import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { resolveClinicIdByWacrmAccount } from '@/lib/clinics/resolve-by-account'
import {
  loadAvailableDays,
  loadDoctorOptions,
  loadDoctorSlotMinutes,
} from '@/lib/whatsapp/query'
import { generateSlots } from '@/lib/availability/slot-generation'
import { bookAppointment } from '@/lib/booking/book'
import { listClinicDoctors } from './availability'
import { createInvite, acceptInvite } from './invites'
import { generateInviteToken, hashInviteToken } from './invite-token'
import { validateSlug } from './onboarding-validate'
import { getSetupStatus } from './setup-status'
import { removeDoctorProfile, upsertDoctorProfile } from './staff'
import type { MemberRole } from '@/types'

/**
 * Self-serve onboarding integration suite (design §13.2, cases 1–25b).
 *
 * The three things in this feature that mocks cannot prove live in the
 * database: the RPC transactions from 012/013/014
 * (create_clinic_with_owner, connect_wacrm_account, accept_clinic_invite,
 * set_doctor_services), the two guard triggers, and the member-read /
 * admin-write policy split 014 installs over seven live tables. No test
 * run applies migrations, so this is the only honest check of any of them.
 *
 * ── Safety / how to run ──────────────────────────────────────────────
 * Gated on THREE vars so it NEVER touches a real/cloud DB by accident.
 * With any of them unset (the default — including plain `npm test`) the
 * whole suite is skipped. To run it, point it at a THROWAWAY stack with
 * every migration applied:
 *
 *   supabase start
 *   supabase db push            # must include 012, 013 and 014
 *   TEST_DATABASE_URL=http://127.0.0.1:54321 \
 *   TEST_DATABASE_SERVICE_KEY=<local service_role key> \
 *   TEST_DATABASE_ANON_KEY=<local anon key> \
 *   npx vitest run src/lib/portal/onboarding.integration.test.ts
 *
 * The ANON key is MANDATORY, not optional. The service-role client
 * bypasses RLS, so running the isolation cases (5, 14, 15, 22) with it
 * would turn the entire multi-tenant story into vacuous passes: every
 * authorization case here signs a real user in and talks to PostgREST
 * with that user's JWT, which is the only way the 014 policies and the
 * `is_clinic_admin` gate are actually evaluated.
 *
 * Fixtures are tagged `e2e-onboarding-<timestamp>`; afterAll deletes
 * CLINICS FIRST, then auth users — the same discipline as
 * book.concurrency.test.ts, and case 17 is what proves that teardown can
 * complete at all. Never run this against a database holding data you
 * care about.
 */

const DB_URL = process.env.TEST_DATABASE_URL
const DB_KEY = process.env.TEST_DATABASE_SERVICE_KEY
const ANON_KEY = process.env.TEST_DATABASE_ANON_KEY
const ENABLED = Boolean(DB_URL && DB_KEY && ANON_KEY)

/** A unique marker so fixtures are identifiable and cleanup is precise. */
const TAG = `e2e-onboarding-${Date.now()}`
const PASSWORD = `pw-${TAG}`
const TZ = 'Asia/Kolkata'
/** Digits-only stem for the ids whose validators demand digits. */
const DIGITS = String(Date.now()).slice(-9)

// ------------------------------------------------------------
// The RLS cookie client, replaced by a real session client.
//
// Every module under test that writes as a logged-in user goes through
// createClient() from '@/lib/supabase/server', which reads next/headers
// cookies — unavailable here. The mock hands back a REAL supabase-js
// client carrying a REAL user JWT, so the library code runs unchanged
// against the real database with RLS in force.
// ------------------------------------------------------------
const sessionWiring = vi.hoisted(() => ({
  factory: null as null | (() => Promise<unknown>),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    if (!sessionWiring.factory) {
      throw new Error('no session wired into the mocked server client')
    }
    return sessionWiring.factory()
  },
}))

/** Run the next library call as this signed-in user. */
function actAs(client: SupabaseClient): void {
  sessionWiring.factory = async () => client
}

/**
 * Run the next library call as a brand-new visitor with no session —
 * what acceptInvite() needs, since it signs in on the client it builds.
 */
function actAsNewVisitor(): void {
  sessionWiring.factory = async () => anonClient()
}

interface Member {
  userId: string
  email: string
  memberId: string
  fullName: string
  profileId: string | null
}

interface Clinic {
  clinicId: string
  slug: string
  admin: Member
  /** The founding admin's session. */
  client: SupabaseClient
}

interface OutcomeRow {
  outcome: string
}
interface CreateClinicRow extends OutcomeRow {
  clinic_id: string | null
  member_id: string | null
}
interface AcceptInviteRow extends OutcomeRow {
  clinic_id: string | null
  member_id: string | null
}
interface SetDoctorServicesRow extends OutcomeRow {
  linked: number
}

let db: SupabaseClient
const createdClinics: string[] = []
const createdUsers: string[] = []
let seq = 0

describe.skipIf(!ENABLED)('self-serve onboarding (real DB)', () => {
  beforeAll(() => {
    db = createClient(DB_URL!, DB_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // The WhatsApp-path libraries (resolve-by-account, whatsapp/query,
    // slot-generation, booking) build their own service-role client from
    // the app's env vars, and invites.ts needs a base URL for the link.
    process.env.NEXT_PUBLIC_SUPABASE_URL = DB_URL
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY
    process.env.SUPABASE_SERVICE_ROLE_KEY = DB_KEY
    process.env.NEXT_PUBLIC_APP_URL = 'https://onboarding.e2e.test'
  })

  afterAll(async () => {
    // Clinics first: the cascade clears members, profiles, invites,
    // services, availability, patients and appointments. Only then can the
    // auth users go, which cascade users -> clinic_members.
    for (const clinicId of createdClinics) {
      await db.from('clinics').delete().eq('id', clinicId)
    }
    for (const userId of createdUsers) {
      await db.auth.admin.deleteUser(userId).catch(() => {})
    }
  })

  // ==========================================================
  // Clinic creation — cases 1, 2, 3, 3b, 4, 5.
  // ==========================================================
  describe('clinic creation', () => {
    it('case 1 — create_clinic_with_owner, explicit p_full_name branch', async () => {
      // No user_metadata at all: the typed name is the only source.
      const user = await createAuthUser('c1a', null)
      const client = await sessionClient(user.email)
      const slug = slugFor('c1a')

      const row = rpcRow<CreateClinicRow>(
        await client.rpc('create_clinic_with_owner', {
          p_name: `Case One A ${TAG}`,
          p_slug: slug,
          p_timezone: TZ,
          p_full_name: 'Explicit Typed Name',
        }),
        'create_clinic_with_owner',
      )
      expect(row.outcome).toBe('created')
      expect(row.clinic_id).toBeTruthy()
      createdClinics.push(row.clinic_id!)

      const { data: members } = await db
        .from('clinic_members')
        .select('id, user_id, role, status')
        .eq('clinic_id', row.clinic_id!)
      expect(members).toHaveLength(1)
      expect(members![0]).toMatchObject({
        user_id: user.userId,
        role: 'admin',
        status: 'active',
      })
      expect(members![0].id).toBe(row.member_id)

      const { data: mirrored } = await db
        .from('users')
        .select('full_name, email')
        .eq('id', user.userId)
        .maybeSingle()
      expect(mirrored?.full_name).toBe('Explicit Typed Name')
      expect(mirrored?.email).toBe(user.email)
    })

    it('case 1 — p_full_name NULL falls back to user_metadata.full_name (the product path)', async () => {
      // This is what createClinic() actually does: /onboarding's form asks
      // for the CLINIC's name, so the user's name can only come from the
      // metadata /signup wrote. AC-2 depends on this branch, and it is the
      // one that decides whether patients later see a real name or the
      // literal 'Doctor' fallback.
      const clinic = await foundClinic('c1b', 'Dr Metadata Name')

      const { data: mirrored } = await db
        .from('users')
        .select('full_name')
        .eq('id', clinic.admin.userId)
        .maybeSingle()
      expect(mirrored?.full_name).toBe('Dr Metadata Name')

      const { data: members } = await db
        .from('clinic_members')
        .select('id, role, status, user_id')
        .eq('clinic_id', clinic.clinicId)
      expect(members).toHaveLength(1)
      expect(members![0]).toMatchObject({
        role: 'admin',
        status: 'active',
        user_id: clinic.admin.userId,
      })
    })

    it('case 2 — the same user calling twice gets already_member and creates nothing', async () => {
      const clinic = await foundClinic('c2', 'Dr Twice')
      const before = await countTaggedClinics()

      const row = rpcRow<CreateClinicRow>(
        await clinic.client.rpc('create_clinic_with_owner', {
          p_name: `Case Two Second ${TAG}`,
          p_slug: slugFor('c2x'),
          p_timezone: TZ,
          p_full_name: null,
        }),
        'create_clinic_with_owner',
      )
      expect(row.outcome).toBe('already_member')
      expect(row.clinic_id).toBeNull()
      expect(await countTaggedClinics()).toBe(before)
    })

    it('case 3 — a duplicate slug is slug_taken and leaves the clinics count alone', async () => {
      const taken = await foundClinic('c3', 'Dr First Claim')
      const rival = await createAuthUser('c3r', 'Dr Late Claim')
      const client = await sessionClient(rival.email)
      const before = await countTaggedClinics()

      const row = rpcRow<CreateClinicRow>(
        await client.rpc('create_clinic_with_owner', {
          p_name: `Case Three Rival ${TAG}`,
          p_slug: taken.slug,
          p_timezone: TZ,
          p_full_name: null,
        }),
        'create_clinic_with_owner',
      )
      expect(row.outcome).toBe('slug_taken')
      expect(await countTaggedClinics()).toBe(before)

      // No membership was created either, so the rival can still found one.
      const { count } = await db
        .from('clinic_members')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', rival.userId)
      expect(count ?? 0).toBe(0)
    })

    it('case 3b — the SQL slug validator matches the TS table row for row', async () => {
      // The SAME table as onboarding-validate.test.ts. If either side
      // drifts, one of the two suites goes red.
      const table: Array<[string, ReturnType<typeof validateSlug>]> = [
        ['ab', 'length'],
        ['a'.repeat(41), 'length'],
        ['-abc', 'charset'],
        ['abc-', 'charset'],
        ['a--b', 'double-hyphen'],
        ['Abc', 'charset'],
        ['ab-1', null],
      ]

      const user = await createAuthUser('c3b', 'Dr Slug Parity')
      const client = await sessionClient(user.email)

      for (const [slug, code] of table.filter(([, c]) => c !== null)) {
        expect(validateSlug(slug)).toBe(code)
        const row = rpcRow<CreateClinicRow>(
          await client.rpc('create_clinic_with_owner', {
            p_name: `Case Three B ${TAG}`,
            p_slug: slug,
            p_timezone: TZ,
            p_full_name: null,
          }),
          'create_clinic_with_owner',
        )
        expect(row.outcome, `slug ${JSON.stringify(slug)}`).toBe('invalid')
      }

      // Every refusal above created nothing, so the same user can still
      // use the accepted value. The slug is the table's literal 'ab-1',
      // not a tagged one, so a leftover from an aborted earlier run of
      // THIS suite is cleared first (throwaway stack, by contract).
      await db.from('clinics').delete().eq('slug', 'ab-1')
      expect(validateSlug('ab-1')).toBeNull()
      const accepted = rpcRow<CreateClinicRow>(
        await client.rpc('create_clinic_with_owner', {
          p_name: `Case Three B Accepted ${TAG}`,
          p_slug: 'ab-1',
          p_timezone: TZ,
          p_full_name: null,
        }),
        'create_clinic_with_owner',
      )
      expect(accepted.outcome).toBe('created')
      createdClinics.push(accepted.clinic_id!)
    })

    it('case 4 — a disabled member cannot found a clinic and reads as disabled', async () => {
      const host = await foundClinic('c4', 'Dr Host')
      const benched = await addMember(host.clinicId, 'c4d', 'receptionist', {
        fullName: 'Benched Member',
        status: 'disabled',
      })
      const client = await sessionClient(benched.email)
      const slug = slugFor('c4n')

      const row = rpcRow<CreateClinicRow>(
        await client.rpc('create_clinic_with_owner', {
          p_name: `Case Four ${TAG}`,
          p_slug: slug,
          p_timezone: TZ,
          p_full_name: null,
        }),
        'create_clinic_with_owner',
      )
      expect(row.outcome).toBe('membership_disabled')

      const { count } = await db
        .from('clinics')
        .select('id', { count: 'exact', head: true })
        .eq('slug', slug)
      expect(count ?? 0).toBe(0)

      // The page-level helper agrees, which is what lets /onboarding show
      // the "access not active" copy before a form is ever submitted —
      // RLS hides the member's own row from them, so only this can.
      const status = await client.rpc('my_membership_status')
      expect(status.error).toBeNull()
      expect(status.data).toBe('disabled')
    })

    it('case 5 — an anon client with no session is refused by all four RPCs', async () => {
      const anon = anonClient()
      const host = await foundClinic('c5', 'Dr Anon Target')

      const calls = [
        anon.rpc('create_clinic_with_owner', {
          p_name: `Case Five ${TAG}`,
          p_slug: slugFor('c5'),
          p_timezone: TZ,
          p_full_name: null,
        }),
        anon.rpc('accept_clinic_invite', {
          p_token_hash: hashInviteToken(generateInviteToken()),
          p_full_name: 'Nobody At All',
        }),
        anon.rpc('connect_wacrm_account', {
          p_clinic_id: host.clinicId,
          p_wacrm_account_id: wacrmId(),
          p_phone_number_id: null,
          p_display_number: null,
        }),
        anon.rpc('set_doctor_services', {
          p_service_id: host.clinicId, // any uuid: the grant is checked first
          p_doctor_ids: [],
        }),
      ]

      for (const result of await Promise.all(calls)) {
        // EXECUTE is revoked from PUBLIC and anon in 012/013/014, so this
        // is a permission failure on the function, not an RLS filter.
        expect(result.error?.code).toBe('42501')
      }
    })
  })

  // ==========================================================
  // The WhatsApp identity chain — cases 6, 7, 8, 9, 10, 25, 25b.
  // ==========================================================
  describe('wacrm connection', () => {
    let a: Clinic
    let b: Clinic
    let acctOne: string
    let acctTwo: string
    let acctThree: string
    let phoneOne: string
    let phoneTwo: string

    beforeAll(async () => {
      a = await foundClinic('w1', 'Dr Wacrm A')
      b = await foundClinic('w2', 'Dr Wacrm B')
      acctOne = wacrmId()
      acctTwo = wacrmId()
      acctThree = wacrmId()
      phoneOne = phoneNumberId()
      phoneTwo = phoneNumberId()
    })

    it('case 6 — connect, then the webhook resolver finds the clinic', async () => {
      const row = rpcRow<OutcomeRow>(
        await connect(a, acctOne),
        'connect_wacrm_account',
      )
      expect(row.outcome).toBe('ok')

      const active = await activeWacrmRows(a.clinicId)
      expect(active).toHaveLength(1)
      expect(active[0].wacrm_account_id).toBe(acctOne)

      // The real last hop of PRD §8's chain, through the library the
      // inbound webhook calls.
      await expect(resolveClinicIdByWacrmAccount(acctOne)).resolves.toBe(
        a.clinicId,
      )
    })

    it('case 7 — re-submit, switch, and switch back are all ok with one active row', async () => {
      // Re-saving the same id must not collide with itself.
      expect(rpcRow<OutcomeRow>(await connect(a, acctOne), 'resubmit').outcome).toBe('ok')
      expect(await activeWacrmRows(a.clinicId)).toHaveLength(1)

      // Switching retires the old row rather than deleting it.
      expect(rpcRow<OutcomeRow>(await connect(a, acctTwo), 'switch').outcome).toBe('ok')
      let active = await activeWacrmRows(a.clinicId)
      expect(active).toHaveLength(1)
      expect(active[0].wacrm_account_id).toBe(acctTwo)

      // And the revert is NOT blocked by the clinic's own disabled row —
      // the bug the globally-unique id would otherwise cause.
      expect(rpcRow<OutcomeRow>(await connect(a, acctOne), 'revert').outcome).toBe('ok')
      active = await activeWacrmRows(a.clinicId)
      expect(active).toHaveLength(1)
      expect(active[0].wacrm_account_id).toBe(acctOne)
      await expect(resolveClinicIdByWacrmAccount(acctOne)).resolves.toBe(a.clinicId)
    })

    it("case 8 — another clinic's LIVE id is wacrm_taken and its row is untouched", async () => {
      const row = rpcRow<OutcomeRow>(await connect(b, acctOne), 'hijack')
      expect(row.outcome).toBe('wacrm_taken')

      const { data: owned } = await db
        .from('clinic_wacrm_accounts')
        .select('clinic_id, status')
        .eq('wacrm_account_id', acctOne)
      expect(owned).toHaveLength(1)
      expect(owned![0]).toMatchObject({ clinic_id: a.clinicId, status: 'active' })
      await expect(resolveClinicIdByWacrmAccount(acctOne)).resolves.toBe(a.clinicId)
      expect(await activeWacrmRows(b.clinicId)).toHaveLength(0)
    })

    it("case 9 — a phone_number_id held by another clinic is refused and leaves the wacrm mapping alone", async () => {
      // B takes a number of its own first.
      expect(
        rpcRow<OutcomeRow>(await connect(b, acctThree, phoneOne), 'b-number').outcome,
      ).toBe('ok')

      // A now asks for that number. The refusal is typed, and A's own
      // mapping is exactly as it was.
      const row = rpcRow<OutcomeRow>(
        await connect(a, acctOne, phoneOne),
        'phone-conflict',
      )
      expect(row.outcome).toBe('phone_number_taken')

      const active = await activeWacrmRows(a.clinicId)
      expect(active).toHaveLength(1)
      expect(active[0].wacrm_account_id).toBe(acctOne)
      expect(active[0].status).toBe('active')

      // Nothing landed in the numbers table for A either.
      const { data: numbers } = await db
        .from('clinic_whatsapp_numbers')
        .select('clinic_id, status')
        .eq('phone_number_id', phoneOne)
      expect(numbers).toHaveLength(1)
      expect(numbers![0]).toMatchObject({ clinic_id: b.clinicId, status: 'active' })
    })

    it('case 10 — a second ACTIVE mapping for one clinic is rejected by the partial index', async () => {
      // Forced with the service role, which bypasses RLS and the RPC
      // entirely: idx_clinic_wacrm_one_active is the backstop for every
      // other writer, including the seed.
      const forced = await db.from('clinic_wacrm_accounts').insert({
        clinic_id: a.clinicId,
        wacrm_account_id: wacrmId(),
        status: 'active',
      })
      expect(forced.error?.code).toBe('23505')
      expect(await activeWacrmRows(a.clinicId)).toHaveLength(1)
    })

    it('case 25 — a DORMANT id is re-pointed to the claiming clinic, for both ids', async () => {
      // A currently holds acctOne active and acctTwo disabled (case 7).
      expect(rpcRow<OutcomeRow>(await connect(a, acctTwo), 'a-to-two').outcome).toBe('ok')

      // acctOne is now A's dormant row, so B may claim it.
      expect(rpcRow<OutcomeRow>(await connect(b, acctOne), 'b-claims-one').outcome).toBe('ok')

      // The id is globally unique: ONE row, now owned by B.
      const { data: rows } = await db
        .from('clinic_wacrm_accounts')
        .select('clinic_id, status')
        .eq('wacrm_account_id', acctOne)
      expect(rows).toHaveLength(1)
      expect(rows![0]).toMatchObject({ clinic_id: b.clinicId, status: 'active' })

      // A keeps exactly one active mapping, acctTwo, and no acctOne row.
      const aActive = await activeWacrmRows(a.clinicId)
      expect(aActive).toHaveLength(1)
      expect(aActive[0].wacrm_account_id).toBe(acctTwo)
      const { count: strandedForA } = await db
        .from('clinic_wacrm_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', a.clinicId)
        .eq('wacrm_account_id', acctOne)
      expect(strandedForA ?? 0).toBe(0)

      await expect(resolveClinicIdByWacrmAccount(acctOne)).resolves.toBe(b.clinicId)
      await expect(resolveClinicIdByWacrmAccount(acctTwo)).resolves.toBe(a.clinicId)

      // Now the same rule for the OTHER globally-unique id. A takes
      // phoneTwo, then re-connects with a fresh number so phoneTwo is left
      // 'disconnected'.
      const phoneThree = phoneNumberId()
      expect(
        rpcRow<OutcomeRow>(await connect(a, acctTwo, phoneTwo), 'a-number-two').outcome,
      ).toBe('ok')
      expect(
        rpcRow<OutcomeRow>(await connect(a, acctTwo, phoneThree), 'a-number-three').outcome,
      ).toBe('ok')

      const { data: dormant } = await db
        .from('clinic_whatsapp_numbers')
        .select('clinic_id, status')
        .eq('phone_number_id', phoneTwo)
      expect(dormant![0]).toMatchObject({ clinic_id: a.clinicId, status: 'disconnected' })

      // B claims the dormant number: 'ok', not phone_number_taken.
      expect(
        rpcRow<OutcomeRow>(await connect(b, acctOne, phoneTwo), 'b-claims-number').outcome,
      ).toBe('ok')

      const { data: claimed } = await db
        .from('clinic_whatsapp_numbers')
        .select('clinic_id, status')
        .eq('phone_number_id', phoneTwo)
      expect(claimed).toHaveLength(1)
      expect(claimed![0]).toMatchObject({ clinic_id: b.clinicId, status: 'active' })

      const aNumbers = await activeNumbers(a.clinicId)
      expect(aNumbers).toHaveLength(1)
      expect(aNumbers[0].phone_number_id).toBe(phoneThree)
    })

    it('case 25b — a LIVE id cannot be taken over, for both ids', async () => {
      // A holds acctTwo active; B asking for it is the anti-hijack half of
      // NFR-1 and must not disturb A.
      const refusedAccount = rpcRow<OutcomeRow>(
        await connect(b, acctTwo),
        'live-account',
      )
      expect(refusedAccount.outcome).toBe('wacrm_taken')

      const aActive = await activeWacrmRows(a.clinicId)
      expect(aActive).toHaveLength(1)
      expect(aActive[0].wacrm_account_id).toBe(acctTwo)
      await expect(resolveClinicIdByWacrmAccount(acctTwo)).resolves.toBe(a.clinicId)

      // Same for the number: A's active number stays A's, and B's own
      // wacrm mapping is left exactly as it was.
      const aNumberBefore = (await activeNumbers(a.clinicId))[0]
      const bAccountBefore = (await activeWacrmRows(b.clinicId))[0]
      const refusedNumber = rpcRow<OutcomeRow>(
        await connect(b, bAccountBefore.wacrm_account_id, aNumberBefore.phone_number_id),
        'live-number',
      )
      expect(refusedNumber.outcome).toBe('phone_number_taken')

      const aNumberAfter = (await activeNumbers(a.clinicId))[0]
      expect(aNumberAfter.phone_number_id).toBe(aNumberBefore.phone_number_id)
      expect(aNumberAfter.status).toBe('active')
      const bAccountAfter = (await activeWacrmRows(b.clinicId))[0]
      expect(bAccountAfter.wacrm_account_id).toBe(bAccountBefore.wacrm_account_id)
    })
  })

  // ==========================================================
  // Invites — cases 11, 12, 12b, 12c, 13, 24.
  // ==========================================================
  describe('invites', () => {
    let host: Clinic

    beforeAll(async () => {
      host = await foundClinic('i1', 'Dr Invite Host')
    })

    it('case 11 — invite then accept as a doctor, through the real /join path', async () => {
      // createInvite + acceptInvite are the real order of operations:
      // load (service role) -> createUser -> signIn -> rpc, on ONE client.
      actAs(host.client)
      const invitee = `${TAG}-i1doc@example.test`
      const created = await createInvite({
        clinicId: host.clinicId,
        createdByMemberId: host.admin.memberId,
        email: invitee,
        role: 'doctor',
        specialty: 'Dermatology',
        slotMinutes: 20,
      })
      expect(created.status).toBe('created')
      if (created.status !== 'created') return
      const token = created.url.split('/join/')[1]

      actAsNewVisitor()
      const accepted = await acceptInvite({
        token,
        fullName: 'Dr Aarthi Menon',
        password: PASSWORD,
      })
      expect(accepted.status).toBe('accepted')
      if (accepted.status !== 'accepted') return

      const { data: member } = await db
        .from('clinic_members')
        .select('id, user_id, role, status')
        .eq('id', accepted.memberId)
        .maybeSingle()
      expect(member).toMatchObject({ role: 'doctor', status: 'active' })
      createdUsers.push(member!.user_id as string)

      const { data: profile } = await db
        .from('doctor_profiles')
        .select('specialty, slot_duration_minutes, clinic_id')
        .eq('clinic_member_id', accepted.memberId)
        .maybeSingle()
      expect(profile).toMatchObject({
        specialty: 'Dermatology',
        slot_duration_minutes: 20,
        clinic_id: host.clinicId,
      })

      // The name typed at ACCEPTANCE is what patients will see.
      const { data: identity } = await db
        .from('users')
        .select('full_name, email')
        .eq('id', member!.user_id as string)
        .maybeSingle()
      expect(identity?.full_name).toBe('Dr Aarthi Menon')
      expect(identity?.email).toBe(invitee)

      const { data: consumed } = await db
        .from('clinic_invites')
        .select('status, accepted_by, accepted_at')
        .eq('token_hash', hashInviteToken(token))
        .maybeSingle()
      expect(consumed?.status).toBe('accepted')
      expect(consumed?.accepted_by).toBe(member!.user_id)
      expect(consumed?.accepted_at).toBeTruthy()
    })

    it('case 12 — every refusal is typed and none of them creates a membership', async () => {
      const before = await countMembers(host.clinicId)

      // (a) re-accept an already-used invite.
      const reuser = await createAuthUser('i12a', 'Dr Reuse')
      const reuseInvite = await issueInvite(host.clinicId, reuser.email, 'nurse')
      const reuseClient = await sessionClient(reuser.email)
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(reuseClient, reuseInvite.tokenHash, 'Dr Reuse'),
          'first-accept',
        ).outcome,
      ).toBe('accepted')
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(reuseClient, reuseInvite.tokenHash, 'Dr Reuse'),
          'second-accept',
        ).outcome,
      ).toBe('already_used')

      const afterReuse = await countMembers(host.clinicId)
      expect(afterReuse).toBe(before + 1) // the one legitimate acceptance

      // (b) an expired invite.
      const late = await createAuthUser('i12b', 'Dr Late')
      const expired = await issueInvite(host.clinicId, late.email, 'nurse', {
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      const lateClient = await sessionClient(late.email)
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(lateClient, expired.tokenHash, 'Dr Late'),
          'expired',
        ).outcome,
      ).toBe('expired')

      // (c) the RPC-level wrong-email accept. /join always signs in AS the
      // invited email, so this is only reachable by calling the RPC
      // directly — which is exactly why the check is in SQL.
      const stranger = await createAuthUser('i12c', 'Dr Stranger')
      const strangerClient = await sessionClient(stranger.email)
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(
            strangerClient,
            hashInviteToken(generateInviteToken()),
            'Dr Stranger',
          ),
          'unknown-token',
        ).outcome,
      ).toBe('not_found')
      const forSomeoneElse = await issueInvite(
        host.clinicId,
        `${TAG}-i12-elsewhere@example.test`,
        'nurse',
      )
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(strangerClient, forSomeoneElse.tokenHash, 'Dr Stranger'),
          'email-mismatch',
        ).outcome,
      ).toBe('email_mismatch')

      // (d) clinic A's ACTIVE member accepting clinic B's invite. v1 is
      // single-membership, and B's invite must stay usable by the right
      // person afterwards.
      const other = await foundClinic('i12d', 'Dr Elsewhere Admin')
      const crossInvite = await issueInvite(
        other.clinicId,
        host.admin.email,
        'receptionist',
      )
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(host.client, crossInvite.tokenHash, 'Dr Invite Host'),
          'already-member',
        ).outcome,
      ).toBe('already_member')
      const { data: stillPending } = await db
        .from('clinic_invites')
        .select('status')
        .eq('token_hash', crossInvite.tokenHash)
        .maybeSingle()
      expect(stillPending?.status).toBe('pending')

      // (e) an empty name. This value is what patients see, so SQL
      // re-validates it rather than trusting the action.
      const nameless = await createAuthUser('i12e', 'Dr Nameless')
      const namelessInvite = await issueInvite(host.clinicId, nameless.email, 'nurse')
      const namelessClient = await sessionClient(nameless.email)
      expect(
        rpcRow<AcceptInviteRow>(
          await accept(namelessClient, namelessInvite.tokenHash, '   '),
          'empty-name',
        ).outcome,
      ).toBe('invalid')

      // Only the single legitimate acceptance in (a) added a member.
      expect(await countMembers(host.clinicId)).toBe(before + 1)
      expect(await countMembers(other.clinicId)).toBe(1)
    })

    it('case 12b — re-inviting a DISABLED member re-activates the same membership', async () => {
      const clinic = await foundClinic('i12f', 'Dr Reinvite Host')
      const benched = await addMember(clinic.clinicId, 'i12f1', 'doctor', {
        fullName: 'Dr Returning',
        status: 'disabled',
        withProfile: { specialty: 'Old Specialty', slotMinutes: 45 },
      })
      const before = await countMembers(clinic.clinicId)
      const invite = await issueInvite(clinic.clinicId, benched.email, 'doctor', {
        specialty: 'New Specialty',
        slotMinutes: 25,
      })
      const client = await sessionClient(benched.email)

      const result = await accept(client, invite.tokenHash, 'Dr Returning')
      // Not a 23505: doctor_profiles.clinic_member_id is UNIQUE, so the
      // RPC's ON CONFLICT is what keeps this from raising.
      expect(result.error).toBeNull()
      const row = rpcRow<AcceptInviteRow>(result, 're-activate')
      expect(row.outcome).toBe('accepted')
      expect(row.member_id).toBe(benched.memberId)

      expect(await countMembers(clinic.clinicId)).toBe(before)
      const { data: member } = await db
        .from('clinic_members')
        .select('role, status')
        .eq('id', benched.memberId)
        .maybeSingle()
      expect(member).toMatchObject({ role: 'doctor', status: 'active' })

      const { data: profiles } = await db
        .from('doctor_profiles')
        .select('id, specialty, slot_duration_minutes')
        .eq('clinic_member_id', benched.memberId)
      expect(profiles).toHaveLength(1)
      expect(profiles![0]).toMatchObject({
        id: benched.profileId,
        specialty: 'New Specialty',
        slot_duration_minutes: 25,
      })
    })

    it('case 12b(ii) — a disabled doctor re-invited as a NURSE is refused by a returned row, not an exception', async () => {
      const clinic = await foundClinic('i12g', 'Dr Role Clash Host')
      const benched = await addMember(clinic.clinicId, 'i12g1', 'doctor', {
        fullName: 'Dr Role Clash',
        status: 'disabled',
        withProfile: { specialty: 'Cardiology', slotMinutes: 30 },
      })
      const invite = await issueInvite(clinic.clinicId, benched.email, 'nurse')
      const client = await sessionClient(benched.email)

      const refused = await accept(client, invite.tokenHash, 'Dr Role Clash')
      // The point of the pre-check: /join has ALREADY created the auth
      // account by the time the RPC runs, so a raised doctor_role_locked
      // could not be undone. It must arrive as a typed outcome.
      expect(refused.error).toBeNull()
      expect(rpcRow<AcceptInviteRow>(refused, 'role-clash').outcome).toBe(
        'doctor_profile_exists',
      )

      const { data: member } = await db
        .from('clinic_members')
        .select('role, status')
        .eq('id', benched.memberId)
        .maybeSingle()
      expect(member).toMatchObject({ role: 'doctor', status: 'disabled' })
      const { data: profile } = await db
        .from('doctor_profiles')
        .select('id')
        .eq('clinic_member_id', benched.memberId)
        .maybeSingle()
      expect(profile?.id).toBe(benched.profileId)
      const { data: invitedStill } = await db
        .from('clinic_invites')
        .select('status')
        .eq('token_hash', invite.tokenHash)
        .maybeSingle()
      expect(invitedStill?.status).toBe('pending')

      // Remove the profile (no appointments) and the SAME invite works.
      const removed = await db
        .from('doctor_profiles')
        .delete()
        .eq('id', benched.profileId!)
      expect(removed.error).toBeNull()

      const retried = rpcRow<AcceptInviteRow>(
        await accept(client, invite.tokenHash, 'Dr Role Clash'),
        'retry-as-nurse',
      )
      expect(retried.outcome).toBe('accepted')
      const { data: after } = await db
        .from('clinic_members')
        .select('role, status')
        .eq('id', benched.memberId)
        .maybeSingle()
      expect(after).toMatchObject({ role: 'nurse', status: 'active' })
    })

    it('case 12c — a disabled ADMIN holding a doctor profile is re-invited as a receptionist', async () => {
      // The negative of 12b(ii). clinic_members_guard rule 2 fires only
      // when OLD.role = 'doctor', and the RPC's pre-check mirrors that
      // predicate exactly — so this shape must NOT be refused.
      const clinic = await foundClinic('i12h', 'Dr Solo Shape Host')
      const benched = await addMember(clinic.clinicId, 'i12h1', 'admin', {
        fullName: 'Dr Wearing Two Hats',
        status: 'disabled',
        withProfile: { specialty: 'Paediatrics', slotMinutes: 15 },
      })
      const invite = await issueInvite(clinic.clinicId, benched.email, 'receptionist')
      const client = await sessionClient(benched.email)

      const row = rpcRow<AcceptInviteRow>(
        await accept(client, invite.tokenHash, 'Dr Wearing Two Hats'),
        'admin-to-receptionist',
      )
      expect(row.outcome).toBe('accepted')

      const { data: member } = await db
        .from('clinic_members')
        .select('role, status')
        .eq('id', benched.memberId)
        .maybeSingle()
      expect(member).toMatchObject({ role: 'receptionist', status: 'active' })

      const { data: profile } = await db
        .from('doctor_profiles')
        .select('id, specialty')
        .eq('clinic_member_id', benched.memberId)
        .maybeSingle()
      expect(profile).toMatchObject({ id: benched.profileId, specialty: 'Paediatrics' })

      // And the doctor readers still offer them, because they key on
      // member STATUS and never on role (§9.4a).
      const options = await loadDoctorOptions(clinic.clinicId)
      expect(options.map((o) => o.label)).toContain(
        'Dr Wearing Two Hats (Paediatrics)',
      )
      const names = await clinicDoctorNames(clinic.client, clinic.clinicId)
      expect(names).toContain('Dr Wearing Two Hats')
    })

    it('case 13 — concurrent accepts of one invite produce one membership', async () => {
      const clinic = await foundClinic('i13', 'Dr Race Host')
      const invitee = await createAuthUser('i13a', 'Dr Racer')
      const invite = await issueInvite(clinic.clinicId, invitee.email, 'nurse')

      // Two independent sessions for the same person, firing together.
      const [first, second] = await Promise.all([
        sessionClient(invitee.email),
        sessionClient(invitee.email),
      ])
      const [a, b] = await Promise.all([
        accept(first, invite.tokenHash, 'Dr Racer'),
        accept(second, invite.tokenHash, 'Dr Racer'),
      ])
      expect(a.error).toBeNull()
      expect(b.error).toBeNull()

      const outcomes = [
        rpcRow<AcceptInviteRow>(a, 'race-a').outcome,
        rpcRow<AcceptInviteRow>(b, 'race-b').outcome,
      ].sort()
      expect(outcomes).toEqual(['accepted', 'already_used'])

      const { data: members } = await db
        .from('clinic_members')
        .select('id')
        .eq('clinic_id', clinic.clinicId)
        .eq('user_id', invitee.userId)
      expect(members).toHaveLength(1)
    })

    it('case 24 — two concurrent createInvite calls leave exactly one pending invite', async () => {
      const clinic = await foundClinic('i24', 'Dr Double Invite Host')
      actAs(clinic.client)
      const email = `${TAG}-i24@example.test`

      const input = {
        clinicId: clinic.clinicId,
        createdByMemberId: clinic.admin.memberId,
        email,
        role: 'nurse' as MemberRole,
        specialty: null,
        slotMinutes: null,
      }
      // Neither call may throw a raw 23505 and neither may loop: the
      // retry is bounded at one, and the loser reports 'raced'.
      const [first, second] = await Promise.all([
        createInvite(input),
        createInvite(input),
      ])
      for (const result of [first, second]) {
        expect(['created', 'raced']).toContain(result.status)
      }

      const { data: pending } = await db
        .from('clinic_invites')
        .select('id')
        .eq('clinic_id', clinic.clinicId)
        .eq('email', email)
        .eq('status', 'pending')
      expect(pending).toHaveLength(1)
    })
  })

  // ==========================================================
  // Authorization and isolation — cases 14, 22, 15, 16, 17, 18.
  // ==========================================================
  describe('authorization and isolation', () => {
    let clinic: Clinic
    let receptionist: Member
    let receptionistClient: SupabaseClient
    let spare: Member
    let doctor: Member
    let serviceId: string

    beforeAll(async () => {
      clinic = await foundClinic('p1', 'Dr Policy Host')
      receptionist = await addMember(clinic.clinicId, 'p1r', 'receptionist', {
        fullName: 'Front Desk',
      })
      receptionistClient = await sessionClient(receptionist.email)
      spare = await addMember(clinic.clinicId, 'p1n', 'nurse', {
        fullName: 'Spare Nurse',
      })
      doctor = await addMember(clinic.clinicId, 'p1d', 'doctor', {
        fullName: 'Dr Policy Doctor',
        withProfile: { specialty: 'ENT', slotMinutes: 30 },
      })
      serviceId = await addService(clinic.clinicId, 'Policy Consultation', 45000)
      expect(
        rpcRow<OutcomeRow>(await connect(clinic, wacrmId()), 'policy-connect').outcome,
      ).toBe('ok')
    })

    it('case 14 — a receptionist session cannot write tenant configuration', async () => {
      const inserts: Array<[string, Record<string, unknown>]> = [
        [
          'clinic_invites',
          {
            clinic_id: clinic.clinicId,
            email: `${TAG}-p14@example.test`,
            role: 'nurse',
            token_hash: hashInviteToken(generateInviteToken()),
          },
        ],
        ['services', { clinic_id: clinic.clinicId, name: 'Smuggled', price_cents: 1 }],
        [
          'doctor_services',
          { clinic_id: clinic.clinicId, doctor_id: doctor.profileId, service_id: serviceId },
        ],
        [
          'doctor_profiles',
          { clinic_id: clinic.clinicId, clinic_member_id: spare.memberId },
        ],
        [
          'clinic_members',
          {
            clinic_id: clinic.clinicId,
            user_id: receptionist.userId,
            role: 'admin',
            status: 'active',
          },
        ],
        [
          'clinic_whatsapp_numbers',
          {
            clinic_id: clinic.clinicId,
            phone_number_id: phoneNumberId(),
            status: 'active',
          },
        ],
      ]

      for (const [table, row] of inserts) {
        const result = await receptionistClient.from(table).insert(row)
        // An INSERT has no existing row to filter, so the failing
        // WITH CHECK raises.
        expect(result.error?.code, `insert ${table}`).toBe('42501')
      }

      // An UPDATE is different and this asymmetry is CORRECT: a failing
      // USING predicate filters the rows away, so there is simply nothing
      // to modify and PostgREST reports 0 rows. Do not "fix" the policy.
      const renamed = await receptionistClient
        .from('clinics')
        .update({ name: 'Renamed By Front Desk' })
        .eq('id', clinic.clinicId)
        .select('id')
      expect(renamed.error).toBeNull()
      expect(renamed.data).toEqual([])

      const repointed = await receptionistClient
        .from('clinic_wacrm_accounts')
        .update({ status: 'disabled' })
        .eq('clinic_id', clinic.clinicId)
        .select('id')
      expect(repointed.error).toBeNull()
      expect(repointed.data).toEqual([])

      // Reads stay member-wide, so the receptionist keeps doing their job.
      const readable = await receptionistClient
        .from('services')
        .select('id, name')
        .eq('clinic_id', clinic.clinicId)
      expect(readable.error).toBeNull()
      expect(readable.data?.length).toBeGreaterThan(0)
    })

    it('case 22 — the clinic ADMIN can write every one of them, one row at a time', async () => {
      // Every other mutation case here goes through a SECURITY DEFINER
      // RPC, which BYPASSES the policies 014 installs. /staff and
      // /services are plain session-scoped writes, so without this case a
      // missing WITH CHECK would let the suite pass green while both
      // screens are bricked for admins.
      const admin = clinic.client

      const insertedService = await admin
        .from('services')
        .insert({ clinic_id: clinic.clinicId, name: 'Admin Added', price_cents: 12300 })
        .select('id')
      expect(insertedService.error).toBeNull()
      expect(insertedService.data).toHaveLength(1)
      const newServiceId = insertedService.data![0].id as string

      const deactivated = await admin
        .from('services')
        .update({ active: false })
        .eq('id', newServiceId)
        .select('id')
      expect(deactivated.data).toHaveLength(1)

      const insertedInvite = await admin
        .from('clinic_invites')
        .insert({
          clinic_id: clinic.clinicId,
          email: `${TAG}-p22@example.test`,
          role: 'nurse',
          token_hash: hashInviteToken(generateInviteToken()),
        })
        .select('id')
      expect(insertedInvite.error).toBeNull()
      expect(insertedInvite.data).toHaveLength(1)

      const revoked = await admin
        .from('clinic_invites')
        .update({ status: 'revoked' })
        .eq('id', insertedInvite.data![0].id as string)
        .select('id')
      expect(revoked.data).toHaveLength(1)

      const reroled = await admin
        .from('clinic_members')
        .update({ role: 'receptionist' })
        .eq('id', spare.memberId)
        .select('id')
      expect(reroled.error).toBeNull()
      expect(reroled.data).toHaveLength(1)

      // doctor_profiles is 014's one exception: the WITH CHECK pins
      // clinic_member_id to a member of the SAME clinic. The positive
      // half is here; case 15 is the negative.
      const insertedProfile = await admin
        .from('doctor_profiles')
        .insert({
          clinic_id: clinic.clinicId,
          clinic_member_id: spare.memberId,
          slot_duration_minutes: 15,
        })
        .select('id')
      expect(insertedProfile.error).toBeNull()
      expect(insertedProfile.data).toHaveLength(1)

      const updatedProfile = await admin
        .from('doctor_profiles')
        .update({ slot_duration_minutes: 20 })
        .eq('id', insertedProfile.data![0].id as string)
        .select('id')
      expect(updatedProfile.data).toHaveLength(1)

      const insertedNumber = await admin
        .from('clinic_whatsapp_numbers')
        .insert({
          clinic_id: clinic.clinicId,
          phone_number_id: phoneNumberId(),
          status: 'active',
        })
        .select('id')
      expect(insertedNumber.error).toBeNull()
      expect(insertedNumber.data).toHaveLength(1)

      const renamed = await admin
        .from('clinics')
        .update({ name: `Policy Host Renamed ${TAG}` })
        .eq('id', clinic.clinicId)
        .select('id')
      expect(renamed.error).toBeNull()
      expect(renamed.data).toHaveLength(1)
    })

    it("case 15 — clinic B's admin cannot read, write or smuggle into clinic A", async () => {
      const a = clinic
      const b = await foundClinic('p15b', 'Dr Other Tenant')
      const bDoctor = await addMember(b.clinicId, 'p15d', 'doctor', {
        fullName: 'Dr Other Tenant Doctor',
        withProfile: { specialty: 'Ortho', slotMinutes: 30 },
      })
      const aInvite = await issueInvite(
        a.clinicId,
        `${TAG}-p15-target@example.test`,
        'nurse',
      )

      // Reads: zero rows, not an error — the policy filters them out.
      const tables = ['clinic_members', 'clinic_invites', 'services', 'clinic_wacrm_accounts']
      for (const table of tables) {
        const read = await b.client.from(table).select('id').eq('clinic_id', a.clinicId)
        expect(read.error, `select ${table}`).toBeNull()
        expect(read.data, `select ${table}`).toEqual([])
      }

      // Writes against A: nothing to modify, so 0 rows.
      const demoted = await b.client
        .from('clinic_members')
        .update({ role: 'nurse' })
        .eq('id', a.admin.memberId)
        .select('id')
      expect(demoted.data).toEqual([])

      const revoked = await b.client
        .from('clinic_invites')
        .update({ status: 'revoked' })
        .eq('token_hash', aInvite.tokenHash)
        .select('id')
      expect(revoked.data).toEqual([])

      const repriced = await b.client
        .from('services')
        .update({ price_cents: 1 })
        .eq('id', serviceId)
        .select('id')
      expect(repriced.data).toEqual([])

      const stolen = await b.client
        .from('clinic_wacrm_accounts')
        .update({ clinic_id: b.clinicId })
        .eq('clinic_id', a.clinicId)
        .select('id')
      expect(stolen.data).toEqual([])

      // Colleague emails are admin-only AND clinic-scoped.
      const identities = await b.client.rpc('clinic_member_identities', {
        target_clinic: a.clinicId,
      })
      expect(identities.error).toBeNull()
      expect(identities.data).toEqual([])

      // The smuggling attempt: a row that passes is_clinic_admin on the
      // column the CLIENT supplies, but pins a member of clinic A. Left
      // unchecked, every doctor reader would render A's member's name to
      // B's patients on WhatsApp and to B's staff on /availability.
      const smuggled = await b.client.from('doctor_profiles').insert({
        clinic_id: b.clinicId,
        clinic_member_id: a.admin.memberId,
      })
      expect(smuggled.error?.code).toBe('42501')

      const repinned = await b.client
        .from('doctor_profiles')
        .update({ clinic_member_id: a.admin.memberId })
        .eq('id', bDoctor.profileId!)
        .select('id')
      expect(repinned.data).toEqual([])

      // The global invariant, asserted with the service role so RLS
      // cannot hide a violation: no profile may point at a member of a
      // different clinic.
      const { data: allProfiles, error: profileErr } = await db
        .from('doctor_profiles')
        .select('id, clinic_id, clinic_members!inner(clinic_id)')
      expect(profileErr).toBeNull()
      const mismatched = (allProfiles ?? []).filter((row) => {
        const r = row as unknown as {
          clinic_id: string
          clinic_members: { clinic_id: string }
        }
        return r.clinic_id !== r.clinic_members.clinic_id
      })
      expect(mismatched).toEqual([])

      // And neither doctor reader leaks A's name into B.
      const options = await loadDoctorOptions(b.clinicId)
      expect(options.map((o) => o.label).join(' | ')).not.toContain('Dr Policy Host')
      const names = await clinicDoctorNames(b.client, b.clinicId)
      expect(names).not.toContain('Dr Policy Host')
    })

    it('case 16 — the last active admin cannot be demoted or disabled', async () => {
      const solo = await foundClinic('p16', 'Dr Only Admin')

      const demoteSelf = await solo.client
        .from('clinic_members')
        .update({ role: 'nurse' })
        .eq('id', solo.admin.memberId)
      expect(demoteSelf.error?.code).toBe('P0001')
      expect(demoteSelf.error?.message).toContain('last_active_admin')

      const disableSelf = await solo.client
        .from('clinic_members')
        .update({ status: 'disabled' })
        .eq('id', solo.admin.memberId)
      expect(disableSelf.error?.code).toBe('P0001')
      expect(disableSelf.error?.message).toContain('last_active_admin')

      // With company, both writes are allowed.
      const second = await addMember(solo.clinicId, 'p16b', 'admin', {
        fullName: 'Dr Second Admin',
      })
      const third = await addMember(solo.clinicId, 'p16c', 'admin', {
        fullName: 'Dr Third Admin',
      })
      expect(third.memberId).toBeTruthy()

      const demoted = await solo.client
        .from('clinic_members')
        .update({ role: 'nurse' })
        .eq('id', solo.admin.memberId)
        .select('id')
      expect(demoted.error).toBeNull()
      expect(demoted.data).toHaveLength(1)

      const secondClient = await sessionClient(second.email)
      const disabled = await secondClient
        .from('clinic_members')
        .update({ status: 'disabled' })
        .eq('id', second.memberId)
        .select('id')
      expect(disabled.error).toBeNull()
      expect(disabled.data).toHaveLength(1)
    })

    it('case 17 — a clinic with one admin who has booked appointments still deletes', async () => {
      // Both guards must stand down for a cascade, or tenant deletion
      // breaks and every integration fixture leaks — this test is what
      // proves THIS suite's own teardown can complete.
      const doomed = await foundClinic('p17', 'Dr Doomed Admin')
      const profileId = await giveDoctorProfile(doomed, doomed.admin, {
        specialty: 'General',
        slotMinutes: 30,
      })
      const patientId = await addPatient(doomed.clinicId)
      await addAppointment(doomed.clinicId, profileId, patientId, {
        startsAt: '2099-03-01T04:00:00.000Z',
        endsAt: '2099-03-01T04:30:00.000Z',
      })

      const deleted = await db.from('clinics').delete().eq('id', doomed.clinicId)
      expect(deleted.error).toBeNull()

      const { count: members } = await db
        .from('clinic_members')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', doomed.clinicId)
      expect(members ?? 0).toBe(0)
      const { count: profiles } = await db
        .from('doctor_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('id', profileId)
      expect(profiles ?? 0).toBe(0)

      // The other cascade path: auth.users -> users -> clinic_members.
      const removedUser = await db.auth.admin.deleteUser(doomed.admin.userId)
      expect(removedUser.error).toBeNull()
    })

    it('case 18 — a member holding a doctor profile is locked to the doctor role', async () => {
      const locked = await clinic.client
        .from('clinic_members')
        .update({ role: 'nurse' })
        .eq('id', doctor.memberId)
      expect(locked.error?.code).toBe('P0001')
      expect(locked.error?.message).toContain('doctor_role_locked')

      const { data: unchanged } = await db
        .from('clinic_members')
        .select('role')
        .eq('id', doctor.memberId)
        .maybeSingle()
      expect(unchanged?.role).toBe('doctor')
    })
  })

  // ==========================================================
  // Services and the end-to-end chain — cases 19, 20, 21, 23, 23b.
  // ==========================================================
  describe('services and booking', () => {
    let clinic: Clinic
    let first: Member
    let secondDoctor: Member
    let foreignDoctorId: string
    let serviceId: string

    beforeAll(async () => {
      clinic = await foundClinic('s1', 'Dr Services Host')
      first = await addMember(clinic.clinicId, 's1a', 'doctor', {
        fullName: 'Dr Services One',
        withProfile: { specialty: 'Derm', slotMinutes: 30 },
      })
      secondDoctor = await addMember(clinic.clinicId, 's1b', 'doctor', {
        fullName: 'Dr Services Two',
        withProfile: { specialty: 'ENT', slotMinutes: 30 },
      })
      const foreign = await foundClinic('s1f', 'Dr Foreign Host')
      foreignDoctorId = await giveDoctorProfile(foreign, foreign.admin, {
        specialty: 'Foreign',
        slotMinutes: 30,
      })
      serviceId = await addService(clinic.clinicId, 'Follow-up visit', 30000)
    })

    it('case 19 — set_doctor_services replaces the set atomically', async () => {
      const both = rpcRow<SetDoctorServicesRow>(
        await clinic.client.rpc('set_doctor_services', {
          p_service_id: serviceId,
          p_doctor_ids: [first.profileId, secondDoctor.profileId],
        }),
        'set-both',
      )
      expect(both.outcome).toBe('ok')
      expect(both.linked).toBe(2)

      const narrowed = rpcRow<SetDoctorServicesRow>(
        await clinic.client.rpc('set_doctor_services', {
          p_service_id: serviceId,
          p_doctor_ids: [secondDoctor.profileId],
        }),
        'narrow',
      )
      expect(narrowed.outcome).toBe('ok')
      expect(narrowed.linked).toBe(1)
      const { data: pairs } = await db
        .from('doctor_services')
        .select('doctor_id')
        .eq('service_id', serviceId)
      expect(pairs).toHaveLength(1)
      expect(pairs![0].doctor_id).toBe(secondDoctor.profileId)

      // A foreign-clinic doctor id is refused and changes nothing. A
      // missing id and a foreign one are the same refusal, so a forged id
      // cannot probe for existence.
      const refused = rpcRow<SetDoctorServicesRow>(
        await clinic.client.rpc('set_doctor_services', {
          p_service_id: serviceId,
          p_doctor_ids: [foreignDoctorId],
        }),
        'foreign',
      )
      expect(refused.outcome).toBe('doctor_not_in_clinic')
      const { data: stillPairs } = await db
        .from('doctor_services')
        .select('doctor_id')
        .eq('service_id', serviceId)
      expect(stillPairs).toHaveLength(1)
      expect(stillPairs![0].doctor_id).toBe(secondDoctor.profileId)

      // An empty array is a legitimate request, not a missing value.
      const cleared = rpcRow<SetDoctorServicesRow>(
        await clinic.client.rpc('set_doctor_services', {
          p_service_id: serviceId,
          p_doctor_ids: [],
        }),
        'clear',
      )
      expect(cleared.outcome).toBe('ok')
      expect(cleared.linked).toBe(0)
      const { count } = await db
        .from('doctor_services')
        .select('id', { count: 'exact', head: true })
        .eq('service_id', serviceId)
      expect(count ?? 0).toBe(0)
    })

    it('case 20 — deactivating a service keeps the appointments that reference it', async () => {
      const patientId = await addPatient(clinic.clinicId)
      const appointmentId = await addAppointment(
        clinic.clinicId,
        first.profileId!,
        patientId,
        {
          startsAt: '2099-04-01T04:00:00.000Z',
          endsAt: '2099-04-01T04:30:00.000Z',
          serviceId,
        },
      )

      const deactivated = await clinic.client
        .from('services')
        .update({ active: false })
        .eq('id', serviceId)
        .select('id, active')
      expect(deactivated.error).toBeNull()
      expect(deactivated.data).toHaveLength(1)
      expect(deactivated.data![0].active).toBe(false)

      // Deactivation is the only removal there is, so history keeps its
      // name — the row survives and still joins.
      const { data: appointment, error } = await db
        .from('appointments')
        .select('id, service_id, services(name, active)')
        .eq('id', appointmentId)
        .maybeSingle()
      expect(error).toBeNull()
      const joined = appointment as unknown as {
        service_id: string
        services: { name: string; active: boolean }
      }
      expect(joined.service_id).toBe(serviceId)
      expect(joined.services.name).toBe('Follow-up visit')
      expect(joined.services.active).toBe(false)
    })

    it('case 21 — a clinic built ONLY through onboarding takes a WhatsApp booking', async () => {
      // Nothing here touches the seed: clinic RPC -> doctor invite
      // accepted -> availability through the member's own session ->
      // wacrm connected. Then the exact library chain the inbound webhook
      // runs.
      const fresh = await foundClinic('s21', 'Dr Parity Admin')

      actAs(fresh.client)
      const invitee = `${TAG}-s21doc@example.test`
      const invited = await createInvite({
        clinicId: fresh.clinicId,
        createdByMemberId: fresh.admin.memberId,
        email: invitee,
        role: 'doctor',
        specialty: 'Physiotherapy',
        slotMinutes: 30,
      })
      expect(invited.status).toBe('created')
      if (invited.status !== 'created') return

      actAsNewVisitor()
      const accepted = await acceptInvite({
        token: invited.url.split('/join/')[1],
        fullName: 'Dr Ravi Shankar',
        password: PASSWORD,
      })
      expect(accepted.status).toBe('accepted')
      if (accepted.status !== 'accepted') return

      const { data: joined } = await db
        .from('clinic_members')
        .select('user_id')
        .eq('id', accepted.memberId)
        .maybeSingle()
      createdUsers.push(joined!.user_id as string)
      const { data: profile } = await db
        .from('doctor_profiles')
        .select('id')
        .eq('clinic_member_id', accepted.memberId)
        .maybeSingle()
      const doctorId = profile!.id as string

      // Availability written by the DOCTOR's own session, through RLS.
      const doctorClient = await sessionClient(invitee)
      await addWeeklyAvailability(doctorClient, fresh.clinicId, doctorId)

      const wacrmAccountId = wacrmId()
      expect(
        rpcRow<OutcomeRow>(
          await connect(fresh, wacrmAccountId, phoneNumberId()),
          's21-connect',
        ).outcome,
      ).toBe('ok')

      // ── the webhook's chain ────────────────────────────────
      const resolved = await resolveClinicIdByWacrmAccount(wacrmAccountId)
      expect(resolved).toBe(fresh.clinicId)

      const options = await loadDoctorOptions(resolved!)
      expect(options).toHaveLength(1)
      // The REAL name, not the 'Doctor' fallback — the whole point of
      // capturing it at acceptance.
      expect(options[0].label).toBe('Dr Ravi Shankar (Physiotherapy)')
      expect(options[0].id).toBe(doctorId)

      const slotMinutes = await loadDoctorSlotMinutes(doctorId)
      expect(slotMinutes).toBe(30)

      const days = await loadAvailableDays(resolved!, doctorId, TZ)
      expect(days.length).toBeGreaterThan(0)

      const slots = await generateSlots({
        doctorId,
        dateYmd: days[0].dateYmd,
        clinicTimezone: TZ,
        defaultSlotMinutes: slotMinutes!,
        minLeadMinutes: 0,
      })
      expect(slots.length).toBeGreaterThan(0)
      const slot = slots[slots.length - 1]

      const booked = await bookAppointment({
        clinicId: resolved!,
        doctorId,
        waPhone: waPhone(),
        startsAtUtc: slot.startsAtUtc,
        endsAtUtc: slot.endsAtUtc,
        patientName: 'Parity Patient',
      })
      expect(booked.status).toBe('booked')

      // The exclusion constraint is still the only no-double-booking
      // guard, onboarded clinic or seeded one.
      const again = await bookAppointment({
        clinicId: resolved!,
        doctorId,
        waPhone: waPhone(),
        startsAtUtc: slot.startsAtUtc,
        endsAtUtc: slot.endsAtUtc,
        patientName: 'Second Parity Patient',
      })
      expect(again.status).toBe('slot_taken')
    }, 120_000)

    it('case 23 — a SOLO clinic is bookable with no second member and no role change', async () => {
      const solo = await foundClinic('s23', 'Dr Solo Owner')

      // The founding admin gives THEMSELVES a doctor profile through the
      // real /staff write path. A role is not what makes a member
      // bookable — a profile is (§9.4a).
      actAs(solo.client)
      const upserted = await upsertDoctorProfile(solo.clinicId, solo.admin.memberId, {
        specialty: 'Family Medicine',
        registrationNumber: 'REG-SOLO-1',
        slotMinutes: 30,
      })
      expect(upserted.status).toBe('ok')

      const { data: profile } = await db
        .from('doctor_profiles')
        .select('id')
        .eq('clinic_member_id', solo.admin.memberId)
        .maybeSingle()
      const doctorId = profile!.id as string

      await addWeeklyAvailability(solo.client, solo.clinicId, doctorId)
      const wacrmAccountId = wacrmId()
      expect(
        rpcRow<OutcomeRow>(await connect(solo, wacrmAccountId), 's23-connect').outcome,
      ).toBe('ok')

      actAs(solo.client)
      const status = await getSetupStatus(solo.clinicId)
      expect(status.whatsappConnected).toBe(true)
      expect(status.hasDoctor).toBe(true)
      expect(status.hasAvailability).toBe(true)
      expect(status.complete).toBe(true)

      const options = await loadDoctorOptions(solo.clinicId)
      expect(options).toHaveLength(1)
      expect(options[0].label).toBe('Dr Solo Owner (Family Medicine)')

      actAs(solo.client)
      const portalDoctors = await listClinicDoctors(solo.clinicId)
      expect(portalDoctors).toHaveLength(1)
      expect(portalDoctors[0].id).toBe(doctorId)

      const resolved = await resolveClinicIdByWacrmAccount(wacrmAccountId)
      expect(resolved).toBe(solo.clinicId)
      const days = await loadAvailableDays(solo.clinicId, doctorId, TZ)
      expect(days.length).toBeGreaterThan(0)
      const slots = await generateSlots({
        doctorId,
        dateYmd: days[0].dateYmd,
        clinicTimezone: TZ,
        defaultSlotMinutes: 30,
        minLeadMinutes: 0,
      })
      expect(slots.length).toBeGreaterThan(0)
      const booked = await bookAppointment({
        clinicId: solo.clinicId,
        doctorId,
        waPhone: waPhone(),
        startsAtUtc: slots[slots.length - 1].startsAtUtc,
        endsAtUtc: slots[slots.length - 1].endsAtUtc,
        patientName: 'Solo Patient',
      })
      expect(booked.status).toBe('booked')

      // Still the admin. Nothing in this flow demotes the owner to make
      // them bookable.
      const { data: member } = await db
        .from('clinic_members')
        .select('role, status')
        .eq('id', solo.admin.memberId)
        .maybeSingle()
      expect(member).toMatchObject({ role: 'admin', status: 'active' })
    }, 120_000)

    it('case 23b — removing a doctor profile never destroys appointment history', async () => {
      const clinic23b = await foundClinic('s23b', 'Dr History Host')
      const withPast = await addMember(clinic23b.clinicId, 's23b1', 'doctor', {
        fullName: 'Dr Has Past',
        withProfile: { specialty: 'Derm', slotMinutes: 30 },
      })
      const withFuture = await addMember(clinic23b.clinicId, 's23b2', 'doctor', {
        fullName: 'Dr Has Future',
        withProfile: { specialty: 'ENT', slotMinutes: 30 },
      })
      const clean = await addMember(clinic23b.clinicId, 's23b3', 'doctor', {
        fullName: 'Dr No Appointments',
        withProfile: { specialty: 'Ortho', slotMinutes: 30 },
      })
      const alsoClean = await addMember(clinic23b.clinicId, 's23b4', 'doctor', {
        fullName: 'Dr Also Clean',
        withProfile: { specialty: 'Ortho', slotMinutes: 30 },
      })

      const patientId = await addPatient(clinic23b.clinicId)
      const pastAppointment = await addAppointment(
        clinic23b.clinicId,
        withPast.profileId!,
        patientId,
        {
          startsAt: '2020-01-06T04:00:00.000Z',
          endsAt: '2020-01-06T04:30:00.000Z',
          status: 'completed',
        },
      )
      const futureAppointment = await addAppointment(
        clinic23b.clinicId,
        withFuture.profileId!,
        patientId,
        {
          startsAt: '2099-05-04T04:00:00.000Z',
          endsAt: '2099-05-04T04:30:00.000Z',
        },
      )

      // The friendly refusal, for a PAST completed appointment — the
      // cascade case, where silently deleting would erase history.
      actAs(clinic23b.client)
      const refusedPast = await removeDoctorProfile(clinic23b.clinicId, withPast.memberId)
      expect(refusedPast.status).toBe('refused')
      expect(await rowExists('doctor_profiles', withPast.profileId!)).toBe(true)
      expect(await rowExists('appointments', pastAppointment)).toBe(true)

      actAs(clinic23b.client)
      const refusedFuture = await removeDoctorProfile(
        clinic23b.clinicId,
        withFuture.memberId,
      )
      expect(refusedFuture.status).toBe('refused')
      expect(await rowExists('doctor_profiles', withFuture.profileId!)).toBe(true)
      expect(await rowExists('appointments', futureAppointment)).toBe(true)

      // Now bypass the action entirely. The action's count produces the
      // friendly message; doctor_profiles_guard() is the GUARANTEE and
      // the race backstop, so even the service role is refused.
      const rawDelete = await db
        .from('doctor_profiles')
        .delete()
        .eq('id', withPast.profileId!)
      expect(rawDelete.error?.code).toBe('P0001')
      expect(rawDelete.error?.message).toContain('doctor_has_appointments')
      expect(await rowExists('doctor_profiles', withPast.profileId!)).toBe(true)
      expect(await rowExists('appointments', pastAppointment)).toBe(true)

      // A profile with no appointments goes, through the action...
      await addWeeklyAvailability(clinic23b.client, clinic23b.clinicId, clean.profileId!)
      actAs(clinic23b.client)
      const removed = await removeDoctorProfile(clinic23b.clinicId, clean.memberId)
      expect(removed.status).toBe('removed')
      expect(await rowExists('doctor_profiles', clean.profileId!)).toBe(false)
      const { count: orphanRules } = await db
        .from('availability_rules')
        .select('id', { count: 'exact', head: true })
        .eq('doctor_id', clean.profileId!)
      expect(orphanRules ?? 0).toBe(0)
      const { data: stillAMember } = await db
        .from('clinic_members')
        .select('role, status')
        .eq('id', clean.memberId)
        .maybeSingle()
      expect(stillAMember).toMatchObject({ role: 'doctor', status: 'active' })
      const options = await loadDoctorOptions(clinic23b.clinicId)
      expect(options.map((o) => o.label).join(' | ')).not.toContain('Dr No Appointments')

      // ...and through a raw delete.
      const rawClean = await db
        .from('doctor_profiles')
        .delete()
        .eq('id', alsoClean.profileId!)
      expect(rawClean.error).toBeNull()
      expect(await rowExists('doctor_profiles', alsoClean.profileId!)).toBe(false)

      // Finally: the guard still stands down for a cascade. Re-create a
      // profile WITH an appointment and delete the clinic.
      const recreated = await giveDoctorProfile(clinic23b, clean, {
        specialty: 'Ortho',
        slotMinutes: 30,
      })
      await addAppointment(clinic23b.clinicId, recreated, patientId, {
        startsAt: '2099-05-05T04:00:00.000Z',
        endsAt: '2099-05-05T04:30:00.000Z',
      })
      const deletedClinic = await db
        .from('clinics')
        .delete()
        .eq('id', clinic23b.clinicId)
      expect(deletedClinic.error).toBeNull()
      expect(await rowExists('doctor_profiles', recreated)).toBe(false)
    }, 120_000)
  })
})

// ------------------------------------------------------------
// Fixture helpers.
// ------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(DB_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * Signs in with the ANON key and returns a client whose every request
 * carries that user's access token — i.e. RLS is genuinely in force for
 * the session. The service-role client must never stand in for this.
 */
async function sessionClient(email: string, password: string = PASSWORD): Promise<SupabaseClient> {
  const client = anonClient()
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`fixture sign-in (${email}): ${error.message}`)
  return client
}

function nextSeq(): number {
  seq += 1
  return seq
}

function slugFor(label: string): string {
  return `${TAG}-${label}`
}

function wacrmId(): string {
  return `${TAG}-acct-${nextSeq()}`
}

function phoneNumberId(): string {
  return `${DIGITS}${String(nextSeq()).padStart(3, '0')}`
}

function waPhone(): string {
  return `+91${DIGITS}${String(nextSeq()).padStart(3, '0')}`
}

interface RpcResult {
  data: unknown
  error: { message: string; code?: string } | null
}

function rpcRow<T>(result: RpcResult, label: string): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | T
    | undefined
  if (!row) throw new Error(`${label}: rpc returned no row`)
  return row
}

async function createAuthUser(
  label: string,
  fullName: string | null,
): Promise<{ userId: string; email: string }> {
  const email = `${TAG}-${label}@example.test`
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    // /signup writes the typed name here; create_clinic_with_owner reads
    // it back when p_full_name is NULL.
    user_metadata: fullName ? { full_name: fullName } : {},
  })
  if (error || !data.user) throw new Error(`fixture user: ${error?.message}`)
  createdUsers.push(data.user.id)
  return { userId: data.user.id, email }
}

/** A clinic founded the product way: signed-in user, create_clinic_with_owner. */
async function foundClinic(label: string, fullName: string): Promise<Clinic> {
  const user = await createAuthUser(label, fullName)
  const client = await sessionClient(user.email)
  const slug = slugFor(label)
  const row = rpcRow<CreateClinicRow>(
    await client.rpc('create_clinic_with_owner', {
      p_name: `${fullName} Clinic ${TAG}`,
      p_slug: slug,
      p_timezone: TZ,
      p_full_name: null,
    }),
    `foundClinic(${label})`,
  )
  if (row.outcome !== 'created' || !row.clinic_id || !row.member_id) {
    throw new Error(`foundClinic(${label}): outcome ${row.outcome}`)
  }
  createdClinics.push(row.clinic_id)
  return {
    clinicId: row.clinic_id,
    slug,
    client,
    admin: {
      userId: user.userId,
      email: user.email,
      memberId: row.member_id,
      fullName,
      profileId: null,
    },
  }
}

/**
 * A colleague, written with the service role. Used where the member's
 * ARRIVAL is not what the case is about (the invite path itself is cases
 * 11-13) — including the disabled and non-doctor shapes the RPCs refuse
 * to create.
 */
async function addMember(
  clinicId: string,
  label: string,
  role: MemberRole,
  opts: {
    fullName?: string
    status?: 'active' | 'disabled'
    withProfile?: { specialty?: string | null; slotMinutes?: number }
  } = {},
): Promise<Member> {
  const fullName = opts.fullName ?? `Member ${label}`
  const user = await createAuthUser(label, fullName)
  const mirrored = await db
    .from('users')
    .insert({ id: user.userId, full_name: fullName, email: user.email })
  if (mirrored.error) throw new Error(`fixture users row: ${mirrored.error.message}`)

  const { data: member, error } = await db
    .from('clinic_members')
    .insert({
      clinic_id: clinicId,
      user_id: user.userId,
      role,
      status: opts.status ?? 'active',
    })
    .select('id')
    .single()
  if (error || !member) throw new Error(`fixture member: ${error?.message}`)

  let profileId: string | null = null
  if (opts.withProfile) {
    const { data: profile, error: profileErr } = await db
      .from('doctor_profiles')
      .insert({
        clinic_member_id: member.id as string,
        clinic_id: clinicId,
        specialty: opts.withProfile.specialty ?? null,
        slot_duration_minutes: opts.withProfile.slotMinutes ?? 15,
      })
      .select('id')
      .single()
    if (profileErr || !profile) {
      throw new Error(`fixture profile: ${profileErr?.message}`)
    }
    profileId = profile.id as string
  }

  return {
    userId: user.userId,
    email: user.email,
    memberId: member.id as string,
    fullName,
    profileId,
  }
}

/** A doctor profile written through the clinic admin's own session. */
async function giveDoctorProfile(
  clinic: Clinic,
  member: Member,
  input: { specialty: string | null; slotMinutes: number },
): Promise<string> {
  const { data, error } = await clinic.client
    .from('doctor_profiles')
    .upsert(
      {
        clinic_member_id: member.memberId,
        clinic_id: clinic.clinicId,
        specialty: input.specialty,
        slot_duration_minutes: input.slotMinutes,
      },
      { onConflict: 'clinic_member_id' },
    )
    .select('id')
    .single()
  if (error || !data) throw new Error(`fixture doctor profile: ${error?.message}`)
  return data.id as string
}

function connect(
  clinic: Clinic,
  wacrmAccountId: string,
  phone?: string,
  displayNumber?: string,
) {
  return clinic.client.rpc('connect_wacrm_account', {
    p_clinic_id: clinic.clinicId,
    p_wacrm_account_id: wacrmAccountId,
    p_phone_number_id: phone ?? null,
    p_display_number: displayNumber ?? null,
  })
}

async function activeWacrmRows(
  clinicId: string,
): Promise<Array<{ wacrm_account_id: string; status: string }>> {
  const { data, error } = await db
    .from('clinic_wacrm_accounts')
    .select('wacrm_account_id, status')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
  if (error) throw new Error(`wacrm rows: ${error.message}`)
  return (data ?? []) as Array<{ wacrm_account_id: string; status: string }>
}

async function activeNumbers(
  clinicId: string,
): Promise<Array<{ phone_number_id: string; status: string }>> {
  const { data, error } = await db
    .from('clinic_whatsapp_numbers')
    .select('phone_number_id, status')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
  if (error) throw new Error(`number rows: ${error.message}`)
  return (data ?? []) as Array<{ phone_number_id: string; status: string }>
}

async function issueInvite(
  clinicId: string,
  email: string,
  role: MemberRole,
  opts: {
    specialty?: string | null
    slotMinutes?: number | null
    expiresAt?: string
  } = {},
): Promise<{ token: string; tokenHash: string }> {
  const token = generateInviteToken()
  const tokenHash = hashInviteToken(token)
  const isDoctor = role === 'doctor'
  const { error } = await db.from('clinic_invites').insert({
    clinic_id: clinicId,
    email: email.toLowerCase(),
    role,
    specialty: isDoctor ? (opts.specialty ?? null) : null,
    slot_duration_minutes: isDoctor ? (opts.slotMinutes ?? null) : null,
    token_hash: tokenHash,
    expires_at:
      opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
  })
  if (error) throw new Error(`fixture invite: ${error.message}`)
  return { token, tokenHash }
}

/** accept_clinic_invite called directly, on a session that is already signed in. */
function accept(client: SupabaseClient, tokenHash: string, fullName: string) {
  return client.rpc('accept_clinic_invite', {
    p_token_hash: tokenHash,
    p_full_name: fullName,
  })
}

async function clinicDoctorNames(
  client: SupabaseClient,
  clinicId: string,
): Promise<string[]> {
  const { data, error } = await client.rpc('clinic_doctor_names', {
    target_clinic: clinicId,
  })
  if (error) throw new Error(`clinic_doctor_names: ${error.message}`)
  return ((data ?? []) as Array<{ full_name: string | null }>)
    .map((row) => row.full_name)
    .filter((name): name is string => Boolean(name))
}

async function addService(
  clinicId: string,
  name: string,
  priceCents: number,
): Promise<string> {
  const { data, error } = await db
    .from('services')
    .insert({ clinic_id: clinicId, name, price_cents: priceCents })
    .select('id')
    .single()
  if (error || !data) throw new Error(`fixture service: ${error?.message}`)
  return data.id as string
}

async function addPatient(clinicId: string): Promise<string> {
  const { data, error } = await db
    .from('patients')
    .insert({ clinic_id: clinicId, wa_phone: waPhone(), full_name: 'Fixture Patient' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`fixture patient: ${error?.message}`)
  return data.id as string
}

async function addAppointment(
  clinicId: string,
  doctorId: string,
  patientId: string,
  opts: {
    startsAt: string
    endsAt: string
    status?: 'booked' | 'completed'
    serviceId?: string | null
  },
): Promise<string> {
  const { data, error } = await db
    .from('appointments')
    .insert({
      clinic_id: clinicId,
      doctor_id: doctorId,
      patient_id: patientId,
      starts_at: opts.startsAt,
      ends_at: opts.endsAt,
      status: opts.status ?? 'booked',
      service_id: opts.serviceId ?? null,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`fixture appointment: ${error?.message}`)
  return data.id as string
}

/** Mon-Sun 09:00-17:00, written through the given session (RLS in force). */
async function addWeeklyAvailability(
  client: SupabaseClient,
  clinicId: string,
  doctorId: string,
): Promise<void> {
  const rows = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    clinic_id: clinicId,
    doctor_id: doctorId,
    weekday,
    start_time: '09:00:00',
    end_time: '17:00:00',
    active: true,
  }))
  const { error } = await client.from('availability_rules').insert(rows)
  if (error) throw new Error(`fixture availability: ${error.message}`)
}

async function countTaggedClinics(): Promise<number> {
  const { count, error } = await db
    .from('clinics')
    .select('id', { count: 'exact', head: true })
    .like('slug', `${TAG}%`)
  if (error) throw new Error(`clinic count: ${error.message}`)
  return count ?? 0
}

async function countMembers(clinicId: string): Promise<number> {
  const { count, error } = await db
    .from('clinic_members')
    .select('id', { count: 'exact', head: true })
    .eq('clinic_id', clinicId)
  if (error) throw new Error(`member count: ${error.message}`)
  return count ?? 0
}

async function rowExists(table: string, id: string): Promise<boolean> {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('id', id)
  if (error) throw new Error(`${table} exists: ${error.message}`)
  return (count ?? 0) > 0
}
