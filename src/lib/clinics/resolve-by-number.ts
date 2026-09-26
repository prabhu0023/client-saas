import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Tenant router: resolve a clinic from the Meta phone_number_id on an
 * inbound WhatsApp webhook. Route on phone_number_id (the stable key),
 * never the display number.
 *
 * Runs on the WhatsApp path (no logged-in user) via the service role,
 * so callers must still enforce tenancy on anything derived from the
 * result (see tenancy.ts).
 */
export async function resolveClinicIdByPhoneNumberId(
  phoneNumberId: string,
): Promise<string | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('clinic_whatsapp_numbers')
    .select('clinic_id')
    .eq('phone_number_id', phoneNumberId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    console.error('[clinics] resolve-by-number failed:', error.message)
    return null
  }
  return (data?.clinic_id as string | undefined) ?? null
}
