import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the patient-messaging DB wrapper (T2).
 *
 * The service-role client is replaced with a tiny chainable fake that
 * models the one shape this module uses:
 * .rpc('capture_patient_message', args) → SETOF one row. It records its
 * arguments so the RPC payload — including the clinic_id that carries
 * tenancy on this RLS-bypassing path (R8) — can be asserted.
 *
 * The module is write-only by design; the 24h window is read on the
 * portal's RLS client and covered by src/lib/portal/messages.test.ts.
 */

// ---- supabaseAdmin fake ------------------------------------------------
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
let rpcResult: { data: unknown; error: { message: string } | null }

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return rpcResult
    },
  }),
}))

import { capturePatientMessage } from './messaging'

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls = []
  rpcResult = {
    data: [
      { patient_id: 'pat-1', message_id: 'msg-1', is_first_message: true },
    ],
    error: null,
  }
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
