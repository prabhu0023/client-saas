-- ============================================================
-- 006_wa_sessions.sql — WhatsApp conversation state
--
-- The wacrm channel forwards free text only (no tapped-row id), so the
-- clinic app owns the multi-step booking conversation. This table holds
-- the per-conversation state: which step we're on and the numbered
-- options we last offered, so a typed reply ('1', '2', …) resolves back
-- to a doctor / day / slot id.
--
-- Keyed by the wacrm conversation_id. Written/read ONLY server-side via
-- the service role (the WhatsApp path has no logged-in user), so no
-- authenticated-user RLS policy is exposed.
--
-- Matches src/lib/whatsapp/session.ts (loadSession / saveSession).
-- ============================================================

CREATE TABLE IF NOT EXISTS wa_sessions (
  conversation_id  TEXT PRIMARY KEY,
  clinic_id        UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  wa_phone         TEXT,
  -- 'idle' | 'awaiting_doctor' | 'awaiting_day' | 'awaiting_time'
  step             TEXT NOT NULL DEFAULT 'idle'
                     CHECK (step IN ('idle', 'awaiting_doctor',
                                     'awaiting_day', 'awaiting_time')),
  -- { doctorId?, dateYmd?, options?: [{ n, id, label }] }
  data             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Sessions live ~30 min from the last write; an abandoned flow
  -- restarts cleanly once past this. The app treats expired rows as
  -- absent (see session.ts loadSession).
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_sessions_clinic ON wa_sessions(clinic_id);
-- Supports cheap cleanup of expired rows (optional cron/GC later).
CREATE INDEX IF NOT EXISTS idx_wa_sessions_expires ON wa_sessions(expires_at);

DROP TRIGGER IF EXISTS wa_sessions_set_updated_at ON wa_sessions;
CREATE TRIGGER wa_sessions_set_updated_at BEFORE UPDATE ON wa_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;
-- No authenticated-user policy: all access is server-side via the
-- service-role key (RLS-bypassing). The app scopes every read/write by
-- conversation_id + clinic_id in code.
