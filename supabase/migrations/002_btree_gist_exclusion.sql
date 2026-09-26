-- ============================================================
-- 002_btree_gist_exclusion.sql — the double-booking guard
--
-- This is the core correctness guarantee: the database itself
-- refuses any two ACTIVE appointments for the same doctor whose
-- time ranges overlap. The booking transaction does NOT check-
-- then-insert; it attempts the INSERT and lets this constraint
-- decide the winner atomically. The loser gets error 23P01
-- (exclusion_violation), which the app recovers from gracefully.
--
-- Half-open range [starts_at, ends_at): an appointment ending
-- exactly when another begins is NOT a conflict.
-- ============================================================

-- Required to combine an equality (doctor_id) with a range overlap
-- (&&) in a single GiST exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- No two active appointments for the same doctor may overlap.
-- Cancelled / completed / no_show rows are excluded from the guard
-- so their slots become bookable again without deleting history.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_no_overlap
      EXCLUDE USING gist (
        doctor_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status IN ('booked', 'confirmed'));
  END IF;
END$$;

-- Cheap extra guard for fixed-length slots: prevents two active
-- appointments with the identical start for one doctor. Redundant
-- with the exclusion constraint but fast and clear.
CREATE UNIQUE INDEX IF NOT EXISTS appt_doctor_start_active
  ON appointments(doctor_id, starts_at)
  WHERE status IN ('booked', 'confirmed');
