import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { sendDueReminders } from '@/lib/reminders/send-due'

/**
 * Reminder cron endpoint (roadmap E3-T3).
 *
 * An external scheduler (Vercel Cron, GitHub Actions, etc.) pings this
 * every few minutes with the shared secret. We authenticate the secret
 * in constant time, then scan for due appointment reminders and send the
 * approved WhatsApp template for each (see src/lib/reminders/send-due.ts).
 *
 * The scan is idempotent (each reminder is claimed before sending), so
 * running this on a short interval — or two runs overlapping — never
 * double-sends. Returns a small JSON summary for observability.
 *
 * Auth: send the secret as `Authorization: Bearer <CRON_SECRET>` or
 * `x-cron-secret: <CRON_SECRET>`. Vercel Cron sends the Bearer form.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron/reminders] CRON_SECRET not set')
    return NextResponse.json({ error: 'not configured' }, { status: 500 })
  }

  if (!isAuthorized(request, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await sendDueReminders()
    return NextResponse.json({ status: 'ok', ...result })
  } catch (err) {
    console.error('[cron/reminders] run failed:', err)
    return NextResponse.json({ error: 'run failed' }, { status: 500 })
  }
}

/** Constant-time check of the cron secret from either accepted header. */
function isAuthorized(request: Request, secret: string): boolean {
  const bearer = request.headers.get('authorization')
  const fromBearer = bearer?.startsWith('Bearer ')
    ? bearer.slice('Bearer '.length)
    : null
  const provided = fromBearer ?? request.headers.get('x-cron-secret')
  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
