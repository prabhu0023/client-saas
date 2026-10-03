// ============================================================
// Shared domain types — mirror supabase/migrations/001.
// ============================================================

export type ClinicStatus = 'active' | 'suspended'
export type MemberRole = 'doctor' | 'nurse' | 'receptionist' | 'admin'
export type MemberStatus = 'active' | 'invited' | 'disabled'
export type WhatsAppNumberStatus = 'active' | 'disconnected'
export type ExceptionKind = 'off' | 'extra'
export type AppointmentStatus =
  | 'booked'
  | 'confirmed'
  | 'cancelled'
  | 'completed'
  | 'no_show'
export type CreatedVia = 'whatsapp' | 'portal'
export type MessageDirection = 'inbound' | 'outbound'
export type ThreadStatus = 'open' | 'escalated' | 'closed'

export interface Clinic {
  id: string
  name: string
  slug: string
  /** IANA timezone name, e.g. 'Asia/Kolkata'. Chosen at onboarding. */
  timezone: string
  status: ClinicStatus
  created_at: string
  updated_at: string
}

export interface ClinicWhatsAppNumber {
  id: string
  clinic_id: string
  /** Meta's stable phone_number_id — the tenant router key. */
  phone_number_id: string
  display_number: string | null
  status: WhatsAppNumberStatus
  created_at: string
}

export interface User {
  id: string
  full_name: string | null
  email: string | null
  created_at: string
}

export interface ClinicMember {
  id: string
  clinic_id: string
  user_id: string
  role: MemberRole
  status: MemberStatus
  created_at: string
}

export interface DoctorProfile {
  id: string
  clinic_member_id: string
  clinic_id: string
  specialty: string | null
  registration_number: string | null
  slot_duration_minutes: number
  created_at: string
}

export interface Patient {
  id: string
  clinic_id: string
  /** E.164, e.g. +919876543210. Unique per clinic. */
  wa_phone: string
  full_name: string | null
  date_of_birth: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Service {
  id: string
  clinic_id: string
  name: string
  price_cents: number
  active: boolean
  created_at: string
}

export interface DoctorService {
  id: string
  clinic_id: string
  doctor_id: string
  service_id: string
}

export interface AvailabilityRule {
  id: string
  clinic_id: string
  doctor_id: string
  /** 0=Sun .. 6=Sat. */
  weekday: number
  /** Clinic-local wall-clock time, 'HH:mm' / 'HH:mm:ss'. */
  start_time: string
  end_time: string
  /** Optional per-rule override of the doctor's default slot length. */
  slot_minutes: number | null
  active: boolean
  created_at: string
}

export interface AvailabilityException {
  id: string
  clinic_id: string
  doctor_id: string
  /** 'YYYY-MM-DD'. */
  date: string
  kind: ExceptionKind
  /** Clinic-local. NULL times on 'off' = whole day off. */
  start_time: string | null
  end_time: string | null
  created_at: string
}

export interface Appointment {
  id: string
  clinic_id: string
  doctor_id: string
  patient_id: string
  /** UTC ISO instant. */
  starts_at: string
  /** UTC ISO instant. */
  ends_at: string
  status: AppointmentStatus
  service_id: string | null
  created_via: CreatedVia
  /** When the appointment reminder was sent; null = not yet reminded. */
  reminder_sent_at: string | null
  created_at: string
  updated_at: string
}

// ------------------------------------------------------------
// Patient messaging — mirror supabase/migrations/011.
// ------------------------------------------------------------

export interface PatientMessage {
  id: string
  clinic_id: string
  patient_id: string
  direction: MessageDirection
  body: string
  /**
   * Inbound: the WhatsApp message id when the delivery carried one,
   * otherwise the wacrm delivery id. NULL for outbound/system rows.
   */
  wa_delivery_id: string | null
  /** Outbound: the staff user who replied. NULL for inbound/system. */
  sent_by: string | null
  created_at: string
}

export interface PatientThread {
  id: string
  clinic_id: string
  /** One thread per patient per clinic. */
  patient_id: string
  status: ThreadStatus
  /** doctor_profiles.id the thread was handed to, if escalated. */
  escalated_to_doctor_id: string | null
  last_message_at: string | null
  unread_count: number
  created_at: string
}

// ------------------------------------------------------------
// Derived / non-DB shapes
// ------------------------------------------------------------

/** A bookable slot produced by slot generation (not stored). */
export interface Slot {
  doctorId: string
  /** UTC ISO instant. */
  startsAtUtc: string
  endsAtUtc: string
  /** Patient-facing label in clinic-local time, e.g. '10:00 AM'. */
  localLabel: string
  /** Clinic-local start as compact 'HHMM' (e.g. '1000') for row ids. */
  hhmm: string
}
