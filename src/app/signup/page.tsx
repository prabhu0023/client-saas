import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getStaffContext } from '@/lib/portal/auth'
import { signupMode, warnSignupDisabled } from '@/lib/portal/signup'
import { signUp } from './actions'
import styles from './signup.module.css'

/**
 * Public account creation (FR-1.1–FR-1.3): name, email, password, and —
 * unless this is a local dev server — the signup code.
 *
 * getStaffContext() runs FIRST, like /login does. Without it, an admin
 * who opens /signup and submits would createUser + signInWithPassword and
 * silently lose their own session to a different account (§11.1).
 *
 * Failures arrive as `?error=<code>` from the action; nothing the user
 * typed comes back with them, because echoing the email through the query
 * string would put it in access logs (NFR-5/6).
 */

const ERRORS: Record<string, string> = {
  name: 'Enter your name.',
  email: 'Enter a valid email address.',
  'password-short': 'Use at least 8 characters.',
  'password-long': 'Use at most 72 characters.',
  mismatch: 'Passwords do not match.',
  code: 'That signup code is not valid.',
  'email-exists': 'An account with this email already exists — sign in instead.',
  failed: 'We could not create your account. Try again.',
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const existing = await getStaffContext()
  if (existing) redirect('/dashboard')

  const { error } = await searchParams
  const mode = signupMode()

  if (mode === 'disabled') {
    warnSignupDisabled()
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <h1 className={styles.title}>DoctorDesk</h1>
          <p className={styles.notice} role="status">
            Self-serve signup is not enabled. Contact DoctorDesk.
          </p>
          <p className={styles.foot}>
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
        </div>
      </div>
    )
  }

  const message = error ? ERRORS[error] ?? 'Something went wrong.' : null

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Create your clinic</h1>
        <p className={styles.subtitle}>
          Start with your own account. You will name the clinic next.
        </p>

        {message && (
          <p className={styles.error} role="alert">
            {message}
            {error === 'email-exists' && (
              <>
                {' '}
                <Link className={styles.errorLink} href="/login">
                  Sign in
                </Link>
              </>
            )}
          </p>
        )}

        <form action={signUp}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="fullName">
              Your name
            </label>
            <input
              className={styles.input}
              id="fullName"
              name="fullName"
              type="text"
              autoComplete="name"
              maxLength={120}
              required
              aria-describedby="fullName-hint"
            />
            <p className={styles.hint} id="fullName-hint">
              Patients see this name when they pick a doctor on WhatsApp.
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">
              Email
            </label>
            <input
              className={styles.input}
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">
              Password
            </label>
            <input
              className={styles.input}
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              required
              aria-describedby="password-hint"
            />
            <p className={styles.hint} id="password-hint">
              At least 8 characters.
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="confirmPassword">
              Confirm password
            </label>
            <input
              className={styles.input}
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>

          {mode === 'coded' && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="code">
                Signup code
              </label>
              <input
                className={styles.input}
                id="code"
                name="code"
                type="text"
                autoComplete="off"
                required
                aria-describedby="code-hint"
              />
              <p className={styles.hint} id="code-hint">
                DoctorDesk gives you this when your clinic is approved.
              </p>
            </div>
          )}

          <button className={styles.button} type="submit">
            Create account
          </button>
        </form>

        <p className={styles.foot}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
