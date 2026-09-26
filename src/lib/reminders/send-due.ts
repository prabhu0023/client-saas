import { supabaseAdmin } from '@/lib/supabase/admin'
import { sendTemplate } from '@/lib/whatsapp/send'
import { localDayLabel, localTimeLabel } from '@/lib/availability/timezone'

/**
 * Appointment-reminder scanner (roadmap E3-T3).
 *
 * Finds appointments that start within the reminder lead window and have
 * not been reminded yet, sends the approved WhatsApp template, and stamps
 * `reminder_sent_at` so a reminder is sent at most once.
 *
 * Idempotency / concurrency: we CLAIM each row with a conditional update
 * (`SET reminder_sent_at = now() WHERE id = ? AND reminder_sent_at IS NULL`)
 * BEFORE sending. If the update matches no row, another cron run already
 * took it and we skip — so two overlapping runs never double-send. If the
 * template send then fails, we release the claim (reset to NULL) so the
 * next run retries.
 *
 * Runs via the service role (no logged-in user) — same trust model as the
 * WhatsApp booking path. Safe to invoke every few minutes.
 */

/** Approved Meta template name for the appointment reminder. */
const TEMPLATE_NAME = process.env.REMINDER_TEMPLATE_NAME ?? 'appointment_reminder'

/** How far ahead to remind, in minutes (default 24h). */
const LEAD_MINUTES = Number(process.env.REMINDER_LEAD_MINUTES ?? 24 * 60)

export interface ReminderRunResult {
  scanned: number
  sent: number
  skipped: number
  failed: number
}

interface DueRow {
  id: string
  starts_at: string
  clinic: { name: string; timezone: string } | null
  patient: { wa_phone: string } | null
  doctor: { specialty: string | null } | null
}

export async function sendDueReminders(
  now: Date = new Date(),
): Promise<ReminderRunResult> {
  const db = supabaseAdmin()
  const windowEnd = new Date(now.getTime() + LEAD_MINUTES * 60_000)

  // Candidates: active, not-yet-reminded, starting inside the lead window
  // and not already in the past. Hits idx_appointments_reminder_due.
  const { data, error } = await db
    .from('appointments')
    .select(
      `id, starts_at,
       clinic:clinics ( name, timezone ),
       patient:patients ( wa_phone ),
       doctor:doctor_profiles ( specialty )`,
    )
    .is('reminder_sent_at', null)
    .in('status', ['booked', 'confirmed'])
    .gte('starts_at', now.toISOString())
    .lte('starts_at', windowEnd.toISOString())
    .order('starts_at', { ascending: true })
    .limit(200)

  if (error) throw new Error(`reminder scan: ${error.message}`)

  const rows = (data ?? []) as unknown as DueRow[]
  const result: ReminderRunResult = {
    scanned: rows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  }

  for (const row of rows) {
    const phone = row.patient?.wa_phone
    const tz = row.clinic?.timezone
    // Missing the essentials → skip (don't claim; nothing we can send).
    if (!phone || !tz) {
      result.skipped++
      continue
    }

    // CLAIM: only one runner can flip NULL → now(). If no row comes back,
    // someone else already claimed it this cycle.
    const claimedAt = now.toISOString()
    const { data: claimed, error: claimErr } = await db
      .from('appointments')
      .update({ reminder_sent_at: claimedAt })
      .eq('id', row.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle()

    if (claimErr) {
      console.error(`[reminders] claim failed for ${row.id}:`, claimErr.message)
      result.failed++
      continue
    }
    if (!claimed) {
      result.skipped++ // lost the race to another run
      continue
    }

    const starts = new Date(row.starts_at)
    const dayLabel = localDayLabel(starts, tz)
    const timeLabel = localTimeLabel(starts, tz)
    const clinicName = row.clinic?.name ?? 'the clinic'

    const send = await sendTemplate({
      kind: 'template',
      to: phone,
      templateName: TEMPLATE_NAME,
      // Template body order: {{1}} clinic, {{2}} day, {{3}} time.
      bodyParams: [clinicName, dayLabel, timeLabel],
    })

    if (send.ok) {
      result.sent++
    } else {
      // RELEASE the claim so a later run retries this reminder.
      await db
        .from('appointments')
        .update({ reminder_sent_at: null })
        .eq('id', row.id)
        .eq('reminder_sent_at', claimedAt)
      console.error(`[reminders] send failed for ${row.id}:`, send.error)
      result.failed++
    }
  }

  return result
}
