/**
 * Thin client for wacrm's public API — the calls the booking flow needs
 * beyond sending messages (which lives in send.ts).
 *
 * wacrm's `message.received` webhook gives us a `contact_id` but not the
 * sender's phone number. We need the E.164 phone to key the patient
 * record, so we resolve it once via GET /api/v1/contacts/{id} (requires
 * a key with the `contacts:read` scope) and cache it on the session.
 */

const BASE = process.env.WACRM_BASE_URL
const KEY = process.env.WACRM_API_KEY

/**
 * Resolve a wacrm contact's E.164 phone number by contact id. Returns
 * null on any failure (not configured, network, not found, bad shape) —
 * callers degrade gracefully rather than throwing on the webhook path.
 */
export async function resolveContactPhone(
  contactId: string,
): Promise<string | null> {
  if (!BASE || !KEY) {
    console.error('[wacrm-client] channel not configured')
    return null
  }

  try {
    const res = await fetch(
      `${BASE.replace(/\/$/, '')}/api/v1/contacts/${encodeURIComponent(contactId)}`,
      {
        headers: { authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.error(`[wacrm-client] contact fetch returned ${res.status}`)
      return null
    }
    const json = (await res.json()) as { data?: { phone?: unknown } }
    const phone = json.data?.phone
    return typeof phone === 'string' && phone.trim() ? phone.trim() : null
  } catch (err) {
    console.error(
      '[wacrm-client] contact fetch failed:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
