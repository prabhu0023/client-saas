import { supabaseAdmin } from '@/lib/supabase/admin'
import { generateSlots } from '@/lib/availability/slot-generation'
import { localToUtc, localDayLabel } from '@/lib/availability/timezone'
import type { DoctorOption, DayOption } from './types'

/**
 * DB reads that back the WhatsApp flow. Kept separate from the flow
 * state machine (text-flow.ts) so the query logic stays isolated and
 * testable. All reads use the service role (the WhatsApp path has no
 * logged-in user) and are always scoped by clinic_id.
 */

/** Active doctors for a clinic, as pickable options. */
export async function loadDoctorOptions(
  clinicId: string,
): Promise<DoctorOption[]> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('doctor_profiles')
    .select('id, specialty, clinic_members!inner(user_id, status, users(full_name))')
    .eq('clinic_id', clinicId)
    .eq('clinic_members.status', 'active')

  if (error) {
    console.error('[wa/query] loadDoctorOptions failed:', error.message)
    return []
  }

  return (data ?? []).map((row) => {
    // Supabase nests the joined relation; shape defensively.
    const rel = row as unknown as {
      id: string
      specialty: string | null
      clinic_members?: { users?: { full_name?: string | null } | null } | null
    }
    const name = rel.clinic_members?.users?.full_name ?? 'Doctor'
    const label = rel.specialty ? `${name} (${rel.specialty})` : name
    return { id: rel.id, label }
  })
}

/**
 * A single doctor's display label ('Dr. Rao (Cardiology)'), scoped to
 * the clinic. Returns null if the doctor is not an active member of
 * this clinic — which doubles as a tenancy check for forged ids.
 */
export async function loadDoctorLabel(
  clinicId: string,
  doctorId: string,
): Promise<string | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('doctor_profiles')
    .select('id, specialty, clinic_members!inner(status, users(full_name))')
    .eq('clinic_id', clinicId)
    .eq('id', doctorId)
    .eq('clinic_members.status', 'active')
    .maybeSingle()

  if (error || !data) {
    if (error) console.error('[wa/query] loadDoctorLabel failed:', error.message)
    return null
  }

  const rel = data as unknown as {
    specialty: string | null
    clinic_members?: { users?: { full_name?: string | null } | null } | null
  }
  const name = rel.clinic_members?.users?.full_name ?? 'Doctor'
  return rel.specialty ? `${name} (${rel.specialty})` : name
}

/** A doctor's default slot length (for slot generation). */
export async function loadDoctorSlotMinutes(
  doctorId: string,
): Promise<number | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('doctor_profiles')
    .select('slot_duration_minutes')
    .eq('id', doctorId)
    .maybeSingle()
  if (error || !data) return null
  return (data as { slot_duration_minutes: number }).slot_duration_minutes
}

/**
 * Compute the upcoming days (within a rolling window) that have at least
 * one open slot for the doctor. Derived live from availability — future
 * dates are never stored.
 */
export async function loadAvailableDays(
  clinicId: string,
  doctorId: string,
  clinicTimezone: string,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<DayOption[]> {
  const windowDays = opts.windowDays ?? 14
  const now = opts.now ?? new Date()
  const slotMinutes = await loadDoctorSlotMinutes(doctorId)
  if (!slotMinutes) return []

  const days: DayOption[] = []
  for (let offset = 0; offset < windowDays && days.length < 10; offset++) {
    const dateYmd = ymdInTz(now, clinicTimezone, offset)
    const slots = await generateSlots({
      doctorId,
      dateYmd,
      clinicTimezone,
      defaultSlotMinutes: slotMinutes,
      minLeadMinutes: 0,
      now,
    })
    if (slots.length > 0) {
      // Midday UTC anchor for a stable day label.
      const anchor = localToUtc(dateYmd, '12:00:00', clinicTimezone)
      days.push({ doctorId, dateYmd, label: localDayLabel(anchor, clinicTimezone) })
    }
  }
  return days
}

/** 'YYYY-MM-DD' for (today + offset days) as seen in the given timezone. */
function ymdInTz(base: Date, timeZone: string, offsetDays: number): string {
  const d = new Date(base.getTime() + offsetDays * 86_400_000)
  // en-CA gives ISO-style YYYY-MM-DD; formatToParts avoids locale drift.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d)
}
