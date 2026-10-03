'use server'

import { redirect } from 'next/navigation'
import { INVITE_TOKEN_RE } from '@/lib/portal/invite-token'
import { acceptInvite } from '@/lib/portal/invites'

/**
 * Accept a staff invite (FR-2.5), then land in the portal.
 *
 * Every outcome maps to a `?error=` code the page renders, the way
 * login/actions.ts and signup/actions.ts already do. Nothing the invitee
 * typed is echoed back through the query string, and no token, email or
 * password is logged anywhere in this path (NFR-5/6) — acceptInvite()
 * logs outcome codes and 8-character hash prefixes only.
 *
 * `redirect()` is called outside any try/catch, since Next implements it
 * by throwing.
 */
export async function joinClinic(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '')

  // The redirect target is built from a SHAPE-CHECKED token only: a
  // crafted post must not get its payload reflected back into a URL. A
  // malformed token falls back to a path that fails the same check on the
  // page, which renders the generic invalid-invite copy.
  const back = INVITE_TOKEN_RE.test(token) ? `/join/${token}` : '/join/link'

  const result = await acceptInvite({
    token,
    fullName: String(formData.get('fullName') ?? ''),
    password: String(formData.get('password') ?? ''),
  })

  if (result.status === 'invalid_name') redirect(`${back}?error=name`)

  if (result.status === 'invalid_password') {
    redirect(`${back}?error=password-${result.reason}`)
  }

  // An existing account whose password did not match. This is the only
  // account-existence signal the product gives, and only after a submit.
  if (result.status === 'wrong_password') redirect(`${back}?error=wrong-password`)

  // The account exists but no session does — they can finish from /login.
  if (result.status === 'sign_in_failed') redirect(`${back}?error=signin`)

  if (result.status === 'already_member') {
    // Same clinic: they are simply already in. Different clinic: v1 is
    // single-membership, so the fix is a different email (§12.3). The
    // invite is left pending either way, so nothing is burned.
    redirect(
      result.sameClinic
        ? '/dashboard?error=already-member'
        : `${back}?error=other-clinic`,
    )
  }

  if (result.status === 'doctor_profile_exists') {
    // The invite stays pending, so the admin's fix needs no new link.
    redirect(`${back}?error=doctor-profile`)
  }

  if (result.status === 'expired') redirect(`${back}?error=expired`)

  // Unknown, revoked, consumed, or an email_mismatch that can only come
  // from a direct RPC call — one generic message for all of them, so a
  // probe learns nothing from the difference.
  if (
    result.status === 'invalid_token' ||
    result.status === 'not_found' ||
    result.status === 'revoked' ||
    result.status === 'already_used' ||
    result.status === 'email_mismatch' ||
    result.status === 'invalid'
  ) {
    redirect(`${back}?error=invalid`)
  }

  if (result.status === 'error') redirect(`${back}?error=failed`)

  redirect('/dashboard')
}
