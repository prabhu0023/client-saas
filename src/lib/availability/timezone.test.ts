import { describe, it, expect } from 'vitest'
import { addDaysYmd } from './timezone'

describe('addDaysYmd', () => {
  it('steps forward and back within a month', () => {
    expect(addDaysYmd('2026-09-27', 1)).toBe('2026-09-28')
    expect(addDaysYmd('2026-09-27', -1)).toBe('2026-09-26')
  })

  it('crosses a month boundary', () => {
    expect(addDaysYmd('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDaysYmd('2026-10-01', -1)).toBe('2026-09-30')
  })

  it('crosses a year boundary', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysYmd('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('handles a leap day', () => {
    expect(addDaysYmd('2028-02-28', 1)).toBe('2028-02-29') // 2028 is a leap year
    expect(addDaysYmd('2028-02-29', 1)).toBe('2028-03-01')
  })

  it('is stable across DST transitions (anchored at UTC noon)', () => {
    // US spring-forward is 2026-03-08; stepping days must not skip/repeat.
    expect(addDaysYmd('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDaysYmd('2026-03-08', 1)).toBe('2026-03-09')
  })

  it('supports multi-day deltas', () => {
    expect(addDaysYmd('2026-09-27', 7)).toBe('2026-10-04')
    expect(addDaysYmd('2026-09-27', -7)).toBe('2026-09-20')
  })
})
