-- ============================================================
-- 006_wacrm_sessions.sql — wacrm integration: tenant map + sessions
--
-- The WhatsApp channel is wacrm (one wacrm ACCOUNT per clinic). wacrm's
-- public webhook forwards a minimal `message.received` event that does
-- NOT include the sender's phone or the tapped interactive-reply id —
-- only { account_id, conversation_id, contact_id, text }. So, unlike a
-- Meta-direct integration, we:
--   1. route the tenant by wacrm account_id (not a Meta phone_number_id), and
--   2. persist conversation state ourselves (the flow is text-driven).
--
-- Service-role only (the WhatsApp path has no logged-in user); RLS is
-- enabled with no policies so the anon/staff clients can't touch these.
-- ============================================================

-- ------------------------------------------------------------
-- clinic_wacrm_accounts — maps a wacrm account to a clinic (tenant router)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_wacrm_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  -- wacrm's account id, present on every webhook envelope.
  wacrm_account_id   TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disconnected')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinic_wacrm_accounts_clinic
  ON clinic_wacrm_accounts(clinic_id);

ALTER TABLE clinic_wacrm_accounts ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- wa_sessions — per-conversation booking state (text-driven flow)
--
-- Keyed by wacrm conversation_id (one active booking flow per
-- conversation). `step` is where we are; `data` holds the accumulated
-- selection (chosen doctor/date) and the options we last offered so the
-- next typed reply ('1', '2', ...) can be matched back to an id.
-- Sessions expire so a stale/abandoned flow restarts cleanly.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa_sessions (
  conversation_id  TEXT PRIMARY KEY,
  clinic_id        UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  -- Cached E.164 phone for the contact (resolved once via wacrm's API),
  -- so we don't re-fetch it on every step.
  wa_phone         TEXT,
  step             TEXT NOT NULL DEFAULT 'idle'
                     CHECK (step IN ('idle', 'awaiting_doctor',
                                     'awaiting_day', 'awaiting_time')),
  -- Free-form flow state: { doctorId?, dateYmd?, options?: [{ n, id, label }] }.
  data             JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_sessions_clinic ON wa_sessions(clinic_id);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_expires ON wa_sessions(expires_at);

DROP TRIGGER IF EXISTS wa_sessions_set_updated_at ON wa_sessions;
CREATE TRIGGER wa_sessions_set_updated_at BEFORE UPDATE ON wa_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;
