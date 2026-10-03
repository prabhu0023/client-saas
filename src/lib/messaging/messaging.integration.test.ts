import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * End-to-end patient-messaging integration test (T5, test matrix d + c).
 *
 * Every other messaging test mocks one side of the feature: the flow
 * tests stub `capturePatientMessage`, the portal tests stub the rows it
 * would have written. This file is the one that joins them — ONE
 * in-memory database is wired into BOTH supabase clients at once:
 *
 *   @/lib/supabase/admin   → the patient (no-login, RLS-bypassing) path
 *   @/lib/supabase/server  → the staff portal (RLS) path
 *
 * so a real inbound WhatsApp message travels through the real capture
 * code, lands in the real tables, and is then read and replied to by the
 * real portal code. `capture_patient_message` is reimplemented here with
 * the semantics of migration 011 (upsert patient, insert inbound, upsert
 * thread bumping unread_count) because no test run applies migrations.
 *
 * The fake implements NO RLS, deliberately: the cross-clinic assertions
 * below therefore prove the CODE's own clinic_id scoping (R8) rather
 * than the database's. The policies themselves are only ever exercised
 * by the TEST_DATABASE_URL-gated src/lib/messaging/tenancy.db.test.ts.
 */

type Row = Record<string, unknown>

const CLINIC_A = 'clinic-a'
const CLINIC_B = 'clinic-b'
const PHONE = '+919876543210'
const DOUBT = 'Is the ointment safe with my tablets?'

/**
 * Timestamps start an hour in the past and advance a second per write,
 * so ordering is deterministic AND the captured inbound is inside the
 * 24h reply window the portal guard checks against the real clock.
 */
const BASE = Date.now() - 60 * 60_000
let clock = 0
let seq = 0

function tick(): string {
  clock += 1000
  return new Date(BASE + clock).toISOString()
}

let db: Record<string, Row[]>

// ------------------------------------------------------------
// The shared in-memory database, wired into both clients.
// ------------------------------------------------------------
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args: Record<string, unknown>) =>
      captureRpc(fn, args),
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}))

// The staff identity behind the portal path.
vi.mock('@/lib/portal/auth', () => ({
  requireStaff: async () => ({
    userId: 'user-staff',
    email: 'staff@clinic-a.test',
    member: { id: 'mem-a1', clinic_id: CLINIC_A, role: 'receptionist' },
    clinic: { id: CLINIC_A, name: 'Clinic A', timezone: 'Asia/Kolkata' },
  }),
}))

// wacrm is the one real boundary we never cross in a test.
const sendMessageMock = vi.fn()
vi.mock('@/lib/whatsapp/send', () => ({
  sendMessage: (...a: unknown[]) => sendMessageMock(...a),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function cmp(a: unknown, b: unknown): number {
  const sa = a == null ? '' : String(a)
  const sb = b == null ? '' : String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/**
 * Chainable supabase stub over `db`: select/insert/update + eq/in/order/
 * limit/maybeSingle, awaitable at any point. Embedded selects are
 * resolved from the seeded tables by foreign key, the way PostgREST
 * would resolve `patients ( … )`.
 */
function makeBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
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
    // Apply orders last-key-first so the first .order() wins overall.
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
      seq += 1
      db[table] = [
        ...(db[table] ?? []),
        { id: `${table}-${seq}`, created_at: tick(), ...values },
      ]
    } else if (op === 'update') {
      for (const row of matched()) Object.assign(row, values)
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

/**
 * `capture_patient_message` from migration 011, in TypeScript: upsert the
 * patient on (clinic_id, wa_phone), compute is_first_message BEFORE the
 * insert, append the inbound row, then upsert the thread with
 * unread_count + 1 — keeping an escalated thread escalated.
 */
function captureRpc(
  fn: string,
  args: Record<string, unknown>,
): { data: Row[] | null; error: { message: string } | null } {
  if (fn !== 'capture_patient_message') {
    return { data: null, error: { message: `unexpected rpc: ${fn}` } }
  }

  const clinicId = args.p_clinic_id as string
  const waPhone = args.p_wa_phone as string
  const body = args.p_body as string
  const deliveryId = (args.p_wa_delivery_id as string | null) ?? null
  const at = tick()

  let patient = (db.patients ?? []).find(
    (p) => p.clinic_id === clinicId && p.wa_phone === waPhone,
  )
  if (!patient) {
    seq += 1
    patient = {
      id: `pat-${seq}`,
      clinic_id: clinicId,
      wa_phone: waPhone,
      full_name: null,
    }
    db.patients = [...(db.patients ?? []), patient]
  }
  const patientId = patient.id as string

  const isFirstMessage = !(db.patient_messages ?? []).some(
    (m) => m.clinic_id === clinicId && m.patient_id === patientId,
  )

  seq += 1
  const messageId = `msg-${seq}`
  db.patient_messages = [
    ...(db.patient_messages ?? []),
    {
      id: messageId,
      clinic_id: clinicId,
      patient_id: patientId,
      direction: 'inbound',
      body,
      wa_delivery_id: deliveryId,
      sent_by: null,
      created_at: at,
    },
  ]

  const thread = (db.patient_threads ?? []).find(
    (t) => t.clinic_id === clinicId && t.patient_id === patientId,
  )
  if (thread) {
    thread.last_message_at = at
    thread.unread_count = (thread.unread_count as number) + 1
    thread.status = thread.status === 'escalated' ? 'escalated' : 'open'
  } else {
    seq += 1
    db.patient_threads = [
      ...(db.patient_threads ?? []),
      {
        id: `thr-${seq}`,
        clinic_id: clinicId,
        patient_id: patientId,
        status: 'open',
        escalated_to_doctor_id: null,
        last_message_at: at,
        unread_count: 1,
        created_at: at,
      },
    ]
  }

  return {
    data: [
      {
        patient_id: patientId,
        message_id: messageId,
        is_first_message: isFirstMessage,
      },
    ],
    error: null,
  }
}

import { handleTextMessage } from '@/lib/whatsapp/text-flow'
import { listThreads, getThreadTimeline } from '@/lib/portal/messages'
import { replyToThread } from '@/app/(portal)/inbox/actions'

/** One inbound WhatsApp message as the webhook would hand it over. */
async function patientSends(
  clinicId: string,
  text: string,
  opts: { phone?: string; conversationId?: string; waMessageId?: string } = {},
) {
  return handleTextMessage({
    clinicId,
    conversationId: opts.conversationId ?? `conv-${clinicId}`,
    waPhone: opts.phone ?? PHONE,
    text,
    waMessageId: opts.waMessageId,
  })
}

function form(entries: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  clock = 0
  seq = 0
  sendMessageMock.mockResolvedValue({ ok: true })
  db = {
    clinics: [
      { id: CLINIC_A, timezone: 'Asia/Kolkata' },
      { id: CLINIC_B, timezone: 'Asia/Kolkata' },
    ],
    wa_sessions: [],
    patients: [],
    doctor_profiles: [],
    patient_threads: [],
    patient_messages: [],
    appointments: [],
  }
})

describe('capture → inbox → reply (one database, both paths)', () => {
  it('carries a patient doubt from WhatsApp to the staff reply', async () => {
    // 1. The patient messages the clinic's WhatsApp with free text.
    const ack = await patientSends(CLINIC_A, DOUBT, { waMessageId: 'wamid-1' })

    expect(ack?.body).toContain('received your message')
    // First ever message, so the one-time logging notice rides along.
    expect(ack?.body).toContain('seen by the clinic staff')

    // Exactly ONE inbound row for that (clinic, patient), stored verbatim.
    const patient = db.patients[0]
    expect(db.patients).toHaveLength(1)
    expect(patient.clinic_id).toBe(CLINIC_A)
    expect(patient.wa_phone).toBe(PHONE)

    const stored = db.patient_messages.filter(
      (m) => m.clinic_id === CLINIC_A && m.patient_id === patient.id,
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      direction: 'inbound',
      body: DOUBT,
      wa_delivery_id: 'wamid-1',
      sent_by: null,
    })

    // 2. Staff open the inbox and see the thread waiting.
    const threads = await listThreads(CLINIC_A)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      status: 'open',
      unreadCount: 1,
      patientId: patient.id,
      patientPhone: PHONE,
      lastMessagePreview: DOUBT,
    })

    // 3. Staff reply inside the 24h window.
    const replyResult = await replyToThread(
      form({ threadId: threads[0].id, body: '  Yes, it is safe.  ' }),
    )
    expect(replyResult.error).toBeNull()

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock.mock.calls[0][0]).toEqual({
      kind: 'text',
      to: PHONE,
      body: 'Yes, it is safe.',
    })

    const outbound = db.patient_messages.filter(
      (m) => m.direction === 'outbound',
    )
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toMatchObject({
      clinic_id: CLINIC_A,
      patient_id: patient.id,
      body: 'Yes, it is safe.',
      sent_by: 'user-staff',
    })

    // Replying is reading: the badge is cleared.
    const afterReply = await listThreads(CLINIC_A)
    expect(afterReply[0].unreadCount).toBe(0)

    // 4. The timeline shows the doubt and the answer, in order.
    const timeline = await getThreadTimeline(
      CLINIC_A,
      patient.id as string,
      'Asia/Kolkata',
    )
    expect(
      timeline.map((e) => [e.kind, e.kind === 'message' ? e.direction : null]),
    ).toEqual([
      ['message', 'inbound'],
      ['message', 'outbound'],
    ])
    expect(timeline.map((e) => (e.kind === 'message' ? e.body : null))).toEqual([
      DOUBT,
      'Yes, it is safe.',
    ])
  })

  it('bumps the unread count on a follow-up without a second thread', async () => {
    await patientSends(CLINIC_A, DOUBT)
    const second = await patientSends(CLINIC_A, 'Still a little sore.')

    // Not the first message any more: no repeated logging notice.
    expect(second?.body).not.toContain('seen by the clinic staff')

    const threads = await listThreads(CLINIC_A)
    expect(threads).toHaveLength(1)
    expect(threads[0].unreadCount).toBe(2)
    expect(threads[0].lastMessagePreview).toBe('Still a little sore.')
    expect(db.patient_messages).toHaveLength(2)
  })
})

describe('clinic isolation across the capture and portal paths (R8)', () => {
  it("one clinic's capture is invisible to another clinic's inbox", async () => {
    await patientSends(CLINIC_A, DOUBT)

    expect(await listThreads(CLINIC_B)).toEqual([])

    const patientA = db.patients[0]
    expect(
      await getThreadTimeline(CLINIC_B, patientA.id as string, 'Asia/Kolkata'),
    ).toEqual([])
  })

  it('the same phone under two clinics is two patients and two threads', async () => {
    await patientSends(CLINIC_A, DOUBT, { conversationId: 'conv-a' })
    await patientSends(CLINIC_B, 'Different clinic, same number.', {
      conversationId: 'conv-b',
    })

    // patients is UNIQUE (clinic_id, wa_phone), so the number is a
    // separate record per clinic — never a shared cross-tenant patient.
    expect(db.patients).toHaveLength(2)
    expect(new Set(db.patients.map((p) => p.id)).size).toBe(2)
    expect(db.patients.map((p) => p.clinic_id)).toEqual([CLINIC_A, CLINIC_B])
    expect(new Set(db.patients.map((p) => p.wa_phone))).toEqual(
      new Set([PHONE]),
    )

    const [a] = await listThreads(CLINIC_A)
    const [b] = await listThreads(CLINIC_B)
    expect(a.id).not.toBe(b.id)
    expect(a.patientId).not.toBe(b.patientId)
    expect(a.lastMessagePreview).toBe(DOUBT)
    expect(b.lastMessagePreview).toBe('Different clinic, same number.')
  })

  it("a reply cannot be aimed at another clinic's thread", async () => {
    await patientSends(CLINIC_B, DOUBT)
    const [threadB] = await listThreads(CLINIC_B)

    // The staff identity is clinic A's; clinic B's thread id resolves to
    // nothing, so nothing is sent and nothing is stored.
    const result = await replyToThread(
      form({ threadId: threadB.id, body: 'Hello?' }),
    )
    expect(result.error).toMatch(/thread not found/)

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(db.patient_messages.filter((m) => m.direction === 'outbound')).toEqual(
      [],
    )
  })
})
