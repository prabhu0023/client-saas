'use client'

import { useActionState, useState } from 'react'
import type { InviteFormState } from '@/lib/portal/invites'
import { inviteMember } from './actions'
import styles from './staff.module.css'

/**
 * The invite form (FR-2.2–FR-2.5).
 *
 * A client component for one reason: the one-time link exists for a single
 * render. The token is unrecoverable once this state is gone — the
 * database holds only its sha256 — so useActionState is what lets the
 * action hand the link back without storing it anywhere.
 *
 * The doctor-only fields appear only for a doctor invite, because 013
 * CHECKs that a non-doctor invite carries neither (and the action nulls
 * them regardless).
 *
 * The panel copy tells the admin to send the link one-to-one. That is a
 * procedural mitigation for a real residual risk, not boilerplate: whoever
 * opens the link first sets the password for that email, and v1 has no
 * password reset to undo it (§9.3).
 */

const INITIAL: InviteFormState = {
  error: null,
  link: null,
  email: null,
  replaced: false,
}

export function InviteForm() {
  const [state, formAction, pending] = useActionState(inviteMember, INITIAL)
  const [role, setRole] = useState('receptionist')
  const [copied, setCopied] = useState(false)

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      // Clipboard access can be refused; the field is selectable anyway.
      setCopied(false)
    }
  }

  return (
    <div>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}

      {state.link && (
        <div className={styles.linkPanel}>
          <h3 className={styles.linkTitle}>Invite link ready</h3>
          <p className={styles.linkCopy}>
            {state.replaced
              ? 'Previous invite replaced. '
              : ''}
            Send this link to <strong>{state.email}</strong> one-to-one —
            not to a group. Whoever opens it first sets the password for
            that email, and it works once.
          </p>
          <div className={styles.linkRow}>
            <label className={styles.srOnly} htmlFor="invite-link">
              Invite link
            </label>
            <input
              className={styles.linkInput}
              id="invite-link"
              readOnly
              value={state.link}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              className={styles.secondaryBtn}
              type="button"
              onClick={() => copyLink(state.link!)}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className={styles.linkWarn} role="status">
            This is the only time the link is shown. To issue another one,
            invite the same email again.
          </p>
        </div>
      )}

      <form className={styles.inviteForm} action={formAction}>
        <div className={styles.inviteField}>
          <label className={styles.label} htmlFor="invite-email">
            Email
          </label>
          <input
            className={styles.input}
            id="invite-email"
            name="email"
            type="email"
            autoComplete="off"
            required
          />
        </div>

        <div className={styles.inviteField}>
          <label className={styles.label} htmlFor="invite-role">
            Role
          </label>
          <select
            className={styles.select}
            id="invite-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="doctor">Doctor</option>
            <option value="nurse">Nurse</option>
            <option value="receptionist">Receptionist</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        {role === 'doctor' && (
          <>
            <div className={styles.inviteField}>
              <label className={styles.label} htmlFor="invite-specialty">
                Specialty <span className={styles.optional}>(optional)</span>
              </label>
              <input
                className={styles.input}
                id="invite-specialty"
                name="specialty"
                type="text"
                maxLength={80}
              />
            </div>

            <div className={styles.inviteField}>
              <label className={styles.label} htmlFor="invite-slot">
                Slot length
              </label>
              <input
                className={styles.input}
                id="invite-slot"
                name="slotMinutes"
                type="number"
                min={5}
                max={240}
                defaultValue={15}
                aria-describedby="invite-slot-hint"
              />
              <p className={styles.hint} id="invite-slot-hint">
                Minutes per appointment, 5–240.
              </p>
            </div>
          </>
        )}

        <button className={styles.primaryBtn} type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create invite link'}
        </button>
      </form>
    </div>
  )
}
