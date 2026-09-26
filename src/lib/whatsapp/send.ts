import type { OutboundMessage, OutboundTemplate } from './types'

/**
 * Send adapter — delivers an outbound message via wacrm's public API
 * (POST /api/v1/messages, Bearer <API key>). Isolating the transport
 * here means a later switch (e.g. Meta Cloud API direct) only touches
 * this file.
 *
 * Contract confirmed against wacrm's docs/public-api.md:
 *   POST /api/v1/messages
 *   - text:     { to, type: 'text', text }
 *   - template: { to, type: 'template', template: { name, language, params } }
 *   wacrm's public API supports type = text | template | media only.
 *   There is NO interactive/list send type.
 *
 * NOTE: wacrm's inbound webhook does NOT forward the tapped list-row id,
 * so the booking flow is driven by numbered TEXT replies. Interactive
 * lists cannot round-trip AND wacrm can't send them via the public API,
 * so an OutboundList degrades to a plain text send of its body. The live
 * flow only ever produces text menus, so this is a safety fallback for
 * any orphaned caller.
 *
 * Replies sent right after a patient's message are inside the 24h
 * session window, so free-form text is allowed. Proactive messages
 * (reminders) must use approved templates — a separate path.
 */

const BASE = process.env.WACRM_BASE_URL
const KEY = process.env.WACRM_API_KEY

export interface SendResult {
  ok: boolean
  error?: string
}

export async function sendMessage(msg: OutboundMessage): Promise<SendResult> {
  if (!BASE || !KEY) {
    return { ok: false, error: 'wacrm channel not configured' }
  }

  // wacrm's public API (POST /api/v1/messages) supports type text |
  // template | media only — no interactive/list. Text sends as-is; a
  // list degrades to a text send of its body (the live flow never sends
  // lists — it uses numbered text menus — so this is just a safe
  // fallback for orphaned callers).
  const payload = { to: msg.to, type: 'text' as const, text: msg.body }

  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return { ok: false, error: `wacrm send returned ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Send an APPROVED WhatsApp template — the proactive path used by the
 * reminder cron (and later, staff-side change notifications) when the
 * patient is OUTSIDE the 24h session window, where free-form text is not
 * allowed by Meta.
 *
 * Same transport as `sendMessage` (POST /api/v1/messages, Bearer key,
 * 10s timeout, graceful failure when unconfigured) — only the payload
 * differs.
 *
 * Payload shape confirmed against wacrm's docs/public-api.md:
 *   { to, type:'template', template: { name, language, params: [...] } }
 * where `params` are the ordered positional body vars ({{1}}, {{2}}, …).
 * (An earlier draft used `body_params`, which wacrm does not accept.)
 */
export async function sendTemplate(tpl: OutboundTemplate): Promise<SendResult> {
  if (!BASE || !KEY) {
    return { ok: false, error: 'wacrm channel not configured' }
  }

  const payload = {
    to: tpl.to,
    type: 'template' as const,
    template: {
      name: tpl.templateName,
      language: tpl.languageCode ?? 'en',
      // wacrm fills body {{1}}, {{2}}, ... from this ordered list.
      params: tpl.bodyParams,
    },
  }

  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return { ok: false, error: `wacrm template send returned ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
