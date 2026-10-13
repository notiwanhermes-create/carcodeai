-- GARAGE HISTORY (Phase 2E)
--
-- Adds what the garage needs to become the place where a vehicle's history
-- lives: saved diagnoses, the repairs users confirm, and a current odometer
-- reading per vehicle. It only ADDS. Nothing is dropped, renamed or retyped, so
-- the previous version of the app keeps working against the database before,
-- during and after it.
--
-- Creates : tables `diagnoses` and `confirmed_fixes`, with their indexes,
--           foreign keys and check constraints; five optional columns on
--           `garage_vehicles` (trim, odometer_value, odometer_unit,
--           odometer_updated_at, archived_at) and one check constraint.
-- Changes : nothing that exists.
-- Backfills: a vehicle's current odometer reading is filled in from its most
--           recent service record that has a clean numeric reading. Vehicles
--           without such a record are left empty. No existing value is changed.
-- Drops   : nothing. What older versions left behind (`sessions`,
--           `oem_fault_codes` and so on) is still not touched here.
-- Data loss: none.
-- Locks   : adding nullable columns and a check constraint takes a brief
--           exclusive lock on `garage_vehicles` (small table: milliseconds).
--           The two new tables lock nothing that exists.
-- Deploy order: run this BEFORE the new application code goes live. The old
--           code is unaffected by it: it does not know the new tables, and
--           every new column is optional.
-- Atomic  : the whole file runs as one transaction. If any statement fails,
--           nothing in this file is applied.
--
-- Delete behaviour, decided on purpose:
--   - deleting an ACCOUNT removes its diagnoses and confirmed fixes with it;
--   - a VEHICLE that has diagnoses or confirmed fixes cannot be deleted from
--     under them (ON DELETE NO ACTION). The app archives such a vehicle instead;
--   - a confirmed fix goes with its diagnosis.

-- Fail rather than wait behind a busy table (see converge_and_expand).
SET LOCAL lock_timeout = '15s';

-- ───────────────────────── 1. Vehicles: trim, current odometer, archive ─────────────────────────

ALTER TABLE "garage_vehicles" ADD COLUMN     "archived_at" TIMESTAMPTZ,
ADD COLUMN     "odometer_unit" TEXT,
ADD COLUMN     "odometer_updated_at" TIMESTAMPTZ,
ADD COLUMN     "odometer_value" INTEGER,
ADD COLUMN     "trim" TEXT;

ALTER TABLE "garage_vehicles" ADD CONSTRAINT "garage_vehicles_odometer_check"
  CHECK ("odometer_value" >= 0 AND ("odometer_unit" IS NULL OR "odometer_unit" IN ('km', 'mi')));

-- Backfill: the most recent service record with a clean reading becomes the
-- vehicle's current reading. The unit is copied only if that record had one.
UPDATE "garage_vehicles" AS v
   SET "odometer_value" = r."odometer_value",
       "odometer_unit" = r."odometer_unit",
       "odometer_updated_at" = COALESCE(r."service_date"::TIMESTAMPTZ, r."created_at")
  FROM (
    SELECT DISTINCT ON ("vehicle_id") "vehicle_id", "odometer_value", "odometer_unit", "service_date", "created_at"
      FROM "maintenance_records"
     WHERE "odometer_value" IS NOT NULL
     ORDER BY "vehicle_id", "service_date" DESC NULLS LAST, "created_at" DESC
  ) AS r
 WHERE r."vehicle_id" = v."id"
   AND v."odometer_value" IS NULL;

-- ───────────────────────── 2. Saved diagnoses ─────────────────────────

CREATE TABLE "diagnoses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "status_changed_at" TIMESTAMPTZ,
    "reviewed_at" TIMESTAMPTZ,
    "source" TEXT NOT NULL DEFAULT 'app',
    "language" TEXT NOT NULL DEFAULT 'en',
    "vehicle_snapshot" JSONB NOT NULL,
    "code_input" TEXT NOT NULL DEFAULT '',
    "symptoms" TEXT NOT NULL DEFAULT '',
    "codes" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB NOT NULL,
    "follow_ups" JSONB NOT NULL DEFAULT '[]',
    "update_count" INTEGER NOT NULL DEFAULT 0,
    "odometer_value" INTEGER,
    "odometer_unit" TEXT,
    "ticket_id" TEXT,
    "import_key" TEXT,
    "diagnosed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "diagnoses_status_check" CHECK ("status" IN ('open', 'resolved', 'dismissed')),
    CONSTRAINT "diagnoses_source_check" CHECK ("source" IN ('app', 'device_import')),
    CONSTRAINT "diagnoses_odometer_check"
      CHECK ("odometer_value" >= 0 AND ("odometer_unit" IS NULL OR "odometer_unit" IN ('km', 'mi')))
);

-- ───────────────────────── 3. Confirmed fixes ─────────────────────────

CREATE TABLE "confirmed_fixes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "diagnosis_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "matched_cause_rank" INTEGER,
    "matched_cause_title" TEXT,
    "fixed_on" DATE NOT NULL,
    "odometer_value" INTEGER,
    "odometer_unit" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confirmed_fixes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "confirmed_fixes_description_check" CHECK (BTRIM("description") <> ''),
    CONSTRAINT "confirmed_fixes_odometer_check"
      CHECK ("odometer_value" >= 0 AND ("odometer_unit" IS NULL OR "odometer_unit" IN ('km', 'mi')))
);

-- ───────────────────────── 4. Indexes for the lookups the app makes ─────────────────────────

-- One vehicle's history, newest first.
CREATE INDEX "diagnoses_vehicle_id_diagnosed_at_idx" ON "diagnoses"("vehicle_id", "diagnosed_at");

-- A user's open issues.
CREATE INDEX "diagnoses_user_id_status_diagnosed_at_idx" ON "diagnoses"("user_id", "status", "diagnosed_at");

-- A follow-up update finds its diagnosis by the id in its signed ticket.
CREATE UNIQUE INDEX "diagnoses_user_id_ticket_id_key" ON "diagnoses"("user_id", "ticket_id");

-- An import from a device cannot create the same diagnosis twice.
CREATE UNIQUE INDEX "diagnoses_user_id_import_key_key" ON "diagnoses"("user_id", "import_key");

-- One outcome per diagnosis.
CREATE UNIQUE INDEX "confirmed_fixes_diagnosis_id_key" ON "confirmed_fixes"("diagnosis_id");

CREATE INDEX "confirmed_fixes_vehicle_id_fixed_on_idx" ON "confirmed_fixes"("vehicle_id", "fixed_on");

CREATE INDEX "confirmed_fixes_user_id_created_at_idx" ON "confirmed_fixes"("user_id", "created_at");

-- ───────────────────────── 5. Relations ─────────────────────────

ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "garage_vehicles"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "confirmed_fixes" ADD CONSTRAINT "confirmed_fixes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "confirmed_fixes" ADD CONSTRAINT "confirmed_fixes_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "garage_vehicles"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "confirmed_fixes" ADD CONSTRAINT "confirmed_fixes_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnoses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
