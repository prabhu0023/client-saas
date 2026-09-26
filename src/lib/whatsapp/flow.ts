import type { InboundEvent } from './types'
import { parseDayId, parseSlotId } from '@/lib/booking/slot-id'

/**
 * Staged WhatsApp booking flow (§6): doctor -> day -> time -> book.
 *
 * The flow is STATELESS per message: the tapped row id carries the
 * accumulated state (which doctor, which day), so we never need a
 * server-side session. `decideAction` is a pure router over the inbound
 * event; the orchestrator (executeFlow, added when the route is wired)
 * runs the chosen action against slot-gen + booking.
 */

const BOOKING_KEYWORDS = [
  'appointment',
  'book',
  'booking',
  'hello',
  'hi',
]

export type FlowAction =
  | { type: 'show_doctors' }
  | { type: 'show_days'; doctorId: string }
  | { type: 'show_times'; doctorId: string; dateYmd: string }
  | { type: 'book'; doctorId: string; dateYmd: string; hhmm: string }
  | { type: 'fallback' }

/**
 * Pure routing decision. Precedence:
 *   1. A tapped slot id  -> book
 *   2. A tapped day id   -> show times
 *   3. A tapped doctor id (doc_<id>) -> show days
 *   4. Free text matching a booking keyword -> show doctors
 *   5. Anything else -> fallback
 *
 * Interactive reply ids are matched first because a tap is unambiguous;
 * free text is only consulted when no reply id is present.
 */
export function decideAction(event: InboundEvent): FlowAction {
  const replyId = event.interactiveReplyId

  if (replyId) {
    const slot = parseSlotId(replyId)
    if (slot) {
      return {
        type: 'book',
        doctorId: slot.doctorId,
        dateYmd: slot.dateYmd,
        hhmm: slot.hhmm,
      }
    }

    const day = parseDayId(replyId)
    if (day) {
      return { type: 'show_times', doctorId: day.doctorId, dateYmd: day.dateYmd }
    }

    if (replyId.startsWith('doc_')) {
      const doctorId = replyId.slice('doc_'.length)
      if (doctorId) return { type: 'show_days', doctorId }
    }

    // Unknown reply id — treat as fallback rather than guessing.
    return { type: 'fallback' }
  }

  if (event.text && matchesBookingKeyword(event.text)) {
    return { type: 'show_doctors' }
  }

  return { type: 'fallback' }
}

/** Case-insensitive substring match against the booking keywords. */
export function matchesBookingKeyword(text: string): boolean {
  const t = text.toLowerCase()
  return BOOKING_KEYWORDS.some((k) => t.includes(k))
}

// ------------------------------------------------------------
// Orchestrator — executes a FlowAction against DB + booking + send.
// (Imports kept here to keep the pure router section import-light.)
// ------------------------------------------------------------

import { supabaseAdmin } from '@/lib/supabase/admin'
import { resolveClinicIdByPhoneNumberId } from '@/lib/clinics/resolve-by-number'
import { generateSlots } from '@/lib/availability/slot-generation'
import { localToUtc } from '@/lib/availability/timezone'
import { bookAppointment } from '@/lib/booking/book'
import {
  loadDoctorOptions,
  loadDoctorSlotMinutes,
  loadAvailableDays,
} from './query'
import {
  buildDoctorList,
  buildDayList,
  buildTimeList,
  buildConfirmation,
  buildSlotTaken,
  buildNoAvailability,
  buildFallback,
} from './messages'
import { sendMessage } from './send'
import type { OutboundMessage } from './types'

/**
 * Handle one inbound event end-to-end: dedupe, resolve tenant, decide,
 * execute, and send the reply. Idempotent against WhatsApp retries via
 * the wamid dedupe. Never throws — logs and returns a status string.
 */
export async function handleInbound(event: InboundEvent): Promise<string> {
  try {
    // 1. Dedupe: ignore a wamid we've already processed (WhatsApp retries,
    //    double taps). Best-effort insert into a processed-events table.
    if (await alreadyProcessed(event.wamid)) return 'duplicate'

    // 2. Resolve the clinic from the receiving number.
    const clinicId = await resolveClinicIdByPhoneNumberId(event.phoneNumberId)
    if (!clinicId) return 'no_clinic'

    const clinic = await loadClinic(clinicId)
    if (!clinic) return 'no_clinic'

    // 3. Decide, then execute.
    const action = decideAction(event)
    const message = await buildReply(event, clinic, action)
    if (message) await sendMessage(message)
    return action.type
  } catch (err) {
    console.error('[wa/flow] handleInbound failed:', err)
    return 'error'
  }
}

interface ClinicRow {
  id: string
  timezone: string
}

async function loadClinic(clinicId: string): Promise<ClinicRow | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('clinics')
    .select('id, timezone')
    .eq('id', clinicId)
    .maybeSingle()
  if (error || !data) return null
  return data as ClinicRow
}

async function alreadyProcessed(wamid: string): Promise<boolean> {
  const db = supabaseAdmin()
  // Insert-if-absent; if the row already existed, it's a duplicate.
  const { error } = await db
    .from('processed_wa_events')
    .insert({ wamid })
  if (!error) return false
  // Unique violation => already processed. Any other error: fail open
  // (process it) rather than dropping a legitimate message.
  return (error as { code?: string }).code === '23505'
}

/** Build the outbound reply for a decided action. */
async function buildReply(
  event: InboundEvent,
  clinic: ClinicRow,
  action: FlowAction,
): Promise<OutboundMessage | null> {
  const to = event.from

  switch (action.type) {
    case 'show_doctors': {
      const doctors = await loadDoctorOptions(clinic.id)
      if (doctors.length === 0) return buildNoAvailability(to)
      return buildDoctorList(to, doctors)
    }

    case 'show_days': {
      const days = await loadAvailableDays(clinic.id, action.doctorId, clinic.timezone)
      if (days.length === 0) return buildNoAvailability(to)
      return buildDayList(to, days)
    }

    case 'show_times': {
      const slotMinutes = await loadDoctorSlotMinutes(action.doctorId)
      if (!slotMinutes) return buildNoAvailability(to)
      const slots = await generateSlots({
        doctorId: action.doctorId,
        dateYmd: action.dateYmd,
        clinicTimezone: clinic.timezone,
        defaultSlotMinutes: slotMinutes,
      })
      if (slots.length === 0) return buildNoAvailability(to)
      return buildTimeList(to, action.doctorId, action.dateYmd, slots)
    }

    case 'book': {
      const slotMinutes = await loadDoctorSlotMinutes(action.doctorId)
      if (!slotMinutes) return buildSlotTaken(to)
      // Reconstruct the slot instants from the encoded id (clinic-local
      // HHMM on the chosen date -> UTC).
      const hh = action.hhmm.slice(0, 2)
      const mm = action.hhmm.slice(2, 4)
      const startsAt = localToUtc(action.dateYmd, `${hh}:${mm}`, clinic.timezone)
      const endsAt = new Date(startsAt.getTime() + slotMinutes * 60_000)

      const result = await bookAppointment({
        clinicId: clinic.id,
        doctorId: action.doctorId,
        waPhone: event.from,
        startsAtUtc: startsAt.toISOString(),
        endsAtUtc: endsAt.toISOString(),
        createdVia: 'whatsapp',
      })

      if (result.status === 'booked') {
        // Minimal confirmation labels; a richer version can look up the
        // doctor's display name and formatted day.
        return buildConfirmation(to, 'your doctor', action.dateYmd, `${hh}:${mm}`)
      }
      if (result.status === 'slot_taken') {
        // Recover: re-show the current times for that day.
        const slots = await generateSlots({
          doctorId: action.doctorId,
          dateYmd: action.dateYmd,
          clinicTimezone: clinic.timezone,
          defaultSlotMinutes: slotMinutes,
        })
        if (slots.length === 0) return buildNoAvailability(to)
        // Send the "just taken" note; the fresh list follows on next tap.
        return buildSlotTaken(to)
      }
      // invalid / error
      return buildSlotTaken(to)
    }

    case 'fallback':
    default:
      return buildFallback(to)
  }
}
