# DoctorDesk — Product Requirements Document (PRD)

# DoctorDesk — Product Requirements Document (PRD) · Single Source of Truth

> **This is the authoritative, consolidated reference for DoctorDesk** — a
> WhatsApp-first, multi-tenant clinic appointment platform. It absorbs and
> supersedes the scattered detail across the older planning docs: product vision,
> personas, the full feature catalog, data model, booking/slot/reminder behavior,
> the WhatsApp integration, deployment & environment, repository structure,
> non-functional requirements, compliance, competitive landscape, business model,
> risk register, and the execution board — all in one place.
>
> **Precedence:** where this document and any other doc disagree, **this document
> wins**. The companion docs are now **subordinate deep-dives**, kept for detail
> but not the source of truth:
> - `clinic-saas-plan.md` — ADR: the *rationale* behind key architecture decisions
> - `clinic-saas-architecture.md` — the Mermaid diagrams (system/sequence/ER)
> - `production-backlog.md` / `production-board.md` — live tracker, risks, Jira-style board
> - `full-setup-guide.md` — the single deploy/setup guide (phases + appendices A–E)
> - `docs/specs/` — per-feature specs when a candidate graduates to build
> - `docs/archive/` — superseded docs (mvp-roadmap, folder-structure), history only
>
> **Status key:** ✅ shipped · ◑ partial / has a gap · ⬜ planned, not started ·
> ⏭️ deferred (Phase 2+) · 🔭 candidate (idea, not committed)
> **Gate:** 🚦 = blocks production launch with real patients.
>
> **Contents:** 1 Vision · 2 Personas · 3 Scope · 4 Feature catalog · 5 System
> overview · 6 Data model (detailed) · 7 Core behaviors (booking/slots/reminders)
> · 8 WhatsApp integration & identity · 9 Deployment & environment · 10 Repository
> structure · 11 Non-functional requirements · 12 Compliance · 13 Out of scope ·
> 14 Competitive landscape · 15 Business model & unit economics · 16 Risk register
> · 17 Execution board · 18 Document map.
>
> Last updated: 2026-10-02 — promoted to single source of truth; absorbed data
> model, core behaviors, WhatsApp/identity, deployment/env, repo structure, risk
> register, and execution board from the companion docs.

---

## 1. Vision & positioning

**Vision.** Make booking and managing a clinic visit as easy as sending a text —
for the patient, with no app and no login, and genuinely reliable for the clinic.

**Positioning.** Competitors (e.g. Docterz) digitize the *clinic* — broad
hospital-management suites with EMR, prescriptions, labs, billing, and patient
apps. DoctorDesk digitizes the *patient conversation*: booking happens where the
patient already is (WhatsApp), with a slot that is genuinely locked the instant
they confirm it.

**The wedge.** Own the single most frequent and most abandoned clinic
interaction — booking and reminders — with less friction (no app install, no
account) and more correctness (database-enforced no-double-booking,
timezone/DST-safe slots) than anyone. Clinical depth is the roadmap; the wedge is
the beachhead.

**Where we win today**
- Zero patient friction — the patient texts the clinic's number; nothing to install.
- Booking you can trust — double-booking prevented by a Postgres exclusion
  constraint, not hopeful app logic. Slots are timezone/DST-correct.
- WhatsApp-native — booking, reminders, cancel, reschedule, and staff-change
  notifications all flow through the one channel the patient already uses.

> Where competitors lead (clinical depth, self-serve maturity) and how we stay
> differentiated: see §14 Competitive landscape.

---

## 2. Personas & roles

| Persona | Channel | What they do |
|---|---|---|
| **Patient** | WhatsApp only (no login) | Book, confirm, cancel, reschedule; receive reminders. Scoped per-clinic by `(clinic_id, wa_phone)`. |
| **Receptionist** | Staff web portal | Manage the day's appointments, statuses, availability. |
| **Doctor** | Staff web portal | See their schedule; `doctor_profiles` sets slot length & specialty. |
| **Nurse** | Staff web portal | (Role exists in schema; deeper workflows deferred.) |
| **Clinic admin** | Staff web portal | Clinic config, staff, availability, services. |
| **Platform operator** | Infra / scheduler | Runs cron, monitors health, handles onboarding (seed today; self-serve planned). |

---

## 3. Scope summary

| Phase | Theme | State |
|---|---|---|
| **MVP (Phase 1)** | WhatsApp booking + reminders + self-service + staff portal | ✅ largely shipped (E1–E6); E7 hardening in progress |
| **Production readiness** | Compliance, observability, reliability, onboarding | ◑ several 🚦 gates open |
| **Phase 2 — Revenue** | Billing, payments, invoices | ⏭️ planned |
| **Phase 2 — Clinical** | EMR, e-Rx, follow-up/adherence, deeper records | ⏭️ planned (compliance-gated) |
| **Candidates (Docterz-inspired)** | Labs, telemedicine, accounting, inventory, uploads, vaccines, analytics | 🔭 candidate |

Authoritative ordering lives in `production-backlog.md` §3 (Now/Next/Later) and
`production-board.md` (§17 summarizes it). This PRD describes *what each feature
is*; those docs decide *when*.

---

## 4. Feature catalog

Each feature: a one-line description, its state, and acceptance intent. Grouped by
domain. 🚦 marks production-launch gates.

### 4.1 Booking core

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F1.1 | Book over WhatsApp | ✅ | Numbered-text flow: doctor → day → time → confirm. Patient books a real, reserved appointment by text. |
| F1.2 | Timezone-correct slot generation | ✅ | Per-doctor slot length; slots computed in clinic tz, stored UTC; DST-safe (tested). |
| F1.3 | No double-booking | ✅ | `btree_gist` exclusion constraint; the DB decides the winner atomically under contention. |
| F1.4 | Confirmation message | ◑ | Sent after commit. Free-form works; **approved template not wired** + `en_US` language fix pending (risk R2). |
| F1.5 | Booking Pattern B/C (service-first → any doctor) | ⏭️ | `doctor_services` already exists → additive. Pick a service, system picks an available doctor. |
| F1.6 | Per-service duration override | ⏭️ | Some services need longer than the doctor's default slot. |

### 4.2 Patient self-service (WhatsApp)

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F2.1 | Cancel over WhatsApp | ✅ | Keyword → list patient's upcoming appointments → cancel chosen one; slot freed; confirmation sent. Only own, cancellable appointments. |
| F2.2 | Reschedule over WhatsApp | ✅ | Book-new-then-cancel-old; original released only when the new booking commits (no zero/double window). |
| F2.3 | Notify on patient-initiated change | ◑ | Staff-side notify is wired; patient-initiated path notifies no one yet. |
| F2.4 | Handle >10 upcoming appointments | ⬜ | Menu caps at 10 rows; add paging / parts-of-day. |
| F2.5 | Richer no-show handling | ⬜ | Status exists; add workflow/automation around it. |
| F2.6 | Waitlist (notify on cancellation opening) | ⏭️ | When a slot frees, notify the next waiting patient. |

### 4.3 Reminders & proactive messaging

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F3.1 | Appointment reminder cron + template | ✅ | Secret-guarded cron finds due appointments per clinic tz, sends approved template, stamps `reminder_sent_at`; idempotent. |
| F3.2 | Reminder claim-lock idempotency | ◑ | Verify the cron uses a claim-row lock (not just `reminder_sent_at`) so parallel runs can't double-send. |
| F3.3 | Per-clinic template selection/config | ⬜ | Template names are hardcoded/env today; make them multi-tenant selectable. |
| F3.4 | Follow-up / adherence engine (medication / lab / results) | ⏭️🚦 | `patient_reminders` table + recurrence + template catalog (plan §9.1). Consent-gated. **Never send lab-result values** — "results ready, contact clinic" only. |

### 4.4 Staff portal

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F4.1 | Auth (login/logout) | ✅ | Supabase email/password; `requireStaff()` gate. |
| F4.2 | Dashboard + status actions | ✅ | One-day view; booked→confirmed/cancelled/no_show, confirmed→completed/cancelled/no_show. |
| F4.3 | Doctor names (RLS-safe) | ✅ | `SECURITY DEFINER` view/RPC exposes member names within the caller's clinic only. |
| F4.4 | Multi-day / week view | ✅ | Next/prev day + week overview with per-day counts. |
| F4.5 | View + edit availability | ✅ | Weekly `availability_rules` + date `availability_exceptions`; changes immediately alter WhatsApp slot offers. |
| F4.6 | Services management (portal) | ⬜ | `services` + `doctor_services` exist; add UI to manage them. |
| F4.7 | Staff invite / role management UI | ⬜ | Invite/enrol staff + assign roles without SQL. |
| F4.8 | Clinic switcher (multi-clinic staff) | ⏭️ | `requireStaff()` picks first active membership; add switcher when a real multi-clinic user exists. |

### 4.5 Tenant / clinic lifecycle

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F5.1 | Multi-tenant data model + isolation | ✅ | Every clinic-scoped table carries `clinic_id`; RLS for portal, service-role + explicit tenancy checks for WhatsApp path. |
| F5.2 | Demo clinic via seed | ✅ | Idempotent `seed.ts`: one clinic, 2 doctors, availability, demo appointments. |
| F5.3 | Self-serve clinic onboarding | ⬜🚦 | Full clinic + staff enrolment replacing the seed script. Biggest functional gap for "sell to everyone". |

### 4.6 Channel integration (WhatsApp via wacrm)

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F6.1 | Inbound webhook (verified, deduped) | ✅ | HMAC verify (both hops), dedupe on delivery id, resolve tenant by wacrm `account_id`. |
| F6.2 | Tenant + patient identity resolution | ✅ | Resolve clinic + patient `(clinic_id, wa_phone)`; dispatch to flow; real send back via wacrm. |
| F6.3 | Direct Meta Cloud API fallback transport | ⬜ | Documented fallback if wacrm becomes a constraint; reduces third-party dependency risk (R8). |

> **Known issue (not a feature):** inbound returns 401 in production (secret/URL
> mismatch) — tracked as risk **R1** / ticket **LAUNCH-1** (§16, §17), not listed
> as a capability here.

### 4.7 Phase 2 — Revenue

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F7.1 | Billing plans + subscription for clinics | ⬜ | How DoctorDesk earns (per-clinic/seat). Needed to charge. |
| F7.2 | Payments (patient-facing, provider-based) | ⏭️🚦 | Stripe/Razorpay hosted checkout. **Never touch card data → PCI** (R11). |
| F7.3 | Invoices / receipts (optionally over WhatsApp) | ⏭️ | Depends on payments. |
| F7.4 | Cost monitoring for template sends | ⬜ | Each proactive send costs money; cap/monitor (R9). |

### 4.8 Phase 2 — Clinical expansion

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F8.1 | E-prescriptions | ⏭️🚦 | Registered practitioner + digital signature + approved channel; **legality varies by country** (R12). |
| F8.2 | Deeper patient records + nurse workflows | ⏭️ | Roles exist in schema; clinical workflows don't. |
| F8.3 | Global cross-clinic patient records | ⏭️🚦 | Consent/privacy heavy; only if a real need emerges. |

### 4.9 Candidate features (competitor-inspired)

Candidates define the horizontal-expansion surface *if/when the wedge proves out*.
Not committed. Promote via `docs/specs/` when one graduates. See §10 Competitive
landscape for where each originates. _Competitor feature sets summarised from
public listings ([Docterz](https://www.docterz.in/),
[OneGlance](https://oneglancehealth.in/)); not copied verbatim._

| # | Feature | State | Description & acceptance intent |
|---|---|---|---|
| F9.1 | Lab integration + referral/commission tracking | 🔭 | (Docterz) Track lab referrals and the clinic's commission. Revenue lever + stickiness; overlaps F3.4 (results-ready). |
| F9.2 | Telemedicine / tele + video consult | 🔭 | (Docterz/OneGlance) Video/tele consult + queue. Evaluate 3rd-party video (Daily/Twilio) vs. native. |
| F9.3 | Clinic accounting / day-book | 🔭 | (Docterz) Per-clinic income/expense ledger + daily collection summary. Lighter than full billing. |
| F9.4 | Inventory / stock management | 🔭 | (OneGlance — **a standout strength there**) Consumables/medicine stock with reorder alerts. Hospital-scale; strong for larger clinics, lower priority for the solo wedge. |
| F9.5 | Multi-file medical record uploads | 🔭🚦 | (Docterz) Attach reports/images to a patient record. **Health data → compliance-gated** (R7). |
| F9.6 | Vaccine / immunization scheduler | 🔭 | (Docterz) Due-date schedule + reminders per child. A sharp **vertical wedge** for pediatrics; reuses the reminder engine. |
| F9.7 | Analytics / practice insights | 🔭 | (Docterz) Booking/no-show/revenue dashboards first; avoid clinical inference until volume + compliance justify it. |
| F9.8 | Patient portal / companion app | 🔭 | (Docterz/OneGlance) **Deliberate non-goal** — contradicts the WhatsApp-first thesis. Logged for completeness. |
| F9.9 | AI prescription assist (VoiceRx-style) | ⏭️🚦 | (Docterz) Voice/AI-assisted Rx capture. Enhances F8.1; inherits its regulatory gate (R12). |
| F9.10 | Auto-dose / auto-frequency Rx helpers | ⏭️🚦 | (Docterz) Auto-fill dose/frequency on prescriptions. Part of the e-Rx workstream; same gate (R12). |
| F9.11 | ABDM compliance (ABHA ID + consent) | 🔭🚦 | (OneGlance — **a headline feature there**) India's Ayushman Bharat Digital Mission: capture ABHA health ID, consent framework, record interoperability. May shift from nice-to-have to **procurement-required** for India/government-adjacent clinics. Lightweight "ABDM-aware" posture (ABHA capture at booking) fits the WhatsApp flow without a full EMR. |
| F9.12 | Multilingual flows + prescriptions | 🔭 | (OneGlance) India is multilingual; multilingual WhatsApp booking/reminder flows are a real edge and **cheaper for us than for app-based competitors** (just template translations). |
| F9.13 | UX polish parity (reception/booking flow) | 🔭 | (Docterz — **its standout strength is a smooth, intuitive UI** with fast staff onboarding). Keep the staff portal and WhatsApp flow best-in-class on usability; treat UX as a competitive feature, not an afterthought. |

---

## 5. System overview (reference)

Two Next.js apps + Supabase. **Patients** use WhatsApp only; **staff** use the
web portal. **wacrm** is the sole bridge to Meta's WhatsApp Cloud API (swapping to
direct Cloud API — F6.4 — changes only this edge). All data lives in Supabase
Postgres. The detail is in the sections that follow: data model §6, core behaviors
(booking/slots/reminders) §7, WhatsApp integration & identity §8. Mermaid diagrams
(system/sequence/ER/tenancy) live in `clinic-saas-architecture.md`.

**Trust boundaries.** RLS protects the **portal path** (policy checks an active
`clinic_members` row for the `clinic_id`). The **WhatsApp path** has no logged-in
user, so it runs under the **service role (RLS-bypassing)** and the application
code re-verifies tenancy itself — every service-role query scopes by `clinic_id` +
`wa_phone` (the identity chain is detailed in §8).

---

## 6. Data model (detailed)

Postgres/Supabase. Every clinic-scoped table carries `clinic_id`; RLS keys off it.
Times: **UTC** in `appointments`, **local clock** in availability rules, clinic
timezone bridges the two.

```
clinics
  id, name, slug (unique), timezone (not null), status, created_at

clinic_whatsapp_numbers            -- tenant router: phone_number_id → clinic
  id, clinic_id, phone_number_id (unique), display_number, status, created_at

clinic_wacrm_accounts              -- LIVE tenant router: wacrm account_id → clinic
  id, clinic_id, wacrm_account_id (unique), status, created_at

users                              -- one row per human login (= auth.users)
  id, full_name, email, created_at

clinic_members                     -- membership + role, per clinic
  id, clinic_id, user_id, role ('doctor'|'nurse'|'receptionist'|'admin'),
  status ('active'|'invited'|'disabled'), created_at ; unique (clinic_id, user_id)

doctor_profiles                    -- extends a doctor membership
  id, clinic_member_id (unique), clinic_id, specialty,
  registration_number, slot_duration_minutes (default 15)

patients                           -- records, NOT logins
  id, clinic_id, wa_phone (E.164), full_name, date_of_birth, notes, created_at
  unique (clinic_id, wa_phone)

services               id, clinic_id, name, price_cents, active
doctor_services        id, clinic_id, doctor_id, service_id ; unique (doctor_id, service_id)

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
  service_id (nullable), created_via ('whatsapp'|'portal'), reminder_sent_at, created_at

processed_wa_events                -- inbound dedupe ledger (idempotency)
  delivery_id (unique), ...

wa_sessions                        -- WhatsApp conversation state (numbered-text flow)
  conversation_id, clinic_id, wa_phone, step
  ('idle'|'awaiting_doctor'|'awaiting_day'|'awaiting_time'|'awaiting_cancel'|'awaiting_reschedule'),
  data (jsonb: options/doctorId/dateYmd/rescheduleId), expires_at (30-min)
```

**Critical constraint — no double-booking (the authoritative guard):**

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status IN ('booked','confirmed'));
```

**Migrations (apply in order; idempotent):**

| # | File | Adds |
|---|------|------|
| 001 | initial_schema | core tables + `set_updated_at()` |
| 002 | btree_gist_exclusion | `btree_gist` + no-overlap constraint |
| 003 | rls_policies | `is_clinic_member()` + RLS |
| 004 | book_appointment_fn | `book_appointment` RPC |
| 005 | processed_wa_events | inbound dedupe ledger |
| 006 | wacrm_sessions | `clinic_wacrm_accounts` + `wa_sessions` |
| 007 | appointment_reminders | `appointments.reminder_sent_at` + due-scan index |
| 008 | wa_session_cancel_step | widen `wa_sessions.step` CHECK (`awaiting_cancel`) |
| 009 | wa_session_reschedule_step | widen CHECK (`awaiting_reschedule`) |
| 010 | clinic_doctor_names_fn | `clinic_doctor_names` RPC (SECURITY DEFINER, member-gated) |

> Next migration to add is **011**. Full ERD in `clinic-saas-architecture.md` §4.

---

## 7. Core behaviors (booking / slots / reminders)

### 7.1 Slot generation (read path)
Given `doctorId`, `date`, `clinicTimezone`, `slotMinutes` → ordered bookable slots:
1. Compute weekday **in the clinic timezone**.
2. Gather recurring `availability_rules` for doctor + weekday → local windows.
3. Apply `availability_exceptions` (`off` subtracts, `extra` adds).
4. Bind local windows to the date in clinic tz, convert to **UTC** (DST-safe via
   `date-fns-tz` — never fixed offsets).
5. Chunk into `slotMinutes` intervals (slot must fully fit).
6. Subtract active appointments (half-open overlap: `a.start < b.end && a.end > b.start`).
7. Drop past slots + anything within minimum lead time.
8. Render labels in clinic-local time. The slot list is **advisory**; the DB
   constraint is authoritative.

### 7.2 Booking transaction (write path)
**Principle: the database decides who wins — never check-then-insert.**
```
[dedupe]  seen this wacrm delivery id? → ignore if yes
[resolve] clinic from wacrm account_id → verify doctor ∈ clinic
BEGIN
  upsert patient (clinic_id, wa_phone)
  INSERT appointment status='booked'                 -- atomic reservation
  success                     → COMMIT → send confirmation (session message)
  exclusion_violation(23P01)  → ROLLBACK → regenerate slots → "just taken, pick again"
```
Confirmation sends only after commit (inside the 24h window → free session message).

### 7.3 Reminder cron (proactive)
Secret-guarded pull-based route (`/api/cron/reminders`): scans for appointments
starting within `REMINDER_LEAD_MINUTES` (default 1440) and not yet reminded, in
each clinic's timezone; **claims each row** (idempotency lock) before sending the
approved Meta template; stamps `reminder_sent_at`. Safe to run every ~15 min.
Reminders are **outside the 24h window → require an approved template**.

---

## 8. WhatsApp integration & identity

**Transport.** `wacrm` is the sole bridge to Meta's WhatsApp Cloud API. Two
independent signed webhook hops:

| | Hop 1: Meta → wacrm | Hop 2: wacrm → DoctorDesk |
|---|---|---|
| Endpoint | `…/api/whatsapp/webhook` (wacrm) | `…/api/whatsapp/inbound` (DoctorDesk) |
| Signature | `X-Hub-Signature-256` | `X-Wacrm-Signature: t=…,v1=…` |
| Secret | `META_APP_SECRET` | `WACRM_WEBHOOK_SECRET` |

DoctorDesk verifies the hop-2 HMAC over the **raw** body in constant time, with a
300s replay window; failures log a **named reason** (`hmac_mismatch`,
`timestamp_skew`, `missing_header`, `malformed_header`). Outbound replies go
DoctorDesk → wacrm (`WACRM_API_KEY`) → Meta.

**Identity chain (how a message finds the right clinic):**
```
Meta phone_number_id ─(wacrm maps)→ wacrm account_id ─(clinic_wacrm_accounts)→ clinic_id
                              patient wa_phone ─(patients: clinic_id+wa_phone)→ patient record
```
The seeded `wacrm_account_id` **must equal** the `account_id` wacrm stamps on
webhooks, or every message is silently dropped as `no_clinic`. `(clinic_id,
wa_phone)` is both the patient key and the tenancy guard on the service-role path.

**Flow note.** wacrm forwards **free text only**, so the live flow is a
**numbered-text** state machine (`wa_sessions`), not tapped interactive rows. Each
inbound message produces exactly one outbound reply.

---

## 9. Deployment & environment

**Stack.** Two Next.js apps on Vercel + two Supabase projects (A = wacrm, B =
DoctorDesk). wacrm owns the Meta webhook & sending; DoctorDesk owns booking +
portal. Full step-by-step + from-zero DB bring-up in `full-setup-guide.md`
(phases + Appendix C).

**Environment variables (DoctorDesk):**

| Key | Purpose | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Supabase B (project) | public |
| `SUPABASE_SERVICE_ROLE_KEY` | RLS-bypassing server client (WhatsApp path) | **secret** |
| `WACRM_BASE_URL` | deployed wacrm origin | — |
| `WACRM_API_KEY` | wacrm public-API bearer (`messages:send`, `contacts:read`) | **secret** |
| `WACRM_WEBHOOK_SECRET` | verifies hop-2 webhook; minted by `wacrm-setup.ts register` | **secret** |
| `CRON_SECRET` | protects the reminder cron (Bearer / `x-cron-secret`) | **secret** |
| `REMINDER_TEMPLATE_NAME` | approved template (default `doctordesk_appointment_reminder`); 3 params: clinic, day, time | — |
| `REMINDER_LEAD_MINUTES` | reminder lead (default 1440) | — |
| `CANCELLATION_TEMPLATE_NAME` | staff-cancel notice template (default `doctordesk_appointment_cancelled`) | — |

> **Golden rule:** after changing any Vercel env var, **redeploy** — a running
> deployment keeps the old value. wacrm-side vars (`ENCRYPTION_KEY`,
> `META_APP_SECRET`) live in the wacrm project; see `full-setup-guide.md` §2.

---

## 10. Repository structure (DoctorDesk)

```
src/
├── app/
│   ├── (portal)/ layout + dashboard + availability (+ actions)   # authenticated staff
│   ├── login/ · logout/
│   ├── api/whatsapp/inbound/route.ts    # hop-2 receiver → drives the flow
│   └── api/cron/reminders/route.ts      # secret-guarded reminder cron
│   └── proxy.ts                          # Next 16 session-refresh middleware
├── lib/
│   ├── supabase/ server.ts · client.ts · admin.ts(service-role)
│   ├── clinics/ resolve-by-account.ts(LIVE) · tenancy.ts
│   ├── availability/ slot-generation.ts · timezone.ts
│   ├── booking/ book.ts (RPC) · book.concurrency.test.ts(gated)
│   ├── whatsapp/ text-flow.ts(LIVE state machine) · session.ts · keywords.ts
│   │             query.ts · messages.ts · send.ts · notify.ts · wacrm-client.ts
│   │             · verify-signature.ts · types.ts
│   └── portal/ auth.ts · appointments.ts
├── reminders/            # scheduler + template-send helpers
supabase/migrations/      # 001–010 (see §6)
scripts/ seed.ts · wacrm-setup.ts · build.sh · start.sh · run.sh
```
(Historical annotated tree: `docs/archive/clinic-saas-folder-structure.md`.)

---

## 11. Non-functional requirements

The production-grade qualities. Full tracking + mitigations in
`production-backlog.md` §2 and §5 (risks). Summary of the launch gates:

| Area | Requirement | State | Gate |
|---|---|---|---|
| Security/privacy | Webhook HMAC verify + replay window | ✅ | |
| | RLS isolation + service-role tenancy re-check | ✅ | |
| | Compliance posture (HIPAA/GDPR/DPDP + Meta health terms) | ⬜ | 🚦 (R7) |
| | Patient consent model for clinical messaging | ⬜ | 🚦 |
| | Secret management / rotation | ⬜ | 🚦 (R4) |
| | PII-safe logging + retention policy | ⬜ | 🚦 |
| Reliability | Atomic booking under contention | ✅ | |
| | Migrations run from zero (verified) | ◑ | 🚦 |
| | Backups / DR with a restore drill | ⬜ | 🚦 (R6) |
| | Outbound send retry/backoff | ⬜ | |
| Performance | Fast reply (ack fast, send via `waitUntil`) | ◑ | (R3) |
| Observability | Structured per-delivery logging | ◑ | 🚦 (R5) |
| | Metrics / alerting + error tracking | ⬜ | 🚦 |
| Abuse | Rate limiting / per-conversation throttle | ⬜ | 🚦 |
| | Cost guard on outbound templates | ⬜ | (R9) |
| Operability | Deploy + setup guide | ✅ | |
| | CI (typecheck/lint/test on push) | ⬜ | 🚦 |
| | End-to-end rehearsal on real WhatsApp | ⬜ | 🚦 (needs R1 + templates) |

---

## 12. Compliance & regulatory posture

DoctorDesk handles health-adjacent data and messages patients on WhatsApp, so
compliance is a **release gate**, not an afterthought. Standing constraints:

- **Decide target jurisdiction(s) early** — gates what's legal (clinical
  messaging, e-prescriptions) and which regime applies (HIPAA / GDPR / DPDP).
- **Explicit patient consent** to receive clinical messages on WhatsApp before
  any proactive clinical nudge (F3.4).
- **Never send lab-result values** over WhatsApp — notify readiness only.
- **Never touch card data** — payments use provider hosted checkout only (F7.2).
- **E-prescriptions** are a separate compliance project — confirm legality,
  require practitioner identity + digital signature, approved channel (F8.1).
- Data retention + right-to-erasure; DPAs with processors (Supabase, Meta, wacrm).

> *Not legal advice — verify per jurisdiction before handling real patient data.*

---

## 13. Explicitly out of scope (now)

Carried from the ADR (`clinic-saas-plan.md`) and `production-backlog.md` — do not pull in
without a deliberate decision: a patient-facing portal/app (deliberate non-goal,
F9.8), full hospital EMR, inventory at launch, cross-clinic patient records, and
the richer recurrence/adherence engine before consent + cost modelling.

---

## 14. Competitive landscape

Two India-focused incumbents frame the market. Both are **app-based and
clinically deep**; DoctorDesk's wedge (no patient app, WhatsApp-native booking,
booking-integrity, reminders) stays differentiated against both. _Competitor
details summarised from public listings; not copied verbatim._

| Axis | [Docterz](https://www.docterz.in/) | [OneGlance](https://oneglancehealth.in/) | DoctorDesk (us) |
|---|---|---|---|
| Core identity | Clinic management (doctor-centric) | HIMS + EMR (hospital tilt) | WhatsApp booking engine |
| Patient channel | Mobile apps (Connect) | Mobile app (Pocket) | **WhatsApp, no app** |
| Reminders | SMS / WhatsApp | SMS | **WhatsApp-native** |
| Clinical depth | Deep (Rx, labs, vaccine) | Deep (EMR, voice, multilingual Rx) | Minimal (deferred) |
| Inventory | Yes | **Yes — a standout strength** | ⬜ candidate (F9.4) |
| ABDM compliance | Not emphasized | **Yes — a headline feature** | ⬜ candidate (F9.11) |
| **UX / usability** | **Standout strength — smooth, intuitive, fast staff onboarding** | Functional, enterprise | Must stay best-in-class (F9.13) |
| Pricing | Published (~₹11,800/yr) | Quote-based (enterprise) | TBD — see §15 |
| Sales motion | Mixed / self-serve-ish | Sales-led | Product-led (implied) |

**What each does notably well (our benchmarks to respect):**
- **Docterz — user experience.** Polished, intuitive UI; receptionists are
  productive quickly. We treat UX as a competitive feature (F9.13), not polish
  applied last.
- **OneGlance — functional depth.** Proper inventory/stock management, full
  HIMS/EMR, ABDM readiness, multilingual prescriptions. These are the
  "grow-into-a-real-clinical-SaaS" capabilities (candidates F9.4, F9.11, F9.12).

**What we win on (reinforced by both comparisons):** zero patient friction (no
app), database-enforced booking integrity, and a WhatsApp-native engagement loop
neither competitor leads with.

**Two gaps worth a deliberate decision:**
1. **ABDM (F9.11)** — OneGlance makes it a headline; absence may block
   India/government-adjacent deals as adoption grows. Could also be a
   differentiator if we claim a lightweight "ABDM-aware" posture.
2. **Inventory (F9.4)** — table stakes for larger clinics; skippable for the
   solo/small-clinic wedge until we move upmarket.

---

## 15. Business model & unit economics

> **All figures illustrative — validate against Meta's official India WhatsApp
> rate card and the live Supabase/hosting bill before using in a pitch or
> pricing decision.** Meta changed WhatsApp pricing twice in 18 months (per-message
> from 1 Jul 2025; service-message cap from 1 Oct 2026), so rates drift.

### 15.1 Revenue model (candidate)

Land-and-expand, mirroring the market but adapted to WhatsApp-first:

1. **Core subscription** — per-clinic/per-doctor, billed annually. Market anchor
   (Docterz) ≈ ₹11,800/yr ≈ **₹983/month**. This is the base recurring revenue.
2. **Metered proactive messaging** — base plan includes an allowance of proactive
   (template) messages; overage sold as packs. Turns the main cost risk (R9) into
   a revenue line.
3. **Take-rate layer (expansion)** — lab referral commission (F9.1) and patient
   payments (F7.2) are margin-rich because we facilitate rather than fulfil.
4. **No branded-patient-app upsell** — Docterz's biggest add-on. We skip it by
   design (patient app is a non-goal, F9.8) and replace that revenue with
   message tiers + take-rate.

### 15.2 WhatsApp cost structure (India)

Meta bills **per delivered template message**, by category; **service messages**
(replies inside the patient-initiated 24h window) are free up to **1,000/clinic
phone number/month**, then ₹0.115. Utility templates (reminders/confirmations)
are **₹0.115** each; marketing is ₹0.8631 (**avoid**). Add **18% GST**.

| Message type | When it happens | India rate |
|---|---|---|
| Booking flow (doctor→day→time→confirm) | Patient-initiated, in 24h window → **service** | Free up to 1,000/clinic/mo, then ₹0.115 |
| Appointment reminder | Proactive → **utility template** | ₹0.115 |
| Confirmation | Sent as a session reply in-window (verified in code) → **service** | Free |
| Marketing/promo | Proactive | ₹0.8631 (avoid) |

### 15.3 Messages per patient & per clinic

**Verified against the live flow** (`src/lib/whatsapp/text-flow.ts`): each inbound
message produces exactly **one** outbound reply (every handler returns a single
`OutboundMessage`). Booking journey:

| Step | Outbound | Billing |
|---|---|---|
| "appointment" → doctor menu | 1 | service (free, in-window) |
| pick doctor → day menu | 1 | service (free) |
| pick day → time menu | 1 | service (free) |
| pick time → **confirmation** | 1 | service (free) — sent as a session reply, **not a template** |

- **Multi-doctor clinic:** **4 outbound**, all in the free 24h service window.
- **Single-doctor clinic:** `startDoctorStep` auto-routes to the day step → **3
  outbound** (skips the doctor menu).
- **Confirmation is free** — the code (`buildConfirmation`) sends it as the reply
  to the patient's last tap, inside the service window. It is **not** a paid
  template. (Correction to an earlier assumption.)
- **The only paid message in a normal visit is the proactive reminder** (the cron,
  outside the window) → **~1 paid utility template per appointment** ≈ ₹0.115 + GST.
- **The real cost driver is clinic volume vs the 1,000 free service cap**, not any
  single patient. Small clinics stay ~free; busy ones overflow into ₹0.115 overage.

### 15.4 Illustrative margin (multi-doctor clinic @ 1,000 appointments/month)

Using the verified counts: 4 outbound service messages per booking (confirmation
free, in-window), plus 1 paid utility reminder per appointment.

```
Booking service msgs (4 × 1,000 = 4,000 outbound, incl. free confirmation):
  first 1,000 free; 3,000 overage × ₹0.115        = ₹345.00
Reminders (utility, the only paid template): 1,000 × ₹0.115 = ₹115.00
GST @ 18%:             (₹460 × 0.18)              = ₹82.80
                                                    ─────────
WhatsApp cost / clinic / month                    ≈ ₹543
+ shared infra slice                              ≈ ₹75
                                                    ─────────
Cost to serve                                     ≈ ₹618 / month

Revenue (₹983/mo) − cost (~₹618)  ≈ ₹365/mo  →  ~37% gross margin
```

**Single-doctor clinic** (3 outbound per booking → 3,000 service msgs; 2,000
overage) is cheaper: WhatsApp cost ≈ ₹(230 + 115) × 1.18 ≈ ₹460/mo → cost to
serve ≈ ₹535 → margin ≈ ₹448/mo (~46%). Most solo-practitioner clinics fall here.

A low-volume clinic (e.g. 200 appointments/mo) stays largely inside the free
service window → cost to serve ≈ infra + a few reminders → **margin ~80%+**.
Margin improves as fixed infra spreads across more clinics; break-even on a
~₹10k/mo shared infra base is roughly **15–20 clinics**.

### 15.5 The margin risk and its mitigation (R9)

The **follow-up/adherence engine (F3.4)** is the one feature that can invert
margin: medication reminders 3×/day are proactive utility templates and do **not**
get the free-window treatment.

```
3×/day × 30 days × 100 patients = 9,000 utility msgs
9,000 × ₹0.115 × 1.18 (GST)      ≈ ₹1,221 / month   (> the base subscription)
```

**Mitigation:** never bundle unlimited proactive messaging into the base price.
Meter it — base allowance + usage packs, or price adherence as a per-patient
add-on. This is risk **R9** in `production-backlog.md §5`; the metering strategy
converts it from a cost into a revenue stream.

### 15.6 Why the model is profitable

- Booking (the bulk of activity) is **near-free** inside the service window.
- The subscription carries a **strong gross margin** (~37% at high volume,
  ~80%+ at low volume) at the market-anchor price.
- **Fixed costs stay flat** because the stack is single and multi-tenant.
- Expansion revenue (take-rate on labs/payments, message packs) adds margin with
  little added cost.
- The only dangerous cost (heavy proactive messaging) is **metered → monetized**.

Profitability requires **scale past ~15–20 clinics** and **disciplined metering
of proactive sends**. Below that it is investment, not loss-making by design.

---

## 16. Risk register (production)

The ways the system can fail in production, ordered by launch impact. 🚦 = must be
mitigated before real patients. Full mitigations in `production-backlog.md §5`.

| # | Risk | Gate | Mitigation (summary) |
|---|---|---|---|
| R1 | Inbound channel breaks silently (signature/config) — the current prod 401 | 🚦 | Re-register forwarder for exact prod URL; set `WACRM_WEBHOOK_SECRET`; redeploy; add a canary alert. |
| R2 | Wrong template language (`en` vs `en_US`) → every reminder rejected | 🚦 | Pass `languageCode:'en_US'` explicitly; test it; verify template approval; alert on rejections. |
| R3 | Slow patient replies (serial handler, cold starts) | | Parallelize lookups; ack fast + send via `waitUntil`; tighten outbound timeout. |
| R4 | Secret sprawl / no rotation (service-role, Meta token high-blast) | 🚦 | Document ownership + rotation per secret; rotate anything shared; scope keys; never log values. |
| R5 | Flying blind (no observability) | 🚦 | Structured per-delivery logging; error tracking; alerts on failure-rate + cron health. |
| R6 | Data loss (no backups/DR) | 🚦 | Enable Supabase backups (both DBs); do a restore drill; document RPO/RTO. |
| R7 | Compliance & consent (health data on WhatsApp) | 🚦 | Decide jurisdiction; explicit consent; never send lab-result values; retention + DPAs. |
| R8 | Third-party dependency (wacrm + Meta outage/token/API) | | Graceful send-failure handling; monitor token expiry; keep direct-Meta fallback documented. |
| R9 | Cost blow-up from template sends (esp. medication 3×/day) | | Monitor volume/cost; rate-limit + cap proactive sends; **meter → monetize** (see §15.5). |
| R10 | Tenancy leak on the service-role path | | Every service-role query scopes by clinic + patient; cross-clinic isolation tests; review new queries. |
| R11 | PCI / card-data exposure (if payments enabled) | 🚦* | Never touch card data; provider hosted checkout; store only tokens/refs. |
| R12 | E-prescription legality (if e-Rx enabled) | 🚦* | Confirm legality per country; practitioner identity + digital signature; approved channel. |

*R11/R12 gates apply only when that Phase 2 feature is enabled.

---

## 17. Execution board (path to production)

Jira-style tracker; full cards in `production-board.md`. 🚦 = launch gate. Order
is dependency-respecting.

| ID | Title | Prio | Status |
|---|---|---|---|
| LAUNCH-1 | Fix inbound 401 in production | P0 🚦 | To Do |
| LAUNCH-2 | Template language (`en_US`) + wire confirmation | P0 🚦 | To Do |
| LAUNCH-4 | Fast reply (parallelize + `waitUntil`) | P1 | Backlog |
| HARD-1 | Structured logging across the flow | P1 🚦 | Backlog |
| HARD-3 | Metrics + alerting (canary, failure rates) | P1 🚦 | Backlog |
| HARD-4 | Rate limiting / abuse guard on inbound | P1 🚦 | Backlog |
| HARD-6 | CI (typecheck/lint/test on push) | P1 🚦 | Backlog |
| REL-1 | Run migrations from zero | P1 🚦 | Backlog |
| REL-3 | Backups + restore drill | P0 🚦 | Backlog |
| SEC-1 | Secret management + rotation policy | P1 🚦 | Backlog |
| SEC-2 | PII-safe logging + data retention | P1 🚦 | Backlog |
| COMP-1 | Compliance posture (HIPAA/GDPR/DPDP + Meta) | P0 🚦 | Backlog |
| COMP-2 | Patient consent model | P0 🚦 | Backlog |
| ONB-1 | Self-serve clinic onboarding | P1 🚦 | Backlog |
| LAUNCH-5 | End-to-end rehearsal on real WhatsApp | P0 🚦 | Backlog |

**Ordered path:** Stage 0 unblock channel (LAUNCH-1) → Stage 1 correctness
(LAUNCH-2/3) → Stage 2 fast (LAUNCH-4) → Stage 3 safe & operable (HARD/REL/SEC) →
Stage 4 compliance gate (COMP-1/2) → Stage 5 onboarding (ONB-1/2/3) → Stage 6
rehearse & go live (LAUNCH-5). Non-gate P2/P3 and all Phase 2 (revenue/clinical)
come after launch.

---

## 18. How this PRD relates to the other docs

This PRD is the **single source of truth**. The other docs are subordinate
deep-dives it draws from; when they disagree, this document wins.

```
                 ┌─────────────────────────────┐
                 │  product-requirements.md     │  ← SINGLE SOURCE OF TRUTH
                 │  (this PRD)                  │
                 └──────────────┬──────────────┘
   ┌───────────────┬────────────┼────────────────┬───────────────┐
   ▼               ▼            ▼                ▼               ▼
 plan.md     architecture.md  backlog.md /    full-setup-      docs/specs/
 (ADR —      (Mermaid         board.md        guide.md         <feature>.md
  decision   diagrams/ERD)    (live tracker,  (deploy + env    (per-feature
  rationale)                   risks, board)   + appendices)    build spec)

 docs/archive/  ← superseded (mvp-roadmap, folder-structure); history only
```

- **This PRD** = the product truth: every feature, behavior, and why it exists.
- **plan.md (ADR)** = *why* the key architecture decisions were made.
- **architecture.md** = the Mermaid diagrams the PRD's ASCII summarizes.
- **backlog / board** = execution truth: what's left, order, what could break.
- **full-setup-guide** = operational step-by-step + env wiring + appendices (A–E).
- **specs** = build truth: how one committed feature gets implemented.
- **archive/** = superseded docs kept for history (not maintained).

When a candidate (🔭) or deferred (⏭️) feature becomes committed work, promote it
to `docs/specs/<feature>.md` (copy `docs/specs/_template.md`) and flip its state
here and in the backlog.
