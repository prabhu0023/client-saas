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
│   ├── slot-id.ts                # Encode/parse slot row ids
│   └── slot-id.test.ts
│
├── whatsapp/
│   ├── text-flow.ts              # LIVE: numbered-text state machine (doctor→day→time)
│   ├── session.ts                # wa_sessions state + option matching
│   ├── query.ts                  # DB reads backing the flow (doctors, days)
│   ├── messages.ts               # Numbered-menu + confirmation builders
│   ├── send.ts                   # Send via wacrm
│   ├── wacrm-client.ts           # wacrm public-API client (resolve contact phone)
│   ├── verify-signature.ts       # Verify wacrm webhook HMAC
│   ├── types.ts                  # Inbound/outbound message shapes
│   ├── flow.ts                   # ORPHANED stateless router (see note)
│   └── flow.test.ts
│
├── portal/
│   ├── auth.ts                   # Staff session + role helpers
│   └── appointments.ts           # Portal appointment reads (RLS-scoped)
│
# future: reminders/ (scheduler + template send), patients/
```

> **Reconciliation note:** the live WhatsApp flow is the numbered-text variant
> (`text-flow.ts` + `session.ts`), driven by the inbound route. `flow.ts` (the
> stateless tap-based router) and `resolve-by-number.ts` are **orphaned** — kept
> for now but not wired. Consolidating them is a pending cleanup.

---

## `supabase/migrations/`

```
supabase/migrations/
├── 001_initial_schema.sql        # All tables from §3 of the plan
├── 002_btree_gist_exclusion.sql  # btree_gist + no-overlap constraint
├── 003_rls_policies.sql          # RLS + clinic_members isolation
├── 004_book_appointment_fn.sql   # Transactional booking RPC
├── 005_processed_wa_events.sql   # Inbound WhatsApp dedupe ledger
└── (pending) wa_sessions, clinic_wacrm_accounts  # referenced by the live flow
```

> **Gap:** the live flow references `wa_sessions` (session state) and
> `clinic_wacrm_accounts` (account→clinic routing) which do not yet have
> migrations — this blocks runtime and is the top pending item.

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
