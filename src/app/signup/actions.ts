'use server'

import { redirect } from 'next/navigation'
import {
  validateEmail,
  validateFullName,
  validatePassword,
} from '@/lib/portal/onboarding-validate'
import {
  createAuthAccount,
  isValidSignupCode,
  signInNewAccount,
  signupMode,
} from '@/lib/portal/signup'

/**
 * Account creation for /signup (FR-1.1–FR-1.3), then straight on to
 * /onboarding to create the clinic.
 *
 * Failures come back as `?error=<code>` and the page renders the copy,
 * the way login/actions.ts already does. The typed email is deliberately
 * NOT echoed back in the query string: it would put an email into server
 * access logs and referrers, and NFR-5/6 keeps emails out of logs
 * entirely. So a failed submit costs the user a re-type — the same trade
 * /login already makes.
 *
 * `redirect()` is called outside any try/catch, since Next implements it
 * by throwing.
 */
export async function signUp(formData: FormData): Promise<void> {
  const mode = signupMode()

  // Defence in depth: the page renders no form in this mode, so reaching
  // here means a crafted post.
  if (mode === 'disabled') {
    console.warn('[signup] submission refused — signup is disabled')
    redirect('/signup')
  }

  const name = validateFullName(String(formData.get('fullName') ?? ''))
  if (!name.ok) redirect('/signup?error=name')

  const email = validateEmail(String(formData.get('email') ?? ''))
  if (!email.ok) redirect('/signup?error=email')

  const rawPassword = String(formData.get('password') ?? '')
  const password = validatePassword(rawPassword)
  if (!password.ok) {
    redirect(`/signup?error=${rawPassword.length < 8 ? 'password-short' : 'password-long'}`)
  }

  if (rawPassword !== String(formData.get('confirmPassword') ?? '')) {
    redirect('/signup?error=mismatch')
  }

  if (mode === 'coded' && !isValidSignupCode(String(formData.get('code') ?? ''))) {
    // Generic on purpose: never say whether the code was close.
    console.warn('[signup] rejected an invalid signup code')
    redirect('/signup?error=code')
  }

  const created = await createAuthAccount({
    email: email.value,
    password: rawPassword,
    fullName: name.value,
  })

  if (created.status === 'email_taken') redirect('/signup?error=email-exists')
  if (created.status === 'error') redirect('/signup?error=failed')

  const signedIn = await signInNewAccount(email.value, rawPassword)

  // The account exists either way, so a failed sign-in is a detour to
  // /login rather than a dead end.
  if (signedIn.status !== 'signed_in') {
    redirect('/login?error=signin-after-signup')
  }

  redirect('/onboarding')
}
