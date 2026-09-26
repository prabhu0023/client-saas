-- ============================================================
-- 003_rls_policies.sql — Row-Level Security (portal isolation)
--
-- RLS protects the authenticated STAFF PORTAL path: a logged-in
-- user may only touch rows of clinics they are an active member of.
--
-- The WhatsApp/booking path is NOT governed by these policies — the
-- patient is not logged in, so that path runs server-side via the
-- service-role key (which bypasses RLS) and re-checks tenancy in
-- application code (see src/lib/clinics/tenancy.ts).
--
-- Helper: is the current auth user an active member of a clinic?
-- ============================================================

CREATE OR REPLACE FUNCTION is_clinic_member(target_clinic UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members m
    WHERE m.clinic_id = target_clinic
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ------------------------------------------------------------
-- Enable RLS on every clinic-scoped table
-- ------------------------------------------------------------
ALTER TABLE clinics                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_whatsapp_numbers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE services                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_services          ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_exceptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments             ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- clinics: a member can see/manage their own clinic row
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinics_member_access ON clinics;
CREATE POLICY clinics_member_access ON clinics FOR ALL
  USING (is_clinic_member(id))
  WITH CHECK (is_clinic_member(id));

-- ------------------------------------------------------------
-- users: a user sees/edits their own row
-- ------------------------------------------------------------
DROP POLICY IF EXISTS users_self_access ON users;
CREATE POLICY users_self_access ON users FOR ALL
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ------------------------------------------------------------
-- clinic_members: visible to members of the same clinic
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinic_members_access ON clinic_members;
CREATE POLICY clinic_members_access ON clinic_members FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

-- ------------------------------------------------------------
-- All other clinic-scoped tables: isolate by clinic_id
-- ------------------------------------------------------------
DROP POLICY IF EXISTS clinic_wa_numbers_access ON clinic_whatsapp_numbers;
CREATE POLICY clinic_wa_numbers_access ON clinic_whatsapp_numbers FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS doctor_profiles_access ON doctor_profiles;
CREATE POLICY doctor_profiles_access ON doctor_profiles FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS patients_access ON patients;
CREATE POLICY patients_access ON patients FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS services_access ON services;
CREATE POLICY services_access ON services FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS doctor_services_access ON doctor_services;
CREATE POLICY doctor_services_access ON doctor_services FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS availability_rules_access ON availability_rules;
CREATE POLICY availability_rules_access ON availability_rules FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS availability_exceptions_access ON availability_exceptions;
CREATE POLICY availability_exceptions_access ON availability_exceptions FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

DROP POLICY IF EXISTS appointments_access ON appointments;
CREATE POLICY appointments_access ON appointments FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

-- NOTE on role-scoped visibility (future): sensitive tables (e.g.
-- clinical notes, once added) should get tighter policies so a
-- receptionist cannot read a doctor's notes. Layer those as more
-- specific policies or enforce in the API when that data lands.
