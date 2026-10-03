import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Slot } from '@/types'

/**
 * Tests for the portal slot read layer (T3).
 *
 * generateSlots is mocked, because what matters here is not the slots it
 * produces — slot-generation has its own tests — but the exact argument
 * object it is handed. That object is the R3 parity contract: it must be
 * the same one src/lib/whatsapp/text-flow.ts#enterTimeStep passes, or
 * staff and patients drift apart on what's available.
 *
 * The RLS cookie client is a tiny in-memory fake with no RLS, so the
 * cross-clinic case proves this module's own clinic_id scoping, not the
 * database's.
 */

type Row = Record<string, unknown>

let db: Record<string, Row[]>

const generateSlotsMock = vi.fn()
vi.mock('@/lib/availability/slot-generation', () => ({
  generateSlots: (...a: unknown[]) => generateSlotsMock(...a),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}))

/** Chainable fake supporting select/eq/maybeSingle. */
function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []

  const run = (): Row[] =>
    (db[table] ?? []).filter((r) => filters.every((f) => f(r)))

  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val)
      return chain
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
  }
  return chain
}

import {
  getDoctorSlotMinutes,
  listSlotsForDay,
  findSlot,
} from './new-appointment'

const CLINIC_A = 'clinic-a'
const CLINIC_B = 'clinic-b'
const NOW = new Date('2099-03-10T04:00:00.000Z')

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

beforeEach(() => {
  vi.clearAllMocks()
  generateSlotsMock.mockResolvedValue(SLOTS)
  db = {
    doctor_profiles: [
      { id: 'doc-a1', clinic_id: CLINIC_A, slot_duration_minutes: 20 },
      { id: 'doc-b1', clinic_id: CLINIC_B, slot_duration_minutes: 30 },
    ],
  }
})

describe('getDoctorSlotMinutes', () => {
  it("returns the doctor's configured slot length", async () => {
    expect(await getDoctorSlotMinutes(CLINIC_A, 'doc-a1')).toBe(20)
  })

  it("returns null for another clinic's doctor (R5)", async () => {
    expect(await getDoctorSlotMinutes(CLINIC_A, 'doc-b1')).toBeNull()
  })

  it('returns null for an unknown doctor', async () => {
    expect(await getDoctorSlotMinutes(CLINIC_A, 'doc-nope')).toBeNull()
  })
})

describe('listSlotsForDay', () => {
  it('calls generateSlots once with the WhatsApp flow\'s exact inputs (R3)', async () => {
    await listSlotsForDay({
      clinicId: CLINIC_A,
      doctorId: 'doc-a1',
      dateYmd: '2099-03-10',
      timezone: 'Asia/Kolkata',
      now: NOW,
    })

    expect(generateSlotsMock).toHaveBeenCalledTimes(1)
    expect(generateSlotsMock.mock.calls[0][0]).toEqual({
      doctorId: 'doc-a1',
      dateYmd: '2099-03-10',
      clinicTimezone: 'Asia/Kolkata',
      defaultSlotMinutes: 20,
      minLeadMinutes: 0,
      now: NOW,
    })
  })

  it('returns generateSlots output unchanged', async () => {
    const slots = await listSlotsForDay({
      clinicId: CLINIC_A,
      doctorId: 'doc-a1',
      dateYmd: '2099-03-10',
      timezone: 'Asia/Kolkata',
      now: NOW,
    })
    expect(slots).toEqual(SLOTS)
  })

  it("returns [] for another clinic's doctor without generating slots (R5)", async () => {
    const slots = await listSlotsForDay({
      clinicId: CLINIC_A,
      doctorId: 'doc-b1',
      dateYmd: '2099-03-10',
      timezone: 'Asia/Kolkata',
      now: NOW,
    })
    expect(slots).toEqual([])
    expect(generateSlotsMock).not.toHaveBeenCalled()
  })

  it('returns [] for an unknown doctor without generating slots', async () => {
    const slots = await listSlotsForDay({
      clinicId: CLINIC_A,
      doctorId: 'doc-nope',
      dateYmd: '2099-03-10',
      timezone: 'Asia/Kolkata',
      now: NOW,
    })
    expect(slots).toEqual([])
    expect(generateSlotsMock).not.toHaveBeenCalled()
  })
})

describe('findSlot', () => {
  it('finds the slot for a clinic-local HHMM', () => {
    expect(findSlot(SLOTS, '1020')).toBe(SLOTS[1])
  })

  it('returns undefined for a time that is not on offer', () => {
    expect(findSlot(SLOTS, '1030')).toBeUndefined()
  })
})
