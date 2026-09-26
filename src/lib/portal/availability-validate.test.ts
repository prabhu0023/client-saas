import { describe, it, expect } from 'vitest'
import { validateRule, validateException, toMinutes } from './availability-validate'

describe('toMinutes', () => {
  it('parses HH:mm', () => {
    expect(toMinutes('09:30')).toBe(570)
    expect(toMinutes('00:00')).toBe(0)
    expect(toMinutes('23:59')).toBe(1439)
  })
  it('rejects malformed / out-of-range', () => {
    expect(toMinutes('9:30')).toBeNull()
    expect(toMinutes('24:00')).toBeNull()
    expect(toMinutes('12:60')).toBeNull()
    expect(toMinutes('noon')).toBeNull()
  })
})

describe('validateRule', () => {
  const base = { weekday: 1, startTime: '09:00', endTime: '13:00', slotMinutes: '' }

  it('accepts a valid rule with no slot override', () => {
    const r = validateRule(base)
    expect(r).toEqual({
      ok: true,
      value: { weekday: 1, startTime: '09:00', endTime: '13:00', slotMinutes: null },
    })
  })

  it('accepts a positive slot override', () => {
    const r = validateRule({ ...base, slotMinutes: '20' })
    expect(r.ok && r.value.slotMinutes).toBe(20)
  })

  it('rejects weekday out of range', () => {
    expect(validateRule({ ...base, weekday: 7 }).ok).toBe(false)
    expect(validateRule({ ...base, weekday: -1 }).ok).toBe(false)
  })

  it('rejects end <= start', () => {
    expect(validateRule({ ...base, endTime: '09:00' }).ok).toBe(false)
    expect(validateRule({ ...base, startTime: '13:00', endTime: '09:00' }).ok).toBe(false)
  })

  it('rejects malformed times', () => {
    expect(validateRule({ ...base, startTime: '9am' }).ok).toBe(false)
  })

  it('rejects non-positive / non-integer slot minutes', () => {
    expect(validateRule({ ...base, slotMinutes: '0' }).ok).toBe(false)
    expect(validateRule({ ...base, slotMinutes: '-5' }).ok).toBe(false)
    expect(validateRule({ ...base, slotMinutes: '15.5' }).ok).toBe(false)
  })
})

describe('validateException', () => {
  const off = { date: '2026-10-01', kind: 'off', startTime: '', endTime: '' }

  it('accepts a whole-day off (no times)', () => {
    const r = validateException(off)
    expect(r).toEqual({
      ok: true,
      value: { date: '2026-10-01', kind: 'off', startTime: null, endTime: null },
    })
  })

  it('accepts a ranged off', () => {
    const r = validateException({ ...off, startTime: '12:00', endTime: '14:00' })
    expect(r.ok && r.value.startTime).toBe('12:00')
  })

  it('accepts extra hours with a range', () => {
    const r = validateException({ date: '2026-10-01', kind: 'extra', startTime: '18:00', endTime: '20:00' })
    expect(r.ok && r.value.kind).toBe('extra')
  })

  it('rejects extra with no times (whole-day extra is meaningless)', () => {
    const r = validateException({ date: '2026-10-01', kind: 'extra', startTime: '', endTime: '' })
    expect(r.ok).toBe(false)
  })

  it('rejects a half-open range (one time only)', () => {
    expect(validateException({ ...off, startTime: '12:00', endTime: '' }).ok).toBe(false)
    expect(validateException({ ...off, startTime: '', endTime: '14:00' }).ok).toBe(false)
  })

  it('rejects end <= start', () => {
    expect(
      validateException({ ...off, startTime: '14:00', endTime: '12:00' }).ok,
    ).toBe(false)
  })

  it('rejects a bad date or kind', () => {
    expect(validateException({ ...off, date: '10/01/2026' }).ok).toBe(false)
    expect(validateException({ ...off, kind: 'holiday' }).ok).toBe(false)
  })
})
