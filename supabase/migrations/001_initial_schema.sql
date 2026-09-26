-- ============================================================
-- 001_initial_schema.sql — Clinic Appointment SaaS core schema
--
-- Idempotent: IF NOT EXISTS on tables/indexes; DROP IF EXISTS
-- before re-creating triggers. RLS policies live in 003; the
-- no-overlap exclusion constraint lives in 002.
--
-- Tenancy: every clinic-scoped table carries clinic_id. The
-- WhatsApp number's Meta phone_number_id is the tenant router.
-- Times: appointments store UTC; availability stores local clock
-- time; clinics.timezone bridges the two.
-- ============================================================

-- UUID defaults use gen_random_uuid(), which is built into Postgres 13+
-- (available by default on Supabase) and needs no extension.

-- Shared updated_at trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- CLINICS — the tenant
-- ============================================================
CREATE TABLE IF NOT EXISTS clinics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  -- IANA timezone name (e.g. 'Asia/Kolkata'), chosen at onboarding.
  -- Drives all slot rendering and DST-correct conversions.
  timezone    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS clinics_set_updated_at ON clinics;
CREATE TRIGGER clinics_set_updated_at BEFORE UPDATE ON clinics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- CLINIC_WHATSAPP_NUMBERS — tenant router (phone_number_id -> clinic)
--
-- Route inbound webhooks on Meta's stable phone_number_id, never the
-- display number. One active number per clinic for the MVP, but the
-- table allows more than one.
-- ============================================================
CREATE TABLE IF NOT EXISTS clinic_whatsapp_numbers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  phone_number_id  TEXT NOT NULL UNIQUE,
  display_number   TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'disconnected')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinic_wa_numbers_clinic
  ON clinic_whatsapp_numbers(clinic_id);

-- ============================================================
-- USERS — one row per human login. Mirrors auth.users.id.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CLINIC_MEMBERS — membership + role, per clinic
--
-- Role lives on the membership (not the user) so the same person can
-- hold different roles at different clinics.
-- ============================================================
CREATE TABLE IF NOT EXISTS clinic_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL
                CHECK (role IN ('doctor', 'nurse', 'receptionist', 'admin')),
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'invited', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_members_clinic ON clinic_members(clinic_id);
CREATE INDEX IF NOT EXISTS idx_clinic_members_user ON clinic_members(user_id);

-- ============================================================
-- DOCTOR_PROFILES — extends a doctor membership
--
-- clinic_id denormalized for simple/fast RLS and filtering.
-- slot_duration_minutes: appointment length is per-doctor (agreed).
-- ============================================================
CREATE TABLE IF NOT EXISTS doctor_profiles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_member_id       UUID NOT NULL UNIQUE
                           REFERENCES clinic_members(id) ON DELETE CASCADE,
  clinic_id              UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  specialty              TEXT,
  registration_number    TEXT,
  slot_duration_minutes  INTEGER NOT NULL DEFAULT 15
                           CHECK (slot_duration_minutes > 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doctor_profiles_clinic ON doctor_profiles(clinic_id);

-- ============================================================
-- PATIENTS — records, NOT logins. Per-clinic (agreed).
--
-- Natural key is the WhatsApp number scoped to the clinic; the same
-- number is a distinct record at each clinic.
-- ============================================================
CREATE TABLE IF NOT EXISTS patients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  wa_phone       TEXT NOT NULL,               -- E.164, e.g. +919876543210
  full_name      TEXT,
  date_of_birth  DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, wa_phone)
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);

DROP TRIGGER IF EXISTS patients_set_updated_at ON patients;
CREATE TRIGGER patients_set_updated_at BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SERVICES — per clinic. Duration comes from the doctor, not here.
-- ============================================================
CREATE TABLE IF NOT EXISTS services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_clinic ON services(clinic_id);

-- ============================================================
-- DOCTOR_SERVICES — which doctor provides which service
--
-- Added now (cheap) so a later move to booking Pattern B (pick
-- service -> any doctor) is additive, not a rewrite.
-- ============================================================
CREATE TABLE IF NOT EXISTS doctor_services (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id   UUID NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  service_id  UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  UNIQUE (doctor_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_doctor_services_clinic ON doctor_services(clinic_id);

-- ============================================================
-- AVAILABILITY_RULES — recurring weekly template, LOCAL clock time
--
-- start_time/end_time are clinic-local wall-clock times. They are
-- combined with a date in the clinic timezone and converted to UTC
-- at slot-generation time (DST-safe). weekday: 0=Sun .. 6=Sat.
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id    UUID NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  -- Optional per-rule override of the doctor's default slot length.
  slot_minutes INTEGER CHECK (slot_minutes IS NULL OR slot_minutes > 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_availability_rules_doctor_weekday
  ON availability_rules(doctor_id, weekday) WHERE active = TRUE;

-- ============================================================
-- AVAILABILITY_EXCEPTIONS — date-specific overrides
--
-- kind='off'   : doctor unavailable. NULL times = whole day off;
--                a time range = that window is removed.
-- kind='extra' : additional hours that specific date.
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id   UUID NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('off', 'extra')),
  start_time  TIME,
  end_time    TIME,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- If both times are present, end must be after start. 'off' may
  -- have both NULL (whole day); 'extra' requires both.
  CHECK (
    (start_time IS NULL AND end_time IS NULL)
    OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  ),
  CHECK (kind = 'off' OR (start_time IS NOT NULL AND end_time IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_availability_exceptions_doctor_date
  ON availability_exceptions(doctor_id, date);

-- ============================================================
-- APPOINTMENTS — UTC timestamps
--
-- The no-overlap exclusion constraint (the double-booking guard)
-- is added in 002 after btree_gist is enabled.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id    UUID NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'booked'
                 CHECK (status IN ('booked', 'confirmed', 'cancelled',
                                   'completed', 'no_show')),
  service_id   UUID REFERENCES services(id) ON DELETE SET NULL,
  created_via  TEXT NOT NULL DEFAULT 'whatsapp'
                 CHECK (created_via IN ('whatsapp', 'portal')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_clinic ON appointments(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_starts
  ON appointments(doctor_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);

DROP TRIGGER IF EXISTS appointments_set_updated_at ON appointments;
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
