import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Slot } from '@/types'

/**
 * Tests for the staff booking actions (T4/T5).
 *
 * requireStaff, the RLS client, generateSlots, bookAppointment and
 * revalidatePath are mocked; the read layers (src/lib/portal/patients.ts
 * and new-appointment.ts) are NOT, so these exercise the real resolve →
 * regenerate-slots → book path, including the clinic_id scoping that is
 * the tenancy gate for a forged ?patient= or ?doctor= value (R5).
 *
 * bookAppointment is mocked at the module boundary because what matters
 * is the exact argument object it receives: created_via 'portal' and the
 * MATCHED SLOT'S instants are the R4 contract, and a submitted time that
 * isn't in the generated list must never reach it at all.
 *
 * As in the other portal tests the fake client has no RLS, so the
 * cross-clinic cases prove the actions' own scoping, not the database's.
 */

type Row = Record<string, unknown>

let db: Record<string, Row[]>
let inserts: Array<{ table: string; values: Row }>
let patientSeq = 0

const generateSlotsMock = vi.fn()
vi.mock('@/lib/availability/slot-generation', () => ({
  generateSlots: (...a: unknown[]) => generateSlotsMock(...a),
}))

const bookAppointmentMock = vi.fn()
vi.mock('@/lib/booking/book', () => ({
  bookAppointment: (...a: unknown[]) => bookAppointmentMock(...a),
}))

const revalidatePathMock = vi.fn()
vi.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}))

let staffClinicId = 'clinic-a'
vi.mock('@/lib/portal/auth', () => ({
  requireStaff: async () => ({
    userId: 'user-staff',
    email: 'staff@clinic.test',
    member: { id: 'mem-1', clinic_id: staffClinicId, role: 'receptionist' },
    clinic: {
      id: staffClinicId,
      name: 'Clinic A',
      timezone: 'Asia/Kolkata',
    },
  }),
}))

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

/**
 * Chainable fake supporting select/insert/eq/ilike/limit/maybeSingle,
 * with the UNIQUE (clinic_id, wa_phone) constraint from migration 001
 * reported as Postgres 23505.
 */
function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let max: number | null = null
  let op: 'select' | 'insert' = 'select'
  let inserted: Row[] | null = null
  let insertError: { code?: string; message: string } | null = null

  const matched = (): Row[] =>
    (db[table] ?? []).filter((r) => filters.every((f) => f(r)))

  const result = (): { data: unknown; error: unknown } => {
    if (insertError) return { data: null, error: insertError }
    if (op === 'insert') return { data: inserted, error: null }
    const rows = matched()
    return { data: max == null ? rows : rows.slice(0, max), error: null }
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
    insert: (v: Row | Row[]) => {
      op = 'insert'
      const rows = Array.isArray(v) ? v : [v]

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
      const res = result()
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data
      return { data, error: res.error }
    },
    then: (
      resolve: (v: { data: unknown; error: unknown }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      try {
        return Promise.resolve(result()).then(resolve)
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e)
      }
    },
  }
  return chain
}

import { searchPatientsAction, addPatient, createAppointment } from './actions'

const CLINIC_A = 'clinic-a'
const CLINIC_B = 'clinic-b'
const DATE = '2099-03-10'

const SLOTS: Slot[] = [
  {
    doctorId: 'doc-a1',
    startsAtUtc: '2099-03-10T04:30:00.000Z',
    endsAtUtc: '2099-03-10T04:50:00.000Z',
    localLabel: '10:00 AM',
    hhmm: '1000',
  },
  {
    doctorId: 'doc-a1',
    startsAtUtc: '2099-03-10T04:50:00.000Z',
    endsAtUtc: '2099-03-10T05:10:00.000Z',
    localLabel: '10:20 AM',
    hhmm: '1020',
  },
]

function form(entries: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

/** A complete, valid create submit; override one field per case. */
function createForm(overrides: Record<string, string> = {}): FormData {
  return form({
    patientId: 'pat-a1',
    doctorId: 'doc-a1',
    date: DATE,
    hhmm: '1020',
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  staffClinicId = CLINIC_A
  inserts = []
  patientSeq = 0
  generateSlotsMock.mockResolvedValue(SLOTS)
  bookAppointmentMock.mockResolvedValue({
    status: 'booked',
    appointmentId: 'appt-new',
    patientId: 'pat-a1',
  })
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
        id: 'pat-b1',
        clinic_id: CLINIC_B,
        full_name: 'Asha Other',
        wa_phone: '+919000000009',
        date_of_birth: null,
        notes: null,
      },
    ],
    // 'clinic_members.status' is seeded flat because the fake matches
    // .eq() keys literally; it stands in for the inner join that
    // getDoctorSlotMinutes and listClinicDoctors both apply.
    doctor_profiles: [
      {
        id: 'doc-a1',
        clinic_id: CLINIC_A,
        slot_duration_minutes: 20,
        'clinic_members.status': 'active',
      },
      {
        id: 'doc-a2',
        clinic_id: CLINIC_A,
        slot_duration_minutes: 20,
        'clinic_members.status': 'inactive',
      },
      {
        id: 'doc-b1',
        clinic_id: CLINIC_B,
        slot_duration_minutes: 30,
        'clinic_members.status': 'active',
      },
    ],
  }
})

describe('createAppointment — happy path', () => {
  it("books once with created_via 'portal' and the matched slot's instants (R4)", async () => {
    const state = await createAppointment(createForm())

    expect(state).toEqual({
      error: null,
      slotTaken: false,
      appointmentId: 'appt-new',
    })
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1)
    expect(bookAppointmentMock.mock.calls[0][0]).toEqual({
      clinicId: CLINIC_A,
      doctorId: 'doc-a1',
      waPhone: '+919000000001',
      startsAtUtc: '2099-03-10T04:50:00.000Z',
      endsAtUtc: '2099-03-10T05:10:00.000Z',
      serviceId: null,
      patientName: 'Asha R',
      createdVia: 'portal',
    })
  })

  it('revalidates the dashboard path, and only that (R6)', async () => {
    await createAppointment(createForm())
    // Search params are not part of the path cache key, so a
    // '/dashboard?date=…' call would revalidate nothing.
    expect(revalidatePathMock.mock.calls).toEqual([['/dashboard']])
  })
})

describe('createAppointment — slot no longer available', () => {
  it('returns the retry state on slot_taken rather than throwing (R4)', async () => {
    bookAppointmentMock.mockResolvedValue({ status: 'slot_taken' })

    const state = await createAppointment(createForm())

    expect(state.slotTaken).toBe(true)
    expect(state.error).toMatch(/no longer available/)
    expect(state.appointmentId).toBeNull()
    // Nothing was created, so nothing is stale.
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it('refuses a time that is not in the generated list, without booking', async () => {
    const state = await createAppointment(createForm({ hhmm: '2300' }))

    expect(state.slotTaken).toBe(true)
    expect(state.error).toMatch(/no longer available/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses every time when the day has no slots at all', async () => {
    generateSlotsMock.mockResolvedValue([])
    const state = await createAppointment(createForm())
    expect(state.slotTaken).toBe(true)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })
})

describe('createAppointment — tenancy', () => {
  it("refuses another clinic's patient id without booking (R5)", async () => {
    const state = await createAppointment(createForm({ patientId: 'pat-b1' }))

    expect(state.error).toMatch(/patient not found/)
    expect(state.appointmentId).toBeNull()
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it("refuses another clinic's doctor id without booking (R5)", async () => {
    const state = await createAppointment(createForm({ doctorId: 'doc-b1' }))

    expect(state.error).not.toBeNull()
    expect(state.appointmentId).toBeNull()
    // No slot length is readable for that doctor, so no slots are even
    // generated — the forged id can't reach the write path.
    expect(generateSlotsMock).not.toHaveBeenCalled()
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses a doctor whose clinic membership is not active, without booking', async () => {
    const state = await createAppointment(createForm({ doctorId: 'doc-a2' }))

    expect(state.error).not.toBeNull()
    expect(state.appointmentId).toBeNull()
    // The picker never offers them, so the submit gate must agree.
    expect(generateSlotsMock).not.toHaveBeenCalled()
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses an unknown patient id', async () => {
    const state = await createAppointment(createForm({ patientId: 'pat-nope' }))
    expect(state.error).toMatch(/patient not found/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })
})

describe('createAppointment — rejected input', () => {
  it('refuses a blank patient id', async () => {
    const state = await createAppointment(createForm({ patientId: '' }))
    expect(state.error).toMatch(/select a patient/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses a blank doctor id', async () => {
    const state = await createAppointment(createForm({ doctorId: '' }))
    expect(state.error).toMatch(/select a doctor/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses a blank date', async () => {
    const state = await createAppointment(createForm({ date: '' }))
    expect(state.error).toMatch(/valid day/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses a malformed date', async () => {
    const state = await createAppointment(createForm({ date: '10-03-2099' }))
    expect(state.error).toMatch(/valid day/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('refuses a blank time', async () => {
    const state = await createAppointment(createForm({ hhmm: '' }))
    expect(state.error).toMatch(/pick a time/)
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })
})

describe('createAppointment — booking rejected downstream', () => {
  it('surfaces an invalid result as an inline error', async () => {
    bookAppointmentMock.mockResolvedValue({
      status: 'invalid',
      reason: 'doctor does not belong to clinic',
    })
    const state = await createAppointment(createForm())
    expect(state).toEqual({
      error: 'doctor does not belong to clinic',
      slotTaken: false,
      appointmentId: null,
    })
  })

  it('surfaces an error result as an inline error', async () => {
    bookAppointmentMock.mockResolvedValue({
      status: 'error',
      message: 'db down',
    })
    const state = await createAppointment(createForm())
    expect(state.error).toBe('db down')
    expect(state.slotTaken).toBe(false)
  })
})

describe('addPatient', () => {
  it('creates the patient and returns it for booking', async () => {
    const state = await addPatient(
      form({
        fullName: '  Chitra M  ',
        waPhone: '+919000000005',
        dateOfBirth: '1988-01-02',
        notes: 'walk-in',
      }),
    )

    expect(state.error).toBeNull()
    expect(state.reused).toBe(false)
    expect(state.patient?.fullName).toBe('Chitra M')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].values).toEqual({
      clinic_id: CLINIC_A,
      wa_phone: '+919000000005',
      full_name: 'Chitra M',
      date_of_birth: '1988-01-02',
      notes: 'walk-in',
    })
  })

  it('returns the validation error for a non-E.164 phone and inserts nothing', async () => {
    const state = await addPatient(
      form({ fullName: 'Chitra M', waPhone: '9000000005' }),
    )

    expect(state.error).toMatch(/E\.164/)
    expect(state.patient).toBeNull()
    expect(inserts).toEqual([])
  })

  it('returns the validation error for a blank name', async () => {
    const state = await addPatient(
      form({ fullName: '   ', waPhone: '+919000000005' }),
    )
    expect(state.error).toMatch(/name is required/)
    expect(inserts).toEqual([])
  })

  it('reuses the existing patient for a duplicate number (R2)', async () => {
    const state = await addPatient(
      form({ fullName: 'Typo Name', waPhone: '+919000000001' }),
    )

    expect(state.error).toBeNull()
    expect(state.reused).toBe(true)
    expect(state.patient?.id).toBe('pat-a1')
    // The curated name survives — nothing was overwritten.
    expect(state.patient?.fullName).toBe('Asha R')
    expect(db.patients.filter((p) => p.clinic_id === CLINIC_A)).toHaveLength(1)
  })
})

describe('searchPatientsAction', () => {
  it("returns only the caller clinic's matches (R1/R5)", async () => {
    const found = await searchPatientsAction('asha')
    expect(found.map((p) => p.id)).toEqual(['pat-a1'])
  })

  it('returns [] for a term that is too short to query on', async () => {
    expect(await searchPatientsAction('a')).toEqual([])
  })
})
