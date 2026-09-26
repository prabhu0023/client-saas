import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Defense-in-depth tenancy checks for the WhatsApp/booking path.
 *
 * The service-role client bypasses RLS, so any id that arrives from an
 * inbound event (or could be forged) must be confirmed to belong to the
 * clinic resolved from the phone_number_id before it is acted on.
 */

/** True if the doctor belongs to the given clinic. */
export async function doctorBelongsToClinic(
  doctorId: string,
  clinicId: string,
): Promise<boolean> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('doctor_profiles')
    .select('id')
    .eq('id', doctorId)
    .eq('clinic_id', clinicId)
    .maybeSingle()

  if (error) {
    console.error('[tenancy] doctorBelongsToClinic failed:', error.message)
    return false
  }
  return Boolean(data)
}
