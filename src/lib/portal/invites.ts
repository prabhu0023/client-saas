import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import {
  INVITE_TOKEN_RE,
  generateInviteToken,
  hashInviteToken,
  inviteUrl,
} from './invite-token'
import { validateFullName, validatePassword } from './onboarding-validate'
import { createAuthAccount } from './signup'
import type { MemberRole } from '@/types'

/**
 * Staff invites (ONB-2) over migration 013's `clinic_invites` and
 * `accept_clinic_invite`.
 *
 * No SMTP is configured and the design rules out an email provider, so an
 * invite is a one-time LINK the admin shares over whatever channel they
 * already use. The plaintext token is returned exactly once, by
 * `createInvite()`, and is never logged: only the sha256 is stored and only
 * an 8-character hash prefix ever reaches a log line (NFR-5/6).
 *
 * Reads and writes here go through the RLS client, whose 013 policies are
 * admin-only for this table — with ONE deliberate exception:
 * `loadInviteByToken()` uses the service role, because the invitee has no
 * account yet and therefore no RLS identity to scope the read to (NFR-3
 * path b).
 */

/** How long a link stays usable. Mirrors 013's column default. */
const INVITE_TTL_DAYS = 7

// ------------------------------------------------------------
// Listing pending invites (the /staff "Pending invites" section)
// ------------------------------------------------------------

export interface PendingInvite {
  id: string
  email: string
  role: MemberRole
  specialty: string | null
  slotDurationMinutes: number | null
  expiresAt: string
  /** Expiry is DERIVED (013): a row stays 'pending' past its date. */
  expired: boolean
  createdAt: string
}

/**
 * Pending invites for the clinic, newest first.
 *
 * `token_hash` is deliberately not selected — nothing outside this module
 * needs it, and a row that never carries it cannot be rendered or logged
 * by accident.
 */
export async function listInvites(clinicId: string): Promise<PendingInvite[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('clinic_invites')
    .select('id, email, role, specialty, slot_duration_minutes, expires_at, created_at')
    .eq('clinic_id', clinicId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`invites fetch: ${error.message}`)

  const now = Date.now()
  return (data ?? []).map((row) => {
    const r = row as unknown as {
      id: string
      email: string
      role: MemberRole
      specialty: string | null
      slot_duration_minutes: number | null
      expires_at: string
      created_at: string
    }
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      specialty: r.specialty,
      slotDurationMinutes: r.slot_duration_minutes,
      expiresAt: r.expires_at,
      expired: new Date(r.expires_at).getTime() <= now,
      createdAt: r.created_at,
    }
  })
}

// ------------------------------------------------------------
// Creating an invite
// ------------------------------------------------------------

export interface NewInvite {
  clinicId: string
  /** clinic_members.id of the issuing admin, for the audit column. */
  createdByMemberId: string | null
  /** Lower-cased here as well as by validateEmail — 013 CHECKs it. */
  email: string
  role: MemberRole
  /** Doctor invites only; forced to null for every other role (013 CHECK). */
  specialty: string | null
  slotMinutes: number | null
}

export type CreateInviteResult =
  /** `url` is the ONLY time the plaintext token is available. */
  | { status: 'created'; url: string; email: string; replaced: boolean }
  | { status: 'already_member' }
  /** Lost the (clinic_id, email) race twice — see the retry note below. */
  | { status: 'raced' }
  | { status: 'error'; message: string }

/**
 * What `InviteForm` renders after a submit (useActionState), mirroring
 * `ReplyState` in messages.ts: the state type lives with the module that
 * produces it, not in the action file.
 *
 * `link` is the ONE place the plaintext token surfaces. It is returned for
 * a single render and stored nowhere, so a reload shows an empty form
 * rather than a link somebody could redeem later.
 */
export interface InviteFormState {
  error: string | null
  link: string | null
  email: string | null
  /** A previous pending invite for this email was revoked first. */
  replaced: boolean
}

/**
 * Issue a one-time invite link.
 *
 * THROWS when NEXT_PUBLIC_APP_URL is unset, and does so BEFORE touching
 * the database: a link built against a missing origin cannot be opened, so
 * inserting first would burn a token (and the partial unique index) on an
 * invite nobody could ever accept. The caller turns the throw into
 * §12.2's "Invite links are not configured. Contact DoctorDesk."
 */
export async function createInvite(input: NewInvite): Promise<CreateInviteResult> {
  const email = input.email.trim().toLowerCase()
  const isDoctor = input.role === 'doctor'

  // Build the link FIRST. inviteUrl() throws when NEXT_PUBLIC_APP_URL is
  // unset, which must happen before any write (§12.2).
  const token = generateInviteToken()
  const url = inviteUrl(token)
  const tokenHash = hashInviteToken(token)

  const supabase = await createClient()

  const already = await emailBelongsToActiveMember(supabase, input.clinicId, email)
  if (already.status === 'error') return { status: 'error', message: already.message }
  if (already.isMember) return { status: 'already_member' }

  // "Resend" is revoke + create new: the original token is unrecoverable
  // by design, so there is nothing to re-show.
  const replaced = await revokePendingFor(supabase, input.clinicId, email)

  const row = {
    clinic_id: input.clinicId,
    email,
    role: input.role,
    specialty: isDoctor ? input.specialty : null,
    slot_duration_minutes: isDoctor ? input.slotMinutes : null,
    // Only the hash is ever stored.
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
    created_by: input.createdByMemberId,
  }

  const first = await supabase.from('clinic_invites').insert(row)

  if (first.error) {
    // idx_clinic_invites_one_pending: another admin inserted a pending
    // invite for this email between the revoke above and this insert.
    // Retry ONCE after revoking again — bounded on purpose, because a
    // loop here is a loop against another request that is also retrying.
    if (first.error.code === '23505') {
      console.warn(`[invites] pending-invite race for clinic ${input.clinicId}`)
      await revokePendingFor(supabase, input.clinicId, email)
      const second = await supabase.from('clinic_invites').insert(row)
      if (second.error) {
        if (second.error.code === '23505') return { status: 'raced' }
        console.error(`[invites] insert failed: ${second.error.message}`)
        return { status: 'error', message: second.error.message }
      }
      return { status: 'created', url, email, replaced: true }
    }

    console.error(`[invites] insert failed: ${first.error.message}`)
    return { status: 'error', message: first.error.message }
  }

  if (replaced) {
    console.info(`[invites] replaced a pending invite for clinic ${input.clinicId}`)
  }

  return { status: 'created', url, email, replaced }
}

/** Revoke any pending invite for this (clinic, email). True if one was. */
async function revokePendingFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  email: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('clinic_invites')
    .update({ status: 'revoked' })
    .eq('clinic_id', clinicId)
    .eq('email', email)
    .eq('status', 'pending')
    .select('id')

  if (error) {
    console.error(`[invites] revoke-before-create failed: ${error.message}`)
    return false
  }
  return (data ?? []).length > 0
}

/**
 * Is this email already an ACTIVE member of the clinic?
 *
 * Resolved through `clinic_member_identities()` (012) and deliberately
 * NEVER through `from('users')`: `users_self_access` is
 * `USING (id = auth.uid())` (003, untouched by 014), so a colleague lookup
 * on `users` returns zero rows and the check would be a silent no-op — the
 * admin would get a link and acceptance would then resolve to
 * `already_member` (§9.3 step 6).
 *
 * The helper returns no status column, so the active filter comes from the
 * `clinic_members` rows an admin can read under 014's member-read policy.
 */
async function emailBelongsToActiveMember(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  email: string,
): Promise<{ status: 'ok'; isMember: boolean } | { status: 'error'; message: string }> {
  const [identities, members] = await Promise.all([
    supabase.rpc('clinic_member_identities', { target_clinic: clinicId }),
    supabase
      .from('clinic_members')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('status', 'active'),
  ])

  if (identities.error) {
    console.error(`[invites] member identities read failed: ${identities.error.message}`)
    return { status: 'error', message: identities.error.message }
  }
  if (members.error) {
    console.error(`[invites] member read failed: ${members.error.message}`)
    return { status: 'error', message: members.error.message }
  }

  const activeIds = new Set(
    ((members.data ?? []) as unknown as Array<{ id: string }>).map((m) => m.id),
  )
  const rows = (identities.data ?? []) as unknown as Array<{
    member_id: string
    email: string | null
  }>

  const isMember = rows.some(
    (r) => activeIds.has(r.member_id) && (r.email ?? '').toLowerCase() === email,
  )
  return { status: 'ok', isMember }
}

// ------------------------------------------------------------
// Revoking
// ------------------------------------------------------------

export type RevokeInviteResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'error'; message: string }

/**
 * Revoke a pending invite. The clinic id is passed explicitly even though
 * RLS already scopes the update — house convention (`appointments.ts`),
 * and it keeps the intent legible.
 */
export async function revokeInvite(
  clinicId: string,
  inviteId: string,
): Promise<RevokeInviteResult> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('clinic_invites')
    .update({ status: 'revoked' })
    .eq('id', inviteId)
    .eq('clinic_id', clinicId)
    .eq('status', 'pending')
    .select('id')

  if (error) {
    console.error(`[invites] revoke failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }
  if ((data ?? []).length === 0) return { status: 'not_found' }
  return { status: 'ok' }
}

// ------------------------------------------------------------
// The pre-session read for /join/<token>
// ------------------------------------------------------------

export interface InviteForJoin {
  clinicId: string
  clinicName: string
  role: MemberRole
  /** The invited address. Shown on the page; FR-2.5 allows it. */
  email: string
}

export type LoadInviteResult =
  | { status: 'ok'; invite: InviteForJoin }
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'already_used' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

/**
 * Resolve an invite from its plaintext token, with the SERVICE ROLE.
 *
 * This is one of only three pre-session service-role paths in the product
 * (NFR-3): the invitee has no account yet, so there is no RLS identity to
 * read 013's admin-only table under. It returns the minimum /join has to
 * render — clinic name, role, invited email — and nothing else.
 *
 * Expiry is derived here exactly as the RPC derives it, so a link whose
 * row is still `pending` past its date renders the expired copy instead of
 * a form that would fail on submit.
 */
export async function loadInviteByToken(token: string): Promise<LoadInviteResult> {
  const tokenHash = hashInviteToken(token)
  const prefix = tokenHash.slice(0, 8)

  const { data, error } = await supabaseAdmin()
    .from('clinic_invites')
    .select('clinic_id, role, email, status, expires_at, clinics!inner(name)')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error) {
    console.error(`[invites] token lookup failed (${prefix}): ${error.message}`)
    return { status: 'error', message: error.message }
  }

  if (!data) {
    console.warn(`[invites] unknown invite token (${prefix})`)
    return { status: 'not_found' }
  }

  const row = data as unknown as {
    clinic_id: string
    role: MemberRole
    email: string
    status: 'pending' | 'accepted' | 'revoked'
    expires_at: string
    clinics: { name: string } | { name: string }[] | null
  }

  if (row.status === 'accepted') {
    console.warn(`[invites] invite already used (${prefix})`)
    return { status: 'already_used' }
  }
  if (row.status === 'revoked') {
    console.warn(`[invites] invite revoked (${prefix})`)
    return { status: 'revoked' }
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    console.warn(`[invites] invite expired (${prefix})`)
    return { status: 'expired' }
  }

  const clinic = Array.isArray(row.clinics) ? row.clinics[0] : row.clinics

  return {
    status: 'ok',
    invite: {
      clinicId: row.clinic_id,
      clinicName: clinic?.name ?? 'the clinic',
      role: row.role,
      email: row.email,
    },
  }
}

// ------------------------------------------------------------
// Acceptance
// ------------------------------------------------------------

export interface AcceptInviteInput {
  /** Raw path segment; the shape is checked here before any DB call. */
  token: string
  fullName: string
  password: string
}

export type AcceptInviteResult =
  | { status: 'accepted'; clinicId: string; memberId: string }
  /** Token shape failed — no DB call was made. */
  | { status: 'invalid_token' }
  | { status: 'invalid_name' }
  | { status: 'invalid_password'; reason: 'short' | 'long' }
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'already_used' }
  | { status: 'expired' }
  /** `sameClinic` picks between §12.2's two copies. */
  | { status: 'already_member'; sameClinic: boolean }
  | { status: 'doctor_profile_exists' }
  /** An account exists on this email and the password did not match. */
  | { status: 'wrong_password' }
  /** The account exists but the session does not — send them to /login. */
  | { status: 'sign_in_failed' }
  /** Defence-in-depth only; unreachable from /join (§9.3). */
  | { status: 'email_mismatch' }
  /** The RPC re-validated the name and refused it — validator drift. */
  | { status: 'invalid' }
  | { status: 'error'; message: string }

interface AcceptInviteRow {
  outcome:
    | 'accepted'
    | 'unauthenticated'
    | 'not_found'
    | 'expired'
    | 'already_used'
    | 'revoked'
    | 'email_mismatch'
    | 'already_member'
    | 'doctor_profile_exists'
    | 'invalid'
  clinic_id: string | null
  member_id: string | null
}

/**
 * Accept an invite: create (or recognise) the auth account, sign in, and
 * run the enrolment transaction — in the order §9.3 fixes.
 *
 * Two rules in here are load-bearing rather than stylistic:
 *
 * 1. A `422 email_exists` from createUser is NOT an error. It is the
 *    "this person already has an account" branch, and it flows on to the
 *    sign-in unchanged — which is also the only account-existence signal
 *    the product gives, and only after a submit (FR-2.5).
 *
 * 2. The cookie client is created ONCE. `signInWithPassword` and
 *    `rpc('accept_clinic_invite', …)` both run on THAT instance, because
 *    the first instance holds the fresh access token in memory. A second
 *    `createClient()` between them would have to re-read the auth cookie
 *    written moments earlier in the same server action; if that missed,
 *    the RPC would answer `unauthenticated` AFTER the auth account had
 *    already been created — a half-done enrolment nothing can undo
 *    (§9.3 step 4).
 */
export async function acceptInvite(
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  // (1) Shape and form first, with no DB call on failure.
  if (!INVITE_TOKEN_RE.test(input.token)) return { status: 'invalid_token' }

  const name = validateFullName(input.fullName)
  if (!name.ok) return { status: 'invalid_name' }

  const password = validatePassword(input.password)
  if (!password.ok) {
    return {
      status: 'invalid_password',
      reason: input.password.length < 8 ? 'short' : 'long',
    }
  }

  // (2) The invite itself, service role.
  const loaded = await loadInviteByToken(input.token)
  if (loaded.status !== 'ok') return loaded
  const invite = loaded.invite

  // (3) The auth account. ONBOARDING_SIGNUP_CODE does NOT gate this: the
  //     256-bit token, already proven pending and unexpired, is the
  //     authorization.
  const created = await createAuthAccount({
    email: invite.email,
    password: input.password,
    fullName: name.value,
  })

  const existingAccount = created.status === 'email_taken'
  if (existingAccount) {
    console.info('[invites] createUser outcome=existing_account')
  }
  if (created.status === 'error') {
    return { status: 'error', message: created.message }
  }

  // (4) ONE cookie client, used for the sign-in AND the RPC below.
  const supabase = await createClient()
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: invite.email,
    password: input.password,
  })

  if (signInError) {
    if (existingAccount) {
      // The ordinary case: they have an account, they typed the wrong
      // password for it. Nothing was created, nothing is stuck.
      console.warn('[invites] sign-in refused for an existing account')
      return { status: 'wrong_password' }
    }
    console.error(`[invites] sign-in after createUser failed: ${signInError.message}`)
    return { status: 'sign_in_failed' }
  }

  // (5) The enrolment transaction, on the SAME client instance.
  const { data, error } = await supabase.rpc('accept_clinic_invite', {
    p_token_hash: hashInviteToken(input.token),
    p_full_name: name.value,
  })

  if (error) {
    console.error(`[invites] accept_clinic_invite failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as AcceptInviteRow | undefined
  if (!row) return { status: 'error', message: 'empty rpc result' }

  switch (row.outcome) {
    case 'accepted':
      if (!row.clinic_id || !row.member_id) {
        return { status: 'error', message: 'accepted without ids' }
      }
      console.info(`[invites] accepted for member ${row.member_id}`)
      return { status: 'accepted', clinicId: row.clinic_id, memberId: row.member_id }

    case 'already_member': {
      // The invite is left pending, so nothing is burned either way; which
      // copy to show depends on WHERE the existing membership is.
      const sameClinic = await isActiveMemberOf(supabase, invite.clinicId)
      console.info(`[invites] outcome=already_member same_clinic=${sameClinic}`)
      return { status: 'already_member', sameClinic }
    }

    case 'doctor_profile_exists':
      console.warn(
        `[invites] outcome=doctor_profile_exists for clinic ${invite.clinicId}`,
      )
      return { status: 'doctor_profile_exists' }

    case 'unauthenticated':
      // Unreachable while the client-instance rule above holds; kept
      // because the auth account already exists by this point (§12.2).
      console.error('[invites] rpc returned unauthenticated after a sign-in')
      return { status: 'sign_in_failed' }

    case 'email_mismatch':
      // /join always signs in AS the invited email, so this means the RPC
      // was called directly.
      console.error('[invites] outcome=email_mismatch — direct rpc caller')
      return { status: 'email_mismatch' }

    case 'invalid':
      console.error('[invites] accept_clinic_invite returned invalid — validator drift')
      return { status: 'invalid' }

    case 'not_found':
    case 'expired':
    case 'already_used':
    case 'revoked':
      console.warn(`[invites] outcome=${row.outcome} at rpc time`)
      return { status: row.outcome }

    default:
      return { status: 'error', message: `unknown outcome: ${row.outcome}` }
  }
}

/**
 * Does the just-signed-in user's active membership belong to this clinic?
 *
 * Only called on the `already_member` path. A failed read reads as "no",
 * which picks the generic "belongs to another clinic" copy rather than
 * sending someone to a dashboard they may have no membership for.
 */
async function isActiveMemberOf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('clinic_members')
    .select('clinic_id')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (error || !data) return false
  return (data as unknown as { clinic_id: string }).clinic_id === clinicId
}
