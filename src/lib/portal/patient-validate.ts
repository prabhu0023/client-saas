import type { Validated } from './availability-validate'

/**
 * Pure validation for the staff booking flow's patient input (T1/T2).
 *
 * Extracted from the actions/read layers for the same reason
 * availability-validate.ts was: the rules are the part staff actually
 * hit, and they must be unit-testable without Supabase or auth.
 *
 * Two of these exist to protect the QUERY, not just the user:
 *  - buildSearchTerms refuses anything under two characters, so the
 *    type-ahead can never turn a single keystroke into an unbounded
 *    `ilike '%a%'` scan over the clinic's whole patient table.
 *  - escapeLikePattern neutralises the LIKE metacharacters, so a staff
 *    member typing '%' searches for a literal percent sign instead of
 *    matching every row. Postgres' default ESCAPE for LIKE/ILIKE is the
 *    backslash, which is why backslash itself is escaped first.
 *
 * Phone shape is E.164 because that is what `patients.wa_phone` holds
 * (the WhatsApp side only ever writes E.164) and `(clinic_id, wa_phone)`
 * is the UNIQUE key that makes R2's "reuse, don't error" work — a
 * loosely formatted duplicate would quietly create a second patient.
 */

/** E.164: '+', a non-zero country digit, then 7–14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/
const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Shortest term the type-ahead will query on. */
const MIN_SEARCH_CHARS = 2

/** Free-text notes are capped so one paste can't fill the column. */
const MAX_NOTES_CHARS = 2000

/** Validate an E.164 WhatsApp number, returning it trimmed. */
export function validateE164(raw: string): Validated<string> {
  const value = raw.trim()
  if (!E164.test(value)) {
    return { ok: false, error: 'phone must be in E.164 format, e.g. +919876543210' }
  }
  return { ok: true, value }
}

export interface SearchTerms {
  /** Matched against full_name: the term exactly as typed, trimmed. */
  name: string
  /**
   * Matched against wa_phone: the same term with a leading '+' and the
   * punctuation people put in phone numbers removed. Null when what is
   * left is too short to query on.
   */
  phone: string | null
}

/**
 * Split a typed search term into ONE pattern PER COLUMN, because the two
 * columns need opposite treatment.
 *
 * wa_phone is stored compact, so '+91 90000-00001' only finds
 * '+919000000001' once the '+', spaces and dashes are stripped.
 * full_name is the opposite: names legitimately contain exactly those
 * characters, so stripping them makes 'Asha R', 'Jean-Luc' and 'M. Rao'
 * match nothing at all. A single normalisation cannot serve both — the
 * term goes to full_name as typed and to wa_phone stripped.
 *
 * The two-character floor is applied to the typed term, and again to the
 * stripped one: '+9' is long enough to type but would leave a one-digit
 * phone pattern, so the phone read is dropped rather than scanned.
 */
export function buildSearchTerms(raw: string): Validated<SearchTerms> {
  const name = raw.trim()
  if (name.length < MIN_SEARCH_CHARS) {
    return { ok: false, error: 'type at least 2 characters' }
  }
  const digits = name.replace(/^\+/, '').replace(/[\s\-.()]/g, '')
  return {
    ok: true,
    value: { name, phone: digits.length >= MIN_SEARCH_CHARS ? digits : null },
  }
}

/**
 * Escape the LIKE metacharacters so the term matches literally. Must
 * escape the backslash first, or the escapes added for '%' and '_'
 * would themselves get escaped.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * True when 'YYYY-MM-DD' is a day that exists. The shape regex alone
 * lets '1990-02-31' and '2099-13-45' through, and the `date` column
 * rejects them — which would reach staff as a raw Postgres message
 * instead of the form's own wording. Round-tripping through a UTC Date
 * catches it here: Date normalises an overflowing day (Feb 31 → Mar 3),
 * so a mismatch on any component means the date was never real.
 */
function isRealYmd(ymd: string): boolean {
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  )
}

export interface ValidatedNewPatient {
  fullName: string
  waPhone: string
  dateOfBirth: string | null
  notes: string | null
}

/**
 * Validate the inline add-patient form. Name and phone are required
 * (they are how staff recognise the patient and how WhatsApp reaches
 * them); DOB and notes are optional and come back as null when blank so
 * the insert writes NULL rather than an empty string.
 */
export function validateNewPatient(input: {
  fullName: string
  waPhone: string
  dateOfBirth?: string
  notes?: string
}): Validated<ValidatedNewPatient> {
  const fullName = input.fullName.trim()
  if (!fullName) return { ok: false, error: 'patient name is required' }

  const phone = validateE164(input.waPhone)
  if (!phone.ok) return phone

  const dobRaw = (input.dateOfBirth ?? '').trim()
  let dateOfBirth: string | null = null
  if (dobRaw) {
    if (!YMD.test(dobRaw) || !isRealYmd(dobRaw)) {
      return { ok: false, error: 'invalid date of birth (use YYYY-MM-DD)' }
    }
    dateOfBirth = dobRaw
  }

  const notesRaw = (input.notes ?? '').trim()
  if (notesRaw.length > MAX_NOTES_CHARS) {
    return { ok: false, error: 'notes are too long (max 2000 characters)' }
  }
  const notes = notesRaw ? notesRaw : null

  return { ok: true, value: { fullName, waPhone: phone.value, dateOfBirth, notes } }
}
