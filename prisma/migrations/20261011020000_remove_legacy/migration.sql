-- REMOVE LEGACY
--
-- Removes what no version of the app that can still be deployed reads or
-- writes. This is the only migration in this set that deletes anything, so it
-- is kept separate and can be held back on its own.
--
-- Drops:
--   tables  sessions                 old cookie log-ins (replaced by Auth.js long ago)
--           auth_pending, auth_tokens  temporary sign-in state from the first prototype
--           feedback_auto_reply_log  a log used by the old auto-reply (removed in Phase 1)
--           oem_fault_codes          ONLY if it holds nothing but the four seeded BMW rows
--   column  feedback.page            after its values were copied to page_url
--   indexes users_email_unique, users_google_id_unique (replaced by users_email_key
--           and users_google_id_key in the previous migration)
--   rows    counters in rate_limits that have already expired
--
-- Data loss: none that the app or its users can see.
--   - The dropped tables hold expired log-in tokens, transient sign-in state and
--     a rate-limit log. None of it is user content.
--   - `oem_fault_codes` is dropped only when every row is one of the four BMW
--     rows the old code inserted by itself (they are also saved in
--     data/quarantine/oem-bmw-seed.unverified.json). If it holds anything else,
--     it is NOT dropped: it is renamed to `legacy_oem_fault_codes_archive` and
--     left for a person to look at.
--   - `feedback.page` is dropped only after every value in it is in `page_url`.
-- Locks: brief, on small tables.
-- Deploy order: after `converge_and_expand`. Safe with both the previous and
--   the new application code: neither uses anything removed here. (If the
--   previous code is rolled back to, its start-up routine simply recreates the
--   empty `sessions` table and the two old indexes.)
-- Atomic: the whole file runs as one transaction. If any statement fails,
--   nothing in this file is applied.

-- Fail rather than wait (see converge_and_expand).
SET LOCAL lock_timeout = '15s';

DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "auth_pending";
DROP TABLE IF EXISTS "auth_tokens";
DROP TABLE IF EXISTS "feedback_auto_reply_log";

DO $$
DECLARE
  unexpected INTEGER;
BEGIN
  IF to_regclass('oem_fault_codes') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COUNT(*) FROM "oem_fault_codes"
       WHERE NOT (UPPER(BTRIM("make")) = 'BMW' AND UPPER(BTRIM("code")) IN ('480A12', '480A0C', '480A11', '481A01'))
    $q$ INTO unexpected;

    IF unexpected = 0 THEN
      EXECUTE 'DROP TABLE "oem_fault_codes"';
    ELSE
      EXECUTE 'ALTER TABLE "oem_fault_codes" RENAME TO "legacy_oem_fault_codes_archive"';
      RAISE NOTICE 'oem_fault_codes held % row(s) that the app did not create. It was kept and renamed to legacy_oem_fault_codes_archive.', unexpected;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'feedback' AND column_name = 'page'
  ) THEN
    -- Values that exist only in the old column (normally already copied).
    EXECUTE 'UPDATE "feedback" SET "page_url" = "page" WHERE "page" IS NOT NULL AND "page_url" IS NULL';
    -- A row with two different values keeps both, so nothing is lost.
    EXECUTE 'UPDATE "feedback" SET "page_url" = "page_url" || '' | '' || "page" WHERE "page" IS NOT NULL AND "page" <> "page_url"';
    EXECUTE 'ALTER TABLE "feedback" DROP COLUMN "page"';
  END IF;
END $$;

DROP INDEX IF EXISTS "users_email_unique";
DROP INDEX IF EXISTS "users_google_id_unique";

DELETE FROM "rate_limits" WHERE "expires_at" < NOW();
