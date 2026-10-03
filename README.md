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

### Bringing up a real clinic

Apply the migrations (below), then open **`/signup`** and create the clinic from
the browser: account → clinic name, slug and timezone → connect the wacrm
account → invite staff → availability → services. No SQL and no seed script.

Two env vars gate it:

- `ONBOARDING_SIGNUP_CODE` — the shared code `/signup` asks for
  (`openssl rand -hex 16`). With it unset, signup is **open** in development and
  **disabled** everywhere else, so a deployment never exposes an ungated signup
  form by accident.
- `NEXT_PUBLIC_APP_URL` — the public base URL invite links are built from.
  Invites refuse to be created without it, by design, so a misconfiguration
  cannot burn invite tokens.

Set both in the host (e.g. Vercel) and **redeploy** — a running deployment keeps
the old env values.

`npm run seed` stays as it is: local **demo** data, not the path a real clinic
takes.

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
- `012_clinic_onboarding.sql` — self-serve clinic creation: `is_clinic_admin()`,
  `my_membership_status()`, `clinic_member_identities()`, the
  `create_clinic_with_owner` and `connect_wacrm_account` RPCs, the last-admin and
  doctor-profile guard triggers, and one active wacrm mapping per clinic
- `013_clinic_invites.sql` — `clinic_invites` (hash-only tokens) + the
  `accept_clinic_invite` enrolment transaction
- `014_admin_write_policies.sql` — member-read / admin-write split over the seven
  tenant-configuration tables, plus the `set_doctor_services` RPC

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

### Self-serve onboarding

A clinic now onboards itself: `/signup` → `/onboarding` → `/setup`'s checklist,
with `/staff` for invites and roles and `/services` for prices and the
doctor-service mapping. Staff arrive through a one-time invite link
(`/join/<token>`) and set their own password; only the hash of the token is ever
stored. Run `supabase db push` so `012`, `013` and `014` are applied — without
them `/onboarding` cannot create a clinic and the admin screens are inert.

What makes a member bookable is a **doctor profile**, not a role, so a solo
owner stays `admin` and still appears to patients on WhatsApp.

The onboarding tests that need a real database are gated on three vars, so
`npm test` skips them. To run them against a throwaway stack with the migrations
applied:

```bash
supabase start
supabase db push
TEST_DATABASE_URL=http://127.0.0.1:54321 \
TEST_DATABASE_SERVICE_KEY=<local service_role key> \
TEST_DATABASE_ANON_KEY=<local anon key> \
npx vitest run src/lib/portal/onboarding.integration.test.ts
```

The anon key is **required**, not optional: the service-role client bypasses RLS,
so the tenant-isolation cases would pass vacuously without a real user session.

**Release gate — do not admit real clinics before both of these pass.**
`npm test` alone never touches a database, so the four RPC transactions, the
last-admin and doctor-profile guards, and the member-read / admin-write policies
`014` installs over seven live tables are otherwise only covered by mocks:

1. `012_clinic_onboarding.sql`, `013_clinic_invites.sql` and
   `014_admin_write_policies.sql` are applied with `supabase db push`.
2. `src/lib/portal/onboarding.integration.test.ts` passes against a throwaway
   stack with those migrations applied (the command above), on any machine with
   Docker.

> **Status: neither condition has been met yet.** The suite ships **unexecuted**
> — it was written on a machine with no Docker daemon and no `supabase/config.toml`,
> so no local stack could be started and `012`–`014` have not been applied to any
> database. Treat the feature as unverified against Postgres until someone runs
> the two steps above. The board keeps ONB-1's 🚦 launch gate open for the
> separate compliance reason (COMP-1/COMP-2).

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
