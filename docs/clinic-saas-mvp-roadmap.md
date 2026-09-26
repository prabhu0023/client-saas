# Clinic SaaS — MVP Delivery Roadmap

> Ordered, ticket-by-ticket plan to take the product from its current state to a
> defensible MVP. Companion to `clinic-saas-plan.md` (which holds the product
> summary, architecture decisions, and deferred scope). This doc is the
> **execution** view: what's done, what's left, and the order to build it.
>
> Status legend: ✅ done · 🟡 partial · ⬜ not started

---

## 0. Where we are today (verified against the code)

The **core booking loop works end-to-end** and is not stubbed:

- WhatsApp inbound webhook (`src/app/api/whatsapp/inbound/route.ts`) — HMAC
  verify, dedupe on delivery id, resolve tenant by wacrm `account_id`, resolve
  patient phone, dispatch to the flow, send the reply. Sending is **real**
  (`send.ts` POSTs to wacrm).
- Numbered-text conversation state machine (`src/lib/whatsapp/text-flow.ts` +
  `session.ts`): `idle → awaiting_doctor → awaiting_day → awaiting_time → book`,
  session persisted in `wa_sessions` (30-min expiry), single-doctor clinics skip
  the doctor step.
- Timezone-correct slot generation (`src/lib/availability/slot-generation.ts`,
  `timezone.ts`) via `date-fns-tz`; DST covered by tests.
- Atomic booking (`src/lib/booking/book.ts` → `book_appointment` RPC) with the
  `btree_gist` exclusion constraint as the authoritative no-double-booking guard.
- Full schema across 6 migrations: tables, exclusion constraint, RLS policies,
  booking RPC, dedupe ledger, and the `clinic_wacrm_accounts` + `wa_sessions`
  tables.
- Staff portal: email/password auth, `requireStaff()` gate, one-day dashboard
  with status-transition actions (booked→confirmed/cancelled/no_show,
  confirmed→completed/cancelled/no_show).
- Working scripts: `seed.ts` (idempotent demo clinic + 2 doctors + availability +
  demo appointments) and `wacrm-setup.ts` (`verify` / `register`).

**Known gaps that block a clean MVP** (detailed as tickets below):

- ~~Orphaned tap-based flow files still present and still tested (dead path).~~
  ✅ Done (E1-T1): removed `flow.ts`, `resolve-by-number.ts`, `slot-id.ts`, the
  dead list builders in `messages.ts`, and their tests; relocated the live
  `matchesBookingKeyword` to `keywords.ts` and the `DoctorOption`/`DayOption`
  types to `types.ts`. Build + tests + lint green.
- Stale claims in `clinic-saas-plan.md` §8 (says `wa_sessions` /
  `clinic_wacrm_accounts` migrations are unwritten — they exist in migration 006).
- No reminder cron / template-send layer (the one in-scope MVP feature missing).
- No patient-facing cancel/reschedule, and no patient notification when staff
  change an appointment.
- Portal: doctor names not shown (RLS-blocked), no availability-management UI,
  thin onboarding.
- No end-to-end/integration tests for the live route or `text-flow.ts`.

---

## 1. How to read this roadmap

Work is grouped into **Epics** (E1…E7) ordered by dependency and value. Each Epic
contains **tickets** with a stable id (`E1-T1`), scope, acceptance criteria, and
dependencies. Build epics in order; within an epic, tickets are also ordered.

**Milestones:**

- **M1 — Trustworthy core** (E1 + E2): the current loop is clean, correct, and
  proven by tests. No new features, just make what exists solid and honest.
- **M2 — Demo-complete** (E3 + E4): reminders fire and patients can manage their
  own bookings — the full narrative in `clinic-saas-plan.md` §7 works on real
  WhatsApp.
- **M3 — Operable** (E5 + E6): staff can run a clinic without touching SQL
  (availability + basic onboarding), and the portal is coherent.
- **M4 — Release hardening** (E7): observability, rate limits, and deploy
  rehearsal.

---

## Epic E1 — Reconcile & clean the core (M1)

**Goal:** eliminate the doc/code drift and dead code so the codebase tells the
truth. No behavior change for the patient.

### E1-T1 — Retire the orphaned tap-based flow ✅ DONE
- **Scope:** remove or quarantine the un-wired stateless flow now that the live
  path is numbered-text: `src/lib/whatsapp/flow.ts`, `resolve-by-number.ts`,
  `src/lib/booking/slot-id.ts`, and the interactive-list builders in `messages.ts`
  that nothing calls. Remove their tests (`flow.test.ts`, `slot-id.test.ts`) or
  repoint them at live code.
- **Before deleting:** confirm no live import path reaches them (grep for
  `handleInbound`, `resolveClinicIdByPhoneNumberId`, `slot-id`, the list builders).
- **Acceptance:**
  - `npm run build` + tests pass with the files removed.
  - No remaining import references to the deleted symbols.
  - Test suite no longer exercises a dead path.
- **Deps:** none. Do this first — it shrinks the surface every later ticket touches.
- **Note:** if you want to keep the Meta-direct/tap-based design for the future,
  move these files under a `docs/` or `archive/` path rather than deleting, and
  drop their tests from the run.

### E1-T2 — Fix stale claims in the plan doc ✅ DONE
- **Scope:** update `clinic-saas-plan.md` §8 — the `wa_sessions` and
  `clinic_wacrm_accounts` migrations exist (migration 006); mark them ✅. Fold the
  §5/§6 tap-based prose into a clearly-labeled "original design" appendix so the
  numbered-text flow is the primary description.
- **Acceptance:** plan §8 checklist matches reality; no reader is told a
  runtime-blocking migration is missing when it isn't.
- **Deps:** E1-T1 (so the doc reflects the cleaned code).

### E1-T3 — Confirm migrations apply cleanly from zero 🟡 DOC DONE, RUN PENDING
- **Scope:** run all 6 migrations against a fresh Supabase project (or local
  shadow db) and then `seed.ts`; verify the demo clinic, doctors, availability,
  and demo appointments land and the dashboard renders them.
- **Acceptance:** documented "from scratch" bring-up in `deployment.md` that a
  new environment can follow; seed prints working login creds.
- **Deps:** E1-T2.
- **Status:**
  - ✅ Reviewed all 6 migrations — self-consistent, correctly ordered, idempotent.
  - ✅ Wrote the "From-scratch bring-up" section in `deployment.md` (local-stack
    + remote paths, migration dependency table) and corrected the stale
    "missing migrations" claims there.
  - ⬜ Actual from-zero run — blocked on environment choice: Docker isn't
    running and the local stack isn't initialized (`supabase init` needed). Awaiting
    a decision on local stack (start Docker) vs. a throwaway remote project.

---

## Epic E2 — Prove the core with tests (M1)

**Goal:** the loop is currently trusted by unit tests on slot-gen and booking
mapping only. Add coverage where a regression would break a live booking.

### E2-T1 — Integration test for `handleTextMessage` ✅ DONE
- **Scope:** drive the state machine through `idle → doctor → day → time → book`
  with a stubbed Supabase admin + wacrm send. Cover: keyword start, single-doctor
  auto-route, invalid replies (`buildDidNotUnderstand`), `slot_taken` re-offer,
  and session expiry.
- **Acceptance:** a test that books an appointment purely by feeding inbound text
  strings; failure of any step fails the test.
- **Deps:** E1-T1.

### E2-T2 — Route-level test for the webhook contract ✅ DONE
- **Scope:** `src/app/api/whatsapp/inbound/route.ts` — bad signature → 401,
  duplicate delivery id → `duplicate`, non-`message.received` → `ignored`,
  missing text → `no_text`, happy path → `handled` + one send.
- **Acceptance:** the wacrm envelope contract is pinned by tests; signature
  verification and dedupe cannot silently regress.
- **Deps:** E2-T1.

### E2-T3 — Concurrency/no-double-booking test ✅ DONE (gated)
- **Scope:** two bookings racing for the same slot against the real RPC (local
  Postgres) — one wins, the other returns `slot_taken`.
- **Acceptance:** the exclusion constraint is proven under contention, not just
  asserted.
- **Deps:** E1-T3 (needs a real DB to run migrations against).
- **Status:** written as `src/lib/booking/book.concurrency.test.ts`, gated
  behind `TEST_DATABASE_URL` so it is **skipped by default** (plain `npm test`
  never touches a real/cloud DB). It creates its own throwaway clinic + doctor,
  fires two concurrent bookings at the same slot (plus an overlapping-but-not-
  identical slot), asserts exactly one `booked` + one `slot_taken`, then deletes
  everything it created. To run against a throwaway local stack:
  ```bash
  TEST_DATABASE_URL=http://127.0.0.1:54321 \
  TEST_DATABASE_SERVICE_KEY=<local service_role key> \
  npx vitest run src/lib/booking/book.concurrency.test.ts
  ```
  ⬜ Not yet executed against a live DB (needs the local stack / a throwaway
  project) — the assertions are ready and will run when a DB is provided.

---

## Epic E3 — Appointment reminders (M2)

**Goal:** build the cron + template-send foundation. This is the single in-scope
MVP feature that is entirely missing, and it's the base every future proactive
message reuses.

> Meta template approval is slow — **submit the reminder template on day 0** in
> parallel with this work (see `clinic-saas-plan.md` §10 risk 1).

### E3-T1 — Template-send path in the wacrm layer ✅ DONE
- **Scope:** extend `src/lib/whatsapp/send.ts` (or a sibling) with a
  template-message send (approved template name + variables), distinct from the
  free-form send used inside the 24h window.
- **Acceptance:** a unit-tested function that posts a template send to wacrm;
  graceful failure when env/config is missing (matches existing send behavior).
- **Deps:** E1 complete. Approved Meta template (external, parallel).

### E3-T2 — Reminder schedule model + migration ✅ DONE
- **Scope:** decide the minimal shape for MVP — a scan over `appointments` for
  "starts within the reminder window and not yet reminded" is enough; add a
  `reminder_sent_at` column (migration 007) rather than a full `patient_reminders`
  table (that richer table is deferred, `clinic-saas-plan.md` §9.1).
- **Acceptance:** migration adds the column + an index supporting the due-scan;
  RLS unaffected (service-role path).
- **Deps:** E3-T1.

### E3-T3 — Reminder cron route + scanner ✅ DONE
- **Scope:** a route (e.g. `src/app/api/cron/reminders/route.ts`) protected by a
  shared secret, that finds due appointments in each clinic's timezone, sends the
  template, and stamps `reminder_sent_at`. Idempotent (safe to run every N min).
- **Acceptance:** invoking the route twice sends each reminder once; timezone
  correct; documented cron trigger (platform scheduler) in `deployment.md`.
- **Deps:** E3-T2.

---

## Epic E4 — Patient-managed bookings over WhatsApp (M2)

**Goal:** patients can cancel/reschedule without calling the clinic, and staff
changes reach the patient. Completes the "real appointment" story.

### E4-T1 — Patient cancel over WhatsApp ✅ DONE
- **Scope:** extend the flow so a keyword (e.g. "cancel") lists the patient's
  upcoming appointments (by `clinic_id` + `wa_phone`) and cancels the chosen one
  (status → `cancelled`), freeing the slot. New session step(s) reusing
  `matchOption`.
- **Acceptance:** patient cancels via text; slot becomes bookable again;
  confirmation sent. Guardrails: only the patient's own appointments, only
  cancellable statuses.
- **Deps:** E1 complete.

### E4-T2 — Patient reschedule over WhatsApp ✅ DONE
- **Scope:** reschedule = cancel + rebook in one flow (pick new day → time for the
  same doctor). Atomic where practical; if the new slot is taken mid-flow, keep
  the original and re-offer.
- **Acceptance:** original slot released only when the new booking commits; no
  window where the patient has zero or double appointments.
- **Deps:** E4-T1.

### E4-T3 — Notify patient on staff-side change ✅ DONE
- **Scope:** when staff cancel/reschedule in the portal (`dashboard/actions.ts`),
  send the patient a WhatsApp message. Within 24h → free-form; outside → template
  (reuses E3-T1).
- **Acceptance:** staff cancellation reaches the patient; template used when
  outside the session window.
- **Deps:** E3-T1, E4-T1.

---

## Epic E5 — Availability management in the portal (M3)

**Goal:** staff configure availability without SQL. Today it's seed-only.

### E5-T1 — View current availability ✅ DONE
- **Scope:** a portal screen listing a doctor's `availability_rules` (weekly) and
  upcoming `availability_exceptions`, RLS-scoped.
- **Acceptance:** staff see the rules that drive the WhatsApp day/time lists.
- **Deps:** E1 complete.

### E5-T2 — Edit weekly rules + exceptions
- **Scope:** create/update/deactivate `availability_rules`; add `off`/`extra`
  `availability_exceptions` for specific dates. Validate against the schema checks.
- **Acceptance:** a rule change immediately alters the slots the WhatsApp flow
  offers (verify against `generateSlots`); RLS enforced.
- **Deps:** E5-T1.

---

## Epic E6 — Portal coherence (M3)

**Goal:** the staff portal reads as a finished product for the demo.

### E6-T1 — Show doctor names (RLS view/RPC)
- **Scope:** doctor names aren't shown today because `users` is RLS-self-only
  (noted in `portal/appointments.ts`). Add a `SECURITY DEFINER` view/RPC exposing
  member display names within the caller's clinic only.
- **Acceptance:** dashboard shows the treating doctor's name; no cross-clinic leak.
- **Deps:** E1 complete.

### E6-T2 — Multi-day / week view
- **Scope:** the dashboard shows one day; add next/prev day and a simple week
  overview so staff aren't clicking a date picker per day.
- **Acceptance:** navigate days without retyping dates; counts per day visible.
- **Deps:** E6-T1.

### E6-T3 — Clinic switcher (if a user is in >1 clinic)
- **Scope:** `requireStaff()` picks the first active membership. Add a switcher
  when a user belongs to multiple clinics.
- **Acceptance:** switching clinic re-scopes the dashboard; default stays the
  first membership. (Skip if MVP users are single-clinic — mark deferred.)
- **Deps:** E6-T1.

---

## Epic E7 — Release hardening (M4)

**Goal:** make it operable and safe to demo on real WhatsApp.

### E7-T1 — Structured logging + error surfacing
- **Scope:** consistent logging in the webhook and flow (delivery id, clinic, step,
  outcome) so a failed booking is diagnosable from logs.
- **Acceptance:** every inbound delivery produces a traceable log line with its
  outcome (`handled`/`duplicate`/`no_clinic`/`error`).
- **Deps:** M1–M3 substantially complete.

### E7-T2 — Rate limiting / abuse guard on inbound
- **Scope:** basic per-conversation throttle so a spammy sender can't loop the
  flow; cheap, in-DB or in-memory for MVP.
- **Acceptance:** excessive inbound from one conversation is dropped/slowed
  without affecting other tenants.
- **Deps:** E7-T1.

### E7-T3 — End-to-end rehearsal on real WhatsApp
- **Scope:** run the full `clinic-saas-plan.md` §7 narrative on the deployed HTTPS
  URL: text the number, book, see "just taken" from a second phone, view in portal,
  receive a reminder.
- **Acceptance:** the demo narrative passes on real infrastructure; any failure
  files a ticket.
- **Deps:** all prior epics; approved reminder template.

---

## Dependency overview

```
E1 (clean) ─┬─> E2 (tests) ───────────────┐
            ├─> E3 (reminders) ─┬─> E4 (patient mgmt) ─┐
            ├─> E5 (availability)                      │
            └─> E6 (portal) ───────────────────────────┤
                                                        └─> E7 (hardening)
M1 = E1+E2 · M2 = E3+E4 · M3 = E5+E6 · M4 = E7
```

## Suggested build order (flat)

1. E1-T1 → E1-T2 → E1-T3  (clean + honest)
2. E2-T1 → E2-T2 → E2-T3  (prove the core)
3. E3-T1 → E3-T2 → E3-T3  (reminders; submit Meta template in parallel now)
4. E4-T1 → E4-T2 → E4-T3  (patient cancel/reschedule + notify)
5. E5-T1 → E5-T2          (availability UI)
6. E6-T1 → E6-T2 → E6-T3  (portal polish)
7. E7-T1 → E7-T2 → E7-T3  (harden + rehearse)

## Explicitly out of MVP scope

Carried over from `clinic-saas-plan.md` §9 — do **not** pull these in without a
deliberate decision: prescriptions, payments/billing, self-serve clinic
onboarding, nurse workflows, booking Pattern B/C (service-first), direct Meta
Cloud API transport, waitlist, per-service duration override, global
cross-clinic patient records, and the richer `patient_reminders` recurrence
engine (medication/lab follow-ups).
