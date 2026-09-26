import { createClient } from '@/lib/supabase/server'
import { getDoctorNameMap } from './doctors'
import type { AvailabilityRule, AvailabilityException } from '@/types'

/**
 * Portal-side availability reads (E5-T1). RLS-scoped via the server
 * client, so a staff member only sees doctors/rules/exceptions for
 * clinics they're an active member of. We still pass clinic_id
 * explicitly so a multi-clinic user gets the right one.
 *
 * Doctor display uses specialty for now — the human name lives in
 * `users`, which RLS scopes to self only (surfacing colleague names is
 * E6-T1). A doctor is labelled by specialty, falling back to a short id.
 */

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export interface DoctorRef {
  id: string
  label: string
}

/**
 * Active doctors in the clinic, as pickable refs. Labelled by name (via
 * the clinic_doctor_names RPC — E6-T1) with specialty appended when both
 * are known; falls back to specialty, then a short id.
 */
export async function listClinicDoctors(clinicId: string): Promise<DoctorRef[]> {
  const supabase = await createClient()
  const [{ data, error }, names] = await Promise.all([
    supabase
      .from('doctor_profiles')
      .select('id, specialty, clinic_members!inner(status)')
      .eq('clinic_id', clinicId)
      .eq('clinic_members.status', 'active'),
    getDoctorNameMap(clinicId),
  ])

  if (error) throw new Error(`doctors fetch: ${error.message}`)

  return (data ?? []).map((row) => {
    const r = row as unknown as { id: string; specialty: string | null }
    const name = names.get(r.id)
    let label: string
    if (name && r.specialty) label = `${name} (${r.specialty})`
    else if (name) label = name
    else label = r.specialty ?? `Doctor ${r.id.slice(0, 8)}`
    return { id: r.id, label }
  })
}

/**
 * A doctor's weekly recurring availability rules, ordered by weekday then
 * start time — the shape the view renders as a weekly grid.
 */
export async function getAvailabilityRules(
  clinicId: string,
  doctorId: string,
): Promise<AvailabilityRule[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('availability_rules')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('doctor_id', doctorId)
    .order('weekday', { ascending: true })
    .order('start_time', { ascending: true })

  if (error) throw new Error(`rules fetch: ${error.message}`)
  return (data ?? []) as AvailabilityRule[]
}

/**
 * A doctor's upcoming date-specific exceptions (today onward), ordered by
 * date. Past exceptions are hidden — they no longer affect any bookable
 * day.
 */
export async function getUpcomingExceptions(
  clinicId: string,
  doctorId: string,
  fromYmd: string,
): Promise<AvailabilityException[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('availability_exceptions')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('doctor_id', doctorId)
    .gte('date', fromYmd)
    .order('date', { ascending: true })

  if (error) throw new Error(`exceptions fetch: ${error.message}`)
  return (data ?? []) as AvailabilityException[]
}
