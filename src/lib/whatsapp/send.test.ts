import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for the send adapter (E3-T1 focus: the template-send path).
 *
 * `send.ts` reads WACRM_BASE_URL / WACRM_API_KEY at module load, so we
 * set them before importing and reset modules between the "configured"
 * and "unconfigured" cases. `fetch` is stubbed so no network call is made.
 */

const BASE = 'https://wacrm.example'
const KEY = 'test-key'

function stubFetchOk() {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => ({ ok: true, status: 200 }) as Response,
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('sendTemplate — configured', () => {
  beforeEach(() => {
    vi.stubEnv('WACRM_BASE_URL', BASE)
    vi.stubEnv('WACRM_API_KEY', KEY)
  })

  it('posts the template payload (name, language, ordered body params)', async () => {
    const fetchMock = stubFetchOk()
    const { sendTemplate } = await import('./send')

    const res = await sendTemplate({
      kind: 'template',
      to: '+919876543210',
      templateName: 'appointment_reminder',
      bodyParams: ['Dr. Rao', 'Mon, Sep 28', '9:00 AM'],
      languageCode: 'en',
    })

    expect(res).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/v1/messages`)
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    )
    expect(JSON.parse(init!.body as string)).toEqual({
      to: '+919876543210',
      type: 'template',
      template: {
        name: 'appointment_reminder',
        language: 'en',
        body_params: ['Dr. Rao', 'Mon, Sep 28', '9:00 AM'],
      },
    })
  })

  it("defaults languageCode to 'en' when omitted", async () => {
    const fetchMock = stubFetchOk()
    const { sendTemplate } = await import('./send')

    await sendTemplate({
      kind: 'template',
      to: '+911112223334',
      templateName: 'appointment_reminder',
      bodyParams: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init!.body as string).template.language).toBe('en')
  })

  it('reports a non-2xx response as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 422 }) as Response),
    )
    const { sendTemplate } = await import('./send')

    const res = await sendTemplate({
      kind: 'template',
      to: '+919876543210',
      templateName: 'appointment_reminder',
      bodyParams: ['x'],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('422')
  })

  it('reports a network error gracefully (no throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const { sendTemplate } = await import('./send')

    const res = await sendTemplate({
      kind: 'template',
      to: '+919876543210',
      templateName: 'appointment_reminder',
      bodyParams: ['x'],
    })
    expect(res).toEqual({ ok: false, error: 'network down' })
  })
})

describe('sendTemplate — unconfigured', () => {
  it('fails gracefully when WACRM env vars are absent (no fetch)', async () => {
    // No env stubbed → BASE/KEY undefined at module load.
    const fetchMock = stubFetchOk()
    const { sendTemplate } = await import('./send')

    const res = await sendTemplate({
      kind: 'template',
      to: '+919876543210',
      templateName: 'appointment_reminder',
      bodyParams: ['x'],
    })
    expect(res).toEqual({ ok: false, error: 'wacrm channel not configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
