import { describe, it, expect, afterEach } from 'vitest'
import {
  generateInviteToken,
  hashInviteToken,
  inviteUrl,
  INVITE_TOKEN_RE,
} from './invite-token'

/**
 * The token is the only thing authorizing an account creation on /join,
 * so its shape, its entropy and the fact that only a hash is ever stored
 * are all asserted here rather than assumed.
 */

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
})

describe('generateInviteToken', () => {
  it('produces 43 base64url characters', () => {
    const token = generateInviteToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).toMatch(INVITE_TOKEN_RE)
  })

  it('produces no padding and no URL-unsafe characters', () => {
    for (let i = 0; i < 100; i += 1) {
      const token = generateInviteToken()
      expect(token).not.toContain('=')
      expect(token).not.toContain('+')
      expect(token).not.toContain('/')
    }
  })

  it('produces 1000 distinct tokens', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i += 1) tokens.add(generateInviteToken())
    expect(tokens.size).toBe(1000)
  })
})

describe('hashInviteToken', () => {
  it('is deterministic and 64 hex characters', () => {
    const token = generateInviteToken()
    const hash = hashInviteToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInviteToken(token)).toBe(hash)
  })

  it('matches the known sha256 of a fixed input', () => {
    // Pins the algorithm and the encoding, so a future "optimisation" to a
    // different digest cannot silently orphan every stored token_hash.
    expect(hashInviteToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('differs for a one-character change', () => {
    const token = generateInviteToken()
    const flipped = `${token.slice(0, 42)}${token[42] === 'a' ? 'b' : 'a'}`
    expect(hashInviteToken(flipped)).not.toBe(hashInviteToken(token))
  })

  it('never returns the token itself', () => {
    const token = generateInviteToken()
    expect(hashInviteToken(token)).not.toContain(token)
  })
})

describe('inviteUrl', () => {
  it('builds <base>/join/<token>', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.doctordesk.in'
    expect(inviteUrl('tok')).toBe('https://app.doctordesk.in/join/tok')
  })

  it('strips a trailing slash from the base', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.doctordesk.in/'
    expect(inviteUrl('tok')).toBe('https://app.doctordesk.in/join/tok')
  })

  it('strips repeated trailing slashes', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.doctordesk.in///'
    expect(inviteUrl('tok')).toBe('https://app.doctordesk.in/join/tok')
  })

  it('throws when NEXT_PUBLIC_APP_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(() => inviteUrl('tok')).toThrow(/NEXT_PUBLIC_APP_URL/)
  })

  it('throws when NEXT_PUBLIC_APP_URL is empty', () => {
    process.env.NEXT_PUBLIC_APP_URL = ''
    expect(() => inviteUrl('tok')).toThrow(/NEXT_PUBLIC_APP_URL/)
  })
})
