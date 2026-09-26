-- ============================================================
-- 005_processed_wa_events.sql — WhatsApp idempotency ledger
--
-- WhatsApp can deliver the same inbound event more than once (Meta
-- retries, double taps). Before acting on an event we insert its wamid
-- here; a unique-violation means we've already handled it and should
-- skip. Service-role only (written from the WhatsApp path) — no user
-- policy exposed.
-- ============================================================

CREATE TABLE IF NOT EXISTS processed_wa_events (
  wamid       TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE processed_wa_events ENABLE ROW LEVEL SECURITY;
-- No authenticated-user policy: all access is server-side via the
-- service-role key.
