import { sendTemplate } from './send'
import { localDayLabel, localTimeLabel } from '@/lib/availability/timezone'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Patient notifications for staff-initiated appointment changes (E4-T3).
 *
 * When staff cancel an appointment in the portal, the patient should be
 * told over WhatsApp. These sends are almost always OUTSIDE the 24h
 * session window (staff act hours/days after the patient's last message),
 * and we don't currently track the patient's last-inbound time — so we
 * use an APPROVED TEMPLATE, which Meta permits both inside and outside
 * the window. (A future optimization: track last-inbound and use a
 * cheaper free-form text when provably inside 24h. Template is the safe
 * default and never gets rejected for being out-of-window.)
 *
 * Best-effort: never throws. A failed notification must not fail the
 * staff action that triggered it — the status change already succeeded.
 * The caller passes the RLS-scoped client it already holds; we only read
 * the patient phone + clinic bits the staff member can already see.
 */

const CANCELLATION_TEMPLATE_NAME =
  process.env.CANCELLATION_TEMPLATE_NAME ?? 'appointment_cancelled'

interface NotifyRow {
  starts_at: string
  clinics: { name: string; timezone: string } | null
  patients: { wa_phone: string } | null
}

/**
 * Tell the patient their appointment was cancelled by the clinic. Reads
 * the phone + clinic/time for the appointment (RLS-scoped via the passed
 * client), then sends the cancellation template. Returns true if a send
 * was attempted and reported OK; false on any miss (no phone, read
 * error, send failure) — logged, never thrown.
 */
export async function notifyPatientCancelled(
  supabase: SupabaseClient,
  appointmentId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('starts_at, clinics ( name, timezone ), patients ( wa_phone )')
      .eq('id', appointmentId)
      .maybeSingle()

    if (error || !data) {
      if (error) console.error('[wa/notify] read failed:', error.message)
      return false
    }

    const row = data as unknown as NotifyRow
    const phone = row.patients?.wa_phone
    const tz = row.clinics?.timezone
    if (!phone || !tz) return false

    const starts = new Date(row.starts_at)
    const dayLabel = localDayLabel(starts, tz)
    const timeLabel = localTimeLabel(starts, tz)
    const clinicName = row.clinics?.name ?? 'the clinic'

    const res = await sendTemplate({
      kind: 'template',
      to: phone,
      templateName: CANCELLATION_TEMPLATE_NAME,
      // Template body order: {{1}} clinic, {{2}} day, {{3}} time.
      bodyParams: [clinicName, dayLabel, timeLabel],
    })
    if (!res.ok) {
      console.error('[wa/notify] cancellation send failed:', res.error)
      return false
    }
    return true
  } catch (err) {
    console.error(
      '[wa/notify] notifyPatientCancelled threw:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}
