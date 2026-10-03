'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/portal/auth'
import {
  getThread,
  isWindowOpen,
  WINDOW_CLOSED_NOTICE,
  type ReplyState,
} from '@/lib/portal/messages'
import { sendMessage } from '@/lib/whatsapp/send'

/**
 * Staff actions on a patient thread (T3/T4): reply, mark read, escalate.
 *
 * All three run requireStaff() and then the RLS cookie client, with an
 * explicit `.eq('clinic_id', clinic.id)` on every statement — a forged
 * thread id from another clinic resolves to no thread and updates
 * nothing (R8).
 *
 * The reply path re-checks the 24h WhatsApp window SERVER-SIDE and
 * refuses the send when it's closed. The disabled textarea in the UI is
 * a courtesy, not the boundary: a free-form send outside the window is
 * rejected by Meta, so attempting one would silently lose a clinical
 * reply (R5). Human relay only — nothing here composes a message on the
 * clinic's behalf.
 *
 * replyToThread RETURNS its failure reason (ReplyState) instead of
 * throwing so ReplyForm can render it next to the textarea with the
 * typed body intact; mark-read and escalate still throw, as the
 * dashboard actions do, because they take no user-authored input.
 */

/** Longest reply we accept; WhatsApp text bodies cap out around 4096. */
const MAX_REPLY_CHARS = 4000

/** Revalidate the inbox list and the thread screen after a mutation. */
function revalidate(threadId: string): void {
  revalidatePath('/inbox')
  revalidatePath(`/inbox/${threadId}`)
}

/**
 * Send a staff reply over the patient's open WhatsApp session and store
 * it as an outbound message. Stores only after wacrm accepted the send,
 * so the thread never shows a reply the patient didn't get.
 */
export async function replyToThread(formData: FormData): Promise<ReplyState> {
  const { clinic, userId } = await requireStaff()

  const threadId = String(formData.get('threadId') ?? '')
  const body = String(formData.get('body') ?? '').trim()

  if (!threadId) return { error: 'missing thread' }
  if (!body) return { error: 'reply cannot be empty' }
  if (body.length > MAX_REPLY_CHARS) {
    return { error: `reply too long (max ${MAX_REPLY_CHARS} characters)` }
  }

  const thread = await getThread(clinic.id, threadId)
  if (!thread) return { error: 'thread not found in this clinic' }
  if (!thread.patientPhone) {
    return { error: 'patient has no WhatsApp number' }
  }

  // The security boundary for R5. Never fall through to a template or a
  // best-effort send; a closed window is a hard stop.
  if (!(await isWindowOpen(clinic.id, thread.patientId))) {
    return { error: WINDOW_CLOSED_NOTICE }
  }

  const sent = await sendMessage({
    kind: 'text',
    to: thread.patientPhone,
    body,
  })
  if (!sent.ok) return { error: `reply send failed: ${sent.error}` }

  const supabase = await createClient()

  const { error: insertErr } = await supabase.from('patient_messages').insert({
    clinic_id: clinic.id,
    patient_id: thread.patientId,
    direction: 'outbound',
    body,
    wa_delivery_id: null,
    sent_by: userId,
  })
  if (insertErr) return { error: `reply store failed: ${insertErr.message}` }

  // Replying is also reading: the thread goes back to zero unread.
  const { error: updateErr } = await supabase
    .from('patient_threads')
    .update({ last_message_at: new Date().toISOString(), unread_count: 0 })
    .eq('id', threadId)
    .eq('clinic_id', clinic.id)
  if (updateErr) return { error: `thread update failed: ${updateErr.message}` }

  revalidate(threadId)
  return { error: null }
}

/** Clear the unread badge without replying. */
export async function markThreadRead(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()

  const threadId = String(formData.get('threadId') ?? '')
  if (!threadId) throw new Error('missing thread')

  const supabase = await createClient()
  const { error } = await supabase
    .from('patient_threads')
    .update({ unread_count: 0 })
    .eq('id', threadId)
    .eq('clinic_id', clinic.id)
  if (error) throw new Error(`mark read failed: ${error.message}`)

  revalidate(threadId)
}

/**
 * Hand the thread to the treating doctor (R6). "Treating doctor" is the
 * doctor on the patient's most recent appointment; a patient with no
 * appointment still escalates, just unassigned, so staff can flag a
 * doubt they can't answer either way.
 */
export async function escalateThread(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()

  const threadId = String(formData.get('threadId') ?? '')
  if (!threadId) throw new Error('missing thread')

  const thread = await getThread(clinic.id, threadId)
  if (!thread) throw new Error('thread not found in this clinic')

  const supabase = await createClient()

  const { data: latest, error: apptErr } = await supabase
    .from('appointments')
    .select('doctor_id')
    .eq('clinic_id', clinic.id)
    .eq('patient_id', thread.patientId)
    .order('starts_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (apptErr) throw new Error(`doctor lookup failed: ${apptErr.message}`)

  const doctorId = (latest as { doctor_id: string } | null)?.doctor_id ?? null

  const { error } = await supabase
    .from('patient_threads')
    .update({ status: 'escalated', escalated_to_doctor_id: doctorId })
    .eq('id', threadId)
    .eq('clinic_id', clinic.id)
  if (error) throw new Error(`escalate failed: ${error.message}`)

  revalidate(threadId)
}
