/**
 * Pure validation for availability edits (E5-T2), mirroring the CHECK
 * constraints in migration 001 so the server actions fail with a clear
 * message before hitting the DB. Extracted from the actions so the rules
 * are unit-testable without Supabase/auth.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const YMD = /^\d{4}-\d{2}-\d{2}$/

/** 'HH:mm' → minutes since midnight, or null if malformed. */
export function toMinutes(t: string): number | null {
  const m = HHMM.exec(t)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export interface ValidatedRule {
  weekday: number
  startTime: string
  endTime: string
  slotMinutes: number | null
}

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/** Validate a weekly-rule form: weekday 0–6, end > start, slot > 0 or blank. */
export function validateRule(input: {
  weekday: number
  startTime: string
  endTime: string
  slotMinutes: string
}): Validated<ValidatedRule> {
  const { weekday, startTime, endTime } = input
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return { ok: false, error: 'invalid weekday' }
  }
  const s = toMinutes(startTime)
  const e = toMinutes(endTime)
  if (s === null || e === null) return { ok: false, error: 'invalid time (use HH:mm)' }
  if (e <= s) return { ok: false, error: 'end time must be after start time' }

  let slotMinutes: number | null = null
  const slotRaw = input.slotMinutes.trim()
  if (slotRaw) {
    const n = Number(slotRaw)
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'slot minutes must be a positive integer' }
    }
    slotMinutes = n
  }

  return { ok: true, value: { weekday, startTime, endTime, slotMinutes } }
}

export interface ValidatedException {
  date: string
  kind: 'off' | 'extra'
  startTime: string | null
  endTime: string | null
}

/**
 * Validate an exception form. Mirrors the DB CHECKs:
 *  - date is YYYY-MM-DD, kind is off|extra
 *  - times are both-present (end > start) or both-absent
 *  - 'extra' requires both times; 'off' may be whole-day (both absent)
 */
export function validateException(input: {
  date: string
  kind: string
  startTime: string
  endTime: string
}): Validated<ValidatedException> {
  const { date } = input
  if (!YMD.test(date)) return { ok: false, error: 'invalid date' }
  if (input.kind !== 'off' && input.kind !== 'extra') {
    return { ok: false, error: 'invalid kind' }
  }
  const kind = input.kind

  const start = input.startTime.trim()
  const end = input.endTime.trim()
  const hasStart = start.length > 0
  const hasEnd = end.length > 0
  if (hasStart !== hasEnd) {
    return { ok: false, error: 'provide both start and end, or neither' }
  }

  if (hasStart && hasEnd) {
    const s = toMinutes(start)
    const e = toMinutes(end)
    if (s === null || e === null) return { ok: false, error: 'invalid time (use HH:mm)' }
    if (e <= s) return { ok: false, error: 'end time must be after start time' }
    return { ok: true, value: { date, kind, startTime: start, endTime: end } }
  }

  if (kind === 'extra') {
    return { ok: false, error: 'extra hours need a start and end time' }
  }
  return { ok: true, value: { date, kind, startTime: null, endTime: null } }
}
