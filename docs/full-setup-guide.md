# Deploy & Setup Guide — Meta + wacrm + DoctorDesk

> **The single deploy/setup reference** (merged from the former `deployment.md`).
> End-to-end setup for the WhatsApp appointment booking system. Follow the phases
> **in order** — each depends on values produced by the previous one. Free stack:
> Vercel (both apps) + Supabase Cloud (two DBs).
>
> Final flow:
> Patient texts "appointment" → Meta → wacrm (forwards webhook) → DoctorDesk
> (runs doctor→day→time flow, books) → reply to patient → appointment in dashboard.
>
> **Contents:** Phases 1–10 (setup) · Appendix A (webhook wiring model) · B (env
> var sourcing) · C (from-zero DB bring-up) · D (wacrm API contract) · E (hosting
> notes & alternatives). Product context: `product-requirements.md` §9.

---

## 0. The big picture (read this first)

Three layers, each with one job:

| Layer | Role | Deploy target |
|---|---|---|
| **Meta WhatsApp Cloud API** | Owns the phone number; delivers inbound + sends outbound | (Meta's servers) |
| **wacrm** | Messaging channel: receives Meta webhooks, sends messages, forwards inbound to clinic-saas | Vercel + Supabase A |
| **clinic-saas** | The product: booking conversation logic + staff dashboard | Vercel + Supabase B |

**Critical concept:** the booking conversation (the "automation") is coded in
**clinic-saas**, not built as a wacrm automation. wacrm only *forwards* messages.
Do NOT create a wacrm keyword-automation for booking — it would double-reply.

---

## 1. What you need (accounts + tools)

- [ ] GitHub account (both repos pushed; clinic-saas **private**)
- [ ] Vercel account (sign in with GitHub)
- [ ] Supabase account (you'll make **two** projects)
- [ ] Meta for Developers account
- [ ] A WhatsApp number (test number to start; verified production number later)
- [ ] Local tools: Node ≥ 20, `npm`, `git`, and `supabase` CLI (optional but handy)

---

## 2. Environment variables — the full map

### wacrm (set in Vercel → wacrm project → Settings → Environment Variables)

| Key | What it is | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project A URL | Supabase A → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key | Supabase A → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key (secret) | Supabase A → Settings → API |
| `ENCRYPTION_KEY` | 64-hex, encrypts stored WhatsApp tokens | generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `META_APP_SECRET` | verifies Meta webhook signatures | Meta → App → Settings → Basic → App Secret |

### clinic-saas (set in Vercel → clinic-saas project → Settings → Environment Variables)

| Key | What it is | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project B URL | Supabase B → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key | Supabase B → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key (secret) | Supabase B → Settings → API |
| `WACRM_BASE_URL` | deployed wacrm URL | from Phase 6 (e.g. `https://wacrm-xxx.vercel.app`) |
| `WACRM_API_KEY` | wacrm public-API key | wacrm dashboard → Settings → API keys (Phase 7) |
| `WACRM_WEBHOOK_SECRET` | verifies wacrm→clinic-saas webhooks | printed by `wacrm-setup.ts register` (Phase 9) |
| `CRON_SECRET` | protects the reminder cron | generate: `openssl rand -hex 32` |

### Local `.env.local` files (for running seed / setup scripts — NEVER commit)

- **clinic-saas/.env.local** needs the Supabase B keys + `WACRM_BASE_URL` +
  `WACRM_API_KEY` + `DEMO_WACRM_ACCOUNT_ID` (from Phase 7).

> **Secret rules:** `NEXT_PUBLIC_*` values are exposed to the browser (fine for
> Supabase URL + anon key — they're public). Everything else (`SERVICE_ROLE_KEY`,
> `ENCRYPTION_KEY`, `META_APP_SECRET`, `WACRM_API_KEY`, `WACRM_WEBHOOK_SECRET`,
> `CRON_SECRET`) is a secret — never `NEXT_PUBLIC_`, never committed. Generate
> FRESH values for production; don't reuse local/dev secrets.
> **After changing any Vercel env var, REDEPLOY** — changes don't apply to a
> running deployment.

---

## 3. The order (why it matters)

You can't set everything at once — later values depend on earlier ones:

```
Supabase A/B created ─┐
Meta app + number ────┤→ wacrm env (Supabase A + Meta App Secret) → deploy wacrm → wacrm URL
                      │→ Meta webhook points at wacrm URL
wacrm deployed ───────┤→ create wacrm API key → get account_id
                      │→ deploy clinic-saas (needs wacrm URL + key)
clinic-saas deployed ─┤→ seed clinic (needs account_id)
                      │→ register forwarder → get WACRM_WEBHOOK_SECRET → set in clinic-saas → redeploy
all wired ────────────┘→ test
```

---

## PHASE 1 — Databases (Supabase Cloud, two projects)

1. Create **Supabase project A** (wacrm). Note URL + anon + service-role keys.
2. Apply wacrm's migrations (`wacrm/supabase/migrations/*`) — SQL editor or
   `supabase db push`. This includes the public-API + `webhook_endpoints`
   migration, which the integration depends on.
3. Create **Supabase project B** (clinic-saas). Note its URL + keys.
4. Apply clinic-saas migrations **001–007 in order** (SQL editor or `db push`).

---

## PHASE 2 — Meta app + WhatsApp number

1. Meta for Developers → **Create App** → type "Business".
2. Add the **WhatsApp** product to the app.
3. **WhatsApp → API Setup:** you get a **test number** with a `phone_number_id`
   and a temporary access token. Note the `phone_number_id` and WABA id.
4. **App Settings → Basic → App Secret** → this is `META_APP_SECRET`.
5. **Access token — get the RIGHT kind (this is what breaks later):**
   - The default token in API Setup is **temporary** (~24h) — fine for a first
     test, but it WILL expire and cause `(#131005) Access denied` later.
   - For anything lasting: create a **System User** (Business Settings → Users →
     System Users), assign the WhatsApp app, and generate a **permanent token**
     with `whatsapp_business_messaging` + `whatsapp_business_management`.
   - This permanent token is what you put in wacrm's WhatsApp settings.
6. **Recipient allow-list (test numbers only):** WhatsApp → API Setup → add the
   phone number(s) you'll test from under "To". Test numbers can ONLY message
   allow-listed recipients — skipping this causes `#131005`.

> Order note: you need `phone_number_id`, WABA id, the **permanent** access
> token, and `META_APP_SECRET` before wacrm can send. Get the permanent token
> now to avoid the "worked then expired" failure.

---

## PHASE 3 — Deploy wacrm

1. Vercel → New Project → import your wacrm repo (your fork, not the upstream).
2. Framework auto-detects Next.js. Leave build settings at defaults.
3. Set the **wacrm env vars** (table in §2): Supabase A keys, `ENCRYPTION_KEY`
   (fresh), `META_APP_SECRET`.
4. Deploy → note the URL, e.g. `https://wacrm-xxx.vercel.app`.

> `ENCRYPTION_KEY` must be set BEFORE you save any WhatsApp config in wacrm
> (it encrypts the stored token). Set it once and never change it, or stored
> tokens become unreadable.

---

## PHASE 4 — Connect the number in wacrm + Meta webhook

1. In the deployed wacrm dashboard → **Settings → WhatsApp**: enter
   `phone_number_id`, WABA id, and the **permanent access token** from Phase 2.
   Save, then run **Verify registration** — confirm it reports "live".
2. In Meta → WhatsApp → **Configuration → Webhook**: set the callback URL to
   `https://wacrm-xxx.vercel.app/api/whatsapp/webhook` and the **verify token**
   to the value in wacrm's WhatsApp settings. Click "Verify and save".
3. Subscribe to the `messages` webhook field.

> If webhook verification 401s: `META_APP_SECRET` is missing/wrong in Vercel, or
> you didn't redeploy after setting it. (This was fixed earlier in this project.)

---

## PHASE 5 — Deploy clinic-saas

1. Vercel → New Project → import the clinic-saas repo (private).
2. Set the **clinic-saas env vars** (§2): Supabase B keys, `WACRM_BASE_URL`
   (the wacrm URL from Phase 3), `WACRM_API_KEY` (Phase 7 — can add now if you
   have it, or after), `CRON_SECRET`. Leave `WACRM_WEBHOOK_SECRET` for Phase 9.
3. Deploy → note the URL, e.g. `https://client-saas-xxx.vercel.app`.
   Inbound endpoint: `https://client-saas-xxx.vercel.app/api/whatsapp/inbound`.

---

## PHASE 6 — Create the wacrm API key

1. wacrm dashboard → **Settings → API keys → New API key**.
2. Grant scopes: `messages:send`, `contacts:read`, `webhooks:manage`.
3. Copy the key (shown **once**) → this is `WACRM_API_KEY`. Put it in
   clinic-saas's Vercel env AND in `clinic-saas/.env.local` (for the scripts).

---

## PHASE 7 — Get the account_id

From the clinic-saas folder (with `WACRM_BASE_URL` + `WACRM_API_KEY` in
`.env.local`):

```bash
npx tsx scripts/wacrm-setup.ts verify
```

Output gives:
- `account_id: <uuid>` → this is `DEMO_WACRM_ACCOUNT_ID`. **Copy it.**
- confirms the key's scopes.
- `webhooks: N` → how many forwarders are registered (0 = not yet).

---

## PHASE 8 — Seed the clinic DB

```bash
# clinic-saas/.env.local must have:
#   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY = Supabase B
#   DEMO_WACRM_ACCOUNT_ID=<account_id from Phase 7>
npm run seed
```

Creates: Demo Clinic, WhatsApp number, **clinic_wacrm_accounts mapping** (so
inbound routes to the clinic), 2 doctors with Mon–Fri availability, services,
and demo appointments. Prints staff logins for the dashboard.

> The seeded `wacrm_account_id` MUST equal the account_id wacrm stamps on
> webhooks (Phase 7). Mismatch → clinic-saas silently drops messages as
> "no_clinic".

---

## PHASE 9 — Register the forwarder (wacrm → clinic-saas)

```bash
npx tsx scripts/wacrm-setup.ts register https://client-saas-xxx.vercel.app/api/whatsapp/inbound
```

- Registers a `message.received` webhook in wacrm.
- Prints `WACRM_WEBHOOK_SECRET=whsec_...` **exactly once**.

Then:
1. Set `WACRM_WEBHOOK_SECRET` in clinic-saas's Vercel env.
2. **Redeploy clinic-saas.** (Skip this → clinic-saas 401s every forwarded webhook.)

---

## PHASE 10 — Test end to end

1. From an **allow-listed** phone, text the WhatsApp number: **"appointment"**.
2. Expect: doctor menu → reply a number → day menu → number → time menu → number
   → confirmation. Appointment appears at `.../dashboard`.
3. Double-book test: same slot from a 2nd phone → "just taken".

---

## Troubleshooting (things we actually hit)

| Symptom | Cause | Fix |
|---|---|---|
| Meta webhook → wacrm returns **401 invalid signature** | `META_APP_SECRET` missing/wrong in Vercel, or not redeployed | Set it, redeploy wacrm |
| `wacrm-setup.ts` → **404 on /api/v1/me** | `WACRM_BASE_URL` points at wrong/old URL (e.g. stale ngrok) | Set it to the deployed wacrm URL |
| `verify` shows **webhooks: 0** | forwarder not registered | run Phase 9 `register` |
| Patient message → **nothing happens** | account_id mismatch (no_clinic) OR `WACRM_WEBHOOK_SECRET` not set/redeployed | check `clinic_wacrm_accounts` row; set secret + redeploy |
| **`(#131005) Access denied`** on outbound send | (a) 24h window closed, (b) token expired, (c) recipient not allow-listed | (a) have patient text again, (b) use permanent token, (c) add phone to Meta allow-list |
| "Worked, then stopped" | usually the **temporary token expired** or the **24h window closed** | permanent token; fresh inbound message before testing |

### The `#131005` decision tree

```
#131005 Access denied
├─ Using a TEST number? → is the recipient phone on Meta's allow-list?  → add it
├─ Was it working then stopped after hours/days? → 24h window closed     → patient texts again
├─ Was it working then stopped after ~24h–60d?  → temporary token expired → create permanent token
└─ Never worked? → token lacks whatsapp_business_messaging / wrong WABA   → fix token in wacrm
```

---

## Env var quick-reference (copy targets)

**Vercel → wacrm:**
```
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
ENCRYPTION_KEY, META_APP_SECRET
```
**Vercel → clinic-saas:**
```
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
WACRM_BASE_URL, WACRM_API_KEY, WACRM_WEBHOOK_SECRET, CRON_SECRET
```
**clinic-saas/.env.local (local scripts only):**
```
NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
WACRM_BASE_URL, WACRM_API_KEY, DEMO_WACRM_ACCOUNT_ID
```

---

## APPENDIX A — Advanced: the webhook wiring across all three systems

> Everything above is the *procedure*. This appendix is the *model* — the deep
> reference for how the hook connecting the three systems actually works, what
> secures each hop, and what to verify whenever you start a deployment. Read this
> when a message doesn't flow and the phase steps didn't make the cause obvious.

### A.1 The three systems and the two hops

```
┌─────────────────────┐   hop 1: inbound    ┌──────────────┐   hop 2: forward    ┌──────────────────────┐
│  Meta WhatsApp       │  ───────────────▶   │    wacrm     │  ───────────────▶   │  DoctorDesk         │
│  Cloud API           │   POST webhook      │  (channel)   │   POST forwarder    │  (clinic-saas)       │
│  (owns the number)   │  ◀───────────────   │              │  ◀───────────────   │  (booking + portal)  │
└─────────────────────┘   send message API   └──────────────┘   send message API  └──────────────────────┘
      Meta's servers        (hop 1 reverse)     Vercel + DB A     (hop 2 reverse)      Vercel + DB B
```

There are **two independent webhook hops**, each with its **own signature and
own secret**. A 401 on one hop has nothing to do with the other — always name
which hop before debugging.

| | Hop 1: Meta → wacrm | Hop 2: wacrm → DoctorDesk |
|---|---|---|
| Direction (inbound) | Meta POSTs the patient's message to wacrm | wacrm forwards `message.received` to DoctorDesk |
| Endpoint | `…/api/whatsapp/webhook` (on wacrm) | `…/api/whatsapp/inbound` (on DoctorDesk) |
| Signature header | `X-Hub-Signature-256` (Meta) | `X-Wacrm-Signature` (wacrm, Stripe-style `t=…,v1=…`) |
| Secret that signs | `META_APP_SECRET` | `WACRM_WEBHOOK_SECRET` |
| Where the secret lives | Vercel → **wacrm** env | Vercel → **DoctorDesk** env |
| Secret is created | Meta App → Settings → Basic | printed **once** by `wacrm-setup.ts register` |
| Verify token (setup handshake) | wacrm's WhatsApp "verify token" | n/a (no GET handshake on hop 2) |
| Reverse path (outbound) | wacrm → Meta send API (permanent token) | DoctorDesk → wacrm send API (`WACRM_API_KEY`) |

### A.2 What secures each hop (and the failure it causes)

- **Hop 1 signature** — Meta signs the raw body with `META_APP_SECRET`
  (`X-Hub-Signature-256`). Wrong/missing in wacrm's Vercel env → **Meta webhook
  verification 401**, patient messages never reach wacrm.
- **Hop 2 signature** — wacrm signs `${t}.${rawBody}` with HMAC-SHA256 using the
  secret from `register`, sent as `X-Wacrm-Signature: t=<unix>,v1=<hex>`.
  DoctorDesk recomputes it over the **raw** bytes and compares in constant time,
  rejecting if `|now − t| > 300s` (replay guard). Mismatch → **`/api/whatsapp/inbound`
  401**. The route logs a *named* reason: `hmac_mismatch` (wrong/absent secret),
  `timestamp_skew` (clock/replay), or `missing_header` / `malformed_header`
  (not a genuine wacrm delivery, or a proxy stripped the header).
- **Outbound auth (both reverse paths)** — wacrm→Meta uses the **permanent
  access token**; DoctorDesk→wacrm uses `WACRM_API_KEY` as a Bearer token.

### A.3 The identity chain (how a message finds the right clinic)

The wiring is not just transport — identity has to survive both hops so the
right clinic's booking logic runs:

```
Meta phone_number_id ──(wacrm maps)──▶ wacrm account_id ──(clinic_wacrm_accounts)──▶ DoctorDesk clinic_id
                                                                                          │
                                          patient wa_phone ──(patients: clinic_id+wa_phone)──▶ patient record
```

- **`phone_number_id`** — Meta's id for the clinic's number; the tenant key at
  hop 1. Configured in wacrm's WhatsApp settings (Phase 4).
- **`account_id`** — wacrm stamps this on every forwarded webhook. DoctorDesk
  resolves it to a clinic via the `clinic_wacrm_accounts` table
  (`resolveClinicIdByWacrmAccount`). **The seeded `wacrm_account_id` MUST equal
  the `account_id` from `wacrm-setup.ts verify` (Phase 7/8)** — mismatch → every
  message is silently dropped as `no_clinic` (200, no reply).
- **`wa_phone`** — the patient's E.164 number, resolved from the wacrm
  `contact_id` (cached on `wa_sessions` after the first message). The pair
  `(clinic_id, wa_phone)` is the patient key **and** the tenancy guard on the
  service-role WhatsApp path (there is no RLS there — the code-level scoping is
  the only guard).

### A.4 Connect-time checklist (run this whenever you start a deployment)

Do these **in order** — each depends on values the previous produced. Values
that must match across systems are called out explicitly.

1. **Both Supabase DBs exist and migrated.** wacrm → project A; DoctorDesk
   `001–007` → project B.
2. **Meta ready:** permanent token (not the ~24h temp one), `phone_number_id`,
   WABA id, `META_APP_SECRET`; test recipients allow-listed.
3. **wacrm deployed** with `ENCRYPTION_KEY` (set *before* saving any WhatsApp
   token) + `META_APP_SECRET`. Note the wacrm URL.
4. **Hop 1 connected:** Meta webhook callback = `<wacrm-url>/api/whatsapp/webhook`,
   verify token matches wacrm's setting, `messages` field subscribed. wacrm
   "Verify registration" reports **live**.
5. **DoctorDesk deployed** with Supabase B keys, `WACRM_BASE_URL` = the wacrm
   URL, `CRON_SECRET`. Note the DoctorDesk URL and its
   `/api/whatsapp/inbound` endpoint.
6. **API key + account_id:** create `WACRM_API_KEY` (scopes `messages:send`,
   `contacts:read`, `webhooks:manage`); run `wacrm-setup.ts verify` → copy
   `account_id`.
7. **Seed with the matching account_id:** `DEMO_WACRM_ACCOUNT_ID` = the
   `account_id` from step 6, then `npm run seed`. ⚠ **This is the #1 silent
   failure** — if it doesn't match, messages drop as `no_clinic`.
8. **Hop 2 connected:** `wacrm-setup.ts register <doctordesk-url>/api/whatsapp/inbound`
   → copy the printed `WACRM_WEBHOOK_SECRET` → set it in DoctorDesk's Vercel env
   → **REDEPLOY** (env changes need a fresh deploy).
9. **URL sanity:** the URL you registered in step 8 must be the **exact current
   production URL** (scheme + host + `/api/whatsapp/inbound`, no trailing slash).
   A stale/renamed deployment URL means wacrm delivers to the wrong place or
   signs with a secret tied to an old registration → `hmac_mismatch`.
10. **End-to-end:** allow-listed phone texts "appointment" → menus → confirmation
    → appointment in the dashboard. Second phone, same slot → "just taken".

### A.5 Fast diagnosis: which hop, which secret

```
Patient texts, nothing happens
│
├─ Meta "Configuration" shows webhook errors, or wacrm never logs the inbound
│     → HOP 1. Check META_APP_SECRET in wacrm's Vercel env; redeploy wacrm.
│
├─ wacrm received it, but DoctorDesk /api/whatsapp/inbound logs 401
│     → HOP 2 signature. Read the NAMED reason in the log:
│        • hmac_mismatch   → WACRM_WEBHOOK_SECRET in DoctorDesk ≠ the secret
│                            wacrm signs with. Re-register for THIS url (step 8),
│                            set the printed secret, REDEPLOY.
│        • timestamp_skew  → clock/replay; check the skewSeconds in the log.
│        • missing/malformed_header → not a real wacrm delivery, or wrong URL /
│                            a proxy stripped the header.
│
├─ DoctorDesk returns 200 but no reply, log says "no_clinic"
│     → IDENTITY. clinic_wacrm_accounts.account_id ≠ wacrm's account_id.
│        Re-seed / fix the mapping row (step 7).
│
├─ DoctorDesk returns 200, "no_phone"
│     → contact phone couldn't be resolved from wacrm (contacts:read scope /
│        WACRM_API_KEY / WACRM_BASE_URL).
│
└─ Reply attempted but patient gets nothing / #131005 on the Meta side
      → OUTBOUND. 24h window closed (patient texts again), token expired
        (permanent token), or recipient not allow-listed. See the #131005 tree.
```

### A.6 Secret & URL matrix (what must equal what)

| Value | Set in | Must match | Symptom if wrong |
|---|---|---|---|
| `META_APP_SECRET` | Vercel → wacrm | Meta App → Basic | Hop 1 401 |
| Webhook verify token | Meta Configuration | wacrm WhatsApp settings | Hop 1 handshake fails |
| `WACRM_WEBHOOK_SECRET` | Vercel → DoctorDesk | secret from `register` for the **current** URL | Hop 2 `hmac_mismatch` 401 |
| Registered forwarder URL | wacrm (via `register`) | DoctorDesk's exact prod `/api/whatsapp/inbound` | 401 / delivered elsewhere |
| `WACRM_BASE_URL` | Vercel → DoctorDesk + `.env.local` | deployed wacrm URL | `404 on /api/v1/me`, outbound + phone-resolve fail |
| `WACRM_API_KEY` | Vercel → DoctorDesk + `.env.local` | key from wacrm dashboard | outbound + `verify` fail |
| `DEMO_WACRM_ACCOUNT_ID` / seeded `wacrm_account_id` | `.env.local` → seed → DB B | `account_id` from `wacrm-setup.ts verify` | `no_clinic`, silent drop |

> **Golden rule:** after changing ANY Vercel env var, **redeploy** — a running
> deployment keeps the old value. Most "I set the secret and it still 401s" cases
> are a missing redeploy.

---

## APPENDIX B — How to generate or get each environment variable value

> §2 lists *what* each variable is and *where* it lives. This appendix is the
> single "how do I actually produce this value" reference: an exact command for
> anything you generate locally, and the precise click-path for anything you
> copy from a console. Grouped by source system so you can gather values in one
> pass. Never commit real values; generate FRESH secrets for production.

### B.1 Generate-it-yourself (run locally, copy the output)

These are secrets you create — no console needed. Run the command, paste the
output into the target env var, and (for `*_KEY`/`*_SECRET`) store it once.

| Variable | Command | Notes |
|---|---|---|
| `ENCRYPTION_KEY` (wacrm) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | 64 hex chars. Set **before** saving any WhatsApp token in wacrm; **never change it** or stored tokens become unreadable. |
| `CRON_SECRET` (DoctorDesk) | `openssl rand -hex 32` | Any long random string. The scheduler sends it as the `x-cron-secret` header. |
| `WACRM_WEBHOOK_SECRET` (DoctorDesk) | `npx tsx scripts/wacrm-setup.ts register <doctordesk-url>/api/whatsapp/inbound` | **Not** hand-generated — wacrm mints it and prints `whsec_…` **once** at registration (Phase 9). Copy immediately; re-register to rotate. |

> Portable alternative for the two random secrets if Node/openssl differ:
> `python3 -c "import secrets; print(secrets.token_hex(32))"`.

### B.2 Get-from-Supabase (two projects — don't mix them up)

Path for both projects: **Supabase → your project → Settings → API.** Project A
backs wacrm; Project B backs DoctorDesk. The same three keys exist in each — copy
each project's values into that project's app only.

| Variable | Supabase A → for wacrm | Supabase B → for DoctorDesk | Field on the API page |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | ✓ | **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | ✓ | **Project API keys → `anon` `public`** |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | **Project API keys → `service_role` `secret`** |

- `URL` + `anon` are public (safe as `NEXT_PUBLIC_`). `service_role` **bypasses
  RLS** — secret, server-only, never `NEXT_PUBLIC_`, never in the browser bundle.
- ⚠ Cross-wiring the two projects' keys is a common mistake and fails in
  confusing ways (DoctorDesk reading wacrm's DB, etc.). Copy A→wacrm and
  B→DoctorDesk in separate passes.

### B.3 Get-from-Meta (App dashboard)

| Variable / value | Where | Notes |
|---|---|---|
| `META_APP_SECRET` (wacrm) | Meta → your App → **Settings → Basic → App Secret** (click "Show") | Signs the Meta→wacrm webhook (`X-Hub-Signature-256`). |
| `phone_number_id` *(not an env var — goes in wacrm's WhatsApp settings)* | Meta → **WhatsApp → API Setup** | The number's tenant key at hop 1. |
| WABA id *(wacrm WhatsApp settings)* | Meta → **WhatsApp → API Setup** | The WhatsApp Business Account id. |
| Permanent access token *(wacrm WhatsApp settings)* | Meta → **Business Settings → Users → System Users** → add the WhatsApp app → **Generate token** with `whatsapp_business_messaging` + `whatsapp_business_management` | Use the **permanent** token, not the ~24h temp one from API Setup, or sends break later with `#131005`. |
| Webhook verify token *(you choose it)* | pick any string; enter the **same** value in wacrm's WhatsApp settings and Meta → Configuration → Webhook | Only used for the one-time hop-1 handshake. |

### B.4 Get-from-wacrm (dashboard + setup script)

Available only after wacrm is deployed (Phase 3) and its WhatsApp number is
connected.

| Variable / value | How to get it | Notes |
|---|---|---|
| `WACRM_BASE_URL` (DoctorDesk) | The deployed wacrm URL from Vercel, e.g. `https://wacrm-xxx.vercel.app` | Origin only, no trailing slash, no path. |
| `WACRM_API_KEY` (DoctorDesk) | wacrm dashboard → **Settings → API keys → New API key**; scopes `messages:send`, `contacts:read`, `webhooks:manage` | Shown **once** — copy immediately. Put in Vercel **and** `.env.local`. |
| `DEMO_WACRM_ACCOUNT_ID` (`.env.local`, seed) | `npx tsx scripts/wacrm-setup.ts verify` → copy the printed `account_id` | Needs `WACRM_BASE_URL` + `WACRM_API_KEY` in `.env.local` first. Must equal the seeded `wacrm_account_id` or messages drop as `no_clinic`. |

### B.5 One-pass gather order (fewest context switches)

Values depend on earlier ones, so gather in this order:

1. **Generate locally now** (B.1): `ENCRYPTION_KEY`, `CRON_SECRET`. (Hold
   `WACRM_WEBHOOK_SECRET` — it comes last, in Phase 9.)
2. **Supabase** (B.2): both projects' URL + anon + service_role.
3. **Meta** (B.3): `META_APP_SECRET`, `phone_number_id`, WABA id, permanent
   token, verify token.
4. **Deploy wacrm** → `WACRM_BASE_URL` (B.4).
5. **wacrm** (B.4): `WACRM_API_KEY`, then `account_id` → `DEMO_WACRM_ACCOUNT_ID`.
6. **Register the forwarder** (Phase 9) → `WACRM_WEBHOOK_SECRET` (B.1) → set in
   Vercel → **redeploy**.

> After setting or changing ANY value in Vercel, **redeploy** the affected
> project — a running deployment keeps the old value.

---

## APPENDIX C — From-scratch DB bring-up (clinic-saas, from zero)

> Merged from the former `deployment.md`. Verifies the full schema + seed apply
> cleanly to an empty database. Use for a new environment or to reproduce a clean
> state. Two paths — pick one.

**Migration order & dependencies** (all in `supabase/migrations/`, idempotent):

| # | File | Adds | Depends on |
|---|------|------|-----------|
| 001 | `001_initial_schema.sql` | Core tables + `set_updated_at()` trigger fn | — |
| 002 | `002_btree_gist_exclusion.sql` | `btree_gist` + no-overlap exclusion constraint | 001 (`appointments`) |
| 003 | `003_rls_policies.sql` | `is_clinic_member()` + RLS policies | 001 |
| 004 | `004_book_appointment_fn.sql` | `book_appointment` RPC | 001, 002 |
| 005 | `005_processed_wa_events.sql` | Inbound dedupe ledger | — |
| 006 | `006_wacrm_sessions.sql` | `clinic_wacrm_accounts` + `wa_sessions` | 001 |
| 007 | `007_appointment_reminders.sql` | `appointments.reminder_sent_at` + due-scan index | 001 |
| 008 | `008_wa_session_cancel_step.sql` | widen `wa_sessions.step` CHECK (`awaiting_cancel`) | 006 |
| 009 | `009_wa_session_reschedule_step.sql` | widen CHECK (`awaiting_reschedule`) | 006 |
| 010 | `010_clinic_doctor_names_fn.sql` | `clinic_doctor_names` RPC (SECURITY DEFINER) | 001, 003 |

### Option A — Local stack (throwaway, non-destructive)

Requires Docker running and the Supabase CLI.

```bash
# 1. Start Docker Desktop first (the local stack runs in containers).
supabase init                 # once, if supabase/config.toml doesn't exist yet
supabase start                # boots local Postgres + applies all migrations from zero
#   prints local API URL + anon + service_role keys.

# 2. Point .env.local at the local stack (use the printed values):
#   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=<printed anon key>
#   SUPABASE_SERVICE_ROLE_KEY=<printed service_role key>

# 3. Seed the demo clinic (idempotent) and confirm it lands.
npm run seed                  # prints staff logins; books demo appointments for today

# 4. Sanity-check the app builds against the fresh schema.
npm run build
```

Tear down with `supabase stop` (`--no-backup` to discard local data).

### Option B — Remote Supabase project

```bash
supabase link --project-ref <your-project-ref>   # once
supabase db push                                  # applies 001..010 in order
npm run seed                                      # against the remote (uses .env.local keys)
```

> ⚠️ `supabase db reset --linked` **wipes** the remote DB before re-applying.
> Only run it against a throwaway/dev project — never one holding real data.

### Expected result (both paths)

- All 10 migrations apply with no errors (idempotent — safe to re-run).
- `npm run seed` creates: Demo Clinic (Asia/Kolkata), a WhatsApp number, a
  `clinic_wacrm_accounts` mapping, 2 services, 2 doctors with Mon–Fri
  availability, and demo appointments for today. Prints staff logins.
- Log in with a printed credential → today's appointments show on the dashboard
  (empty on a weekend — seed availability is Mon–Fri; pick a weekday).

---

## APPENDIX D — wacrm public API contract (verified against wacrm/docs/public-api.md)

> Merged from the former `deployment.md`. The confirmed request/response shapes
> the integration depends on.

All calls: `Authorization: Bearer <WACRM_API_KEY>`, JSON, base `WACRM_BASE_URL`.
Envelope: success `{ "data": ... }`, error `{ "error": { "code", "message" } }`.

- **`GET /api/v1/me`** (no scope) → `data.account.id` = the **routing key**
  (`DEMO_WACRM_ACCOUNT_ID` / `clinic_wacrm_accounts.wacrm_account_id`);
  `data.key.scopes` lists the key's scopes.
- **`POST /api/v1/messages`** (`messages:send`) — types `text` | `template` |
  media only; **no interactive/list type**.
  - text: `{ to, type:'text', text }`
  - template: `{ to, type:'template', template:{ name, language, params:[...] } }`
    — positional body vars are **`params`**.
- **`GET /api/v1/contacts/{id}`** (`contacts:read`) → contact incl. `phone`
  (E.164) — resolves the patient number from a webhook `contact_id`.
- **Webhook `message.received`**:
  `{ id, event, occurred_at, account_id, data:{ conversation_id, contact_id, whatsapp_message_id, content_type, text } }`.
- **Signature** `X-Wacrm-Signature: t=<unix>,v1=<hex>`,
  `v1 = HMAC_SHA256(secret, "${t}.${rawBody}")` over the raw body, constant-time,
  reject stale `t` (>300s).

Scopes: `messages:send` + `contacts:read` (booking), `webhooks:manage` (register
the forwarder). Rate limit 120 req/min per key. Webhook targets must be public
`https://` (SSRF guard blocks localhost/private ranges).

> **Note on `sendTemplate`:** confirm the template send succeeds against wacrm's
> real API before relying on it in production (template body vars are `params`;
> an `OutboundList` degrades to a text send since wacrm has no interactive type).

---

## APPENDIX E — Hosting notes & alternatives

> Merged from the former `deployment.md`.

**Free stack used here:** Vercel (both apps) + Supabase Cloud (two DBs). Vercel
Hobby is non-commercial (fine for a demo); Supabase free projects pause after
~1 week idle (just unpause). Plan a paid move for a real launch.

- **Render free tier** — free instances sleep and cold-start; a sleeping webhook
  receiver can drop inbound WhatsApp events. Vercel serverless avoids this →
  preferred for both apps.
- **Railway / Fly.io** — trial credits rather than a durable free tier; usable
  but may need a card.
- **Self-host on a VPS (Docker)** — most control, not free, more ops. Revisit for
  the real (paid) launch.
