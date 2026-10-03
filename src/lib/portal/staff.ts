import { createClient } from '@/lib/supabase/server'
import type { MemberRole, MemberStatus } from '@/types'

/**
 * The /staff member-management layer (ONB-2, FR-2.8–FR-2.11).
 *
 * Everything goes through the RLS cookie client. 014 splits
 * `clinic_members` and `doctor_profiles` into member-read + admin-write
 * policies, so the database refuses a non-admin write whether or not
 * `requireAdmin()` ever ran — this module does not re-check the role.
 *
 * Two shapes here are deliberate and worth not "simplifying":
 *
 * - A doctor profile is what makes a member bookable, NOT their role
 *   (§9.4a). So `upsertDoctorProfile()` works on ANY active member and
 *   never writes `clinic_members.role`. That is what lets a solo
 *   owner-admin clinic have its one doctor without a role change the
 *   last-admin guard would reject anyway.
 * - There is exactly ONE write for create-and-edit
 *   (`ON CONFLICT (clinic_member_id) DO UPDATE`) and no
 *   `updateDoctorProfile()`: two functions over one UNIQUE column would
 *   only create a question about which to call.
 */

/**
 * §12.2's refusal copy, exported so /staff's error map and the outcomes
 * below cannot drift apart: a refusal that arrives as a result object and
 * the same refusal that arrives as a `?error=` code must read identically.
 */
export const STAFF_MESSAGES = {
  lastActiveAdmin: 'A clinic needs at least one active admin.',
  doctorRoleLocked:
    "Remove this member's doctor profile first, or disable the member.",
  doctorHasAppointments:
    'This doctor has appointments on record, so the profile cannot be removed. Disable the member instead.',
  memberNotActive: 'That member is no longer active.',
  memberNotInClinic: 'That member is not part of this clinic.',
} as const

// ------------------------------------------------------------
// Listing
// ------------------------------------------------------------

export interface MemberDoctorProfile {
  id: string
  specialty: string | null
  registrationNumber: string | null
  slotMinutes: number
}

export interface MemberListItem {
  /** clinic_members.id — what every write below is keyed on. */
  id: string
  userId: string
  fullName: string | null
  email: string | null
  role: MemberRole
  status: MemberStatus
  /** null when this member is not bookable as a doctor. */
  doctorProfile: MemberDoctorProfile | null
  createdAt: string
}

/**
 * Every member of the clinic with their name, email, role, status and
 * doctor profile.
 *
 * Three reads rather than one, because the identities are not readable as
 * a join: `users_self_access` (003) scopes `users` to the caller's own
 * row, so names and emails come from `clinic_member_identities()` (012),
 * the admin-gated SECURITY DEFINER helper. `clinic_doctor_names` (010) is
 * not an alternative — it returns doctors only and names only, and this
 * list has to show nurses, receptionists and fellow admins with their
 * emails (FR-2.8).
 */
export async function listMembers(clinicId: string): Promise<MemberListItem[]> {
  const supabase = await createClient()

  const [members, identities, profiles] = await Promise.all([
    supabase
      .from('clinic_members')
      .select('id, user_id, role, status, created_at')
      .eq('clinic_id', clinicId)
      .order('created_at', { ascending: true }),
    supabase.rpc('clinic_member_identities', { target_clinic: clinicId }),
    supabase
      .from('doctor_profiles')
      .select('id, clinic_member_id, specialty, registration_number, slot_duration_minutes')
      .eq('clinic_id', clinicId),
  ])

  if (members.error) throw new Error(`members fetch: ${members.error.message}`)
  if (identities.error) {
    throw new Error(`member identities fetch: ${identities.error.message}`)
  }
  if (profiles.error) {
    throw new Error(`doctor profiles fetch: ${profiles.error.message}`)
  }

  const identityByMember = new Map<string, { full_name: string | null; email: string | null }>()
  for (const row of (identities.data ?? []) as unknown as Array<{
    member_id: string
    full_name: string | null
    email: string | null
  }>) {
    identityByMember.set(row.member_id, { full_name: row.full_name, email: row.email })
  }

  const profileByMember = new Map<string, MemberDoctorProfile>()
  for (const row of (profiles.data ?? []) as unknown as Array<{
    id: string
    clinic_member_id: string
    specialty: string | null
    registration_number: string | null
    slot_duration_minutes: number
  }>) {
    profileByMember.set(row.clinic_member_id, {
      id: row.id,
      specialty: row.specialty,
      registrationNumber: row.registration_number,
      slotMinutes: row.slot_duration_minutes,
    })
  }

  return ((members.data ?? []) as unknown as Array<{
    id: string
    user_id: string
    role: MemberRole
    status: MemberStatus
    created_at: string
  }>).map((m) => {
    const identity = identityByMember.get(m.id)
    return {
      id: m.id,
      userId: m.user_id,
      fullName: identity?.full_name ?? null,
      email: identity?.email ?? null,
      role: m.role,
      status: m.status,
      doctorProfile: profileByMember.get(m.id) ?? null,
      createdAt: m.created_at,
    }
  })
}

// ------------------------------------------------------------
// Role and status
// ------------------------------------------------------------

export type MemberWriteResult =
  | { status: 'ok' }
  /**
   * The database refused on an invariant it owns. `message` is the copy
   * §12.2 specifies; `reason` is the machine-readable code behind it.
   */
  | {
      status: 'refused'
      reason: 'last_active_admin' | 'doctor_role_locked'
      message: string
    }
  | { status: 'not_found' }
  | { status: 'error'; message: string }

/**
 * Change a member's role.
 *
 * `clinic_members_guard` (012) owns the two rules this can trip: the
 * clinic keeps at least one active admin, and a member holding a doctor
 * profile keeps `role='doctor'`. Both arrive as `P0001` with a bare
 * machine-readable message, so this switches on a code rather than
 * parsing prose.
 */
export async function setMemberRole(
  clinicId: string,
  memberId: string,
  role: MemberRole,
): Promise<MemberWriteResult> {
  return writeMember(clinicId, memberId, { role }, 'role')
}

/** Disable or re-enable a member. Same guard, same mapping. */
export async function setMemberStatus(
  clinicId: string,
  memberId: string,
  status: Extract<MemberStatus, 'active' | 'disabled'>,
): Promise<MemberWriteResult> {
  return writeMember(clinicId, memberId, { status }, 'status')
}

async function writeMember(
  clinicId: string,
  memberId: string,
  patch: { role: MemberRole } | { status: MemberStatus },
  label: string,
): Promise<MemberWriteResult> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('clinic_members')
    .update(patch)
    .eq('id', memberId)
    .eq('clinic_id', clinicId)
    .select('id')

  if (error) {
    const refusal = guardRefusal(error)
    if (refusal) {
      console.warn(`[staff] ${label} change refused: ${refusal.reason}`)
      return refusal
    }
    console.error(`[staff] ${label} change failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  // RLS filters rather than errors, so an empty result is "not yours".
  if ((data ?? []).length === 0) return { status: 'not_found' }
  return { status: 'ok' }
}

/** Map `clinic_members_guard`'s P0001 messages to §12.2's copy. */
function guardRefusal(error: {
  code?: string
  message: string
}): Extract<MemberWriteResult, { status: 'refused' }> | null {
  if (error.code !== 'P0001') return null
  if (error.message.includes('last_active_admin')) {
    return {
      status: 'refused',
      reason: 'last_active_admin',
      message: STAFF_MESSAGES.lastActiveAdmin,
    }
  }
  if (error.message.includes('doctor_role_locked')) {
    return {
      status: 'refused',
      reason: 'doctor_role_locked',
      message: STAFF_MESSAGES.doctorRoleLocked,
    }
  }
  return null
}

// ------------------------------------------------------------
// Doctor profiles (FR-2.11) — exactly two functions
// ------------------------------------------------------------

export interface DoctorProfileInput {
  specialty: string | null
  registrationNumber: string | null
  /** 5–240, validated by the caller; 15 is the product default. */
  slotMinutes: number
}

export type UpsertDoctorProfileResult =
  | { status: 'ok' }
  /** Not an active member of this clinic — the UI only offers active ones. */
  | { status: 'not_active_member' }
  /** 42501 from 014's pinned-join WITH CHECK: member belongs elsewhere. */
  | { status: 'not_in_clinic' }
  | { status: 'error'; message: string }

/**
 * Give a member a doctor profile, or edit the one they have.
 *
 * ONE statement, `ON CONFLICT (clinic_member_id) DO UPDATE`, so a
 * duplicate is not an error — it is the edit case (§12.2). And it NEVER
 * writes `clinic_members.role`: being bookable is having this row with an
 * active membership, independent of role (§9.4a). Writing the role here
 * would also be the thing that makes a solo owner-admin impossible, since
 * moving them off `admin` trips the last-admin guard.
 */
export async function upsertDoctorProfile(
  clinicId: string,
  memberId: string,
  input: DoctorProfileInput,
): Promise<UpsertDoctorProfileResult> {
  const supabase = await createClient()

  // The row is only meaningful for an active member: every doctor reader
  // joins clinic_members and filters status='active', so a profile on a
  // disabled member is invisible anyway.
  const { data: member, error: memberErr } = await supabase
    .from('clinic_members')
    .select('id')
    .eq('id', memberId)
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .maybeSingle()

  if (memberErr) {
    console.error(`[staff] member check failed: ${memberErr.message}`)
    return { status: 'error', message: memberErr.message }
  }
  if (!member) {
    console.error(`[staff] doctor profile refused — member ${memberId} is not active`)
    return { status: 'not_active_member' }
  }

  const { error } = await supabase.from('doctor_profiles').upsert(
    {
      clinic_member_id: memberId,
      clinic_id: clinicId,
      specialty: input.specialty,
      registration_number: input.registrationNumber,
      slot_duration_minutes: input.slotMinutes,
    },
    { onConflict: 'clinic_member_id' },
  )

  if (error) {
    if (error.code === '42501') {
      console.error(`[staff] doctor profile write refused by RLS for ${memberId}`)
      return { status: 'not_in_clinic' }
    }
    console.error(`[staff] doctor profile write failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  return { status: 'ok' }
}

export type RemoveDoctorProfileResult =
  | { status: 'removed' }
  /** No profile on that member — nothing to remove. */
  | { status: 'not_found' }
  /** Refused because the profile carries appointment history. */
  | { status: 'refused'; message: string; appointments: number | null }
  | { status: 'error'; message: string }

/**
 * Remove a member's doctor profile — a real DELETE, and destructive
 * enough to be guarded twice.
 *
 * `appointments.doctor_id` is `ON DELETE CASCADE` (001), so deleting a
 * profile that has ever been booked would destroy that doctor's entire
 * appointment history, past included, silently. The RULE is therefore:
 * refuse whenever ANY appointment references the profile, any date, any
 * status.
 *
 * The count below keys on the PROFILE id, which is why the profile is
 * resolved from the member id first — `/staff` only has the member id in
 * hand, and counting against it would match nothing and always allow the
 * delete. When the count is non-zero NO delete is issued at all.
 *
 * The count is for the friendly message; the GUARANTEE is
 * `doctor_profiles_guard()` (012), which refuses even when a WhatsApp
 * booking lands in the check-then-delete window. Its `P0001
 * doctor_has_appointments` maps to the SAME copy, so the admin sees one
 * message either way (§9.4a, §12.2).
 */
export async function removeDoctorProfile(
  clinicId: string,
  memberId: string,
): Promise<RemoveDoctorProfileResult> {
  const supabase = await createClient()

  const { data: profile, error: profileErr } = await supabase
    .from('doctor_profiles')
    .select('id')
    .eq('clinic_member_id', memberId)
    .eq('clinic_id', clinicId)
    .maybeSingle()

  if (profileErr) {
    console.error(`[staff] doctor profile lookup failed: ${profileErr.message}`)
    return { status: 'error', message: profileErr.message }
  }
  if (!profile) return { status: 'not_found' }

  const profileId = (profile as unknown as { id: string }).id

  const { count, error: countErr } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('clinic_id', clinicId)
    .eq('doctor_id', profileId)

  if (countErr) {
    console.error(`[staff] appointment count failed: ${countErr.message}`)
    return { status: 'error', message: countErr.message }
  }

  // Non-zero count: return here, with NO delete issued.
  if ((count ?? 0) > 0) {
    console.warn(
      `[staff] doctor profile removal refused for member ${memberId} — ${count} appointment(s)`,
    )
    return { status: 'refused', message: STAFF_MESSAGES.doctorHasAppointments, appointments: count ?? 0 }
  }

  const { error: deleteErr } = await supabase
    .from('doctor_profiles')
    .delete()
    .eq('id', profileId)
    .eq('clinic_id', clinicId)

  if (deleteErr) {
    // The race backstop: a booking landed between the count and here, or
    // something bypassed this action entirely.
    if (
      deleteErr.code === 'P0001' &&
      deleteErr.message.includes('doctor_has_appointments')
    ) {
      console.warn(`[staff] doctor profile removal raced for member ${memberId}`)
      return { status: 'refused', message: STAFF_MESSAGES.doctorHasAppointments, appointments: null }
    }
    console.error(`[staff] doctor profile delete failed: ${deleteErr.message}`)
    return { status: 'error', message: deleteErr.message }
  }

  console.info(`[staff] doctor profile removed for member ${memberId}`)
  return { status: 'removed' }
}
