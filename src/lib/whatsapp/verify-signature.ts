import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Why a signature check failed. Safe to log — none of these leak the
 * secret or the request body. Lets an operator distinguish a wrong/absent
 * secret (`hmac_mismatch`) from a clock/replay problem (`timestamp_skew`)
 * or a malformed/absent header, which are the real-world causes of a 401.
 */
export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_skew'
  | 'hmac_mismatch'

export interface SignatureCheck {
  ok: boolean
  reason?: SignatureFailure
  /** Signed-vs-now skew in seconds (only when the timestamp parsed). */
  skewSeconds?: number
}

/**
 * Verify a wacrm webhook signature, returning a structured result.
 *
 * wacrm signs each delivery Stripe-style:
 *   X-Wacrm-Signature: t=<unix_seconds>,v1=<hex HMAC-SHA256>
 * where v1 = HMAC_SHA256(secret, `${t}.${rawBody}`). We must recompute
 * over the RAW request body (never a re-serialized copy), compare in
 * constant time, and reject if `t` is too old (replay protection).
 */
export function checkWacrmSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing_header' }

  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=')
      return [kv.slice(0, i).trim(), kv.slice(i + 1)]
    }),
  ) as { t?: string; v1?: string }

  const t = Number(parts.t)
  const v1 = typeof parts.v1 === 'string' ? parts.v1.trim().toLowerCase() : ''
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'malformed_header' }

  const skewSeconds = nowSeconds - t
  if (Math.abs(skewSeconds) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_skew', skewSeconds }
  }

  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex')

  if (
    expected.length !== v1.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
  ) {
    return { ok: false, reason: 'hmac_mismatch', skewSeconds }
  }

  return { ok: true, skewSeconds }
}

/**
 * Boolean convenience wrapper around {@link checkWacrmSignature}, kept
 * for callers/tests that only care whether the signature is valid.
 */
export function verifyWacrmSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  return checkWacrmSignature(header, rawBody, secret, nowSeconds, toleranceSeconds).ok
}
