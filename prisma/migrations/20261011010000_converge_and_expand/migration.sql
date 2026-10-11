-- CONVERGE AND EXPAND
--
-- Brings any existing CarCode database, whatever version of the app last
-- touched it, to one known shape, and adds what the app needs next. It only
-- ADDS: tables, columns, indexes and constraints. It drops nothing and renames
-- nothing, so the previous version of the app keeps working against the
-- database before, during and after it (which is what makes an application
-- rollback safe).
--
-- Every statement is written so that it does nothing when its work is already
-- done, because existing databases differ in what they already have.
--
-- Creates : tables an old database may lack; typed copies of values that were
--           stored as text; `rate_limits.expires_at`; indexes; constraints.
-- Changes : `created_at` and `is_active` become NOT NULL with a default;
--           account emails are stored trimmed and in lower case.
-- Backfills: see each section.
-- Drops   : nothing.
-- Data loss: none. Text values are kept exactly as they are next to their
--           typed copies.
-- Locks   : each ALTER/CREATE INDEX briefly locks one table. These tables are
--           small (thousands of rows at most), so this takes milliseconds.
--           On a table of millions of rows the indexes would be built with
--           CREATE INDEX CONCURRENTLY instead.
-- Deploy order: run this BEFORE the new application code goes live. The old
--           code is unaffected by it.
-- Atomic  : the whole file runs as one transaction. If any statement fails,
--           nothing in this file is applied.

-- Fail rather than wait: if something else holds a table for more than 15
-- seconds, stop (changing nothing) instead of queueing behind it and stalling
-- the site.
SET LOCAL lock_timeout = '15s';

-- ───────────────────────── 1. Tables an older database may lack ─────────────────────────

CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "profile_image" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "garage_vehicles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "year" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "engine" TEXT,
    "vin" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "garage_vehicles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "maintenance_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "vehicle_id" TEXT NOT NULL REFERENCES "garage_vehicles"("id") ON DELETE CASCADE,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "mileage" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "feedback" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "rating" INTEGER,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rate_limits" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key", "window_start")
);

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- ───────────────────────── 2. Columns that were added over time ─────────────────────────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_image" TEXT;
ALTER TABLE "garage_vehicles" ADD COLUMN IF NOT EXISTS "nickname" TEXT;
ALTER TABLE "garage_vehicles" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN DEFAULT FALSE;
ALTER TABLE "maintenance_records" ADD COLUMN IF NOT EXISTS "cost" TEXT;
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "page_url" TEXT;

-- ───────────────────────── 3. Email verification (first introduced in Phase 1) ─────────────────────────
-- The body runs only on a database that never got these columns. It classifies
-- the accounts that existed at that moment, exactly as the old start-up code
-- did, so nobody who could sign in before is locked out:
--   - Google-only accounts are marked verified;
--   - accounts with a password are marked "legacy_unverified" (they keep
--     working, but are not treated as proven owners of the address).
-- No password is changed or removed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "email_verified" TIMESTAMPTZ;
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legacy_unverified" BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE "users" SET "email_verified" = COALESCE("created_at", NOW())
      WHERE "google_id" IS NOT NULL AND "password_hash" IS NULL;
    UPDATE "users" SET "legacy_unverified" = TRUE
      WHERE "password_hash" IS NOT NULL;
  END IF;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legacy_unverified" BOOLEAN NOT NULL DEFAULT FALSE;

-- ───────────────────────── 4. Account emails and sign-in identities ─────────────────────────
-- The app looks accounts up by exact, lower-case email. This makes the
-- database guarantee what the app assumes: one account per address, stored in
-- lower case.
--
-- If two accounts share an address (possible only on a database that never had
-- the old uniqueness index), the migration STOPS here and changes nothing:
-- which account is the real one is a decision for a person, not a script.

DO $$
DECLARE
  clashes INTEGER;
BEGIN
  SELECT COUNT(*) INTO clashes FROM (
    SELECT LOWER(BTRIM("email")) FROM "users"
    WHERE "email" IS NOT NULL AND BTRIM("email") <> ''
    GROUP BY 1 HAVING COUNT(*) > 1
  ) d;
  IF clashes > 0 THEN
    RAISE EXCEPTION 'CarCode migration stopped: % email address(es) are used by more than one account. Nothing was changed. Resolve the duplicates, then run the migration again.', clashes;
  END IF;

  SELECT COUNT(*) INTO clashes FROM (
    SELECT "google_id" FROM "users" WHERE "google_id" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
  ) d;
  IF clashes > 0 THEN
    RAISE EXCEPTION 'CarCode migration stopped: % Google identity(ies) are linked to more than one account. Nothing was changed. Resolve the duplicates, then run the migration again.', clashes;
  END IF;
END $$;

-- Backfill: trim and lower-case stored addresses; an empty address becomes "no address".
UPDATE "users"
   SET "email" = NULLIF(LOWER(BTRIM("email")), '')
 WHERE "email" IS NOT NULL
   AND "email" IS DISTINCT FROM NULLIF(LOWER(BTRIM("email")), '');

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_key" ON "users"("google_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_lowercase' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = LOWER("email"));
  END IF;
END $$;

-- ───────────────────────── 5. Timestamps and flags that could be empty ─────────────────────────
-- Backfill: a missing creation time becomes "now" (the real time is unknown).

UPDATE "users" SET "created_at" = NOW() WHERE "created_at" IS NULL;
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT NOW(), ALTER COLUMN "created_at" SET NOT NULL;

UPDATE "garage_vehicles" SET "created_at" = NOW() WHERE "created_at" IS NULL;
ALTER TABLE "garage_vehicles" ALTER COLUMN "created_at" SET DEFAULT NOW(), ALTER COLUMN "created_at" SET NOT NULL;

UPDATE "maintenance_records" SET "created_at" = NOW() WHERE "created_at" IS NULL;
ALTER TABLE "maintenance_records" ALTER COLUMN "created_at" SET DEFAULT NOW(), ALTER COLUMN "created_at" SET NOT NULL;

UPDATE "feedback" SET "created_at" = NOW() WHERE "created_at" IS NULL;
ALTER TABLE "feedback" ALTER COLUMN "created_at" SET DEFAULT NOW(), ALTER COLUMN "created_at" SET NOT NULL;

UPDATE "garage_vehicles" SET "is_active" = FALSE WHERE "is_active" IS NULL;
ALTER TABLE "garage_vehicles" ALTER COLUMN "is_active" SET DEFAULT FALSE, ALTER COLUMN "is_active" SET NOT NULL;

-- ───────────────────────── 6. Typed copies of values stored as text ─────────────────────────
-- The original text columns are NOT touched. A typed copy is filled in only
-- when the text converts cleanly; otherwise it stays empty and the text
-- remains the record. `npm run db:inspect` counts the rows left unconverted.

-- Vehicle year: a four-digit year from 1900 to 2099.
ALTER TABLE "garage_vehicles" ADD COLUMN IF NOT EXISTS "model_year" INTEGER;

UPDATE "garage_vehicles"
   SET "model_year" = BTRIM("year")::INTEGER
 WHERE "model_year" IS NULL
   AND BTRIM("year") ~ '^(19|20)[0-9]{2}$';

-- Maintenance: service date, odometer reading and cost.
ALTER TABLE "maintenance_records" ADD COLUMN IF NOT EXISTS "service_date" DATE;
ALTER TABLE "maintenance_records" ADD COLUMN IF NOT EXISTS "odometer_value" INTEGER;
ALTER TABLE "maintenance_records" ADD COLUMN IF NOT EXISTS "odometer_unit" TEXT;
ALTER TABLE "maintenance_records" ADD COLUMN IF NOT EXISTS "cost_amount" DECIMAL(12,2);

-- A date is accepted only as YYYY-MM-DD and only if it is a real calendar day.
CREATE OR REPLACE FUNCTION pg_temp.carcode_to_date(value TEXT) RETURNS DATE
LANGUAGE plpgsql AS $fn$
BEGIN
  IF value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN value::DATE;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$fn$;

UPDATE "maintenance_records"
   SET "service_date" = pg_temp.carcode_to_date(BTRIM("date"))
 WHERE "service_date" IS NULL
   AND pg_temp.carcode_to_date(BTRIM("date")) IS NOT NULL;

DROP FUNCTION pg_temp.carcode_to_date(TEXT);

-- An odometer reading is whole digits, optionally with thousands commas and a
-- unit: "120000", "120,000", "120000 km", "75,500 miles". Anything else
-- (for example "120.000" or "about 120k") is left as text only.
UPDATE "maintenance_records" AS m
   SET "odometer_value" = REPLACE(v.parts[1], ',', '')::INTEGER,
       "odometer_unit" = CASE
         WHEN v.parts[2] IN ('km', 'kms', 'kilometers', 'kilometres') THEN 'km'
         WHEN v.parts[2] IN ('mi', 'mile', 'miles') THEN 'mi'
         ELSE NULL
       END
  FROM (
    SELECT "id",
           regexp_match(
             LOWER(BTRIM("mileage")),
             '^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,7}) ?(km|kms|kilometers|kilometres|mi|mile|miles)?$'
           ) AS parts
      FROM "maintenance_records"
     WHERE "mileage" IS NOT NULL
  ) AS v
 WHERE m."id" = v."id"
   AND m."odometer_value" IS NULL
   AND v.parts IS NOT NULL
   AND LENGTH(REPLACE(v.parts[1], ',', '')) <= 7;

-- A cost is a plain amount, optionally with a leading "$" and thousands
-- commas: "120", "120.5", "$1,250.00". "120,50" is NOT converted, because it
-- cannot be told apart from a thousands separator.
UPDATE "maintenance_records" AS m
   SET "cost_amount" = REPLACE(v.amount, ',', '')::DECIMAL(12,2)
  FROM (
    SELECT "id", BTRIM(LTRIM(BTRIM("cost"), '$')) AS amount
      FROM "maintenance_records"
     WHERE "cost" IS NOT NULL
  ) AS v
 WHERE m."id" = v."id"
   AND m."cost_amount" IS NULL
   AND (v.amount ~ '^[0-9]{1,3}(,[0-9]{3})+(\.[0-9]{1,2})?$' OR v.amount ~ '^[0-9]{1,9}(\.[0-9]{1,2})?$')
   AND LENGTH(REPLACE(SPLIT_PART(v.amount, '.', 1), ',', '')) <= 9;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'garage_vehicles_model_year_check' AND conrelid = 'garage_vehicles'::regclass) THEN
    ALTER TABLE "garage_vehicles" ADD CONSTRAINT "garage_vehicles_model_year_check" CHECK ("model_year" BETWEEN 1900 AND 2100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_records_odometer_check' AND conrelid = 'maintenance_records'::regclass) THEN
    ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_odometer_check"
      CHECK ("odometer_value" >= 0 AND ("odometer_unit" IS NULL OR "odometer_unit" IN ('km', 'mi')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_records_cost_amount_check' AND conrelid = 'maintenance_records'::regclass) THEN
    ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_cost_amount_check" CHECK ("cost_amount" >= 0);
  END IF;
END $$;

-- ───────────────────────── 7. Feedback: one column for the page address ─────────────────────────
-- Two versions of the app disagreed: one wrote "page", the other "page_url".
-- "page_url" is the one in use and is now the only one the app knows.
-- Backfill: copy any value that exists only in the old "page" column.
-- The old column itself is removed in the next migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'feedback' AND column_name = 'page'
  ) THEN
    EXECUTE 'UPDATE "feedback" SET "page_url" = "page" WHERE "page_url" IS NULL AND "page" IS NOT NULL';
  END IF;
END $$;

-- ───────────────────────── 8. Short-lived counters get an expiry ─────────────────────────
-- `rate_limits` holds request counters and the per-diagnosis follow-up count.
-- Each row now records when it stops mattering, so expired rows can be removed
-- with one indexed query instead of the table growing without limit.
-- Backfill: existing rows expire two days after their window began (longer
-- than any window the app uses). The default keeps the previous version of the
-- app, which does not set this column, working.

ALTER TABLE "rate_limits" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;
UPDATE "rate_limits" SET "expires_at" = "window_start" + INTERVAL '2 days' WHERE "expires_at" IS NULL;
ALTER TABLE "rate_limits" ALTER COLUMN "expires_at" SET DEFAULT (NOW() + INTERVAL '2 days'), ALTER COLUMN "expires_at" SET NOT NULL;

-- ───────────────────────── 9. Relations ─────────────────────────
-- Present on every known version of the database; added here only if missing.
-- Delete behaviour is deliberate:
--   deleting an account removes its vehicles, service records and tokens;
--   deleting a vehicle removes that vehicle's service records.
-- Nothing is ever left pointing at a row that no longer exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'garage_vehicles'::regclass AND conname = 'garage_vehicles_user_id_fkey') THEN
    ALTER TABLE "garage_vehicles" ADD CONSTRAINT "garage_vehicles_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'maintenance_records'::regclass AND conname = 'maintenance_records_user_id_fkey') THEN
    ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'maintenance_records'::regclass AND conname = 'maintenance_records_vehicle_id_fkey') THEN
    ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vehicle_id_fkey"
      FOREIGN KEY ("vehicle_id") REFERENCES "garage_vehicles"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'email_verification_tokens'::regclass AND conname = 'email_verification_tokens_user_id_fkey') THEN
    ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ───────────────────────── 10. Indexes for the lookups the app makes ─────────────────────────

CREATE INDEX IF NOT EXISTS "garage_vehicles_user_id_created_at_idx" ON "garage_vehicles"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "maintenance_records_vehicle_id_created_at_idx" ON "maintenance_records"("vehicle_id", "created_at");
CREATE INDEX IF NOT EXISTS "maintenance_records_user_id_created_at_idx" ON "maintenance_records"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_expires_at_idx" ON "email_verification_tokens"("expires_at");
CREATE INDEX IF NOT EXISTS "rate_limits_expires_at_idx" ON "rate_limits"("expires_at");
CREATE INDEX IF NOT EXISTS "feedback_created_at_idx" ON "feedback"("created_at");
