import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the /setup checklist probe (FR-1.10).
 *
 * The RLS cookie client is replaced with the in-memory fake the other
 * portal tests use, extended with two things this module needs: a
 * dotted `.eq('clinic_members.status', …)` filter so the embedded join
 * is really exercised, and a per-table error injection so a degraded
 * probe can be asserted instead of assumed.
 *
 * The load-bearing assertions are the two `hasDoctor` shapes: a profile
 * on an ACTIVE ADMIN counts (the solo-clinic shape — a founder who gave
 * themself a doctor profile, §9.4a), and a profile on a DISABLED member
 * does not. If this probe ever keys on `role = 'doctor'` instead of
 * member status, the first case fails and the checklist can never go
 * green for a one-person clinic.
 */

type Row = Record<string, unknown>

let db: Record<string, Row[]>
/** Tables whose next read returns a Postgres-style error. */
let failing: Set<string>
/** Every read that reached the client, so "no query issued" is testable. */
let reads: string[]

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}))

/** Read `a.b` out of a row, so an embedded-join filter can be applied. */
function get(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Row)[key]
    return undefined
  }, row)
}

function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let max: number | null = null

  const result = (): { data: unknown; error: unknown } => {
    reads.push(table)
    if (failing.has(table)) {
      return { data: null, error: { message: `relation ${table} unavailable` } }
    }
    const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)))
    return { data: max == null ? rows : rows.slice(0, max), error: null }
  }

  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters.push((r) => get(r, col) === val)
      return chain
    },
    limit: (n: number) => {
      max = n
      return chain
    },
    maybeSingle: async () => {
      const res = result()
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data
      return { data, error: res.error }
    },
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(result()).then(resolve),
  }
  return chain
}

import { getSetupStatus, getSavedWacrmConnection } from './setup-status'

const CLINIC = 'clinic-a'
const OTHER = 'clinic-b'

beforeEach(() => {
  failing = new Set()
  reads = []
  db = {
    clinic_wacrm_accounts: [],
    doctor_profiles: [],
    availability_rules: [],
    services: [],
    clinic_whatsapp_numbers: [],
  }
})

function connectWhatsApp(clinicId = CLINIC, status = 'active') {
  db.clinic_wacrm_accounts.push({
    id: 'wa-1',
    clinic_id: clinicId,
    wacrm_account_id: 'acct_live_1',
    status,
  })
}

function addDoctorProfile(opts: {
  clinicId?: string
  role?: string
  status?: string
}) {
  db.doctor_profiles.push({
    id: `doc-${db.doctor_profiles.length + 1}`,
    clinic_id: opts.clinicId ?? CLINIC,
    clinic_members: { status: opts.status ?? 'active', role: opts.role ?? 'doctor' },
  })
}

describe('getSetupStatus', () => {
  it('is all false for a clinic that has just been created', async () => {
    expect(await getSetupStatus(CLINIC)).toEqual({
      whatsappConnected: false,
      hasDoctor: false,
      hasAvailability: false,
      hasService: false,
      complete: false,
    })
  })

  it('turns each flag on independently', async () => {
    connectWhatsApp()
    expect((await getSetupStatus(CLINIC)).whatsappConnected).toBe(true)

    addDoctorProfile({})
    expect((await getSetupStatus(CLINIC)).hasDoctor).toBe(true)

    db.availability_rules.push({ id: 'r-1', clinic_id: CLINIC, active: true })
    expect((await getSetupStatus(CLINIC)).hasAvailability).toBe(true)

    db.services.push({ id: 's-1', clinic_id: CLINIC, active: true })
    expect((await getSetupStatus(CLINIC)).hasService).toBe(true)
  })

  it('is complete once connected, with a doctor and availability — a service is advisory', async () => {
    connectWhatsApp()
    addDoctorProfile({})
    db.availability_rules.push({ id: 'r-1', clinic_id: CLINIC, active: true })

    const status = await getSetupStatus(CLINIC)
    expect(status.hasService).toBe(false)
    expect(status.complete).toBe(true)
  })

  it('is not complete while any bookable item is missing', async () => {
    connectWhatsApp()
    addDoctorProfile({})
    db.services.push({ id: 's-1', clinic_id: CLINIC, active: true })

    // No availability rule.
    expect((await getSetupStatus(CLINIC)).complete).toBe(false)
  })

  it('ignores a disabled wacrm mapping and an inactive rule or service', async () => {
    connectWhatsApp(CLINIC, 'disabled')
    db.availability_rules.push({ id: 'r-1', clinic_id: CLINIC, active: false })
    db.services.push({ id: 's-1', clinic_id: CLINIC, active: false })

    const status = await getSetupStatus(CLINIC)
    expect(status.whatsappConnected).toBe(false)
    expect(status.hasAvailability).toBe(false)
    expect(status.hasService).toBe(false)
  })

  it("never counts another clinic's rows", async () => {
    connectWhatsApp(OTHER)
    addDoctorProfile({ clinicId: OTHER })
    db.availability_rules.push({ id: 'r-1', clinic_id: OTHER, active: true })
    db.services.push({ id: 's-1', clinic_id: OTHER, active: true })

    expect(await getSetupStatus(CLINIC)).toEqual({
      whatsappConnected: false,
      hasDoctor: false,
      hasAvailability: false,
      hasService: false,
      complete: false,
    })
  })

  it("counts a profile on an ACTIVE ADMIN — the solo clinic's founder (FR-1.10, §9.4a)", async () => {
    addDoctorProfile({ role: 'admin', status: 'active' })
    expect((await getSetupStatus(CLINIC)).hasDoctor).toBe(true)
  })

  it('counts a profile on an active nurse — the role is irrelevant (FR-2.11)', async () => {
    addDoctorProfile({ role: 'nurse', status: 'active' })
    expect((await getSetupStatus(CLINIC)).hasDoctor).toBe(true)
  })

  it('does NOT count a profile whose member is disabled', async () => {
    addDoctorProfile({ role: 'doctor', status: 'disabled' })
    expect((await getSetupStatus(CLINIC)).hasDoctor).toBe(false)
  })

  it('does NOT count a profile whose member is still invited', async () => {
    addDoctorProfile({ role: 'doctor', status: 'invited' })
    expect((await getSetupStatus(CLINIC)).hasDoctor).toBe(false)
  })

  it('degrades one failed probe to false without throwing, keeping the others', async () => {
    connectWhatsApp()
    addDoctorProfile({})
    db.availability_rules.push({ id: 'r-1', clinic_id: CLINIC, active: true })
    db.services.push({ id: 's-1', clinic_id: CLINIC, active: true })
    failing.add('doctor_profiles')

    const status = await getSetupStatus(CLINIC)
    expect(status.hasDoctor).toBe(false)
    expect(status.whatsappConnected).toBe(true)
    expect(status.hasAvailability).toBe(true)
    expect(status.hasService).toBe(true)
    expect(status.complete).toBe(false)
  })

  it('reads all four tables once per call', async () => {
    await getSetupStatus(CLINIC)
    expect(reads.sort()).toEqual([
      'availability_rules',
      'clinic_wacrm_accounts',
      'doctor_profiles',
      'services',
    ])
  })
})

describe('getSavedWacrmConnection', () => {
  it('returns null when nothing is connected', async () => {
    expect(await getSavedWacrmConnection(CLINIC)).toBeNull()
    // The number table is not read when there is no account row.
    expect(reads).toEqual(['clinic_wacrm_accounts'])
  })

  it('returns the account id with nulls when no number was saved', async () => {
    connectWhatsApp()
    expect(await getSavedWacrmConnection(CLINIC)).toEqual({
      wacrmAccountId: 'acct_live_1',
      phoneNumberId: null,
      displayNumber: null,
    })
  })

  it('returns the saved number alongside the account id', async () => {
    connectWhatsApp()
    db.clinic_whatsapp_numbers.push({
      id: 'num-1',
      clinic_id: CLINIC,
      phone_number_id: '123456789',
      display_number: '+91 90000 00000',
      status: 'active',
    })

    expect(await getSavedWacrmConnection(CLINIC)).toEqual({
      wacrmAccountId: 'acct_live_1',
      phoneNumberId: '123456789',
      displayNumber: '+91 90000 00000',
    })
  })

  it('ignores a disconnected number row', async () => {
    connectWhatsApp()
    db.clinic_whatsapp_numbers.push({
      id: 'num-1',
      clinic_id: CLINIC,
      phone_number_id: '123456789',
      display_number: '+91 90000 00000',
      status: 'disconnected',
    })

    expect(await getSavedWacrmConnection(CLINIC)).toEqual({
      wacrmAccountId: 'acct_live_1',
      phoneNumberId: null,
      displayNumber: null,
    })
  })

  it('returns null when the read fails rather than throwing', async () => {
    connectWhatsApp()
    failing.add('clinic_wacrm_accounts')
    expect(await getSavedWacrmConnection(CLINIC)).toBeNull()
  })
})
