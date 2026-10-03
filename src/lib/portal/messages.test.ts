import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the portal patient-messaging read layer (T3/T4).
 *
 * The RLS cookie client is replaced with a tiny in-memory fake (same
 * spirit as src/lib/reminders/send-due.test.ts, generalized because this
 * module issues four different query shapes). The fake does NOT implement
 * RLS — it only applies the filters the code passes. That is exactly the
 * point: the cross-clinic cases below prove the module's own explicit
 * `.eq('clinic_id', …)` scoping holds up even with RLS taken away (R8).
 */

type Row = Record<string, unknown>

let db: Record<string, Row[]>

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}))

/** Compare two cell values as supabase would order them (nulls last-ish). */
function cmp(a: unknown, b: unknown): number {
  const sa = a == null ? '' : String(a)
  const sb = b == null ? '' : String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/**
 * Chainable query stub supporting select/eq/in/order/limit/maybeSingle,
 * awaitable at any point. Embedded selects ('patients ( … )') are
 * resolved from the seeded tables by foreign key.
 */
function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  const orders: Array<{ col: string; asc: boolean }> = []
  let cols = '*'
  let max: number | null = null

  const shape = (r: Row): Row => {
    const out: Row = { ...r }
    if (cols.includes('patients')) {
      out.patients =
        (db.patients ?? []).find((p) => p.id === r.patient_id) ?? null
    }
    if (cols.includes('doctor_profiles')) {
      out.doctor_profiles =
        (db.doctor_profiles ?? []).find(
          (d) => d.id === r.escalated_to_doctor_id,
        ) ?? null
    }
    return out
  }

  const run = (): Row[] => {
    let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)))
    // Apply orders last-key-first so the first .order() wins overall.
    for (const o of [...orders].reverse()) {
      rows = [...rows].sort(
        (a, b) => cmp(a[o.col], b[o.col]) * (o.asc ? 1 : -1),
      )
    }
    if (max != null) rows = rows.slice(0, max)
    return rows.map(shape)
  }

  const chain = {
    select: (c: string) => {
      cols = c
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val)
      return chain
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]))
      return chain
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orders.push({ col, asc: opts?.ascending !== false })
      return chain
    },
    limit: (n: number) => {
      max = n
      return chain
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (
      resolve: (v: { data: Row[]; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      try {
        return Promise.resolve({ data: run(), error: null }).then(resolve)
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e)
      }
    },
  }
  return chain
}

import {
  listThreads,
  getThread,
  getThreadTimeline,
  isWindowOpen,
} from './messages'

const CLINIC_A = 'clinic-a'
const CLINIC_B = 'clinic-b'
const NOW = new Date('2099-03-10T12:00:00.000Z')

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString()
}

beforeEach(() => {
  db = {
    patients: [
      { id: 'pat-a1', clinic_id: CLINIC_A, full_name: 'Asha R', wa_phone: '+919000000001' },
      { id: 'pat-a2', clinic_id: CLINIC_A, full_name: null, wa_phone: '+919000000002' },
      { id: 'pat-b1', clinic_id: CLINIC_B, full_name: 'Other Clinic', wa_phone: '+919000000003' },
    ],
    doctor_profiles: [
      { id: 'doc-a1', clinic_id: CLINIC_A, specialty: 'Dermatology' },
    ],
    patient_threads: [
      {
        id: 'thr-a1',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        status: 'open',
        escalated_to_doctor_id: null,
        last_message_at: hoursAgo(1),
        unread_count: 2,
      },
      {
        id: 'thr-a2',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a2',
        status: 'escalated',
        escalated_to_doctor_id: 'doc-a1',
        last_message_at: hoursAgo(40),
        unread_count: 0,
      },
      {
        id: 'thr-b1',
        clinic_id: CLINIC_B,
        patient_id: 'pat-b1',
        status: 'open',
        escalated_to_doctor_id: null,
        last_message_at: hoursAgo(2),
        unread_count: 5,
      },
    ],
    patient_messages: [
      {
        id: 'msg-a1-1',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        direction: 'inbound',
        body: 'Is the ointment   safe with my other tablets?',
        sent_by: null,
        created_at: hoursAgo(1),
      },
      {
        id: 'msg-a1-0',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        direction: 'outbound',
        body: 'Thanks — the clinic has received your message.',
        sent_by: 'user-1',
        created_at: hoursAgo(26),
      },
      {
        id: 'msg-a2-1',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a2',
        direction: 'inbound',
        body: 'Still some swelling after the visit.',
        sent_by: null,
        created_at: hoursAgo(30),
      },
      {
        id: 'msg-b1-1',
        clinic_id: CLINIC_B,
        patient_id: 'pat-b1',
        direction: 'inbound',
        body: 'Clinic B private message',
        sent_by: null,
        created_at: hoursAgo(2),
      },
    ],
    appointments: [
      {
        id: 'appt-a1-1',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        doctor_id: 'doc-a1',
        status: 'completed',
        starts_at: hoursAgo(48),
      },
      {
        id: 'appt-a1-2',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        doctor_id: 'doc-a1',
        status: 'booked',
        starts_at: hoursAgo(-72),
      },
      {
        id: 'appt-b1-1',
        clinic_id: CLINIC_B,
        patient_id: 'pat-b1',
        doctor_id: 'doc-b1',
        status: 'booked',
        starts_at: hoursAgo(10),
      },
    ],
  }
})

describe('listThreads', () => {
  it("returns only the caller clinic's threads", async () => {
    const threads = await listThreads(CLINIC_A)
    expect(threads.map((t) => t.id)).toEqual(['thr-a2', 'thr-a1'])
    expect(threads.some((t) => t.id === 'thr-b1')).toBe(false)
  })

  it('puts escalated threads ahead of open ones', async () => {
    // thr-a2 is older but escalated, so it leads the queue.
    const threads = await listThreads(CLINIC_A)
    expect(threads[0].status).toBe('escalated')
    expect(threads[1].status).toBe('open')
  })

  it('shapes patient name, phone, unread count and a flattened preview', async () => {
    const threads = await listThreads(CLINIC_A)
    const open = threads.find((t) => t.id === 'thr-a1')!

    expect(open.patientName).toBe('Asha R')
    expect(open.patientPhone).toBe('+919000000001')
    expect(open.unreadCount).toBe(2)
    // Newest message for that patient, whitespace collapsed.
    expect(open.lastMessagePreview).toBe(
      'Is the ointment safe with my other tablets?',
    )

    const escalated = threads.find((t) => t.id === 'thr-a2')!
    expect(escalated.patientName).toBeNull()
    expect(escalated.lastMessagePreview).toBe('Still some swelling after the visit.')
  })

  it('returns an empty list when the clinic has no threads', async () => {
    db.patient_threads = []
    expect(await listThreads(CLINIC_A)).toEqual([])
  })
})

describe('getThread', () => {
  it('returns the thread with its patient', async () => {
    const thread = await getThread(CLINIC_A, 'thr-a1')
    expect(thread).not.toBeNull()
    expect(thread!.patientId).toBe('pat-a1')
    expect(thread!.patientPhone).toBe('+919000000001')
    expect(thread!.status).toBe('open')
  })

  it('resolves the escalated doctor specialty for the degraded label', async () => {
    const thread = await getThread(CLINIC_A, 'thr-a2')
    expect(thread!.escalatedToDoctorId).toBe('doc-a1')
    expect(thread!.escalatedToDoctorSpecialty).toBe('Dermatology')
  })

  it("returns null for another clinic's thread id (R8)", async () => {
    expect(await getThread(CLINIC_A, 'thr-b1')).toBeNull()
  })

  it('returns null for an unknown id', async () => {
    expect(await getThread(CLINIC_A, 'nope')).toBeNull()
  })
})

describe('getThreadTimeline', () => {
  it('interleaves messages and appointments in time order (R7)', async () => {
    const entries = await getThreadTimeline(CLINIC_A, 'pat-a1', 'Asia/Kolkata')

    expect(entries.map((e) => [e.kind, e.id])).toEqual([
      ['appointment', 'appt-a1-1'],
      ['message', 'msg-a1-0'],
      ['message', 'msg-a1-1'],
      ['appointment', 'appt-a1-2'],
    ])
    // Sorted ascending on the same field the UI groups by.
    const times = entries.map((e) => e.at)
    expect([...times].sort()).toEqual(times)
  })

  it('labels entries in clinic-local time', async () => {
    const entries = await getThreadTimeline(CLINIC_A, 'pat-a1', 'Asia/Kolkata')
    const msg = entries.find((e) => e.id === 'msg-a1-1')!
    // 11:00 UTC → 16:30 in Asia/Kolkata.
    expect(msg.timeLabel).toBe('4:30 PM')
    expect(msg.dayLabel).toMatch(/Mar 10/)
  })

  it('keeps direction and sender on message entries', async () => {
    const entries = await getThreadTimeline(CLINIC_A, 'pat-a1', 'Asia/Kolkata')
    const inbound = entries.find((e) => e.id === 'msg-a1-1')!
    const outbound = entries.find((e) => e.id === 'msg-a1-0')!
    expect(inbound.kind === 'message' && inbound.direction).toBe('inbound')
    expect(inbound.kind === 'message' && inbound.sentBy).toBeNull()
    expect(outbound.kind === 'message' && outbound.direction).toBe('outbound')
    expect(outbound.kind === 'message' && outbound.sentBy).toBe('user-1')
  })

  it("excludes another clinic's rows for the same patient id", async () => {
    const entries = await getThreadTimeline(CLINIC_A, 'pat-b1', 'Asia/Kolkata')
    expect(entries).toEqual([])
  })
})

describe('isWindowOpen', () => {
  it('is true when the last inbound is an hour old', async () => {
    expect(await isWindowOpen(CLINIC_A, 'pat-a1', NOW)).toBe(true)
  })

  it('is false when the last inbound is 30 hours old', async () => {
    expect(await isWindowOpen(CLINIC_A, 'pat-a2', NOW)).toBe(false)
  })

  it('is false for a patient who has never messaged', async () => {
    db.patient_messages = []
    expect(await isWindowOpen(CLINIC_A, 'pat-a1', NOW)).toBe(false)
  })

  it('ignores outbound messages when deriving the window', async () => {
    // Only an outbound reply exists, 1 hour old: the patient's window is
    // still closed — staff replying does not re-open it.
    db.patient_messages = [
      {
        id: 'out-only',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        direction: 'outbound',
        body: 'hello',
        sent_by: 'user-1',
        created_at: hoursAgo(1),
      },
    ]
    expect(await isWindowOpen(CLINIC_A, 'pat-a1', NOW)).toBe(false)
  })

  it("ignores another clinic's inbound for the same patient id", async () => {
    expect(await isWindowOpen(CLINIC_A, 'pat-b1', NOW)).toBe(false)
  })
})
