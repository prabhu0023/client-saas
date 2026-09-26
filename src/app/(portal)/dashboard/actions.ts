'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/portal/auth'
import { notifyPatientCancelled } from '@/lib/whatsapp/notify'
import type { AppointmentStatus } from '@/types'

// Statuses a staff member can set from the dashboard. 'booked' is the
// initial state set at creation; the portal moves appointments forward
// (or cancels) from there.
const SETTABLE: readonly AppointmentStatus[] = [
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
]

/**
 * Update an appointment's status. RLS ensures the caller can only touch
 * appointments in a clinic they're an active member of; requireStaff()
 * additionally guarantees there is a valid session. Revalidates the
 * dashboard for the given date so the change shows immediately.
 */
export async function updateAppointmentStatus(formData: FormData): Promise<void> {
  await requireStaff()

  const id = String(formData.get('id') ?? '')
  const status = String(formData.get('status') ?? '') as AppointmentStatus
  const date = String(formData.get('date') ?? '')

  if (!id || !SETTABLE.includes(status)) {
    throw new Error('invalid status update')
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('appointments')
    .update({ status })
    .eq('id', id)

  if (error) throw new Error(`status update failed: ${error.message}`)

  // Staff-initiated cancellation → tell the patient over WhatsApp.
  // Best-effort: notification failure must not fail the status change,
  // which has already committed. Reuses the RLS-scoped client so the
  // read stays inside the caller's clinic.
  if (status === 'cancelled') {
    await notifyPatientCancelled(supabase, id)
  }

  // Revalidate the dashboard (with the date preserved if present).
  revalidatePath('/dashboard')
  if (date) revalidatePath(`/dashboard?date=${date}`)
}
