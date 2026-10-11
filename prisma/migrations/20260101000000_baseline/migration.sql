-- BASELINE
--
-- The database exactly as the application's old start-up code built it (the
-- `ensureDB()` function and the table check in the feedback route, as they
-- stood at Phase 2C).
--
-- On a database that already exists (production), this migration is NOT run.
-- It is recorded as already applied, because those tables are already there:
--     prisma migrate resolve --applied 20260101000000_baseline
-- `scripts/db-migrate.mjs` does that automatically when it finds the app's
-- tables but no migration history.
--
-- On an empty database (a new environment, a test database) it runs normally
-- and creates the same starting point, so every database then goes through the
-- same later migrations.
--
-- Creates: 7 tables, 2 indexes.  Changes: nothing.  Drops: nothing.

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "google_id" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "profile_image" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "email_verified" TIMESTAMPTZ,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "legacy_unverified" BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_unique" ON "users" (LOWER("email")) WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX "users_google_id_unique" ON "users" ("google_id") WHERE "google_id" IS NOT NULL;

CREATE TABLE "sessions" (
    "sid" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid")
);

CREATE TABLE "garage_vehicles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "year" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "engine" TEXT,
    "vin" TEXT,
    "nickname" TEXT,
    "is_active" BOOLEAN DEFAULT FALSE,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "garage_vehicles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "maintenance_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "vehicle_id" TEXT NOT NULL REFERENCES "garage_vehicles"("id") ON DELETE CASCADE,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "mileage" TEXT,
    "cost" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "feedback" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "rating" INTEGER,
    "message" TEXT NOT NULL,
    "page" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "page_url" TEXT,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key", "window_start")
);

CREATE TABLE "email_verification_tokens" (
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("token_hash")
);
