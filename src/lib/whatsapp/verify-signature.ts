import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify a wacrm webhook signature.
 *
 * wacrm signs each delivery Stripe-style:
 *   X-Wacrm-Signature: t=<unix_seconds>,v1=<hex HMAC-SHA256>
 * where v1 = HMAC_SHA256(secret, `${t}.${rawBody}`). We must recompute
 * over the RAW request body (never a re-serialized copy), compare in
 * constant time, and reject if `t` is too old (replay protection).
 */
export function verifyWacrmSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!header) return false

  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=')
      return [kv.slice(0, i).trim(), kv.slice(i + 1)]
    }),
  ) as { t?: string; v1?: string }

  const t = Number(parts.t)
  const v1 = typeof parts.v1 === 'string' ? parts.v1.trim().toLowerCase() : ''
  if (!Number.isFinite(t) || !v1) return false
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex')

  if (expected.length !== v1.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}
