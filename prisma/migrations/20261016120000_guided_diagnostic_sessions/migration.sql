-- GUIDED DIAGNOSTIC SESSIONS (Guided Diagnostics V2G, research)
--
-- Adds two new, empty tables for persisted guided-diagnostic sessions and
-- their append-only revision history. NOTHING IN THE APP READS OR WRITES THEM
-- YET. It only ADDS. Nothing that exists is dropped, renamed, retyped or
-- changed, so every earlier version of the app keeps working against the
-- database before, during and after it.
--
-- Creates : tables `guided_diagnostic_sessions` and
--           `guided_diagnostic_session_revisions`, with their indexes, foreign
--           keys and check constraints.
-- Changes : nothing that exists. No column is added to any existing table.
-- Backfills: none.
-- Drops   : nothing.
-- Data loss: none.
-- Locks   : creating the foreign keys briefly takes a SHARE ROW EXCLUSIVE lock
--           on `users` and `garage_vehicles` (blocks writes to them for
--           milliseconds; reads continue). The new tables are empty.
-- Deploy order: may run before or after the application code: no code uses
--           these tables yet.
-- Atomic  : the whole file runs as one transaction. If any statement fails,
--           nothing in this file is applied.
--
-- Delete behaviour, decided on purpose (see
-- docs/research/guided-diagnostics/v2g-persistence.md, "Vehicle relation"):
--   - deleting an ACCOUNT removes its sessions with it;
--   - deleting a VEHICLE for good removes its sessions with it (ON DELETE
--     CASCADE). The app only ever deletes a vehicle that is already archived,
--     and then deletes all of its history; this keeps that delete working
--     unchanged, with no new failure. Archiving deletes nothing;
--   - a session's revision history goes with its session.
--
-- The pinned vehicle description inside `payload` is history: later edits to
-- the garage vehicle never rewrite it.

-- Fail rather than wait behind a busy table (see converge_and_expand).
SET LOCAL lock_timeout = '15s';

-- ───────────────────────── 1. Sessions ─────────────────────────

CREATE TABLE "guided_diagnostic_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "workflow_version" INTEGER NOT NULL,
    "workflow_fingerprint" TEXT NOT NULL,
    "persistence_version" INTEGER NOT NULL,
    "session_format_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'active',
    "current_step" TEXT,
    "payload" JSONB NOT NULL,
    "integrity_algorithm" TEXT NOT NULL,
    "payload_digest" TEXT NOT NULL,
    "create_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "guided_diagnostic_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guided_diagnostic_sessions_lifecycle_check" CHECK ("lifecycle" IN ('active', 'completed')),
    CONSTRAINT "guided_diagnostic_sessions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "guided_diagnostic_sessions_versions_check" CHECK ("persistence_version" >= 1 AND "session_format_version" >= 1),
    -- A completed session always carries the time it completed, and only then.
    CONSTRAINT "guided_diagnostic_sessions_completed_check" CHECK (("lifecycle" = 'completed') = ("completed_at" IS NOT NULL))
);

-- ───────────────────────── 2. Append-only revision history ─────────────────────────

CREATE TABLE "guided_diagnostic_session_revisions" (
    "session_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "transition" TEXT NOT NULL,
    "input_count" INTEGER NOT NULL,
    "step_id" TEXT,
    "lifecycle" TEXT NOT NULL,
    "current_step" TEXT,
    "end_result" TEXT,
    "payload_digest" TEXT NOT NULL,
    "input_origin" TEXT NOT NULL DEFAULT 'direct',
    "ai_text_ref" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One row per revision: a retried or concurrent save cannot record the same revision twice.
    CONSTRAINT "guided_diagnostic_session_revisions_pkey" PRIMARY KEY ("session_id","revision"),
    CONSTRAINT "guided_diagnostic_session_revisions_revision_check" CHECK ("revision" >= 1 AND "input_count" >= 0),
    CONSTRAINT "guided_diagnostic_session_revisions_transition_check" CHECK ("transition" IN ('start', 'input')),
    CONSTRAINT "guided_diagnostic_session_revisions_lifecycle_check" CHECK ("lifecycle" IN ('active', 'completed')),
    CONSTRAINT "guided_diagnostic_session_revisions_origin_check" CHECK ("input_origin" IN ('direct', 'ai_parser')),
    -- AI-parsed input is referenced by a hash of the text, never the text, and only for AI-parsed input.
    CONSTRAINT "guided_diagnostic_session_revisions_ai_ref_check" CHECK (("input_origin" = 'ai_parser') = ("ai_text_ref" IS NOT NULL))
);

-- ───────────────────────── 3. Indexes for the lookups the store makes ─────────────────────────

-- A retried start finds the session it already made.
CREATE UNIQUE INDEX "guided_diagnostic_sessions_user_id_create_key_key" ON "guided_diagnostic_sessions"("user_id", "create_key");

-- A user's active (or completed) sessions, most recent first.
CREATE INDEX "guided_diagnostic_sessions_user_id_lifecycle_updated_at_idx" ON "guided_diagnostic_sessions"("user_id", "lifecycle", "updated_at");

-- One vehicle's sessions.
CREATE INDEX "guided_diagnostic_sessions_vehicle_id_created_at_idx" ON "guided_diagnostic_sessions"("vehicle_id", "created_at");

-- ───────────────────────── 4. Relations ─────────────────────────

ALTER TABLE "guided_diagnostic_sessions" ADD CONSTRAINT "guided_diagnostic_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guided_diagnostic_sessions" ADD CONSTRAINT "guided_diagnostic_sessions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "garage_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guided_diagnostic_session_revisions" ADD CONSTRAINT "guided_diagnostic_session_revisions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "guided_diagnostic_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
