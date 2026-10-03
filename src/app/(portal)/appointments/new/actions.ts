'use server'

import { revalidatePath } from 'next/cache'
import { requireStaff } from '@/lib/portal/auth'
import { validateNewPatient } from '@/lib/portal/patient-validate'
import {
  searchPatients,
  getPatient,
  createOrReusePatient,
  type PatientRef,
} from '@/lib/portal/patients'
import {
  listSlotsForDay,
  findSlot,
  type AddPatientState,
  type CreateAppointmentState,
} from '@/lib/portal/new-appointment'
import { bookAppointment } from '@/lib/booking/book'

/**
 * Staff booking actions (T4): find a patient, add one inline, create the
 * appointment.
 *
 * Every action starts with requireStaff() and then uses ONLY clinic.id
 * from that context. Nothing here accepts a clinic id from the client —
 * the patient id, doctor id, day and time are all re-resolved against
 * the caller's own clinic, so a forged id reads as "not found" rather
 * than booking into someone else's clinic (R5).
 *
 * All three RETURN a typed state instead of throwing, like replyToThread
 * in src/app/(portal)/inbox/actions.ts: a thrown server-action error is
 * redacted to a generic digest in production and the (portal) group has
 * no error boundary, so throwing would lose both the reason and the
 * staff member's typed input. And slot_taken is not a bug — it is the
 * expected outcome of two people booking the same time, and it needs a
 * "pick again" recovery, not an error screen (R4).
 *
 * The create path NEVER trusts a submitted instant. It regenerates the
 * day's slots and books the matched slot's own startsAtUtc/endsAtUtc, so
 * a hand-edited form cannot book outside availability: the btree_gist
 * exclusion constraint stops overlaps, but it would happily accept an
 * out-of-hours insert, and force-booking is an explicit non-goal.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Shown for both the slot-expiry and the lost-race cases (R4). */
const RETRY_NOTICE = 'that time is no longer available — pick another'

/** Patients in the caller's clinic matching the typed term (R1). */
export async function searchPatientsAction(term: string): Promise<PatientRef[]> {
  const { clinic } = await requireStaff()
  return searchPatients(clinic.id, term)
}

/**
 * Create the patient staff typed into the inline form, or hand back the
 * one that already holds that number so booking continues on the
 * existing record instead of erroring (R2).
 */
export async function addPatient(formData: FormData): Promise<AddPatientState> {
  const { clinic } = await requireStaff()

  const validated = validateNewPatient({
    fullName: String(formData.get('fullName') ?? ''),
    waPhone: String(formData.get('waPhone') ?? ''),
    dateOfBirth: String(formData.get('dateOfBirth') ?? ''),
    notes: String(formData.get('notes') ?? ''),
  })
  if (!validated.ok) {
    return { error: validated.error, patient: null, reused: false }
  }

  try {
    const { patient, reused } = await createOrReusePatient(
      clinic.id,
      validated.value,
    )
    return { error: null, patient, reused }
  } catch (e) {
    return { error: message(e, 'could not save the patient'), patient: null, reused: false }
  }
}

/**
 * Book the selected slot for the selected patient through the existing
 * atomic book_appointment RPC, with created_via 'portal' (R4).
 */
export async function createAppointment(
  formData: FormData,
): Promise<CreateAppointmentState> {
  const { clinic } = await requireStaff()

  const patientId = String(formData.get('patientId') ?? '')
  const doctorId = String(formData.get('doctorId') ?? '')
  const date = String(formData.get('date') ?? '')
  const hhmm = String(formData.get('hhmm') ?? '')

  if (!patientId) return fail('select a patient first')
  if (!doctorId) return fail('select a doctor first')
  if (!date || !YMD.test(date)) return fail('pick a valid day')
  if (!hhmm) return fail('pick a time')

  try {
    // Re-resolve the patient in THIS clinic: null covers both an unknown
    // id and another clinic's id (R5).
    const patient = await getPatient(clinic.id, patientId)
    if (!patient) return fail('patient not found in this clinic')

    // Regenerate the day's slots and insist the submitted time is still
    // one of them. A cross-clinic doctorId yields no slots at all, so
    // this is also the doctor tenancy gate.
    const slots = await listSlotsForDay({
      clinicId: clinic.id,
      doctorId,
      dateYmd: date,
      timezone: clinic.timezone,
    })
    const slot = findSlot(slots, hhmm)
    if (!slot) return retry()

    const result = await bookAppointment({
      clinicId: clinic.id,
      doctorId,
      waPhone: patient.waPhone,
      // The matched slot's OWN instants — never a client-sent timestamp,
      // and they already respect a per-rule slot_minutes override.
      startsAtUtc: slot.startsAtUtc,
      endsAtUtc: slot.endsAtUtc,
      serviceId: null,
      patientName: patient.fullName,
      createdVia: 'portal',
    })

    switch (result.status) {
      case 'booked':
        // Drop the dashboard's cached render so the new appointment is
        // there on return (R6). Only the bare path — Next keys the path
        // cache without search params, so revalidating
        // '/dashboard?date=…' would target nothing. The specific day
        // comes back fresh because SlotPicker pushes to it and then
        // calls router.refresh().
        revalidatePath('/dashboard')
        return { error: null, slotTaken: false, appointmentId: result.appointmentId }
      case 'slot_taken':
        // Someone else won the race between display and submit. Same
        // recovery as the WhatsApp flow: re-offer the day's slots.
        return retry()
      case 'invalid':
        return fail(result.reason)
      default:
        return fail(result.message)
    }
  } catch (e) {
    return fail(message(e, 'could not create the appointment'))
  }
}

function fail(error: string): CreateAppointmentState {
  return { error, slotTaken: false, appointmentId: null }
}

function retry(): CreateAppointmentState {
  return { error: RETRY_NOTICE, slotTaken: true, appointmentId: null }
}

/** Surface a thrown reason without leaking a non-Error object's shape. */
function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}
