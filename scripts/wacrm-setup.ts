/**
 * wacrm setup + verify.
 *
 * Confirms your wacrm API key works and has the scopes this integration
 * needs, then (optionally) registers the inbound webhook so wacrm
 * forwards `message.received` events to clinic-saas.
 *
 * Reads WACRM_BASE_URL and WACRM_API_KEY from .env.local.
 *
 * Usage:
 *   # 1) verify the key + scopes and list existing webhooks
 *   npx tsx scripts/wacrm-setup.ts verify
 *
 *   # 2) register the inbound webhook (prints the signing secret ONCE)
 *   npx tsx scripts/wacrm-setup.ts register https://your-clinic-saas.example.com/api/whatsapp/inbound
 *
 * The printed secret goes in .env.local as WACRM_WEBHOOK_SECRET.
 *
 * Notes:
 * - The key needs scopes: messages:send, contacts:read (for the flow),
 *   plus webhooks:manage (only to run `register` here).
 * - wacrm refuses non-https and private/localhost webhook URLs (SSRF
 *   guard), so `register` needs a public https URL.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnv() {
  try {
    const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // rely on real env
  }
}
loadEnv()

const BASE = (process.env.WACRM_BASE_URL ?? '').replace(/\/$/, '')
const KEY = process.env.WACRM_API_KEY ?? ''

const REQUIRED_FLOW_SCOPES = ['messages:send', 'contacts:read']

function assertConfigured() {
  if (!BASE || !KEY) {
    console.error('Missing WACRM_BASE_URL or WACRM_API_KEY in .env.local')
    process.exit(1)
  }
  if (BASE.includes('your-wacrm-instance') || KEY.includes('your-api-key')) {
    console.error(
      'WACRM_BASE_URL / WACRM_API_KEY still hold placeholder values — set real ones first.',
    )
    process.exit(1)
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function verify() {
  console.log(`wacrm: ${BASE}`)

  // 1) Key + scopes via GET /api/v1/me.
  const me = await api('GET', '/api/v1/me')
  if (me.status !== 200) {
    console.error(`GET /api/v1/me failed (${me.status}):`, JSON.stringify(me.json))
    process.exit(1)
  }
  const data = (me.json as {
    data?: { account?: { id?: string; name?: string }; key?: { scopes?: string[] } }
  }).data
  const accountId = data?.account?.id ?? '(unknown)'
  const accountName = data?.account?.name ?? '(unknown account)'
  const scopes = data?.key?.scopes ?? []
  console.log(`  account:    ${accountName}`)
  console.log(`  account_id: ${accountId}   <- use as DEMO_WACRM_ACCOUNT_ID`)
  console.log(`  scopes:     ${scopes.length ? scopes.join(', ') : '(none)'}`)

  const missing = REQUIRED_FLOW_SCOPES.filter((s) => !scopes.includes(s))
  if (missing.length) {
    console.warn(`  ⚠ missing scopes for the booking flow: ${missing.join(', ')}`)
  } else {
    console.log('  ✓ has the scopes the booking flow needs')
  }

  // 2) List existing webhooks (needs webhooks:manage; tolerate 403).
  const hooks = await api('GET', '/api/v1/webhooks')
  if (hooks.status === 200) {
    const list = (hooks.json as { data?: Array<{ url: string; events: string[]; is_active?: boolean }> }).data ?? []
    console.log(`  webhooks: ${list.length}`)
    for (const h of list) {
      console.log(`    - ${h.url} [${h.events.join(', ')}]${h.is_active === false ? ' (inactive)' : ''}`)
    }
  } else {
    console.log(`  webhooks: not listed (GET returned ${hooks.status}; needs webhooks:manage)`)
  }
}

async function register(url: string) {
  if (!/^https:\/\//.test(url)) {
    console.error('Webhook URL must be https:// (wacrm refuses http/localhost).')
    process.exit(1)
  }
  const res = await api('POST', '/api/v1/webhooks', {
    url,
    events: ['message.received'],
  })
  if (res.status !== 201) {
    console.error(`register failed (${res.status}):`, JSON.stringify(res.json))
    process.exit(1)
  }
  const created = (res.json as { data?: { id?: string; secret?: string } }).data
  console.log('Webhook registered.')
  console.log(`  id:     ${created?.id}`)
  console.log(`  secret: ${created?.secret}`)
  console.log('\nAdd this to .env.local (shown only once):')
  console.log(`  WACRM_WEBHOOK_SECRET=${created?.secret ?? '<not returned>'}`)
}

async function main() {
  assertConfigured()
  const cmd = process.argv[2] ?? 'verify'
  if (cmd === 'verify') {
    await verify()
  } else if (cmd === 'register') {
    const url = process.argv[3]
    if (!url) {
      console.error('Usage: npx tsx scripts/wacrm-setup.ts register <https-url>')
      process.exit(1)
    }
    await register(url)
  } else {
    console.error(`Unknown command "${cmd}". Use "verify" or "register".`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
