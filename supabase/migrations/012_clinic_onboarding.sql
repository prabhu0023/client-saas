-- ============================================================
-- 012_clinic_onboarding.sql — self-serve clinic creation (ONB-1)
--
-- The one path in the product where a user acts BEFORE belonging to
-- any clinic: a brand-new signup has a session but no clinic_members
-- row, so RLS blocks the very first insert (clinics_member_access's
-- WITH CHECK (is_clinic_member(id)) is false for a row nobody is yet a
-- member of). Rather than put the service role on a browser-reachable
-- action, the write is a SECURITY DEFINER RPC keyed on auth.uid():
-- one implicit transaction, identity taken from the session and not
-- suppliable by the caller. Same shape as book_appointment (004) and
-- clinic_doctor_names (010).
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
-- before CREATE TRIGGER, CREATE UNIQUE INDEX IF NOT EXISTS.
--
-- Every function is SET search_path = public, so auth.users must be
-- schema-qualified (it is not on the search path).
-- ============================================================


-- ------------------------------------------------------------
-- 1. is_clinic_admin — the write-side gate for 014's policies.
--    Mirrors is_clinic_member (003) plus role = 'admin'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_clinic_admin(target_clinic UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members m
    WHERE m.clinic_id = target_clinic
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role = 'admin'
  );
$$;


-- ------------------------------------------------------------
-- 2. my_membership_status — lets /onboarding render the
--    "access not active" copy BEFORE the user submits a form.
--
--    Needed because is_clinic_member() requires status='active'
--    (003), so a disabled member cannot read their OWN
--    clinic_members row through the RLS client — the page
--    literally cannot see it. SECURITY DEFINER can.
--
--    Discloses nothing the caller does not already own: their own
--    status, no clinic id, no other user.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION my_membership_status()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cm.status
  FROM clinic_members cm
  WHERE cm.user_id = auth.uid()
  ORDER BY CASE cm.status
             WHEN 'active'   THEN 0
             WHEN 'disabled' THEN 1
             ELSE 2
           END
  LIMIT 1;
$$;


-- ------------------------------------------------------------
-- 3. clinic_member_identities — names AND emails for the /staff
--    member list.
--
--    users_self_access (003) scopes reads to the caller's own row,
--    and clinic_doctor_names (010) returns doctors only and
--    full_name only — so neither can render a member list that
--    must show nurses, receptionists and fellow admins with their
--    emails.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinic_member_identities(target_clinic UUID)
RETURNS TABLE (member_id UUID, user_id UUID, full_name TEXT, email TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, u.id, u.full_name, u.email
  FROM clinic_members m
  JOIN users u ON u.id = m.user_id
  WHERE m.clinic_id = target_clinic
    -- Authorization: colleague emails are admin-only, so this gate is
    -- is_clinic_admin, NOT is_clinic_member (cf. 010, which is
    -- member-gated because a name alone is less sensitive).
    AND is_clinic_admin(target_clinic);
$$;


-- ------------------------------------------------------------
-- 4. create_clinic_with_owner — the pre-membership write path.
--
--    Every failure is a RETURNED ROW, not an exception, so nothing
--    partially commits: the inserts either all land or an early
--    return happens before any of them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_clinic_with_owner(
  p_name      TEXT,
  p_slug      TEXT,
  p_timezone  TEXT,
  p_full_name TEXT DEFAULT NULL
)
RETURNS TABLE (outcome TEXT, clinic_id UUID, member_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID;
  v_clinic_id UUID;
  v_member_id UUID;
  v_name      TEXT;
BEGIN
  -- (1) Identity comes from the session, never from a parameter.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- (2) v1 is single-membership (§5): one active membership across ALL
  --     clinics. UNIQUE (clinic_id, user_id) only catches a repeat at
  --     the same clinic, so this must look globally.
  IF EXISTS (
    SELECT 1 FROM clinic_members cm
    WHERE cm.user_id = v_uid AND cm.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'already_member'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- (3) A disabled (or 'invited') member must NOT be able to found a
  --     second clinic. This check cannot live in the page: RLS hides
  --     the row from its own owner. 'invited' is folded in
  --     deliberately — nothing here creates that state, but 001
  --     permits it, so the branch fails closed.
  IF EXISTS (
    SELECT 1 FROM clinic_members cm
    WHERE cm.user_id = v_uid AND cm.status IN ('disabled', 'invited')
  ) THEN
    RETURN QUERY SELECT 'membership_disabled'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- (4) Re-validate with the CANONICAL rules of §12.1, identical to the
  --     TS validators. An 'invalid' outcome is read by the app as a
  --     validator-drift bug signal, so the two sides must not diverge.
  v_name := btrim(COALESCE(p_name, ''));
  IF v_name = '' OR length(v_name) > 120 THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_slug IS NULL
     OR length(p_slug) NOT BETWEEN 3 AND 40
     OR p_slug !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$'
     OR p_slug LIKE '%--%' THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- IANA-only, matching Intl.supportedValuesOf('timeZone') on the TS
  -- side. Deliberately NOT a bare AT TIME ZONE test: Postgres also
  -- accepts 'EST', 'UTC+5' and POSIX forms that the TS validator
  -- rejects, and clinics.timezone feeds date-fns-tz slot generation,
  -- so both sides must accept the same set.
  IF p_timezone IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_timezone_names tz WHERE tz.name = p_timezone
     ) THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Secondary check: the name is in the catalogue but still unusable.
  BEGIN
    PERFORM now() AT TIME ZONE p_timezone;
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
      RETURN;
  END;

  -- (5) The clinic. Slug is globally UNIQUE (001); a collision is a
  --     typed outcome, never a raw 23505 and never a 500.
  BEGIN
    INSERT INTO clinics (name, slug, timezone)
    VALUES (v_name, p_slug, p_timezone)
    RETURNING id INTO v_clinic_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT 'slug_taken'::TEXT, NULL::UUID, NULL::UUID;
      RETURN;
  END;

  -- (6) Mirror the auth identity into users. auth.users has no
  --     full_name column — the display name lives in
  --     raw_user_meta_data->>'full_name', which is what /signup writes
  --     via createUser({ user_metadata: { full_name } }) and what
  --     scripts/seed.ts writes too.
  --
  --     The only caller passes p_full_name = NULL (/onboarding's form
  --     asks for the CLINIC's name, not the user's), so the metadata
  --     fallback is the product path AC-2 depends on. users.full_name
  --     comes first in the COALESCE because here the row is almost
  --     always being created; in accept_clinic_invite the invitee's
  --     freshly typed name must win instead.
  INSERT INTO users (id, full_name, email)
  SELECT v_uid,
         COALESCE(NULLIF(btrim(p_full_name), ''), au.raw_user_meta_data->>'full_name'),
         lower(au.email)
  FROM auth.users au
  WHERE au.id = v_uid
  ON CONFLICT (id) DO UPDATE
    SET full_name = COALESCE(users.full_name, EXCLUDED.full_name),
        email     = COALESCE(users.email, EXCLUDED.email);

  -- (7) The founding membership: first ACTIVE ADMIN of the clinic.
  INSERT INTO clinic_members (clinic_id, user_id, role, status)
  VALUES (v_clinic_id, v_uid, 'admin', 'active')
  RETURNING id INTO v_member_id;

  -- (8)
  RETURN QUERY SELECT 'created'::TEXT, v_clinic_id, v_member_id;
END;
$$;


-- ------------------------------------------------------------
-- 5. connect_wacrm_account — writes the last hop of PRD §8's
--    identity chain (Meta phone_number_id -> wacrm account_id ->
--    clinic_id), plus the optional clinic_whatsapp_numbers row, in
--    ONE transaction.
--
--    Both ids are globally UNIQUE, and both are handled by the SAME
--    rule: only another clinic's *active* row is a conflict; a
--    dormant row is re-pointed to the claiming clinic. Without the
--    status filter, any clinic that ever touched an id would burn it
--    forever — a churned pilot, a wrong-account typo and a genuine
--    transfer would all be operator-SQL-only to fix.
--
--    The anti-hijack guarantee survives in the form that matters:
--    no clinic can take over an id that is CURRENTLY ROUTING TRAFFIC.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect_wacrm_account(
  p_clinic_id        UUID,
  p_wacrm_account_id TEXT,
  p_phone_number_id  TEXT DEFAULT NULL,
  p_display_number   TEXT DEFAULT NULL
)
RETURNS TABLE (outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
BEGIN
  -- (1)
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT;
    RETURN;
  END IF;

  IF p_clinic_id IS NULL OR NOT is_clinic_admin(p_clinic_id) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  -- (2) Re-validate, same rules as the TS validators (§12.1).
  IF p_wacrm_account_id IS NULL
     OR length(p_wacrm_account_id) NOT BETWEEN 1 AND 128
     OR p_wacrm_account_id !~ '^[A-Za-z0-9_.:-]+$' THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  IF p_phone_number_id IS NOT NULL
     AND p_phone_number_id !~ '^[0-9]{1,64}$' THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  IF p_display_number IS NOT NULL
     AND (length(p_display_number) > 32
          OR p_display_number !~ '^[0-9+() -]*$') THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  -- (3) Only another clinic's LIVE mapping is a conflict.
  IF EXISTS (
    SELECT 1 FROM clinic_wacrm_accounts wa
    WHERE wa.wacrm_account_id = p_wacrm_account_id
      AND wa.clinic_id <> p_clinic_id
      AND wa.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'wacrm_taken'::TEXT;
    RETURN;
  END IF;

  -- (4) Retire this clinic's other active mapping, keeping the partial
  --     unique index (below) satisfied. Skips the id being submitted,
  --     so re-saving the same id is idempotent.
  UPDATE clinic_wacrm_accounts wa
     SET status = 'disabled'
   WHERE wa.clinic_id = p_clinic_id
     AND wa.status = 'active'
     AND wa.wacrm_account_id <> p_wacrm_account_id;

  -- (5) Claim the id. DO UPDATE covers three cases with one statement:
  --     re-saving the clinic's own active id, reviving its own disabled
  --     row, and re-pointing another clinic's dormant row.
  INSERT INTO clinic_wacrm_accounts (clinic_id, wacrm_account_id, status)
  VALUES (p_clinic_id, p_wacrm_account_id, 'active')
  ON CONFLICT (wacrm_account_id) DO UPDATE
    SET clinic_id = p_clinic_id,
        status    = 'active';

  -- (6) The optional Meta phone_number_id row, same rule as step 3.
  --     A collision rolls the WHOLE function back, so the admin sees
  --     one failure rather than a half-applied connect.
  IF p_phone_number_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM clinic_whatsapp_numbers wn
      WHERE wn.phone_number_id = p_phone_number_id
        AND wn.clinic_id <> p_clinic_id
        AND wn.status = 'active'
    ) THEN
      RETURN QUERY SELECT 'phone_number_taken'::TEXT;
      RETURN;
    END IF;

    UPDATE clinic_whatsapp_numbers wn
       SET status = 'disconnected'
     WHERE wn.clinic_id = p_clinic_id
       AND wn.status = 'active'
       AND wn.phone_number_id <> p_phone_number_id;

    INSERT INTO clinic_whatsapp_numbers
      (clinic_id, phone_number_id, display_number, status)
    VALUES
      (p_clinic_id, p_phone_number_id, p_display_number, 'active')
    ON CONFLICT (phone_number_id) DO UPDATE
      SET clinic_id      = p_clinic_id,
          display_number = p_display_number,
          status         = 'active';
  END IF;

  -- (7)
  RETURN QUERY SELECT 'ok'::TEXT;
END;
$$;


-- ------------------------------------------------------------
-- 6. clinic_members_guard — two invariants that must survive any
--    IN-PLACE write path (portal, future API, service role, manual
--    SQL), because losing them leaves a tenant unmanageable with no
--    product-level repair.
--
--    The naive version makes clinics undeletable: clinic_members
--    .clinic_id is ON DELETE CASCADE and row triggers fire on
--    cascades, so a BEFORE DELETE guard that counts admins turns
--    DELETE FROM clinics into last_active_admin — breaking tenant
--    deletion and leaking every integration fixture (the house
--    teardown is db.from('clinics').delete()).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinic_members_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY DEFINER: the counting SELECT below would otherwise run
-- under the caller's RLS and could see zero sibling admins that do
-- exist.
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cascade stand-down. RI cascades run AFTER the parent row is
  -- already deleted, so a missing parent means "the whole tenant/user
  -- is going away" and there is no invariant left to protect.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM clinics c WHERE c.id = OLD.clinic_id) THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id) THEN
      RETURN OLD;  -- cascade from auth.users -> users -> clinic_members
    END IF;
  END IF;

  -- Rule 1: never drop the last active admin.
  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.status <> 'active') THEN
    IF NOT EXISTS (
      SELECT 1 FROM clinic_members cm
      WHERE cm.clinic_id = OLD.clinic_id
        AND cm.id <> OLD.id
        AND cm.role = 'admin'
        AND cm.status = 'active'
    ) THEN
      RAISE EXCEPTION 'last_active_admin' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Rule 2: a member with a doctor_profiles row keeps role='doctor'.
  -- Fires only when OLD.role = 'doctor', so an admin/nurse who holds a
  -- doctor profile without a role change (the solo-clinic shape) is
  -- entirely unaffected. accept_clinic_invite carries a pre-check with
  -- this EXACT predicate; widen both together if this ever changes.
  IF TG_OP = 'UPDATE' AND OLD.role = 'doctor' AND NEW.role <> 'doctor'
     AND EXISTS (
       SELECT 1 FROM doctor_profiles dp WHERE dp.clinic_member_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'doctor_role_locked' USING ERRCODE = 'P0001';
  END IF;

  -- Required: NEW is NULL in a BEFORE DELETE trigger, and returning
  -- NULL would silently cancel the row operation.
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS clinic_members_guard_trg ON clinic_members;
CREATE TRIGGER clinic_members_guard_trg
  BEFORE UPDATE OR DELETE ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION clinic_members_guard();


-- ------------------------------------------------------------
-- 7. doctor_profiles_guard — appointment history is not deletable
--    through a doctor profile.
--
--    appointments.doctor_id is ON DELETE CASCADE (001), so deleting a
--    profile destroys that doctor's whole appointment history, past
--    rows included, SILENTLY. An app-level count before the delete is
--    a check-then-delete race it cannot win: book_appointment (004)
--    is SECURITY DEFINER and runs from the WhatsApp path on the
--    service role with no coordination with the portal, so a booking
--    landing in between would be cascaded away with no error.
--
--    Division of labour: the action's count produces the friendly
--    message, THIS is the guarantee and the race backstop.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION doctor_profiles_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY DEFINER for the same reason as clinic_members_guard: the
-- EXISTS below must see every appointment, not the caller's
-- RLS-filtered subset.
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cascade stand-down, two distinct paths, both load-bearing:
  -- DELETE FROM clinics reaches doctor_profiles via its own clinic_id
  -- FK (first check), while auth.admin.deleteUser() reaches it through
  -- auth.users -> users -> clinic_members -> doctor_profiles (second).
  IF NOT EXISTS (SELECT 1 FROM clinics c WHERE c.id = OLD.clinic_id) THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clinic_members cm WHERE cm.id = OLD.clinic_member_id
  ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM appointments a WHERE a.doctor_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'doctor_has_appointments' USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS doctor_profiles_guard_trg ON doctor_profiles;
CREATE TRIGGER doctor_profiles_guard_trg
  BEFORE DELETE ON doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION doctor_profiles_guard();


-- ------------------------------------------------------------
-- 8. One ACTIVE wacrm mapping per clinic.
--
--    Dedupe FIRST: CREATE UNIQUE INDEX aborts outright if any clinic
--    already holds two active rows, and this file is not wrapped in a
--    transaction — a failure here would leave the functions created
--    and the index missing while the file advertises itself as
--    re-runnable. Current data makes the collision unlikely (the seed
--    upserts one row by wacrm_account_id), but the index must not
--    depend on that.
-- ------------------------------------------------------------
UPDATE clinic_wacrm_accounts a SET status = 'disabled'
WHERE a.status = 'active'
  AND a.id <> (
    SELECT b.id FROM clinic_wacrm_accounts b
    WHERE b.clinic_id = a.clinic_id AND b.status = 'active'
    ORDER BY b.created_at DESC, b.id LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_wacrm_one_active
  ON clinic_wacrm_accounts (clinic_id) WHERE status = 'active';


-- ------------------------------------------------------------
-- 9. UNRELATED HOUSEKEEPING (not part of ONB-1/2/3): 007 created this
--    column with uuid_generate_v4(), which needs uuid-ossp; nothing in
--    the tree creates that extension (it happens to be preinstalled on
--    Supabase). Switching the default to the built-in gen_random_uuid()
--    removes the last such dependency. Safe because no existing id's
--    provenance matters. A future revert of this feature should NOT
--    drag this line back.
-- ------------------------------------------------------------
ALTER TABLE clinic_wacrm_accounts
  ALTER COLUMN id SET DEFAULT gen_random_uuid();


-- ------------------------------------------------------------
-- 10. Who may call these.
--
--     Postgres grants EXECUTE on a new public function to PUBLIC, and
--     Supabase exposes the public schema over PostgREST to anon — so
--     "we never granted it to anon" is NOT a control. 011 is the only
--     migration in the tree that documents this trap; its own grant
--     goes to service_role (and it revokes from authenticated too)
--     because its caller is the WhatsApp path. The same reasoning
--     applies here with `authenticated` as the target, since every one
--     of these is called by a logged-in staff user.
--
--     The two trigger functions need no entry: a RETURNS TRIGGER
--     function is not callable over PostgREST and is invoked by the
--     trigger mechanism, not by a role's EXECUTE.
--
--     service_role needs no grant either: it bypasses RLS, so policies
--     (and therefore is_clinic_admin) are never evaluated for it.
--
--     Consequence to accept deliberately: is_clinic_admin is used
--     inside 014's policy expressions, which are evaluated as the
--     querying role. An anon-key write against a protected table
--     therefore raises `42501 permission denied for function
--     is_clinic_admin` rather than an RLS violation — still a hard
--     rejection, which is why the tests assert by error class.
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION is_clinic_admin(UUID)                            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION my_membership_status()                           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION clinic_member_identities(UUID)                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION create_clinic_with_owner(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION connect_wacrm_account(UUID, TEXT, TEXT, TEXT)    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION is_clinic_admin(UUID)                            TO authenticated;
GRANT EXECUTE ON FUNCTION my_membership_status()                           TO authenticated;
GRANT EXECUTE ON FUNCTION clinic_member_identities(UUID)                   TO authenticated;
GRANT EXECUTE ON FUNCTION create_clinic_with_owner(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION connect_wacrm_account(UUID, TEXT, TEXT, TEXT)    TO authenticated;
