# Clinic SaaS — Architecture Decision Record (ADR)

> **Superseded as a plan.** The product spec, data model, core behaviors, scope,
> and roadmap now live in the single source of truth,
> [`product-requirements.md`](./product-requirements.md). This file is trimmed to
> the one thing it still uniquely holds: **the "why" behind the key architecture
> decisions** (the rationale, not just the choice). When this file and the PRD
> disagree on anything other than rationale, the PRD wins.

---

## Key architecture decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Build location | Separate product, not inside `wacrm` | Its own SaaS with regulated data; `wacrm` is just the messaging channel. |
| WhatsApp transport (MVP) | Reuse `wacrm` | Webhook/send plumbing already exists; fastest to a working product. |
| Patient scope | Per-clinic, key `(clinic_id, wa_phone)` | Cleaner privacy; no cross-clinic history sharing. |
| Tenant key | wacrm `account_id` (not Meta `phone_number_id`) | wacrm forwards free text + stamps `account_id`; that's what we can route on. |
| Doctors per clinic | Multiple | Booking resolves to one doctor before slot lookup. |
| Booking pattern | Pattern A — pick doctor → slot | Simplest; matches most clinics' mental model. (Service-first B/C deferred — additive.) |
| Slot length | Per doctor (`slot_duration_minutes`) | Different doctors, different consult lengths. |
| Timezone | Per clinic, chosen at onboarding | Multi-region capable; one tz per clinic bridges local-clock rules and UTC storage. |
| Double-booking prevention | DB exclusion constraint (`btree_gist`) | The database decides the winner atomically; no app-level race. |
| Time storage | UTC in appointments; local clock in availability rules | DST-safe; the clinic timezone bridges the two. |
| Patient reads/writes | Server-side via service role (bypasses RLS) | Patients aren't logged in; code re-verifies tenancy as defense-in-depth. |
| WhatsApp selection mechanic | Numbered-text menu (not tapped interactive rows) | wacrm forwards free text only; same slot-gen/booking core either way. |

---

## Deferred-scope rationale (why these are *not* in the MVP)

The full deferred/candidate catalog with states is PRD §4.5–4.9 and §13. The
reasoning worth preserving:

- **Prescriptions / e-Rx** — heavily regulated (registered practitioner, digital
  signature, approved channel); legality varies by country. Separate compliance
  project (PRD R12).
- **Payments / billing** — use a provider's hosted checkout (Stripe/Razorpay);
  never touch card data → avoids PCI scope (PRD R11).
- **Self-serve onboarding** — the single biggest commercial gap; the MVP uses a
  seed script instead (PRD F5.3 / ticket ONB-1).
- **Patient reminders / follow-up engine** (medication/lab/results) — every
  proactive message is outside the 24h window → needs an approved template and
  **costs money per send**; price and rate-limit before building. Consent-gated;
  never send lab-result *values*. Reuses the appointment-reminder cron, so it
  comes after booking reminders (PRD F3.4 / R9).
- **Global cross-clinic patient records** — raises consent/privacy questions;
  only if a real need emerges.

---

## Standing risks (summary)

Full risk register with mitigations is **PRD §16**. The ones that shaped these
decisions: Meta onboarding/template-approval lead time, compliance
(HIPAA/GDPR/DPDP + Meta health terms), timezone/DST correctness, and the WhatsApp
24-hour messaging window.
