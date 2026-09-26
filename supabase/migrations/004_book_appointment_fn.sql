-- ============================================================
-- 004_book_appointment_fn.sql — atomic booking RPC (write path §5)
--
-- The Supabase JS client can't run a multi-statement transaction, so
-- the atomic "upsert patient + insert appointment" lives here as a
-- single plpgsql function. The function body runs in one implicit
-- transaction: if the INSERT trips the no-overlap exclusion constraint
-- (migration 002), the whole call rolls back and we return a typed
-- 'slot_taken' outcome instead of letting the raw 23P01 escape.
--
-- Principle (docs §5): the DATABASE decides who wins. No check-then-
-- insert. We attempt the insert and let the constraint arbitrate.
--
-- Tenancy: SECURITY DEFINER so it runs regardless of RLS (the WhatsApp
-- path has no logged-in user). The caller MUST have already verified
-- the doctor belongs to p_clinic_id (see src/lib/clinics/tenancy.ts);
-- as defense-in-depth we also re-check it here.
-- ============================================================

CREATE OR REPLACE FUNCTION book_appointment(
  p_clinic_id   UUID,
  p_doctor_id   UUID,
  p_wa_phone    TEXT,
  p_starts_at   TIMESTAMPTZ,
  p_ends_at     TIMESTAMPTZ,
  p_service_id  UUID DEFAULT NULL,
  p_patient_name TEXT DEFAULT NULL,
  p_created_via TEXT DEFAULT 'whatsapp'
)
RETURNS TABLE (
  outcome        TEXT,   -- 'booked' | 'slot_taken' | 'invalid'
  appointment_id UUID,
  patient_id     UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient_id     UUID;
  v_appointment_id UUID;
BEGIN
  -- Defense-in-depth tenancy: the doctor must belong to this clinic.
  IF NOT EXISTS (
    SELECT 1 FROM doctor_profiles d
    WHERE d.id = p_doctor_id AND d.clinic_id = p_clinic_id
  ) THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Upsert the patient by (clinic_id, wa_phone). Set the name only when
  -- provided and not already set, so we don't clobber a curated name.
  INSERT INTO patients (clinic_id, wa_phone, full_name)
  VALUES (p_clinic_id, p_wa_phone, p_patient_name)
  ON CONFLICT (clinic_id, wa_phone) DO UPDATE
    SET full_name = COALESCE(patients.full_name, EXCLUDED.full_name)
  RETURNING id INTO v_patient_id;

  -- Attempt the reservation. The exclusion constraint arbitrates.
  BEGIN
    INSERT INTO appointments (
      clinic_id, doctor_id, patient_id, starts_at, ends_at,
      status, service_id, created_via
    )
    VALUES (
      p_clinic_id, p_doctor_id, v_patient_id, p_starts_at, p_ends_at,
      'booked', p_service_id, p_created_via
    )
    RETURNING id INTO v_appointment_id;
  EXCEPTION
    WHEN exclusion_violation OR unique_violation THEN
      -- Someone booked this slot (or an overlapping one) first. The
      -- failed INSERT is rolled back; the patient upsert above is a
      -- separate statement and persists, which is fine (idempotent).
      RETURN QUERY SELECT 'slot_taken'::TEXT, NULL::UUID, v_patient_id;
      RETURN;
  END;

  RETURN QUERY SELECT 'booked'::TEXT, v_appointment_id, v_patient_id;
END;
$$;
