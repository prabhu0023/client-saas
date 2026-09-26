import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Auth + dispatch tests for the reminder cron route (E3-T3).
 * The scanner itself is mocked; here we pin the secret check and the
 * summary response.
 */

const SECRET = 'cron-secret-xyz'
vi.stubEnv('CRON_SECRET', SECRET)

const sendDueRemindersMock = vi.fn()
vi.mock('@/lib/reminders/send-due', () => ({
  sendDueReminders: (...a: unknown[]) => sendDueRemindersMock(...a),
}))

import { GET } from './route'

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://clinic.example/api/cron/reminders', {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sendDueRemindersMock.mockResolvedValue({
    scanned: 2,
    sent: 2,
    skipped: 0,
    failed: 0,
  })
})

describe('GET /api/cron/reminders — auth', () => {
  it('401s with no secret', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(sendDueRemindersMock).not.toHaveBeenCalled()
  })

  it('401s with a wrong secret', async () => {
    const res = await GET(req({ authorization: 'Bearer nope' }))
    expect(res.status).toBe(401)
    expect(sendDueRemindersMock).not.toHaveBeenCalled()
  })

  it('accepts the Bearer form (Vercel Cron style)', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ok',
      scanned: 2,
      sent: 2,
      skipped: 0,
      failed: 0,
    })
    expect(sendDueRemindersMock).toHaveBeenCalledTimes(1)
  })

  it('accepts the x-cron-secret header form', async () => {
    const res = await GET(req({ 'x-cron-secret': SECRET }))
    expect(res.status).toBe(200)
    expect(sendDueRemindersMock).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/cron/reminders — errors', () => {
  it('500s if the scan throws', async () => {
    sendDueRemindersMock.mockRejectedValue(new Error('db down'))
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(500)
  })
})
