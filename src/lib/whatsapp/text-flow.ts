import { supabaseAdmin } from '@/lib/supabase/admin'
import { generateSlots } from '@/lib/availability/slot-generation'
import { localToUtc, localDayLabel, localTimeLabel } from '@/lib/availability/timezone'
import { bookAppointment } from '@/lib/booking/book'
import {
  loadDoctorOptions,
  loadDoctorLabel,
  loadDoctorSlotMinutes,
  loadAvailableDays,
  loadUpcomingAppointments,
  cancelAppointment,
} from './query'
import {
  buildDoctorMenu,
  buildDayMenu,
  buildTimeMenu,
  buildConfirmation,
  buildNoAvailability,
  buildFallback,
  buildDidNotUnderstand,
  buildCancelMenu,
  buildNoAppointments,
  buildCancelled,
  buildReschedulePickMenu,
  buildRescheduled,
  buildMessageAck,
} from './messages'
import { capturePatientMessage } from './messaging'
import {
  matchesBookingKeyword,
  matchesCancelKeyword,
  matchesRescheduleKeyword,
} from './keywords'
import {
  loadSession,
  saveSession,
  clearSession,
  matchOption,
  type WaSession,
  type FlowOption,
} from './session'
import type { OutboundMessage } from './types'

/**
 * Text-driven booking flow for the wacrm channel.
 *
 * wacrm forwards only free text per inbound message (no tapped-row id,
 * no phone). So we own the conversation: a per-conversation session in
 * `wa_sessions` remembers the step + the numbered options we last
 * offered, and each reply is matched back to an id. Steps:
 *   idle → (keyword) → awaiting_doctor → awaiting_day → awaiting_time → book
 *
 * Single-doctor clinics skip the doctor step: we auto-select the only
 * doctor and go straight to days.
 *
 * MULTI-DOCTOR UX (decision): numbered TEXT menus ("1. Dr. Rao ...")
 * matched by `matchOption`. This is the chosen approach because wacrm's
 * webhook forwards only free text — not the tapped interactive-row id —
 * so a true tappable list can't round-trip a hidden id. If a prettier
 * bubble is ever wanted, swap the build*Menu calls here for the
 * interactive-list builder in send.ts and match the reply against the
 * visible row TITLE instead of a number (same `matchOption`, fed the
 * titles) — the state machine below is otherwise unchanged.
 *
 * `to` is the wacrm conversation's patient number (E.164), used both as
 * the send target and as the patient key for booking.
 */
export interface TextFlowInput {
  clinicId: string
  conversationId: string
  /** Patient E.164 phone (resolved from the wacrm contact). */
  waPhone: string
  /** The inbound free text. */
  text: string
  /** wacrm delivery id, stored with a captured message for tracing. */
  waMessageId?: string
}

interface ClinicRow {
  id: string
  timezone: string
}

export async function handleTextMessage(
  input: TextFlowInput,
): Promise<OutboundMessage | null> {
  const clinic = await loadClinic(input.clinicId)
  if (!clinic) return null

  const to = input.waPhone
  const existing = await loadSession(input.conversationId)

  // No live session: route by intent keyword. Order matters — reschedule
  // and cancel are checked before booking because "reschedule/cancel my
  // appointment" also contains the booking keyword "appointment".
  if (!existing || existing.step === 'idle') {
    if (matchesRescheduleKeyword(input.text))
      return startRescheduleStep(clinic, input, to)
    if (matchesCancelKeyword(input.text)) return startCancelStep(clinic, input, to)
    if (!matchesBookingKeyword(input.text)) return captureMessage(clinic, input, to)
    return startDoctorStep(clinic, input, to)
  }

  switch (existing.step) {
    case 'awaiting_doctor':
      return handleDoctorReply(clinic, existing, input, to)
    case 'awaiting_day':
      return handleDayReply(clinic, existing, input, to)
    case 'awaiting_cancel':
      return handleCancelReply(clinic, existing, input, to)
    case 'awaiting_reschedule':
      return handleReschedulePickReply(clinic, existing, input, to)
    case 'awaiting_time':
      return handleTimeReply(clinic, existing, input, to)
    default:
      return buildFallback(to)
  }
}

// ------------------------------------------------------------
// Non-booking message: a post-visit doubt rather than booking intent.
//
// This branch used to just nudge ("reply with appointment"), which lost
// the message. Now it persists it into the patient's thread for staff to
// answer (R1) and acknowledges receipt (R3). No session is created — the
// patient is not in a flow, and the next message is judged on its own.
//
// If the write fails we fall back to the old nudge: never acknowledge
// receipt of something we didn't actually store.
// ------------------------------------------------------------
async function captureMessage(
  clinic: ClinicRow,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const result = await capturePatientMessage({
    clinicId: clinic.id,
    waPhone: input.waPhone,
    body: input.text,
    waMessageId: input.waMessageId,
  })
  if (!result) return buildFallback(to)
  return buildMessageAck(to, result.isFirstMessage)
}

// ------------------------------------------------------------
// Step entry: doctor selection (or single-doctor auto-route).
// ------------------------------------------------------------
async function startDoctorStep(
  clinic: ClinicRow,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const doctors = await loadDoctorOptions(clinic.id)
  if (doctors.length === 0) return buildNoAvailability(to)

  // Single-doctor clinic: skip the picker, go straight to days.
  if (doctors.length === 1) {
    return enterDayStep(clinic, input, to, doctors[0].id)
  }

  const options: FlowOption[] = doctors.map((d, i) => ({
    n: i + 1,
    id: d.id,
    label: d.label,
  }))
  await saveSession({
    conversationId: input.conversationId,
    clinicId: clinic.id,
    waPhone: input.waPhone,
    step: 'awaiting_doctor',
    data: { options },
  })
  return buildDoctorMenu(to, options.map((o) => o.label))
}

async function handleDoctorReply(
  clinic: ClinicRow,
  session: WaSession,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const picked = matchOption(input.text, session.data.options ?? [])
  if (!picked) return buildDidNotUnderstand(to)
  return enterDayStep(clinic, input, to, picked.id)
}

// ------------------------------------------------------------
// Step entry: day selection for a chosen doctor.
// ------------------------------------------------------------
async function enterDayStep(
  clinic: ClinicRow,
  input: TextFlowInput,
  to: string,
  doctorId: string,
  rescheduleId?: string,
): Promise<OutboundMessage> {
  // Tenancy: confirm the doctor is an active member of this clinic.
  if (!(await loadDoctorLabel(clinic.id, doctorId))) return buildFallback(to)

  const days = await loadAvailableDays(clinic.id, doctorId, clinic.timezone)
  if (days.length === 0) return buildNoAvailability(to)

  const options: FlowOption[] = days.map((d, i) => ({
    n: i + 1,
    id: d.dateYmd,
    label: d.label,
  }))
  await saveSession({
    conversationId: input.conversationId,
    clinicId: clinic.id,
    waPhone: input.waPhone,
    step: 'awaiting_day',
    data: { doctorId, rescheduleId, options },
  })
  return buildDayMenu(to, options.map((o) => o.label))
}

async function handleDayReply(
  clinic: ClinicRow,
  session: WaSession,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const doctorId = session.data.doctorId
  if (!doctorId) return buildFallback(to)

  const picked = matchOption(input.text, session.data.options ?? [])
  if (!picked) return buildDidNotUnderstand(to)

  return enterTimeStep(
    clinic,
    input,
    to,
    doctorId,
    picked.id,
    session.data.rescheduleId,
  )
}

// ------------------------------------------------------------
// Step entry: time selection for a chosen doctor + day.
// ------------------------------------------------------------
async function enterTimeStep(
  clinic: ClinicRow,
  input: TextFlowInput,
  to: string,
  doctorId: string,
  dateYmd: string,
  rescheduleId?: string,
): Promise<OutboundMessage> {
  const slotMinutes = await loadDoctorSlotMinutes(doctorId)
  if (!slotMinutes) return buildNoAvailability(to)

  const slots = await generateSlots({
    doctorId,
    dateYmd,
    clinicTimezone: clinic.timezone,
    defaultSlotMinutes: slotMinutes,
  })
  if (slots.length === 0) return buildNoAvailability(to)

  const options: FlowOption[] = slots.map((s, i) => ({
    n: i + 1,
    id: s.hhmm,
    label: s.localLabel,
  }))
  await saveSession({
    conversationId: input.conversationId,
    clinicId: clinic.id,
    waPhone: input.waPhone,
    step: 'awaiting_time',
    data: { doctorId, dateYmd, rescheduleId, options },
  })
  return buildTimeMenu(to, options.map((o) => o.label))
}

async function handleTimeReply(
  clinic: ClinicRow,
  session: WaSession,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const { doctorId, dateYmd } = session.data
  if (!doctorId || !dateYmd) return buildFallback(to)

  const picked = matchOption(input.text, session.data.options ?? [])
  if (!picked) return buildDidNotUnderstand(to)

  const doctorLabel = await loadDoctorLabel(clinic.id, doctorId)
  if (!doctorLabel) return buildFallback(to)

  const slotMinutes = await loadDoctorSlotMinutes(doctorId)
  if (!slotMinutes) return buildNoAvailability(to)

  // picked.id is the compact 'HHMM' clinic-local start.
  const hh = picked.id.slice(0, 2)
  const mm = picked.id.slice(2, 4)
  const startsAt = localToUtc(dateYmd, `${hh}:${mm}`, clinic.timezone)
  const endsAt = new Date(startsAt.getTime() + slotMinutes * 60_000)

  const result = await bookAppointment({
    clinicId: clinic.id,
    doctorId,
    waPhone: input.waPhone,
    startsAtUtc: startsAt.toISOString(),
    endsAtUtc: endsAt.toISOString(),
    createdVia: 'whatsapp',
  })

  const rescheduleId = session.data.rescheduleId

  if (result.status === 'booked') {
    const dayLabel = localDayLabel(startsAt, clinic.timezone)
    const timeLabel = localTimeLabel(startsAt, clinic.timezone)

    // Reschedule: the NEW slot is now booked, so it's safe to release the
    // OLD one. Ordering matters — book-new-then-cancel-old means there's
    // never a moment with zero appointments, and the DB exclusion
    // constraint already prevented a double-book above.
    if (rescheduleId) {
      await cancelAppointment(clinic.id, input.waPhone, rescheduleId)
      await clearSession(input.conversationId)
      return buildRescheduled(to, doctorLabel, dayLabel, timeLabel)
    }

    await clearSession(input.conversationId)
    return buildConfirmation(to, doctorLabel, dayLabel, timeLabel)
  }

  if (result.status === 'slot_taken') {
    // Re-offer the day's remaining times (stay in awaiting_time). The old
    // appointment is untouched, so a reschedule that hits a taken slot
    // safely leaves the patient with their original booking intact.
    return enterTimeStep(clinic, input, to, doctorId, dateYmd, rescheduleId)
  }

  // invalid / error: reset so the patient can start over. For a
  // reschedule this also leaves the original appointment untouched.
  await clearSession(input.conversationId)
  return buildFallback(to)
}

// ------------------------------------------------------------
// Cancel flow: list the patient's upcoming appointments, cancel the
// chosen one. Entered by a 'cancel' keyword from an idle conversation.
// ------------------------------------------------------------
async function startCancelStep(
  clinic: ClinicRow,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const appts = await loadUpcomingAppointments(
    clinic.id,
    input.waPhone,
    clinic.timezone,
  )
  if (appts.length === 0) return buildNoAppointments(to)

  const options: FlowOption[] = appts.map((a, i) => ({
    n: i + 1,
    id: a.id,
    label: a.label,
  }))
  await saveSession({
    conversationId: input.conversationId,
    clinicId: clinic.id,
    waPhone: input.waPhone,
    step: 'awaiting_cancel',
    data: { options },
  })
  return buildCancelMenu(to, options.map((o) => o.label))
}

async function handleCancelReply(
  clinic: ClinicRow,
  session: WaSession,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const options = session.data.options ?? []
  const picked = matchOption(input.text, options)
  if (!picked) return buildDidNotUnderstand(to)

  const ok = await cancelAppointment(clinic.id, input.waPhone, picked.id)
  await clearSession(input.conversationId)

  // On success confirm with the label we showed; if the row was already
  // gone/changed (e.g. staff cancelled it first), fall back gracefully.
  if (ok) return buildCancelled(to, picked.label)
  return buildNoAppointments(to)
}

// ------------------------------------------------------------
// Reschedule flow: pick an upcoming appointment to move, then run the
// normal day → time → book steps for the SAME doctor. On a successful
// new booking, the old appointment is cancelled (see handleTimeReply).
// Entered by a 'reschedule' keyword from an idle conversation.
// ------------------------------------------------------------
async function startRescheduleStep(
  clinic: ClinicRow,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const appts = await loadUpcomingAppointments(
    clinic.id,
    input.waPhone,
    clinic.timezone,
  )
  if (appts.length === 0) return buildNoAppointments(to)

  // Carry the doctor id on each option (encoded as `${apptId}|${doctorId}`)
  // so the pick handler can re-enter the day step for the same doctor
  // without a second lookup.
  const options: FlowOption[] = appts.map((a, i) => ({
    n: i + 1,
    id: `${a.id}|${a.doctorId}`,
    label: a.label,
  }))
  await saveSession({
    conversationId: input.conversationId,
    clinicId: clinic.id,
    waPhone: input.waPhone,
    step: 'awaiting_reschedule',
    data: { options },
  })
  return buildReschedulePickMenu(to, options.map((o) => o.label))
}

async function handleReschedulePickReply(
  clinic: ClinicRow,
  session: WaSession,
  input: TextFlowInput,
  to: string,
): Promise<OutboundMessage> {
  const picked = matchOption(input.text, session.data.options ?? [])
  if (!picked) return buildDidNotUnderstand(to)

  const [rescheduleId, doctorId] = picked.id.split('|')
  if (!rescheduleId || !doctorId) return buildFallback(to)

  // Re-enter the day step for the same doctor, carrying the id of the
  // appointment being moved so the final booking step cancels it.
  return enterDayStep(clinic, input, to, doctorId, rescheduleId)
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
