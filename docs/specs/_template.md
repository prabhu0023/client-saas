# Feature Spec — <Feature Name>

> Per-feature spec for DoctorDesk. Use this when a candidate graduates from a
> `production-backlog.md` row to committed, non-trivial, or compliance-gated
> work. Delete this blockquote and every `<...>` / _(guidance)_ placeholder as
> you fill it in.
>
> Companion docs (cross-reference, don't duplicate):
> - `clinic-saas-plan.md` — product summary, architecture decisions, deferred scope
> - `clinic-saas-architecture.md` — system architecture
> - `production-backlog.md` — the living tracker (link the row this spec promotes)
>
> **Status:** ⬜ draft · ◑ in progress · ✅ shipped — pick one.
> **Backlog row:** <link/anchor to the §2B row this promotes>
> **Source:** <e.g. Docterz competitor analysis (2026-10-02), or internal>

---

## 1. Context & goal

_(One or two paragraphs. What is this feature, who is it for, and why now?
State the single sentence of value: "a <user> can <do X> so that <outcome>".
Link back to the backlog row and any analysis note that motivated it.)_

**Goal:** <one clear, verifiable sentence>

**Non-goals:** _(what this feature deliberately does NOT do — prevents scope
creep. e.g. "does not send lab-result values over WhatsApp".)_

---

## 2. Compliance gate (fill FIRST if 🚦)

> For 🚦 features (health-data, payments, e-Rx), the legal/consent decision
> gates the design — resolve it before writing tasks. For non-gated features,
> write "N/A — not compliance-gated" and move on.

- **Jurisdiction(s):** <target country/countries — gates what's legal>
- **Regulation(s) in scope:** <HIPAA / GDPR / DPDP / Meta health-data terms / PCI / e-Rx law>
- **Consent required?** <yes/no — if yes, what consent, captured how, stored where>
- **Hard constraints:** _(e.g. never send result values; registered-practitioner
  + digital signature required; never touch card data → use hosted checkout)_
- **Decision / blocker:** <what must be confirmed before build starts; who owns it>
- **Related risk:** <R# from production-backlog.md §5, if any>

---

## 3. Requirements

Behaviour the feature must exhibit, framed as acceptance criteria. Number them so
tasks and tests can cite them.

- **R1 —** <requirement>. **Acceptance:** <observable, testable outcome>.
- **R2 —** <requirement>. **Acceptance:** <...>.
- **R3 —** <edge case / failure mode>. **Acceptance:** <...>.

_(Cover the unhappy paths: invalid input, concurrency, the 24h WhatsApp window,
multi-tenant isolation, idempotency where proactive sends are involved.)_

---

## 4. Design

### 4.1 Fit with existing architecture
_(How this hooks into what already exists. Name the reuse explicitly — e.g.
"rides the reminder cron + template-send layer (E3)", "extends the numbered-text
flow state machine", "adds a portal screen alongside availability". Reusing a
foundation beats rebuilding it.)_

### 4.2 Data model
_(Repeat the plan §3 style: table block + constraints + relationship + tenancy.
Every clinic-scoped table carries `clinic_id`; state the RLS policy and whether
the WhatsApp service-role path touches it.)_

```
<new_table>
  id, clinic_id, <columns...>, created_at
  <unique / constraints>
```

- **RLS:** <policy — e.g. active clinic_members for clinic_id; service-role path re-scopes>
- **Migration:** <migration number + what it adds; forward-only?>
- **Indexes:** <any index needed for the read/scan path>

### 4.3 Flow / UI
_(The WhatsApp conversation steps and/or portal screens. For WhatsApp: new
session states, numbered-reply handling, keyword triggers. For portal: screen,
RLS scoping, which role sees it.)_

### 4.4 Proactive messaging (if any)
_(If it sends outside the 24h window: which approved Meta template, variables,
language code `en_US`, cost/rate-limit note. See R2/R9 in the backlog.)_

### 4.5 Open questions
- <decisions still needed before or during build>

---

## 5. Tasks

Ordered, dependency-aware, each with its own acceptance check (mirror the E-ticket
format). Keep them small enough to ship and verify independently.

### T1 — <task>
- **Scope:** <what changes; which files/dirs>
- **Acceptance:** <build/test/behaviour that proves it done>
- **Deps:** <none | T#>

### T2 — <task>
- **Scope:** <...>
- **Acceptance:** <...>
- **Deps:** T1

### T3 — <task>
- **Scope:** <...>
- **Acceptance:** <...>
- **Deps:** T2

---

## 6. Verification

_(How the whole feature is proven end-to-end before it's marked ✅. For UI:
browser/DOM check. For logic: the test to run. For WhatsApp: the live-message
rehearsal. "Looks right" is not verification.)_

- **Build/tests:** <command(s) to run>
- **Manual/E2E:** <steps>
- **Tenancy check:** <assert no cross-clinic leak on the service-role path>

---

## 7. Rollout & done

- **Flag/gradual?** <behind a flag, one clinic first, or straight on>
- **Backlog update:** flip the §2B row's State; add a line to §4 Done log.
- **Docs to update:** <plan / architecture / setup-guide sections touched>
