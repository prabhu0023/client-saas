-- ============================================================
-- 007_appointment_reminders.sql — appointment reminder tracking
--
-- MVP reminder model (roadmap E3-T2): rather than a separate
-- patient_reminders table (deferred — see plan §9.1), we track the
-- single "appointment reminder" directly on the appointment. A nightly/
-- periodic cron (E3-T3) scans for appointments starting within the
-- reminder window that haven't been reminded yet, sends the approved
-- WhatsApp template, and stamps reminder_sent_at so it never re-sends.
--
-- Idempotent: IF NOT EXISTS on the column and the index.
-- ============================================================

-- When the appointment reminder was sent (NULL = not yet reminded).
-- The cron only ever sets this once; it's the idempotency marker.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Supports the due-reminder scan: find active, not-yet-reminded
-- appointments ordered by start time. Partial index keeps it small —
-- only rows the cron cares about (active status, no reminder yet).
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments (starts_at)
  WHERE reminder_sent_at IS NULL
    AND status IN ('booked', 'confirmed');
