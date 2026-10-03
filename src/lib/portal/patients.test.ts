import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the portal patient lookup / inline create layer (T1/T2).
 *
 * The RLS cookie client is replaced with the in-memory fake used by the
 * other portal tests, extended with `ilike` (pattern translated honouring
 * the backslash escape, so the literal-'%' case is real) and with the
 * UNIQUE (clinic_id, wa_phone) constraint from migration 001 reported as
 * Postgres 23505.
 *
 * The fake has no RLS — only the filters the code passes — which is the
 * point: the cross-clinic cases prove this module's own explicit
 * `.eq('clinic_id', …)` scoping holds up with RLS taken away (R1/R5).
 */

type Row = Record<string, unknown>

let db: Record<string, Row[]>
let inserts: Array<{ table: string; values: Row }>
let updates: Array<{ table: string; values: Row }>
/** Every statement that reached the client, so "no query issued" is testable. */
let queries: Array<{ table: string; op: string }>
let patientSeq = 0

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}))

/** Translate a LIKE pattern into a regex, honouring '\' escapes. */
function likeToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[++i]
      if (next !== undefined) out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }
    if (ch === '%') out += '[\\s\\S]*'
    else if (ch === '_') out += '[\\s\\S]'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

/** Chainable fake supporting select/insert/update/eq/ilike/limit/maybeSingle. */
function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let max: number | null = null
  let op: 'select' | 'insert' | 'update' = 'select'
  let values: Row = {}
  let inserted: Row[] | null = null
  let insertError: { code?: string; message: string } | null = null

  const matched = (): Row[] =>
    (db[table] ?? []).filter((r) => filters.every((f) => f(r)))

  const run = (): Row[] => {
    const rows = matched()
    return max == null ? rows : rows.slice(0, max)
  }

  const result = (): { data: unknown; error: unknown } => {
    if (insertError) return { data: null, error: insertError }
    if (op === 'insert') return { data: inserted, error: null }
    if (op === 'update') {
      for (const row of matched()) Object.assign(row, values)
      updates.push({ table, values })
      return { data: null, error: null }
    }
    return { data: run(), error: null }
  }

  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val)
      return chain
    },
    ilike: (col: string, pattern: string) => {
      const re = likeToRegExp(pattern.toLowerCase())
      filters.push((r) => {
        const cell = r[col]
        return typeof cell === 'string' && re.test(cell.toLowerCase())
      })
      return chain
    },
    limit: (n: number) => {
      max = n
      return chain
    },
    update: (v: Row) => {
      op = 'update'
      values = v
      return chain
    },
    insert: (v: Row | Row[]) => {
      op = 'insert'
      const rows = Array.isArray(v) ? v : [v]
      values = rows[0]
      queries.push({ table, op: 'insert' })

      const clash =
        table === 'patients' &&
        rows.some((r) =>
          (db.patients ?? []).some(
            (e) => e.clinic_id === r.clinic_id && e.wa_phone === r.wa_phone,
          ),
        )

      if (clash) {
        insertError = {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "patients_clinic_id_wa_phone_key"',
        }
        return chain
      }

      const created = rows.map((r) => ({ id: `pat-new-${++patientSeq}`, ...r }))
      db[table] = [...(db[table] ?? []), ...created]
      inserted = created
      inserts.push({ table, values: rows[0] })
      return chain
    },
    maybeSingle: async () => {
      if (op === 'select') queries.push({ table, op: 'select' })
      const res = result()
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data
      return { data, error: res.error }
    },
    then: (
      resolve: (v: { data: unknown; error: unknown }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      try {
        if (op === 'select') queries.push({ table, op: 'select' })
        return Promise.resolve(result()).then(resolve)
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e)
      }
    },
  }
  return chain
}

import { searchPatients, getPatient, createOrReusePatient } from './patients'

const CLINIC_A = 'clinic-a'
const CLINIC_B = 'clinic-b'

beforeEach(() => {
  inserts = []
  updates = []
  queries = []
  patientSeq = 0
  db = {
    patients: [
      {
        id: 'pat-a1',
        clinic_id: CLINIC_A,
        full_name: 'Asha R',
        wa_phone: '+919000000001',
        date_of_birth: '1990-03-10',
        notes: 'regular',
      },
      {
        id: 'pat-a2',
        clinic_id: CLINIC_A,
        full_name: 'Bala 90000',
        wa_phone: '+919000000002',
        date_of_birth: null,
        notes: null,
      },
      {
        id: 'pat-a3',
        clinic_id: CLINIC_A,
        full_name: '100% Cotton Test',
        wa_phone: '+919000000003',
        date_of_birth: null,
        notes: null,
      },
      {
        id: 'pat-b1',
        clinic_id: CLINIC_B,
        full_name: 'Asha Other',
        wa_phone: '+919000000009',
        date_of_birth: null,
        notes: null,
      },
    ],
  }
})

describe('searchPatients', () => {
  it('matches a name fragment case-insensitively (R1)', async () => {
    const found = await searchPatients(CLINIC_A, 'ash')
    expect(found.map((p) => p.id)).toEqual(['pat-a1'])
    expect(found[0]).toEqual({
      id: 'pat-a1',
      fullName: 'Asha R',
      waPhone: '+919000000001',
      dateOfBirth: '1990-03-10',
    })
  })

  it('matches a phone fragment (R1)', async () => {
    const found = await searchPatients(CLINIC_A, '0000000 1')
    expect(found.map((p) => p.id)).toEqual(['pat-a1'])
  })

  it('matches a punctuated phone against the compact stored number', async () => {
    const found = await searchPatients(CLINIC_A, '+91 90000-00001')
    expect(found.map((p) => p.id)).toEqual(['pat-a1'])
  })

  it("never returns another clinic's matching patient (R1/R5)", async () => {
    const found = await searchPatients(CLINIC_A, 'asha')
    expect(found.map((p) => p.id)).toEqual(['pat-a1'])

    const other = await searchPatients(CLINIC_B, 'asha')
    expect(other.map((p) => p.id)).toEqual(['pat-b1'])
  })

  it('issues no query for a blank term', async () => {
    expect(await searchPatients(CLINIC_A, '')).toEqual([])
    expect(queries).toEqual([])
  })

  it('issues no query for a single character', async () => {
    expect(await searchPatients(CLINIC_A, 'a')).toEqual([])
    expect(queries).toEqual([])
  })

  it("treats a typed '%' as a literal, not a wildcard", async () => {
    const found = await searchPatients(CLINIC_A, '100%')
    expect(found.map((p) => p.id)).toEqual(['pat-a3'])
  })

  it('returns a patient matching both columns exactly once', async () => {
    // 'Bala 90000' matches on name, '+919000000002' matches on phone.
    const found = await searchPatients(CLINIC_A, '90000')
    expect(found.filter((p) => p.id === 'pat-a2')).toHaveLength(1)
  })

  it('respects the limit', async () => {
    // '91900' matches all three clinic-A patients on phone.
    expect(await searchPatients(CLINIC_A, '91900')).toHaveLength(3)
    expect(await searchPatients(CLINIC_A, '91900', 2)).toHaveLength(2)
  })
})

describe('getPatient', () => {
  it('returns the patient for its own clinic', async () => {
    const patient = await getPatient(CLINIC_A, 'pat-a1')
    expect(patient).toEqual({
      id: 'pat-a1',
      fullName: 'Asha R',
      waPhone: '+919000000001',
      dateOfBirth: '1990-03-10',
    })
  })

  it("returns null for another clinic's patient id (R5)", async () => {
    expect(await getPatient(CLINIC_A, 'pat-b1')).toBeNull()
  })

  it('returns null for an unknown id', async () => {
    expect(await getPatient(CLINIC_A, 'pat-nope')).toBeNull()
  })
})

describe('createOrReusePatient', () => {
  const input = {
    fullName: 'Chitra M',
    waPhone: '+919000000005',
    dateOfBirth: '1988-01-02',
    notes: 'walk-in',
  }

  it('inserts exactly one clinic-scoped row and reports reused: false', async () => {
    const result = await createOrReusePatient(CLINIC_A, input)

    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('patients')
    expect(inserts[0].values).toEqual({
      clinic_id: CLINIC_A,
      wa_phone: '+919000000005',
      full_name: 'Chitra M',
      date_of_birth: '1988-01-02',
      notes: 'walk-in',
    })
    expect(result.reused).toBe(false)
    expect(result.patient.waPhone).toBe('+919000000005')
  })

  it('reuses the existing row for a duplicate phone without overwriting it (R2)', async () => {
    const result = await createOrReusePatient(CLINIC_A, {
      fullName: 'Typo Name',
      waPhone: '+919000000001',
      dateOfBirth: null,
      notes: null,
    })

    expect(result.reused).toBe(true)
    expect(result.patient.id).toBe('pat-a1')
    expect(result.patient.fullName).toBe('Asha R')
    expect(updates).toEqual([])

    const stored = db.patients.find((p) => p.id === 'pat-a1')!
    expect(stored.full_name).toBe('Asha R')
    expect(stored.date_of_birth).toBe('1990-03-10')
    expect(stored.notes).toBe('regular')
    expect(db.patients.filter((p) => p.clinic_id === CLINIC_A)).toHaveLength(3)
  })

  it('still creates the patient when another clinic holds the same number', async () => {
    const result = await createOrReusePatient(CLINIC_A, {
      fullName: 'Same Number',
      waPhone: '+919000000009',
      dateOfBirth: null,
      notes: null,
    })
    expect(result.reused).toBe(false)
    expect(inserts).toHaveLength(1)
  })
})
