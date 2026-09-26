# DoctorDesk — Production Backlog & Tracker

> Single source of truth for taking DoctorDesk (the WhatsApp-first clinic
> appointment platform) from "MVP demo" to **production for real clinics and
> real patients**. This is the doc to open when asking "what's left, what's
> next, what's done, and what could break in production."
>
> Companion docs (do not duplicate — cross-reference):
> - `product-requirements.md` — **the single source of truth**: every feature, data model, behaviors, risks, board
> - `clinic-saas-plan.md` — ADR: rationale behind key architecture decisions
> - `full-setup-guide.md` — deploy + env + webhook wiring (Appendix A/B)
> - `docs/archive/` — superseded docs (mvp-roadmap, folder-structure)
>
> **Goal (updated):** not a demo — a production SaaS usable by everyone. That
> promotes compliance, observability, and reliability from "nice to have" to
> **release gates**. See §5 Technology risks.

---

## Legend

- **State:** ✅ done · ◑ partial / has a gap · ⬜ not started · ⏭️ deferred
- **Size:** S (hours) · M (1–3 days) · L (1–2 weeks) · XL (multi-week)
- **Gate:** 🚦 = blocks production launch (must be done before real patients)

> Timeline/dates: intentionally left blank for now (add a `Target` column or
> per-item dates later). Track *order* via §3 Now / Next / Later first.

---

## 1. Functional features

What the system does for patients and staff.

### Booking core
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Book over WhatsApp (doctor→day→time→confirm) | ✅ | — | | Live flow (numbered-text). |
| Timezone-correct slot generation | ✅ | — | | Per-doctor slot length, DST-safe. |
| No double-booking (DB exclusion constraint) | ✅ | — | | Concurrency test written (not yet run vs real DB). |
| Confirmation message | ◑ | S | | Free-form works; approved **template not wired** + `en_US`/`en` bug (§5 R2). |

### Patient self-service
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Cancel over WhatsApp | ✅ | — | | |
| Reschedule over WhatsApp | ✅ | — | | book-new-then-cancel-old. |
| Notify on patient-initiated change | ◑ | M | | Staff-side notify wired; patient-initiated path notifies no one. |
| Handle >10 upcoming appointments | ⬜ | S | | Menu caps at 10. |
| Richer no-show handling | ⬜ | S | | Status exists; no workflow/automation around it. |
| Waitlist (notify on cancellation opening) | ⏭️ | L | | Phase 2 §1B (plan §9). |

### Reminders / proactive messaging
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Appointment reminder cron + template | ✅ | — | | Verify it fires on the prod scheduler + claim-lock idempotency (§2 Reliability). |
| Per-clinic template selection/config | ⬜ | M | | Names hardcoded/env today; not multi-tenant selectable. |
| Follow-up engine (medication / lab / results) | ⏭️ | XL | | Phase 2 §1B. `patient_reminders` table + recurrence + template catalog (plan §9.1); consent-gated. Never send lab-result *values*. |

### Staff portal
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Auth (login/logout) | ✅ | — | | |
| Dashboard + status actions | ✅ | — | | confirm/cancel/complete/no_show. |
| Doctor names (RLS-safe) | ✅ | — | | |
| Multi-day / week view | ✅ | — | | |
| View + edit availability | ✅ | — | | Weekly rules + date exceptions. |
| Clinic switcher (multi-clinic staff) | ⏭️ | M | | Deferred; safe for single-clinic. |

### Tenant / clinic lifecycle
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Multi-tenant data model + isolation | ✅ | — | | RLS + service-role scoping. |
| Demo clinic via seed | ✅ | — | | |
| **Self-serve clinic onboarding** | ⬜ | L | 🚦 | Full clinic + staff enrolment replacing the seed script (plan §9). Today SQL/seed only. Biggest functional gap for "everyone". |
| Staff invite / role management UI | ⬜ | M | | Invite/enrol staff + assign roles without SQL. |
| Services management (portal) | ⬜ | M | | `services` + `doctor_services` tables exist; no UI to manage them. |

### Channel integration
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Inbound webhook (verified, deduped) | ✅ | — | | |
| Tenant + patient identity resolution | ✅ | — | | |
| **Inbound 401 in production** | ◑ | S | 🚦 | Channel dead in prod until fixed. §5 R1. |

---

## 2. Non-functional features

How well the system runs — the production-grade qualities.

### Security & privacy
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Webhook HMAC verify (both hops) + replay window | ✅ | — | | |
| RLS clinic isolation + service-role scoping | ✅ | — | | |
| Inbound dedupe (idempotent) | ✅ | — | | |
| **Compliance posture (HIPAA/GDPR/DPDP + Meta health terms)** | ⬜ | L | 🚦 | Required before ANY real patient data. §5 R7. |
| **Patient consent model** | ⬜ | M | 🚦 | Consent to clinical messaging on WhatsApp. |
| Secret management / rotation policy | ⬜ | M | 🚦 | Secrets in env today; define rotation + storage. §5 R4. |
| PII-safe logging + data retention policy | ⬜ | M | 🚦 | What's logged, how long data is kept. |

### Reliability & correctness
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Atomic booking under contention | ✅ | — | | By design; test written. |
| Migrations run from zero (E1-T3) | ◑ | S | 🚦 | Verified in docs, never executed. |
| Concurrency test vs real DB (E2-T3) | ◑ | S | | Written, gated, not run. |
| **Backups / disaster recovery** | ⬜ | M | 🚦 | Supabase backups + restore drill. §5 R6. |
| Outbound send retry/backoff | ⬜ | M | | wacrm send has no retry today. |
| Reminder claim-lock idempotency | ◑ | S | | Architecture §3 shows a "claim row" lock; verify the implemented cron does this, not just `reminder_sent_at`. |

### Performance & latency
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Reply latency ("immediate") | ◑ | M | | Handler serial, reply sent last. Parallelize + `waitUntil`. §5 R3. |
| Cold-start mitigation | ⬜ | S | | Warmer / min instances. |

### Observability
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Structured logging (E7-T1) | ◑ | M | 🚦 | Named 401 reasons added; not consistent across flow. |
| Metrics / alerting | ⬜ | M | 🚦 | Booking/send failures, cron health. §5 R5. |
| Error tracking (e.g. Sentry) | ⬜ | S | | |

### Abuse & resilience
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Rate limiting / abuse guard (E7-T2) | ⬜ | M | 🚦 | Per-conversation throttle. |
| Cost guard on outbound templates | ⬜ | S | | Each template send costs money; cap/monitor. |

### Operability
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Deploy + setup guide | ✅ | — | | `full-setup-guide.md` + Appendix A/B. |
| CI (typecheck/lint/test on push) | ⬜ | S | 🚦 | No automated gate today. |
| End-to-end rehearsal on real WhatsApp (E7-T3) | ⬜ | M | 🚦 | Blocked on R1 + approved templates. |
| On-call runbook | ◑ | S | | Diagnosis trees exist in setup guide. |
| Reconcile orphaned stateless-flow files | ✅ | — | | Verified removed; folder-structure doc drift fixed (2026-09-27). |
| Direct Meta Cloud API fallback transport | ⬜ | L | | Documented fallback if wacrm becomes a constraint (plan §9, arch §1). Reduces R8. |

---

## 2B. Phase 2 — revenue & clinical expansion (post-launch)

Fully scoped and tracked, but **not** on the path to first production launch.
These are the "grow into a real, paid, clinical SaaS" bets. Sourced from
`clinic-saas-plan.md` §9 / §9.1. Grouped so they don't clutter the launch board.
Several are **compliance/legal-gated** — 🚦 applies *if/when you enable that
feature*, not to the initial launch.

### Revenue
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Billing plans + subscription for clinics | ⬜ | L | | How DoctorDesk itself earns (per-clinic/seat). Needed to charge for "everyone". |
| Payments (patient-facing, provider-based) | ⏭️ | L | 🚦 | Use Stripe/Razorpay; **never touch card data → PCI** (plan §9). §5 R11. |
| Invoices / receipts (optionally over WhatsApp) | ⏭️ | M | | Depends on payments. |
| Cost monitoring for template sends | ⬜ | S | | Each proactive send costs money (§5 R9). |

### Clinical expansion
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| E-prescriptions | ⏭️ | XL | 🚦 | Heavily regulated: registered practitioner + digital signature + approved channel; **legality varies by country** (plan §9). §5 R12. |
| Follow-up / adherence engine (med / lab / results) | ⏭️ | XL | 🚦 | `patient_reminders` table + recurrence + template catalog (plan §9.1). Consent-gated; never send result *values*. |
| Deeper patient records + nurse workflows | ⏭️ | L | | Roles exist in schema; workflows don't (plan §9). |
| Global cross-clinic patient records | ⏭️ | L | 🚦 | Consent/privacy heavy; only if a real need emerges (plan §9). |

### Booking model expansion
| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Booking Pattern B/C (service-first → any doctor) | ⏭️ | M | | `doctor_services` already exists → additive, not a rewrite (plan §9). |
| Per-service duration override | ⏭️ | M | | Some services need longer than the doctor's default slot (plan §9). |
| Waitlist (notify on opening) | ⏭️ | L | | Also listed in §1 patient self-service. |

### Competitor-inspired features (sourced from Docterz analysis)

Candidate features from analysing [Docterz](https://www.docterz.in/) and
[OneGlance](https://oneglancehealth.in/) — India clinic/hospital management
platforms. Notable competitor strengths to benchmark: **Docterz — polished,
intuitive UX**; **OneGlance — deep functionality (proper inventory, ABDM, EMR)**. These are **candidates, not commitments**:
they define DoctorDesk's horizontal-expansion surface *if/when* the wedge
(WhatsApp booking) proves out. Several are compliance- or payments-gated and
overlap existing Phase 2 items (noted inline). Added 2026-10-02. _Competitor
feature set summarised from public listings; not copied verbatim._
>
> When one of these graduates from candidate to committed work, promote it to a
> per-feature spec under `docs/specs/` (copy `docs/specs/_template.md`) — see
> `docs/specs/README.md` for the promotion rule. 🚦 items must fill the spec's
> compliance-gate section before build.

| Item | State | Size | Gate | Notes |
|---|---|---|---|---|
| Lab integration + referral/commission tracking | ⬜ | L | | Docterz monetization angle: track lab referrals and the clinic's commission. Revenue lever + stickiness. Overlaps follow-up engine (lab-results-ready) in Clinical expansion. |
| Telemedicine / tele + video consult | ⬜ | L | | Docterz ships patient companion apps (Connect) for tele/video + queue monitoring. Large build; evaluate 3rd-party video (Daily/Twilio) vs. native. |
| Clinic accounting / day-book ("Hisaab Kitaab" equivalent) | ⬜ | M | | Simple per-clinic income/expense ledger + daily collection summary. Lighter than full billing; complements the payments item. |
| Inventory / stock management | ⬜ | M | | (OneGlance — **standout strength there**) Consumables/medicine stock + reorder alerts. Hospital-scale; strong for larger clinics, low priority for the solo wedge. |
| ABDM compliance (ABHA ID + consent) | ⬜ | L | 🚦 | (OneGlance — **headline feature there**) India's Ayushman Bharat Digital Mission: ABHA health ID capture, consent framework, record interoperability. May become **procurement-required** for India/government-adjacent clinics. Lightweight "ABDM-aware" posture fits the WhatsApp flow without a full EMR. (gate applies if/when targeting ABDM-required segments.) |
| Multilingual flows + prescriptions | ⬜ | M | | (OneGlance) Multilingual WhatsApp booking/reminder flows + prescriptions. India is multilingual; **cheaper for us than app-based competitors** (template translations). Real edge. |
| UX polish parity (reception/booking flow) | ⬜ | M | | (Docterz — **its standout strength is smooth, intuitive UX** + fast staff onboarding). Treat UX as a competitive feature; keep the portal + WhatsApp flow best-in-class on usability. |
| Multi-file medical record uploads | ⬜ | M | 🚦 | Attach reports/images to a patient record. **Health data → compliance-gated** (R7): storage, access control, retention, consent. Prereq for deeper records. |
| Vaccine / immunization scheduler | ⬜ | M | | Docterz's pediatric heritage: due-date schedule + reminders per child. A sharp **vertical wedge** if targeting pediatrics; reuses the reminder engine. |
| Analytics / practice insights | ⬜ | M | | Docterz pitches "business insights" from clinical/engagement data. Start with booking/no-show/revenue dashboards; avoid clinical inference until data volume + compliance justify it. |
| Patient portal / companion surface | ⬜ | L | | Docterz has patient apps (Connect, white-labeled). DoctorDesk's thesis is *no patient app* (WhatsApp-first) — treat as a **deliberate non-goal** unless a concrete need emerges. Logged for completeness. |
| AI prescription assist (VoiceRx-style) | ⏭️ | XL | 🚦 | Voice/AI-assisted Rx capture. Enhancement to the existing **E-prescriptions** item below — inherits its regulatory gate (R12). Frontier feature Docterz now markets. |
| Auto-dose / auto-frequency Rx helpers | ⏭️ | M | 🚦 | Docterz auto-fills dose/frequency on prescriptions. Part of the e-Rx workstream; same regulatory gate (R12). |

---

## 3. Now / Next / Later

The focused view — keeps the board above from being overwhelming.

### 🔨 Now (in progress)
- _(pick one — proposed: Confirmation template + `en_US` fix — Functional/Booking core)_

### ⏭️ Next (queued, in order)
1. Fix inbound 401 in production (R1) — 🚦 unblocks the whole channel.
2. Reply latency / `waitUntil` (R3).
3. Structured logging across the flow (E7-T1).
4. Rate limiting on inbound (E7-T2).

### 🗓️ Later (important, not yet scheduled)
- Self-serve clinic onboarding + staff invites.
- Compliance + consent model (🚦 before real patient data).
- Backups/DR, metrics/alerting, CI.
- Per-clinic template config; medication/lab reminders.

---

## 4. Done log

Append here when an item ships (newest first). Keeps honest, visible progress.

- _(2026-10-02)_ Branded WhatsApp template names to DoctorDesk: code defaults now `doctordesk_appointment_reminder` (`send-due.ts`) and `doctordesk_appointment_cancelled` (`notify.ts`); updated tests + PRD §9 env table; confirmation template to be registered as `doctordesk_appointment_confirmation` when LAUNCH-2 wires it. 16 WhatsApp/reminder tests pass.
- _(2026-10-02)_ Renamed product **SlotWhisper → DoctorDesk** across docs (active set), source (`layout.tsx`, `login/page.tsx`), `README.md`, `package.json`/`package-lock.json` (`name: doctordesk`); `tsc --noEmit` passes. Left archive docs + historical Done-log lines unchanged; flagged that the `slotwhisper_appointment_confirmation` template identifier (code + Meta) still needs renaming before wiring (LAUNCH-2).
- _(2026-10-02)_ Pitch-folder cleanup: extracted shared messaging (3 anchors, Grow/Care/Earn vision, objections, elevator, close, honesty guardrails) into `pitch/_shared-messaging.md`; trimmed the three scripts (video / speaking-notes / timed-meeting) to reference it; fixed overclaims across scripts + `slide-deck.html` + `one-pager.html` — relabeled 98%/500M as industry figures, replaced "bank-grade security" with "building toward HIPAA/DPDP compliance."
- _(2026-10-02)_ Merged `deployment.md` into `full-setup-guide.md` (new Appendices C from-zero DB bring-up, D wacrm API contract, E hosting alternatives); archived `deployment.md`; repointed references. Deploy docs are now one guide.
- _(2026-10-02)_ Docs de-duplication pass: trimmed PRD §1/§5 internal redundancy, reframed the inbound-401 "feature" as a known-issue ref (R1/LAUNCH-1); archived `clinic-saas-mvp-roadmap.md` + `clinic-saas-folder-structure.md` to `docs/archive/` (fully absorbed into the PRD); trimmed `clinic-saas-plan.md` to an ADR (decision rationale + deferred-scope reasoning only); repointed all live cross-references.
- _(2026-10-02)_ Promoted `product-requirements.md` to the **single source of truth**: absorbed detailed data model, core behaviors (slots/booking/reminders), WhatsApp integration + identity chain, deployment/env reference, repo structure, risk register, and execution board from the companion docs into one 18-section PRD; declared precedence over the other docs (now subordinate deep-dives).
- _(2026-10-02)_ Verified per-booking message counts against `src/lib/whatsapp/text-flow.ts` (4 outbound multi-doctor / 3 single-doctor, all free service-window; confirmation is a free session reply, NOT a paid template; only the proactive reminder is paid) and corrected PRD §11 unit economics accordingly.
- _(2026-10-02)_ Analysed OneGlance (competitor) + captured competitor strengths (Docterz UX, OneGlance inventory/ABDM depth); added ABDM, multilingual, inventory, and UX-parity candidates to §2B and PRD §4.9, a Competitive landscape section (PRD §10), and a Business model & unit economics section with WhatsApp cost math (PRD §11).
- _(2026-10-02)_ Created `product-requirements.md` — consolidated PRD covering all features (shipped ✅ → candidate 🔭) with vision, personas, feature catalog, NFRs, compliance posture, and doc-map; cross-linked from the backlog.
- _(2026-10-02)_ Added `docs/specs/` with a per-feature spec template (`_template.md`) + `README.md` promotion rule, modeled on the mvp-roadmap ticket shape; linked it from §2B.
- _(2026-10-02)_ Analysed Docterz (competitor) and added a "Competitor-inspired features" subsection to §2B Phase 2 (lab/referral tracking, telemedicine, clinic accounting, inventory, record uploads, vaccine scheduler, analytics, patient portal non-goal, AI/auto Rx helpers).
- _(2026-09-27)_ Verified orphaned flow files already removed; fixed stale file-tree + migrations drift in `clinic-saas-folder-structure.md`.
- _(2026-09-27)_ Added named 401 signature-failure reasons to `/api/whatsapp/inbound` (partial E7-T1 / R1 diagnosis).
- _(2026-09-27)_ Built `slotwhisper_appointment_confirmation` WhatsApp template definition (not yet wired). _(Template identifier predates the DoctorDesk rename; see 2026-10-02 rename note — the actual Meta template name must be updated to `doctordesk_appointment_confirmation` before wiring.)_
- _(2026-09-27)_ Renamed product to **SlotWhisper** (user-facing surfaces + package). _(Later renamed to DoctorDesk — see 2026-10-02.)_
- _(2026-09-27)_ Added `full-setup-guide.md` Appendix A (webhook wiring) + Appendix B (env var sourcing).

---

## 5. Technology risks for going to production (with mitigations)

The specific ways this system can fail in production, and how to reduce each.
Ordered by launch impact. 🚦 = must be mitigated before real patients.

### R1 🚦 — Inbound channel breaks silently (signature/config)
- **Risk:** a secret/URL mismatch (the current prod 401) kills all inbound with
  no reply; the app returns 200/401 and looks "up" while doing nothing.
- **Seen:** production 401 on `/api/whatsapp/inbound`.
- **Mitigate:** re-register the forwarder for the exact prod URL, set
  `WACRM_WEBHOOK_SECRET`, redeploy (setup guide Phase 9 / Appendix A.4). Keep the
  named-reason logging. Add a synthetic "canary" inbound + alert if no successful
  delivery in N minutes.

### R2 🚦 — Wrong template language / unapproved template rejected by Meta
- **Risk:** `sendTemplate` defaults to `en`, but templates are `en_US` → every
  reminder / notification send is rejected. Silent failure to the patient.
- **Mitigate:** pass `languageCode: 'en_US'` explicitly (or make it required);
  add a test asserting the language; verify template approval status before
  relying on it; alert on send-rejection responses.

### R3 — Slow / delayed patient replies
- **Risk:** the inbound handler runs all lookups serially and sends the reply
  last; on cold starts or a slow wacrm the patient waits seconds, and wacrm may
  retry the webhook.
- **Mitigate:** parallelize independent lookups; ack the webhook fast and send
  the reply via `waitUntil` (Vercel); tighten the outbound timeout; consider a
  warmer for cold starts.

### R4 🚦 — Secret sprawl / no rotation
- **Risk:** secrets (service-role keys, `WACRM_API_KEY`, webhook secret, Meta
  token) live in env/`.env.local` with no rotation plan; a leak is high-blast
  (service-role bypasses RLS; Meta token sends as the clinic).
- **Mitigate:** document ownership + rotation for each secret (Appendix B is the
  inventory); rotate anything ever committed or shared; scope keys minimally;
  never log secret values; consider a secrets manager beyond Vercel env later.

### R5 🚦 — Flying blind (no observability)
- **Risk:** without consistent logs + alerts, failures (bad bookings, dropped
  messages, cron not firing) are invisible until a clinic complains.
- **Mitigate:** structured per-delivery logging (id, clinic, step, outcome —
  E7-T1); error tracking; alerts on failure-rate, send-rejection, and cron
  health; a dashboard of daily bookings/sends.

### R6 🚦 — Data loss (no backups/DR)
- **Risk:** appointments and patient records with no verified backup/restore =
  unacceptable for a clinic.
- **Mitigate:** enable Supabase backups (both DBs); do a **restore drill** (a
  backup you've never restored is not a backup); document RPO/RTO; treat
  migrations as forward-only + reversible where possible.

### R7 🚦 — Compliance & consent (health data on WhatsApp)
- **Risk:** "for everyone" + real patient data triggers HIPAA/GDPR/DPDP and
  Meta's health-data terms. Non-compliance is legal/existential, not technical.
- **Mitigate:** decide target jurisdiction(s) early; obtain explicit patient
  **consent** to clinical messaging; never send lab-result *values* over
  WhatsApp; data retention + deletion (right-to-erasure) support; a DPA with
  processors (Supabase, Meta, wacrm). *Not legal advice — verify per
  jurisdiction before real data.*

### R8 — Third-party / channel dependency (wacrm + Meta)
- **Risk:** DoctorDesk depends on wacrm, which depends on Meta. An outage,
  API change, token expiry, or 24h-window rule breaks messaging.
- **Mitigate:** handle send failures gracefully (already partial); monitor token
  expiry; keep the plan's "direct Meta Cloud API" path as a documented fallback;
  don't hard-couple to wacrm-specific behavior beyond the adapter.

### R9 — Cost blow-up from template sends
- **Risk:** every proactive/template message costs money; reminders × patients ×
  clinics can scale surprisingly.
- **Mitigate:** monitor send volume/cost; rate-limit proactive sends; cap
  per-clinic; price it into the plan before enabling medication/lab reminders.

### R10 — Tenancy leak on the service-role path
- **Risk:** the WhatsApp path uses the service role (bypasses RLS); a missing
  `clinic_id`/`wa_phone` scope in any new query could leak across clinics.
- **Mitigate:** every service-role query MUST scope by clinic + patient (as the
  current code does); add tests that assert cross-clinic isolation; code-review
  new queries specifically for this.

### R11 🚦 (if payments enabled) — PCI / card-data exposure
- **Risk:** handling card data directly triggers PCI-DSS scope — heavy and
  unnecessary. Applies only when the payments feature (§2B) is enabled.
- **Mitigate:** **never touch card data.** Use a provider's hosted
  checkout/tokenization (Stripe/Razorpay); store only provider tokens/refs;
  keep webhooks signed; reconcile via the provider, not stored PANs.

### R12 🚦 (if e-prescriptions enabled) — regulatory legality
- **Risk:** e-prescriptions are heavily regulated and **may be illegal or
  require a registered practitioner + digital signature + an approved channel**
  depending on jurisdiction. Applies only when the prescriptions feature (§2B)
  is enabled.
- **Mitigate:** confirm legality per target country **before** building; require
  practitioner identity + digital signature; use an approved channel (WhatsApp
  may not qualify); treat as a separate compliance project. *Not legal advice —
  verify per jurisdiction.*

---

## 6. How to use this doc

1. Work from **§3 Now / Next / Later**, not the full board.
2. When starting an item, move it to **Now** and note the ticket id if it maps to
   the roadmap (e.g. E7-T1).
3. When it ships: update its **State** in §1/§2, move it out of Now, and add a
   line to **§4 Done log**.
4. Before launch, every 🚦 item in §1/§2 and every 🚦 risk in §5 must be resolved.
5. Add timelines later (a `Target` column or dates in §3) once order is settled.
