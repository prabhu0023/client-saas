# DoctorDesk — Shared Pitch Messaging

> **The single home for messaging reused across the pitch scripts.** The three
> script docs — `video-script-and-talking-points.md` (recorded video),
> `speaking-notes.md` (live, per-slide cue cards), `meeting-script-timed.md`
> (live, timed conversation) — reference this file instead of each restating it.
> Edit messaging **here once**; the scripts stay thin and format-specific.

---

## The 3 anchors (land these no matter the format)

1. **Under 60 seconds to book** — the live/recorded demo proves it.
2. **Impossible to double-book** — enforced in the database, not a toggle.
3. **Free pilot, I do the setup** — the close.

Everything else is supporting cast.

---

## Elevator pitch (30 sec)

> "DoctorDesk is WhatsApp-first appointment booking for clinics. Patients text
> your number, pick a doctor, pick a time, done — in under a minute. Your staff
> sees it instantly in a dashboard. It's impossible to double-book because the
> system enforces it at the database level. And automatic WhatsApp reminders cut
> no-shows. It's what clinic booking should be in 2026 — can I set up a free
> pilot for your clinic?"

---

## The vision — Grow / Care / Earn

Everything demoed today works now; this is where it goes. Each phase builds on
the last, and **clinical/payment features ship only where compliant** — patient
privacy and local regulation come first.

- **Grow — scale to every clinic.** Self-serve onboarding (sign up, connect a
  WhatsApp number, add doctors, go live — no manual setup); multi-clinic/chains
  with full data isolation and a separate number per clinic; staff invites &
  roles; service-based booking ("I need a blood pressure check" → matched to an
  available doctor).
- **Care — beyond the appointment.** Medication-adherence nudges; lab-test
  follow-ups ("results are ready, contact the clinic" — **never the values**);
  next-visit reminders; richer patient history + nurse workflows. *Every
  proactive clinical message is consent-based and uses pre-approved templates.*
- **Earn — a full business platform.** Payments over WhatsApp via Razorpay/Stripe
  hosted checkout (**we never touch card data — PCI-safe**); digital
  invoices/receipts; e-prescriptions where law permits (registered-practitioner
  sign-off + digital signature); waitlist/smart-fill on cancellations.

**How to use it in the room:** lead with today, anchor with tomorrow; frame
compliance as a strength, not a blocker; then ask **"Of everything here, what
would help your clinic the most?"** — their answer tells you what to prioritize.

---

## Objection handling

| If they say... | You say... |
|---|---|
| "My patients are older, they won't use this." | "They already WhatsApp their children and grandchildren. If they can do that, they can reply with a number. And your front desk is still there for anyone who prefers to call." |
| "We already have a system." | "Does it stop double-bookings at the source? Does it remind patients on WhatsApp? Does it let someone book at 10pm without a call? If it does all three, you may not need me. If not — that's the gap I fill." |
| "What about patient data and privacy?" | "Each clinic's data is isolated and encrypted. We're building toward HIPAA/DPDP compliance, and clinical/payment features only roll out where they're compliant and the patient has consented." |
| "What if WhatsApp goes down?" | "Your staff can always add appointments in the portal directly. WhatsApp is the convenience layer for patients, not something your clinic depends on to function." |
| "How much does it cost?" | "The pilot is free. After that we'll price it fairly, per clinic — but let's prove it's worth paying for first." |
| "Sounds complicated to set up." | "That's my job, not yours. I connect your WhatsApp number, add your doctors and hours, and you just start taking bookings." |

---

## The close

> "I'll set DoctorDesk up for your clinic as a free pilot — no cost, no
> commitment, I just want your honest feedback. I handle all the setup; your team
> just starts seeing bookings on WhatsApp. We start small, you watch it work with
> your own patients, and if it's not making your days easier, we walk away."

Then the specific ask — don't soften it: **"Can we book 30 minutes this week to
get your clinic set up?"** Then stop talking.

---

## Honesty guardrails (read before every pitch)

Credibility is the biggest asset in front of a doctor. Keep claims defensible:

- **Be explicit about live vs. coming.** Only the MVP (booking, reminders,
  cancel/reschedule, staff portal, availability) is built. Grow/Care/Earn is
  roadmap. Say so.
- **Stats are directional, not guaranteed.** WhatsApp's high open rates and large
  Indian user base are widely reported industry figures — present them as
  "industry numbers," not DoctorDesk's measured results. Avoid a specific
  uptime % (there is no SLA yet; production hardening is in progress).
- **Don't overclaim compliance.** HIPAA/DPDP compliance and backups are **in
  progress, not done**. Say "building toward compliance," never "fully
  compliant." Never claim an uptime guarantee.
- **"We never send lab-result values"** and **"we never touch card data"** are
  real design commitments — those you *can* state firmly.
