import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Clinic, ClinicMember, MemberRole } from '@/types'
import type { StaffContext } from './auth'

/**
 * requireAdmin() is the friendly half of the admin gate (RLS in 014 is
 * the real one), so what is asserted here is the branch: admins get the
 * context back untouched, every other role is redirected to the dashboard
 * with the notice code the dashboard knows how to render.
 *
 * redirect() is mocked to THROW, because that is what Next's real
 * implementation does — a mock that returned normally would let execution
 * fall through to `return context` and hide a missing redirect.
 */

const requireStaffMock = vi.fn<() => Promise<StaffContext>>()
const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})

vi.mock('@/lib/portal/auth', () => ({
  requireStaff: () => requireStaffMock(),
}))

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}))

const { isAdmin, requireAdmin } = await import('./roles')

const CLINIC: Clinic = {
  id: 'clinic-a',
  name: 'Sunrise Clinic',
  slug: 'sunrise-clinic',
  timezone: 'Asia/Kolkata',
  status: 'active',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
}

function contextFor(role: MemberRole): StaffContext {
  const member: ClinicMember = {
    id: 'member-1',
    clinic_id: CLINIC.id,
    user_id: 'user-1',
    role,
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
  }
  return { userId: 'user-1', email: 'staff@clinic.com', member, clinic: CLINIC }
}

beforeEach(() => {
  vi.clearAllMocks()
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  })
})

describe('isAdmin', () => {
  it('is true only for role admin', () => {
    expect(isAdmin(contextFor('admin').member)).toBe(true)
    for (const role of ['doctor', 'nurse', 'receptionist'] as const) {
      expect(isAdmin(contextFor(role).member)).toBe(false)
    }
  })
})

describe('requireAdmin', () => {
  it('returns the staff context for an admin', async () => {
    const context = contextFor('admin')
    requireStaffMock.mockResolvedValue(context)

    await expect(requireAdmin()).resolves.toBe(context)
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it.each(['doctor', 'nurse', 'receptionist'] as const)(
    'redirects a %s to /dashboard?error=admin-only',
    async (role) => {
      requireStaffMock.mockResolvedValue(contextFor(role))

      await expect(requireAdmin()).rejects.toThrow(
        'NEXT_REDIRECT:/dashboard?error=admin-only',
      )
      expect(redirectMock).toHaveBeenCalledWith('/dashboard?error=admin-only')
    },
  )

  it('never logs the user id or email on a refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    requireStaffMock.mockResolvedValue(contextFor('receptionist'))

    await expect(requireAdmin()).rejects.toThrow()

    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toContain('staff@clinic.com')
    expect(logged).not.toContain('user-1')
    warn.mockRestore()
  })

  it('propagates requireStaff()\u2019s own redirect without checking the role', async () => {
    requireStaffMock.mockRejectedValue(new Error('NEXT_REDIRECT:/login'))

    await expect(requireAdmin()).rejects.toThrow('NEXT_REDIRECT:/login')
    expect(redirectMock).not.toHaveBeenCalled()
  })
})
