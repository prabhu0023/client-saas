import { createClient } from '@/lib/supabase/server'

/**
 * Typed wrappers over migration 012's onboarding RPCs.
 *
 * Every call goes through the RLS-RESPECTING cookie client, never the
 * service role: the RPCs are SECURITY DEFINER and take the identity from
 * `auth.uid()` inside the function, so the caller cannot supply it. That
 * is the whole reason clinic creation is an RPC rather than a
 * service-role action — see design §9.1.
 *
 * Shape follows src/lib/booking/book.ts: the RPC's outcome string is
 * mapped to a discriminated union and a BUSINESS outcome is never thrown.
 * `slug_taken` and `wacrm_taken` are things users do, not faults, and
 * both need the typed input kept on screen rather than an error page.
 * Only a transport/DB fault becomes `{ status: 'error' }`.
 */

export type MembershipStatus = 'active' | 'disabled' | 'invited'

/**
 * This user's membership status across all clinics, or null when they
 * have none — which is what /onboarding renders the create-clinic form
 * for.
 *
 * Needs the RPC rather than a plain select: `is_clinic_member()` requires
 * status='active' (003), so a disabled member cannot read their own
 * `clinic_members` row through RLS.
 *
 * A failed probe reads as null, i.e. "show the form". That is safe
 * because `create_clinic_with_owner` repeats the check as
 * `membership_disabled` — the database is the real gate (§12.3), and this
 * read only decides which copy renders first.
 */
export async function myMembershipStatus(): Promise<MembershipStatus | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('my_membership_status')

  if (error) {
    console.error(`[onboarding] my_membership_status failed: ${error.message}`)
    return null
  }

  const status = typeof data === 'string' ? data : null
  if (status === 'active' || status === 'disabled' || status === 'invited') {
    return status
  }
  return null
}

export interface NewClinic {
  /** Trimmed by validateClinicName. */
  name: string
  /** Already canonical per validateSlug — never normalised here. */
  slug: string
  /** IANA name, checked by isValidTimeZone. */
  timezone: string
}

export type CreateClinicResult =
  | { status: 'created'; clinicId: string; memberId: string }
  | { status: 'slug_taken' }
  | { status: 'already_member' }
  | { status: 'membership_disabled' }
  | { status: 'unauthenticated' }
  | { status: 'invalid' }
  | { status: 'error'; message: string }

interface CreateClinicRow {
  outcome:
    | 'created'
    | 'slug_taken'
    | 'already_member'
    | 'membership_disabled'
    | 'unauthenticated'
    | 'invalid'
  clinic_id: string | null
  member_id: string | null
}

/**
 * Create the clinic and the caller's founding admin membership, in one
 * transaction.
 *
 * `p_full_name` is deliberately NULL. The only name this wrapper could
 * supply is the one /signup already wrote into the auth user's
 * `user_metadata.full_name`, and §9.1 step 6 reads that back out of
 * `auth.users.raw_user_meta_data` itself — so there is no fourth form
 * field, no `auth.getUser()` round-trip here, and AC-2 still holds when
 * /onboarding is reached in a later session.
 */
export async function createClinic(input: NewClinic): Promise<CreateClinicResult> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_clinic_with_owner', {
    p_name: input.name,
    p_slug: input.slug,
    p_timezone: input.timezone,
    // The name lives on the auth user; see the note above.
    p_full_name: null,
  })

  if (error) {
    console.error(`[onboarding] create_clinic_with_owner failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as CreateClinicRow | undefined
  if (!row) return { status: 'error', message: 'empty rpc result' }

  switch (row.outcome) {
    case 'created':
      if (!row.clinic_id || !row.member_id) {
        return { status: 'error', message: 'created without ids' }
      }
      return { status: 'created', clinicId: row.clinic_id, memberId: row.member_id }
    case 'slug_taken':
    case 'already_member':
    case 'membership_disabled':
    case 'unauthenticated':
    case 'invalid':
      return { status: row.outcome }
    default:
      return { status: 'error', message: `unknown outcome: ${row.outcome}` }
  }
}

export interface WacrmConnection {
  clinicId: string
  /** Trimmed by validateWacrmAccountId. */
  wacrmAccountId: string
  /** null when the admin left it blank — no number row is written. */
  phoneNumberId: string | null
  displayNumber: string | null
}

export type ConnectWacrmResult =
  | { status: 'ok' }
  | { status: 'wacrm_taken' }
  | { status: 'phone_number_taken' }
  | { status: 'forbidden' }
  | { status: 'unauthenticated' }
  | { status: 'invalid' }
  /** Two admins connected at once; nothing was applied. */
  | { status: 'conflict' }
  | { status: 'error'; message: string }

interface ConnectWacrmRow {
  outcome:
    | 'ok'
    | 'wacrm_taken'
    | 'phone_number_taken'
    | 'forbidden'
    | 'unauthenticated'
    | 'invalid'
}

/**
 * Write the last hop of PRD §8's routing chain (wacrm account_id ->
 * clinic_id) and, optionally, the Meta `phone_number_id` row — both in
 * one transaction, so a `phone_number_taken` leaves the wacrm mapping
 * untouched.
 *
 * `clinicId` comes from the staff context, never from the form; the RPC
 * re-checks it with `is_clinic_admin()` and answers `forbidden`.
 *
 * A raw 23505 here is the partial unique index `idx_clinic_wacrm_one_active`
 * losing a race with another admin's connect. The transaction rolled back,
 * so it is a plain retry rather than a half-applied state.
 */
export async function connectWacrmAccount(
  input: WacrmConnection,
): Promise<ConnectWacrmResult> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('connect_wacrm_account', {
    p_clinic_id: input.clinicId,
    p_wacrm_account_id: input.wacrmAccountId,
    p_phone_number_id: input.phoneNumberId,
    p_display_number: input.displayNumber,
  })

  if (error) {
    if (error.code === '23505') {
      console.warn(
        `[onboarding] connect_wacrm_account raced for clinic ${input.clinicId}`,
      )
      return { status: 'conflict' }
    }
    console.error(`[onboarding] connect_wacrm_account failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as ConnectWacrmRow | undefined
  if (!row) return { status: 'error', message: 'empty rpc result' }

  switch (row.outcome) {
    case 'ok':
      return { status: 'ok' }
    case 'wacrm_taken':
    case 'phone_number_taken':
    case 'forbidden':
    case 'unauthenticated':
    case 'invalid':
      return { status: row.outcome }
    default:
      return { status: 'error', message: `unknown outcome: ${row.outcome}` }
  }
}
