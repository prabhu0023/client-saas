import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getStaffContext } from '@/lib/portal/auth'
import { signIn } from './actions'
import styles from './login.module.css'

// 'no-clinic' is gone: requireStaff() was its only producer and it now
// sends a clinic-less user to /onboarding, so a stale bookmark falls
// through to the generic message rather than claiming something untrue.
const ERRORS: Record<string, string> = {
  missing: 'Enter your email and password.',
  invalid: 'Incorrect email or password.',
  'signin-after-signup': 'Account created — please sign in.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  // Already signed in with an active clinic? Skip the form.
  const existing = await getStaffContext()
  if (existing) redirect('/dashboard')

  const { error } = await searchParams
  const message = error ? ERRORS[error] ?? 'Something went wrong.' : null

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>DoctorDesk</h1>
        <p className={styles.subtitle}>Sign in to the staff portal</p>

        {message && (
          <p className={styles.error} role="alert">
            {message}
          </p>
        )}

        <form action={signIn}>
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
              autoComplete="current-password"
              required
            />
          </div>

          <button className={styles.button} type="submit">
            Sign in
          </button>
        </form>

        <p className={styles.foot}>
          New here? <Link href="/signup">Create a clinic</Link>
        </p>
      </div>
    </div>
  )
}
