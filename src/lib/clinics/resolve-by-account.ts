import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Tenant router for the wacrm channel: resolve a clinic from the wacrm
 * `account_id` carried on every inbound webhook envelope. One wacrm
 * account maps to exactly one clinic (see clinic_wacrm_accounts).
 *
 * Runs on the WhatsApp path (no logged-in user) via the service role,
 * so callers must still enforce tenancy on anything derived from the
 * result (see tenancy.ts).
 */
export async function resolveClinicIdByWacrmAccount(
  wacrmAccountId: string,
): Promise<string | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('clinic_wacrm_accounts')
    .select('clinic_id')
    .eq('wacrm_account_id', wacrmAccountId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    console.error('[clinics] resolve-by-account failed:', error.message)
    return null
  }
  return (data?.clinic_id as string | undefined) ?? null
}
