-- ============================================================
-- 007_clinic_wacrm_accounts.sql — wacrm account → clinic router
--
-- The MVP integrates via wacrm (one wacrm account per clinic). Every
-- inbound webhook envelope carries wacrm's `account_id`; this table maps
-- it to the clinic so the flow knows which tenant the message belongs to.
--
-- Matches src/lib/clinics/resolve-by-account.ts
-- (resolveClinicIdByWacrmAccount).
-- ============================================================

CREATE TABLE IF NOT EXISTS clinic_wacrm_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  -- wacrm's account id (from GET /api/v1/me → data.account.id). The
  -- inbound webhook envelope's `account_id` is matched against this.
  wacrm_account_id  TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinic_wacrm_accounts_clinic
  ON clinic_wacrm_accounts(clinic_id);

ALTER TABLE clinic_wacrm_accounts ENABLE ROW LEVEL SECURITY;

-- Staff of a clinic may read/manage their own mapping (portal). The
-- WhatsApp path resolves it via the service role, which bypasses RLS.
DROP POLICY IF EXISTS clinic_wacrm_accounts_access ON clinic_wacrm_accounts;
CREATE POLICY clinic_wacrm_accounts_access ON clinic_wacrm_accounts FOR ALL
  USING (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));
