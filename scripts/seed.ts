/**
 * Demo seed — one clinic, a WhatsApp number, two doctors (each with
 * availability rules), and a couple of services. Enough to exercise the
 * WhatsApp booking flow end to end.
 *
 * Idempotent: safe to re-run. Uses the service-role key (bypasses RLS).
 * Reads env from .env.local.
 *
 * Run:  npm run seed
 *
 * NOTE: patients are NOT seeded — they're created by the booking flow
 * when a real WhatsApp number books. Set the clinic's phone_number_id
 * below to the Meta phone_number_id of the WhatsApp number wired to
 * this demo (via wacrm).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz'

// ---- Minimal .env.local loader (no dotenv dependency) --------------
function loadEnv() {
  try {
    const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // no .env.local — rely on real env
  }
}
loadEnv()

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !SERVICE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local',
  )
  process.exit(1)
}

const db: SupabaseClient = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ---- Config you can tweak ------------------------------------------
const CLINIC = {
  name: 'Demo Clinic',
  slug: 'demo-clinic',
  timezone: 'Asia/Kolkata',
}
// Set this to the Meta phone_number_id of your demo WhatsApp number.
const PHONE_NUMBER_ID = process.env.DEMO_PHONE_NUMBER_ID ?? 'demo-phone-number-id'

// wacrm account id for this clinic (one wacrm account per clinic). This
// is the `account_id` wacrm stamps on every inbound webhook; it routes
// the inbound event to this clinic. Set DEMO_WACRM_ACCOUNT_ID to your
// real wacrm account id so live inbound messages resolve to the demo clinic.
const WACRM_ACCOUNT_ID =
  process.env.DEMO_WACRM_ACCOUNT_ID ?? 'demo-wacrm-account-id'

// Password set on every seeded doctor account so you can log in to the
// staff portal. Override with DEMO_PASSWORD in .env.local. This is demo
// data only — never use a shared/known password for real accounts.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123'

const DOCTORS = [
  { email: 'dr.rao@demo.clinic', name: 'Dr. Rao', specialty: 'General', slot: 30 },
  { email: 'dr.iyer@demo.clinic', name: 'Dr. Iyer', specialty: 'Pediatrics', slot: 20 },
]

const SERVICES = [
  { name: 'General consultation', price_cents: 50000 },
  { name: 'Follow-up', price_cents: 30000 },
]

// Mon-Fri 09:00-13:00 and 17:00-20:00 for every doctor.
const WEEKDAYS = [1, 2, 3, 4, 5]
const WINDOWS = [
  { start: '09:00', end: '13:00' },
  { start: '17:00', end: '20:00' },
]

// ---- Helpers -------------------------------------------------------
async function upsertAuthUser(email: string, name: string): Promise<string> {
  // Try to find an existing user by listing (demo scale is tiny).
  const { data: list } = await db.auth.admin.listUsers()
  const existing = list?.users.find((u) => u.email === email)
  if (existing) {
    // Ensure the demo password is set (accounts created before this
    // change had no password and so couldn't log in to the portal).
    await db.auth.admin.updateUserById(existing.id, {
      password: DEMO_PASSWORD,
      email_confirm: true,
    })
    return existing.id
  }

  const { data, error } = await db.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name },
  })
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`)
  return data.user.id
}

// A few demo patients (wa_phone is the natural key per clinic).
const DEMO_PATIENTS = [
  { wa_phone: '+919000000001', name: 'Asha Menon' },
  { wa_phone: '+919000000002', name: 'Vikram Shah' },
  { wa_phone: '+919000000003', name: 'Priya Nair' },
]

/**
 * Book demo appointments for TODAY (in the clinic timezone) so the staff
 * portal dashboard isn't empty. Uses the book_appointment RPC — the same
 * transactional path the WhatsApp flow uses — so the no-overlap guard and
 * patient upsert behave exactly as in production. Idempotent: a slot that
 * already exists comes back as 'slot_taken' and is skipped.
 *
 * Note: today must be a weekday the doctors have availability for
 * (seed availability is Mon–Fri). On a weekend, no slots are booked and
 * you'll want to pick a weekday date in the dashboard's date picker.
 */
async function seedAppointments(
  clinicId: string,
  doctors: Array<{ id: string; slot: number }>,
): Promise<void> {
  const tz = CLINIC.timezone
  const todayYmd = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd')

  // Morning start times (clinic-local) inside the 09:00–13:00 window.
  const startTimes = ['09:00', '09:30', '10:00']

  let booked = 0
  let skipped = 0

  for (let di = 0; di < doctors.length; di++) {
    const doctor = doctors[di]
    // Give each doctor a different patient/time so nothing collides.
    const patient = DEMO_PATIENTS[di % DEMO_PATIENTS.length]
    const startLocal = startTimes[di % startTimes.length]

    const startsAt = fromZonedTime(`${todayYmd}T${startLocal}:00`, tz)
    const endsAt = new Date(startsAt.getTime() + doctor.slot * 60_000)

    const { data, error } = await db.rpc('book_appointment', {
      p_clinic_id: clinicId,
      p_doctor_id: doctor.id,
      p_wa_phone: patient.wa_phone,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_service_id: null,
      p_patient_name: patient.name,
      p_created_via: 'portal',
    })

    if (error) {
      console.warn(`  appt skipped (${patient.name}): ${error.message}`)
      continue
    }
    const row = Array.isArray(data) ? data[0] : data
    if (row?.outcome === 'booked') booked++
    else skipped++
  }

  console.log(
    `  appointments for ${todayYmd}: ${booked} booked, ${skipped} already existed`,
  )
}

async function main() {
  console.log('Seeding demo clinic...')

  // 1. Clinic (upsert by slug)
  const { data: clinic, error: cErr } = await db
    .from('clinics')
    .upsert(CLINIC, { onConflict: 'slug' })
    .select()
    .single()
  if (cErr || !clinic) throw new Error(`clinic: ${cErr?.message}`)
  const clinicId = clinic.id as string
  console.log(`  clinic ${clinicId}`)

  // 2. WhatsApp number (upsert by phone_number_id)
  const { error: wErr } = await db
    .from('clinic_whatsapp_numbers')
    .upsert(
      { clinic_id: clinicId, phone_number_id: PHONE_NUMBER_ID, status: 'active' },
      { onConflict: 'phone_number_id' },
    )
  if (wErr) throw new Error(`wa number: ${wErr.message}`)
  console.log(`  wa number ${PHONE_NUMBER_ID}`)

  // 2b. wacrm account -> clinic mapping (tenant router for the wacrm
  //     webhook). Upsert by wacrm_account_id so re-runs are idempotent.
  const { error: waAcctErr } = await db
    .from('clinic_wacrm_accounts')
    .upsert(
      { clinic_id: clinicId, wacrm_account_id: WACRM_ACCOUNT_ID, status: 'active' },
      { onConflict: 'wacrm_account_id' },
    )
  if (waAcctErr) throw new Error(`wacrm account: ${waAcctErr.message}`)
  console.log(`  wacrm account ${WACRM_ACCOUNT_ID}`)

  // 3. Services (upsert-ish: skip if a same-named one exists)
  for (const s of SERVICES) {
    const { data: existing } = await db
      .from('services')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('name', s.name)
      .maybeSingle()
    if (!existing) {
      await db.from('services').insert({ clinic_id: clinicId, ...s })
    }
  }
  console.log(`  ${SERVICES.length} services`)

  // 4. Doctors: auth user -> users row -> member -> profile -> availability
  const doctorIds: Array<{ id: string; slot: number }> = []
  for (const d of DOCTORS) {
    const userId = await upsertAuthUser(d.email, d.name)

    await db
      .from('users')
      .upsert({ id: userId, full_name: d.name, email: d.email }, { onConflict: 'id' })

    const { data: member, error: mErr } = await db
      .from('clinic_members')
      .upsert(
        { clinic_id: clinicId, user_id: userId, role: 'doctor', status: 'active' },
        { onConflict: 'clinic_id,user_id' },
      )
      .select()
      .single()
    if (mErr || !member) throw new Error(`member ${d.email}: ${mErr?.message}`)

    const { data: profile, error: pErr } = await db
      .from('doctor_profiles')
      .upsert(
        {
          clinic_member_id: member.id,
          clinic_id: clinicId,
          specialty: d.specialty,
          slot_duration_minutes: d.slot,
        },
        { onConflict: 'clinic_member_id' },
      )
      .select()
      .single()
    if (pErr || !profile) throw new Error(`profile ${d.email}: ${pErr?.message}`)
    const doctorId = profile.id as string

    // Availability: clear this doctor's rules, then insert fresh.
    await db.from('availability_rules').delete().eq('doctor_id', doctorId)
    const rules = WEEKDAYS.flatMap((weekday) =>
      WINDOWS.map((w) => ({
        clinic_id: clinicId,
        doctor_id: doctorId,
        weekday,
        start_time: w.start,
        end_time: w.end,
        active: true,
      })),
    )
    const { error: rErr } = await db.from('availability_rules').insert(rules)
    if (rErr) throw new Error(`rules ${d.email}: ${rErr.message}`)

    doctorIds.push({ id: doctorId, slot: d.slot })
    console.log(`  doctor ${d.name} (${doctorId}) + ${rules.length} rules`)
  }

  // 5. Demo appointments for TODAY (clinic-local), so the staff portal
  //    dashboard has something to show. Booked via the same RPC the real
  //    flow uses, so the no-overlap guard and patient upsert apply.
  //    Idempotent: re-running returns 'slot_taken' for existing slots.
  await seedAppointments(clinicId, doctorIds)

  console.log('Seed complete.')
  console.log('\nStaff portal logins (email / password):')
  for (const d of DOCTORS) {
    console.log(`  ${d.email}  /  ${DEMO_PASSWORD}`)
  }
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
