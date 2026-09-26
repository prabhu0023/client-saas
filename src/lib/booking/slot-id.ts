/**
 * Stateless encode/parse of WhatsApp list-row ids for the staged
 * booking flow (see docs §6). Encoding the slot into the row id lets
 * the tap be reconstructed without a server-side lookup table.
 *
 *   day step:   day_<doctorId>_<YYYY-MM-DD>
 *   time step:  slot_<doctorId>_<YYYY-MM-DD>_<HHMM>
 *
 * doctorId is a UUID (contains hyphens), so we parse from the right.
 */

export function encodeDayId(doctorId: string, dateYmd: string): string {
  return `day_${doctorId}_${dateYmd}`
}

export function encodeSlotId(
  doctorId: string,
  dateYmd: string,
  hhmm: string,
): string {
  return `slot_${doctorId}_${dateYmd}_${hhmm}`
}

export interface ParsedDayId {
  doctorId: string
  dateYmd: string
}

export interface ParsedSlotId {
  doctorId: string
  dateYmd: string
  /** 'HHMM', e.g. '1000'. */
  hhmm: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HHMM_RE = /^\d{4}$/

/** Parse `day_<doctorId>_<YYYY-MM-DD>`; null if malformed. */
export function parseDayId(id: string): ParsedDayId | null {
  if (!id.startsWith('day_')) return null
  const rest = id.slice('day_'.length)
  const sep = rest.lastIndexOf('_')
  if (sep < 0) return null
  const doctorId = rest.slice(0, sep)
  const dateYmd = rest.slice(sep + 1)
  if (!doctorId || !DATE_RE.test(dateYmd)) return null
  return { doctorId, dateYmd }
}

/** Parse `slot_<doctorId>_<YYYY-MM-DD>_<HHMM>`; null if malformed. */
export function parseSlotId(id: string): ParsedSlotId | null {
  if (!id.startsWith('slot_')) return null
  const rest = id.slice('slot_'.length)
  const lastSep = rest.lastIndexOf('_')
  if (lastSep < 0) return null
  const hhmm = rest.slice(lastSep + 1)
  const beforeHhmm = rest.slice(0, lastSep)
  const dateSep = beforeHhmm.lastIndexOf('_')
  if (dateSep < 0) return null
  const doctorId = beforeHhmm.slice(0, dateSep)
  const dateYmd = beforeHhmm.slice(dateSep + 1)
  if (!doctorId || !DATE_RE.test(dateYmd) || !HHMM_RE.test(hhmm)) return null
  return { doctorId, dateYmd, hhmm }
}
