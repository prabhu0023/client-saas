import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Patient-messaging write path for the WhatsApp channel (T2).
 *
 * Runs on the service-role client because the actor is a patient with no
 * login, so RLS can't apply (see src/lib/supabase/admin.ts). That makes
 * tenancy this module's responsibility: every statement here is scoped
 * by the clinic_id the caller already resolved from the wacrm account,
 * so a clinic can never touch another clinic's thread (R8/R10).
 *
 * The capture itself is three writes that must land together (upsert
 * patient, insert message, bump thread), so it lives in the
 * `capture_patient_message` RPC (migration 011); this is the typed
 * wrapper around it, in the same shape as src/lib/booking/book.ts.
 *
 * WRITE-ONLY ON PURPOSE: the 24h free-form reply window (spec §4.5) is
 * decided on the staff side, by isWindowOpen in src/lib/portal/messages.ts,
 * on the RLS client. It is deliberately NOT answered here — a reader on
 * the service-role client would bypass RLS for a logged-in staff user,
 * and a second copy of the rule could drift from the one the reply guard
 * enforces. Do not add a window/transcript read to this module.
 *
 * Nothing here throws: an inbound webhook that fails to persist should
 * degrade to the plain fallback nudge, never to a 500 that makes wacrm
 * retry the delivery.
 */

export interface CaptureArgs {
  clinicId: string
  /** E.164 WhatsApp number of the patient. */
  waPhone: string
  /** The inbound free text, stored verbatim. */
  body: string
  /** wacrm delivery id, for tracing a row back to its webhook delivery. */
  waMessageId?: string
}

export interface CaptureResult {
  patientId: string
  messageId: string
  /** True only for the patient's first ever message — drives the notice. */
  isFirstMessage: boolean
}

interface CaptureRpcRow {
  patient_id: string
  message_id: string
  is_first_message: boolean
}

/**
 * Persist one inbound patient message into its thread.
 * Returns null on any failure — the caller must then NOT claim receipt.
 */
export async function capturePatientMessage(
  args: CaptureArgs,
): Promise<CaptureResult | null> {
  const { clinicId, waPhone, body, waMessageId = null } = args

  const db = supabaseAdmin()
  const { data, error } = await db.rpc('capture_patient_message', {
    p_clinic_id: clinicId,
    p_wa_phone: waPhone,
    p_body: body,
    p_wa_delivery_id: waMessageId,
  })

  if (error) {
    console.error(
      '[messaging] capture_patient_message rpc failed:',
      error.message,
    )
    return null
  }

  // supabase returns SETOF rows; take the first.
  const row = (Array.isArray(data) ? data[0] : data) as
    | CaptureRpcRow
    | undefined
  if (!row || !row.patient_id || !row.message_id) {
    console.error('[messaging] capture_patient_message returned no row')
    return null
  }

  return {
    patientId: row.patient_id,
    messageId: row.message_id,
    isFirstMessage: row.is_first_message === true,
  }
}
