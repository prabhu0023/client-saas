import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser Supabase client for the staff portal. Uses the anon key and
 * respects RLS — a logged-in staff user only sees rows for clinics they
 * are an active member of.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
