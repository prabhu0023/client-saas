import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { checkWacrmSignature } from '@/lib/whatsapp/verify-signature'
import { resolveClinicIdByWacrmAccount } from '@/lib/clinics/resolve-by-account'
import { resolveContactPhone } from '@/lib/whatsapp/wacrm-client'
import { loadSession } from '@/lib/whatsapp/session'
import { handleTextMessage } from '@/lib/whatsapp/text-flow'
import { sendMessage } from '@/lib/whatsapp/send'

/**
 * Inbound WhatsApp events from the wacrm channel (one wacrm account per
 * clinic). wacrm owns the Meta webhook and POSTs us a signed
 * `message.received` delivery.
 *
 * Contract (confirmed against the wacrm codebase):
 *   Headers: X-Wacrm-Signature: t=<unix>,v1=<hex>
 *   Body:    { id, event, occurred_at, account_id,
 *              data: { conversation_id, contact_id,
 *                      whatsapp_message_id, content_type, text } }
 *
 * We verify the HMAC over the raw body, dedupe on the delivery id,
 * resolve the clinic from account_id and the patient phone from
 * contact_id, then run the text-driven booking flow and send the reply.
 * Always 200s quickly on handled cases so wacrm doesn't retry.
 */
export async function POST(request: Request) {
  const secret = process.env.WACRM_WEBHOOK_SECRET
  if (!secret) {
    console.error('[wa/inbound] WACRM_WEBHOOK_SECRET not set')
    return NextResponse.json({ error: 'not configured' }, { status: 500 })
  }

  // Read the RAW body first — the HMAC is computed over these exact bytes.
  const rawBody = await request.text()
  const signature = request.headers.get('x-wacrm-signature')
  const sig = checkWacrmSignature(signature, rawBody, secret)
  if (!sig.ok) {
    // Log the NAMED reason so a 401 is diagnosable without exposing the
    // secret or body. `hmac_mismatch` => the Vercel WACRM_WEBHOOK_SECRET
    // doesn't match the secret wacrm signs with (re-register the webhook
    // for THIS deployment's URL and set the printed secret). `timestamp_skew`
    // => clock/replay issue (skewSeconds shows how far off). `missing_header`
    // / `malformed_header` => not a genuine wacrm delivery or a proxy stripped
    // the header.
    console.error(
      `[wa/inbound] signature check failed: ${sig.reason}` +
        (sig.skewSeconds !== undefined ? ` (skew=${sig.skewSeconds}s)` : '') +
        ` headerPresent=${signature !== null}`,
    )
    return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }

  let envelope: WacrmEnvelope | null
  try {
    envelope = parseEnvelope(JSON.parse(rawBody))
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!envelope) {
    return NextResponse.json({ error: 'missing required fields' }, { status: 400 })
  }

  // Only react to inbound messages; ack everything else so wacrm is happy.
  if (envelope.event !== 'message.received') {
    return NextResponse.json({ status: 'ignored' })
  }

  const status = await handleDelivery(envelope)
  return NextResponse.json({ status })
}

async function handleDelivery(env: WacrmEnvelope): Promise<string> {
  try {
    // Dedupe on the per-delivery id (deliveries are at-least-once).
    if (await alreadyProcessed(env.id)) return 'duplicate'

    const clinicId = await resolveClinicIdByWacrmAccount(env.accountId)
    if (!clinicId) return 'no_clinic'

    const { conversationId, contactId, text } = env.data
    if (!text || !text.trim()) return 'no_text'

    // Resolve the patient's phone: prefer a cached value on the session,
    // otherwise fetch it from wacrm once.
    const session = await loadSession(conversationId)
    const waPhone =
      session?.waPhone ?? (await resolveContactPhone(contactId))
    if (!waPhone) return 'no_phone'

    const reply = await handleTextMessage({
      clinicId,
      conversationId,
      waPhone,
      text,
    })
    if (reply) await sendMessage(reply)
    return 'handled'
  } catch (err) {
    console.error('[wa/inbound] handleDelivery failed:', err)
    return 'error'
  }
}

/** Insert-if-absent into processed_wa_events; true if already seen. */
async function alreadyProcessed(deliveryId: string): Promise<boolean> {
  const db = supabaseAdmin()
  const { error } = await db
    .from('processed_wa_events')
    .insert({ wamid: deliveryId })
  if (!error) return false
  // 23505 = unique violation => already processed. Any other error:
  // fail open (process it) rather than dropping a legitimate message.
  return (error as { code?: string }).code === '23505'
}

interface WacrmEnvelope {
  id: string
  event: string
  accountId: string
  data: {
    conversationId: string
    contactId: string
    whatsappMessageId: string | null
    text: string | null
  }
}

/** Normalize wacrm's snake_case envelope; null if required fields absent. */
function parseEnvelope(body: unknown): WacrmEnvelope | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>

  const id = typeof b.id === 'string' ? b.id : null
  const event = typeof b.event === 'string' ? b.event : null
  const accountId = typeof b.account_id === 'string' ? b.account_id : null
  const data =
    typeof b.data === 'object' && b.data !== null
      ? (b.data as Record<string, unknown>)
      : null
  if (!id || !event || !accountId || !data) return null

  const conversationId =
    typeof data.conversation_id === 'string' ? data.conversation_id : null
  const contactId =
    typeof data.contact_id === 'string' ? data.contact_id : null
  if (!conversationId || !contactId) return null

  return {
    id,
    event,
    accountId,
    data: {
      conversationId,
      contactId,
      whatsappMessageId:
        typeof data.whatsapp_message_id === 'string'
          ? data.whatsapp_message_id
          : null,
      text: typeof data.text === 'string' ? data.text : null,
    },
  }
}
