import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the services layer (ONB-3, design §13.1).
 *
 * The RLS client is faked and every operation is logged in order, because
 * the load-bearing properties here are about calls that must NOT happen:
 *
 *  - NO code path may `.delete()` a `services` row. `appointments.service_id`
 *    is ON DELETE SET NULL (001), so a delete would silently rewrite what
 *    past appointments were for — deactivation is the only removal (FR-3.3).
 *  - the doctor mapping must be replaced by `set_doctor_services` (014) and
 *    never by a client-side delete-then-insert pair on `doctor_services`,
 *    which could leave the screen showing a half-applied mapping (FR-3.4).
 *
 * Prices are the other half: they must reach the column as integer cents
 * produced by `parsePriceToCents`, with '450.555' refused rather than
 * rounded into money nobody typed.
 */

type Row = Record<string, unknown>
type DbError = { code?: string; message: string }

let db: Record<string, Row[]>
/** Every operation, in order: `<mode>:<table>`. */
let log: string[]
let writes: Array<{ mode: string; table: string; payload: unknown }>
let errors: Record<string, DbError[]>
let rpcResults: Record<string, { data: unknown; error: unknown }>
let rpcCalls: Array<{ fn: string; args: Row | undefined }>

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args?: Row) => {
      log.push(`rpc:${fn}`)
      rpcCalls.push({ fn, args })
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
  const filters: Array<[string, unknown]> = []

  function matching(): Row[] {
    return (db[table] ?? []).filter((r) => filters.every(([col, val]) => r[col] === val))
  }

  function run(): { data: unknown; error: unknown; count: number | null } {
    log.push(`${mode}:${table}`)
    const err = takeError(`${mode}:${table}`)
    if (err) return { data: null, error: err, count: null }

    if (mode === 'insert' || mode === 'upsert') {
      writes.push({ mode, table, payload })
      const stored = { id: `${table}-${(db[table] ?? []).length + 1}`, ...payload }
      db[table] = [...(db[table] ?? []), stored]
      return { data: [stored], error: null, count: null }
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
    const rows = matching()
    return { data: rows, error: null, count: rows.length }
  }

  const chain = {
    select: () => chain,
    insert: (value: Row) => {
      mode = 'insert'
      payload = value
      return chain
    },
    upsert: (value: Row) => {
      mode = 'upsert'
      payload = value
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
    limit: () => chain,
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
  createService,
  listServices,
  setServiceActive,
  setServiceDoctors,
  updateService,
} from './services'

const CLINIC = 'clinic-a'

beforeEach(() => {
  db = {
    services: [
      {
        id: 's-1',
        clinic_id: CLINIC,
        name: 'Consultation',
        price_cents: 45000,
        active: true,
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 's-2',
        clinic_id: CLINIC,
        name: 'Scaling',
        price_cents: 120000,
        active: false,
        created_at: '2025-02-01T00:00:00Z',
      },
    ],
    doctor_services: [
      { id: 'ds-1', clinic_id: CLINIC, doctor_id: 'dp-1', service_id: 's-1' },
    ],
    doctor_profiles: [
      { id: 'dp-1', clinic_id: CLINIC, specialty: 'Cardiology' },
      { id: 'dp-2', clinic_id: CLINIC, specialty: null },
    ],
  }
  log = []
  writes = []
  errors = {}
  rpcCalls = []
  rpcResults = {
    clinic_doctor_names: {
      data: [{ doctor_id: 'dp-1', full_name: 'Dr Rao' }],
      error: null,
    },
    set_doctor_services: { data: [{ outcome: 'ok', linked: 2 }], error: null },
  }
})

describe('listServices', () => {
  it('returns price, active flag and the doctors offering each service', async () => {
    const services = await listServices(CLINIC)

    expect(services).toHaveLength(2)
    expect(services[0]).toMatchObject({
      id: 's-1',
      name: 'Consultation',
      priceCents: 45000,
      active: true,
    })
    // Labelled exactly like listClinicDoctors: name + specialty when both known.
    expect(services[0].doctors).toEqual([{ id: 'dp-1', label: 'Dr Rao (Cardiology)' }])
    expect(services[1].doctors).toEqual([])
  })

  it('lists inactive services too — deactivation is not a delete', async () => {
    const services = await listServices(CLINIC)
    expect(services.map((s) => s.active)).toEqual([true, false])
  })

  it('falls back to specialty, then a short id, when no name is readable', async () => {
    db.doctor_services.push({
      id: 'ds-2',
      clinic_id: CLINIC,
      doctor_id: 'dp-2',
      service_id: 's-2',
    })
    rpcResults.clinic_doctor_names = { data: [], error: null }

    const services = await listServices(CLINIC)

    expect(services[0].doctors).toEqual([{ id: 'dp-1', label: 'Cardiology' }])
    expect(services[1].doctors).toEqual([{ id: 'dp-2', label: 'Doctor dp-2' }])
  })

  it('throws when a read fails, matching the availability readers', async () => {
    errors['select:services'] = [{ message: 'boom' }]
    await expect(listServices(CLINIC)).rejects.toThrow(/services fetch: boom/)
  })
})

describe('createService', () => {
  it('stores integer cents from a major-unit string', async () => {
    const result = await createService(CLINIC, { name: '  X-ray  ', price: '450.50' })

    expect(result).toMatchObject({ status: 'ok' })
    expect(writes).toEqual([
      {
        mode: 'insert',
        table: 'services',
        payload: {
          clinic_id: CLINIC,
          name: 'X-ray',
          price_cents: 45050,
          active: true,
        },
      },
    ])
  })

  it('stores whole units as a round number of cents', async () => {
    await createService(CLINIC, { name: 'Consult', price: '450' })
    expect(writes[0].payload).toMatchObject({ price_cents: 45000 })
  })

  it('refuses a third decimal rather than rounding it', async () => {
    const result = await createService(CLINIC, { name: 'Consult', price: '450.555' })

    expect(result).toEqual({
      status: 'invalid',
      field: 'price',
      message: 'Enter a price like 450 or 450.50.',
    })
    // Refused BEFORE any DB call — nothing reached the column.
    expect(log).toEqual([])
  })

  it('refuses an empty name before touching the database', async () => {
    const result = await createService(CLINIC, { name: '   ', price: '450' })

    expect(result).toEqual({
      status: 'invalid',
      field: 'name',
      message: 'Enter the service name.',
    })
    expect(log).toEqual([])
  })

  it('maps a write failure to error', async () => {
    errors['insert:services'] = [{ message: 'nope' }]
    expect(await createService(CLINIC, { name: 'Consult', price: '450' })).toEqual({
      status: 'error',
      message: 'nope',
    })
  })
})

describe('updateService', () => {
  it('writes the name and price and nothing else', async () => {
    const result = await updateService(CLINIC, 's-1', {
      name: 'Consultation',
      price: '500',
    })

    expect(result).toEqual({ status: 'ok', id: 's-1' })
    expect(writes).toEqual([
      {
        mode: 'update',
        table: 'services',
        payload: { name: 'Consultation', price_cents: 50000 },
      },
    ])
    // The active flag is not part of an edit.
    expect(db.services[0].active).toBe(true)
  })

  it('reads an empty result as not_found, the way RLS filters', async () => {
    expect(
      await updateService('other-clinic', 's-1', { name: 'Consult', price: '450' }),
    ).toEqual({ status: 'not_found' })
  })

  it('refuses a bad price without issuing the update', async () => {
    const result = await updateService(CLINIC, 's-1', { name: 'Consult', price: 'free' })
    expect(result).toMatchObject({ status: 'invalid', field: 'price' })
    expect(writes).toEqual([])
  })
})

describe('setServiceActive', () => {
  it('deactivates with an UPDATE and never a DELETE', async () => {
    expect(await setServiceActive(CLINIC, 's-1', false)).toEqual({ status: 'ok' })

    expect(writes).toEqual([
      { mode: 'update', table: 'services', payload: { active: false } },
    ])
    expect(log).not.toContain('delete:services')
    // The row is still there, so appointments pointing at it still read.
    expect(db.services.find((s) => s.id === 's-1')).toBeDefined()
  })

  it('re-activates the same way', async () => {
    expect(await setServiceActive(CLINIC, 's-2', true)).toEqual({ status: 'ok' })
    expect(db.services[1].active).toBe(true)
  })

  it('reads an empty result as not_found', async () => {
    expect(await setServiceActive('other-clinic', 's-1', false)).toEqual({
      status: 'not_found',
    })
  })

  it('maps a write failure to error', async () => {
    errors['update:services'] = [{ message: 'nope' }]
    expect(await setServiceActive(CLINIC, 's-1', false)).toEqual({
      status: 'error',
      message: 'nope',
    })
  })
})

describe('setServiceDoctors', () => {
  it('replaces the set through the RPC, with no table writes of its own', async () => {
    const result = await setServiceDoctors('s-1', ['dp-1', 'dp-2'])

    expect(result).toEqual({ status: 'ok', linked: 2 })
    expect(rpcCalls).toEqual([
      {
        fn: 'set_doctor_services',
        args: { p_service_id: 's-1', p_doctor_ids: ['dp-1', 'dp-2'] },
      },
    ])
    // The whole point of the RPC: no delete-then-insert pair from here.
    expect(writes).toEqual([])
    expect(log).toEqual(['rpc:set_doctor_services'])
  })

  it('passes an empty array through — clearing the mapping is legitimate', async () => {
    rpcResults.set_doctor_services = { data: [{ outcome: 'ok', linked: 0 }], error: null }

    expect(await setServiceDoctors('s-1', [])).toEqual({ status: 'ok', linked: 0 })
    expect(rpcCalls[0].args).toEqual({ p_service_id: 's-1', p_doctor_ids: [] })
  })

  it('maps doctor_not_in_clinic', async () => {
    rpcResults.set_doctor_services = {
      data: [{ outcome: 'doctor_not_in_clinic', linked: 0 }],
      error: null,
    }
    expect(await setServiceDoctors('s-1', ['dp-x'])).toEqual({
      status: 'doctor_not_in_clinic',
    })
  })

  it('maps service_not_found, forbidden and unauthenticated', async () => {
    for (const outcome of ['service_not_found', 'forbidden', 'unauthenticated'] as const) {
      rpcResults.set_doctor_services = { data: [{ outcome, linked: 0 }], error: null }
      expect(await setServiceDoctors('s-1', [])).toEqual({ status: outcome })
    }
  })

  it('treats a transport failure and an empty result as errors', async () => {
    rpcResults.set_doctor_services = { data: null, error: { message: 'down' } }
    expect(await setServiceDoctors('s-1', [])).toEqual({ status: 'error', message: 'down' })

    rpcResults.set_doctor_services = { data: [], error: null }
    expect(await setServiceDoctors('s-1', [])).toEqual({
      status: 'error',
      message: 'empty rpc result',
    })
  })

  it('treats an unknown outcome as an error rather than a success', async () => {
    rpcResults.set_doctor_services = {
      data: [{ outcome: 'something_new', linked: 0 }],
      error: null,
    }
    expect(await setServiceDoctors('s-1', [])).toEqual({
      status: 'error',
      message: 'unknown outcome: something_new',
    })
  })
})
