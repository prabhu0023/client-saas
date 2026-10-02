import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'

/**
 * Route-level test for the wacrm inbound webhook (E2-T2).
 *
 * Pins the webhook contract so the security-sensitive bits (HMAC
 * verification, at-least-once dedupe) and the dispatch/ack behavior
 * can't silently regress:
 *
 *   - bad / missing signature        → 401
 *   - non-`message.received` event   → 200 { status: 'ignored' }
 *   - duplicate delivery id          → 200 { status: 'duplicate' }
 *   - unknown wacrm account          → 200 { status: 'no_clinic' }
 *   - empty text                     → 200 { status: 'no_text' }
 *   - valid message                  → 200 { status: 'handled' } + one send
 *
 * The signature is computed with a REAL HMAC (matching verify-signature)
 * so that path is genuinely exercised. The clinic/contact resolvers, the
 * flow, and the send adapter are stubbed at the module boundary; the
 * `processed_wa_events` dedupe is modeled with an in-memory set that
 * mimics insert-if-absent (23505 on repeat).
 */

const SECRET = 'test-webhook-secret'

// ------------------------------------------------------------
// Env: the route requires WACRM_WEBHOOK_SECRET.
// ------------------------------------------------------------
vi.stubEnv('WACRM_WEBHOOK_SECRET', SECRET)

// ------------------------------------------------------------
// In-memory dedupe ledger behind supabaseAdmin().from('processed_wa_events').
// ------------------------------------------------------------
const processed = new Set<string>()

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'processed_wa_events') {
        throw new Error(`unexpected table in route: ${table}`)
      }
      return {
        insert: async (row: { wamid: string }) => {
          if (processed.has(row.wamid)) {
            return { error: { code: '23505' } } // unique violation → duplicate
          }
          processed.add(row.wamid)
          return { error: null }
        },
      }
    },
  }),
}))

// ------------------------------------------------------------
// Tenant + contact resolution, session, flow, send.
// ------------------------------------------------------------
const resolveClinicMock = vi.fn()
vi.mock('@/lib/clinics/resolve-by-account', () => ({
  resolveClinicIdByWacrmAccount: (...a: unknown[]) => resolveClinicMock(...a),
}))

const resolveContactPhoneMock = vi.fn()
vi.mock('@/lib/whatsapp/wacrm-client', () => ({
  resolveContactPhone: (...a: unknown[]) => resolveContactPhoneMock(...a),
}))

const loadSessionMock = vi.fn()
vi.mock('@/lib/whatsapp/session', () => ({
  loadSession: (...a: unknown[]) => loadSessionMock(...a),
}))

const handleTextMessageMock = vi.fn()
vi.mock('@/lib/whatsapp/text-flow', () => ({
  handleTextMessage: (...a: unknown[]) => handleTextMessageMock(...a),
}))

const sendMessageMock = vi.fn()
vi.mock('@/lib/whatsapp/send', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(...a),
}))

import { POST } from './route'

// ------------------------------------------------------------
// Helpers.
// ------------------------------------------------------------
function sign(rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}

function envelope(over: Record<string, unknown> = {}) {
  const { data: dataOver, ...topOver } = over
  return {
    id: 'delivery-1',
    event: 'message.received',
    occurred_at: '2026-09-27T00:00:00Z',
    account_id: 'acct-1',
    ...topOver,
    // Merge (not replace) the data block so a partial `data` override
    // keeps the required conversation_id / contact_id fields.
    data: {
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
      whatsapp_message_id: 'wamid-1',
      text: 'appointment',
      ...((dataOver as object) ?? {}),
    },
  }
}

/** Build a Request with a valid signature over the given body (unless overridden). */
function req(body: object, signature?: string): Request {
  const raw = JSON.stringify(body)
  return new Request('https://clinic.example/api/whatsapp/inbound', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wacrm-signature': signature ?? sign(raw),
    },
    body: raw,
  })
}

beforeEach(() => {
  processed.clear()
  vi.clearAllMocks()
  resolveClinicMock.mockResolvedValue('clinic-1')
  resolveContactPhoneMock.mockResolvedValue('+919876543210')
  loadSessionMock.mockResolvedValue(null)
  handleTextMessageMock.mockResolvedValue({
    kind: 'text',
    to: '+919876543210',
    body: 'Which doctor would you like to see?',
  })
  sendMessageMock.mockResolvedValue(undefined)
})

describe('POST /api/whatsapp/inbound — signature', () => {
  it('rejects a missing signature with 401', async () => {
    const raw = JSON.stringify(envelope())
    const request = new Request('https://clinic.example/api/whatsapp/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })
    const res = await POST(request)
    expect(res.status).toBe(401)
    expect(handleTextMessageMock).not.toHaveBeenCalled()
  })

  it('rejects a tampered body (signature no longer matches) with 401', async () => {
    const goodSig = sign(JSON.stringify(envelope()))
    // Send a different body under the old signature.
    const request = req(envelope({ id: 'delivery-tampered' }), goodSig)
    const res = await POST(request)
    expect(res.status).toBe(401)
  })
})

describe('POST /api/whatsapp/inbound — routing & acks', () => {
  it('ignores non-message.received events', async () => {
    const res = await POST(req(envelope({ event: 'message.read' })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(handleTextMessageMock).not.toHaveBeenCalled()
  })

  it('handles a valid message: dispatches to the flow and sends one reply', async () => {
    const res = await POST(req(envelope()))
    expect(await res.json()).toEqual({ status: 'handled' })
    expect(handleTextMessageMock).toHaveBeenCalledTimes(1)
    expect(handleTextMessageMock).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      conversationId: 'conv-1',
      waPhone: '+919876543210',
      text: 'appointment',
      waMessageId: 'wamid-1',
    })
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('dedupes a repeated delivery id (at-least-once)', async () => {
    const first = await POST(req(envelope()))
    expect(await first.json()).toEqual({ status: 'handled' })

    // Same delivery id again → duplicate, no second dispatch/send.
    const second = await POST(req(envelope()))
    expect(await second.json()).toEqual({ status: 'duplicate' })
    expect(handleTextMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('returns no_clinic when the wacrm account is unknown', async () => {
    resolveClinicMock.mockResolvedValue(null)
    const res = await POST(req(envelope()))
    expect(await res.json()).toEqual({ status: 'no_clinic' })
    expect(handleTextMessageMock).not.toHaveBeenCalled()
  })

  it('returns no_text when the message carries no text', async () => {
    const res = await POST(req(envelope({ data: { text: '   ' } })))
    expect(await res.json()).toEqual({ status: 'no_text' })
    expect(handleTextMessageMock).not.toHaveBeenCalled()
  })

  it('prefers the cached session phone over a contact lookup', async () => {
    loadSessionMock.mockResolvedValue({ waPhone: '+911112223334' })
    await POST(req(envelope()))
    expect(resolveContactPhoneMock).not.toHaveBeenCalled()
    expect(handleTextMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ waPhone: '+911112223334' }),
    )
  })

  it('returns no_phone when neither session nor contact resolves a phone', async () => {
    loadSessionMock.mockResolvedValue(null)
    resolveContactPhoneMock.mockResolvedValue(null)
    const res = await POST(req(envelope()))
    expect(await res.json()).toEqual({ status: 'no_phone' })
    expect(handleTextMessageMock).not.toHaveBeenCalled()
  })

  it('does not send when the flow yields no reply', async () => {
    handleTextMessageMock.mockResolvedValue(null)
    const res = await POST(req(envelope()))
    expect(await res.json()).toEqual({ status: 'handled' })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/inbound — malformed input', () => {
  it('returns 400 on invalid JSON (with a valid signature over the raw bytes)', async () => {
    const raw = 'not-json{'
    const request = new Request('https://clinic.example/api/whatsapp/inbound', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wacrm-signature': sign(raw),
      },
      body: raw,
    })
    const res = await POST(request)
    expect(res.status).toBe(400)
  })

  it('returns 400 when required envelope fields are missing', async () => {
    const res = await POST(req({ id: 'x', event: 'message.received' }))
    expect(res.status).toBe(400)
  })
})
