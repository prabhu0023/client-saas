# Deployment Guide — wacrm + clinic-saas (free tier)

> Goal: both apps live on public HTTPS, wired together, so a patient can have a
> booking conversation over WhatsApp. Free stack: **Vercel** (both apps) +
> **Supabase Cloud** (two DBs).
>
> "Free" notes: Vercel Hobby is non-commercial (fine for a demo). Supabase free
> projects pause after ~1 week idle (just unpause). Good enough to demo; plan a
> paid move for a real launch.

---

## Architecture (deployed)

```
Patient → WhatsApp → Meta Cloud API
                        │  (webhook)
                        ▼
        wacrm  (Vercel project #1)  ── Supabase project A
                        │  forwards inbound (signed) to clinic-saas
                        ▼
     clinic-saas (Vercel project #2) ── Supabase project B
                        │  calls wacrm API to send replies
                        ▼
                     wacrm  ──→ Meta ──→ Patient
```

Two apps, two Supabase DBs, wired over HTTPS. wacrm owns the Meta webhook and
message sending; clinic-saas owns booking logic.

---

## Prerequisites (accounts — all free)

- [ ] GitHub account (both repos pushed there — Vercel deploys from Git)
- [ ] Vercel account (sign in with GitHub)
- [ ] Supabase account
- [ ] Meta for Developers account + a WhatsApp test/business number
      (this has lead time — start early)

---

## Phase 0 — Get both repos into GitHub

wacrm already has a remote (`github.com/ArnasDon/wacrm`) — but that's the
upstream. You want **your own** copies you control.

1. **clinic-saas** — it has no remote yet:
   - Create a **private** GitHub repo (it's your product + will hold health data).
   - `git init` (if needed) → first commit → add remote → push.
2. **wacrm** — you're deploying a fork/instance:
   - Either fork `ArnasDon/wacrm` to your account, or push your local copy to a
     new repo you own. Deploy from your copy so you control env + deploys.

---

## Phase 1 — Databases (Supabase Cloud)

Create **two** Supabase projects (keep schemas isolated).

### 1a. wacrm database
1. New Supabase project → note the Project URL + anon key + service-role key.
2. Apply wacrm's migrations (`wacrm/supabase/migrations/*`) via the Supabase SQL
   editor or `supabase db push`.

### 1b. clinic-saas database
1. New Supabase project → note URL + anon + service-role keys.
2. Apply clinic-saas migrations **in order**, `001` → `009` (all in
   `supabase/migrations/`): `001` schema, `002` btree_gist exclusion, `003` RLS,
   `004` `book_appointment` RPC, `005` `processed_wa_events`, `006`
   `clinic_wacrm_accounts` + `wa_sessions`, `007` `reminder_sent_at`. The
   migrations are idempotent and ordered, so `supabase db push` (or the SQL
   editor, in order) applies them cleanly from zero. See "From-scratch bring-up"
   below for the exact commands.
3. Seed the demo clinic: run the seed against this DB (see clinic-saas README),
   including a `clinic_wacrm_accounts` row mapping your wacrm account_id → clinic.

---

## From-scratch bring-up (clinic-saas DB from zero)

Verifies the full schema + seed apply cleanly to an empty database. Use this for
a new environment or to reproduce a clean state. Two paths — pick one.

**Migration order & dependencies** (all in `supabase/migrations/`, idempotent):

| # | File | Adds | Depends on |
|---|------|------|-----------|
| 001 | `001_initial_schema.sql` | Core tables + `set_updated_at()` trigger fn | — |
| 002 | `002_btree_gist_exclusion.sql` | `btree_gist` + no-overlap exclusion constraint | 001 (`appointments`) |
| 003 | `003_rls_policies.sql` | `is_clinic_member()` + RLS policies | 001 |
| 004 | `004_book_appointment_fn.sql` | `book_appointment` RPC | 001, 002 |
| 005 | `005_processed_wa_events.sql` | Inbound dedupe ledger | — |
| 006 | `006_wacrm_sessions.sql` | `clinic_wacrm_accounts` + `wa_sessions` | 001 (`set_updated_at`, `clinics`) |
| 007 | `007_appointment_reminders.sql` | `appointments.reminder_sent_at` + due-scan index | 001 (`appointments`) |
| 008 | `008_wa_session_cancel_step.sql` | widen `wa_sessions.step` CHECK for `awaiting_cancel` | 006 (`wa_sessions`) |
| 009 | `009_wa_session_reschedule_step.sql` | widen `wa_sessions.step` CHECK for `awaiting_reschedule` | 006 (`wa_sessions`) |

### Option A — Local stack (throwaway, non-destructive)

Requires Docker running and the Supabase CLI.

```bash
# 1. Start Docker Desktop first (the local stack runs in containers).
supabase init                 # once, if supabase/config.toml doesn't exist yet
supabase start                # boots local Postgres + applies all migrations from zero
# supabase start prints local API URL + anon + service_role keys.

# 2. Point .env.local at the local stack (use the printed values):
#   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=<printed anon key>
#   SUPABASE_SERVICE_ROLE_KEY=<printed service_role key>

# 3. Seed the demo clinic (idempotent) and confirm it lands.
npm run seed                  # prints staff logins; books demo appointments for today

# 4. Sanity-check the app builds against the fresh schema.
npm run build
```

Tear down with `supabase stop` (add `--no-backup` to discard local data).

### Option B — Remote Supabase project

For a real (or throwaway cloud) project. `supabase db push` applies any
migrations the remote hasn't seen yet.

```bash
supabase link --project-ref <your-project-ref>   # once
supabase db push                                  # applies 001..009 in order
npm run seed                                      # against the remote (uses .env.local keys)
```

> ⚠️ `supabase db reset --linked` **wipes** the remote database before
> re-applying migrations. Only run it against a throwaway/dev project you are
> certain is safe to erase — never a project holding real data.

### Expected result (both paths)

- All 9 migrations apply with no errors (idempotent — safe to re-run).
- `npm run seed` creates: Demo Clinic (Asia/Kolkata), a WhatsApp number, a
  `clinic_wacrm_accounts` mapping, 2 services, 2 doctors with Mon–Fri
  availability, and a few demo appointments for today. It prints staff logins.
- Log in to the portal with a printed credential → today's appointments show on
  the dashboard (empty on a weekend, since seed availability is Mon–Fri; pick a
  weekday in the date picker).

---

## Phase 2 — Deploy wacrm (Vercel project #1)

1. Vercel → New Project → import your wacrm repo.
2. Framework preset: Next.js (auto-detected). Build/output: defaults.
3. Set Environment Variables (from wacrm's `.env.local.example`): Supabase URL +
   anon + service-role (project A), `ENCRYPTION_KEY`, `META_APP_SECRET`, and any
   others wacrm requires. Generate secrets freshly for production; do not reuse
   local/dev keys.
4. Deploy → note the URL, e.g. `https://wacrm-you.vercel.app`.
5. This URL is where Meta sends webhooks and where clinic-saas sends API calls.

---

## Phase 3 — Deploy clinic-saas (Vercel project #2)

1. Vercel → New Project → import clinic-saas repo.
2. Set Environment Variables:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY` (Supabase project B)
   - `WACRM_BASE_URL` = the wacrm URL from Phase 2
   - `WACRM_API_KEY` = a wacrm API key (create in wacrm dashboard;
     scopes: messages:send, contacts:read)
   - `WACRM_WEBHOOK_SECRET` = shared secret wacrm signs webhooks with
   - `CRON_SECRET` = long random string (for the reminder cron later)
3. Deploy → note the URL, e.g. `https://clinic-you.vercel.app`.
4. The inbound webhook endpoint is:
   `https://clinic-you.vercel.app/api/whatsapp/inbound`

---

## Phase 4 — Wire WhatsApp (Meta → wacrm)

1. In Meta for Developers: create/point a WhatsApp app at wacrm's webhook URL
   (`https://wacrm-you.vercel.app/...webhook`) with the verify token you set in
   wacrm's settings.
2. Connect your WhatsApp number in wacrm's settings (phone number id, WABA id,
   access token). Verify the connection is live.

---

## Phase 5 — Wire wacrm → clinic-saas

1. In wacrm, configure an **outbound webhook / automation** that forwards inbound
   `message.received` events to clinic-saas:
   `https://clinic-you.vercel.app/api/whatsapp/inbound`, signed with
   `WACRM_WEBHOOK_SECRET`.
2. Confirm clinic-saas can call back to wacrm's API (the `WACRM_API_KEY` works,
   `contacts:read` + `messages:send` scopes present).

---

## Phase 5b — Wire the reminder cron

The appointment reminder (`/api/cron/reminders`) is pull-based: an external
scheduler pings it on an interval, it scans for appointments starting within the
reminder window and sends the approved WhatsApp template for each.

1. **Env vars** (clinic-saas, Supabase project B):
   - `CRON_SECRET` — long random string; the scheduler must send it as
     `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret`). Requests without
     it get 401.
   - `REMINDER_TEMPLATE_NAME` — the approved Meta template name (defaults to
     `appointment_reminder`). Its body must accept 3 params in order:
     `{{1}}` clinic name, `{{2}}` day label, `{{3}}` time label.
   - `REMINDER_LEAD_MINUTES` — how far ahead to remind (defaults to `1440` = 24h).
   - `CANCELLATION_TEMPLATE_NAME` — approved template for staff-initiated
     cancellation notices (defaults to `appointment_cancelled`; same 3 body
     params: `{{1}}` clinic, `{{2}}` day, `{{3}}` time). Used by the portal when
     staff cancel an appointment (E4-T3).
2. **Scheduler** — e.g. Vercel Cron in `vercel.json` (sends the Bearer secret
   automatically), or any external cron hitting the URL with the secret header:
   ```json
   { "crons": [{ "path": "/api/cron/reminders", "schedule": "*/15 * * * *" }] }
   ```
   Every 15 minutes is fine — the scan is idempotent (each reminder is claimed
   before sending), so overlapping or frequent runs never double-send.
3. **Verify:** `curl -H "Authorization: Bearer $CRON_SECRET"
   https://clinic-you.vercel.app/api/cron/reminders` → JSON summary
   `{ status, scanned, sent, skipped, failed }`.

> ⚠️ Reminders require an **approved** template. Until Meta approves it the send
> will fail (counted in `failed`) and the reminder is released for retry — so the
> booking demo is unaffected, but reminders won't deliver until approval lands.
> The wacrm template payload shape in `src/lib/whatsapp/send.ts` (`sendTemplate`)
> is marked `TODO(verify)` — confirm it against wacrm's real API before relying
> on it in production.

---

## Phase 6 — End-to-end test

1. From a phone, WhatsApp the clinic's number: "appointment".
2. Expect: numbered doctor menu → reply a number → day menu → time menu →
   confirmation. Appointment appears in the clinic-saas portal.
3. Book the same slot from a second phone → expect "just taken" (proves the
   no-double-booking constraint).

---

## Ordered checklist

- [ ] Push both repos to GitHub (clinic-saas private)
- [ ] Supabase project A (wacrm) — create, apply migrations
- [ ] Supabase project B (clinic-saas) — create, apply migrations 001–009
- [ ] Seed clinic-saas DB (clinic, doctors, availability, wacrm-account mapping)
- [ ] Deploy wacrm to Vercel + env vars → get URL
- [ ] Deploy clinic-saas to Vercel + env vars (incl. wacrm URL) → get URL
- [ ] Meta: point webhook at wacrm, connect WhatsApp number
- [ ] wacrm: forward inbound webhooks to clinic-saas `/api/whatsapp/inbound`
- [ ] End-to-end conversation test

---

## Blockers to clear first (known gaps)

1. **wacrm public API contract** — clinic-saas's `send.ts` assumes an endpoint
   shape that should be verified against wacrm's real public API before relying
   on it in production.
2. **Meta onboarding lead time** — number + template approval can take days.

> Resolved: an earlier version of this guide listed "missing migrations
> (`wa_sessions` + `clinic_wacrm_accounts`)" as the top blocker. Both exist in
> migration `006` — the schema is complete for the MVP.

---

## Alternatives considered

- **Render free tier** — works, but free instances sleep and cold-start; a
  sleeping webhook receiver can drop inbound WhatsApp events. Vercel serverless
  doesn't have that problem, so Vercel is preferred for both apps.
- **Railway / Fly.io** — trial credits rather than a durable free tier; usable
  but may require a card.
- **Self-host on a VPS (Docker)** — most control, not free, more ops. Revisit
  for the real (paid) launch, not the demo.
