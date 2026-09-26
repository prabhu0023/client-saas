> ⚠️ **ARCHIVED / superseded.** Repo structure now lives in
> `../product-requirements.md` §10, and the migration list in §6. Kept for
> history; not maintained. See `./README.md`.

# Clinic Appointment SaaS — Proposed Code Folder Structure

> Companion to `clinic-saas-plan.md` and `clinic-saas-architecture.md`. This is
> the folder layout for the clinic project (Next.js App Router + Supabase). It
> mirrors `wacrm`'s conventions: `src/{app,components,hooks,lib,types}`, domain-
> grouped folders under `lib/`, and colocated `*.test.ts` files. Only the
> folders/files needed for the **MVP** are marked; future-scope items are noted
> but not required to start.
>
> This doc lives in `clinic-saas/docs/` alongside the code it describes.

---

## Top-level

```
clinic-saas/
├── src/
│   ├── app/                      # Next.js App Router: routes, API, portal pages
│   ├── components/               # React UI (portal)
│   ├── hooks/                    # Client React hooks
│   ├── lib/                      # Domain logic (server + shared), the core
│   ├── types/                    # Shared TypeScript types
│   └── proxy.ts                  # Session-refresh middleware (Next 16 renames
│                                 #   `middleware` -> `proxy`)
├── supabase/
│   └── migrations/               # SQL migrations (schema, RLS, constraints)
├── scripts/
│   ├── build.sh                  # Production build (checks + next build)
│   ├── start.sh                  # Start (prod/dev), builds if needed
│   ├── run.sh                    # All-in-one helper (setup/check/build/…)
│   ├── seed.ts                   # Demo seed: 1 clinic, 2 doctors, services
│   └── wacrm-setup.ts            # wacrm channel setup helper
├── docs/                         # These planning docs (here, with the code)
├── public/
├── .env.local.example            # Documented env vars (no secrets committed)
├── package.json
├── tsconfig.json
└── next.config.ts
```

---

## `src/app/` — routes & API

```
src/app/
├── login/                        # Staff login (page + server action)
├── logout/                       # Sign-out route
│
├── (portal)/                     # Authenticated staff area (has nav/chrome)
│   ├── layout.tsx                # Guards session; loads clinic context
│   └── dashboard/page.tsx        # Upcoming appointments (MVP demo screen)
│   # future: appointments/, availability/, doctors/, services/, settings/
│
├── api/
│   ├── whatsapp/
│   │   └── inbound/route.ts      # Receives signed events from wacrm; drives flow
│   └── cron/
│       └── reminders/route.ts    # Secret-guarded reminder cron (future)
│
├── layout.tsx                    # Root layout
└── page.tsx                      # Landing (redirects to login/dashboard)
```

**Route-group notes:**
- `(portal)` is a Next.js route group — parentheses don't affect the URL, they
  just give the authenticated area its own layout.
- `api/whatsapp/inbound` is the seam where wacrm forwards WhatsApp events; it
  verifies a wacrm HMAC signature.
- Session refresh is handled by `src/proxy.ts` (the Next 16 middleware).

---

## `src/lib/` — domain logic (the core)

Each domain gets a folder; tests colocated as `*.test.ts` (wacrm convention).

```
src/lib/
├── supabase/
│   ├── server.ts                 # Server client (SSR, RLS-respecting)
│   ├── client.ts                 # Browser client (portal)
│   └── admin.ts                  # Service-role client (RLS-bypassing) — WA path
│
├── clinics/
│   ├── resolve-by-account.ts     # wacrm account_id -> clinic (LIVE tenant router)
│   ├── resolve-by-number.ts      # phone_number_id -> clinic (orphaned; see note)
│   └── tenancy.ts                # Helpers: verify X belongs to clinic Y
│
├── availability/
│   ├── slot-generation.ts        # §4: rules + exceptions - bookings -> slots
│   ├── slot-generation.test.ts   # Timezone/DST + overlap edge cases
│   └── timezone.ts               # date-fns-tz wrappers (UTC <-> clinic tz)
│
├── booking/
│   ├── book.ts                   # §5: atomic insert (via RPC) + conflict recovery
│   ├── book.test.ts              # Race / exclusion-violation handling
│   └── book.concurrency.test.ts  # Gated race test vs a real DB (skipped by default)
│
├── whatsapp/
│   ├── text-flow.ts              # LIVE: numbered-text state machine (doctor→day→time)
│   ├── text-flow.test.ts         # Integration test driving the state machine
│   ├── keywords.ts               # Booking/cancel/reschedule keyword matching
│   ├── session.ts                # wa_sessions state + option matching
│   ├── query.ts                  # DB reads backing the flow (doctors, days, upcoming)
│   ├── messages.ts               # Numbered-menu + confirmation builders
│   ├── send.ts                   # Send via wacrm (text + template)
│   ├── send.test.ts
│   ├── notify.ts                 # Patient notify on staff-side change (template)
│   ├── notify.test.ts
│   ├── wacrm-client.ts           # wacrm public-API client (resolve contact phone)
│   ├── verify-signature.ts       # Verify wacrm webhook HMAC (named failure reasons)
│   └── types.ts                  # Inbound/outbound message shapes
│
├── portal/
│   ├── auth.ts                   # Staff session + role helpers
│   └── appointments.ts           # Portal appointment reads (RLS-scoped)
│
# future: reminders/ (scheduler + template send), patients/
```

> **Reconciliation note (resolved):** the live WhatsApp flow is the numbered-text
> variant (`text-flow.ts` + `session.ts`), driven by the inbound route. The old
> orphaned tap-based files (`flow.ts`, `resolve-by-number.ts`,
> `src/lib/booking/slot-id.ts`) and their tests were **removed** (roadmap E1-T1);
> `matchesBookingKeyword` moved to `keywords.ts`. This tree reflects the current,
> cleaned code.

---

## `supabase/migrations/`

```
supabase/migrations/
├── 001_initial_schema.sql          # All tables from §3 of the plan
├── 002_btree_gist_exclusion.sql    # btree_gist + no-overlap constraint
├── 003_rls_policies.sql            # RLS + clinic_members isolation
├── 004_book_appointment_fn.sql     # Transactional booking RPC
├── 005_processed_wa_events.sql     # Inbound WhatsApp dedupe ledger
├── 006_wa_sessions.sql             # Conversation state for the numbered-text flow
├── 006_wacrm_sessions.sql          # (dup 006) wacrm session/account bits
├── 007_appointment_reminders.sql   # reminder_sent_at + due-scan index
├── 007_clinic_wacrm_accounts.sql   # (dup 007) account_id → clinic routing
├── 008_wa_session_cancel_step.sql  # Widen step CHECK: awaiting_cancel
├── 009_wa_session_reschedule_step.sql # Widen step CHECK: awaiting_reschedule
└── 010_clinic_doctor_names_fn.sql  # SECURITY DEFINER doctor-name lookup (E6-T1)
```

> **Resolved:** `wa_sessions` (session state) and `clinic_wacrm_accounts`
> (account→clinic routing) migrations **exist** (006). The earlier "pending /
> blocks runtime" note was stale. Note the duplicate 006/007 numbers already in
> the tree — the next migration to add is **011**.

---

## `scripts/`

```
scripts/
├── build.sh          # node/deps check -> typecheck -> lint -> tests -> next build
│                     #   flags: --fast (build only), SKIP_TESTS=1
├── start.sh          # prod: build-if-needed then serve; --dev, --rebuild, PORT=
├── run.sh            # all-in-one: setup|env|check|test|dev|build|start|seed|verify
├── seed.ts           # idempotent demo seed (npm run seed)
└── wacrm-setup.ts    # wacrm channel setup helper
```

---

## MVP status (build order)

```
[done] migrations 001–005; schema, exclusion constraint, RLS, booking RPC, dedupe
[done] slot generation (+tests), booking transaction (+tests), slot-id (+tests)
[done] WhatsApp numbered-text flow, inbound route, send, wacrm client, signature
[done] seed script; build.sh / start.sh / run.sh
[partial] staff portal: login/logout/dashboard + proxy session refresh
[pending] migrations for wa_sessions + clinic_wacrm_accounts (blocks runtime)
[pending] reminder cron + template send
[pending] reconcile orphaned stateless-flow files
[pending] deploy to stable URL; end-to-end rehearsal on real WhatsApp
```
