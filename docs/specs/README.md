# Feature specs

Per-feature design docs for DoctorDesk. Each file here takes one feature from
idea to shippable, using a requirements → design → tasks structure (each with
acceptance criteria). See `../product-requirements.md` for the product context a
spec builds on.

## When to create a spec (the promotion rule)

Maturity decides which document pattern a feature lives in:

| Maturity | Lives in | Pattern |
|---|---|---|
| Idea / maybe | `../production-backlog.md` §2B | A backlog row |
| Committed **and** trivial / additive | `../production-backlog.md` | Backlog row + an acceptance note |
| Committed **and** non-trivial or 🚦 compliance-gated | **here** (`docs/specs/`) | Full spec from `_template.md` |

Don't promote prematurely. Most backlog rows stay rows. A feature earns a spec
when it's genuinely being built and it's either non-trivial or touches
compliance (health data, payments, e-prescriptions).

## How to use

1. Copy `_template.md` to `<feature-name>.md` (kebab-case, e.g.
   `lab-referral-tracking.md`).
2. If it's a 🚦 feature, fill **§2 Compliance gate first** — the legal/consent
   decision gates the design.
3. Work top-to-bottom; keep tasks small and independently verifiable.
4. On ship: flip the row State in `../production-backlog.md` §1/§2 and add a
   line to its §4 Done log.

> Prefer Kiro's native Spec workflow? It generates
> `.kiro/specs/<feature>/{requirements,design,tasks}.md` with the same shape.
> Either location works — pick one per feature and link it from the backlog row.
