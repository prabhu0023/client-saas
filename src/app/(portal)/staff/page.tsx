import { requireAdmin } from '@/lib/portal/roles'
import { listInvites } from '@/lib/portal/invites'
import { listMembers, STAFF_MESSAGES, type MemberListItem } from '@/lib/portal/staff'
import type { MemberRole } from '@/types'
import {
  changeMemberRole,
  changeMemberStatus,
  removeDoctorProfileFor,
  revokePendingInvite,
  saveDoctorProfile,
} from './actions'
import { InviteForm } from './InviteForm'
import styles from './staff.module.css'

/**
 * Members and pending invites (FR-2.6–FR-2.11). Admin-only via
 * requireAdmin(); 014's admin-write policies are the actual boundary.
 *
 * Two sections rather than one list, because a pending invite is not a
 * member: `clinic_members.user_id` is NOT NULL, so no row can exist until
 * the invitee has an auth account (§9.3).
 *
 * The Doctor profile control sits on EVERY active member row regardless of
 * role. That is the point of FR-2.11: being bookable is having a
 * `doctor_profiles` row with an active membership, not having
 * `role='doctor'` — which is how a one-person clinic gets its one doctor
 * without a role change the last-admin guard would reject anyway (§9.4a).
 */

const ROLE_LABELS: Record<MemberRole, string> = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  receptionist: 'Receptionist',
  admin: 'Admin',
}

const ERRORS: Record<string, string> = {
  role: 'Choose a role.',
  specialty: 'Specialty is too long.',
  registration: 'Registration number is too long.',
  slot: 'Slot length must be between 5 and 240 minutes.',
  'last-admin': STAFF_MESSAGES.lastActiveAdmin,
  'doctor-locked': STAFF_MESSAGES.doctorRoleLocked,
  'has-appointments': STAFF_MESSAGES.doctorHasAppointments,
  'not-active': STAFF_MESSAGES.memberNotActive,
  'not-in-clinic': STAFF_MESSAGES.memberNotInClinic,
  'no-profile': 'That member has no doctor profile.',
  'member-not-found': 'That member is no longer on this clinic.',
  'invite-not-found': 'That invite is no longer pending.',
  failed: 'Something went wrong. Try again.',
}

const SAVED: Record<string, string> = {
  role: 'Role updated.',
  status: 'Member updated.',
  profile: 'Doctor profile saved.',
  'profile-removed': 'Doctor profile removed.',
  'invite-revoked': 'Invite revoked — that link no longer works.',
}

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>
}) {
  const { clinic, member } = await requireAdmin()
  const { error, saved } = await searchParams

  const [members, invites] = await Promise.all([
    listMembers(clinic.id),
    listInvites(clinic.id),
  ])

  const errorMessage = error ? ERRORS[error] ?? 'Something went wrong.' : null
  const savedMessage = saved ? SAVED[saved] ?? null : null

  return (
    <div>
      <div className={styles.head}>
        <h1 className={styles.title}>Staff</h1>
        <p className={styles.sub}>
          Who can use this clinic&rsquo;s portal, and who patients can book on
          WhatsApp.
        </p>
      </div>

      {errorMessage && (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      )}
      {savedMessage && (
        <p className={styles.saved} role="status">
          {savedMessage}
        </p>
      )}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Members</h2>
        <ul className={styles.memberList}>
          {members.map((m) => (
            <MemberRow key={m.id} member={m} isSelf={m.id === member.id} />
          ))}
        </ul>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Invite someone</h2>
        <InviteForm />
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Pending invites</h2>
        {invites.length === 0 ? (
          <p className={styles.emptyInline}>No invites waiting to be accepted.</p>
        ) : (
          <ul className={styles.inviteList}>
            {invites.map((invite) => (
              <li className={styles.inviteRow} key={invite.id}>
                <div>
                  <div className={styles.inviteEmail}>{invite.email}</div>
                  <div className={styles.inviteMeta}>
                    {ROLE_LABELS[invite.role] ?? invite.role} ·{' '}
                    {invite.expired
                      ? 'expired'
                      : `expires ${invite.expiresAt.slice(0, 10)}`}
                  </div>
                </div>
                <form action={revokePendingInvite}>
                  <input type="hidden" name="inviteId" value={invite.id} />
                  <button className={styles.secondaryBtn} type="submit">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function MemberRow({
  member,
  isSelf,
}: {
  member: MemberListItem
  isSelf: boolean
}) {
  const profile = member.doctorProfile
  const isActive = member.status === 'active'

  return (
    <li className={`${styles.member} ${isActive ? '' : styles.memberOff}`}>
      <div className={styles.memberHead}>
        <div className={styles.memberWho}>
          <span className={styles.memberName}>
            {member.fullName ?? 'Name not set'}
            {isSelf && <span className={styles.selfTag}>you</span>}
          </span>
          <span className={styles.memberEmail}>{member.email ?? '—'}</span>
        </div>
        <div className={styles.badges}>
          <span className={styles.badge}>
            {ROLE_LABELS[member.role] ?? member.role}
          </span>
          {profile && <span className={styles.badgeDoctor}>bookable</span>}
          {!isActive && <span className={styles.badgeOff}>{member.status}</span>}
        </div>
      </div>

      <div className={styles.controls}>
        <form className={styles.inlineForm} action={changeMemberRole}>
          <input type="hidden" name="memberId" value={member.id} />
          <label className={styles.srOnly} htmlFor={`role-${member.id}`}>
            Role for {member.fullName ?? member.email ?? 'this member'}
          </label>
          <select
            className={styles.select}
            id={`role-${member.id}`}
            name="role"
            defaultValue={member.role}
          >
            <option value="doctor">Doctor</option>
            <option value="nurse">Nurse</option>
            <option value="receptionist">Receptionist</option>
            <option value="admin">Admin</option>
          </select>
          <button className={styles.secondaryBtn} type="submit">
            Save role
          </button>
        </form>

        <form className={styles.inlineForm} action={changeMemberStatus}>
          <input type="hidden" name="memberId" value={member.id} />
          <input
            type="hidden"
            name="status"
            value={isActive ? 'disabled' : 'active'}
          />
          <button className={styles.secondaryBtn} type="submit">
            {isActive ? 'Disable' : 'Re-enable'}
          </button>
        </form>
      </div>

      {isActive && (
        <details className={styles.profileBox} open={Boolean(profile)}>
          <summary className={styles.profileSummary}>
            {profile ? 'Doctor profile' : 'Add a doctor profile'}
          </summary>

          <p className={styles.profileHint}>
            A doctor profile is what makes this member bookable on WhatsApp
            and attachable to consulting hours. Their role does not change.
          </p>

          <form className={styles.profileForm} action={saveDoctorProfile}>
            <input type="hidden" name="memberId" value={member.id} />

            <div className={styles.profileField}>
              <label className={styles.label} htmlFor={`specialty-${member.id}`}>
                Specialty <span className={styles.optional}>(optional)</span>
              </label>
              <input
                className={styles.input}
                id={`specialty-${member.id}`}
                name="specialty"
                type="text"
                maxLength={80}
                defaultValue={profile?.specialty ?? ''}
              />
            </div>

            <div className={styles.profileField}>
              <label
                className={styles.label}
                htmlFor={`registration-${member.id}`}
              >
                Registration number{' '}
                <span className={styles.optional}>(optional)</span>
              </label>
              <input
                className={styles.input}
                id={`registration-${member.id}`}
                name="registrationNumber"
                type="text"
                maxLength={64}
                defaultValue={profile?.registrationNumber ?? ''}
              />
            </div>

            <div className={styles.profileField}>
              <label className={styles.label} htmlFor={`slot-${member.id}`}>
                Slot length
              </label>
              <input
                className={styles.input}
                id={`slot-${member.id}`}
                name="slotMinutes"
                type="number"
                min={5}
                max={240}
                defaultValue={profile?.slotMinutes ?? 15}
              />
            </div>

            <button className={styles.primaryBtn} type="submit">
              {profile ? 'Save profile' : 'Make bookable'}
            </button>
          </form>

          {profile && (
            <form className={styles.removeForm} action={removeDoctorProfileFor}>
              <input type="hidden" name="memberId" value={member.id} />
              <button className={styles.dangerBtn} type="submit">
                Remove doctor profile
              </button>
              <p className={styles.removeHint}>
                Only possible while the profile has no appointments at all —
                removing it would take their history with it.
              </p>
            </form>
          )}
        </details>
      )}
    </li>
  )
}
