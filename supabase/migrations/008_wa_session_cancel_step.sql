-- ============================================================
-- 008_wa_session_cancel_step.sql — allow the cancel flow step
--
-- E4-T1 adds a patient-initiated cancel flow over WhatsApp. It needs a
-- new conversation step, 'awaiting_cancel', in which we've listed the
-- patient's upcoming appointments and are waiting for them to pick one
-- to cancel. Widen the wa_sessions.step CHECK to permit it.
--
-- The original CHECK (migration 006) was inline/unnamed, so Postgres
-- auto-named it. We look up and drop whichever CHECK constraint governs
-- `step` (robust to the auto-generated name), then add a named one with
-- the wider set. Idempotent: re-running finds our named constraint,
-- drops it, and re-adds it.
-- ============================================================

DO $$
DECLARE
  con_name TEXT;
BEGIN
  -- Find any CHECK constraint on wa_sessions whose definition references
  -- the `step` column (covers both the auto-named original and our own).
  FOR con_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'wa_sessions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%step%'
  LOOP
    EXECUTE format('ALTER TABLE wa_sessions DROP CONSTRAINT %I', con_name);
  END LOOP;

  ALTER TABLE wa_sessions
    ADD CONSTRAINT wa_sessions_step_check
    CHECK (step IN ('idle', 'awaiting_doctor', 'awaiting_day',
                    'awaiting_time', 'awaiting_cancel'));
END$$;
