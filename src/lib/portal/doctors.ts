import { createClient } from '@/lib/supabase/server'

/**
 * Doctor display names for the portal (E6-T1).
 *
 * Names live in `users`, which RLS scopes to the caller's own row, so a
 * receptionist can't read a colleague's name directly. The
 * `clinic_doctor_names` RPC (migration 010, SECURITY DEFINER, gated by
 * is_clinic_member) returns names for the caller's clinic only.
 *
 * Returns a Map of doctor_profiles.id → full_name for use as a lookup
 * when rendering appointments/availability. Best-effort: on any error we
 * return an empty map so callers fall back to specialty.
 */
export async function getDoctorNameMap(
  clinicId: string,
): Promise<Map<string, string>> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('clinic_doctor_names', {
    target_clinic: clinicId,
  })

  if (error) {
    // Expected until migration 010 is applied (the function won't exist);
    // callers fall back to specialty. Warn rather than error so a
    // not-yet-deployed function doesn't surface as a scary Console Error.
    console.warn(
      '[portal/doctors] clinic_doctor_names unavailable (falling back to specialty):',
      error.message,
    )
    return new Map()
  }

  const map = new Map<string, string>()
  for (const row of (data ?? []) as Array<{
    doctor_id: string
    full_name: string | null
  }>) {
    if (row.full_name) map.set(row.doctor_id, row.full_name)
  }
  return map
}
