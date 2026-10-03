import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Patient-messaging tenancy + RPC integration test (T5, requirement R8).
 *
 * The two things in this feature that mocks cannot prove live in SQL:
 * the `capture_patient_message` function from migration 011 (three
 * writes in one transaction, UNIQUE (clinic_id, patient_id) on the
 * thread, never de-escalating) and the RLS policies that stop one
 * clinic's staff reading another clinic's messages. No test run applies
 * migrations, so this is the only honest check of either.
 *
 * ── Safety / how to run ──────────────────────────────────────────────
 * Gated behind TEST_DATABASE_URL so it NEVER touches a real/cloud DB by
 * accident. With the var unset (the default — including plain
 * `npm test`) the whole suite is skipped. To run it, point it at a
 * THROWAWAY stack with every migration applied:
 *
 *   supabase start
 *   supabase db push            # must include 011_patient_messaging.sql
 *   TEST_DATABASE_URL=http://127.0.0.1:54321 \
 *   TEST_DATABASE_SERVICE_KEY=<local service_role key> \
 *   npx vitest run src/lib/messaging/tenancy.db.test.ts
 *
 * The fixture creates TWO throwaway clinics (each with a member + doctor
 * profile) tagged with a unique marker and deletes them in afterAll —
 * but never run it against a database holding data you care about.
 *
 * The RLS half signs a real user in. A signed-in supabase-js client
 * sends that user's JWT as the Authorization bearer instead of the
 * service key, so PostgREST runs the request as `authenticated` and the
 * policies from migration 011 actually apply.
 */

const DB_URL = process.env.TEST_DATABASE_URL
const DB_KEY = process.env.TEST_DATABASE_SERVICE_KEY
const ENABLED = Boolean(DB_URL && DB_KEY)

// A unique marker so fixtures are identifiable and cleanup is precise.
const TAG = `e2e-messaging-${Date.now()}`
const PASSWORD = `pw-${TAG}`

/** Same number in both clinics — patients is UNIQUE (clinic_id, wa_phone). */
const PATIENT_PHONE = `+9199${String(Date.now()).slice(-8)}`

interface ClinicFixture {
  clinicId: string
  doctorId: string
  userId: string
  email: string
}

interface Fixture {
  a: ClinicFixture
  b: ClinicFixture
}

describe.skipIf(!ENABLED)('patient messaging — tenancy (real DB)', () => {
  let db: SupabaseClient
  let fx: Fixture

  beforeAll(async () => {
    db = createClient(DB_URL!, DB_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    fx = {
      a: await createClinicFixture(db, 'a'),
      b: await createClinicFixture(db, 'b'),
    }
  })

  afterAll(async () => {
    if (fx) {
      await destroyClinicFixture(db, fx.a)
      await destroyClinicFixture(db, fx.b)
    }
  })

  it('capture_patient_message creates the patient, the message and the thread', async () => {
    const first = await capture(db, fx.a.clinicId, 'Is the ointment safe?')
    expect(first.error).toBeNull()

    const row = rpcRow(first.data)
    expect(row.patient_id).toBeTruthy()
    expect(row.message_id).toBeTruthy()
    expect(row.is_first_message).toBe(true)

    const { data: patient } = await db
      .from('patients')
      .select('id, wa_phone')
      .eq('clinic_id', fx.a.clinicId)
      .eq('wa_phone', PATIENT_PHONE)
      .maybeSingle()
    expect(patient?.id).toBe(row.patient_id)

    const { data: messages } = await db
      .from('patient_messages')
      .select('id, direction, body, wa_delivery_id, sent_by')
      .eq('clinic_id', fx.a.clinicId)
      .eq('patient_id', row.patient_id)
    expect(messages).toHaveLength(1)
    expect(messages![0]).toMatchObject({
      direction: 'inbound',
      body: 'Is the ointment safe?',
      sent_by: null,
    })

    const { data: threads } = await db
      .from('patient_threads')
      .select('id, status, unread_count, last_message_at')
      .eq('clinic_id', fx.a.clinicId)
      .eq('patient_id', row.patient_id)
    expect(threads).toHaveLength(1)
    expect(threads![0].status).toBe('open')
    expect(threads![0].unread_count).toBe(1)
    expect(threads![0].last_message_at).toBeTruthy()
  })

  it('a second message increments unread_count without a second thread', async () => {
    const second = await capture(db, fx.a.clinicId, 'Still a little sore.')
    expect(second.error).toBeNull()

    const row = rpcRow(second.data)
    // Same patient, and no longer the first message.
    expect(row.is_first_message).toBe(false)

    const { data: threads } = await db
      .from('patient_threads')
      .select('id, unread_count')
      .eq('clinic_id', fx.a.clinicId)
      .eq('patient_id', row.patient_id)
    // UNIQUE (clinic_id, patient_id) holds: one thread, count bumped.
    expect(threads).toHaveLength(1)
    expect(threads![0].unread_count).toBe(2)

    const { data: messages } = await db
      .from('patient_messages')
      .select('id')
      .eq('clinic_id', fx.a.clinicId)
      .eq('patient_id', row.patient_id)
    expect(messages).toHaveLength(2)
  })

  it('an escalated thread stays escalated after a new inbound message', async () => {
    const { data: before } = await db
      .from('patient_threads')
      .select('id, patient_id')
      .eq('clinic_id', fx.a.clinicId)
      .limit(1)
      .maybeSingle()
    expect(before?.id).toBeTruthy()

    await db
      .from('patient_threads')
      .update({
        status: 'escalated',
        escalated_to_doctor_id: fx.a.doctorId,
      })
      .eq('id', before!.id)
      .eq('clinic_id', fx.a.clinicId)

    const again = await capture(db, fx.a.clinicId, 'Any update, doctor?')
    expect(again.error).toBeNull()

    const { data: after } = await db
      .from('patient_threads')
      .select('status, escalated_to_doctor_id, unread_count')
      .eq('id', before!.id)
      .maybeSingle()
    // A follow-up must never silently undo a doctor hand-off.
    expect(after?.status).toBe('escalated')
    expect(after?.escalated_to_doctor_id).toBe(fx.a.doctorId)
    expect(after?.unread_count).toBe(3)
  })

  it("RLS hides another clinic's messages from an authenticated member (R8)", async () => {
    // Both clinics now have a captured message from the same number.
    const inB = await capture(db, fx.b.clinicId, 'Clinic B private doubt.')
    expect(inB.error).toBeNull()

    const asA = createClient(DB_URL!, DB_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const signIn = await asA.auth.signInWithPassword({
      email: fx.a.email,
      password: PASSWORD,
    })
    expect(signIn.error).toBeNull()

    // Own clinic: visible.
    const ownThreads = await asA
      .from('patient_threads')
      .select('id')
      .eq('clinic_id', fx.a.clinicId)
    expect(ownThreads.error).toBeNull()
    expect(ownThreads.data?.length).toBeGreaterThan(0)

    const ownMessages = await asA
      .from('patient_messages')
      .select('id')
      .eq('clinic_id', fx.a.clinicId)
    expect(ownMessages.error).toBeNull()
    expect(ownMessages.data?.length).toBeGreaterThan(0)

    // Other clinic: zero rows, not an error — the policy filters them out.
    const otherThreads = await asA
      .from('patient_threads')
      .select('id')
      .eq('clinic_id', fx.b.clinicId)
    expect(otherThreads.error).toBeNull()
    expect(otherThreads.data).toEqual([])

    const otherMessages = await asA
      .from('patient_messages')
      .select('id')
      .eq('clinic_id', fx.b.clinicId)
    expect(otherMessages.error).toBeNull()
    expect(otherMessages.data).toEqual([])

    // Unfiltered reads see only clinic A's rows, so a forgotten
    // clinic_id filter still cannot leak another tenant.
    const allThreads = await asA.from('patient_threads').select('clinic_id')
    expect(
      (allThreads.data ?? []).every((r) => r.clinic_id === fx.a.clinicId),
    ).toBe(true)

    await asA.auth.signOut()
  })
})

// ------------------------------------------------------------
// Helpers.
// ------------------------------------------------------------
interface CaptureRow {
  patient_id: string
  message_id: string
  is_first_message: boolean
}

function capture(db: SupabaseClient, clinicId: string, body: string) {
  return db.rpc('capture_patient_message', {
    p_clinic_id: clinicId,
    p_wa_phone: PATIENT_PHONE,
    p_body: body,
    p_wa_delivery_id: null,
  })
}

function rpcRow(data: unknown): CaptureRow {
  const row = (Array.isArray(data) ? data[0] : data) as CaptureRow | undefined
  if (!row) throw new Error('capture_patient_message returned no row')
  return row
}

/**
 * Create a throwaway clinic with one active doctor member (auth user →
 * users → clinic_members → doctor_profiles), the minimum needed for
 * is_clinic_member() to be true for that user.
 */
async function createClinicFixture(
  db: SupabaseClient,
  suffix: string,
): Promise<ClinicFixture> {
  const slug = `${TAG}-${suffix}`
  const email = `${slug}@example.test`

  const { data: clinic, error: cErr } = await db
    .from('clinics')
    .insert({ name: slug, slug, timezone: 'Asia/Kolkata' })
    .select('id')
    .single()
  if (cErr || !clinic) throw new Error(`fixture clinic: ${cErr?.message}`)
  const clinicId = clinic.id as string

  const { data: authUser, error: uErr } = await db.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (uErr || !authUser.user) throw new Error(`fixture user: ${uErr?.message}`)
  const userId = authUser.user.id

  await db
    .from('users')
    .insert({ id: userId, full_name: `Fixture Doctor ${suffix}`, email })

  const { data: member, error: mErr } = await db
    .from('clinic_members')
    .insert({
      clinic_id: clinicId,
      user_id: userId,
      role: 'doctor',
      status: 'active',
    })
    .select('id')
    .single()
  if (mErr || !member) throw new Error(`fixture member: ${mErr?.message}`)

  const { data: profile, error: pErr } = await db
    .from('doctor_profiles')
    .insert({
      clinic_member_id: member.id as string,
      clinic_id: clinicId,
      slot_duration_minutes: 30,
    })
    .select('id')
    .single()
  if (pErr || !profile) throw new Error(`fixture profile: ${pErr?.message}`)

  return { clinicId, doctorId: profile.id as string, userId, email }
}

/**
 * Delete everything the fixture created. ON DELETE CASCADE on clinic_id
 * clears patients/messages/threads/members/profiles; we then remove the
 * auth user (its mirrored users row cascades from auth.users).
 */
async function destroyClinicFixture(
  db: SupabaseClient,
  fx: ClinicFixture,
): Promise<void> {
  await db.from('clinics').delete().eq('id', fx.clinicId)
  await db.auth.admin.deleteUser(fx.userId).catch(() => {})
}
