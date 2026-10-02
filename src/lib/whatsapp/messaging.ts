import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Patient-messaging write/read path for the WhatsApp channel (T2).
 *
 * Runs on the service-role client because the actor is a patient with no
 * login, so RLS can't apply (see src/lib/supabase/admin.ts). That makes
 * tenancy this module's responsibility: every statement here is scoped
 * by clinic_id — and, where a patient is already known, by patient_id as
 * well — so a clinic can never see another clinic's thread (R8/R10).
 *
 * The capture itself is three writes that must land together (upsert
 * patient, insert message, bump thread), so it lives in the
 * `capture_patient_message` RPC (migration 011); this is the typed
 * wrapper around it, in the same shape as src/lib/booking/book.ts.
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

/**
 * Timestamp of the patient's most recent INBOUND message, which is what
 * the 24h free-form reply window is derived from (spec §4.5). Scoped by
 * BOTH clinic_id and patient_id: on the service-role client a patient_id
 * alone would read across tenants.
 */
export async function latestInboundAt(
  clinicId: string,
  patientId: string,
): Promise<string | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('patient_messages')
    .select('created_at')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[messaging] latestInboundAt failed:', error.message)
    return null
  }
  return (data as { created_at: string } | null)?.created_at ?? null
}
