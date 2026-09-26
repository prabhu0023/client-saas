# Clinic Appointment SaaS — Technical Architecture

> Companion to `clinic-saas-plan.md`. Diagrams are Mermaid (render in GitHub,
> most IDEs, and doc tools). Reflects the agreed MVP: new clinic app + `wacrm`
> as the WhatsApp channel, Supabase (Postgres + Auth + RLS), staged booking, and
> a reminder cron sending approved templates.
>
> Note: diagrams §1–§2 show the original tap-based (interactive-row) design. The
> implemented MVP uses a numbered-text flow over `wacrm` (which forwards free
> text only) with a session in `wa_sessions`; the components, tenancy, and
> booking core are unchanged. See `clinic-saas-plan.md` §2 note.

---

## 1. System context (components & boundaries)

```mermaid
flowchart TB
    subgraph patient_side["Patient side (WhatsApp only)"]
        PT["Patient<br/>(WhatsApp app)"]
    end

    subgraph meta["Meta / WhatsApp Cloud API"]
        WA["WhatsApp Business<br/>Cloud API"]
    end

    subgraph channel["Messaging channel"]
        CRM["wacrm<br/>(webhook in / template + interactive send out)"]
    end

    subgraph clinicapp["Clinic SaaS (new project — Next.js)"]
        API["App / API routes<br/>(booking, slot-gen, portal APIs)"]
        CRON["Reminder cron<br/>(secret-guarded)"]
        PORTAL["Staff portal UI<br/>(doctor / nurse / receptionist)"]
    end

    subgraph data["Supabase"]
        DB[("Postgres<br/>+ RLS + btree_gist")]
        AUTH["Supabase Auth<br/>(staff logins)"]
    end

    STAFF["Clinic staff"]
    SCHED["External scheduler<br/>(cron pinger / Vercel Cron)"]

    PT <-->|messages / taps| WA
    WA <-->|webhook + send| CRM
    CRM -->|inbound events| API
    API -->|trigger template / interactive send| CRM
    CRON -->|trigger template send| CRM
    SCHED -->|ping w/ secret| CRON

    STAFF -->|login| AUTH
    STAFF --> PORTAL
    PORTAL --> API
    API <--> DB
    CRON <--> DB
    AUTH -.->|session| PORTAL
```

**Boundaries:**
- Patients never touch the clinic app directly — only WhatsApp.
- `wacrm` is the only thing that talks to Meta; the clinic app never calls Meta
  directly (MVP). Swapping to direct Cloud API later only changes this edge.
- All clinic data lives in Supabase Postgres; RLS isolates clinics for the portal.
  WhatsApp-driven writes use the service role (RLS-bypassing) with server-side
  tenancy checks.

---

## 2. Booking request (staged selection → atomic booking)

```mermaid
sequenceDiagram
    autonumber
    actor P as Patient
    participant WA as Meta Cloud API
    participant CRM as wacrm
    participant API as Clinic API
    participant DB as Postgres

    P->>WA: I need an appointment
    WA->>CRM: inbound webhook (phone_number_id, wamid)
    CRM->>API: forward event
    API->>DB: resolve clinic by phone_number_id
    API->>CRM: send doctor list (≤10)
    CRM->>WA: interactive list
    WA->>P: pick a doctor

    P->>WA: tap doctor (id: doc_UUID)
    WA->>CRM: interactive_reply
    CRM->>API: reply id
    API->>DB: slot-gen per day (rolling window)
    API->>CRM: send DAY list (days with openings, ≤10)
    CRM->>WA: interactive list
    WA->>P: pick a day

    P->>WA: tap day (id: day_DOC_DATE)
    WA->>CRM: interactive_reply
    CRM->>API: reply id
    API->>DB: slot-gen for that day
    API->>CRM: send TIME list (≤10)
    CRM->>WA: interactive list
    WA->>P: pick a time

    P->>WA: tap time (id: slot_DOC_DATE_HHMM)
    WA->>CRM: interactive_reply
    CRM->>API: reply id (+ wamid)
    Note over API: dedupe wamid then verify doctor belongs to clinic
    API->>DB: BEGIN, upsert patient, INSERT appointment booked

    alt slot free (commit)
        DB-->>API: OK, exclusion constraint satisfied
        API->>CRM: send confirmation (session message)
        CRM->>WA: message
        WA->>P: Confirmed - Dr X, date and time
    else slot just taken (23P01)
        DB-->>API: exclusion_violation, ROLLBACK
        API->>DB: regenerate that day's times
        API->>CRM: just taken, pick again + fresh times
        CRM->>WA: interactive list
        WA->>P: pick again
    end
```

---

## 3. Reminder cron (proactive template send)

```mermaid
sequenceDiagram
    autonumber
    participant SCHED as External scheduler
    participant CRON as Reminder cron route
    participant DB as Postgres
    participant CRM as wacrm
    participant WA as Meta Cloud API
    actor P as Patient

    SCHED->>CRON: GET /cron (x-cron-secret)
    Note over CRON: timing-safe secret compare, else 401
    CRON->>DB: SELECT due reminders (next_run_at <= now, clinic-tz aware, LIMIT 50)
    loop each due row
        CRON->>DB: claim row (set status running) [idempotency lock]
        alt claim won
            CRON->>CRM: send APPROVED TEMPLATE (name + vars)
            CRM->>WA: template message
            WA->>P: Reminder - appointment tomorrow
            CRON->>DB: mark sent + compute next_run_at
        else already claimed
            Note over CRON: skip (another run took it)
        end
    end
```

**Why template, not free text:** the cron fires days after the patient's last
message → outside the 24h window → Meta requires a pre-approved template.

---

## 4. Data model (entity relationships)

```mermaid
erDiagram
    clinics ||--o{ clinic_whatsapp_numbers : has
    clinics ||--o{ clinic_members : has
    clinics ||--o{ patients : has
    clinics ||--o{ services : has
    clinics ||--o{ appointments : has
    users ||--o{ clinic_members : "is"
    clinic_members ||--o| doctor_profiles : "extends (doctor)"
    doctor_profiles ||--o{ availability_rules : has
    doctor_profiles ||--o{ availability_exceptions : has
    doctor_profiles ||--o{ doctor_services : offers
    services ||--o{ doctor_services : "offered by"
    doctor_profiles ||--o{ appointments : "booked with"
    patients ||--o{ appointments : books
    services ||--o{ appointments : "for"

    clinics {
        uuid id PK
        text name
        text slug UK
        text timezone
        text status
    }
    clinic_whatsapp_numbers {
        uuid id PK
        uuid clinic_id FK
        text phone_number_id UK
        text display_number
        text status
    }
    clinic_members {
        uuid id PK
        uuid clinic_id FK
        uuid user_id FK
        text role
        text status
    }
    doctor_profiles {
        uuid id PK
        uuid clinic_member_id FK
        uuid clinic_id FK
        text specialty
        text registration_number
        int slot_duration_minutes
    }
    patients {
        uuid id PK
        uuid clinic_id FK
        text wa_phone
        text full_name
    }
    services {
        uuid id PK
        uuid clinic_id FK
        text name
        int price_cents
    }
    availability_rules {
        uuid id PK
        uuid doctor_id FK
        int weekday
        time start_time
        time end_time
    }
    availability_exceptions {
        uuid id PK
        uuid doctor_id FK
        date date
        text kind
    }
    appointments {
        uuid id PK
        uuid clinic_id FK
        uuid doctor_id FK
        uuid patient_id FK
        timestamptz starts_at
        timestamptz ends_at
        text status
    }
```

---

## 5. Tenancy & trust boundaries

```mermaid
flowchart LR
    subgraph portalpath["Portal path (authenticated staff)"]
        S["Staff"] --> P["Portal / API"]
        P --> RLS{"RLS<br/>clinic_members check"}
        RLS -->|allowed rows only| DB1[("Postgres")]
    end

    subgraph wapath["WhatsApp path (no login)"]
        W["Inbound webhook"] --> SR["Service role<br/>(bypasses RLS)"]
        SR --> TC{"Explicit code check:<br/>doctor belongs to resolved clinic"}
        TC -->|verified| DB2[("Postgres")]
    end
```

**Rule:** RLS protects the portal; **server-side code** protects the WhatsApp
path (patients aren't logged in, so the service role bypasses RLS and the app
must re-check tenancy itself).
