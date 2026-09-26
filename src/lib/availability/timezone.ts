import { fromZonedTime, formatInTimeZone } from 'date-fns-tz'

/**
 * Timezone helpers for slot generation. The whole DST defense lives
 * here: availability is stored as LOCAL wall-clock time; appointments
 * are UTC instants; the clinic's IANA timezone bridges them. We always
 * convert through the named timezone (never a fixed offset), so a
 * clinic's "09:00" maps to the correct UTC instant on both sides of a
 * DST transition automatically.
 */

/** 'HH:mm' or 'HH:mm:ss' -> minutes since local midnight. */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** minutes since midnight -> 'HH:mm'. */
export function minutesToHHmm(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 'HH:mm' -> 'HHmm' (for slot-row ids). */
export function hhmmCompact(time: string): string {
  const [h, m] = time.split(':')
  return `${h.padStart(2, '0')}${(m ?? '00').padStart(2, '0')}`
}

/**
 * Combine a local date ('YYYY-MM-DD') and a local time ('HH:mm[:ss]')
 * interpreted in `timeZone`, returning the corresponding UTC instant.
 *
 * Uses date-fns-tz `fromZonedTime`, which resolves the named-timezone
 * offset for that specific date — the DST-safe conversion.
 */
export function localToUtc(
  dateYmd: string,
  time: string,
  timeZone: string,
): Date {
  // Normalize to 'YYYY-MM-DDTHH:mm:ss' wall-clock, then bind to the tz.
  const hhmmss = time.length === 5 ? `${time}:00` : time
  return fromZonedTime(`${dateYmd}T${hhmmss}`, timeZone)
}

/**
 * The weekday (0=Sun .. 6=Sat) of a local date as seen in `timeZone`.
 * Anchored at local noon to stay clear of midnight/DST boundaries.
 */
export function weekdayInTimeZone(dateYmd: string, timeZone: string): number {
  const utcNoon = localToUtc(dateYmd, '12:00:00', timeZone)
  // Read the weekday back in the clinic timezone.
  const dow = formatInTimeZone(utcNoon, timeZone, 'i') // ISO day 1=Mon..7=Sun
  const iso = Number(dow)
  return iso === 7 ? 0 : iso // map to 0=Sun..6=Sat
}

/** Format a UTC instant as a patient-facing local label, e.g. '10:00 AM'. */
export function localTimeLabel(utc: Date, timeZone: string): string {
  return formatInTimeZone(utc, timeZone, 'h:mm a')
}

/** Format a UTC instant as a local day label, e.g. 'Mon, Sep 22'. */
export function localDayLabel(utc: Date, timeZone: string): string {
  return formatInTimeZone(utc, timeZone, 'EEE, MMM d')
}

/** Today's date as 'YYYY-MM-DD' as seen in `timeZone`. */
export function todayYmdInTimeZone(timeZone: string, now: Date = new Date()): string {
  return formatInTimeZone(now, timeZone, 'yyyy-MM-dd')
}

/**
 * Calendar-day arithmetic on a 'YYYY-MM-DD' string: returns the date
 * `delta` days away as 'YYYY-MM-DD'. Anchored at UTC noon so DST never
 * shifts the calendar day. `delta` may be negative.
 */
export function addDaysYmd(dateYmd: string, delta: number): string {
  const d = new Date(`${dateYmd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}
