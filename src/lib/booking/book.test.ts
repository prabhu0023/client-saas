import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the tenancy check and the admin client before importing book.ts.
const rpcMock = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: rpcMock }),
}))

const doctorBelongsMock = vi.fn()
vi.mock('@/lib/clinics/tenancy', () => ({
  doctorBelongsToClinic: (...args: unknown[]) => doctorBelongsMock(...args),
}))

import { bookAppointment, type BookArgs } from './book'

function args(over: Partial<BookArgs> = {}): BookArgs {
  return {
    clinicId: 'clinic-1',
    doctorId: 'doctor-1',
    waPhone: '+919876543210',
    startsAtUtc: '2026-09-21T03:30:00.000Z',
    endsAtUtc: '2026-09-21T04:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  rpcMock.mockReset()
  doctorBelongsMock.mockReset()
  doctorBelongsMock.mockResolvedValue(true)
})

describe('bookAppointment', () => {
  it('maps a booked outcome to a booked result with ids', async () => {
    rpcMock.mockResolvedValue({
      data: [{ outcome: 'booked', appointment_id: 'appt-1', patient_id: 'pat-1' }],
      error: null,
    })
    const res = await bookAppointment(args())
    expect(res).toEqual({
      status: 'booked',
      appointmentId: 'appt-1',
      patientId: 'pat-1',
    })
  })

  it('maps slot_taken (the race) to a slot_taken result, no throw', async () => {
    rpcMock.mockResolvedValue({
      data: [{ outcome: 'slot_taken', appointment_id: null, patient_id: 'pat-1' }],
      error: null,
    })
    const res = await bookAppointment(args())
    expect(res).toEqual({ status: 'slot_taken' })
  })

  it('maps an rpc invalid outcome to invalid', async () => {
    rpcMock.mockResolvedValue({
      data: [{ outcome: 'invalid', appointment_id: null, patient_id: null }],
      error: null,
    })
    const res = await bookAppointment(args())
    expect(res.status).toBe('invalid')
  })

  it('surfaces an unexpected rpc error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const res = await bookAppointment(args())
    expect(res).toEqual({ status: 'error', message: 'db down' })
  })

  it('rejects invalid time range before calling the rpc', async () => {
    const res = await bookAppointment(
      args({ endsAtUtc: '2026-09-21T03:00:00.000Z' }),
    )
    expect(res.status).toBe('invalid')
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('fails tenancy check before calling the rpc', async () => {
    doctorBelongsMock.mockResolvedValue(false)
    const res = await bookAppointment(args())
    expect(res.status).toBe('invalid')
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('handles a non-array rpc result (single row)', async () => {
    rpcMock.mockResolvedValue({
      data: { outcome: 'booked', appointment_id: 'a', patient_id: 'p' },
      error: null,
    })
    const res = await bookAppointment(args())
    expect(res.status).toBe('booked')
  })
})
