-- ============================================================
-- 014_admin_write_policies.sql — member-read / admin-write split
--
-- 003 and 007 gave every clinic-scoped table a single FOR ALL policy
-- keyed on is_clinic_member(): "any member may do anything in their
-- clinic". That was fine while the only session-scoped writes were
-- availability and appointment status. This feature adds staff,
-- services and WhatsApp-mapping screens, so the seven
-- TENANT-CONFIGURATION tables move to "any member may read, ADMINS may
-- write", enforced in the database rather than only in the UI: a
-- hand-crafted client using the anon key with a receptionist session
-- must not be able to invite staff, repoint a WhatsApp mapping or edit
-- prices.
--
-- Deliberately UNTOUCHED, so a receptionist keeps doing their job:
-- availability_rules, availability_exceptions, appointments, patients,
-- users_self_access, processed_wa_events, and 011's patient_threads /
-- patient_messages.
--
-- This is the one NON-ADDITIVE migration in the set — it drops and
-- recreates seven live policies — which is why it is isolated here
-- with its own blast-radius note at the bottom.
--
-- Policy naming: per-command policies (<table>_member_read,
-- <table>_admin_insert/_update/_delete) rather than one FOR ALL write
-- policy, because a policy covers a single command and spelling each
-- out makes a missing WITH CHECK obvious on sight.
--
-- Idempotent: DROP POLICY IF EXISTS before every CREATE POLICY.
-- ============================================================


-- ------------------------------------------------------------
-- clinics — the clinic reference is `id`, not `clinic_id`.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinics_member_access ON clinics;
DROP POLICY IF EXISTS clinics_member_read   ON clinics;
DROP POLICY IF EXISTS clinics_admin_insert  ON clinics;
DROP POLICY IF EXISTS clinics_admin_update  ON clinics;
DROP POLICY IF EXISTS clinics_admin_delete  ON clinics;

CREATE POLICY clinics_member_read ON clinics
  FOR SELECT USING (is_clinic_member(id));

CREATE POLICY clinics_admin_insert ON clinics
  FOR INSERT WITH CHECK (is_clinic_admin(id));

CREATE POLICY clinics_admin_update ON clinics
  FOR UPDATE USING (is_clinic_admin(id)) WITH CHECK (is_clinic_admin(id));

CREATE POLICY clinics_admin_delete ON clinics
  FOR DELETE USING (is_clinic_admin(id));


-- ------------------------------------------------------------
-- clinic_members
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinic_members_access       ON clinic_members;
DROP POLICY IF EXISTS clinic_members_member_read  ON clinic_members;
DROP POLICY IF EXISTS clinic_members_admin_insert ON clinic_members;
DROP POLICY IF EXISTS clinic_members_admin_update ON clinic_members;
DROP POLICY IF EXISTS clinic_members_admin_delete ON clinic_members;

CREATE POLICY clinic_members_member_read ON clinic_members
  FOR SELECT USING (is_clinic_member(clinic_id));

CREATE POLICY clinic_members_admin_insert ON clinic_members
  FOR INSERT WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY clinic_members_admin_update ON clinic_members
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY clinic_members_admin_delete ON clinic_members
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- clinic_whatsapp_numbers — in the list because THIS FEATURE is the
-- first thing that writes it from a session (the optional
-- phone_number_id on the Connect WhatsApp form). Left as FOR ALL +
-- is_clinic_member, a receptionist with the anon key could repoint a
-- phone_number_id mapping.
--
-- Note the policy being dropped does NOT follow the <table>_access
-- naming pattern.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinic_wa_numbers_access            ON clinic_whatsapp_numbers;
DROP POLICY IF EXISTS clinic_whatsapp_numbers_member_read  ON clinic_whatsapp_numbers;
DROP POLICY IF EXISTS clinic_whatsapp_numbers_admin_insert ON clinic_whatsapp_numbers;
DROP POLICY IF EXISTS clinic_whatsapp_numbers_admin_update ON clinic_whatsapp_numbers;
DROP POLICY IF EXISTS clinic_whatsapp_numbers_admin_delete ON clinic_whatsapp_numbers;

CREATE POLICY clinic_whatsapp_numbers_member_read ON clinic_whatsapp_numbers
  FOR SELECT USING (is_clinic_member(clinic_id));

CREATE POLICY clinic_whatsapp_numbers_admin_insert ON clinic_whatsapp_numbers
  FOR INSERT WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY clinic_whatsapp_numbers_admin_update ON clinic_whatsapp_numbers
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY clinic_whatsapp_numbers_admin_delete ON clinic_whatsapp_numbers
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- doctor_profiles — THE ONE EXCEPTION. Must not be "simplified" back
-- into the uniform shape.
--
-- is_clinic_admin(clinic_id) alone checks only the column the CLIENT
-- SUPPLIES, so clinic B's admin could
--   INSERT { clinic_id: B, clinic_member_id: <a clinic_members.id of A> }
-- and pass the policy. That is a real cross-tenant read, not a
-- theoretical one: loadDoctorOptions() and loadDoctorLabel()
-- (src/lib/whatsapp/query.ts), listClinicDoctors()
-- (src/lib/portal/availability.ts), getDoctorSlotMinutes()
-- (src/lib/portal/new-appointment.ts) and clinic_doctor_names (010) all
-- select on doctor_profiles.clinic_id joined to
-- clinic_members!inner(status) and NEVER on clinic_members.clinic_id —
-- so that row would render A's member's full_name to B's patients on
-- WhatsApp and to B's staff on /availability.
--
-- Policy rather than a trigger, stated so the choice is not re-litigated:
--   (a) 014 already rewrites this table's policies, so the rule lands in
--       the file a reviewer reads to learn who may write doctor_profiles;
--   (b) it is an AUTHORIZATION rule about what a session may submit,
--       which is exactly what WITH CHECK is for;
--   (c) the service role legitimately bypasses it — scripts/seed.ts
--       writes profiles for members it created in the same breath —
--       whereas a trigger would fire for the seed too, with no benefit.
-- The two rules that must hold for EVERY writer (>=1 active admin, and
-- no-delete-with-appointments) are the two that are triggers, in 012.
--
-- The clinic_member_id predicate is on INSERT/UPDATE WITH CHECK only,
-- NEVER on USING: a USING predicate referencing it would filter
-- EXISTING rows and could hide a legitimately-owned profile from its
-- own admin.
--
-- The EXISTS is evaluated UNDER THE CALLER'S RLS, unlike
-- is_clinic_admin() which is SECURITY DEFINER — a table referenced
-- inside a policy expression has its own row security applied. So the
-- legitimate insert depends on clinic_members_member_read (created
-- above) being true for the admin's own clinic, which it is. The
-- cross-clinic attempt is refused either way: if A's member row is
-- invisible the EXISTS is empty, and if it were visible the
-- m.clinic_id = doctor_profiles.clinic_id predicate still fails. Worth
-- knowing because the two failure modes are indistinguishable from the
-- client, so an implementer debugging the legitimate path could
-- otherwise suspect visibility rather than the predicate.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS doctor_profiles_access       ON doctor_profiles;
DROP POLICY IF EXISTS doctor_profiles_member_read  ON doctor_profiles;
DROP POLICY IF EXISTS doctor_profiles_admin_insert ON doctor_profiles;
DROP POLICY IF EXISTS doctor_profiles_admin_update ON doctor_profiles;
DROP POLICY IF EXISTS doctor_profiles_admin_delete ON doctor_profiles;

CREATE POLICY doctor_profiles_member_read ON doctor_profiles
  FOR SELECT USING (is_clinic_member(clinic_id));

CREATE POLICY doctor_profiles_admin_insert ON doctor_profiles
  FOR INSERT WITH CHECK (
    is_clinic_admin(clinic_id)
    AND EXISTS (
      SELECT 1 FROM clinic_members m
      WHERE m.id = clinic_member_id
        AND m.clinic_id = doctor_profiles.clinic_id
    )
  );

CREATE POLICY doctor_profiles_admin_update ON doctor_profiles
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (
    is_clinic_admin(clinic_id)
    AND EXISTS (
      SELECT 1 FROM clinic_members m
      WHERE m.id = clinic_member_id
        AND m.clinic_id = doctor_profiles.clinic_id
    )
  );

CREATE POLICY doctor_profiles_admin_delete ON doctor_profiles
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- services
-- ------------------------------------------------------------
DROP POLICY IF EXISTS services_access       ON services;
DROP POLICY IF EXISTS services_member_read  ON services;
DROP POLICY IF EXISTS services_admin_insert ON services;
DROP POLICY IF EXISTS services_admin_update ON services;
DROP POLICY IF EXISTS services_admin_delete ON services;

CREATE POLICY services_member_read ON services
  FOR SELECT USING (is_clinic_member(clinic_id));

CREATE POLICY services_admin_insert ON services
  FOR INSERT WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY services_admin_update ON services
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY services_admin_delete ON services
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- doctor_services — the table does carry its own clinic_id
-- (NOT NULL, 001), which is why set_doctor_services below must
-- populate it from the RESOLVED SERVICE's clinic rather than from a
-- parameter.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS doctor_services_access       ON doctor_services;
DROP POLICY IF EXISTS doctor_services_member_read  ON doctor_services;
DROP POLICY IF EXISTS doctor_services_admin_insert ON doctor_services;
DROP POLICY IF EXISTS doctor_services_admin_update ON doctor_services;
DROP POLICY IF EXISTS doctor_services_admin_delete ON doctor_services;

CREATE POLICY doctor_services_member_read ON doctor_services
  FOR SELECT USING (is_clinic_member(clinic_id));

CREATE POLICY doctor_services_admin_insert ON doctor_services
  FOR INSERT WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY doctor_services_admin_update ON doctor_services
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY doctor_services_admin_delete ON doctor_services
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- clinic_wacrm_accounts — its policy lives in 007, not 003.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinic_wacrm_accounts_access       ON clinic_wacrm_accounts;
DROP POLICY IF EXISTS clinic_wacrm_accounts_member_read  ON clinic_wacrm_accounts;
DROP POLICY IF EXISTS clinic_wacrm_accounts_admin_insert ON clinic_wacrm_accounts;
DROP POLICY IF EXISTS clinic_wacrm_accounts_admin_update ON clinic_wacrm_accounts;
DROP POLICY IF EXISTS clinic_wacrm_accounts_admin_delete ON clinic_wacrm_accounts;

CREATE POLICY clinic_wacrm_accounts_member_read ON clinic_wacrm_accounts
  FOR SELECT USING (is_clinic_member(clinic_id));

CREATE POLICY clinic_wacrm_accounts_admin_insert ON clinic_wacrm_accounts
  FOR INSERT WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY clinic_wacrm_accounts_admin_update ON clinic_wacrm_accounts
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (is_clinic_admin(clinic_id));

CREATE POLICY clinic_wacrm_accounts_admin_delete ON clinic_wacrm_accounts
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- set_doctor_services — replace a service's doctor set atomically.
--
-- The mapping joins two clinic-scoped tables, so validating both sides
-- in one statement is the only place it can be done atomically; the
-- screen can never show a half-applied mapping.
--
-- p_doctor_ids = '{}' clears the mapping, which is a legitimate state.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_doctor_services(
  p_service_id UUID,
  p_doctor_ids UUID[]
)
RETURNS TABLE (outcome TEXT, linked INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID;
  v_clinic_id UUID;
  v_ids       UUID[];
  v_linked    INT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, 0;
    RETURN;
  END IF;

  v_ids := COALESCE(p_doctor_ids, '{}'::UUID[]);

  -- The service decides the clinic; the caller never supplies one.
  SELECT s.clinic_id INTO v_clinic_id
  FROM services s
  WHERE s.id = p_service_id;

  IF v_clinic_id IS NULL THEN
    RETURN QUERY SELECT 'service_not_found'::TEXT, 0;
    RETURN;
  END IF;

  IF NOT is_clinic_admin(v_clinic_id) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, 0;
    RETURN;
  END IF;

  -- Every supplied id must be an EXISTING doctor_profiles row of THIS
  -- clinic. A missing row and a foreign-clinic row are the same
  -- refusal, so a forged id cannot probe for existence. A NULL element
  -- fails closed here too.
  IF EXISTS (
    SELECT 1
    FROM unnest(v_ids) AS t(doctor_id)
    LEFT JOIN doctor_profiles dp ON dp.id = t.doctor_id
    WHERE dp.id IS NULL OR dp.clinic_id <> v_clinic_id
  ) THEN
    RETURN QUERY SELECT 'doctor_not_in_clinic'::TEXT, 0;
    RETURN;
  END IF;

  -- Drop the pairs that are no longer wanted. With an empty array
  -- `<> ALL` is TRUE for every row, which is how clearing works.
  DELETE FROM doctor_services ds
  WHERE ds.service_id = p_service_id
    AND ds.doctor_id <> ALL(v_ids);

  -- Add the missing ones. clinic_id comes from the resolved service
  -- (the column is NOT NULL); ON CONFLICT matches the table's existing
  -- UNIQUE (doctor_id, service_id).
  INSERT INTO doctor_services (clinic_id, doctor_id, service_id)
  SELECT v_clinic_id, t.doctor_id, p_service_id
  FROM unnest(v_ids) AS t(doctor_id)
  ON CONFLICT (doctor_id, service_id) DO NOTHING;

  SELECT COUNT(*) INTO v_linked
  FROM doctor_services ds
  WHERE ds.service_id = p_service_id;

  RETURN QUERY SELECT 'ok'::TEXT, v_linked;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_doctor_services(UUID, UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION set_doctor_services(UUID, UUID[]) TO authenticated;


-- ============================================================
-- BLAST RADIUS — checked against every current read and write before
-- dropping the policies above.
--
-- Reads, still allowed for all members (SELECT policies are
-- member-wide):
--   - src/lib/portal/appointments.ts joins services / doctor_profiles
--   - src/lib/portal/availability.ts reads doctor_profiles
--   - src/lib/portal/new-appointment.ts reads doctor_profiles
--   - src/app/(portal)/availability/actions.ts reads doctor_profiles
--   - clinic_doctor_names (010) is SECURITY DEFINER, so unaffected
--
-- Writes: a grep of every non-.select() Supabase call in src/ confirms
-- no existing SESSION-SCOPED write touches any of these seven tables.
-- Portal writes land only on availability_rules,
-- availability_exceptions, appointments, patients, patient_threads and
-- patient_messages — all left with their member-wide policies.
--
-- The WhatsApp path, 011's capture_patient_message and scripts/seed.ts
-- all use the service role, which bypasses RLS entirely.
--
-- One asymmetry to expect in tests rather than "fix": a failing USING
-- on UPDATE/DELETE filters rows away, so PostgREST reports 0 rows,
-- while an INSERT has no row to filter so the failing WITH CHECK
-- raises 42501. And a receptionist is `authenticated`, so they DO hold
-- EXECUTE on is_clinic_admin and get 0 rows — where an anon caller gets
-- `permission denied for function is_clinic_admin` instead.
-- ============================================================
