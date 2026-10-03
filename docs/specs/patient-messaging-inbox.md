# Feature Spec — Post-Visit Patient Messaging Inbox

> Per-feature spec for DoctorDesk. Source: a doctor's request — after a visit,
> patients message the clinic's WhatsApp with doubts; today those messages get
> lost or messy. Captures every non-booking inbound message into a per-patient
> thread, surfaces it in the staff dashboard, lets staff escalate to the doctor,
> and lets staff/doctor reply.
>
> **Status:** ◑ in progress (building now)
> **Backlog row:** promotes a new §1 "Patient messaging" group (and PRD §4).
> **Companion:** `product-requirements.md` (SoT), `clinic-saas-architecture.md`.

---

## 1. Context & goal

A patient books → visits → is treated. Later (at home, before the next visit)
they have a doubt and message the clinic's WhatsApp number. Today any inbound
text drives the numbered **booking** state machine; a message that isn't a
booking keyword falls through to a generic fallback nudge and is **not captured**.
The doctor wants these doubts captured, visible, and answerable.

**Goal:** every inbound patient message that is **not** part of an active
booking/cancel/reschedule flow is stored as a message in a per-patient thread,
shown in the staff dashboard inbox, flaggable/escalatable to the doctor, and
repliable by staff (and doctor) — within WhatsApp's messaging rules.

**Non-goals (v1):**
- **No automated clinical advice / bot answers.** This is a **human-relay inbox**:
  a human reads and replies. No AI/auto-reply to clinical questions.
- No new patient-facing app — replies go out over the same WhatsApp thread.
- Not a full EMR; the "record-like log" is a message/activity timeline, not
  clinical charting.

---

## 2. Compliance gate

> This is **clinical communication** with patients over WhatsApp — a higher bar
> than booking. Fill before wiring proactive/templated replies.

- **Jurisdiction(s):** India first (DPDP + Meta health-data terms).
- **Consent:** patient should be told their messages are logged and may be seen
  by clinic staff/doctor. Capture a lightweight consent/notice (v1: a one-time
  auto-notice on first inbound message; full consent model is the broader R7/
  COMP-2 work and remains the launch gate for proactive clinical messaging).
- **Hard constraints:**
  - **Never auto-answer clinical questions** — human relay only.
  - Replies **within** the patient's 24h session window are free-form (free).
    Replies **outside** 24h require a pre-approved template (see §4.4) — the UI
    must make this distinction visible so staff don't try to send free text that
    silently fails.
  - PII-safe: thread content is patient data; service-role queries scope by
    `(clinic_id, patient_id)`; RLS on the portal path.
- **Related risk:** R7 (compliance/consent), R2 (template language), R10 (tenancy).

---

## 3. Requirements

- **R1 — Capture.** An inbound message with **no active booking/cancel/reschedule
  session** and **no booking-intent keyword** is stored as a `patient_message`
  (direction `inbound`) under the patient's thread, instead of only sending the
  fallback nudge. **Acceptance:** sending a free-text doubt creates exactly one
  inbound `patient_message` row linked to the right `(clinic_id, patient_id)`.
- **R2 — Don't break booking.** Booking / cancel / reschedule keywords and any
  in-progress `wa_session` still drive their flows unchanged. **Acceptance:** the
  existing booking/cancel/reschedule tests still pass; "appointment" still books.
- **R3 — Auto-acknowledge.** On capturing an inbound message, the patient gets an
  immediate in-window ack ("Thanks — the clinic has received your message and will
  reply soon."), so they know it landed. **Acceptance:** capture produces one ack
  send; it is a free-form in-window message (patient just messaged → window open).
- **R4 — Staff inbox.** A dashboard view lists patient threads with unread/open
  messages for the staff's clinic, newest first, with patient name + last message
  preview + unread count. **Acceptance:** a captured message appears in the inbox,
  RLS-scoped to the clinic; opening a thread shows the full message history.
- **R5 — Reply (staff).** Staff can reply from the thread. If the patient's 24h
  window is open → free-form send; if closed → the UI blocks free text and offers
  an approved template (or marks "window closed — patient must message again").
  The reply is stored as a `patient_message` (direction `outbound`).
  **Acceptance:** a staff reply within window sends + stores; outside window the
  UI does not silently attempt a free-form send.
- **R6 — Escalate to doctor.** A thread/message can be flagged `escalated` to the
  treating doctor; the dashboard surfaces escalated threads distinctly.
  **Acceptance:** flagging sets state visible in the inbox; (doctor-notification
  channel may be in-portal only for v1 — see §4.3).
- **R7 — Thread = patient timeline.** The thread view shows messages interleaved
  with the patient's appointment history (booked/visited/cancelled) so a doubt has
  context. **Acceptance:** opening a patient thread shows both their messages and
  their appointments in time order.
- **R8 — Tenancy.** No cross-clinic leakage on the service-role WhatsApp path or
  the portal path. **Acceptance:** a cross-clinic read returns nothing; test asserts it.

---

## 4. Design

### 4.1 Fit with existing architecture
The capture hook is the **fallback branch** of `handleTextMessage`
(`src/lib/whatsapp/text-flow.ts`): today, a no-session non-keyword message returns
`buildFallback`. Change it to **persist the message + send an ack** instead (R1,
R3). Reuse `resolve-by-account` (clinic), the cached `wa_sessions.waPhone` (patient
phone), the `patients` upsert pattern from booking, `send.ts` (reply), and
`notify.ts`/`sendTemplate` (out-of-window). The dashboard inbox is a new
`(portal)/inbox` route alongside the existing dashboard, using the same
`requireStaff()` gate and RLS pattern.

### 4.2 Data model (migration 011)
```
patient_messages
  id uuid pk, clinic_id uuid not null, patient_id uuid not null,
  direction text check (direction in ('inbound','outbound')),
  body text not null,
  wa_delivery_id text,              -- inbound: wacrm delivery id (nullable for outbound)
  sent_by uuid null,                -- outbound: staff user_id (null for inbound/system)
  created_at timestamptz default now()
  index (clinic_id, patient_id, created_at)

patient_threads                     -- one open thread per patient (lightweight)
  id uuid pk, clinic_id uuid not null, patient_id uuid unique-per-clinic,
  status text check (status in ('open','escalated','closed')) default 'open',
  escalated_to_doctor_id uuid null,
  last_message_at timestamptz, unread_count int default 0,
  created_at timestamptz
  unique (clinic_id, patient_id)
```
- **RLS:** both tables clinic-scoped via `is_clinic_member()` (migration 003
  pattern); the WhatsApp service-role path writes with explicit `clinic_id` +
  `patient_id` scoping.
- Reuse the existing `patients` table; a message/thread always links to a patient
  row (upsert by `(clinic_id, wa_phone)` as booking does).

### 4.3 Flow / UI
- **Inbound capture:** `text-flow.ts` fallback → upsert patient → insert inbound
  `patient_message` → upsert `patient_threads` (bump `last_message_at`,
  `unread_count`, status `open`) → return the ack message (R3).
- **Dashboard inbox** (`(portal)/inbox`): list threads (open/escalated first,
  newest), unread badges; thread detail shows messages + the patient's
  appointments interleaved (R7); reply box; "Escalate to doctor" action (R6).
- **Doctor access (v1):** doctor sees escalated threads in the same portal
  (they're a `clinic_member`); a dedicated doctor push/notification is deferred.
- **Thread resolution — DEFERRED past v1 (decided during build).** Escalation is
  one-way: the only status write is `open` → `escalated`, and nothing sets
  `closed`. There is no Resolve or Close action, so an escalated thread stays at
  the top of the queue until the patient messages again. The `closed` value stays
  in the CHECK constraint and in `STATUS_RANK` (ranked last) so adding the actions
  later needs no migration, but the inbox renders **no Closed badge** — a badge
  for a state no code path can produce would be a lie to staff. Follow-up 1A in
  §7.

### 4.4 Proactive / out-of-window replies
- In-window (patient messaged within 24h) → free-form `send.ts`. **This is the
  common case** since a reply usually follows soon.
- Out-of-window → an approved template, e.g. `doctordesk_clinic_reply` (must be
  **registered + approved in Meta**; language `en_US`; see R2). v1 may ship with
  the in-window path only and clearly disable free text when the window is closed,
  surfacing "ask the patient to message again" — rather than shipping an
  unapproved template. Decide at implementation: in-window-only vs. add the
  template.

### 4.5 Open questions (resolved during build)
- **24h-window tracking → derived, not a field.** `isWindowOpen` reads the newest
  `direction='inbound'` row for the patient; no dedicated column. Known blind
  spot kept on purpose: an inbound that drove the booking state machine is never
  stored as a `patient_message`, so the window reads closed while Meta's session
  is open. It fails CLOSED (staff are never invited into a send Meta would
  reject) and the notice is worded to claim only what is on record — "No recent
  patient message on record — ask the patient to message again" — instead of
  asserting the WhatsApp window is shut. Follow-up 2A in §7.
- **One thread per patient, re-opened by new activity.** `UNIQUE (clinic_id,
  patient_id)`; a follow-up message bumps the existing thread and never
  de-escalates it. Since nothing sets `closed` in v1 (see §4.3), "re-open after
  closed" does not arise yet.

---

## 5. Tasks

### T1 — Migration 011 + types
- **Scope:** `supabase/migrations/011_patient_messaging.sql` (two tables above,
  RLS, indexes); TypeScript types.
- **Acceptance:** migration applies clean from zero (idempotent); RLS mirrors 003.
- **Deps:** none.

### T2 — Inbound capture in the flow
- **Scope:** change `text-flow.ts` fallback branch to persist inbound message +
  thread + send ack; new `src/lib/whatsapp/messaging.ts` for the DB writes.
- **Acceptance:** R1 + R3 tests pass; R2 (booking/cancel/reschedule unchanged) —
  existing suite stays green.
- **Deps:** T1.

### T3 — Staff inbox UI (list + thread detail + reply)
- **Scope:** `(portal)/inbox` route; thread list; thread detail with interleaved
  appointments; reply (in-window send + out-of-window guard); `requireStaff()`.
- **Acceptance:** R4, R5, R7 — captured message shows in inbox; reply sends +
  stores; window-closed disables free text.
- **Deps:** T2.

### T4 — Escalate to doctor
- **Scope:** escalate action on a thread; inbox surfaces escalated distinctly.
- **Acceptance:** R6.
- **Deps:** T3.

### T5 — Tenancy + tests
- **Scope:** cross-clinic isolation test on the service-role writes and portal
  reads; integration test for capture→inbox→reply.
- **Acceptance:** R8; full `npm run build` + tests green.
- **Deps:** T2–T4.

---

## 6. Verification
- **Build/tests:** `npm run build`; `npx vitest run` (existing + new).
- **Flow test:** feed a free-text inbound → assert inbound row + ack; feed
  "appointment" → assert booking still starts (no capture).
- **Tenancy:** assert a clinic can't read another clinic's threads/messages.

---

## 7. Rollout & done
- **Migration:** 011 applied via `supabase db push` (deploy guide App. C).
- **Release gate (blocking):** before the feature is enabled in production, 011
  must be applied AND `src/lib/messaging/tenancy.db.test.ts` must pass against a
  throwaway Supabase stack with it applied (`supabase start` + `supabase db push`
  + `TEST_DATABASE_URL`/`TEST_DATABASE_SERVICE_KEY`; see README). `npm test`
  skips those tests, so until this runs the RPC's transaction boundary, the
  thread upsert, the never-de-escalate rule and both RLS policies are only
  covered by a TypeScript stand-in, never by the database.
- **Env:** if the out-of-window template ships, add `CLINIC_REPLY_TEMPLATE_NAME`
  (default `doctordesk_clinic_reply`) + register/approve it in Meta.
- **Docs:** add the feature to PRD §4 (new "Patient messaging" group) + the board;
  Done-log line.

### Deferred follow-ups (out of v1, do not lose)
- **1A — Thread resolution.** Add a Resolve action (status back to `open`,
  clearing `escalated_to_doctor_id`) and/or a Close action (status `closed`), and
  restore the Closed badge in the inbox list when one of them can produce it.
  Without this, escalated threads accumulate at the top of the queue and the
  priority ordering stops discriminating as volume grows. No migration needed —
  `closed` is already a legal status. See §4.3.
- **2B/2A — Window tracking.** Record a timestamp for every inbound delivery (a
  `last_inbound_at` column on `patients`/`patient_threads`, or the window source
  on `wa_sessions`) and read that in `isWindowOpen`, so staff can reply while a
  booking-flow session is live instead of being told there is nothing on record.
  Ships with the notice reverting to a true "window closed" wording. See §4.5.
- **Follow-up on 004.** `book_appointment` is SECURITY DEFINER with no EXECUTE
  restriction, the same exposure 011 fixes for `capture_patient_message`: anon
  and authenticated can call it over PostgREST with an arbitrary `clinic_id`.
  Needs its own migration (`REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`
  + `GRANT ... TO service_role`) and a check of any other SECURITY DEFINER
  function in 001–010.
