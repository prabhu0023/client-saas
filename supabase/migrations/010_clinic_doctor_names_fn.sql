-- ============================================================
-- 010_clinic_doctor_names_fn.sql — surface doctor names to staff (E6-T1)
--
-- The portal shows doctor SPECIALTY only, because a doctor's human name
-- lives in `users`, whose RLS policy scopes reads to the caller's own
-- row (users_self_access). So a receptionist can't read a doctor's name
-- directly.
--
-- This SECURITY DEFINER function returns (doctor_id, full_name) for the
-- active doctors of a clinic — but ONLY when the caller is an active
-- member of that clinic. The is_clinic_member() gate (migration 003) is
-- the authorization check, so there is no cross-clinic leak: a caller
-- gets names only for clinics they already belong to.
--
-- Keyed by doctor_profiles.id (what the portal already has), joining
-- through clinic_members to users.
-- ============================================================

CREATE OR REPLACE FUNCTION clinic_doctor_names(target_clinic UUID)
RETURNS TABLE (doctor_id UUID, full_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT dp.id AS doctor_id, u.full_name
  FROM doctor_profiles dp
  JOIN clinic_members m ON m.id = dp.clinic_member_id
  JOIN users u ON u.id = m.user_id
  WHERE dp.clinic_id = target_clinic
    AND m.status = 'active'
    -- Authorization: only a member of this clinic may read its names.
    AND is_clinic_member(target_clinic);
$$;
