import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client. BYPASSES RLS.
 *
 * Use ONLY server-side, and ONLY for the WhatsApp/booking path where
 * the actor is a patient with no login (so RLS can't apply). Because
 * this bypasses RLS, every caller MUST re-check tenancy in application
 * code — e.g. verify the doctor belongs to the clinic resolved from the
 * inbound phone_number_id (see src/lib/clinics/tenancy.ts).
 *
 * Never import this into browser/client code.
 */
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}
