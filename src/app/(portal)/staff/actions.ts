'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/portal/roles'
import { validateEmail } from '@/lib/portal/onboarding-validate'
import {
  createInvite,
  revokeInvite,
  type InviteFormState,
} from '@/lib/portal/invites'
import {
  removeDoctorProfile,
  setMemberRole,
  setMemberStatus,
  upsertDoctorProfile,
} from '@/lib/portal/staff'
import type { MemberRole } from '@/types'

/**
 * Admin actions on /staff (FR-2.1–FR-2.11).
 *
 * The clinic id always comes from requireAdmin()'s context, never from the
 * form, and 014's admin-write policies re-check it in the database — so a
 * crafted post with another clinic's member id updates nothing.
 *
 * inviteMember RETURNS its state, because the one-time link has to reach
 * the screen exactly once (useActionState); everything else redirects with
 * a `?error=`/`?saved=` code, the pattern /setup and /login already use.
 * Refusal copy comes from STAFF_MESSAGES via the page's code map, so the
 * same refusal reads identically wherever it surfaces.
 *
 * Nothing here logs an email: `[invites]`/`[staff]` lines carry clinic and
 * member ids and outcome codes only (NFR-5/6).
 */

const ROLES: readonly MemberRole[] = ['doctor', 'nurse', 'receptionist', 'admin']
const SPECIALTY_MAX = 80
const REGISTRATION_MAX = 64
const SLOT_MIN = 5
const SLOT_MAX = 240
const SLOT_DEFAULT = 15

function parseRole(raw: string): MemberRole | null {
  return (ROLES as readonly string[]).includes(raw) ? (raw as MemberRole) : null
}

/** Trim to null, rejecting anything over the column's working limit. */
function parseOptional(raw: string, max: number): string | null | 'too-long' {
  const value = raw.trim()
  if (value === '') return null
  if (value.length > max) return 'too-long'
  return value
}

/** Doctor slot length: integer minutes, 5–240, blank means the default. */
function parseSlotMinutes(raw: string): number | null {
  const value = raw.trim()
  if (value === '') return SLOT_DEFAULT
  if (!/^\d{1,3}$/.test(value)) return null
  const minutes = Number(value)
  if (minutes < SLOT_MIN || minutes > SLOT_MAX) return null
  return minutes
}

/**
 * Issue a one-time invite link (FR-2.2–FR-2.4).
 *
 * createInvite() THROWS when NEXT_PUBLIC_APP_URL is unset — deliberately,
 * and before it writes anything, so no token is burned on a link nobody
 * could open. That is the one failure this action has to catch rather than
 * map, since a thrown action error would be redacted to a digest in
 * production and the (portal) group has no error boundary.
 */
export async function inviteMember(
  _previous: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const { clinic, member } = await requireAdmin()

  const email = validateEmail(String(formData.get('email') ?? ''))
  if (!email.ok) return fail(email.error)

  const role = parseRole(String(formData.get('role') ?? ''))
  if (!role) return fail('Choose a role.')

  const isDoctor = role === 'doctor'

  const specialty = parseOptional(String(formData.get('specialty') ?? ''), SPECIALTY_MAX)
  if (specialty === 'too-long') return fail('Specialty is too long.')

  const slotMinutes = parseSlotMinutes(String(formData.get('slotMinutes') ?? ''))
  if (slotMinutes === null) {
    return fail('Slot length must be between 5 and 240 minutes.')
  }

  try {
    const result = await createInvite({
      clinicId: clinic.id,
      createdByMemberId: member.id,
      email: email.value,
      role,
      specialty: isDoctor ? specialty : null,
      slotMinutes: isDoctor ? slotMinutes : null,
    })

    if (result.status === 'already_member') {
      return fail('That person is already a member.')
    }
    if (result.status === 'raced') {
      return fail('Previous invite replaced — try again.')
    }
    if (result.status === 'error') {
      return fail('Could not create the invite.')
    }

    revalidatePath('/staff')
    return {
      error: null,
      link: result.url,
      email: result.email,
      replaced: result.replaced,
    }
  } catch (e) {
    // The NEXT_PUBLIC_APP_URL case, and only it: the throw happens before
    // any write, so there is nothing to clean up.
    const message = e instanceof Error ? e.message : 'unknown error'
    console.error(`[invites] could not build an invite link: ${message}`)
    return fail('Invite links are not configured. Contact DoctorDesk.')
  }
}

function fail(error: string): InviteFormState {
  return { error, link: null, email: null, replaced: false }
}

/** Revoke a pending invite (FR-2.4). The link stops working immediately. */
export async function revokePendingInvite(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const inviteId = String(formData.get('inviteId') ?? '')

  const result = await revokeInvite(clinic.id, inviteId)

  if (result.status === 'not_found') redirect('/staff?error=invite-not-found')
  if (result.status === 'error') redirect('/staff?error=failed')

  revalidatePath('/staff')
  redirect('/staff?saved=invite-revoked')
}

/** Change a member's role (FR-2.7). The guards own the refusals. */
export async function changeMemberRole(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const memberId = String(formData.get('memberId') ?? '')

  const role = parseRole(String(formData.get('role') ?? ''))
  if (!role) redirect('/staff?error=role')

  const result = await setMemberRole(clinic.id, memberId, role)
  redirect(`/staff?${memberOutcome(result, 'role')}`)
}

/** Disable or re-enable a member (FR-2.9). History stays attached. */
export async function changeMemberStatus(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const memberId = String(formData.get('memberId') ?? '')
  const raw = String(formData.get('status') ?? '')

  if (raw !== 'active' && raw !== 'disabled') redirect('/staff?error=failed')

  const result = await setMemberStatus(clinic.id, memberId, raw)
  redirect(`/staff?${memberOutcome(result, 'status')}`)
}

/**
 * Map a member write to its query string. Pulled out because the role and
 * status paths map identically — both are the same trigger's refusals.
 */
function memberOutcome(
  result: Awaited<ReturnType<typeof setMemberRole>>,
  saved: 'role' | 'status',
): string {
  if (result.status === 'refused') {
    return result.reason === 'last_active_admin'
      ? 'error=last-admin'
      : 'error=doctor-locked'
  }
  if (result.status === 'not_found') return 'error=member-not-found'
  if (result.status === 'error') return 'error=failed'

  revalidatePath('/staff')
  // A disabled member disappears from every doctor reader, so the
  // availability screen and the checklist can both change.
  revalidatePath('/availability')
  revalidatePath('/setup')
  revalidatePath('/', 'layout')
  return `saved=${saved}`
}

/**
 * Give an active member a doctor profile, or edit the one they have
 * (FR-2.11). Works on ANY active member regardless of role — a doctor
 * profile, not a role, is what makes someone bookable (§9.4a) — and this
 * path never writes clinic_members.role.
 */
export async function saveDoctorProfile(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const memberId = String(formData.get('memberId') ?? '')

  const specialty = parseOptional(String(formData.get('specialty') ?? ''), SPECIALTY_MAX)
  if (specialty === 'too-long') redirect('/staff?error=specialty')

  const registration = parseOptional(
    String(formData.get('registrationNumber') ?? ''),
    REGISTRATION_MAX,
  )
  if (registration === 'too-long') redirect('/staff?error=registration')

  const slotMinutes = parseSlotMinutes(String(formData.get('slotMinutes') ?? ''))
  if (slotMinutes === null) redirect('/staff?error=slot')

  const result = await upsertDoctorProfile(clinic.id, memberId, {
    specialty,
    registrationNumber: registration,
    slotMinutes,
  })

  if (result.status === 'not_active_member') redirect('/staff?error=not-active')
  if (result.status === 'not_in_clinic') redirect('/staff?error=not-in-clinic')
  if (result.status === 'error') redirect('/staff?error=failed')

  revalidateDoctorSurfaces()
  redirect('/staff?saved=profile')
}

/**
 * Remove a doctor profile (FR-2.11).
 *
 * Refused for a profile with ANY appointment, because
 * `appointments.doctor_id` cascades on delete and the past rows are the
 * history FR-2.10 promises to keep (§9.4a). The admin sees one message
 * whether the pre-check or the trigger refused.
 */
export async function removeDoctorProfileFor(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const memberId = String(formData.get('memberId') ?? '')

  const result = await removeDoctorProfile(clinic.id, memberId)

  if (result.status === 'refused') redirect('/staff?error=has-appointments')
  if (result.status === 'not_found') redirect('/staff?error=no-profile')
  if (result.status === 'error') redirect('/staff?error=failed')

  revalidateDoctorSurfaces()
  redirect('/staff?saved=profile-removed')
}

/**
 * A profile appearing or disappearing changes who /availability can attach
 * hours to and whether /setup's doctor item is green — and the layout
 * renders the "Finish setup" link from that same probe.
 */
function revalidateDoctorSurfaces(): void {
  revalidatePath('/staff')
  revalidatePath('/availability')
  revalidatePath('/setup')
  revalidatePath('/', 'layout')
}
