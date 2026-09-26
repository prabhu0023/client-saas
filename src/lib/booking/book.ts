import { supabaseAdmin } from '@/lib/supabase/admin'
import { doctorBelongsToClinic } from '@/lib/clinics/tenancy'

/**
 * Booking transaction wrapper (write path §5).
 *
 * Delegates the atomic upsert-patient + insert-appointment to the
 * `book_appointment` Postgres RPC (migration 004), which lets the DB
 * exclusion constraint arbitrate races. This wrapper:
 *   - re-checks tenancy before calling (defense-in-depth; the RPC also
 *     checks),
 *   - maps the RPC outcome into a typed result,
 *   - never throws for the expected "slot taken" race — the caller
 *     recovers by regenerating slots.
 *
 * Runs server-side via the service-role client (patients have no login).
 */

export interface BookArgs {
  clinicId: string
  doctorId: string
  /** E.164 WhatsApp number of the patient. */
  waPhone: string
  /** UTC ISO instants (from a generated Slot). */
  startsAtUtc: string
  endsAtUtc: string
  serviceId?: string | null
  patientName?: string | null
  createdVia?: 'whatsapp' | 'portal'
}

export type BookResult =
  | { status: 'booked'; appointmentId: string; patientId: string }
  | { status: 'slot_taken' }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; message: string }

interface BookRpcRow {
  outcome: 'booked' | 'slot_taken' | 'invalid'
  appointment_id: string | null
  patient_id: string | null
}

export async function bookAppointment(args: BookArgs): Promise<BookResult> {
  const {
    clinicId,
    doctorId,
    waPhone,
    startsAtUtc,
    endsAtUtc,
    serviceId = null,
    patientName = null,
    createdVia = 'whatsapp',
  } = args

  // Basic shape guard — cheap and prevents obviously bad calls.
  if (new Date(endsAtUtc).getTime() <= new Date(startsAtUtc).getTime()) {
    return { status: 'invalid', reason: 'ends_at must be after starts_at' }
  }

  // Defense-in-depth tenancy check before touching the DB write path.
  if (!(await doctorBelongsToClinic(doctorId, clinicId))) {
    return { status: 'invalid', reason: 'doctor does not belong to clinic' }
  }

  const db = supabaseAdmin()
  const { data, error } = await db.rpc('book_appointment', {
    p_clinic_id: clinicId,
    p_doctor_id: doctorId,
    p_wa_phone: waPhone,
    p_starts_at: startsAtUtc,
    p_ends_at: endsAtUtc,
    p_service_id: serviceId,
    p_patient_name: patientName,
    p_created_via: createdVia,
  })

  if (error) {
    // The RPC handles the expected exclusion race internally, so an error
    // here is genuinely unexpected (bad args, DB down). Surface it.
    console.error('[booking] book_appointment rpc failed:', error.message)
    return { status: 'error', message: error.message }
  }

  // supabase returns SETOF rows; take the first.
  const row = (Array.isArray(data) ? data[0] : data) as BookRpcRow | undefined
  if (!row) return { status: 'error', message: 'empty rpc result' }

  switch (row.outcome) {
    case 'booked':
      if (!row.appointment_id || !row.patient_id) {
        return { status: 'error', message: 'booked without ids' }
      }
      return {
        status: 'booked',
        appointmentId: row.appointment_id,
        patientId: row.patient_id,
      }
    case 'slot_taken':
      return { status: 'slot_taken' }
    case 'invalid':
      return { status: 'invalid', reason: 'doctor does not belong to clinic' }
    default:
      return { status: 'error', message: `unknown outcome: ${row.outcome}` }
  }
}
