import { createClient } from '@/lib/supabase/server'
import { localToUtc, localTimeLabel } from '@/lib/availability/timezone'
import type { AppointmentStatus } from '@/types'

/**
 * A single appointment row shaped for the dashboard: the appointment
 * plus the joined patient, service, and doctor bits that RLS lets a
 * staff member read. Doctor display uses the profile's specialty for
 * now — the human name lives in `users`, which RLS scopes to self only,
 * so surfacing colleague names needs a view/RPC (future work).
 */
export interface DashboardAppointment {
  id: string
  startsAt: string
  endsAt: string
  status: AppointmentStatus
  createdVia: 'whatsapp' | 'portal'
  startLabel: string
  endLabel: string
  /** The patient this visit belongs to — the key the inbox opens on. */
  patientId: string
  patientName: string | null
  patientPhone: string
  serviceName: string | null
  doctorId: string
  doctorSpecialty: string | null
}

interface AppointmentJoinRow {
  id: string
  starts_at: string
  ends_at: string
  status: AppointmentStatus
  created_via: 'whatsapp' | 'portal'
  doctor_id: string
  patient_id: string
  patients: { full_name: string | null; wa_phone: string } | null
  services: { name: string } | null
  doctor_profiles: { specialty: string | null } | null
}

/**
 * The clinic-local calendar day [dateYmd 00:00, next day 00:00) expressed
 * as UTC bounds, mirroring how slot-generation derives day boundaries so
 * the two views agree on what "a day" is.
 */
function dayBoundsUtc(dateYmd: string, timezone: string): {
  startUtc: string
  endUtc: string
} {
  const startUtc = localToUtc(dateYmd, '00:00:00', timezone)
  const endUtc = localToUtc(dateYmd, '00:00:00', timezone)
  endUtc.setUTCDate(endUtc.getUTCDate() + 1)
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() }
}

/**
 * Fetch a clinic's appointments for a single clinic-local day, ordered by
 * start time. RLS restricts rows to the caller's clinic; we still pass
 * clinic_id explicitly so a multi-clinic user gets the right one.
 */
export async function getAppointmentsForDay(args: {
  clinicId: string
  dateYmd: string
  timezone: string
}): Promise<DashboardAppointment[]> {
  const { clinicId, dateYmd, timezone } = args
  const { startUtc, endUtc } = dayBoundsUtc(dateYmd, timezone)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('appointments')
    .select(
      `id, starts_at, ends_at, status, created_via, doctor_id, patient_id,
       patients ( full_name, wa_phone ),
       services ( name ),
       doctor_profiles ( specialty )`,
    )
    .eq('clinic_id', clinicId)
    .gte('starts_at', startUtc)
    .lt('starts_at', endUtc)
    .order('starts_at', { ascending: true })

  if (error) throw new Error(`appointments fetch: ${error.message}`)

  const rows = (data ?? []) as unknown as AppointmentJoinRow[]

  return rows.map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    createdVia: r.created_via,
    startLabel: localTimeLabel(new Date(r.starts_at), timezone),
    endLabel: localTimeLabel(new Date(r.ends_at), timezone),
    patientId: r.patient_id,
    patientName: r.patients?.full_name ?? null,
    patientPhone: r.patients?.wa_phone ?? '',
    serviceName: r.services?.name ?? null,
    doctorId: r.doctor_id,
    doctorSpecialty: r.doctor_profiles?.specialty ?? null,
  }))
}
