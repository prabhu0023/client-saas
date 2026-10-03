import { timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

/**
 * Public account creation for /signup (FR-1.1–FR-1.3).
 *
 * This is one of only three paths in the product that touch the service
 * role before a session exists (the other two are `loadInviteByToken` and
 * `/join`'s createUser): `auth.admin.createUser` has no non-privileged
 * equivalent. Everything after it — clinic creation included — runs as the
 * logged-in user through the RLS client.
 *
 * `/signup` is gated by `signupMode()` rather than left open, because an
 * open endpoint on a deployed instance lets anyone create a tenant.
 */

export type SignupMode = 'coded' | 'open' | 'disabled'

/**
 * Whether /signup accepts submissions, and on what terms.
 *
 * Keyed ONLY on ONBOARDING_SIGNUP_CODE and NODE_ENV, deliberately NOT on
 * VERCEL_ENV: a preview or staging deployment is a real deployment on the
 * public internet, and keying on a host-specific variable would quietly
 * open signup wherever that variable is absent or renamed. So the rule
 * fails closed — without a code, the only environment that gets an open
 * form is a local dev server.
 */
export function signupMode(): SignupMode {
  if (process.env.ONBOARDING_SIGNUP_CODE) return 'coded'
  if (process.env.NODE_ENV === 'development') return 'open'
  return 'disabled'
}

/**
 * Constant-time comparison of a submitted code against the configured one.
 *
 * The length check is not an optimisation: `timingSafeEqual` THROWS on
 * buffers of unequal length, so calling it first would turn a wrong-length
 * guess into a 500. Length is not the secret here — the code is.
 */
export function isValidSignupCode(submitted: string): boolean {
  const expected = process.env.ONBOARDING_SIGNUP_CODE
  if (!expected) return false

  const a = Buffer.from(submitted, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false

  return timingSafeEqual(a, b)
}

export interface NewAccount {
  /** Already trimmed and lower-cased by validateEmail. */
  email: string
  password: string
  /** Already trimmed by validateFullName. */
  fullName: string
}

export type CreateAccountResult =
  | { status: 'created'; userId: string }
  | { status: 'email_taken' }
  | { status: 'error'; message: string }

/**
 * Create a confirmed auth account with the service role.
 *
 * `email_confirm: true` because v1 has no email delivery at all — an
 * unconfirmed account could never be confirmed, so the user would be
 * stuck. `user_metadata.full_name` is LOAD-BEARING, not decoration:
 * `createClinic()` passes `p_full_name = NULL`, so
 * `create_clinic_with_owner` reads the name back out of
 * `auth.users.raw_user_meta_data->>'full_name'` to populate
 * `users.full_name`. Omit it and the column lands NULL, which
 * `loadDoctorOptions()` renders to patients as the literal 'Doctor'
 * (src/lib/whatsapp/query.ts).
 *
 * `email_taken` is a RETURNED OUTCOME rather than a throw because it is an
 * ordinary thing for a user to do, and because /join needs the same call
 * with the opposite meaning (there, an existing account is the
 * sign-in-instead branch rather than a refusal).
 */
export async function createAuthAccount(
  input: NewAccount,
): Promise<CreateAccountResult> {
  const { data, error } = await supabaseAdmin().auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  })

  if (error) {
    if (isEmailExists(error)) {
      console.warn('[signup] createUser outcome=email_taken')
      return { status: 'email_taken' }
    }
    // No email, no password, no metadata — just the provider's message.
    console.error(`[signup] createUser failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  if (!data.user) {
    console.error('[signup] createUser returned no user')
    return { status: 'error', message: 'createUser returned no user' }
  }

  return { status: 'created', userId: data.user.id }
}

export type SignInResult =
  | { status: 'signed_in' }
  | { status: 'error'; message: string }

/**
 * Sign the new account in on the COOKIE client, which is what writes the
 * session the following request (and `create_clinic_with_owner`) runs as.
 * Same call `src/app/login/actions.ts` makes.
 *
 * A failure here is not a dead end: the account exists, so the caller
 * sends the user to /login rather than asking them to sign up again.
 */
export async function signInNewAccount(
  email: string,
  password: string,
): Promise<SignInResult> {
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    console.error(`[signup] sign-in after createUser failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  return { status: 'signed_in' }
}

/**
 * Supabase reports a duplicate email as `code: 'email_exists'` with HTTP
 * 422. The message fallback covers older gotrue builds that set the status
 * but no code; the status alone is not enough, since 422 also carries
 * weak-password and invalid-email failures that must stay fatal.
 */
function isEmailExists(error: { code?: string; status?: number; message: string }): boolean {
  if (error.code === 'email_exists') return true
  return (
    error.status === 422 &&
    /already\s+(been\s+)?registered|already\s+exists/i.test(error.message)
  )
}
