# Clinic Appointment SaaS — Plan & MVP Scope

> A WhatsApp-first, multi-tenant clinic appointment platform. Patients interact
> over WhatsApp; doctors/receptionists use a web portal. This document captures
> the agreed architecture, decisions, MVP demo scope, next steps, and deferred
> (future) scope.
>
> Status: planning. This is a **new project** — separate from `wacrm`. `wacrm`
> (or the Meta Cloud API) acts only as the WhatsApp messaging channel.

---

## 1. Product summary

- **What it is:** a SaaS for clinics. Multiple clinics enrol; each has doctors,
  nurses, and receptionists using a staff portal.
- **Who uses what:**
  - **Patients** — interact **only** via WhatsApp (no portal login). They book
    appointments, receive confirmations/reminders.
  - **Staff (doctor / nurse / receptionist / admin)** — use a web portal.
- **Core value (MVP):** a patient books a real appointment over WhatsApp, the
  slot is genuinely reserved (no double-booking), and staff see it in the portal.

---

## 2. Key architectural decisions (agreed)

| Decision | Choice | Why |
|---|---|---|
| Build location | **Separate product**, not inside `wacrm` | It's its own SaaS with regulated data; `wacrm` is just the messaging channel |
| WhatsApp transport (MVP) | **Reuse `wacrm`** as the messaging layer | Webhook/send/interactive plumbing already exists; fastest to demo |
| Patient scope | **Per-clinic** | Cleaner privacy; no cross-clinic history sharing. Key: `(clinic_id, wa_phone)` |
| WhatsApp number | **One per clinic** | The receiving number's `phone_number_id` becomes the tenant key |
| Doctors per clinic | **Multiple** | Booking resolves to one doctor before slot lookup |
| Booking pattern | **Pattern A** — pick doctor → pick slot | Simplest; matches most clinics' mental model |
| Slot length | **Per doctor** (`doctor_profiles.slot_minutes`) | Per your requirement |
| Timezone | **Per clinic, chosen at onboarding** | Multi-region capable; one tz per clinic |
| Double-booking prevention | **DB exclusion constraint** (`btree_gist`) | Database decides the winner atomically; no app-level race |
| Time storage | **UTC in appointments; local clock in availability rules** | DST-safe; clinic timezone bridges the two |

> **Implementation note (WhatsApp flow, updated):** the MVP integrates via
> `wacrm`, whose inbound webhook forwards **free text only** (not the tapped
> interactive-row id) and identifies the tenant by wacrm `account_id`. The live
> flow is therefore a **stateful, numbered-text menu** (session in `wa_sessions`,
> replies matched by number) rather than the stateless interactive-row model
> sketched in §5/§6 below. §5/§6 describe the original design and the tap-based
> mechanics; the numbered-text variant reuses the same slot-gen and booking core.
> See the code in `src/lib/whatsapp/` (`text-flow.ts`, `session.ts`) for the
> implemented version. Reconciling §5/§6 prose with the implemented flow is a
> pending doc cleanup.

---

## 3. Data model (target schema)

Postgres/Supabase. Every clinic-scoped table carries `clinic_id`; RLS keys off it.

```
clinics
  id, name, slug (unique), timezone (not null), status, created_at

clinic_whatsapp_numbers            -- tenant router: phone_number_id → clinic
  id, clinic_id, phone_number_id (unique), display_number, status, created_at

users                              -- one row per human login (= auth.users)
  id, full_name, email, created_at

clinic_members                     -- membership + role, per clinic
  id, clinic_id, user_id, role ('doctor'|'nurse'|'receptionist'|'admin'),
  status ('active'|'invited'|'disabled'), created_at
  unique (clinic_id, user_id)

doctor_profiles                    -- extends a doctor membership
  id, clinic_member_id (unique), clinic_id, specialty,
  registration_number, slot_duration_minutes (default 15)

patients                           -- records, NOT logins
  id, clinic_id, wa_phone (E.164), full_name, date_of_birth, notes, created_at
  unique (clinic_id, wa_phone)

services
  id, clinic_id, name, price_cents, active

doctor_services                    -- which doctor provides which service
  id, clinic_id, doctor_id, service_id
  unique (doctor_id, service_id)

availability_rules                 -- recurring weekly template, LOCAL clock time
  id, clinic_id, doctor_id, weekday (0=Sun..6=Sat),
  start_time (time), end_time (time), slot_minutes, active

availability_exceptions            -- date-specific overrides
  id, clinic_id, doctor_id, date, kind ('off'|'extra'),
  start_time (nullable), end_time (nullable)

appointments                       -- UTC timestamps
  id, clinic_id, doctor_id, patient_id,
  starts_at (timestamptz), ends_at (timestamptz),
  status ('booked'|'confirmed'|'cancelled'|'completed'|'no_show'),
  service_id (nullable), created_via ('whatsapp'|'portal'), created_at
```

**Critical constraints on `appointments`:**

```sql
-- enable once
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- no overlapping active appointments for the same doctor
ALTER TABLE appointments ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('booked','confirmed'));

-- optional cheap extra guard for fixed-length slots
CREATE UNIQUE INDEX appt_doctor_start
  ON appointments (doctor_id, starts_at)
  WHERE status IN ('booked','confirmed');
```

**Relationship map:**

```
clinics ─┬─< clinic_whatsapp_numbers   (phone_number_id → clinic)
         ├─< clinic_members >── users   (role per membership)
         ├─< doctor_profiles            (slot length here)
         ├─< patients                   (unique per clinic_id + wa_phone)
         ├─< services
         ├─< doctor_services
         ├─< availability_rules         (local clock time)
         ├─< availability_exceptions
         └─< appointments ── patient, doctor, service   (UTC, no-overlap)
```

**Tenancy / RLS notes:**
- Enable RLS on every clinic-scoped table; policy checks the user is an active
  `clinic_members` row for that `clinic_id`. Layer role checks for sensitive tables.
- Patients are **not** logged in → WhatsApp-driven reads/writes run **server-side
  via the service role** (bypasses RLS). Server code must re-verify tenancy
  (e.g. doctor belongs to the resolved clinic) as defense-in-depth.
- Denormalize `clinic_id` onto child tables so RLS policies stay simple/fast.

---

## 4. Slot generation (read path)

Given `doctorId`, `date`, `clinicTimezone`, `slotMinutes` → ordered bookable slots.

1. Compute **weekday in the clinic timezone**.
2. Gather recurring `availability_rules` for that doctor + weekday → local windows.
3. Apply `availability_exceptions` for that date: `off` (whole day → empty, or
   subtract a range), `extra` (add a range).
4. Bind local windows to the date **in the clinic timezone**, convert to UTC
   (DST-safe — do this per-date through the named timezone, never fixed offsets).
5. Chunk each UTC window into `slotMinutes` intervals (slot must fully fit:
   `cursor + slotMinutes <= windowEnd`).
6. Subtract active appointments via half-open overlap test:
   `a.start < b.end && a.end > b.start`.
7. Drop past slots and anything within minimum lead time.
8. Render labels in clinic-local time for the WhatsApp list.

**Principles:** compute on demand (cache a rolling 7–14 day window); local clock
in rules, UTC in appointments, timezone as the bridge; the slot list is
advisory — the DB constraint is authoritative; half-open intervals everywhere.
Use `date-fns-tz` or Luxon for conversions — never hand-roll offsets.

---

## 5. Booking transaction (write path)

> **Accuracy note:** the transactional principle below matches the live code
> (`src/lib/booking/book.ts` → `book_appointment` RPC). Two identifiers differ
> from this original sketch: the tenant is resolved from the **wacrm
> `account_id`** (not the Meta `phone_number_id`), and dedupe keys off the
> **wacrm delivery id** (not a Meta `wamid`). The atomicity, patient upsert,
> and conflict-recovery behavior are as described.

**Principle:** the database decides who wins. Never check-then-insert. Attempt
the insert; let it commit or fail on the exclusion constraint.

```
[dedupe]  seen this WhatsApp message id (wamid) before? → ignore if yes
[resolve] clinic from phone_number_id → verify doctor ∈ clinic
BEGIN
  upsert patient (clinic_id, wa_phone)
  INSERT appointment status='booked'         -- atomic reservation
  success            → COMMIT → send WhatsApp confirmation (session message)
  exclusion_violation(23P01) → ROLLBACK → regenerate slots
                              → send "just taken, pick again"
```

- **Confirmation is sent only after commit** (inside the 24h window → free-form
  message is fine).
- **Idempotency:** dedupe inbound `wamid` (same pattern `wacrm` uses); optionally
  enforce one active appointment per patient/doctor/day.
- **Tenancy re-check** server-side because the service role bypasses RLS.

---

## 6. WhatsApp conversation flow (staged selection)

> **Note:** this section describes the original tap-based (interactive-row)
> design. The implemented MVP uses a numbered-text variant (see the note in §2)
> because `wacrm` forwards free text only. The staging (doctor → day → time) and
> the slot-gen/booking core are identical; only the selection mechanism differs
> (numbered replies vs. tapped row ids).

**Constraint:** a WhatsApp interactive **list** allows max **10 rows** (buttons
max 3). You cannot show many days × many times in one message, so selection is
**staged**: doctor → day → time. Each stage fires on the previous stage's
`interactive_reply` id.

```
"I need an appointment"
      │
[pick doctor]  list of doctors (≤10)                 id: doc_<uuid>
      │
[pick day]     list of days WITH availability (≤10)  id: day_<doctorId>_<YYYY-MM-DD>
      │        (run slot-gen per upcoming date in a
      │         rolling ~14-day window; include a day
      │         only if it yields ≥1 open slot; show
      │         the nearest 10)
      │
[pick time]    list of times for that day (≤10)      id: slot_<doctorId>_<YYYY-MM-DD>_<HHMM>
      │        (only the chosen day's times)
      │
[book]         parse id → combine date+time in clinic tz → UTC
               → atomic booking transaction (§5) → confirm
```

**Answering the recurring UX questions:**
- *Show only the time?* Yes — at the **time** stage, after a day is picked.
- *Show future dates?* The **day** stage lists upcoming days that have open
  slots, **derived live** from availability rules − bookings − exceptions
  (§4). Future dates are not stored; they're computed per-date.

**Row-id encoding (stateless — reconstruct without a lookup table):**
```
day step:   day_<doctorId>_<YYYY-MM-DD>
time step:  slot_<doctorId>_<YYYY-MM-DD>_<HHMM>
```
On the final tap, parse the slot id, combine date + time **in the clinic
timezone**, convert to UTC → that's `starts_at` for the booking transaction.

**More than 10 times in a day:** offer **Morning / Afternoon / Evening** (3
buttons) then times within the part (fits ≤10); or show the first 10 with a
"See more times →" paging row. MVP: parts-of-day if days are busy, else first 10.

**Setup side (staff portal):** availability is configured via `availability_rules`
(recurring weekly) + `availability_exceptions` (per-date off/extra). The patient
day/time lists are generated from these; staff never enter individual future
slots.

**Caveat:** day/time lists are **snapshots**, not reservations. If a time is
taken between display and tap, the atomic constraint (§5) rejects it → recover by
regenerating that day's times ("just taken, here are the current openings").

---

## 7. MVP demo scope

**Goal:** prove the core loop on real WhatsApp with real slot logic.

**In scope for the demo:**
- One seeded clinic, 2 doctors with availability, a few services (SQL seed, no
  onboarding UI).
- Schema + `btree_gist` + exclusion constraint.
- Slot generation (timezone-correct).
- Booking transaction (atomic) + idempotency.
- WhatsApp flow (staged, see §6): keyword → pick doctor → pick day → pick time →
  book → confirm.
- Staff portal: Supabase auth + one screen showing upcoming appointments per
  doctor, with RLS enforcing clinic isolation.
- Reminder cron sending a **pre-approved template** before appointments.
- Deployed to a **stable HTTPS URL** (not ngrok) with managed Postgres.

**The demo narrative ("done" looks like):**
1. Text the clinic's WhatsApp number: "I need an appointment."
2. Pick a doctor → see real available slots → tap one.
3. Instant confirmation; slot genuinely reserved (tap again from another phone →
   "just taken" — proves no double-booking).
4. Open staff portal → appointment is there.
5. (Bonus) reminder template fires.

**Demo uses synthetic/seeded patient data only** — sidesteps health-data
compliance for the demo itself.

---

## 8. Next steps (ordered)

> The detailed, ticket-by-ticket execution plan from here to MVP lives in
> **`clinic-saas-mvp-roadmap.md`**. This checklist is the high-level status
> summary; the roadmap is the source of truth for ordering and acceptance
> criteria.

Meta onboarding runs in **parallel** from day 0 (long lead time).

- [ ] **Day 0 — Meta WhatsApp onboarding:** business account, phone number, app,
      access token; submit the **reminder template** for approval (approval is
      slow and can be rejected).
- [ ] **Decide target country** (gates compliance + whether WhatsApp
      prescriptions are even legal — for the real product, not the demo).
- [x] **Scaffold the new project** (Next.js + Supabase).
- [x] **Initial migration:** full schema, `btree_gist`, exclusion constraint.
- [x] **Seed script:** one clinic, 2 doctors + availability rules, services.
- [x] **Slot generation** function (timezone handling via `date-fns-tz`).
- [x] **Booking transaction** (atomic insert, conflict recovery, idempotency).
- [x] **WhatsApp conversation flow** wired to slot gen + booking (via `wacrm`)
      — implemented as the numbered-text variant (see §2 note).
- [x] **Migrations for `wa_sessions` and `clinic_wacrm_accounts`** — present in
      migration `006` (`clinic_wacrm_accounts` + `wa_sessions`, RLS enabled,
      service-role only). *(Corrected: an earlier draft of this list claimed
      these were unwritten and blocked runtime — they exist.)*
- [x] **Reconcile orphaned stateless-flow files** — done (roadmap E1-T1):
      `flow.ts`, `resolve-by-number.ts`, `slot-id.ts`, and the dead
      interactive-list builders were removed; the live `matchesBookingKeyword`
      moved to `keywords.ts` and the `DoctorOption`/`DayOption` types to
      `types.ts`.
- [~] **Staff portal:** auth + upcoming-appointments screen + RLS policies
      (partially implemented: login/logout/dashboard + status actions + proxy
      present; gaps: doctor-name display, availability UI, onboarding —
      roadmap E5/E6).
- [ ] **Reminder cron** + template send (roadmap E3).
- [ ] **Deploy** to stable URL; end-to-end rehearsal on real WhatsApp
      (roadmap E7).

---

## 9. Future scope (build later — deferred)

Deliberately **out** of the MVP demo:

- **Prescriptions** (e-prescription — heavily regulated; check legality per
  country; may require registered practitioner, digital signature, approved
  channel).
- **Billing / invoices** over WhatsApp; **payments** (use a provider —
  Stripe/Razorpay; never handle card data → PCI).
- **Clinic onboarding portal** (self-serve clinic + staff enrolment, replacing
  the seed script).
- **Nurse role** workflows and deeper patient records.
- **Booking Pattern B/C** (pick service → any doctor). `doctor_services` is
  already in the schema so this is additive, not a rewrite.
- **Direct Meta Cloud API** transport (replacing the `wacrm` dependency) if the
  CRM layer becomes a constraint.
- **Cancellations / reschedules / no-show / waitlist** flows.
- **Per-service duration override** (if some services need longer than the
  doctor's default slot).
- **Global patient records** across clinics (only if a real need emerges;
  raises consent/privacy questions).
- **Patient reminders / follow-up engine** (see §9.1 below).

### 9.1 Patient reminders / follow-up engine (future scope)

Proactive WhatsApp nudges beyond the appointment reminder:

- **Next-visit reminder** — upcoming appointment (overlaps the MVP appointment
  reminder; reuse it).
- **Medication adherence** — recurring nudges ("Have you taken your medicine?"),
  possibly multiple times/day for the course duration (e.g. daily, 3x/day).
- **Lab-test follow-up** — "Have you taken the test?" and "Are your results
  ready?" (notify readiness — do **not** send result values, see below).

**Hard constraints:**
- Every message is **proactive → outside the 24h window → needs a pre-approved
  Meta template**, and each send costs money. Medication 3x/day × N patients ×
  course length multiplies cost and annoyance — price and rate-limit before
  building. Template catalog: `next_visit_reminder`, `medication_reminder`,
  `lab_test_reminder`, `lab_results_ready`.
- **Compliance (sensitive):** these are clinical communications about a specific
  patient. Likely need explicit **consent** to receive clinical messages on
  WhatsApp (HIPAA/GDPR/DPDP + Meta health-data terms). **Never send actual lab
  result values over WhatsApp** — send "results are ready, contact the clinic"
  only. Requires a consent model + jurisdiction check before shipping.

**Technical shape (reuses the appointment reminder cron + template-send layer):**
```
patient_reminders
  id, clinic_id, patient_id,
  kind ('next_visit'|'medication'|'lab_test'|'lab_results'),
  template_name,               -- approved Meta template
  schedule,                    -- one-off datetime OR recurrence (e.g. daily 3x)
  starts_at, ends_at,          -- e.g. medication course duration
  status, next_run_at, created_at
```
- **Recurrence engine** expands "3x daily for 7 days" into concrete send times
  (timezone-aware; stops at course end).
- **Cron scanner** finds due reminders, sends template, computes `next_run_at`
  (same pattern as the appointment reminder cron / wacrm's cron).
- **Optional reply loop:** interactive template ("Yes/No: taken?") → store the
  answer → turns a one-way nudge into an adherence *tracker*. More valuable, more
  work — decide if needed.

**Sequencing:** build after the booking MVP; it reuses the appointment
reminder's cron + template-send foundation, so booking reminders come first.

---

## 10. Standing risks to manage

1. **Meta onboarding + template approval lead time** — start day 0. Booking
   confirmation is a session message (no template needed); only reminders need an
   approved template, so the core booking demo survives approval delays.
2. **Compliance** (HIPAA / GDPR / DPDP + e-prescription rules) — demo on
   synthetic data avoids it; real patient data does not. Decide target country
   early. *(Not legal advice — verify per jurisdiction.)*
3. **Timezone/DST correctness** — use a real tz library; a wrong-time booking in
   a demo is avoidable and embarrassing.
4. **WhatsApp 24-hour messaging window** — free-form only within 24h of the
   patient's last message; everything proactive (reminders, prescription-ready,
   bills) needs pre-approved templates. Plan the template catalog early.
