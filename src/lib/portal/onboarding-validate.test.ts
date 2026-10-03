import { describe, it, expect } from 'vitest'
import {
  slugify,
  validateSlug,
  validateClinicName,
  isValidTimeZone,
  validateEmail,
  validatePassword,
  validateWacrmAccountId,
  validatePhoneNumberId,
  validateDisplayNumber,
  parsePriceToCents,
  validateServiceName,
  validateFullName,
} from './onboarding-validate'

/**
 * Pure-rule tests for onboarding input. No Supabase, no auth.
 *
 * The slug table below is the SAME table the integration suite asserts
 * against `create_clinic_with_owner`, so the TS and SQL validators cannot
 * drift apart without one of the two suites going red.
 */

describe('slugify', () => {
  it('drops punctuation instead of turning it into a separator', () => {
    expect(slugify("St. Mary's Clinic")).toBe('st-marys-clinic')
  })

  it('drops a curly apostrophe the same way', () => {
    expect(slugify('St. Mary\u2019s Clinic')).toBe('st-marys-clinic')
  })

  it('strips unicode punctuation such as an em dash', () => {
    expect(slugify('Sunrise \u2014 Main Branch')).toBe('sunrise-main-branch')
  })

  it('collapses runs of whitespace and hyphens into a single hyphen', () => {
    expect(slugify('Sunrise   --  Clinic')).toBe('sunrise-clinic')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugify('--Sunrise Clinic--')).toBe('sunrise-clinic')
  })

  it('keeps accented letters as their base letter', () => {
    expect(slugify('Cl\u00ednica Norte')).toBe('clinica-norte')
  })

  it('caps at 40 characters without leaving a trailing hyphen', () => {
    const result = slugify(`${'a'.repeat(39)} clinic`)
    expect(result).toBe('a'.repeat(39))
    expect(validateSlug(result)).toBeNull()
  })

  it('returns an empty string for a name with nothing slug-able in it', () => {
    expect(slugify('!!! ???')).toBe('')
  })

  it('produces a valid slug for an ordinary clinic name', () => {
    expect(validateSlug(slugify('Sunrise Family Clinic'))).toBeNull()
  })
})

describe('validateSlug — the canonical rule, identical in SQL', () => {
  const cases: Array<[string, ReturnType<typeof validateSlug>]> = [
    ['ab', 'length'],
    ['a'.repeat(41), 'length'],
    ['-abc', 'charset'],
    ['abc-', 'charset'],
    ['a--b', 'double-hyphen'],
    ['Abc', 'charset'],
    ['ab-1', null],
  ]

  for (const [slug, expected] of cases) {
    it(`${JSON.stringify(slug.length > 12 ? `${slug.slice(0, 9)}…` : slug)} → ${expected}`, () => {
      expect(validateSlug(slug)).toBe(expected)
    })
  }

  it('accepts the shortest and longest allowed slugs', () => {
    expect(validateSlug('abc')).toBeNull()
    expect(validateSlug('a'.repeat(40))).toBeNull()
  })

  it('rejects an underscore and a space', () => {
    expect(validateSlug('a_b')).toBe('charset')
    expect(validateSlug('a b')).toBe('charset')
  })
})

describe('validateClinicName', () => {
  it('trims', () => {
    expect(validateClinicName('  Sunrise Clinic  ')).toEqual({
      ok: true,
      value: 'Sunrise Clinic',
    })
  })

  it('rejects blank and over-120', () => {
    expect(validateClinicName('   ').ok).toBe(false)
    expect(validateClinicName('x'.repeat(121)).ok).toBe(false)
    expect(validateClinicName('x'.repeat(120)).ok).toBe(true)
  })
})

describe('isValidTimeZone', () => {
  it('accepts Asia/Kolkata — the name the product actually uses', () => {
    // V8 canonicalizes per CLDR, so supportedValuesOf() carries
    // 'Asia/Calcutta' and NOT 'Asia/Kolkata'. A literal membership test
    // would reject the timezone every clinic in the target market picks,
    // while pg_timezone_names accepts it. This is the regression guard.
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
  })

  it('accepts the CLDR-canonical spelling too', () => {
    expect(isValidTimeZone('Asia/Calcutta')).toBe(true)
  })

  it('accepts other ordinary IANA zones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('Australia/Sydney')).toBe(true)
  })

  it('accepts every entry the onboarding <select> will be built from', () => {
    for (const tz of Intl.supportedValuesOf('timeZone')) {
      expect(isValidTimeZone(tz)).toBe(true)
    }
  })

  it('rejects a made-up zone', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidTimeZone('')).toBe(false)
  })

  it('rejects the non-IANA forms a bare AT TIME ZONE test would accept', () => {
    // pg_timezone_names does not carry these either, which is why the RPC
    // uses the catalogue rather than casting.
    expect(isValidTimeZone('UTC+5')).toBe(false)
    expect(isValidTimeZone('GMT+5:30')).toBe(false)
    expect(isValidTimeZone('+05:30')).toBe(false)
  })

  it('rejects the bare abbreviations ICU would otherwise resolve', () => {
    // 'EST' resolves to America/Panama and 'EST5EDT' to America/New_York,
    // so the shape check has to run before the canonicalizer.
    expect(isValidTimeZone('EST')).toBe(false)
    expect(isValidTimeZone('EST5EDT')).toBe(false)
    expect(isValidTimeZone('MST')).toBe(false)
  })

  it('rejects a lower-cased zone, because the SQL lookup is case-sensitive', () => {
    expect(isValidTimeZone('asia/kolkata')).toBe(false)
  })

  it('rejects a POSIX-style name', () => {
    expect(isValidTimeZone('posix/Asia/Calcutta')).toBe(false)
    expect(isValidTimeZone('localtime')).toBe(false)
  })
})

describe('validateEmail', () => {
  it('trims and lower-cases', () => {
    expect(validateEmail('  Admin@Clinic.COM ')).toEqual({
      ok: true,
      value: 'admin@clinic.com',
    })
  })

  it('rejects a missing @, a missing dot and a one-char tld', () => {
    expect(validateEmail('adminclinic.com').ok).toBe(false)
    expect(validateEmail('admin@clinic').ok).toBe(false)
    expect(validateEmail('admin@clinic.c').ok).toBe(false)
  })

  it('rejects internal whitespace and a blank value', () => {
    expect(validateEmail('ad min@clinic.com').ok).toBe(false)
    expect(validateEmail('   ').ok).toBe(false)
  })

  it('rejects over 254 characters', () => {
    expect(validateEmail(`${'a'.repeat(250)}@c.com`).ok).toBe(false)
  })
})

describe('validatePassword', () => {
  it('accepts 8 characters', () => {
    expect(validatePassword('abcd1234')).toEqual({ ok: true, value: 'abcd1234' })
  })

  it('rejects 7 characters', () => {
    expect(validatePassword('abcd123').ok).toBe(false)
  })

  it('accepts exactly 72 and rejects 73 — the bcrypt ceiling', () => {
    expect(validatePassword('x'.repeat(72)).ok).toBe(true)
    expect(validatePassword('x'.repeat(73)).ok).toBe(false)
  })

  it('does not trim — spaces are legitimate password characters', () => {
    expect(validatePassword('  pass  ok  ')).toEqual({
      ok: true,
      value: '  pass  ok  ',
    })
  })
})

describe('validateWacrmAccountId', () => {
  it('trims and accepts the documented charset', () => {
    expect(validateWacrmAccountId(' acct_1.2:3-4 ')).toEqual({
      ok: true,
      value: 'acct_1.2:3-4',
    })
  })

  it('rejects blank, a space inside, and over 128 characters', () => {
    expect(validateWacrmAccountId('  ').ok).toBe(false)
    expect(validateWacrmAccountId('acct 1').ok).toBe(false)
    expect(validateWacrmAccountId('a'.repeat(129)).ok).toBe(false)
    expect(validateWacrmAccountId('a'.repeat(128)).ok).toBe(true)
  })
})

describe('validatePhoneNumberId', () => {
  it('treats blank as absent', () => {
    expect(validatePhoneNumberId('   ')).toEqual({ ok: true, value: null })
  })

  it('accepts digits only', () => {
    expect(validatePhoneNumberId(' 123456789012345 ')).toEqual({
      ok: true,
      value: '123456789012345',
    })
  })

  it('rejects a + prefix and over 64 digits', () => {
    expect(validatePhoneNumberId('+123456').ok).toBe(false)
    expect(validatePhoneNumberId('1'.repeat(65)).ok).toBe(false)
  })
})

describe('validateDisplayNumber', () => {
  it('treats blank as absent', () => {
    expect(validateDisplayNumber('')).toEqual({ ok: true, value: null })
  })

  it('accepts the punctuation people put in phone numbers', () => {
    expect(validateDisplayNumber(' +91 (080) 4000-1234 ')).toEqual({
      ok: true,
      value: '+91 (080) 4000-1234',
    })
  })

  it('REJECTS over 32 characters rather than truncating', () => {
    const long = `+${'1'.repeat(40)}`
    const result = validateDisplayNumber(long)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('1'.repeat(32))
  })

  it('rejects letters', () => {
    expect(validateDisplayNumber('+91 call-me').ok).toBe(false)
  })
})

describe('parsePriceToCents', () => {
  it('converts whole and fractional major units', () => {
    expect(parsePriceToCents('450')).toEqual({ ok: true, value: 45000 })
    expect(parsePriceToCents('450.5')).toEqual({ ok: true, value: 45050 })
    expect(parsePriceToCents('450.50')).toEqual({ ok: true, value: 45050 })
    expect(parsePriceToCents('0')).toEqual({ ok: true, value: 0 })
  })

  it('accepts the largest value the column contract allows', () => {
    expect(parsePriceToCents('999999.99')).toEqual({ ok: true, value: 99_999_999 })
  })

  it('rejects three decimals', () => {
    expect(parsePriceToCents('450.555').ok).toBe(false)
  })

  it('rejects seven integer digits', () => {
    expect(parsePriceToCents('9999999').ok).toBe(false)
  })

  it('rejects a negative, a blank value and non-numeric text', () => {
    expect(parsePriceToCents('-1').ok).toBe(false)
    expect(parsePriceToCents('').ok).toBe(false)
    expect(parsePriceToCents('   ').ok).toBe(false)
    expect(parsePriceToCents('450rs').ok).toBe(false)
    expect(parsePriceToCents('4,50').ok).toBe(false)
  })

  it('never leaks float drift into the cents value', () => {
    expect(parsePriceToCents('0.07')).toEqual({ ok: true, value: 7 })
    expect(parsePriceToCents('1.15')).toEqual({ ok: true, value: 115 })
  })
})

describe('validateServiceName', () => {
  it('trims and enforces 1–120', () => {
    expect(validateServiceName('  Consultation ')).toEqual({
      ok: true,
      value: 'Consultation',
    })
    expect(validateServiceName(' ').ok).toBe(false)
    expect(validateServiceName('x'.repeat(121)).ok).toBe(false)
  })
})

describe('validateFullName', () => {
  it('trims and enforces 1–120', () => {
    expect(validateFullName('  Dr. Asha Rao ')).toEqual({
      ok: true,
      value: 'Dr. Asha Rao',
    })
    expect(validateFullName('   ').ok).toBe(false)
    expect(validateFullName('x'.repeat(121)).ok).toBe(false)
    expect(validateFullName('x'.repeat(120)).ok).toBe(true)
  })
})
