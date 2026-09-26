# DoctorDesk

WhatsApp-first clinic appointment platform. Staff portal coming soon.

See the planning docs (currently in the `wacrm` repo under `docs/`):
`clinic-saas-plan.md`, `clinic-saas-architecture.md`, `clinic-saas-folder-structure.md`.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Supabase (Postgres + Auth + RLS)
- `date-fns` / `date-fns-tz` for timezone-correct slot generation
- WhatsApp channel via `wacrm` (MVP)

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase + secrets
npm run dev
```

## Database

Migrations live in `supabase/migrations/`:

- `001_initial_schema.sql` — all tables (clinics, members, doctors, patients,
  services, availability, appointments)
- `002_btree_gist_exclusion.sql` — the no-double-booking exclusion constraint
- `003_rls_policies.sql` — RLS clinic isolation for the staff portal
- `004_book_appointment_fn.sql` — transactional book-appointment function
- `005_processed_wa_events.sql` — inbound WhatsApp event dedupe table

Apply them with the Supabase CLI (`supabase db push`) or paste into the SQL
editor in order.

## Scripts

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run test` — vitest
- `npm run seed` — seed one demo clinic (1 clinic, WA number, 2 doctors with
  Mon–Fri availability, 2 services). Requires `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. Set `DEMO_PHONE_NUMBER_ID` to the
  Meta `phone_number_id` of your demo WhatsApp number so inbound events route to
  the seeded clinic. Idempotent — safe to re-run.

### Shell scripts (`scripts/`)

Build and run the app with the paired shell scripts:

```bash
./scripts/build.sh              # full build: node check, deps, typecheck, lint, tests, next build
./scripts/build.sh --fast       # build only (skip lint + tests)
SKIP_TESTS=1 ./scripts/build.sh # build + lint, skip tests

./scripts/start.sh              # production: build if needed, then serve
./scripts/start.sh --dev        # dev server (hot reload)
./scripts/start.sh --rebuild    # force a fresh build, then serve
PORT=4000 ./scripts/start.sh    # override port (default 3000)
```

`start.sh` warns (does not fail) when `.env.local` or the Supabase vars are
missing, so the server can still boot for a health check during setup — but
runtime requests need those vars set.

There is also `scripts/run.sh`, an all-in-one helper with subcommands
(`setup`, `env`, `check`, `test`, `dev`, `build`, `start`, `seed`, `verify`);
`run.sh help` lists them. `build.sh` + `start.sh` are the focused pair; `run.sh`
is the convenience wrapper.

## Status

Scaffold + schema + Supabase clients + slot-id encoding. Next: slot generation,
booking transaction, WhatsApp flow, staff portal (see the plan doc's next steps).
