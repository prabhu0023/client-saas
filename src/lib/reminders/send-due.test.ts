import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the appointment-reminder scanner (E3-T3).
 *
 * The Supabase admin client is stubbed with a tiny fake that models just
 * the two shapes send-due.ts uses:
 *   1. the SELECT chain that returns due candidate rows, and
 *   2. the conditional UPDATE "claim" (and the release-on-failure update).
 * `sendTemplate` is mocked so no network call is made.
 */

// ---- sendTemplate mock -------------------------------------------------
const sendTemplateMock = vi.fn()
vi.mock('@/lib/whatsapp/send', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplateMock(...a),
}))

// ---- supabaseAdmin fake ------------------------------------------------
// Candidate rows returned by the SELECT scan.
let dueRows: unknown[] = []
// Set of appointment ids currently claimed (reminder_sent_at != null),
// so the conditional `.is('reminder_sent_at', null)` claim can race.
let claimed: Set<string>
// Record of update calls for assertions.
let updateCalls: Array<{ id: string; reminder_sent_at: string | null; guard: string }>

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'appointments') throw new Error(`unexpected table ${table}`)
      return makeAppointmentsBuilder()
    },
  }),
}))

/**
 * Builds a chainable stub. Two terminal shapes:
 *  - SELECT scan: .select().is().in().gte().lte().order().limit() → { data }
 *  - UPDATE claim: .update(vals).eq('id', id).is|eq('reminder_sent_at', g)
 *                    .select('id').maybeSingle() → { data }
 */
function makeAppointmentsBuilder() {
  const state: {
    op: 'select' | 'update'
    updateVals?: { reminder_sent_at: string | null }
    id?: string
    guard?: string // value the update is guarded on
  } = { op: 'select' }

  const chain = {
    select: () => chain,
    is: () => {
      if (state.op === 'update') state.guard = 'null'
      return chain
    },
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: async () => ({ data: dueRows, error: null }),
    update: (vals: { reminder_sent_at: string | null }) => {
      state.op = 'update'
      state.updateVals = vals
      return chain
    },
    eq: (col: string, val: string) => {
      if (col === 'id') state.id = val
      if (col === 'reminder_sent_at') state.guard = val
      return chain
    },
    maybeSingle: async () => {
      // Terminal for the CLAIM update (…select('id').maybeSingle()).
      const id = state.id!
      updateCalls.push({
        id,
        reminder_sent_at: state.updateVals!.reminder_sent_at,
        guard: state.guard ?? '',
      })
      // Claim path: succeeds only if not already claimed (guard: is null).
      if (claimed.has(id)) return { data: null, error: null }
      claimed.add(id)
      return { data: { id }, error: null }
    },
    // The RELEASE update awaits the builder directly (no maybeSingle), so
    // the chain must be thenable to resolve and record that call.
    then: (
      resolve: (v: { data: null; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      try {
        if (state.op === 'update') {
          const id = state.id!
          updateCalls.push({
            id,
            reminder_sent_at: state.updateVals!.reminder_sent_at,
            guard: state.guard ?? '',
          })
          if (state.updateVals!.reminder_sent_at === null) claimed.delete(id)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e)
      }
    },
  }
  return chain
}

import { sendDueReminders } from './send-due'

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'appt-1',
    starts_at: '2099-01-05T03:30:00.000Z',
    clinic: { name: 'Demo Clinic', timezone: 'Asia/Kolkata' },
    patient: { wa_phone: '+919876543210' },
    doctor: { specialty: 'General' },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  dueRows = []
  claimed = new Set()
  updateCalls = []
  sendTemplateMock.mockResolvedValue({ ok: true })
})

describe('sendDueReminders', () => {
  it('sends a template for a due row and claims it', async () => {
    dueRows = [dueRow()]
    const res = await sendDueReminders()

    expect(res).toEqual({ scanned: 1, sent: 1, skipped: 0, failed: 0 })
    expect(sendTemplateMock).toHaveBeenCalledTimes(1)
    // Claim happened (non-null reminder_sent_at), no release.
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].reminder_sent_at).not.toBeNull()

    const arg = sendTemplateMock.mock.calls[0][0] as {
      to: string
      templateName: string
      bodyParams: string[]
    }
    expect(arg.to).toBe('+919876543210')
    expect(arg.bodyParams[0]).toBe('Demo Clinic')
    // Labels rendered in clinic tz (Asia/Kolkata, +05:30): 09:00 AM.
    expect(arg.bodyParams[2]).toContain('9:00')
  })

  it('releases the claim when the send fails, so it retries later', async () => {
    dueRows = [dueRow()]
    sendTemplateMock.mockResolvedValue({ ok: false, error: 'wacrm 500' })

    const res = await sendDueReminders()
    expect(res).toEqual({ scanned: 1, sent: 0, skipped: 0, failed: 1 })

    // Two updates: claim (non-null) then release (null).
    expect(updateCalls).toHaveLength(2)
    expect(updateCalls[0].reminder_sent_at).not.toBeNull()
    expect(updateCalls[1].reminder_sent_at).toBeNull()
    // The row is back to unclaimed.
    expect(claimed.has('appt-1')).toBe(false)
  })

  it('skips a row already claimed by a concurrent run (no send)', async () => {
    dueRows = [dueRow()]
    claimed.add('appt-1') // someone else claimed it first

    const res = await sendDueReminders()
    expect(res).toEqual({ scanned: 1, sent: 0, skipped: 1, failed: 0 })
    expect(sendTemplateMock).not.toHaveBeenCalled()
  })

  it('skips rows missing a phone or timezone without claiming', async () => {
    dueRows = [
      dueRow({ id: 'no-phone', patient: null }),
      dueRow({ id: 'no-tz', clinic: { name: 'X', timezone: null } }),
    ]
    const res = await sendDueReminders()
    expect(res).toEqual({ scanned: 2, sent: 0, skipped: 2, failed: 0 })
    expect(sendTemplateMock).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0) // never attempted a claim
  })

  it('processes multiple due rows', async () => {
    dueRows = [dueRow({ id: 'a' }), dueRow({ id: 'b' }), dueRow({ id: 'c' })]
    const res = await sendDueReminders()
    expect(res).toEqual({ scanned: 3, sent: 3, skipped: 0, failed: 0 })
    expect(sendTemplateMock).toHaveBeenCalledTimes(3)
  })
})
