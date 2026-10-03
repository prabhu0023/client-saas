import type { Validated } from './availability-validate'

/**
 * Pure validation for the self-serve onboarding surfaces (/signup,
 * /onboarding, /join, /setup, /staff, /services).
 *
 * Extracted for the same reason availability-validate.ts and
 * patient-validate.ts were: these are the rules the user actually hits,
 * and they must be unit-testable without Supabase or auth. Every server
 * action calls them BEFORE any DB round-trip.
 *
 * The security-relevant rules are deliberately duplicated in SQL —
 * `create_clinic_with_owner` (012), `connect_wacrm_account` (012) and
 * `accept_clinic_invite` (013) re-validate with the SAME rules, because
 * an RPC must not trust its caller. The consequence is that the two
 * sides must not drift: the app reads an `invalid` outcome from those
 * RPCs as a BUG SIGNAL (validator drift), not as user error, so a
 * divergent pattern here would manufacture exactly that bug. The slug
 * rule below is the one most at risk and is written character-for-
 * character as the SQL has it.
 */

/**
 * Canonical slug rule, identical to the regex in
 * create_clinic_with_owner: starts and ends alphanumeric, lowercase
 * only, single hyphens in between.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/
const SLUG_MIN = 3
const SLUG_MAX = 40

/** Deliberately permissive: shape only, never a deliverability claim. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const EMAIL_MAX = 254

/** 72 is the bcrypt input ceiling — a longer password is silently truncated. */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 72

const WACRM_ACCOUNT_RE = /^[A-Za-z0-9_.:-]+$/
const WACRM_ACCOUNT_MAX = 128

/** Meta's phone_number_id is a numeric string. */
const PHONE_NUMBER_ID_RE = /^[0-9]{1,64}$/

/** The human-readable number shown in the portal, not a routing key. */
const DISPLAY_NUMBER_RE = /^[0-9+\-() ]*$/
const DISPLAY_NUMBER_MAX = 32

/** Up to six major units with at most two decimals. */
const PRICE_RE = /^\d{1,6}(\.\d{1,2})?$/
const PRICE_CENTS_MAX = 99_999_999

/** Names are what patients see on WhatsApp, so they are capped, not cut. */
const NAME_MAX = 120

/**
 * Suggest a slug from a clinic name. Prefills the field; the user may
 * still edit it, and `validateSlug` is what actually decides.
 *
 * Punctuation is DROPPED rather than turned into a separator, which is
 * what makes "St. Mary's Clinic" read `st-marys-clinic` instead of
 * `st-mary-s-clinic`. Only whitespace and hyphens separate, and runs of
 * them collapse to one. The result can still be invalid (a name of only
 * punctuation yields ''), so the caller must validate it.
 */
export function slugify(raw: string): string {
  return raw
    .normalize('NFKD')
    // Strip the combining marks NFKD just split off, so "Clínica" →
    // "clinica" rather than losing the letter with its accent.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Drop everything that is not a letter, digit or separator — this is
    // the step that removes '.', apostrophes (straight and curly) and
    // the rest of the unicode punctuation block.
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // The slice can land mid-hyphen, which would fail SLUG_RE.
    .replace(/-+$/g, '')
}

/**
 * The canonical slug rule. Returns the reason it failed so a caller can
 * phrase one message per cause, or null when the slug is usable.
 *
 * Kept as a code union rather than Validated<string> because the slug is
 * never normalised here — a slug that needs fixing is the user's to fix
 * (it becomes their public web address), and silently rewriting it would
 * change what they think they chose.
 */
export function validateSlug(s: string): 'length' | 'charset' | 'double-hyphen' | null {
  if (s.length < SLUG_MIN || s.length > SLUG_MAX) return 'length'
  if (!SLUG_RE.test(s)) return 'charset'
  if (s.includes('--')) return 'double-hyphen'
  return null
}

/** Trimmed clinic name, 1–120 chars. Re-validated by the RPC. */
export function validateClinicName(raw: string): Validated<string> {
  const value = raw.trim()
  if (!value || value.length > NAME_MAX) {
    return { ok: false, error: 'Enter the clinic name.' }
  }
  return { ok: true, value }
}

/**
 * Area/Location shape, with every segment starting uppercase — which is
 * how `pg_timezone_names` spells all of them, and how every one of the 418
 * entries `Intl.supportedValuesOf('timeZone')` returns is spelled. Used
 * only on the alias path below, where it is what keeps 'EST', 'EST5EDT',
 * 'UTC+5' and a lower-cased 'asia/kolkata' out.
 */
const IANA_ZONE_RE = /^[A-Z][A-Za-z0-9+_-]*(?:\/[A-Z][A-Za-z0-9+_-]*)+$/

/**
 * True for an IANA timezone name.
 *
 * The matching SQL rule is `EXISTS (SELECT 1 FROM pg_timezone_names …)`,
 * NOT a bare `AT TIME ZONE` cast: Postgres also accepts 'EST', 'UTC+5'
 * and POSIX forms that this list rejects, and `clinics.timezone` feeds
 * date-fns-tz slot generation, so both sides must accept the same set.
 *
 * WHY THIS IS NOT A BARE `includes(tz)`. V8 canonicalizes zone names per
 * CLDR, which still treats the pre-2018 names as canonical, so the list
 * contains 'Asia/Calcutta' and NOT 'Asia/Kolkata' — the name IANA made
 * primary, the name `scripts/seed.ts` writes, and the name every clinic in
 * the target market would pick. A literal membership test therefore
 * rejects the single most important timezone in the product while
 * `pg_timezone_names` accepts it: drift, in the direction that produces
 * the `invalid` RPC outcome §12.2 reads as a bug signal. So a CLDR alias
 * is accepted by resolving it through Intl's own canonicalization.
 *
 * The invariant kept is the one that matters: everything accepted here is
 * in `pg_timezone_names` too (it contains both the primary names and the
 * backward links). The reverse does not hold — 'UTC', 'EST' and the
 * `posix/*` names are accepted by Postgres and refused here — and that
 * asymmetry is safe, because the stricter side is the one the user picks
 * from.
 *
 * `Intl.supportedValuesOf` is Node ≥ 18 (engines requires ≥ 20) and is
 * only reached on the Node runtime — none of the onboarding routes opt
 * into Edge.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false

  const supported = Intl.supportedValuesOf('timeZone')
  if (supported.includes(tz)) return true

  // Alias path. Shape-checked FIRST, so nothing that is not an
  // Area/Location name can reach the canonicalizer — ICU happily resolves
  // 'EST' to America/Panama and 'EST5EDT' to America/New_York, and both
  // are exactly the non-IANA forms this validator exists to refuse.
  if (!IANA_ZONE_RE.test(tz)) return false

  try {
    const canonical = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
    }).resolvedOptions().timeZone
    return supported.includes(canonical)
  } catch {
    // RangeError — not a zone this runtime knows at all.
    return false
  }
}

/** Trimmed and LOWER-CASED, so it matches what the DB stores. */
export function validateEmail(raw: string): Validated<string> {
  const value = raw.trim().toLowerCase()
  if (!value || value.length > EMAIL_MAX || !EMAIL_RE.test(value)) {
    return { ok: false, error: 'Enter a valid email address.' }
  }
  return { ok: true, value }
}

/**
 * Password length only — never trimmed, since leading and trailing
 * spaces are legitimate characters in a password the user chose.
 *
 * Confirm-field equality is the caller's check, because only the caller
 * has both fields and the two failures need different copy.
 */
export function validatePassword(raw: string): Validated<string> {
  if (raw.length < PASSWORD_MIN) {
    return { ok: false, error: 'Use at least 8 characters.' }
  }
  if (raw.length > PASSWORD_MAX) {
    return { ok: false, error: 'Use at most 72 characters.' }
  }
  return { ok: true, value: raw }
}

/** Required. The last hop of PRD §8's routing chain, so it is re-validated in SQL. */
export function validateWacrmAccountId(raw: string): Validated<string> {
  const value = raw.trim()
  if (!value || value.length > WACRM_ACCOUNT_MAX || !WACRM_ACCOUNT_RE.test(value)) {
    return { ok: false, error: 'That does not look like a wacrm account id.' }
  }
  return { ok: true, value }
}

/** Optional: blank comes back as null so the RPC writes no number row. */
export function validatePhoneNumberId(raw: string): Validated<string | null> {
  const value = raw.trim()
  if (!value) return { ok: true, value: null }
  if (!PHONE_NUMBER_ID_RE.test(value)) {
    return { ok: false, error: 'Phone number id should be digits only.' }
  }
  return { ok: true, value }
}

/**
 * Optional display number. REJECTED, never truncated: silently cutting
 * a number to 32 chars would store a wrong number that looks right.
 */
export function validateDisplayNumber(raw: string): Validated<string | null> {
  const value = raw.trim()
  if (!value) return { ok: true, value: null }
  if (value.length > DISPLAY_NUMBER_MAX || !DISPLAY_NUMBER_RE.test(value)) {
    return { ok: false, error: 'Enter a valid number.' }
  }
  return { ok: true, value }
}

/**
 * Parse a price in major units ('450', '450.50') to integer cents.
 *
 * Strict string parse first, so no float ever reaches the DB column, and
 * then an EXPLICIT range assertion rather than trusting the regex to
 * imply it: the two bounds are what `services.price_cents` must hold, and
 * stating them here means a widened regex cannot quietly widen the column
 * contract too.
 */
export function parsePriceToCents(raw: string): Validated<number> {
  const value = raw.trim()
  const invalid = { ok: false, error: 'Enter a price like 450 or 450.50.' } as const
  if (!PRICE_RE.test(value)) return invalid

  const cents = Math.round(Number(value) * 100)
  if (!Number.isInteger(cents) || cents < 0 || cents > PRICE_CENTS_MAX) return invalid

  return { ok: true, value: cents }
}

/** Trimmed service name, 1–120 chars. Duplicate-name checks live in the action. */
export function validateServiceName(raw: string): Validated<string> {
  const value = raw.trim()
  if (!value || value.length > NAME_MAX) {
    return { ok: false, error: 'Enter the service name.' }
  }
  return { ok: true, value }
}

/**
 * Trimmed person's name, 1–120 chars.
 *
 * Re-validated in SQL by both `create_clinic_with_owner` and
 * `accept_clinic_invite`, because this is the one value patients read:
 * `loadDoctorOptions()` falls back to the literal 'Doctor' when
 * `users.full_name` is null (src/lib/whatsapp/query.ts).
 */
export function validateFullName(raw: string): Validated<string> {
  const value = raw.trim()
  if (!value || value.length > NAME_MAX) {
    return { ok: false, error: 'Enter your name.' }
  }
  return { ok: true, value }
}
