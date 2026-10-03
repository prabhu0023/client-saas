import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Two things are pinned here that nothing else can catch.
 *
 * 1. The signupMode() truth table, including the fail-closed cases. The
 *    mode is the only thing standing between a deployed instance and
 *    anyone creating a tenant, and the dangerous failure (open when it
 *    should be disabled) is invisible in a passing build.
 *
 * 2. The captured createUser payload. createClinic() passes
 *    p_full_name = NULL, so create_clinic_with_owner reads the name back
 *    from auth.users.raw_user_meta_data->>'full_name'. A createUser call
 *    that omits user_metadata type-checks, passes every other test here,
 *    and silently leaves users.full_name NULL — which loadDoctorOptions()
 *    renders to patients as the literal 'Doctor'. This assertion is the
 *    only unit-level guard on that mechanism.
 */

const { timingSafeEqual: realTimingSafeEqual } = await vi.importActual<
  typeof import('node:crypto')
>('node:crypto')

/**
 * Wraps the real timingSafeEqual so the equal-length path still compares
 * properly, while the call log proves the unequal-length path never
 * reaches it — that call throws, so a missing length check would be a 500
 * on every wrong-length guess.
 */
const timingSafeEqualSpy = vi.fn((a: Uint8Array, b: Uint8Array) =>
  realTimingSafeEqual(a, b),
)

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => timingSafeEqualSpy(a, b),
  }
})

interface CreateUserPayload {
  email: string
  password: string
  email_confirm?: boolean
  user_metadata?: { full_name?: string }
}

let createUserCalls: CreateUserPayload[] = []
let createUserResult: {
  data: { user: { id: string } | null }
  error: { code?: string; status?: number; message: string } | null
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        createUser: async (payload: CreateUserPayload) => {
          createUserCalls.push(payload)
          return createUserResult
        },
      },
    },
  }),
}))

let signInCalls: Array<{ email: string; password: string }> = []
let signInError: { message: string } | null = null
const createClientSpy = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    createClientSpy()
    return {
      auth: {
        signInWithPassword: async (args: { email: string; password: string }) => {
          signInCalls.push(args)
          return { data: {}, error: signInError }
        },
      },
    }
  },
}))

const { signupMode, isValidSignupCode, createAuthAccount, signInNewAccount } =
  await import('./signup')

const ORIGINAL_CODE = process.env.ONBOARDING_SIGNUP_CODE
const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV

/** NODE_ENV is readonly in @types/node, so write it through the record. */
function setEnv(key: string, value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>
  if (value === undefined) delete env[key]
  else env[key] = value
}

beforeEach(() => {
  vi.clearAllMocks()
  createUserCalls = []
  signInCalls = []
  signInError = null
  createUserResult = { data: { user: { id: 'user-1' } }, error: null }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  setEnv('ONBOARDING_SIGNUP_CODE', ORIGINAL_CODE)
  setEnv('NODE_ENV', ORIGINAL_NODE_ENV)
  setEnv('VERCEL_ENV', ORIGINAL_VERCEL_ENV)
  vi.restoreAllMocks()
})

describe('signupMode', () => {
  it.each(['development', 'test', 'production'])(
    'is coded whenever a code is set (NODE_ENV=%s)',
    (nodeEnv) => {
      setEnv('ONBOARDING_SIGNUP_CODE', 's3cret')
      setEnv('NODE_ENV', nodeEnv)
      expect(signupMode()).toBe('coded')
    },
  )

  it('is open only for a local dev server with no code', () => {
    setEnv('ONBOARDING_SIGNUP_CODE', undefined)
    setEnv('NODE_ENV', 'development')
    expect(signupMode()).toBe('open')
  })

  it('is disabled in production with no code', () => {
    setEnv('ONBOARDING_SIGNUP_CODE', undefined)
    setEnv('NODE_ENV', 'production')
    expect(signupMode()).toBe('disabled')
  })

  it('is disabled on a PREVIEW deployment with no code — never keyed on VERCEL_ENV', () => {
    setEnv('ONBOARDING_SIGNUP_CODE', undefined)
    setEnv('NODE_ENV', 'production')
    setEnv('VERCEL_ENV', 'preview')
    expect(signupMode()).toBe('disabled')
  })

  it('is disabled under NODE_ENV=test with no code', () => {
    setEnv('ONBOARDING_SIGNUP_CODE', undefined)
    setEnv('NODE_ENV', 'test')
    expect(signupMode()).toBe('disabled')
  })

  it('treats an empty code as unset, so it fails closed in production', () => {
    setEnv('ONBOARDING_SIGNUP_CODE', '')
    setEnv('NODE_ENV', 'production')
    expect(signupMode()).toBe('disabled')
  })
})

describe('isValidSignupCode', () => {
  beforeEach(() => {
    setEnv('ONBOARDING_SIGNUP_CODE', 's3cret-code')
  })

  it('accepts the configured code', () => {
    expect(isValidSignupCode('s3cret-code')).toBe(true)
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects a same-length wrong code, comparing it in constant time', () => {
    expect(isValidSignupCode('s3cret-cods')).toBe(false)
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects a shorter guess WITHOUT calling timingSafeEqual, which throws on unequal lengths', () => {
    expect(isValidSignupCode('s3c')).toBe(false)
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })

  it('rejects a longer guess the same way', () => {
    expect(isValidSignupCode('s3cret-code-plus')).toBe(false)
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })

  it('rejects an empty submission', () => {
    expect(isValidSignupCode('')).toBe(false)
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })

  it('rejects everything when no code is configured', () => {
    setEnv('ONBOARDING_SIGNUP_CODE', undefined)
    expect(isValidSignupCode('anything')).toBe(false)
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })
})

describe('createAuthAccount', () => {
  const input = {
    email: 'admin@clinic.com',
    password: 'abcd1234',
    fullName: 'Dr. Asha Rao',
  }

  it('creates a CONFIRMED account carrying full_name in user_metadata', async () => {
    await expect(createAuthAccount(input)).resolves.toEqual({
      status: 'created',
      userId: 'user-1',
    })

    expect(createUserCalls).toHaveLength(1)
    expect(createUserCalls[0]).toEqual({
      email: 'admin@clinic.com',
      password: 'abcd1234',
      email_confirm: true,
      user_metadata: { full_name: 'Dr. Asha Rao' },
    })
  })

  it('passes the name through exactly as given — the caller trims it', async () => {
    await createAuthAccount({ ...input, fullName: 'Asha R' })
    expect(createUserCalls[0].user_metadata).toEqual({ full_name: 'Asha R' })
  })

  it('maps a 422 email_exists to email_taken', async () => {
    createUserResult = {
      data: { user: null },
      error: { code: 'email_exists', status: 422, message: 'User already registered' },
    }
    await expect(createAuthAccount(input)).resolves.toEqual({ status: 'email_taken' })
  })

  it('maps a 422 with no code but an "already registered" message to email_taken', async () => {
    createUserResult = {
      data: { user: null },
      error: { status: 422, message: 'A user with this email address has already been registered' },
    }
    await expect(createAuthAccount(input)).resolves.toEqual({ status: 'email_taken' })
  })

  it('keeps an unrelated 422 fatal rather than calling it email_taken', async () => {
    createUserResult = {
      data: { user: null },
      error: { status: 422, code: 'weak_password', message: 'Password is too weak' },
    }
    const result = await createAuthAccount(input)
    expect(result.status).toBe('error')
  })

  it('returns an error for any other failure', async () => {
    createUserResult = {
      data: { user: null },
      error: { status: 500, message: 'service key missing' },
    }
    await expect(createAuthAccount(input)).resolves.toEqual({
      status: 'error',
      message: 'service key missing',
    })
  })

  it('returns an error when createUser reports success with no user', async () => {
    createUserResult = { data: { user: null }, error: null }
    expect((await createAuthAccount(input)).status).toBe('error')
  })

  it('never logs the email or the password', async () => {
    createUserResult = {
      data: { user: null },
      error: { status: 500, message: 'boom' },
    }
    await createAuthAccount(input)

    const logged = [
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]
      .flat()
      .join(' ')
    expect(logged).not.toContain('admin@clinic.com')
    expect(logged).not.toContain('abcd1234')
  })
})

describe('signInNewAccount', () => {
  it('signs in on the cookie client', async () => {
    await expect(signInNewAccount('admin@clinic.com', 'abcd1234')).resolves.toEqual({
      status: 'signed_in',
    })
    expect(createClientSpy).toHaveBeenCalledTimes(1)
    expect(signInCalls).toEqual([{ email: 'admin@clinic.com', password: 'abcd1234' }])
  })

  it('returns an error without throwing when the credentials are refused', async () => {
    signInError = { message: 'Invalid login credentials' }
    await expect(signInNewAccount('admin@clinic.com', 'nope1234')).resolves.toEqual({
      status: 'error',
      message: 'Invalid login credentials',
    })
  })
})
