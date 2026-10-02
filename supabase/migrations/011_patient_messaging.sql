-- ============================================================
-- 011_patient_messaging.sql — post-visit patient messaging inbox (T1)
--
-- A patient who has already visited messages the clinic's WhatsApp with
-- a doubt. Today any non-booking text only gets the fallback nudge and
-- is lost. These two tables are the human-relay inbox behind it:
--
--   patient_messages — the append-only transcript, both directions.
--   patient_threads  — one lightweight thread per patient, carrying the
--                      inbox state staff work from (status, unread
--                      count, last activity, escalation target).
--
-- Tenancy: both tables are clinic-scoped and RLS-protected with the
-- is_clinic_member() helper from migration 003, so the authenticated
-- portal path can only reach its own clinic's rows. The WhatsApp path
-- has no logged-in user and writes via the service role (RLS-bypassing),
-- so it MUST scope every statement by clinic_id + patient_id in code
-- (see src/lib/whatsapp/messaging.ts).
--
-- NOTE: this feature stores clinical *communication*, not charting —
-- no automated advice is ever generated from it (spec §1 non-goals).
--
-- Idempotent: every CREATE is guarded, policies are dropped first, so
-- it applies from zero and re-applies cleanly.
-- ============================================================

-- ------------------------------------------------------------
-- patient_messages — the transcript.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL
                    CHECK (direction IN ('inbound', 'outbound')),
  body            TEXT NOT NULL,
  -- Inbound: the wacrm delivery id, so a message can be traced back to
  -- the webhook delivery. NULL for outbound/system rows.
  wa_delivery_id  TEXT,
  -- Outbound: the staff user who sent the reply. NULL for inbound and
  -- for anything the system sent on the clinic's behalf (e.g. the ack).
  sent_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serves both the thread transcript read and the "latest inbound"
-- 24h-window lookup, which are always scoped by clinic + patient.
CREATE INDEX IF NOT EXISTS idx_patient_messages_thread
  ON patient_messages (clinic_id, patient_id, created_at);

-- ------------------------------------------------------------
-- patient_threads — one thread per patient (spec §4.2).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_threads (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id              UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'escalated', 'closed')),
  -- Set when staff hand the thread to the treating doctor.
  escalated_to_doctor_id  UUID REFERENCES doctor_profiles(id) ON DELETE SET NULL,
  last_message_at         TIMESTAMPTZ,
  unread_count            INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One thread per patient per clinic; also the upsert conflict target.
  UNIQUE (clinic_id, patient_id)
);

-- ------------------------------------------------------------
-- RLS — clinic isolation for the authenticated portal path, in the
-- exact form migration 003 uses for every other clinic-scoped table.
-- ------------------------------------------------------------
ALTER TABLE patient_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_threads  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patient_messages_access ON patient_messages;
CREATE POLICY patient_messages_access ON patient_messages FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS patient_threads_access ON patient_threads;
CREATE POLICY patient_threads_access ON patient_threads FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

-- ------------------------------------------------------------
-- capture_patient_message — atomic inbound capture.
--
-- Why a function: capturing one inbound message is three writes that
-- must land together (upsert the patient, insert the message, bump the
-- thread), and the Supabase JS client can't run a multi-statement
-- transaction — same reasoning as 004_book_appointment_fn.sql. The
-- function body is one implicit transaction.
--
-- SECURITY DEFINER because the caller is the WhatsApp path, which has
-- no logged-in user, so is_clinic_member() would be false. The caller
-- supplies the clinic_id it already resolved from the wacrm account.
--
-- `is_first_message` is computed BEFORE the insert and tells the caller
-- whether this is the patient's first ever message, so the ack can
-- carry the one-time logging notice (spec §2 consent).
--
-- The thread upsert deliberately does NOT de-escalate: a follow-up
-- message on an 'escalated' thread keeps it escalated, so a doctor
-- hand-off is never silently undone by the patient typing again. A
-- 'closed' thread re-opens, which is what staff expect from new
-- activity.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION capture_patient_message(
  p_clinic_id       UUID,
  p_wa_phone        TEXT,
  p_body            TEXT,
  p_wa_delivery_id  TEXT DEFAULT NULL
)
RETURNS TABLE (
  patient_id       UUID,
  message_id       UUID,
  is_first_message BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient_id UUID;
  v_message_id UUID;
  v_first      BOOLEAN;
BEGIN
  -- Upsert the patient by (clinic_id, wa_phone), exactly as booking
  -- does. DO UPDATE (not DO NOTHING) so RETURNING always yields the id;
  -- COALESCE keeps a curated name from being clobbered.
  INSERT INTO patients (clinic_id, wa_phone)
  VALUES (p_clinic_id, p_wa_phone)
  ON CONFLICT (clinic_id, wa_phone) DO UPDATE
    SET full_name = COALESCE(patients.full_name, EXCLUDED.full_name)
  RETURNING id INTO v_patient_id;

  -- First ever message for this patient? Checked before the insert.
  SELECT NOT EXISTS (
    SELECT 1 FROM patient_messages
    WHERE clinic_id = p_clinic_id AND patient_messages.patient_id = v_patient_id
  ) INTO v_first;

  INSERT INTO patient_messages (
    clinic_id, patient_id, direction, body, wa_delivery_id
  )
  VALUES (
    p_clinic_id, v_patient_id, 'inbound', p_body, p_wa_delivery_id
  )
  RETURNING id INTO v_message_id;

  INSERT INTO patient_threads (
    clinic_id, patient_id, status, last_message_at, unread_count
  )
  VALUES (p_clinic_id, v_patient_id, 'open', NOW(), 1)
  ON CONFLICT (clinic_id, patient_id) DO UPDATE
    SET last_message_at = NOW(),
        unread_count = patient_threads.unread_count + 1,
        status = CASE
                   WHEN patient_threads.status = 'escalated' THEN 'escalated'
                   ELSE 'open'
                 END;

  RETURN QUERY SELECT v_patient_id, v_message_id, v_first;
END;
$$;
