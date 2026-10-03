import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'

/**
 * Tests for the invite layer (ONB-2, design §13.1).
 *
 * Both Supabase clients are faked at the module boundary, and every call
 * either client receives is appended to one ordered `log`. That log is the
 * point: three of the assertions here are about calls that must or must
 * NOT happen, and in what order —
 *
 *  - `createInvite` must reach `inviteUrl()` BEFORE any write, so a
 *    missing NEXT_PUBLIC_APP_URL cannot burn a token;
 *  - the duplicate-member check must go through
 *    `clinic_member_identities` and NEVER `from('users')`, because
 *    `users_self_access` would make a `users` lookup a silent no-op;
 *  - `acceptInvite` must create the cookie client exactly ONCE and call
 *    `signInWithPassword` and `rpc('accept_clinic_invite')` on that same
 *    instance (§9.3 step 4) — so the fake deliberately hands out a NEW
 *    client object per `createClient()` call, which is what makes the
 *    same-object assertion meaningful rather than tautological.
 */

type Row = Record<string, unknown>
type DbError = { code?: string; status?: number; message: string }

interface FakeClient {
  id: number
  from: (table: string) => ReturnType<typeof makeBuilder>
  rpc: (fn: string, args?: Row) => Promise<{ data: unknown; error: unknown }>
  auth: {
    signInWithPassword: (creds: { email: string; password: string }) => Promise<{
      data: unknown
      error: unknown
    }>
  }
}

const CLINIC = 'clinic-a'
const OTHER_CLINIC = 'clinic-b'
const USER = 'user-1'

let db: Record<string, Row[]>
/** Every client/admin operation, in order. */
let log: string[]
/** Captured write payloads: { mode, table, payload }. */
let writes: Array<{ mode: string; table: string; payload: unknown }>
/** Queued errors keyed `${mode}:${table}`; each read is consumed. */
let errors: Record<string, DbError[]>
let rpcResults: Record<string, { data: unknown; error: unknown }>
let rpcCalls: Array<{ client: FakeClient; fn: string; args: Row | null }>
let signInCalls: Array<{ client: FakeClient; email: string; password: string }>
let signInError: DbError | null
let createClientCalls: number
let clientSeq: number

/** What the mocked admin client's clinic_invites lookup returns. */
let adminInvite: Row | null
let adminInviteError: DbError | null
let adminEqArgs: Array<[string, unknown]>
let createUserResult: { data: { user: { id: string } | null }; error: DbError | null }
let createUserPayload: Row | null

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    createClientCalls += 1
    return newClient()
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => makeAdminBuilder(),
    auth: {
      admin: {
        createUser: async (payload: Row) => {
          log.push('admin:createUser')
          createUserPayload = payload
          return createUserResult
        },
      },
    },
  }),
}))

function newClient(): FakeClient {
  clientSeq += 1
  const id = clientSeq
  const client: FakeClient = {
    id,
    from: (table: string) => makeBuilder(id, table),
    rpc: async (fn: string, args?: Row) => {
      log.push(`c${id}:rpc:${fn}`)
      rpcCalls.push({ client, fn, args: args ?? null })
      return rpcResults[fn] ?? { data: null, error: null }
    },
    auth: {
      signInWithPassword: async (creds: { email: string; password: string }) => {
        log.push(`c${id}:signIn`)
        signInCalls.push({ client, email: creds.email, password: creds.password })
        if (signInError) return { data: { user: null }, error: signInError }
        return { data: { user: { id: USER } }, error: null }
      },
    },
  }
  return client
}

/** The service-role read in loadInviteByToken. */
function makeAdminBuilder() {
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      adminEqArgs.push([col, val])
      return chain
    },
    maybeSingle: async () => {
      log.push('admin:select:clinic_invites')
      if (adminInviteError) return { data: null, error: adminInviteError }
      return { data: adminInvite, error: null }
    },
  }
  return chain
}

function takeError(key: string): DbError | null {
  const queue = errors[key]
  if (!queue || queue.length === 0) return null
  return queue.shift() ?? null
}

function makeBuilder(clientId: number, table: string) {
  let mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let patch: Row = {}
  let payload: Row | null = null
  const filters: Array<[string, unknown]> = []
  let max: number | null = null
  let head = false

  function matching(): Row[] {
    return (db[table] ?? []).filter((r) =>
      filters.every(([col, val]) => r[col] === val),
    )
  }

  function run(): { data: unknown; error: unknown; count: number | null } {
    log.push(`c${clientId}:${mode}:${table}`)
    const err = takeError(`${mode}:${table}`)
    if (err) return { data: null, error: err, count: null }

    if (mode === 'insert' || mode === 'upsert') {
      writes.push({ mode, table, payload })
      if (payload) db[table] = [...(db[table] ?? []), { ...payload }]
      return { data: payload ? [payload] : [], error: null, count: null }
    }
    if (mode === 'update') {
      const hit = matching()
      for (const row of hit) Object.assign(row, patch)
      writes.push({ mode, table, payload: patch })
      return { data: hit, error: null, count: hit.length }
    }
    if (mode === 'delete') {
      const hit = matching()
      db[table] = (db[table] ?? []).filter((r) => !hit.includes(r))
      writes.push({ mode, table, payload: null })
      return { data: hit, error: null, count: hit.length }
    }
    const rows = matching()
    return {
      data: head ? null : max == null ? rows : rows.slice(0, max),
      error: null,
      count: rows.length,
    }
  }

  const chain = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) head = true
      return chain
    },
    insert: (value: Row) => {
      mode = 'insert'
      payload = value
      return chain
    },
    upsert: (value: Row) => {
      mode = 'upsert'
      payload = value
      return chain
    },
    update: (value: Row) => {
      mode = 'update'
      patch = value
      return chain
    },
    delete: () => {
      mode = 'delete'
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val])
      return chain
    },
    order: () => chain,
    limit: (n: number) => {
      max = n
      return chain
    },
    maybeSingle: async () => {
      const res = run()
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data
      return { data, error: res.error, count: res.count }
    },
    then: (resolve: (v: { data: unknown; error: unknown; count: number | null }) => unknown) =>
      Promise.resolve(run()).then(resolve),
  }
  return chain
}

import {
  acceptInvite,
  createInvite,
  listInvites,
  loadInviteByToken,
  revokeInvite,
} from './invites'
import { hashInviteToken } from './invite-token'

const BASE = 'https://clinic.example'
const TOKEN = 'a'.repeat(43)
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = BASE
  db = {
    clinic_invites: [],
    clinic_members: [{ id: 'm-admin', clinic_id: CLINIC, status: 'active' }],
  }
  log = []
  writes = []
  errors = {}
  rpcResults = {
    clinic_member_identities: {
      data: [
        {
          member_id: 'm-admin',
          user_id: 'u-admin',
          full_name: 'Dr Admin',
          email: 'admin@clinic.test',
        },
      ],
      error: null,
    },
  }
  rpcCalls = []
  signInCalls = []
  signInError = null
  createClientCalls = 0
  clientSeq = 0
  adminInvite = null
  adminInviteError = null
  adminEqArgs = []
  createUserResult = { data: { user: { id: USER } }, error: null }
  createUserPayload = null
})

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
})

function newInvite(over: Partial<Parameters<typeof createInvite>[0]> = {}) {
  return {
    clinicId: CLINIC,
    createdByMemberId: 'm-admin',
    email: 'new.doctor@clinic.test',
    role: 'doctor' as const,
    specialty: 'Cardiology',
    slotMinutes: 20,
    ...over,
  }
}

/** The one insert createInvite is expected to make. */
function insertedInvite(): Row {
  const write = writes.find((w) => w.mode === 'insert' && w.table === 'clinic_invites')
  expect(write).toBeDefined()
  return write!.payload as Row
}

describe('createInvite', () => {
  it('issues a link and stores only the hash of its token', async () => {
    const result = await createInvite(newInvite())

    expect(result.status).toBe('created')
    if (result.status !== 'created') return

    const match = /^https:\/\/clinic\.example\/join\/([A-Za-z0-9_-]{43})$/.exec(result.url)
    expect(match).not.toBeNull()
    const token = match![1]

    const row = insertedInvite()
    expect(row.token_hash).toBe(hashInviteToken(token))
    // The plaintext never reaches the table, under any column name.
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row.role).toBe('doctor')
    expect(row.specialty).toBe('Cardiology')
    expect(row.slot_duration_minutes).toBe(20)
    expect(row.created_by).toBe('m-admin')
    expect(result.replaced).toBe(false)
  })

  it('checks NEXT_PUBLIC_APP_URL before inserting, so no token is burned', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL

    await expect(createInvite(newInvite())).rejects.toThrow(/NEXT_PUBLIC_APP_URL/)

    // Not just "no insert" — no database call at all.
    expect(writes).toEqual([])
    expect(log).toEqual([])
  })

  it('lower-cases and trims the email before storing it', async () => {
    const result = await createInvite(newInvite({ email: '  New.Doctor@Clinic.TEST  ' }))

    expect(result.status).toBe('created')
    expect(insertedInvite().email).toBe('new.doctor@clinic.test')
    if (result.status === 'created') expect(result.email).toBe('new.doctor@clinic.test')
  })

  it('drops doctor-only fields for a non-doctor role (013 CHECK)', async () => {
    await createInvite(newInvite({ role: 'receptionist' }))

    const row = insertedInvite()
    expect(row.specialty).toBeNull()
    expect(row.slot_duration_minutes).toBeNull()
  })

  it('revokes an existing pending invite BEFORE inserting the new one', async () => {
    const existing = {
      id: 'inv-old',
      clinic_id: CLINIC,
      email: 'new.doctor@clinic.test',
      status: 'pending',
    }
    db.clinic_invites = [existing]

    const result = await createInvite(newInvite())

    expect(result.status).toBe('created')
    if (result.status === 'created') expect(result.replaced).toBe(true)
    expect(existing.status).toBe('revoked')

    const revokeAt = log.indexOf('c1:update:clinic_invites')
    const insertAt = log.indexOf('c1:insert:clinic_invites')
    expect(revokeAt).toBeGreaterThanOrEqual(0)
    expect(insertAt).toBeGreaterThan(revokeAt)
  })

  it('returns the link exactly once — a second call issues a different token', async () => {
    const first = await createInvite(newInvite())
    const second = await createInvite(newInvite())

    expect(first.status).toBe('created')
    expect(second.status).toBe('created')
    if (first.status !== 'created' || second.status !== 'created') return
    expect(first.url).not.toBe(second.url)
  })

  it('refuses an email that already belongs to an ACTIVE member', async () => {
    const result = await createInvite(newInvite({ email: 'Admin@Clinic.test' }))

    expect(result.status).toBe('already_member')
    expect(writes).toEqual([])
  })

  it('allows an email whose only membership is disabled', async () => {
    db.clinic_members = [{ id: 'm-admin', clinic_id: CLINIC, status: 'disabled' }]

    const result = await createInvite(newInvite({ email: 'admin@clinic.test' }))

    expect(result.status).toBe('created')
  })

  it('resolves members through clinic_member_identities and NEVER from(users)', async () => {
    await createInvite(newInvite())

    expect(rpcCalls.map((c) => c.fn)).toContain('clinic_member_identities')
    expect(rpcCalls[0].args).toEqual({ target_clinic: CLINIC })
    // A users lookup would silently return zero rows under
    // users_self_access, making the duplicate check a no-op.
    expect(log.some((entry) => entry.includes(':users'))).toBe(false)
  })

  it('retries once on the pending unique index, then reports rather than looping', async () => {
    errors['insert:clinic_invites'] = [{ code: '23505', message: 'duplicate key' }]

    const result = await createInvite(newInvite())
    expect(result.status).toBe('created')
    if (result.status === 'created') expect(result.replaced).toBe(true)
    expect(log.filter((e) => e === 'c1:insert:clinic_invites')).toHaveLength(2)
  })

  it('reports `raced` when the retry loses too', async () => {
    errors['insert:clinic_invites'] = [
      { code: '23505', message: 'duplicate key' },
      { code: '23505', message: 'duplicate key' },
    ]

    expect((await createInvite(newInvite())).status).toBe('raced')
  })

  it('surfaces a non-unique insert failure as an error', async () => {
    errors['insert:clinic_invites'] = [{ code: '08006', message: 'connection lost' }]

    const result = await createInvite(newInvite())
    expect(result.status).toBe('error')
  })
})

describe('listInvites', () => {
  it('returns pending invites with a derived expired flag', async () => {
    db.clinic_invites = [
      {
        id: 'inv-1',
        clinic_id: CLINIC,
        email: 'a@clinic.test',
        role: 'nurse',
        specialty: null,
        slot_duration_minutes: null,
        status: 'pending',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: '2025-05-01T00:00:00Z',
      },
      {
        id: 'inv-2',
        clinic_id: CLINIC,
        email: 'b@clinic.test',
        role: 'doctor',
        specialty: 'ENT',
        slot_duration_minutes: 30,
        status: 'pending',
        expires_at: '2020-01-01T00:00:00Z',
        created_at: '2025-04-01T00:00:00Z',
      },
    ]

    const invites = await listInvites(CLINIC)

    expect(invites.map((i) => i.id)).toEqual(['inv-1', 'inv-2'])
    expect(invites[0].expired).toBe(false)
    expect(invites[1].expired).toBe(true)
    expect(invites[1].slotDurationMinutes).toBe(30)
  })
})

describe('revokeInvite', () => {
  it('revokes a pending invite', async () => {
    db.clinic_invites = [{ id: 'inv-1', clinic_id: CLINIC, status: 'pending' }]

    expect((await revokeInvite(CLINIC, 'inv-1')).status).toBe('ok')
    expect(db.clinic_invites[0].status).toBe('revoked')
  })

  it('reports not_found for an invite that is no longer pending', async () => {
    db.clinic_invites = [{ id: 'inv-1', clinic_id: CLINIC, status: 'accepted' }]

    expect((await revokeInvite(CLINIC, 'inv-1')).status).toBe('not_found')
  })
})

function pendingInviteRow(over: Row = {}): Row {
  return {
    clinic_id: CLINIC,
    role: 'doctor',
    email: 'new.doctor@clinic.test',
    status: 'pending',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    clinics: { name: 'Sunrise Clinic' },
    ...over,
  }
}

describe('loadInviteByToken', () => {
  it('looks the invite up by the token HASH and returns what /join renders', async () => {
    adminInvite = pendingInviteRow()

    const result = await loadInviteByToken(TOKEN)

    expect(adminEqArgs).toEqual([['token_hash', TOKEN_HASH]])
    expect(result).toEqual({
      status: 'ok',
      invite: {
        clinicId: CLINIC,
        clinicName: 'Sunrise Clinic',
        role: 'doctor',
        email: 'new.doctor@clinic.test',
      },
    })
  })

  it('returns expired for a past expires_at even though the row is still pending', async () => {
    adminInvite = pendingInviteRow({ expires_at: '2020-01-01T00:00:00Z' })

    expect((await loadInviteByToken(TOKEN)).status).toBe('expired')
  })

  it('distinguishes accepted, revoked and unknown tokens', async () => {
    adminInvite = pendingInviteRow({ status: 'accepted' })
    expect((await loadInviteByToken(TOKEN)).status).toBe('already_used')

    adminInvite = pendingInviteRow({ status: 'revoked' })
    expect((await loadInviteByToken(TOKEN)).status).toBe('revoked')

    adminInvite = null
    expect((await loadInviteByToken(TOKEN)).status).toBe('not_found')
  })
})

describe('acceptInvite', () => {
  const INPUT = { token: TOKEN, fullName: '  Dr Meera Rao ', password: 'longenough1' }

  beforeEach(() => {
    adminInvite = pendingInviteRow()
    rpcResults.accept_clinic_invite = {
      data: [{ outcome: 'accepted', clinic_id: CLINIC, member_id: 'm-9' }],
      error: null,
    }
  })

  it('enrols a brand-new account: load -> createUser -> signIn -> rpc', async () => {
    const result = await acceptInvite(INPUT)

    expect(result).toEqual({ status: 'accepted', clinicId: CLINIC, memberId: 'm-9' })
    expect(log).toEqual([
      'admin:select:clinic_invites',
      'admin:createUser',
      'c1:signIn',
      'c1:rpc:accept_clinic_invite',
    ])
    expect(createUserPayload).toMatchObject({
      email: 'new.doctor@clinic.test',
      email_confirm: true,
      user_metadata: { full_name: 'Dr Meera Rao' },
    })
    expect(rpcCalls[0].args).toEqual({
      p_token_hash: TOKEN_HASH,
      p_full_name: 'Dr Meera Rao',
    })
  })

  it('creates the cookie client ONCE and runs signIn + rpc on that same instance', async () => {
    await acceptInvite(INPUT)

    expect(createClientCalls).toBe(1)
    expect(signInCalls).toHaveLength(1)
    expect(rpcCalls).toHaveLength(1)
    // Same object, not merely an equal one — a second instance would have
    // to re-read the auth cookie written moments earlier (§9.3 step 4).
    expect(rpcCalls[0].client).toBe(signInCalls[0].client)
  })

  it('treats a 422 email_exists as the existing-account branch and carries on', async () => {
    createUserResult = {
      data: { user: null },
      error: { code: 'email_exists', status: 422, message: 'User already registered' },
    }

    const result = await acceptInvite(INPUT)

    expect(result.status).toBe('accepted')
    expect(log).toEqual([
      'admin:select:clinic_invites',
      'admin:createUser',
      'c1:signIn',
      'c1:rpc:accept_clinic_invite',
    ])
  })

  it('asks an existing account for its password when the sign-in is refused', async () => {
    createUserResult = {
      data: { user: null },
      error: { code: 'email_exists', status: 422, message: 'User already registered' },
    }
    signInError = { message: 'Invalid login credentials' }

    expect((await acceptInvite(INPUT)).status).toBe('wrong_password')
    expect(rpcCalls).toHaveLength(0)
  })

  it('sends a fresh account to /login when its own sign-in fails', async () => {
    signInError = { message: 'service unavailable' }

    expect((await acceptInvite(INPUT)).status).toBe('sign_in_failed')
    expect(rpcCalls).toHaveLength(0)
  })

  it('treats an rpc `unauthenticated` as the sign-in backstop', async () => {
    rpcResults.accept_clinic_invite = {
      data: [{ outcome: 'unauthenticated', clinic_id: null, member_id: null }],
      error: null,
    }

    expect((await acceptInvite(INPUT)).status).toBe('sign_in_failed')
  })

  it('rejects a malformed token with no DB call at all', async () => {
    const result = await acceptInvite({ ...INPUT, token: 'too-short' })

    expect(result.status).toBe('invalid_token')
    expect(log).toEqual([])
    expect(createClientCalls).toBe(0)
  })

  it('validates the form before touching the database', async () => {
    expect((await acceptInvite({ ...INPUT, fullName: '   ' })).status).toBe('invalid_name')
    expect(await acceptInvite({ ...INPUT, password: 'short' })).toEqual({
      status: 'invalid_password',
      reason: 'short',
    })
    expect(await acceptInvite({ ...INPUT, password: 'x'.repeat(73) })).toEqual({
      status: 'invalid_password',
      reason: 'long',
    })
    expect(log).toEqual([])
  })

  it('stops at the invite when it is already expired', async () => {
    adminInvite = pendingInviteRow({ expires_at: '2020-01-01T00:00:00Z' })

    expect((await acceptInvite(INPUT)).status).toBe('expired')
    expect(log).toEqual(['admin:select:clinic_invites'])
  })

  it('tells an already-active member of THIS clinic apart from one elsewhere', async () => {
    rpcResults.accept_clinic_invite = {
      data: [{ outcome: 'already_member', clinic_id: CLINIC, member_id: null }],
      error: null,
    }
    db.clinic_members = [{ id: 'm-1', clinic_id: CLINIC, status: 'active' }]

    expect(await acceptInvite(INPUT)).toEqual({ status: 'already_member', sameClinic: true })

    db.clinic_members = [{ id: 'm-1', clinic_id: OTHER_CLINIC, status: 'active' }]

    expect(await acceptInvite(INPUT)).toEqual({ status: 'already_member', sameClinic: false })
  })

  it('passes doctor_profile_exists through for the re-issue copy', async () => {
    rpcResults.accept_clinic_invite = {
      data: [{ outcome: 'doctor_profile_exists', clinic_id: CLINIC, member_id: null }],
      error: null,
    }

    expect((await acceptInvite(INPUT)).status).toBe('doctor_profile_exists')
  })

  it('passes the raced invite outcomes through', async () => {
    for (const outcome of ['already_used', 'revoked', 'expired', 'not_found'] as const) {
      rpcResults.accept_clinic_invite = {
        data: [{ outcome, clinic_id: CLINIC, member_id: null }],
        error: null,
      }
      expect((await acceptInvite(INPUT)).status).toBe(outcome)
    }
  })

  it('surfaces email_mismatch as its own outcome (direct rpc caller only)', async () => {
    rpcResults.accept_clinic_invite = {
      data: [{ outcome: 'email_mismatch', clinic_id: CLINIC, member_id: null }],
      error: null,
    }

    expect((await acceptInvite(INPUT)).status).toBe('email_mismatch')
  })

  it('does not call the rpc when createUser fails for a real reason', async () => {
    createUserResult = {
      data: { user: null },
      error: { status: 422, message: 'Password should be at least 6 characters' },
    }

    expect((await acceptInvite(INPUT)).status).toBe('error')
    expect(signInCalls).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })
})
