import { createClient } from '@/lib/supabase/server'
import { generateSlots } from '@/lib/availability/slot-generation'
import type { Slot } from '@/types'
import type { PatientRef } from './patients'

/**
 * Portal slot reads for staff booking (T3, requirement R3), plus the
 * shared state types the booking actions module cannot export itself.
 *
 * Slots are NOT recomputed here. listSlotsForDay delegates to the same
 * generateSlots the WhatsApp flow uses, with the same inputs
 * src/lib/whatsapp/text-flow.ts#enterTimeStep passes (clinic timezone,
 * the doctor's own slot_duration_minutes, no lead time). That identity
 * IS the R3 parity guarantee — a second slot-generation path in the
 * portal would drift from what the patient is offered, and staff and
 * patient would be looking at different availability for the same day.
 *
 * generateSlots reads through the SERVICE-ROLE client internally, which
 * is intentional (the patient path has no login) but means it applies no
 * RLS and no tenancy check of its own. So tenancy is enforced BEFORE the
 * call: getDoctorSlotMinutes is an RLS-scoped read filtered by
 * clinic_id, and a doctor id that isn't in the caller's clinic comes
 * back null, which short-circuits to no slots. That doubles as the gate
 * on a forged `?doctor=` value.
 */

/** Doctor's configured slot length, or null if not in this clinic. */
export async function getDoctorSlotMinutes(
  clinicId: string,
  doctorId: string,
): Promise<number | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('doctor_profiles')
    .select('slot_duration_minutes')
    .eq('id', doctorId)
    .eq('clinic_id', clinicId)
    .maybeSingle()

  if (error) throw new Error(`doctor slot length fetch: ${error.message}`)

  const minutes = (data as { slot_duration_minutes: number } | null)
    ?.slot_duration_minutes
  return minutes ?? null
}

/**
 * The open slots for one doctor on one clinic-local day. Empty when the
 * doctor isn't this clinic's (R5) or has no slot length configured.
 */
export async function listSlotsForDay(args: {
  clinicId: string
  doctorId: string
  /** 'YYYY-MM-DD' in the clinic's timezone. */
  dateYmd: string
  timezone: string
  /** Injectable clock for tests. */
  now?: Date
}): Promise<Slot[]> {
  const { clinicId, doctorId, dateYmd, timezone, now } = args

  const defaultSlotMinutes = await getDoctorSlotMinutes(clinicId, doctorId)
  if (!defaultSlotMinutes) return []

  return generateSlots({
    doctorId,
    dateYmd,
    clinicTimezone: timezone,
    defaultSlotMinutes,
    minLeadMinutes: 0,
    now,
  })
}

/**
 * The slot a staff member picked, by its clinic-local 'HHMM' id. Pure,
 * so the create path can re-generate the day's slots and confirm the
 * submitted time is still one of them before booking it.
 */
export function findSlot(slots: Slot[], hhmm: string): Slot | undefined {
  return slots.find((s) => s.hhmm === hhmm)
}

/**
 * Outcome of the inline add-patient form. RETURNED by the action rather
 * than thrown, for the same reason as ReplyState in
 * src/lib/portal/messages.ts: a thrown server-action error is redacted
 * to a generic digest in production and the (portal) group has no error
 * boundary, so throwing would lose both the reason and the typed input.
 *
 * These types live here because a 'use server' module may only export
 * async functions — the same constraint that put WINDOW_CLOSED_NOTICE in
 * messages.ts.
 */
export interface AddPatientState {
  /** Null when the patient was created or reused; the reason otherwise. */
  error: string | null
  /** The resolved patient to continue booking with; null on failure. */
  patient: PatientRef | null
  /** True when an existing (clinic_id, wa_phone) row was reused (R2). */
  reused: boolean
}

/** Outcome of the create-appointment submit. */
export interface CreateAppointmentState {
  /** Null when the appointment was created; the reason otherwise. */
  error: string | null
  /**
   * The slot was taken between display and submit (R4). The UI re-offers
   * the day's slots instead of showing a dead end — mirrors the WhatsApp
   * slot_taken recovery.
   */
  slotTaken: boolean
  /** Set when the appointment was created. */
  appointmentId: string | null
}
