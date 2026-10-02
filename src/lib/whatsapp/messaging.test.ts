import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the patient-messaging DB wrapper (T2).
 *
 * The service-role client is replaced with a tiny chainable fake that
 * models only the two shapes this module uses:
 *   1. .rpc('capture_patient_message', args) → SETOF one row, and
 *   2. the SELECT chain behind latestInboundAt.
 * Both record their arguments so the RPC payload and — importantly for
 * tenancy (R8) — the filters on the read can be asserted.
 */

// ---- supabaseAdmin fake ------------------------------------------------
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
let rpcResult: { data: unknown; error: { message: string } | null }

// Filters applied by the latestInboundAt chain, and its scripted result.
let selectFilters: Array<[string, string]>
let selectTable: string | null
let selectResult: { data: unknown; error: { message: string } | null }

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return rpcResult
    },
    from: (table: string) => {
      selectTable = table
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          selectFilters.push([col, val])
          return chain
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => selectResult,
      }
      return chain
    },
  }),
}))

import { capturePatientMessage, latestInboundAt } from './messaging'

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls = []
  rpcResult = {
    data: [
      { patient_id: 'pat-1', message_id: 'msg-1', is_first_message: true },
    ],
    error: null,
  }
  selectFilters = []
  selectTable = null
  selectResult = { data: { created_at: '2026-09-28T10:00:00.000Z' }, error: null }
})

describe('capturePatientMessage', () => {
  it('calls the RPC with the right args and maps the returned row', async () => {
    const res = await capturePatientMessage({
      clinicId: 'clinic-1',
      waPhone: '+919876543210',
      body: 'I have a doubt about the medicine',
      waMessageId: 'wamid-1',
    })

    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('capture_patient_message')
    expect(rpcCalls[0].args).toEqual({
      p_clinic_id: 'clinic-1',
      p_wa_phone: '+919876543210',
      p_body: 'I have a doubt about the medicine',
      p_wa_delivery_id: 'wamid-1',
    })
    expect(res).toEqual({
      patientId: 'pat-1',
      messageId: 'msg-1',
      isFirstMessage: true,
    })
  })

  it('passes a null delivery id when none is known', async () => {
    await capturePatientMessage({
      clinicId: 'clinic-1',
      waPhone: '+919876543210',
      body: 'hello?',
    })
    expect(rpcCalls[0].args.p_wa_delivery_id).toBeNull()
  })

  it('returns null (and does not throw) when the RPC errors', async () => {
    rpcResult = { data: null, error: { message: 'db down' } }
    const res = await capturePatientMessage({
      clinicId: 'clinic-1',
      waPhone: '+919876543210',
      body: 'anything',
    })
    expect(res).toBeNull()
  })

  it('returns null when the RPC yields no row', async () => {
    rpcResult = { data: [], error: null }
    const res = await capturePatientMessage({
      clinicId: 'clinic-1',
      waPhone: '+919876543210',
      body: 'anything',
    })
    expect(res).toBeNull()
  })
})

describe('latestInboundAt', () => {
  it('scopes the read by clinic_id AND patient_id AND inbound direction', async () => {
    const at = await latestInboundAt('clinic-1', 'pat-1')

    expect(selectTable).toBe('patient_messages')
    expect(selectFilters).toEqual([
      ['clinic_id', 'clinic-1'],
      ['patient_id', 'pat-1'],
      ['direction', 'inbound'],
    ])
    expect(at).toBe('2026-09-28T10:00:00.000Z')
  })

  it('returns null when the patient has no inbound messages', async () => {
    selectResult = { data: null, error: null }
    expect(await latestInboundAt('clinic-1', 'pat-1')).toBeNull()
  })

  it('returns null on a read error', async () => {
    selectResult = { data: null, error: { message: 'boom' } }
    expect(await latestInboundAt('clinic-1', 'pat-1')).toBeNull()
  })
})
