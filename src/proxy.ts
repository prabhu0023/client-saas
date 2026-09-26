import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Refreshes the Supabase auth session on each request and forwards the
 * (possibly rotated) auth cookies to both the browser and downstream
 * Server Components. This is the piece the server-side Supabase client
 * (src/lib/supabase/server.ts) anticipates — without it, sessions would
 * silently expire mid-use.
 *
 * It does NOT do authorization (that lives in the portal layout / route
 * gates); it only keeps the session token fresh and cookies in sync.
 *
 * Named `proxy` in the file `src/proxy.ts` per the Next.js 16 convention
 * (the old `middleware` file/function name is deprecated).
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // Touch the user to trigger a refresh if the access token is stale.
  // Do NOT run code between createServerClient and getUser().
  await supabase.auth.getUser()

  return response
}

export const config = {
  // Run on everything except Next internals, static assets, and the
  // WhatsApp inbound webhook (which authenticates via its own secret,
  // not a browser session).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/whatsapp).*)',
  ],
}
