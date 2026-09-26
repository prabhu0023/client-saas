-- ============================================================
-- 009_wa_session_reschedule_step.sql — allow the reschedule flow step
--
-- E4-T2 adds a patient-initiated reschedule flow over WhatsApp. It needs
-- a new conversation step, 'awaiting_reschedule', in which we've listed
-- the patient's upcoming appointments and are waiting for them to pick
-- one to move (after which the normal day/time steps run). Widen the
-- wa_sessions.step CHECK to permit it.
--
-- Same robust drop-and-readd pattern as migration 008: look up whatever
-- CHECK constraint governs `step` and replace it with the wider set.
-- Idempotent.
-- ============================================================

DO $$
DECLARE
  con_name TEXT;
BEGIN
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
                    'awaiting_time', 'awaiting_cancel',
                    'awaiting_reschedule'));
END$$;
