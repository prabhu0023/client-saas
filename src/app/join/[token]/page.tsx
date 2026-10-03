import Link from 'next/link'
import { getStaffContext } from '@/lib/portal/auth'
import { INVITE_TOKEN_RE } from '@/lib/portal/invite-token'
import { loadInviteByToken } from '@/lib/portal/invites'
import type { MemberRole } from '@/types'
import { joinClinic } from './actions'
import styles from './join.module.css'

/**
 * Public invite acceptance (FR-2.5). The invitee sets their own password,
 * so nobody — including the admin who invited them — ever knows it.
 *
 * Three things about this page are deliberate:
 *
 * 1. getStaffContext() runs FIRST. An already-signed-in member sees "sign
 *    out first" instead of a form, because acceptInvite() signs in as the
 *    INVITED email and would otherwise silently replace the session of
 *    whoever clicked the link (§11.1). Echoing their own email back is
 *    safe; it is the one they are currently authenticated as.
 * 2. A malformed token is refused with NO database lookup (§12.1).
 * 3. The password copy serves the new-account and existing-account cases
 *    with one sentence, so the page never discloses whether an account
 *    exists on this email before a submit (FR-2.5).
 */

const ROLE_LABELS: Record<MemberRole, string> = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  receptionist: 'Receptionist',
  admin: 'Admin',
}

const INVALID_COPY =
  'This invite link is no longer valid. Ask your clinic admin for a new one.'
const EXPIRED_COPY = 'This invite has expired. Ask your clinic admin for a new one.'

const ERRORS: Record<string, string> = {
  name: 'Enter your name.',
  'password-short': 'Use at least 8 characters.',
  'password-long': 'Use at most 72 characters.',
  'wrong-password':
    'An account already exists for this email. Enter its password to accept.',
  'other-clinic':
    'This account already belongs to another clinic. Ask your admin to invite a different email.',
  'doctor-profile':
    'Your clinic admin needs to update this invite — ask them to re-issue it.',
  signin: 'Your account was created — please sign in and open the link again.',
  invalid: INVALID_COPY,
  expired: EXPIRED_COPY,
  failed: 'We could not complete your enrolment. Try again.',
}

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { token } = await params
  const { error } = await searchParams

  // Before anything else: whose browser is this?
  const existing = await getStaffContext()
  if (existing) {
    return (
      <Card>
        <p className={styles.notice} role="status">
          You are signed in as {existing.email ?? 'another account'}. Sign out
          first to accept this invite.
        </p>
        <form action="/logout" method="post">
          <button className={styles.button} type="submit">
            Sign out
          </button>
        </form>
      </Card>
    )
  }

  // Shape check before any lookup — a malformed link costs no query.
  if (!INVITE_TOKEN_RE.test(token)) {
    return <Dead copy={INVALID_COPY} />
  }

  const loaded = await loadInviteByToken(token)

  if (loaded.status === 'expired') return <Dead copy={EXPIRED_COPY} />
  if (loaded.status !== 'ok') return <Dead copy={INVALID_COPY} />

  const invite = loaded.invite
  const message = error ? ERRORS[error] ?? 'Something went wrong.' : null

  return (
    <Card>
      <h1 className={styles.title}>Join {invite.clinicName}</h1>
      <p className={styles.subtitle}>
        You have been invited as{' '}
        <strong>{ROLE_LABELS[invite.role] ?? invite.role}</strong> for{' '}
        <strong>{invite.email}</strong>.
      </p>

      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}

      <form action={joinClinic}>
        <input type="hidden" name="token" value={token} />

        <div className={styles.field}>
          <label className={styles.label} htmlFor="fullName">
            Your full name
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
            Patients see this name on WhatsApp, so use the one they would
            recognise.
          </p>
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
            minLength={8}
            maxLength={72}
            required
            aria-describedby="password-hint"
          />
          {/* One sentence for both cases: the page must not reveal whether
              an account already exists on this email (FR-2.5). */}
          <p className={styles.hint} id="password-hint">
            Choose a password of at least 8 characters. If you already have a
            DoctorDesk account on this email, enter that password instead.
          </p>
        </div>

        <button className={styles.button} type="submit">
          Accept invite
        </button>
      </form>

      <p className={styles.foot}>
        Not expecting this? <Link href="/login">Sign in</Link> instead.
      </p>
    </Card>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>{children}</div>
    </div>
  )
}

/** A link that cannot be used: one message, no form, no retry affordance. */
function Dead({ copy }: { copy: string }) {
  return (
    <Card>
      <h1 className={styles.title}>DoctorDesk</h1>
      <p className={styles.notice} role="status">
        {copy}
      </p>
      <p className={styles.foot}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </Card>
  )
}
