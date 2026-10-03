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
- `011_patient_messaging.sql` — patient messaging inbox: `patient_messages` +
  `patient_threads`, their RLS policies, and the `capture_patient_message` RPC
  that stores an inbound message and bumps its thread in one transaction

Apply them with the Supabase CLI (`supabase db push`) or paste into the SQL
editor in order.

### Patient messaging inbox

A non-booking WhatsApp message is no longer lost: it is captured into the
patient's thread and answered by staff from `/inbox`. Run `supabase db push` so
`011_patient_messaging.sql` is applied — without it every inbound free-text
message falls back to the old "reply with appointment" nudge.

Replies are **in-window only** in v1: staff can answer while the patient's 24h
WhatsApp session is open, and the reply form is disabled (and the server-side
guard refuses the send) once it closes. That needs no new Meta template and no
new env var; the patient is asked to message again instead.

The messaging tests that need a real database are gated, so `npm test` skips
them. To run them against a throwaway stack with the migrations applied:

```bash
supabase start
supabase db push
TEST_DATABASE_URL=http://127.0.0.1:54321 \
TEST_DATABASE_SERVICE_KEY=<local service_role key> \
npx vitest run src/lib/messaging/tenancy.db.test.ts
```

**Release gate — do not enable this feature in production before both of these
pass.** `npm test` alone never touches a database, so the migration's
transaction boundary, the thread upsert, the never-de-escalate rule and the two
RLS policies are otherwise only covered by a TypeScript stand-in:

1. `011_patient_messaging.sql` is applied with `supabase db push`.
2. `src/lib/messaging/tenancy.db.test.ts` passes against a throwaway stack with
   that migration applied (the block above), on any machine with Docker.

### Staff-created appointments

Walk-ins and phone bookings no longer need the patient to open WhatsApp. Staff
book from `/appointments/new` (the **New appointment** button on the dashboard):
find the patient by name or phone — or add them inline — then pick a doctor, a
day and a time.

The offered times come from the **same** `generateSlots` the WhatsApp flow uses,
with the same inputs, so staff and patients never see different availability for
one doctor and day. Only real open slots are bookable: a submitted time is
re-checked against a freshly generated list before anything is written, so there
is no force-booking outside availability.

Writes go through the existing `book_appointment` RPC with
`created_via='portal'`, which keeps the `btree_gist` exclusion constraint as the
single no-double-booking guard — the loser of a race is told to pick again
instead of double-booking.

**No migration is required.** Every table, column, index and RLS policy this
needs already exists: `patients` with its `UNIQUE (clinic_id, wa_phone)`, the
`patients_access` policy from `003_rls_policies.sql`, and the
`appointments.created_via` check that already allows `'portal'`.

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
