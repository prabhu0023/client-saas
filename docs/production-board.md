# DoctorDesk — Production Board

> The **execution** view: features (epics) → tickets, in the order to build them
> for production. Think of this as the Jira board; `production-backlog.md` is the
> inventory + risk register it draws from.
>
> - **Board (§1):** columns at a glance (Backlog → To Do → In Progress → In Review → Done).
> - **Ordered path (§2):** the exact sequence to production, dependency-respecting.
> - **Epics & tickets (§3):** self-contained cards for active work; lean refs for Phase 2.
> - **Gates (§4):** what must be Done before launch.
>
> **Ticket IDs are stable** — reference them in commits/PRs/chat (e.g. `LAUNCH-2`).

---

## Legend

- **Status:** `Backlog` · `To Do` · `In Progress` · `In Review` · `Done`
- **Priority:** P0 (launch blocker) · P1 (needed for a safe launch) · P2 (soon after) · P3 (later)
- **Size:** S (hours) · M (1–3 days) · L (1–2 weeks) · XL (multi-week)
- 🚦 = launch gate (see §4)

---

## 1. Board at a glance

| ID | Title | Epic | Prio | Size | Status |
|---|---|---|---|---|---|
| LAUNCH-1 | Fix inbound 401 in production | E-Channel | P0 🚦 | S | To Do |
| LAUNCH-2 | Fix template language (`en_US`) + wire confirmation | E-Booking | P0 🚦 | S | To Do |
| LAUNCH-3 | Notify on patient-initiated cancel/reschedule | E-Booking | P2 | M | Backlog |
| LAUNCH-4 | Fast reply (parallelize + `waitUntil`) | E-Perf | P1 | M | Backlog |
| HARD-1 | Structured logging across the flow | E-Obs | P1 🚦 | M | Backlog |
| HARD-2 | Error tracking (Sentry) | E-Obs | P2 | S | Backlog |
| HARD-3 | Metrics + alerting (canary, failure rates) | E-Obs | P1 🚦 | M | Backlog |
| HARD-4 | Rate limiting / abuse guard on inbound | E-Resil | P1 🚦 | M | Backlog |
| HARD-5 | Outbound send retry/backoff | E-Resil | P2 | M | Backlog |
| HARD-6 | CI (typecheck/lint/test on push) | E-Ops | P1 🚦 | S | Backlog |
| REL-1 | Run migrations from zero | E-Rel | P1 🚦 | S | Backlog |
| REL-2 | Concurrency test vs real DB | E-Rel | P2 | S | Backlog |
| REL-3 | Backups + restore drill | E-Rel | P0 🚦 | M | Backlog |
| SEC-1 | Secret management + rotation policy | E-Sec | P1 🚦 | M | Backlog |
| SEC-2 | PII-safe logging + data retention policy | E-Sec | P1 🚦 | M | Backlog |
| COMP-1 | Compliance posture (HIPAA/GDPR/DPDP + Meta) | E-Comp | P0 🚦 | L | Backlog |
| COMP-2 | Patient consent model | E-Comp | P0 🚦 | M | Backlog |
| ONB-1 | Self-serve clinic onboarding | E-Onboard | P1 🚦 | L | Backlog |
| ONB-2 | Staff invite / role management UI | E-Onboard | P2 | M | Backlog |
| ONB-3 | Services management (portal) | E-Onboard | P2 | M | Backlog |
| LAUNCH-5 | End-to-end rehearsal on real WhatsApp | E-Channel | P0 🚦 | M | Backlog |
| P2-* | Phase 2 (revenue + clinical) | see §3.9 | P3 | — | Backlog |

> Update the **Status** column as work moves. Mirror completions into
> `production-backlog.md` §4 Done log.

---

## 2. Ordered path to production

Dependency-respecting sequence. Do stages top to bottom; within a stage, tickets
can run in parallel unless a dep says otherwise.

```
Stage 0 — Unblock the channel
  └─ LAUNCH-1  (nothing works in prod until inbound accepts messages)

Stage 1 — Correctness quick wins  (dep: LAUNCH-1 to verify end-to-end)
  ├─ LAUNCH-2  (en_US bug + confirmation template)
  └─ LAUNCH-3  (notify on patient-initiated change)   [P2 — can slip to Stage 3]

Stage 2 — Make it fast
  └─ LAUNCH-4  (parallelize + waitUntil)

Stage 3 — Make it safe & operable  (bulk of hardening; run in parallel)
  ├─ HARD-1 → HARD-3   (logging → metrics/alerting build on it)
  ├─ HARD-2            (error tracking)
  ├─ HARD-4, HARD-5    (rate limit, retry)
  ├─ HARD-6            (CI)
  ├─ REL-1 → REL-2     (migrate-from-zero → then run concurrency test)
  ├─ REL-3             (backups + restore drill)
  └─ SEC-1, SEC-2      (secrets, PII/retention)

Stage 4 — Compliance gate  (before ANY real patient data)
  ├─ COMP-1  (compliance posture)
  └─ COMP-2  (consent model)

Stage 5 — Let real clinics in
  ├─ ONB-1  (self-serve onboarding)
  ├─ ONB-2  (staff invites)         [can follow ONB-1]
  └─ ONB-3  (services management)   [can follow ONB-1]

Stage 6 — Rehearse & launch  (dep: all P0/P1 🚦 done)
  └─ LAUNCH-5  (end-to-end on real WhatsApp) → GO LIVE

Post-launch — Phase 2
  └─ P2-* (revenue, clinical expansion — see §3.9)
```

---

## 3. Epics & tickets

Active-work tickets (Stages 0–6) are **self-contained** — acceptance criteria
inline. Phase 2 is **lean** — refers to the backlog.

### E-Channel — WhatsApp channel

#### LAUNCH-1 — Fix inbound 401 in production · P0 🚦 · S
- **Problem:** prod `POST /api/whatsapp/inbound` returns 401 — HMAC signature
  mismatch; all inbound dead. Diagnostic logging (named reasons) already added.
- **Do:** trigger one message, read the named reason in Vercel logs. If
  `hmac_mismatch`: re-register the forwarder for the exact prod URL
  (`scripts/wacrm-setup.ts register …/api/whatsapp/inbound`), set the printed
  `WACRM_WEBHOOK_SECRET` in Vercel, **redeploy**. (Setup guide Phase 9 / App. A.)
- **Accept:** an inbound message logs `handled`; a booking round-trips end-to-end.
- **Dep:** none. **First.**

#### LAUNCH-5 — End-to-end rehearsal on real WhatsApp · P0 🚦 · M
- **Do:** run the full narrative on the deployed URL — text the number, book,
  see "just taken" from a 2nd phone, view in dashboard, receive a reminder.
- **Accept:** the demo narrative passes on real infra; any failure files a ticket.
- **Dep:** all P0/P1 🚦 tickets Done; approved templates.

### E-Booking — booking & notifications

#### LAUNCH-2 — Template language fix + wire confirmation · P0 🚦 · S
- **Problem:** `sendTemplate` defaults `languageCode` to `en`; template is
  `en_US` → sends rejected. Confirmation template not wired to booking success.
- **Do:** pass `en_US` explicitly (or make required); send
  `doctordesk_appointment_confirmation` on booking success with the 4 params;
  add a test asserting the language + params.
- **Accept:** confirmation template sends successfully; test proves `en_US` used.
- **Dep:** LAUNCH-1 (to verify end-to-end); approved template.
- ⚠️ **Template names:** reminder + cancellation defaults are already branded in
  code (`doctordesk_appointment_reminder`, `doctordesk_appointment_cancelled`).
  The confirmation template (built pre-rename as `slotwhisper_appointment_confirmation`)
  must be **registered in Meta as `doctordesk_appointment_confirmation`** and wired
  with that exact name here, or the send is rejected.

#### LAUNCH-3 — Notify on patient-initiated cancel/reschedule · P2 · M
- **Do:** when a patient cancels/reschedules over WhatsApp, send the appropriate
  confirmation/notification (reuse `notify.ts` / `sendTemplate`); decide if staff
  also get notified.
- **Accept:** patient-initiated change produces a notification; template used
  when outside the 24h window.
- **Dep:** LAUNCH-2 (shared template plumbing).

### E-Perf — performance

#### LAUNCH-4 — Fast reply (parallelize + `waitUntil`) · P1 · M
- **Problem:** inbound handler is serial and sends the reply last; slow on cold
  starts / slow wacrm.
- **Do:** parallelize independent lookups (dedupe gates; clinic-resolve +
  session-load concurrent); ack the webhook fast and send the reply via
  `waitUntil`; tighten the outbound timeout.
- **Accept:** measured reply latency drops; webhook acks quickly; no double-reply.
- **Dep:** LAUNCH-1.

### E-Obs — observability

#### HARD-1 — Structured logging across the flow · P1 🚦 · M
- **Do:** consistent log line per inbound delivery (delivery id, clinic, step,
  outcome: `handled`/`duplicate`/`no_clinic`/`no_phone`/`error`). Extend beyond
  the 401-reason logging already added.
- **Accept:** every inbound produces a traceable, outcome-tagged log line.

#### HARD-2 — Error tracking (Sentry) · P2 · S
- **Do:** wire an error tracker for unhandled exceptions in routes + cron.
- **Accept:** a thrown error surfaces in the tracker with context.
- **Dep:** HARD-1 (consistent context).

#### HARD-3 — Metrics + alerting · P1 🚦 · M
- **Do:** alert on inbound failure-rate, send-rejection, and cron health; add a
  synthetic inbound **canary** that alerts if no successful delivery in N minutes.
- **Accept:** a simulated outage (bad secret) fires an alert.
- **Dep:** HARD-1.

### E-Resil — abuse & resilience

#### HARD-4 — Rate limiting / abuse guard on inbound · P1 🚦 · M
- **Do:** per-conversation throttle so a spammy sender can't loop the flow;
  cheap (in-DB or in-memory) for now; per-tenant safe.
- **Accept:** excessive inbound from one conversation is slowed/dropped without
  affecting other tenants.
- **Dep:** HARD-1.

#### HARD-5 — Outbound send retry/backoff · P2 · M
- **Do:** retry transient wacrm send failures with bounded backoff; give up
  gracefully + log.
- **Accept:** a transient failure is retried and succeeds; a hard failure is
  logged, not lost silently.

### E-Ops — operability

#### HARD-6 — CI (typecheck/lint/test on push) · P1 🚦 · S
- **Do:** CI pipeline running `typecheck`, `lint`, `test` on every push/PR.
- **Accept:** a failing test/type error blocks merge.

### E-Rel — reliability & correctness

#### REL-1 — Run migrations from zero · P1 🚦 · S
- **Do:** apply all migrations (001→010) + seed against a fresh DB; verify the
  demo clinic, doctors, availability, appointments land and the dashboard renders.
- **Accept:** a documented, repeatable from-zero bring-up succeeds.

#### REL-2 — Concurrency test vs real DB · P2 · S
- **Do:** run `book.concurrency.test.ts` against a real Postgres
  (`TEST_DATABASE_URL`); one booking wins, the other returns `slot_taken`.
- **Accept:** the exclusion constraint is proven under contention.
- **Dep:** REL-1 (real DB available).

#### REL-3 — Backups + restore drill · P0 🚦 · M
- **Do:** enable Supabase backups (both DBs); perform an actual **restore drill**;
  document RPO/RTO.
- **Accept:** a backup is successfully restored to a scratch project.

### E-Sec — security & privacy

#### SEC-1 — Secret management + rotation policy · P1 🚦 · M
- **Do:** document ownership + rotation for each secret (Appendix B is the
  inventory); rotate anything ever shared/committed; scope keys minimally.
- **Accept:** every secret has a documented owner + rotation step; none logged.

#### SEC-2 — PII-safe logging + data retention · P1 🚦 · M
- **Do:** audit what's logged (no PII/secrets); define + implement data retention
  and deletion (right-to-erasure) behavior.
- **Accept:** logs are PII-free; a documented retention/deletion policy exists.
- **Dep:** HARD-1.

### E-Comp — compliance (before real patient data)

#### COMP-1 — Compliance posture · P0 🚦 · L
- **Do:** decide target jurisdiction(s); map HIPAA/GDPR/DPDP + Meta health-data
  obligations; DPAs with processors (Supabase, Meta, wacrm). *Not legal advice —
  verify per jurisdiction.*
- **Accept:** a documented compliance decision + signed DPAs for the target market.

#### COMP-2 — Patient consent model · P0 🚦 · M
- **Do:** capture + store explicit consent to clinical messaging on WhatsApp;
  gate proactive sends on consent; never send lab-result *values*.
- **Accept:** no proactive clinical message sends without recorded consent.
- **Dep:** COMP-1 (defines what consent must cover).

### E-Onboard — let real clinics in

#### ONB-1 — Self-serve clinic onboarding · P1 🚦 · L
- **Do:** UI/flow to create a clinic (name, slug, timezone), connect its wacrm
  account, and enrol the first admin — replacing the seed script.
- **Accept:** a new clinic can onboard end-to-end with no SQL.
- **Dep:** COMP-1/COMP-2 (real clinics ⇒ real data ⇒ compliance in place).

#### ONB-2 — Staff invite / role management UI · P2 · M
- **Do:** invite staff, assign roles (doctor/nurse/receptionist/admin) in-portal.
- **Accept:** an admin adds staff without SQL; roles enforced.
- **Dep:** ONB-1.

#### ONB-3 — Services management (portal) · P2 · M
- **Do:** CRUD for `services` + `doctor_services` in the portal.
- **Accept:** staff manage services + doctor-service mapping without SQL.
- **Dep:** ONB-1.

### 3.9 Phase 2 — revenue & clinical (post-launch, lean)

Tracked in `production-backlog.md` §2B. Do **after** launch. Compliance/legal
gates apply per-feature when enabled.

| ID | Title | Prio | Ref |
|---|---|---|---|
| P2-REV-1 | Clinic subscription/billing | P3 | backlog §2B Revenue |
| P2-REV-2 | Patient payments (provider-based, PCI-safe) | P3 🚦 | backlog §2B + R11 |
| P2-REV-3 | Invoices / receipts | P3 | backlog §2B |
| P2-CLIN-1 | E-prescriptions | P3 🚦 | backlog §2B + R12 |
| P2-CLIN-2 | Follow-up/adherence engine (med/lab/results) | P3 🚦 | backlog §2B + R9 |
| P2-CLIN-3 | Deeper records + nurse workflows | P3 | backlog §2B |
| P2-BOOK-1 | Service-first booking (Pattern B/C) | P3 | backlog §2B |
| P2-BOOK-2 | Per-service duration override | P3 | backlog §2B |
| P2-BOOK-3 | Waitlist | P3 | backlog §2B |

---

## 4. Launch gates

**Do not go live for real patients until every 🚦 below is `Done`:**

- **Channel works:** LAUNCH-1, LAUNCH-5
- **Correct sends:** LAUNCH-2
- **Observable:** HARD-1, HARD-3
- **Defended:** HARD-4
- **Automated gate:** HARD-6
- **Recoverable:** REL-1, REL-3
- **Secured:** SEC-1, SEC-2
- **Compliant:** COMP-1, COMP-2
- **Onboardable:** ONB-1

> P2 tickets and P2/P3 non-gate items are explicitly **out** of the launch gate.

---

## 5. Workflow

1. Pull the next ticket from §2's current stage; set its Status → `In Progress`.
2. Build it; meet the acceptance criteria; open review → `In Review`.
3. On merge → `Done`; update §1 board + `production-backlog.md` §4 Done log.
4. A 🚦 ticket is never skipped — re-scope it if blocked, don't drop it.
5. Add target dates later (a `Target` column in §1) once you commit to a timeline.
