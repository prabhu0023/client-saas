import { createHash, randomBytes } from 'node:crypto'

/**
 * One-time invite token mechanics (ONB-2).
 *
 * No SMTP is configured, so an invite is a shareable link rather than an
 * email. The token IS the authorization, which is why it is 256 bits of
 * CSPRNG output and why the database stores only its sha256:
 * `clinic_invites.token_hash` is all a dump or a leaked read gives up.
 *
 * Hashing happens here in Node rather than in SQL so nothing depends on
 * pgcrypto being enabled. Knowing sha256(token) is equivalent to holding
 * the token, so passing the hash to `accept_clinic_invite` is no weaker
 * than passing the token itself.
 *
 * The plaintext token is shown to the admin exactly once and is never
 * written to a log (NFR-5).
 */

/** 32 bytes → 43 base64url characters, no padding. */
const TOKEN_BYTES = 32

/** Shape of what generateInviteToken produces; the /join route re-checks it. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * A fresh invite token. base64url so it survives a URL path segment, a
 * WhatsApp message and a copy-paste without escaping.
 */
export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** sha256 hex — what the database stores and what the RPC is keyed on. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The shareable link for a token.
 *
 * THROWS when NEXT_PUBLIC_APP_URL is unset rather than guessing a host:
 * a link built against the wrong origin is unusable, and `createInvite()`
 * calls this BEFORE inserting so a misconfigured deployment cannot burn a
 * token on a link nobody can open.
 */
export function inviteUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (!base) {
    throw new Error('NEXT_PUBLIC_APP_URL is not set — cannot build an invite link')
  }
  return `${base.replace(/\/+$/, '')}/join/${token}`
}
