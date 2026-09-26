import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Server Supabase client for the staff portal (SSR / route handlers).
 * Uses the anon key and the request's auth cookies, so RLS applies —
 * this is the RLS-respecting path for authenticated staff.
 *
 * Do NOT use this for the WhatsApp/booking path (patients aren't logged
 * in) — use the admin (service-role) client there instead.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Called from a Server Component — safe to ignore when
            // the proxy (src/proxy.ts) is refreshing the session.
          }
        },
      },
    },
  )
}
