import type { OutboundMessage, OutboundTemplate } from './types'

/**
 * Send adapter — delivers an outbound message via wacrm's public API
 * (POST /api/v1/messages, Bearer <API key>). Isolating the transport
 * here means a later switch (e.g. Meta Cloud API direct) only touches
 * this file.
 *
 * Contract confirmed against the wacrm codebase:
 *   - text: { to, type: 'text', text }
 *   - list: { to, interactive_payload: { kind:'list', body,
 *            button_label, sections:[{ rows:[{id,title,description?}] }] } }
 *
 * NOTE: wacrm's inbound webhook does NOT forward the tapped list-row id,
 * so the booking flow is driven by numbered TEXT replies; interactive
 * lists are a nicer-to-read extra, not something we can round-trip. The
 * flow therefore sends text menus by default.
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

  // Map our normalized shape to wacrm's public-API send contract
  // (POST /api/v1/messages). Text is a plain `type:'text'` send; a list
  // maps to wacrm's `interactive_payload` (kind:'list') — NOT the
  // `type:'interactive_list'` shape an earlier draft assumed.
  const payload =
    msg.kind === 'text'
      ? { to: msg.to, type: 'text', text: msg.body }
      : {
          to: msg.to,
          interactive_payload: {
            kind: 'list' as const,
            body: msg.body,
            button_label: msg.buttonLabel,
            sections: [{ rows: msg.rows }],
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
 * ⚠️ TODO(verify): the exact template payload shape below is modeled on
 * WhatsApp's standard template message (name + language + ordered body
 * parameters) but has NOT yet been confirmed against wacrm's real public
 * API — the same caveat `deployment.md` raises for the existing send
 * contract. If wacrm expects a different envelope (e.g. a `template_payload`
 * wrapper mirroring `interactive_payload`, or named rather than positional
 * params), change it HERE only; callers and the reminder cron are
 * insulated from the wire shape.
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
      // WhatsApp fills body {{1}}, {{2}}, ... from this ordered list.
      body_params: tpl.bodyParams,
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
