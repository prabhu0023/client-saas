import { describe, it, expect } from 'vitest'
import {
  validateE164,
  normalizeSearchTerm,
  escapeLikePattern,
  validateNewPatient,
} from './patient-validate'

/**
 * Pure-rule tests for the staff booking patient input (T1/T2). No
 * Supabase, no auth — that separation is why these rules live in their
 * own module.
 */

describe('validateE164', () => {
  it('accepts a full E.164 number', () => {
    expect(validateE164('+919876543210')).toEqual({
      ok: true,
      value: '+919876543210',
    })
  })

  it('rejects a number with no country prefix', () => {
    expect(validateE164('9876543210').ok).toBe(false)
  })

  it('rejects a zero country digit', () => {
    expect(validateE164('+0123456789').ok).toBe(false)
  })

  it('rejects internal spaces — wa_phone is stored compact', () => {
    expect(validateE164('+91 98765 43210').ok).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(validateE164('').ok).toBe(false)
  })

  it('rejects more than 15 digits', () => {
    expect(validateE164(`+9${'1'.repeat(19)}`).ok).toBe(false)
  })
})

describe('normalizeSearchTerm', () => {
  it('strips phone punctuation and a leading +', () => {
    expect(normalizeSearchTerm('+91 90000-00001')).toEqual({
      ok: true,
      value: '919000000001',
    })
  })

  it('leaves a name fragment alone', () => {
    expect(normalizeSearchTerm('  Asha  ')).toEqual({ ok: true, value: 'Asha' })
  })

  it('rejects an empty term', () => {
    expect(normalizeSearchTerm('').ok).toBe(false)
  })

  it('rejects a single character — no unbounded scan on one keystroke', () => {
    expect(normalizeSearchTerm('a').ok).toBe(false)
  })

  it('accepts two characters', () => {
    expect(normalizeSearchTerm('as')).toEqual({ ok: true, value: 'as' })
  })
})

describe('escapeLikePattern', () => {
  it('escapes the percent wildcard', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
  })

  it('escapes the single-character wildcard', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
  })

  it('escapes the backslash itself, and does it first', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })
})

describe('validateNewPatient', () => {
  it('rejects a blank name', () => {
    const result = validateNewPatient({
      fullName: '   ',
      waPhone: '+919876543210',
    })
    expect(result).toEqual({ ok: false, error: 'patient name is required' })
  })

  it('rejects a non-E.164 phone', () => {
    const result = validateNewPatient({ fullName: 'Asha R', waPhone: '98765' })
    expect(result.ok).toBe(false)
  })

  it('trims the name and returns null for a missing DOB and notes', () => {
    expect(
      validateNewPatient({ fullName: '  Asha R  ', waPhone: '+919876543210' }),
    ).toEqual({
      ok: true,
      value: {
        fullName: 'Asha R',
        waPhone: '+919876543210',
        dateOfBirth: null,
        notes: null,
      },
    })
  })

  it('treats a blank DOB and blank notes as absent', () => {
    const result = validateNewPatient({
      fullName: 'Asha R',
      waPhone: '+919876543210',
      dateOfBirth: '  ',
      notes: '   ',
    })
    expect(result).toEqual({
      ok: true,
      value: {
        fullName: 'Asha R',
        waPhone: '+919876543210',
        dateOfBirth: null,
        notes: null,
      },
    })
  })

  it('rejects a malformed DOB', () => {
    const result = validateNewPatient({
      fullName: 'Asha R',
      waPhone: '+919876543210',
      dateOfBirth: '10-03-1990',
    })
    expect(result.ok).toBe(false)
  })

  it('keeps a valid DOB and trimmed notes', () => {
    expect(
      validateNewPatient({
        fullName: 'Asha R',
        waPhone: '+919876543210',
        dateOfBirth: '1990-03-10',
        notes: '  walk-in  ',
      }),
    ).toEqual({
      ok: true,
      value: {
        fullName: 'Asha R',
        waPhone: '+919876543210',
        dateOfBirth: '1990-03-10',
        notes: 'walk-in',
      },
    })
  })

  it('rejects notes over 2000 characters', () => {
    const result = validateNewPatient({
      fullName: 'Asha R',
      waPhone: '+919876543210',
      notes: 'x'.repeat(2001),
    })
    expect(result.ok).toBe(false)
  })
})
