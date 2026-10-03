-- ============================================================
-- 013_clinic_invites.sql — staff invite / enrolment (ONB-2)
--
-- No SMTP is configured and the design rules out an email provider,
-- so an invite is a one-time LINK the admin shares out-of-band. The
-- invitee sets their own password, so nobody else ever knows it.
--
-- Why a dedicated table rather than an 'invited' clinic_members row:
-- clinic_members.user_id is NOT NULL REFERENCES users(id), and no auth
-- user exists until the invitee acts. So the pending state lives here
-- and the membership is created at acceptance, as 'active'.
--
-- The token itself is NEVER stored — only sha256(token) hex. Hashing
-- happens in Node (node:crypto), which also avoids depending on
-- pgcrypto being enabled. Knowing the hash is equivalent to holding
-- the token, so passing the hash to the RPC is no weaker.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, DROP POLICY IF EXISTS
-- before CREATE POLICY, CREATE OR REPLACE FUNCTION.
-- ============================================================

CREATE TABLE IF NOT EXISTS clinic_invites (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  email                  TEXT NOT NULL,              -- stored lower-cased
  role                   TEXT NOT NULL
                           CHECK (role IN ('doctor','nurse','receptionist','admin')),
  specialty              TEXT,
  slot_duration_minutes  INTEGER
                           CHECK (slot_duration_minutes IS NULL
                                  OR slot_duration_minutes > 0),
  token_hash             TEXT NOT NULL UNIQUE,       -- sha256 hex of the one-time token
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','accepted','revoked')),
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  created_by             UUID REFERENCES clinic_members(id) ON DELETE SET NULL,
  accepted_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lower-casing is enforced here so the email-match rule in
  -- accept_clinic_invite can compare against lower(auth.users.email)
  -- without a case-folding surprise.
  CHECK (email = lower(email)),
  -- Doctor-only fields stay out of non-doctor invites.
  CHECK (role = 'doctor' OR (specialty IS NULL AND slot_duration_minutes IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_clinic_invites_clinic
  ON clinic_invites(clinic_id);

-- One LIVE invite per email per clinic. createInvite() revokes an
-- existing pending invite before issuing a new one, so this index only
-- bites on a genuine race between two admins.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_invites_one_pending
  ON clinic_invites (clinic_id, email) WHERE status = 'pending';

-- No full_name column: the admin does not know or vouch for the
-- invitee's spelling of their own name. It is captured at acceptance,
-- where the person typing it is the person it belongs to
-- (accept_clinic_invite's p_full_name).


-- ------------------------------------------------------------
-- RLS — admins only, for reads as well as writes. A receptionist has
-- no business listing who has been invited.
--
-- loadInviteByToken() reads this table with the SERVICE ROLE, which
-- bypasses RLS, so these policies do not block the pre-session
-- /join/<token> render (the invitee has no account yet, so there is no
-- RLS identity to scope the read to).
--
-- Per-command policies rather than one FOR ALL, matching 014: it keeps
-- the read/write asymmetry legible and makes a missing WITH CHECK
-- obvious at a glance.
-- ------------------------------------------------------------
ALTER TABLE clinic_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinic_invites_admin_read ON clinic_invites;
CREATE POLICY clinic_invites_admin_read ON clinic_invites
  FOR SELECT USING (is_clinic_admin(clinic_id));

DROP POLICY IF EXISTS clinic_invites_admin_insert ON clinic_invites;
CREATE POLICY clinic_invites_admin_insert ON clinic_invites
  FOR INSERT WITH CHECK (is_clinic_admin(clinic_id));

DROP POLICY IF EXISTS clinic_invites_admin_update ON clinic_invites;
CREATE POLICY clinic_invites_admin_update ON clinic_invites
  FOR UPDATE USING (is_clinic_admin(clinic_id))
  WITH CHECK (is_clinic_admin(clinic_id));

DROP POLICY IF EXISTS clinic_invites_admin_delete ON clinic_invites;
CREATE POLICY clinic_invites_admin_delete ON clinic_invites
  FOR DELETE USING (is_clinic_admin(clinic_id));


-- ------------------------------------------------------------
-- accept_clinic_invite — the enrolment transaction.
--
-- Called from /join's acceptInvite() on the SAME cookie client that
-- just ran signInWithPassword, so auth.uid() is the invitee.
--
-- Single-use is enforced by the conditional transition under the row
-- lock taken in step 2, not by application code: two simultaneous
-- claims cannot both create a membership.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION accept_clinic_invite(
  p_token_hash TEXT,
  p_full_name  TEXT
)
RETURNS TABLE (outcome TEXT, clinic_id UUID, member_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID;
  v_invite    clinic_invites;
  v_email     TEXT;
  v_name      TEXT;
  v_member_id UUID;
BEGIN
  -- (1)
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- (2) Lock the invite row for the duration of the transaction.
  SELECT ci.* INTO v_invite
  FROM clinic_invites ci
  WHERE ci.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- (3) Status and expiry. Expiry is DERIVED, never a stored status, so
  --     there is no cron and no drifting column.
  IF v_invite.status = 'accepted' THEN
    RETURN QUERY SELECT 'already_used'::TEXT, v_invite.clinic_id, NULL::UUID;
    RETURN;
  END IF;

  IF v_invite.status = 'revoked' THEN
    RETURN QUERY SELECT 'revoked'::TEXT, v_invite.clinic_id, NULL::UUID;
    RETURN;
  END IF;

  IF v_invite.expires_at <= NOW() THEN
    RETURN QUERY SELECT 'expired'::TEXT, v_invite.clinic_id, NULL::UUID;
    RETURN;
  END IF;

  -- (4) An invite can only be accepted by the email it was issued to.
  --     auth.users is schema-qualified because search_path is public.
  --
  --     Unreachable from /join (step 4 of acceptInvite always signs in
  --     AS invite.email, so by this point auth.uid() is by construction
  --     that email's user). Kept as defence-in-depth for a direct RPC
  --     caller who obtained a token and calls this themself.
  SELECT lower(au.email) INTO v_email
  FROM auth.users au
  WHERE au.id = v_uid;

  IF v_email IS NULL OR v_email <> v_invite.email THEN
    RETURN QUERY SELECT 'email_mismatch'::TEXT, v_invite.clinic_id, NULL::UUID;
    RETURN;
  END IF;

  -- (4b) Re-validate the name in SQL, not just in the action: this
  --      value is what patients see. A crafted call with '' would leave
  --      users.full_name NULL and loadDoctorOptions() would offer this
  --      doctor to patients as the literal 'Doctor'
  --      (src/lib/whatsapp/query.ts).
  v_name := btrim(COALESCE(p_full_name, ''));
  IF v_name = '' OR length(v_name) > 120 THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- (5) EVERY refusal check runs before ANY write.
  --
  --     NOTE — deliberate ordering deviation from design §9.3, which
  --     lists the users upsert (its step 5) before these two checks.
  --     Returning a refusal row does NOT roll the transaction back, so
  --     that order would persist the typed name on a refused
  --     acceptance — including overwriting the caller's name at clinic
  --     A when they are refused at clinic B. Behaviour on the accepted
  --     path is identical, and "no writes before the checks" is the
  --     principle the doctor_profile_exists rationale already rests on.

  -- v1 is single-membership (§5). UNIQUE (clinic_id, user_id) only
  -- catches a repeat at the SAME clinic, so this must look across all
  -- clinics: a user active at clinic A accepting clinic B's invite is
  -- not a constraint violation, and requireStaff() resolves
  -- .order('created_at').limit(1), so they would stay pinned to A while
  -- B's admin saw an "active" member who could never open the portal —
  -- unrecoverable without SQL, since no product surface deletes a
  -- membership.
  IF EXISTS (
    SELECT 1 FROM clinic_members cm
    WHERE cm.user_id = v_uid AND cm.status = 'active'
  ) THEN
    -- Returns BEFORE step 8, so the invite is left 'pending' and the
    -- admin can still revoke it (or the right person can use it).
    RETURN QUERY SELECT 'already_member'::TEXT, v_invite.clinic_id, NULL::UUID;
    RETURN;
  END IF;

  -- Disabling a member does NOT delete their doctor_profiles row
  -- (FR-2.10's retained history is the reason). So "disable a doctor,
  -- then re-invite the same email as a receptionist" would reach the
  -- upsert below with OLD.role='doctor', NEW.role<>'doctor' and a
  -- surviving profile — the exact predicate of clinic_members_guard
  -- rule 2. SECURITY DEFINER bypasses RLS but NOT triggers, so the
  -- RAISE would roll this back AFTER /join had already created the auth
  -- account and signed the invitee in, and catching it afterwards
  -- cannot un-create the account. Refuse with a typed outcome instead.
  --
  -- The predicate MIRRORS rule 2 exactly, m.role = 'doctor' included:
  -- rule 2 fires only when OLD.role = 'doctor', so a disabled
  -- admin/nurse/receptionist who holds a doctor profile without a role
  -- change (the solo-owner shape this feature exists to support) trips
  -- no trigger and must NOT be refused here. If rule 2 is ever widened,
  -- widen this in the same commit.
  IF v_invite.role <> 'doctor' AND EXISTS (
    SELECT 1 FROM clinic_members m
    JOIN doctor_profiles dp ON dp.clinic_member_id = m.id
    WHERE m.clinic_id = v_invite.clinic_id
      AND m.user_id = v_uid
      AND m.role = 'doctor'
  ) THEN
    RETURN QUERY SELECT 'doctor_profile_exists'::TEXT, v_invite.clinic_id, NULL::UUID;
    RETURN;
  END IF;

  -- (6) Mirror the identity into users. The invitee's freshly typed
  --     name WINS over a stale one (EXCLUDED first), the opposite of
  --     create_clinic_with_owner, where the row is almost always being
  --     created rather than updated.
  INSERT INTO users (id, full_name, email)
  VALUES (v_uid, v_name, v_email)
  ON CONFLICT (id) DO UPDATE
    SET full_name = COALESCE(EXCLUDED.full_name, users.full_name),
        email     = COALESCE(users.email, EXCLUDED.email);

  -- (7) Re-inviting a DISABLED member re-activates that SAME row, so
  --     the history FR-2.10 promises stays attached to one membership.
  --     The global check above has ruled out an active membership
  --     anywhere, so the only row this can conflict with is a
  --     disabled/invited one at this clinic.
  INSERT INTO clinic_members (clinic_id, user_id, role, status)
  VALUES (v_invite.clinic_id, v_uid, v_invite.role, 'active')
  ON CONFLICT (clinic_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'active'
  RETURNING id INTO v_member_id;

  -- (8) doctor_profiles.clinic_member_id is UNIQUE (001), so an
  --     unconditional insert would raise a raw 23505 for a re-activated
  --     doctor.
  IF v_invite.role = 'doctor' THEN
    INSERT INTO doctor_profiles
      (clinic_member_id, clinic_id, specialty, slot_duration_minutes)
    VALUES
      (v_member_id, v_invite.clinic_id, v_invite.specialty,
       COALESCE(v_invite.slot_duration_minutes, 15))
    ON CONFLICT (clinic_member_id) DO UPDATE
      SET specialty             = EXCLUDED.specialty,
          slot_duration_minutes = EXCLUDED.slot_duration_minutes;
  END IF;

  -- (9) Consume the invite.
  UPDATE clinic_invites ci
     SET status      = 'accepted',
         accepted_by = v_uid,
         accepted_at = NOW()
   WHERE ci.id = v_invite.id;

  RETURN QUERY SELECT 'accepted'::TEXT, v_invite.clinic_id, v_member_id;
END;
$$;


-- ------------------------------------------------------------
-- Who may call it. See the note at the bottom of 012: Postgres grants
-- EXECUTE on a new public function to PUBLIC and Supabase exposes
-- public over PostgREST to anon, so the revoke is the control.
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION accept_clinic_invite(TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION accept_clinic_invite(TEXT, TEXT) TO authenticated;
