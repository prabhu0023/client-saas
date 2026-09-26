import { describe, it, expect } from 'vitest'
import {
  subtractWindow,
  computeLocalWindows,
  overlaps,
  buildSlots,
  type GenerateSlotsArgs,
} from './slot-generation'
import { localToUtc, weekdayInTimeZone } from './timezone'
import type { AvailabilityRule, AvailabilityException } from '@/types'

const DOCTOR = 'doc-1'
const TZ = 'Asia/Kolkata' // no DST — stable baseline

function rule(overrides: Partial<AvailabilityRule>): AvailabilityRule {
  return {
    id: 'r',
    clinic_id: 'c',
    doctor_id: DOCTOR,
    weekday: 1,
    start_time: '09:00',
    end_time: '12:00',
    slot_minutes: null,
    active: true,
    created_at: '',
    ...overrides,
  }
}

function exception(
  overrides: Partial<AvailabilityException>,
): AvailabilityException {
  return {
    id: 'e',
    clinic_id: 'c',
    doctor_id: DOCTOR,
    date: '2026-09-21',
    kind: 'off',
    start_time: null,
    end_time: null,
    created_at: '',
    ...overrides,
  }
}

// A Monday in Sep 2026 (2026-09-21 is a Monday).
const MON = '2026-09-21'
// Fixed "now" far in the past so nothing is filtered by lead time.
const PAST_NOW = new Date('2000-01-01T00:00:00Z')

function baseArgs(over: Partial<GenerateSlotsArgs> = {}): GenerateSlotsArgs {
  return {
    doctorId: DOCTOR,
    dateYmd: MON,
    clinicTimezone: TZ,
    defaultSlotMinutes: 30,
    now: PAST_NOW,
    ...over,
  }
}

describe('subtractWindow', () => {
  it('removes a middle range, splitting the window', () => {
    const out = subtractWindow([{ startMin: 540, endMin: 720 }], 600, 660)
    expect(out).toEqual([
      { startMin: 540, endMin: 600 },
      { startMin: 660, endMin: 720 },
    ])
  })

  it('keeps windows that do not overlap', () => {
    const out = subtractWindow([{ startMin: 540, endMin: 600 }], 700, 800)
    expect(out).toEqual([{ startMin: 540, endMin: 600 }])
  })

  it('fully removes a covered window', () => {
    const out = subtractWindow([{ startMin: 540, endMin: 600 }], 500, 700)
    expect(out).toEqual([])
  })
})

describe('overlaps (half-open)', () => {
  const a0 = new Date('2026-09-21T04:00:00Z')
  const a1 = new Date('2026-09-21T04:30:00Z')
  it('touching edges do not overlap', () => {
    const b0 = new Date('2026-09-21T04:30:00Z')
    const b1 = new Date('2026-09-21T05:00:00Z')
    expect(overlaps(a0, a1, b0, b1)).toBe(false)
  })
  it('real overlap is detected', () => {
    const b0 = new Date('2026-09-21T04:15:00Z')
    const b1 = new Date('2026-09-21T04:45:00Z')
    expect(overlaps(a0, a1, b0, b1)).toBe(true)
  })
})

describe('computeLocalWindows', () => {
  it('whole-day off returns nothing', () => {
    const out = computeLocalWindows(1, [rule({})], [exception({ kind: 'off' })], 30)
    expect(out).toEqual([])
  })

  it('subtracts a timed off range from a rule window', () => {
    const out = computeLocalWindows(
      1,
      [rule({ start_time: '09:00', end_time: '12:00' })],
      [exception({ kind: 'off', start_time: '10:00', end_time: '10:30' })],
      30,
    )
    expect(out).toEqual([
      { startMin: 540, endMin: 600, slotMinutes: 30 },
      { startMin: 630, endMin: 720, slotMinutes: 30 },
    ])
  })

  it('adds an extra window', () => {
    const out = computeLocalWindows(
      1,
      [rule({ start_time: '09:00', end_time: '10:00' })],
      [exception({ kind: 'extra', start_time: '17:00', end_time: '18:00' })],
      30,
    )
    expect(out).toContainEqual({ startMin: 1020, endMin: 1080, slotMinutes: 30 })
  })

  it('ignores rules for other weekdays', () => {
    const out = computeLocalWindows(2, [rule({ weekday: 1 })], [], 30)
    expect(out).toEqual([])
  })
})

describe('buildSlots', () => {
  it('chunks a 09:00-12:00 window into 30-min slots (6 slots)', () => {
    const slots = buildSlots(baseArgs(), [rule({})], [], [])
    expect(slots).toHaveLength(6)
    expect(slots[0].localLabel).toBe('9:00 AM')
    expect(slots[5].localLabel).toBe('11:30 AM')
  })

  it('a slot must fully fit — 09:00-10:00 with 45-min slots yields 1', () => {
    const slots = buildSlots(
      baseArgs({ defaultSlotMinutes: 45 }),
      [rule({ start_time: '09:00', end_time: '10:00' })],
      [],
      [],
    )
    expect(slots).toHaveLength(1)
    expect(slots[0].localLabel).toBe('9:00 AM')
  })

  it('subtracts a booked appointment', () => {
    // Book 10:00-10:30 local (Kolkata = UTC+5:30 -> 04:30-05:00 UTC).
    const bStart = localToUtc(MON, '10:00', TZ)
    const bEnd = localToUtc(MON, '10:30', TZ)
    const slots = buildSlots(baseArgs(), [rule({})], [], [
      { start: bStart, end: bEnd },
    ])
    expect(slots.map((s) => s.localLabel)).not.toContain('10:00 AM')
    // Neighbors remain.
    expect(slots.map((s) => s.localLabel)).toContain('9:30 AM')
    expect(slots.map((s) => s.localLabel)).toContain('10:30 AM')
  })

  it('filters slots before the lead-time cutoff', () => {
    // now = 09:45 local that day; lead 0 -> 9:00/9:30 dropped, 10:00+ kept.
    const now = localToUtc(MON, '09:45', TZ)
    const slots = buildSlots(baseArgs({ now }), [rule({})], [], [])
    const labels = slots.map((s) => s.localLabel)
    expect(labels).not.toContain('9:00 AM')
    expect(labels).not.toContain('9:30 AM')
    expect(labels).toContain('10:00 AM')
  })

  it('stores UTC that matches the clinic-local time', () => {
    const slots = buildSlots(baseArgs(), [rule({})], [], [])
    // 09:00 IST == 03:30 UTC.
    expect(slots[0].startsAtUtc).toBe('2026-09-21T03:30:00.000Z')
  })
})

describe('DST correctness (US spring-forward)', () => {
  const NY = 'America/New_York'
  // 2026-03-08 is US spring-forward: 02:00 -> 03:00 local (a Sunday).
  const DST_DAY = '2026-03-08'

  it('weekday is computed in the clinic timezone', () => {
    expect(weekdayInTimeZone(DST_DAY, NY)).toBe(0) // Sunday
  })

  it('09:00 local maps to the correct UTC instant on the DST day', () => {
    // After spring-forward, New York is UTC-4 (EDT), so 09:00 -> 13:00 UTC.
    const slots = buildSlots(
      {
        doctorId: DOCTOR,
        dateYmd: DST_DAY,
        clinicTimezone: NY,
        defaultSlotMinutes: 60,
        now: PAST_NOW,
      },
      [rule({ weekday: 0, start_time: '09:00', end_time: '11:00' })],
      [],
      [],
    )
    expect(slots[0].startsAtUtc).toBe('2026-03-08T13:00:00.000Z')
  })
})
