import { NextResponse } from 'next/server'
import { handleInbound } from '@/lib/whatsapp/flow'
import type { InboundEvent } from '@/lib/whatsapp/types'

/**
 * Inbound WhatsApp events, forwarded from the wacrm channel.
 *
 * wacrm receives the Meta webhook and POSTs a normalized event here.
 * This route validates a shared secret, normalizes the body into an
 * InboundEvent, and hands it to the flow. Fire-and-forget from the
 * caller's perspective — we always 200 quickly so wacrm/Meta don't
 * retry on slow processing (dedupe protects against genuine repeats).
 */

export async function POST(request: Request) {
  // Shared-secret guard (same secret family as the cron).
  const expected = process.env.CRON_SECRET
  const supplied = request.headers.get('x-webhook-secret') ?? ''
  if (!expected || supplied !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const event = normalize(body)
  if (!event) {
    return NextResponse.json({ error: 'missing required fields' }, { status: 400 })
  }

  const status = await handleInbound(event)
  return NextResponse.json({ status })
}

/** Normalize the forwarded body into an InboundEvent; null if invalid. */
function normalize(body: unknown): InboundEvent | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const phoneNumberId = typeof b.phoneNumberId === 'string' ? b.phoneNumberId : null
  const from = typeof b.from === 'string' ? b.from : null
  const wamid = typeof b.wamid === 'string' ? b.wamid : null
  if (!phoneNumberId || !from || !wamid) return null

  return {
    phoneNumberId,
    from,
    wamid,
    text: typeof b.text === 'string' ? b.text : undefined,
    interactiveReplyId:
      typeof b.interactiveReplyId === 'string' ? b.interactiveReplyId : undefined,
  }
}
