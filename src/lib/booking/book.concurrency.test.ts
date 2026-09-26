import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Concurrency / no-double-booking integration test (E2-T3).
 *
 * This is the ONE guarantee that cannot be unit-tested with mocks: that
 * the database itself refuses two overlapping active appointments for the
 * same doctor. It exercises the real `book_appointment` RPC (migration
 * 004) against the real `btree_gist` exclusion constraint (migration 002)
 * by firing two bookings at the SAME slot concurrently and asserting
 * exactly one wins.
 *
 * ── Safety / how to run ──────────────────────────────────────────────
 * Gated behind TEST_DATABASE_URL so it NEVER touches a real/cloud DB by
 * accident. With the var unset (the default — including plain `npm test`)
 * the whole suite is skipped. To run it, point it at a THROWAWAY database
 * (e.g. a local `supabase start` stack) with all migrations applied:
 *
 *   TEST_DATABASE_URL=http://127.0.0.1:54321 \
 *   TEST_DATABASE_SERVICE_KEY=<local service_role key> \
 *   npx vitest run src/lib/booking/book.concurrency.test.ts
 *
 * The test creates its own throwaway clinic + doctor and deletes
 * everything it created in afterAll — but never run it against a database
 * holding data you care about.
 */

const DB_URL = process.env.TEST_DATABASE_URL
const DB_KEY = process.env.TEST_DATABASE_SERVICE_KEY
const ENABLED = Boolean(DB_URL && DB_KEY)

// A unique marker so fixtures are identifiable and cleanup is precise.
const TAG = `e2e-concurrency-${Date.now()}`

interface Fixture {
  clinicId: string
  doctorId: string
  memberId: string
  userId: string
}

describe.skipIf(!ENABLED)('book_appointment — concurrency (real DB)', () => {
  let db: SupabaseClient
  let fx: Fixture

  beforeAll(async () => {
    db = createClient(DB_URL!, DB_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    fx = await createFixture(db)
  })

  afterAll(async () => {
    if (fx) await destroyFixture(db, fx)
  })

  it('two concurrent bookings for the same slot → exactly one wins', async () => {
    const startsAt = '2099-01-05T09:00:00.000Z' // far future, weekday, no clash
    const endsAt = '2099-01-05T09:30:00.000Z'

    const attempt = (phone: string) =>
      db.rpc('book_appointment', {
        p_clinic_id: fx.clinicId,
        p_doctor_id: fx.doctorId,
        p_wa_phone: phone,
        p_starts_at: startsAt,
        p_ends_at: endsAt,
        p_service_id: null,
        p_patient_name: null,
        p_created_via: 'whatsapp',
      })

    // Fire both at once — the DB exclusion constraint arbitrates.
    const [a, b] = await Promise.all([
      attempt('+919000000001'),
      attempt('+919000000002'),
    ])

    expect(a.error).toBeNull()
    expect(b.error).toBeNull()

    const outcomes = [rowOutcome(a.data), rowOutcome(b.data)].sort()
    // Exactly one 'booked' and one 'slot_taken'.
    expect(outcomes).toEqual(['booked', 'slot_taken'])
  })

  it('an overlapping (not identical) slot is also rejected', async () => {
    // First booking 10:00–10:30.
    const first = await db.rpc('book_appointment', {
      p_clinic_id: fx.clinicId,
      p_doctor_id: fx.doctorId,
      p_wa_phone: '+919000000010',
      p_starts_at: '2099-01-06T10:00:00.000Z',
      p_ends_at: '2099-01-06T10:30:00.000Z',
      p_service_id: null,
      p_patient_name: null,
      p_created_via: 'whatsapp',
    })
    expect(rowOutcome(first.data)).toBe('booked')

    // Overlapping 10:15–10:45 for the same doctor → slot_taken.
    const overlap = await db.rpc('book_appointment', {
      p_clinic_id: fx.clinicId,
      p_doctor_id: fx.doctorId,
      p_wa_phone: '+919000000011',
      p_starts_at: '2099-01-06T10:15:00.000Z',
      p_ends_at: '2099-01-06T10:45:00.000Z',
      p_service_id: null,
      p_patient_name: null,
      p_created_via: 'whatsapp',
    })
    expect(rowOutcome(overlap.data)).toBe('slot_taken')
  })
})

// ------------------------------------------------------------
// Helpers.
// ------------------------------------------------------------
function rowOutcome(data: unknown): string {
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string }
    | undefined
  return row?.outcome ?? 'missing'
}

/**
 * Create a throwaway clinic + doctor (auth user → users → member →
 * profile). Returns the ids needed to book and to clean up.
 */
async function createFixture(db: SupabaseClient): Promise<Fixture> {
  const { data: clinic, error: cErr } = await db
    .from('clinics')
    .insert({ name: TAG, slug: TAG, timezone: 'Asia/Kolkata' })
    .select('id')
    .single()
  if (cErr || !clinic) throw new Error(`fixture clinic: ${cErr?.message}`)
  const clinicId = clinic.id as string

  // Auth user (service role) → mirrored users row.
  const { data: authUser, error: uErr } = await db.auth.admin.createUser({
    email: `${TAG}@example.test`,
    password: `pw-${TAG}`,
    email_confirm: true,
  })
  if (uErr || !authUser.user) throw new Error(`fixture user: ${uErr?.message}`)
  const userId = authUser.user.id

  await db.from('users').insert({ id: userId, full_name: 'Fixture Doctor', email: `${TAG}@example.test` })

  const { data: member, error: mErr } = await db
    .from('clinic_members')
    .insert({ clinic_id: clinicId, user_id: userId, role: 'doctor', status: 'active' })
    .select('id')
    .single()
  if (mErr || !member) throw new Error(`fixture member: ${mErr?.message}`)
  const memberId = member.id as string

  const { data: profile, error: pErr } = await db
    .from('doctor_profiles')
    .insert({ clinic_member_id: memberId, clinic_id: clinicId, slot_duration_minutes: 30 })
    .select('id')
    .single()
  if (pErr || !profile) throw new Error(`fixture profile: ${pErr?.message}`)

  return { clinicId, doctorId: profile.id as string, memberId, userId }
}

/**
 * Delete everything the fixture created. ON DELETE CASCADE on clinic_id
 * clears appointments/patients/members/profiles; we then remove the auth
 * user (and its mirrored users row cascades from auth.users).
 */
async function destroyFixture(db: SupabaseClient, fx: Fixture): Promise<void> {
  await db.from('clinics').delete().eq('id', fx.clinicId)
  await db.auth.admin.deleteUser(fx.userId).catch(() => {})
}
