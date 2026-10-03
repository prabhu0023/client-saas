import { redirect } from 'next/navigation'
import { requireStaff, type StaffContext } from './auth'
import type { ClinicMember } from '@/types'

/**
 * Role gate for the admin-only portal screens (/setup, /staff, /services).
 *
 * This is a FRIENDLY refusal, not the security boundary. The boundary is
 * RLS: migration 014 splits the seven tenant-configuration tables into
 * member-read + admin-write policies keyed on `is_clinic_admin()`, so a
 * hand-crafted client with a receptionist session is refused by the
 * database whether or not it ever renders a page. What this adds is a
 * redirect instead of a confusing empty screen or a raw 42501.
 */

export function isAdmin(member: ClinicMember): boolean {
  return member.role === 'admin'
}

/**
 * Like requireStaff(), plus the admin check. Non-admins land on the
 * dashboard with ?error=admin-only, which the dashboard renders as a
 * notice — otherwise the redirect is silent and looks like a bug.
 */
export async function requireAdmin(): Promise<StaffContext> {
  const context = await requireStaff()

  if (!isAdmin(context.member)) {
    console.warn(`[staff] admin-only route refused for role ${context.member.role}`)
    redirect('/dashboard?error=admin-only')
  }

  return context
}
