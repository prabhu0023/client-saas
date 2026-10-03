import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the member-management layer (ONB-2, design §13.1).
 *
 * The RLS client is faked and every operation is logged in order, because
 * the two load-bearing properties here are about calls that must NOT
 * happen:
 *
 *  - `removeDoctorProfile()` must resolve the PROFILE id from the member
 *    id, count appointments for that profile id, and issue NO `.delete()`
 *    at all when the count is non-zero. `appointments.doctor_id` is
 *    ON DELETE CASCADE, so a delete that slipped through would destroy
 *    that doctor's whole history silently (§9.4a).
 *  - `upsertDoctorProfile()` must never write `clinic_members.role` on any
 *    path. Being bookable is having the profile row, not having the role
 *    (FR-2.11) — and writing the role is exactly what makes a solo
 *    owner-admin clinic impossible, since the last-admin guard rejects it.
 *
 * The app-level count is only the friendly message; the guarantee is
 * `doctor_profiles_guard()`, whose `P0001 doctor_has_appointments` is fed
 * back from the mocked delete here and asserted to produce the SAME copy.
 */

type Row = Record<string, unknown>
type DbError = { code?: string; message: string }

let db: Record<string, Row[]>
/** Every operation, in order: `<mode>:<table>`. */
let log: string[]
let writes: Array<{ mode: string; table: string; payload: unknown; options?: unknown }>
let reads: Array<{ table: string; filters: Array<[string, unknown]> }>
let errors: Record<string, DbError[]>
let rpcResults: Record<string, { data: unknown; error: unknown }>

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args?: Row) => {
      log.push(`rpc:${fn}`)
      void args
      return rpcResults[fn] ?? { data: null, error: null }
    },
  }),
}))

function takeError(key: string): DbError | null {
  const queue = errors[key]
  if (!queue || queue.length === 0) return null
  return queue.shift() ?? null
}

function makeBuilder(table: string) {
  let mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let patch: Row = {}
  let payload: Row | null = null
  let options: unknown = null
  const filters: Array<[string, unknown]> = []
  let max: number | null = null
  let head = false

  function matching(): Row[] {
    return (db[table] ?? []).filter((r) => filters.every(([col, val]) => r[col] === val))
  }

  function run(): { data: unknown; error: unknown; count: number | null } {
    log.push(`${mode}:${table}`)
    const err = takeError(`${mode}:${table}`)
    if (err) return { data: null, error: err, count: null }

    if (mode === 'insert' || mode === 'upsert') {
      writes.push({ mode, table, payload, options })
      if (payload) db[table] = [...(db[table] ?? []), { ...payload }]
      return { data: payload ? [payload] : [], error: null, count: null }
    }
    if (mode === 'update') {
      const hit = matching()
      for (const row of hit) Object.assign(row, patch)
      writes.push({ mode, table, payload: patch })
      return { data: hit, error: null, count: hit.length }
    }
    if (mode === 'delete') {
      const hit = matching()
      db[table] = (db[table] ?? []).filter((r) => !hit.includes(r))
      writes.push({ mode, table, payload: null })
      return { data: hit, error: null, count: hit.length }
    }
    reads.push({ table, filters: [...filters] })
    const rows = matching()
    return {
      data: head ? null : max == null ? rows : rows.slice(0, max),
      error: null,
      count: rows.length,
    }
  }

  const chain = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) head = true
      return chain
    },
    insert: (value: Row) => {
      mode = 'insert'
      payload = value
      return chain
    },
    upsert: (value: Row, opts?: unknown) => {
      mode = 'upsert'
      payload = value
      options = opts ?? null
      return chain
    },
    update: (value: Row) => {
      mode = 'update'
      patch = value
      return chain
    },
    delete: () => {
      mode = 'delete'
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val])
      return chain
    },
    order: () => chain,
    limit: (n: number) => {
      max = n
      return chain
    },
    maybeSingle: async () => {
      const res = run()
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data
      return { data, error: res.error, count: res.count }
    },
    then: (resolve: (v: { data: unknown; error: unknown; count: number | null }) => unknown) =>
      Promise.resolve(run()).then(resolve),
  }
  return chain
}

import {
  listMembers,
  removeDoctorProfile,
  setMemberRole,
  setMemberStatus,
  upsertDoctorProfile,
} from './staff'

const CLINIC = 'clinic-a'
const HAS_APPOINTMENTS =
  'This doctor has appointments on record, so the profile cannot be removed. Disable the member instead.'

beforeEach(() => {
  db = {
    clinic_members: [
      {
        id: 'm-1',
        clinic_id: CLINIC,
        user_id: 'u-1',
        role: 'admin',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'm-2',
        clinic_id: CLINIC,
        user_id: 'u-2',
        role: 'nurse',
        status: 'active',
        created_at: '2025-02-01T00:00:00Z',
      },
    ],
    doctor_profiles: [],
    appointments: [],
  }
  log = []
  writes = []
  reads = []
  errors = {}
  rpcResults = {
    clinic_member_identities: {
      data: [
        { member_id: 'm-1', user_id: 'u-1', full_name: 'Dr Rao', email: 'rao@clinic.test' },
        { member_id: 'm-2', user_id: 'u-2', full_name: 'Nurse Ann', email: 'ann@clinic.test' },
      ],
      error: null,
    },
  }
})

function giveProfile(memberId: string, over: Row = {}) {
  db.doctor_profiles.push({
    id: `dp-${memberId}`,
    clinic_member_id: memberId,
    clinic_id: CLINIC,
    specialty: 'Cardiology',
    registration_number: 'REG-1',
    slot_duration_minutes: 15,
    ...over,
  })
}

describe('listMembers', () => {
  it('joins identities and doctor profiles onto every member', async () => {
    giveProfile('m-1')

    const members = await listMembers(CLINIC)

    expect(members).toHaveLength(2)
    expect(members[0]).toMatchObject({
      id: 'm-1',
      fullName: 'Dr Rao',
      email: 'rao@clinic.test',
      role: 'admin',
      status: 'active',
    })
    // The solo-clinic shape: an ADMIN holding the doctor profile.
    expect(members[0].doctorProfile).toEqual({
      id: 'dp-m-1',
      specialty: 'Cardiology',
      registrationNumber: 'REG-1',
      slotMinutes: 15,
    })
    expect(members[1].doctorProfile).toBeNull()
    expect(log).toContain('rpc:clinic_member_identities')
  })

  it('lists a member whose identity row is missing rather than dropping them', async () => {
    rpcResults.clinic_member_identities = { data: [], error: null }

    const members = await listMembers(CLINIC)

    expect(members).toHaveLength(2)
    expect(members[0].fullName).toBeNull()
    expect(members[0].email).toBeNull()
  })

  it('includes disabled members, so they can be re-enabled', async () => {
    db.clinic_members[1].status = 'disabled'

    const members = await listMembers(CLINIC)
    expect(members.map((m) => m.status)).toEqual(['active', 'disabled'])
  })
})

describe('setMemberRole / setMemberStatus', () => {
  it('writes the role and nothing else', async () => {
    expect(await setMemberRole(CLINIC, 'm-2', 'receptionist')).toEqual({ status: 'ok' })
    expect(writes).toEqual([
      { mode: 'update', table: 'clinic_members', payload: { role: 'receptionist' } },
    ])
    expect(db.clinic_members[1].role).toBe('receptionist')
  })

  it('disables and re-enables a member', async () => {
    expect(await setMemberStatus(CLINIC, 'm-2', 'disabled')).toEqual({ status: 'ok' })
    expect(db.clinic_members[1].status).toBe('disabled')

    expect(await setMemberStatus(CLINIC, 'm-2', 'active')).toEqual({ status: 'ok' })
    expect(db.clinic_members[1].status).toBe('active')
  })

  it("maps the trigger's last_active_admin to the admin-count copy", async () => {
    errors['update:clinic_members'] = [
      { code: 'P0001', message: 'last_active_admin' },
    ]

    expect(await setMemberStatus(CLINIC, 'm-1', 'disabled')).toEqual({
      status: 'refused',
      reason: 'last_active_admin',
      message: 'A clinic needs at least one active admin.',
    })
  })

  it("maps the trigger's doctor_role_locked to the remove-the-profile copy", async () => {
    errors['update:clinic_members'] = [
      { code: 'P0001', message: 'doctor_role_locked' },
    ]

    expect(await setMemberRole(CLINIC, 'm-1', 'nurse')).toEqual({
      status: 'refused',
      reason: 'doctor_role_locked',
      message: "Remove this member's doctor profile first, or disable the member.",
    })
  })

  it('reports not_found when RLS filtered the row away', async () => {
    expect((await setMemberRole(CLINIC, 'm-elsewhere', 'nurse')).status).toBe('not_found')
  })

  it('surfaces an unrelated DB failure as an error', async () => {
    errors['update:clinic_members'] = [{ code: '08006', message: 'connection lost' }]

    expect((await setMemberRole(CLINIC, 'm-2', 'nurse')).status).toBe('error')
  })
})

describe('upsertDoctorProfile', () => {
  const INPUT = { specialty: 'ENT', registrationNumber: 'REG-9', slotMinutes: 20 }

  it('is the single entry point for both create and edit, via ON CONFLICT', async () => {
    expect(await upsertDoctorProfile(CLINIC, 'm-2', INPUT)).toEqual({ status: 'ok' })

    const created = writes.filter((w) => w.table === 'doctor_profiles')
    expect(created).toHaveLength(1)
    expect(created[0].mode).toBe('upsert')
    expect(created[0].options).toEqual({ onConflict: 'clinic_member_id' })
    expect(created[0].payload).toEqual({
      clinic_member_id: 'm-2',
      clinic_id: CLINIC,
      specialty: 'ENT',
      registration_number: 'REG-9',
      slot_duration_minutes: 20,
    })

    // The edit case is the same call — there is no updateDoctorProfile().
    writes = []
    expect(
      await upsertDoctorProfile(CLINIC, 'm-2', { ...INPUT, slotMinutes: 30 }),
    ).toEqual({ status: 'ok' })
    const edited = writes.filter((w) => w.table === 'doctor_profiles')
    expect(edited).toHaveLength(1)
    expect(edited[0].mode).toBe('upsert')
  })

  it('never writes clinic_members.role — on any path (FR-2.11, §9.4a)', async () => {
    await upsertDoctorProfile(CLINIC, 'm-1', INPUT) // an admin
    await upsertDoctorProfile(CLINIC, 'm-2', INPUT) // a nurse
    await upsertDoctorProfile(CLINIC, 'm-gone', INPUT) // not a member

    errors['upsert:doctor_profiles'] = [{ code: '42501', message: 'denied' }]
    await upsertDoctorProfile(CLINIC, 'm-2', INPUT) // refused by RLS

    expect(writes.filter((w) => w.table === 'clinic_members')).toEqual([])
    expect(log.some((entry) => entry.startsWith('update:clinic_members'))).toBe(false)
    expect(db.clinic_members.map((m) => m.role)).toEqual(['admin', 'nurse'])
  })

  it('works on an active member of any role', async () => {
    expect((await upsertDoctorProfile(CLINIC, 'm-1', INPUT)).status).toBe('ok')
    expect((await upsertDoctorProfile(CLINIC, 'm-2', INPUT)).status).toBe('ok')
  })

  it('refuses a member who is not active, with no write', async () => {
    db.clinic_members[1].status = 'disabled'

    expect((await upsertDoctorProfile(CLINIC, 'm-2', INPUT)).status).toBe(
      'not_active_member',
    )
    expect(writes).toEqual([])
  })

  it("maps 42501 from 014's pinned-join check to not_in_clinic", async () => {
    errors['upsert:doctor_profiles'] = [{ code: '42501', message: 'new row violates' }]

    expect((await upsertDoctorProfile(CLINIC, 'm-2', INPUT)).status).toBe('not_in_clinic')
  })
})

describe('removeDoctorProfile', () => {
  it('resolves the profile id, counts appointments for THAT id, and deletes', async () => {
    giveProfile('m-2')

    expect(await removeDoctorProfile(CLINIC, 'm-2')).toEqual({ status: 'removed' })

    expect(log).toEqual([
      'select:doctor_profiles',
      'select:appointments',
      'delete:doctor_profiles',
    ])
    // The count keys on the PROFILE id, not the member id — counting on
    // the member id would match nothing and always allow the delete.
    const countRead = reads.find((r) => r.table === 'appointments')
    expect(countRead?.filters).toEqual([
      ['clinic_id', CLINIC],
      ['doctor_id', 'dp-m-2'],
    ])
    expect(db.doctor_profiles).toEqual([])
  })

  it('issues NO delete at all when the profile has appointments', async () => {
    giveProfile('m-2')
    db.appointments = [
      { id: 'a-1', clinic_id: CLINIC, doctor_id: 'dp-m-2' },
      { id: 'a-2', clinic_id: CLINIC, doctor_id: 'dp-m-2' },
    ]

    expect(await removeDoctorProfile(CLINIC, 'm-2')).toEqual({
      status: 'refused',
      message: HAS_APPOINTMENTS,
      appointments: 2,
    })

    expect(log).toEqual(['select:doctor_profiles', 'select:appointments'])
    expect(writes).toEqual([])
    expect(db.doctor_profiles).toHaveLength(1)
  })

  it('counts appointments of ANY date and status — a past one is enough', async () => {
    giveProfile('m-2')
    db.appointments = [
      {
        id: 'a-old',
        clinic_id: CLINIC,
        doctor_id: 'dp-m-2',
        status: 'completed',
        starts_at: '2020-01-01T00:00:00Z',
      },
    ]

    expect((await removeDoctorProfile(CLINIC, 'm-2')).status).toBe('refused')
  })

  it("ignores another doctor's appointments", async () => {
    giveProfile('m-2')
    db.appointments = [{ id: 'a-1', clinic_id: CLINIC, doctor_id: 'dp-other' }]

    expect((await removeDoctorProfile(CLINIC, 'm-2')).status).toBe('removed')
  })

  it('maps the guard\u2019s P0001 race backstop to the SAME refusal copy', async () => {
    giveProfile('m-2')
    errors['delete:doctor_profiles'] = [
      { code: 'P0001', message: 'doctor_has_appointments' },
    ]

    expect(await removeDoctorProfile(CLINIC, 'm-2')).toEqual({
      status: 'refused',
      message: HAS_APPOINTMENTS,
      appointments: null,
    })
    expect(db.doctor_profiles).toHaveLength(1)
  })

  it('reports not_found when the member has no profile, without counting', async () => {
    expect((await removeDoctorProfile(CLINIC, 'm-2')).status).toBe('not_found')
    expect(log).toEqual(['select:doctor_profiles'])
  })

  it('surfaces a failed count as an error and issues no delete', async () => {
    giveProfile('m-2')
    errors['select:appointments'] = [{ code: '08006', message: 'connection lost' }]

    expect((await removeDoctorProfile(CLINIC, 'm-2')).status).toBe('error')
    expect(log).toEqual(['select:doctor_profiles', 'select:appointments'])
    expect(db.doctor_profiles).toHaveLength(1)
  })
})
