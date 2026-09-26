import type { OutboundMessage } from './types'

/**
 * Send adapter — delivers an outbound message via the wacrm messaging
 * channel (MVP transport). Isolating this here means a later switch to
 * the Meta Cloud API only touches this file.
 *
 * Booking confirmations sent right after a patient's tap are inside the
 * 24h session window, so a free-form text send is allowed. Proactive
 * messages (reminders) must use approved templates — a separate path.
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

  // Map our normalized shape to wacrm's public-API send contract.
  const payload =
    msg.kind === 'text'
      ? { to: msg.to, type: 'text', text: msg.body }
      : {
          to: msg.to,
          type: 'interactive_list',
          body: msg.body,
          button: msg.buttonLabel,
          rows: msg.rows,
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
