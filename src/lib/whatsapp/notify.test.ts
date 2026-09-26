import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for staff-initiated patient notification (E4-T3).
 *
 * sendTemplate is mocked; the Supabase client is a tiny chain stub
 * providing just the shape notifyPatientCancelled uses.
 */

const sendTemplateMock = vi.fn()
vi.mock('./send', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplateMock(...a),
}))

import { notifyPatientCancelled } from './notify'

// ------------------------------------------------------------
// Supabase client stub (RLS-scoped, read-only chain).
// ------------------------------------------------------------
let readRow: unknown | null = null
let readError: { message: string } | null = null

function stubClient() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: readRow, error: readError }),
        }),
      }),
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function apptRow(over: Record<string, unknown> = {}) {
  return {
    starts_at: '2026-09-28T03:30:00.000Z',
    clinics: { name: 'Demo Clinic', timezone: 'Asia/Kolkata' },
    patients: { wa_phone: '+919876543210' },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  readRow = apptRow()
  readError = null
  sendTemplateMock.mockResolvedValue({ ok: true })
})

describe('notifyPatientCancelled', () => {
  it('sends the cancellation template with clinic/day/time params', async () => {
    const ok = await notifyPatientCancelled(stubClient(), 'appt-1')
    expect(ok).toBe(true)
    expect(sendTemplateMock).toHaveBeenCalledTimes(1)
    const arg = sendTemplateMock.mock.calls[0][0] as {
      to: string
      templateName: string
      bodyParams: string[]
    }
    expect(arg.to).toBe('+919876543210')
    expect(arg.templateName).toBe('appointment_cancelled')
    expect(arg.bodyParams[0]).toBe('Demo Clinic')
    // Time rendered in Asia/Kolkata (+05:30): 09:00 AM.
    expect(arg.bodyParams[2]).toContain('9:00')
  })

  it('returns false and logs when the read errors', async () => {
    readError = { message: 'rls denied' }
    readRow = null
    const ok = await notifyPatientCancelled(stubClient(), 'appt-1')
    expect(ok).toBe(false)
    expect(sendTemplateMock).not.toHaveBeenCalled()
  })

  it('returns false when the patient phone is missing', async () => {
    readRow = apptRow({ patients: null })
    const ok = await notifyPatientCancelled(stubClient(), 'appt-1')
    expect(ok).toBe(false)
    expect(sendTemplateMock).not.toHaveBeenCalled()
  })

  it('returns false when the clinic timezone is missing', async () => {
    readRow = apptRow({ clinics: { name: 'X', timezone: null } })
    const ok = await notifyPatientCancelled(stubClient(), 'appt-1')
    expect(ok).toBe(false)
    expect(sendTemplateMock).not.toHaveBeenCalled()
  })

  it('returns false (no throw) when the send fails', async () => {
    sendTemplateMock.mockResolvedValue({ ok: false, error: 'wacrm 500' })
    const ok = await notifyPatientCancelled(stubClient(), 'appt-1')
    expect(ok).toBe(false)
  })

  it('returns false (no throw) on unexpected errors', async () => {
    sendTemplateMock.mockRejectedValue(new Error('boom'))
    const ok = await notifyPatientCancelled(stubClient(), 'appt-1')
    expect(ok).toBe(false)
  })
})
