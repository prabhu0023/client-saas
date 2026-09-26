'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireStaff } from '@/lib/portal/auth'
import { validateRule, validateException } from '@/lib/portal/availability-validate'

/**
 * Availability editing (E5-T2). Staff create/toggle/remove a doctor's
 * weekly rules and date exceptions. RLS scopes every write to a clinic
 * the caller is an active member of; inputs are validated (see
 * availability-validate.ts) against the same CHECK constraints migration
 * 001 enforces, so we fail with a clear message rather than a raw DB
 * error.
 *
 * A rule/exception change takes effect immediately: slot generation reads
 * these tables live per request, so the next WhatsApp day/time list
 * reflects the edit with no cache to bust.
 */

/** Revalidate the availability screen for the affected doctor. */
function revalidate(doctorId: string): void {
  revalidatePath('/availability')
  revalidatePath(`/availability?doctor=${doctorId}`)
}

/**
 * Confirm the doctor belongs to the caller's clinic before writing. RLS
 * already blocks cross-clinic writes, but this gives a clean error
 * instead of a silent no-op.
 */
async function assertDoctorInClinic(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  doctorId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('doctor_profiles')
    .select('id')
    .eq('id', doctorId)
    .eq('clinic_id', clinicId)
    .maybeSingle()
  if (error) throw new Error(`doctor check failed: ${error.message}`)
  if (!data) throw new Error('doctor not found in this clinic')
}

export async function addRule(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()
  const doctorId = String(formData.get('doctorId') ?? '')
  if (!doctorId) throw new Error('missing doctor')

  const result = validateRule({
    weekday: Number(formData.get('weekday')),
    startTime: String(formData.get('startTime') ?? ''),
    endTime: String(formData.get('endTime') ?? ''),
    slotMinutes: String(formData.get('slotMinutes') ?? ''),
  })
  if (!result.ok) throw new Error(result.error)
  const { weekday, startTime, endTime, slotMinutes } = result.value

  const supabase = await createClient()
  await assertDoctorInClinic(supabase, clinic.id, doctorId)

  const { error } = await supabase.from('availability_rules').insert({
    clinic_id: clinic.id,
    doctor_id: doctorId,
    weekday,
    start_time: startTime,
    end_time: endTime,
    slot_minutes: slotMinutes,
    active: true,
  })
  if (error) throw new Error(`add rule failed: ${error.message}`)

  revalidate(doctorId)
}

export async function toggleRule(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()
  const id = String(formData.get('id') ?? '')
  const doctorId = String(formData.get('doctorId') ?? '')
  const active = String(formData.get('active') ?? '') === 'true'
  if (!id || !doctorId) throw new Error('missing rule')

  const supabase = await createClient()
  const { error } = await supabase
    .from('availability_rules')
    .update({ active })
    .eq('id', id)
    .eq('clinic_id', clinic.id)
  if (error) throw new Error(`toggle rule failed: ${error.message}`)

  revalidate(doctorId)
}

export async function deleteRule(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()
  const id = String(formData.get('id') ?? '')
  const doctorId = String(formData.get('doctorId') ?? '')
  if (!id || !doctorId) throw new Error('missing rule')

  const supabase = await createClient()
  const { error } = await supabase
    .from('availability_rules')
    .delete()
    .eq('id', id)
    .eq('clinic_id', clinic.id)
  if (error) throw new Error(`delete rule failed: ${error.message}`)

  revalidate(doctorId)
}

export async function addException(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()
  const doctorId = String(formData.get('doctorId') ?? '')
  if (!doctorId) throw new Error('missing doctor')

  const result = validateException({
    date: String(formData.get('date') ?? ''),
    kind: String(formData.get('kind') ?? ''),
    startTime: String(formData.get('startTime') ?? ''),
    endTime: String(formData.get('endTime') ?? ''),
  })
  if (!result.ok) throw new Error(result.error)
  const { date, kind, startTime, endTime } = result.value

  const supabase = await createClient()
  await assertDoctorInClinic(supabase, clinic.id, doctorId)

  const { error } = await supabase.from('availability_exceptions').insert({
    clinic_id: clinic.id,
    doctor_id: doctorId,
    date,
    kind,
    start_time: startTime,
    end_time: endTime,
  })
  if (error) throw new Error(`add exception failed: ${error.message}`)

  revalidate(doctorId)
}

export async function deleteException(formData: FormData): Promise<void> {
  const { clinic } = await requireStaff()
  const id = String(formData.get('id') ?? '')
  const doctorId = String(formData.get('doctorId') ?? '')
  if (!id || !doctorId) throw new Error('missing exception')

  const supabase = await createClient()
  const { error } = await supabase
    .from('availability_exceptions')
    .delete()
    .eq('id', id)
    .eq('clinic_id', clinic.id)
  if (error) throw new Error(`delete exception failed: ${error.message}`)

  revalidate(doctorId)
}
