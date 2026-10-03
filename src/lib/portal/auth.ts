import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Clinic, ClinicMember } from '@/types'

/**
 * The authenticated staff context for a portal request: the Supabase
 * auth user, their active membership at the current clinic, and the
 * clinic row itself. Everything here is RLS-scoped to what this user
 * may see.
 */
export interface StaffContext {
  userId: string
  email: string | null
  member: ClinicMember
  clinic: Clinic
}

/**
 * Resolve the current staff context, or redirect to /login if there is
 * no session. For the MVP a staff user works within a single clinic; if
 * they belong to several active clinics we pick the first (a clinic
 * switcher can come later).
 *
 * Uses the RLS-respecting server client, so `clinic_members` and
 * `clinics` only return rows this user may actually see.
 */
export async function requireStaff(): Promise<StaffContext> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Active membership (RLS + our own status filter). 'invited'/'disabled'
  // members are treated as having no access.
  const { data: member, error: memberErr } = await supabase
    .from('clinic_members')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (memberErr) {
    throw new Error(`failed to load membership: ${memberErr.message}`)
  }
  if (!member) {
    // Signed in with no active membership — which is the normal state of
    // someone who just signed up, so it is onboarding, not an error.
    // /onboarding is outside the (portal) group, so this cannot loop.
    redirect('/onboarding')
  }

  const { data: clinic, error: clinicErr } = await supabase
    .from('clinics')
    .select('*')
    .eq('id', member.clinic_id)
    .single()

  if (clinicErr || !clinic) {
    throw new Error(`failed to load clinic: ${clinicErr?.message ?? 'not found'}`)
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    member: member as ClinicMember,
    clinic: clinic as Clinic,
  }
}

/**
 * Like requireStaff but returns null instead of redirecting — for places
 * (e.g. /login) that want to check whether a session already exists.
 */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: member } = await supabase
    .from('clinic_members')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!member) return null

  const { data: clinic } = await supabase
    .from('clinics')
    .select('*')
    .eq('id', member.clinic_id)
    .single()
  if (!clinic) return null

  return {
    userId: user.id,
    email: user.email ?? null,
    member: member as ClinicMember,
    clinic: clinic as Clinic,
  }
}
