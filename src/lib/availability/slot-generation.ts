import { supabaseAdmin } from '@/lib/supabase/admin'
import type {
  AvailabilityRule,
  AvailabilityException,
  Appointment,
  Slot,
} from '@/types'
import {
  timeToMinutes,
  minutesToHHmm,
  localToUtc,
  weekdayInTimeZone,
  localTimeLabel,
} from './timezone'

/**
 * Slot generation (read path, docs §4).
 *
 * Given one doctor, one date, and the clinic timezone, produce the
 * ordered list of bookable slots:
 *
 *   rules (for weekday) + 'extra' exceptions
 *     - 'off' exceptions
 *     - already-booked appointments
 *     - past / within-lead-time slots
 *   -> chunked into slot-length intervals, labelled in clinic-local time.
 *
 * The list is ADVISORY. The DB exclusion constraint (migration 002) is
 * the authoritative guard against double-booking; two callers can be
 * shown the same slot simultaneously.
 */

export interface LocalWindow {
  /** minutes since local midnight */
  startMin: number
  endMin: number
}

export interface UtcWindow {
  start: Date
  end: Date
}

export interface GenerateSlotsArgs {
  doctorId: string
  /** 'YYYY-MM-DD' in the clinic's timezone. */
  dateYmd: string
  clinicTimezone: string
  /** Doctor's default slot length; a rule may override per-window. */
  defaultSlotMinutes: number
  /** Minimum minutes from now a slot must start (default 0). */
  minLeadMinutes?: number
  /** Injectable clock for tests. */
  now?: Date
}

// ------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ------------------------------------------------------------

/**
 * Subtract one local minute-range from a set of windows. Splits a
 * window when the removed range falls inside it. Half-open ranges.
 */
export function subtractWindow(
  windows: LocalWindow[],
  offStart: number,
  offEnd: number,
): LocalWindow[] {
  const out: LocalWindow[] = []
  for (const w of windows) {
    // No overlap — keep as is.
    if (offEnd <= w.startMin || offStart >= w.endMin) {
      out.push(w)
      continue
    }
    // Left remainder.
    if (offStart > w.startMin) out.push({ startMin: w.startMin, endMin: offStart })
    // Right remainder.
    if (offEnd < w.endMin) out.push({ startMin: offEnd, endMin: w.endMin })
    // Fully covered -> nothing kept.
  }
  return out.sort((a, b) => a.startMin - b.startMin)
}

/**
 * Compute effective LOCAL windows for a date from recurring rules for
 * the weekday plus that date's exceptions. Each window carries the slot
 * length to use (rule override or the doctor default).
 */
export function computeLocalWindows(
  weekday: number,
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
  defaultSlotMinutes: number,
): Array<LocalWindow & { slotMinutes: number }> {
  // Whole-day off short-circuits everything.
  const wholeDayOff = exceptions.some(
    (e) => e.kind === 'off' && !e.start_time && !e.end_time,
  )
  if (wholeDayOff) return []

  // Base windows from recurring rules for this weekday.
  let windows: Array<LocalWindow & { slotMinutes: number }> = rules
    .filter((r) => r.active && r.weekday === weekday)
    .map((r) => ({
      startMin: timeToMinutes(r.start_time),
      endMin: timeToMinutes(r.end_time),
      slotMinutes: r.slot_minutes ?? defaultSlotMinutes,
    }))

  // Add 'extra' windows (use the doctor default slot length).
  for (const e of exceptions) {
    if (e.kind === 'extra' && e.start_time && e.end_time) {
      windows.push({
        startMin: timeToMinutes(e.start_time),
        endMin: timeToMinutes(e.end_time),
        slotMinutes: defaultSlotMinutes,
      })
    }
  }

  // Subtract timed 'off' ranges. Preserve each surviving piece's slot len.
  for (const e of exceptions) {
    if (e.kind === 'off' && e.start_time && e.end_time) {
      const offStart = timeToMinutes(e.start_time)
      const offEnd = timeToMinutes(e.end_time)
      windows = windows.flatMap((w) =>
        subtractWindow([w], offStart, offEnd).map((piece) => ({
          ...piece,
          slotMinutes: w.slotMinutes,
        })),
      )
    }
  }

  return windows.sort((a, b) => a.startMin - b.startMin)
}

/**
 * Half-open overlap test for two UTC intervals:
 * `a.start < b.end && a.end > b.start`.
 */
export function overlaps(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime()
}

// ------------------------------------------------------------
// Orchestrator (fetches DB, produces slots)
// ------------------------------------------------------------

/**
 * Pure core: given already-fetched rules/exceptions/appointments,
 * produce slots. Separated from the DB fetch so it is fully testable
 * without a database.
 */
export function buildSlots(
  args: GenerateSlotsArgs,
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
  bookedUtc: Array<{ start: Date; end: Date }>,
): Slot[] {
  const {
    doctorId,
    dateYmd,
    clinicTimezone,
    defaultSlotMinutes,
    minLeadMinutes = 0,
    now = new Date(),
  } = args

  const weekday = weekdayInTimeZone(dateYmd, clinicTimezone)
  const localWindows = computeLocalWindows(
    weekday,
    rules,
    exceptions,
    defaultSlotMinutes,
  )
  if (localWindows.length === 0) return []

  const cutoff = new Date(now.getTime() + minLeadMinutes * 60_000)
  const slots: Slot[] = []

  for (const w of localWindows) {
    const slotMs = w.slotMinutes * 60_000
    // Walk the window in slot-length steps; a slot must fully fit.
    for (let m = w.startMin; m + w.slotMinutes <= w.endMin; m += w.slotMinutes) {
      const startUtc = localToUtc(dateYmd, minutesToHHmm(m), clinicTimezone)
      const endUtc = new Date(startUtc.getTime() + slotMs)

      // Drop past / within-lead-time.
      if (startUtc.getTime() < cutoff.getTime()) continue

      // Drop if it overlaps an existing active appointment.
      const clash = bookedUtc.some((b) =>
        overlaps(startUtc, endUtc, b.start, b.end),
      )
      if (clash) continue

      // Compact clinic-local HHMM for the slot-row id (derived from the
      // local minute we're iterating, not re-parsed from a display label).
      const hh = String(Math.floor(m / 60)).padStart(2, '0')
      const mm = String(m % 60).padStart(2, '0')

      slots.push({
        doctorId,
        startsAtUtc: startUtc.toISOString(),
        endsAtUtc: endUtc.toISOString(),
        localLabel: localTimeLabel(startUtc, clinicTimezone),
        hhmm: `${hh}${mm}`,
      })
    }
  }

  return slots.sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))
}

/**
 * Full path: fetch rules/exceptions/booked appointments for the doctor
 * and date, then build slots. Runs server-side (service role) since it
 * is used by the WhatsApp path.
 */
export async function generateSlots(args: GenerateSlotsArgs): Promise<Slot[]> {
  const db = supabaseAdmin()
  const { doctorId, dateYmd, clinicTimezone } = args

  // Day bounds in UTC, derived from the clinic-local calendar day.
  const dayStartUtc = localToUtc(dateYmd, '00:00:00', clinicTimezone)
  const dayEndUtc = localToUtc(dateYmd, '00:00:00', clinicTimezone)
  dayEndUtc.setUTCDate(dayEndUtc.getUTCDate() + 1)

  const [rulesRes, exceptionsRes, apptRes] = await Promise.all([
    db.from('availability_rules').select('*').eq('doctor_id', doctorId),
    db
      .from('availability_exceptions')
      .select('*')
      .eq('doctor_id', doctorId)
      .eq('date', dateYmd),
    db
      .from('appointments')
      .select('starts_at, ends_at, status')
      .eq('doctor_id', doctorId)
      .in('status', ['booked', 'confirmed'])
      .lt('starts_at', dayEndUtc.toISOString())
      .gt('ends_at', dayStartUtc.toISOString()),
  ])

  if (rulesRes.error) throw new Error(`rules fetch: ${rulesRes.error.message}`)
  if (exceptionsRes.error)
    throw new Error(`exceptions fetch: ${exceptionsRes.error.message}`)
  if (apptRes.error) throw new Error(`appointments fetch: ${apptRes.error.message}`)

  const booked = (apptRes.data as Pick<Appointment, 'starts_at' | 'ends_at'>[]).map(
    (a) => ({ start: new Date(a.starts_at), end: new Date(a.ends_at) }),
  )

  return buildSlots(
    args,
    rulesRes.data as AvailabilityRule[],
    exceptionsRes.data as AvailabilityException[],
    booked,
  )
}
