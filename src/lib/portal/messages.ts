import { createClient } from '@/lib/supabase/server'
import { localDayLabel, localTimeLabel } from '@/lib/availability/timezone'
import type {
  AppointmentStatus,
  MessageDirection,
  ThreadStatus,
} from '@/types'

/**
 * Portal-side patient-messaging reads (T3/T4).
 *
 * Runs on the RLS-respecting cookie client, so a staff member can only
 * ever see threads/messages for clinics they're an active member of.
 * Every statement here ALSO passes `.eq('clinic_id', clinicId)`
 * explicitly: RLS is the security boundary, the filter is defence in
 * depth plus the thing that picks the right tenant for a multi-clinic
 * user (R8) — same contract as src/lib/portal/appointments.ts.
 *
 * This is deliberately a separate module from
 * src/lib/whatsapp/messaging.ts, which covers the same domain on the
 * service-role client for the patient (no-login) side: that one only
 * WRITES, because the portal must never read patient data through a
 * client that bypasses RLS. So every read in this feature — including
 * the single answer to the 24h-window question (isWindowOpen below) —
 * lives here, with no second copy of the rule to drift from.
 */

/** Free-form WhatsApp replies are only allowed inside this window. */
const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The one wording for a closed window, shared by the disabled reply form
 * and the server-side guard that throws, so staff see the same reason
 * whichever one stops them. Lives here rather than in the 'use server'
 * actions module, which may only export async functions.
 */
export const WINDOW_CLOSED_NOTICE =
  '24h WhatsApp window closed — ask the patient to message again'

/** How much of the last message body the inbox list shows. */
const PREVIEW_CHARS = 120

/**
 * How many recent messages the list scans to build previews. The inbox is
 * a working queue, not an archive; a clinic that has more than this many
 * messages across its threads simply loses the preview on the oldest
 * (quietest) threads, never a thread row itself.
 */
const PREVIEW_SCAN_LIMIT = 500

export interface ThreadListItem {
  id: string
  status: ThreadStatus
  unreadCount: number
  lastMessageAt: string | null
  patientId: string
  patientName: string | null
  patientPhone: string
  /** Last message body, truncated. Null when nothing was found. */
  lastMessagePreview: string | null
}

export interface ThreadDetail {
  id: string
  status: ThreadStatus
  unreadCount: number
  lastMessageAt: string | null
  escalatedToDoctorId: string | null
  /** Specialty of the escalated-to doctor, for the degraded label. */
  escalatedToDoctorSpecialty: string | null
  patientId: string
  patientName: string | null
  patientPhone: string
}

/** A patient message in the thread timeline. */
export interface TimelineMessage {
  kind: 'message'
  id: string
  /** UTC ISO instant the entry is sorted on. */
  at: string
  dayLabel: string
  timeLabel: string
  direction: MessageDirection
  body: string
  /** Staff user who sent an outbound reply; null for inbound. */
  sentBy: string | null
}

/** One of the patient's appointments, for context around a doubt (R7). */
export interface TimelineAppointment {
  kind: 'appointment'
  id: string
  at: string
  dayLabel: string
  timeLabel: string
  status: AppointmentStatus
  doctorId: string
}

export type TimelineEntry = TimelineMessage | TimelineAppointment

interface ThreadRow {
  id: string
  status: ThreadStatus
  unread_count: number
  last_message_at: string | null
  patient_id: string
  escalated_to_doctor_id?: string | null
  patients: { full_name: string | null; wa_phone: string } | null
  doctor_profiles?: { specialty: string | null } | null
}

/**
 * Sort rank for the inbox queue: escalated threads first (someone is
 * waiting on the doctor), then open, then closed. Within a rank the
 * newest activity wins.
 */
const STATUS_RANK: Record<ThreadStatus, number> = {
  escalated: 0,
  open: 1,
  closed: 2,
}

function truncate(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS
    ? `${flat.slice(0, PREVIEW_CHARS - 1)}…`
    : flat
}

/**
 * Every thread in the clinic, ordered for the inbox queue. Previews come
 * from a second scoped read rather than a correlated subquery, which
 * supabase-js can't express.
 */
export async function listThreads(clinicId: string): Promise<ThreadListItem[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('patient_threads')
    .select(
      `id, status, unread_count, last_message_at, patient_id,
       patients ( full_name, wa_phone )`,
    )
    .eq('clinic_id', clinicId)
    .order('last_message_at', { ascending: false })

  if (error) throw new Error(`threads fetch: ${error.message}`)

  const rows = (data ?? []) as unknown as ThreadRow[]
  if (rows.length === 0) return []

  const previews = await lastMessagePreviews(
    clinicId,
    rows.map((r) => r.patient_id),
  )

  return rows
    .map((r) => ({
      id: r.id,
      status: r.status,
      unreadCount: r.unread_count,
      lastMessageAt: r.last_message_at,
      patientId: r.patient_id,
      patientName: r.patients?.full_name ?? null,
      patientPhone: r.patients?.wa_phone ?? '',
      lastMessagePreview: previews.get(r.patient_id) ?? null,
    }))
    .sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      if (rank !== 0) return rank
      return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
    })
}

/** patient_id → truncated body of that patient's most recent message. */
async function lastMessagePreviews(
  clinicId: string,
  patientIds: string[],
): Promise<Map<string, string>> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('patient_messages')
    .select('patient_id, body, created_at')
    .eq('clinic_id', clinicId)
    .in('patient_id', patientIds)
    .order('created_at', { ascending: false })
    .limit(PREVIEW_SCAN_LIMIT)

  if (error) throw new Error(`message previews fetch: ${error.message}`)

  const out = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ patient_id: string; body: string }>) {
    // Rows arrive newest-first, so the first hit per patient is the one.
    if (!out.has(row.patient_id)) out.set(row.patient_id, truncate(row.body))
  }
  return out
}

/**
 * One thread with its patient, or null when it doesn't exist — which is
 * also what a thread id belonging to another clinic returns, so callers
 * can treat null as a 404 without leaking existence.
 */
export async function getThread(
  clinicId: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('patient_threads')
    .select(
      `id, status, unread_count, last_message_at, patient_id,
       escalated_to_doctor_id,
       patients ( full_name, wa_phone ),
       doctor_profiles ( specialty )`,
    )
    .eq('id', threadId)
    .eq('clinic_id', clinicId)
    .maybeSingle()

  if (error) throw new Error(`thread fetch: ${error.message}`)
  if (!data) return null

  const row = data as unknown as ThreadRow
  return {
    id: row.id,
    status: row.status,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    escalatedToDoctorId: row.escalated_to_doctor_id ?? null,
    escalatedToDoctorSpecialty: row.doctor_profiles?.specialty ?? null,
    patientId: row.patient_id,
    patientName: row.patients?.full_name ?? null,
    patientPhone: row.patients?.wa_phone ?? '',
  }
}

/**
 * The patient's messages interleaved with their appointments in one
 * ascending timeline (R7), so a doubt is read next to the visit it is
 * about. Labels are rendered in clinic-local time here, the same way the
 * dashboard shapes labels in its read layer.
 */
export async function getThreadTimeline(
  clinicId: string,
  patientId: string,
  timezone: string,
): Promise<TimelineEntry[]> {
  const supabase = await createClient()

  const [messages, appointments] = await Promise.all([
    supabase
      .from('patient_messages')
      .select('id, direction, body, sent_by, created_at')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .order('created_at', { ascending: true }),
    supabase
      .from('appointments')
      .select('id, starts_at, status, doctor_id')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .order('starts_at', { ascending: true }),
  ])

  if (messages.error) {
    throw new Error(`thread messages fetch: ${messages.error.message}`)
  }
  if (appointments.error) {
    throw new Error(`thread appointments fetch: ${appointments.error.message}`)
  }

  const entries: TimelineEntry[] = []

  for (const row of (messages.data ?? []) as Array<{
    id: string
    direction: MessageDirection
    body: string
    sent_by: string | null
    created_at: string
  }>) {
    entries.push({
      kind: 'message',
      id: row.id,
      at: row.created_at,
      dayLabel: localDayLabel(new Date(row.created_at), timezone),
      timeLabel: localTimeLabel(new Date(row.created_at), timezone),
      direction: row.direction,
      body: row.body,
      sentBy: row.sent_by,
    })
  }

  for (const row of (appointments.data ?? []) as Array<{
    id: string
    starts_at: string
    status: AppointmentStatus
    doctor_id: string
  }>) {
    entries.push({
      kind: 'appointment',
      id: row.id,
      at: row.starts_at,
      dayLabel: localDayLabel(new Date(row.starts_at), timezone),
      timeLabel: localTimeLabel(new Date(row.starts_at), timezone),
      status: row.status,
      doctorId: row.doctor_id,
    })
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * Is the patient's 24h WhatsApp session window still open? Derived from
 * the latest INBOUND message rather than a dedicated column (spec §4.5),
 * so it can never drift out of sync with what was actually received.
 *
 * A patient who has never messaged has no window: false, not true.
 */
export async function isWindowOpen(
  clinicId: string,
  patientId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('patient_messages')
    .select('created_at')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`window check failed: ${error.message}`)

  const at = (data as { created_at: string } | null)?.created_at
  if (!at) return false
  return now.getTime() - new Date(at).getTime() < WINDOW_MS
}
