import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for the inbox server actions (T3/T4).
 *
 * requireStaff, the RLS client, the WhatsApp send adapter and
 * revalidatePath are mocked; the read layer (src/lib/portal/messages.ts)
 * is NOT, so these exercise the real getThread/isWindowOpen path the
 * actions depend on — including the 24h guard that is the security
 * boundary for R5.
 *
 * As in messages.test.ts the fake client has no RLS, so a cross-clinic
 * case here proves the actions' own clinic_id scoping, not the database's.
 */

type Row = Record<string, unknown>

let db: Record<string, Row[]>
let inserts: Array<{ table: string; values: Row }>
let updates: Array<{ table: string; values: Row; filters: Row }>

const sendMessageMock = vi.fn()
vi.mock('@/lib/whatsapp/send', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(...a),
}))

const revalidatePathMock = vi.fn()
vi.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}))

let staffClinicId = 'clinic-a'
vi.mock('@/lib/portal/auth', () => ({
  requireStaff: async () => ({
    userId: 'user-staff',
    email: 'staff@clinic.test',
    member: { id: 'mem-1', clinic_id: staffClinicId, role: 'receptionist' },
    clinic: {
      id: staffClinicId,
      name: 'Clinic A',
      timezone: 'Asia/Kolkata',
    },
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}))

function cmp(a: unknown, b: unknown): number {
  const sa = a == null ? '' : String(a)
  const sb = b == null ? '' : String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Chainable fake supporting the read shapes plus insert/update. */
function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  const filterValues: Row = {}
  const orders: Array<{ col: string; asc: boolean }> = []
  let cols = '*'
  let max: number | null = null
  let op: 'select' | 'insert' | 'update' = 'select'
  let values: Row = {}

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

  const matched = (): Row[] =>
    (db[table] ?? []).filter((r) => filters.every((f) => f(r)))

  const run = (): Row[] => {
    let rows = matched()
    for (const o of [...orders].reverse()) {
      rows = [...rows].sort(
        (a, b) => cmp(a[o.col], b[o.col]) * (o.asc ? 1 : -1),
      )
    }
    if (max != null) rows = rows.slice(0, max)
    return rows.map(shape)
  }

  const commit = (): { data: null; error: null } => {
    if (op === 'insert') {
      db[table] = [...(db[table] ?? []), { id: `new-${inserts.length}`, ...values }]
      inserts.push({ table, values })
    } else if (op === 'update') {
      for (const row of matched()) Object.assign(row, values)
      updates.push({ table, values, filters: { ...filterValues } })
    }
    return { data: null, error: null }
  }

  const chain = {
    select: (c: string) => {
      cols = c
      return chain
    },
    insert: (v: Row) => {
      op = 'insert'
      values = v
      return chain
    },
    update: (v: Row) => {
      op = 'update'
      values = v
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val)
      filterValues[col] = val
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
      resolve: (v: { data: unknown; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      try {
        const result = op === 'select' ? { data: run(), error: null } : commit()
        return Promise.resolve(result).then(resolve)
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e)
      }
    },
  }
  return chain
}

import { replyToThread, markThreadRead, escalateThread } from './actions'
import { WINDOW_CLOSED_NOTICE } from '@/lib/portal/messages'

const CLINIC_A = 'clinic-a'
const CLINIC_B = 'clinic-b'

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString()
}

function form(entries: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

/** Last inbound age decides the window; 1h = open, 30h = closed. */
function seed(inboundHoursAgo: number | null): void {
  db = {
    patients: [
      { id: 'pat-a1', clinic_id: CLINIC_A, full_name: 'Asha R', wa_phone: '+919000000001' },
      { id: 'pat-b1', clinic_id: CLINIC_B, full_name: 'B Patient', wa_phone: '+919000000009' },
    ],
    doctor_profiles: [
      { id: 'doc-a1', clinic_id: CLINIC_A, specialty: 'Dermatology' },
      { id: 'doc-a2', clinic_id: CLINIC_A, specialty: 'General' },
    ],
    patient_threads: [
      {
        id: 'thr-a1',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        status: 'open',
        escalated_to_doctor_id: null,
        last_message_at: hoursAgo(inboundHoursAgo ?? 1),
        unread_count: 3,
      },
      {
        id: 'thr-b1',
        clinic_id: CLINIC_B,
        patient_id: 'pat-b1',
        status: 'open',
        escalated_to_doctor_id: null,
        last_message_at: hoursAgo(1),
        unread_count: 1,
      },
    ],
    patient_messages:
      inboundHoursAgo == null
        ? []
        : [
            {
              id: 'msg-a1',
              clinic_id: CLINIC_A,
              patient_id: 'pat-a1',
              direction: 'inbound',
              body: 'Is the ointment safe with my tablets?',
              sent_by: null,
              created_at: hoursAgo(inboundHoursAgo),
            },
          ],
    appointments: [
      {
        id: 'appt-old',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        doctor_id: 'doc-a2',
        status: 'completed',
        starts_at: hoursAgo(400),
      },
      {
        id: 'appt-recent',
        clinic_id: CLINIC_A,
        patient_id: 'pat-a1',
        doctor_id: 'doc-a1',
        status: 'completed',
        starts_at: hoursAgo(50),
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  staffClinicId = CLINIC_A
  inserts = []
  updates = []
  sendMessageMock.mockResolvedValue({ ok: true })
  seed(1)
})

describe('replyToThread — window open', () => {
  it('sends once and stores exactly one outbound message (R5)', async () => {
    await replyToThread(
      form({ threadId: 'thr-a1', body: '  Yes, it is safe.  ' }),
    )

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock.mock.calls[0][0]).toEqual({
      kind: 'text',
      to: '+919000000001',
      body: 'Yes, it is safe.',
    })

    const outbound = inserts.filter((i) => i.table === 'patient_messages')
    expect(outbound).toHaveLength(1)
    expect(outbound[0].values).toEqual({
      clinic_id: CLINIC_A,
      patient_id: 'pat-a1',
      direction: 'outbound',
      body: 'Yes, it is safe.',
      wa_delivery_id: null,
      sent_by: 'user-staff',
    })
  })

  it('clears the unread count and bumps last_message_at, scoped to the clinic', async () => {
    await replyToThread(form({ threadId: 'thr-a1', body: 'Yes.' }))

    const update = updates.find((u) => u.table === 'patient_threads')!
    expect(update.values.unread_count).toBe(0)
    expect(update.values.last_message_at).toBeTypeOf('string')
    expect(update.filters).toEqual({ id: 'thr-a1', clinic_id: CLINIC_A })
    expect(db.patient_threads[0].unread_count).toBe(0)
  })

  it('revalidates the inbox and the thread', async () => {
    await replyToThread(form({ threadId: 'thr-a1', body: 'Yes.' }))
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox/thr-a1')
  })

  it('stores nothing when the send fails', async () => {
    sendMessageMock.mockResolvedValue({ ok: false, error: 'wacrm 500' })
    await expect(
      replyToThread(form({ threadId: 'thr-a1', body: 'Yes.' })),
    ).rejects.toThrow(/reply send failed/)
    expect(inserts).toHaveLength(0)
  })
})

describe('replyToThread — window closed', () => {
  it('throws without attempting a free-form send (R5)', async () => {
    seed(30) // last inbound 30h ago
    await expect(
      replyToThread(form({ threadId: 'thr-a1', body: 'Yes, it is safe.' })),
    ).rejects.toThrow(WINDOW_CLOSED_NOTICE)

    expect(sendMessageMock).toHaveBeenCalledTimes(0)
    expect(inserts).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  it('throws for a patient who never messaged', async () => {
    seed(null)
    await expect(
      replyToThread(form({ threadId: 'thr-a1', body: 'Hello?' })),
    ).rejects.toThrow(WINDOW_CLOSED_NOTICE)
    expect(sendMessageMock).toHaveBeenCalledTimes(0)
  })
})

describe('replyToThread — rejected input', () => {
  it("refuses another clinic's thread id (R8)", async () => {
    await expect(
      replyToThread(form({ threadId: 'thr-b1', body: 'Hi' })),
    ).rejects.toThrow(/thread not found/)
    expect(sendMessageMock).toHaveBeenCalledTimes(0)
  })

  it('refuses an empty body', async () => {
    await expect(
      replyToThread(form({ threadId: 'thr-a1', body: '   ' })),
    ).rejects.toThrow(/empty/)
    expect(sendMessageMock).toHaveBeenCalledTimes(0)
  })

  it('refuses a missing thread id', async () => {
    await expect(replyToThread(form({ body: 'Hi' }))).rejects.toThrow(
      /missing thread/,
    )
  })
})

describe('markThreadRead', () => {
  it('zeroes the unread count for the caller clinic', async () => {
    await markThreadRead(form({ threadId: 'thr-a1' }))

    const update = updates.find((u) => u.table === 'patient_threads')!
    expect(update.values).toEqual({ unread_count: 0 })
    expect(update.filters).toEqual({ id: 'thr-a1', clinic_id: CLINIC_A })
    expect(db.patient_threads[0].unread_count).toBe(0)
  })

  it("updates nothing for another clinic's thread", async () => {
    await markThreadRead(form({ threadId: 'thr-b1' }))
    // The clinic_id filter matches no row, so clinic B keeps its badge.
    expect(db.patient_threads[1].unread_count).toBe(1)
  })
})

describe('escalateThread', () => {
  it("sets status escalated and the latest appointment's doctor (R6)", async () => {
    await escalateThread(form({ threadId: 'thr-a1' }))

    const update = updates.find((u) => u.table === 'patient_threads')!
    expect(update.values).toEqual({
      status: 'escalated',
      escalated_to_doctor_id: 'doc-a1',
    })
    expect(db.patient_threads[0].status).toBe('escalated')
  })

  it('escalates unassigned when the patient has no appointments', async () => {
    db.appointments = []
    await escalateThread(form({ threadId: 'thr-a1' }))

    const update = updates.find((u) => u.table === 'patient_threads')!
    expect(update.values).toEqual({
      status: 'escalated',
      escalated_to_doctor_id: null,
    })
  })

  it("refuses another clinic's thread id", async () => {
    await expect(escalateThread(form({ threadId: 'thr-b1' }))).rejects.toThrow(
      /thread not found/,
    )
    expect(db.patient_threads[1].status).toBe('open')
  })
})
