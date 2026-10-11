/**
 * Migration tests: databases shaped the way older versions of the app left
 * them are taken through the migrations, and every row is checked afterwards.
 *
 * This release's migrations only ADD. So the tests check three things about
 * every older database: the app's own tables end up in one known shape, no row
 * is lost, and everything older versions left behind is still exactly as it was.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import * as db from "../db";
import * as legacy from "../legacy-shapes";
import { parseCost, parseModelYear, parseOdometer, parseServiceDate } from "../../../app/lib/maintenance-values";

const APP_TABLES = db.APP_TABLES;

/** The release a rollback returns to (Phase 2C). Its code is run for real when this copy of the repository has it. */
const PREVIOUS_RELEASE = "e79758c";
const hasPreviousRelease = spawnSync("git", ["cat-file", "-e", `${PREVIOUS_RELEASE}^{commit}`], { cwd: db.ROOT }).status === 0;

export function migrationSuite() {
  db.dbDescribe("migrations", () => {
    let pool: Pool;
    /** The shape of the app's tables in a database built from nothing by all the migrations. */
    let expectedShape: Awaited<ReturnType<typeof db.schemaSnapshot>>;

    const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
    const hasColumn = async (table: string, column: string) =>
      (await rows(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column])).length > 0;
    /** The app's own tables, as they are now. */
    const appShapeNow = async () => db.appShape(await db.schemaSnapshot(pool));

    beforeAll(async () => {
      pool = db.newPool();
      await db.buildFromEmpty(pool);
      expectedShape = await db.schemaSnapshot(pool);
    });
    afterAll(async () => {
      await pool.end();
    });
    beforeEach(async () => {
      await db.emptyDatabase(pool);
    });

    /* ───────────── databases as older versions left them ───────────── */

    /** February 2026 prototype: no passwords, no feedback, no limits. */
    async function buildPrototype() {
      await pool.query(legacy.PROTOTYPE_SCHEMA);
      await pool.query(`
        INSERT INTO users (id, email, first_name, created_at) VALUES
          ('u-password', 'pw.user@example.test',     'Pat', '2026-02-11T10:00:00Z'),
          ('u-google',   'google.user@example.test', 'Gil', '2026-02-12T10:00:00Z'),
          ('u-both',     'Both.User@Example.TEST',   'Bo',  NULL),
          ('u-noemail',  NULL,                       NULL,  '2026-03-01T10:00:00Z');
        INSERT INTO auth_pending (state, code_verifier, origin_host) VALUES ('st', 'cv', 'host');
        INSERT INTO auth_tokens (token, sid, origin_host) VALUES ('tok', 'sid', 'host');
      `);
      await pool.query(legacy.SAMPLE_GARAGE);
      await pool.query(legacy.SAMPLE_SESSIONS);
    }

    /** Just before Phase 1: passwords and Google exist, nothing about verification or limits. */
    async function buildBeforePhase1() {
      await pool.query(legacy.BEFORE_PHASE_1_SCHEMA);
      await pool.query(legacy.OEM_SEED_ROWS);
      await pool.query(legacy.SAMPLE_ACCOUNTS);
      await pool.query(legacy.SAMPLE_GARAGE);
      await pool.query(legacy.SAMPLE_COSTS);
      await pool.query(legacy.SAMPLE_SESSIONS);
      await pool.query(legacy.SAMPLE_FEEDBACK);
      await pool.query(`INSERT INTO feedback_auto_reply_log (email_lower, ip_hash) VALUES ('someone@example.test', 'iphash')`);
    }

    /**
     * Production as of Phase 2C: built by that version's own start-up SQL, plus
     * the tables that earlier versions created and later ones stopped creating.
     */
    async function buildPhase2c() {
      await pool.query(legacy.PREVIOUS_VERSION_STARTUP_SQL);
      await pool.query(legacy.PHASE_2C_EXTRAS);
      await pool.query(legacy.OEM_SEED_ROWS);
      await pool.query(legacy.SAMPLE_ACCOUNTS);
      await pool.query(legacy.SAMPLE_GARAGE);
      await pool.query(legacy.SAMPLE_COSTS);
      await pool.query(legacy.SAMPLE_SESSIONS);
      await pool.query(legacy.SAMPLE_FEEDBACK);
      await pool.query(legacy.SAMPLE_PHASE_1_ROWS);
      await pool.query(`INSERT INTO feedback_auto_reply_log (email_lower, ip_hash) VALUES ('someone@example.test', 'iphash')`);
      // Phase 1 classified the accounts that existed then, and one person has signed up since.
      await pool.query(`
        UPDATE users SET legacy_unverified = TRUE WHERE password_hash IS NOT NULL;
        UPDATE users SET email_verified = COALESCE(created_at, NOW()) WHERE google_id IS NOT NULL AND password_hash IS NULL;
        INSERT INTO users (id, email, password_hash) VALUES ('u-pending', 'pending@example.test', 'HASH-PENDING');
      `);
    }

    type Shape = {
      name: string;
      build: () => Promise<void>;
      hasPasswords: boolean;
      hasCosts: boolean;
      hasFeedback: boolean;
      /** Tables this shape holds that the app no longer uses. All must survive. */
      leftoverTables: string[];
    };
    const SHAPES: Shape[] = [
      { name: "the February 2026 prototype", build: buildPrototype, hasPasswords: false, hasCosts: false, hasFeedback: false, leftoverTables: ["auth_pending", "auth_tokens", "sessions"] },
      { name: "the database just before Phase 1", build: buildBeforePhase1, hasPasswords: true, hasCosts: true, hasFeedback: true, leftoverTables: ["feedback_auto_reply_log", "oem_fault_codes", "sessions"] },
      { name: "production as of Phase 2C", build: buildPhase2c, hasPasswords: true, hasCosts: true, hasFeedback: true, leftoverTables: ["feedback_auto_reply_log", "oem_fault_codes", "sessions"] },
    ];

    /* ───────────── the real tool, end to end ───────────── */

    it("builds an empty database from nothing with the real migration command, matching schema.prisma", async () => {
      const run = db.runScript("db-migrate.mjs");
      expect(run.output).toContain("empty database: all migrations will be applied");
      expect(run.status, run.output).toBe(0);

      // A new database holds the app's six tables and nothing from older versions.
      expect(await db.tableNames(pool)).toEqual(APP_TABLES);
      expect(await db.leftovers(pool)).toEqual({ tables: {}, columns: {}, indexes: [] });
      const applied = await rows(`SELECT migration_name, finished_at IS NOT NULL AS done FROM _prisma_migrations ORDER BY started_at`);
      expect(applied).toEqual([
        { migration_name: db.BASELINE, done: true },
        { migration_name: db.CONVERGE, done: true },
      ]);

      const drift = db.schemaMatchesPrisma();
      expect(drift.matches, drift.output).toBe(true);
      expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
    });

    it("records the baseline on an existing database instead of rebuilding it, then applies the rest", async () => {
      await buildPhase2c();
      const usersBefore = await rows(`SELECT id, password_hash, google_id FROM users ORDER BY id`);
      const leftBehind = await db.leftovers(pool);

      // Prisma on its own refuses a database that has tables but no history...
      const refused = db.runPrisma(["migrate", "deploy"]);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain("P3005");
      expect(await hasColumn("garage_vehicles", "model_year")).toBe(false);

      // ...so the project's command records the baseline first. Nothing is recreated.
      const run = db.runScript("db-migrate.mjs");
      expect(run.output).toContain("recording the baseline as already applied");
      expect(run.status, run.output).toBe(0);

      expect(await rows(`SELECT id, password_hash, google_id FROM users ORDER BY id`)).toEqual(usersBefore);
      expect((await rows(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at`)).map((r) => r.migration_name)).toEqual([
        db.BASELINE,
        db.CONVERGE,
      ]);
      expect(await appShapeNow()).toEqual(db.appShape(expectedShape));
      expect(await db.leftovers(pool)).toEqual(leftBehind);

      // Running it again finds nothing to do.
      const again = db.runScript("db-migrate.mjs");
      expect(again.status, again.output).toBe(0);
      expect(again.output).toMatch(/No pending migrations to apply/);
      expect(await appShapeNow()).toEqual(db.appShape(expectedShape));
      expect(await db.leftovers(pool)).toEqual(leftBehind);
    });

    /* ───────────── every legacy shape: same result, nothing lost, nothing removed ───────────── */

    for (const shape of SHAPES) {
      it(`upgrades ${shape.name} without losing a row or removing anything`, async () => {
        await shape.build();
        const before = {
          users: await rows(`SELECT id, email, first_name, created_at FROM users ORDER BY id`),
          secrets: shape.hasPasswords ? await rows(`SELECT id, password_hash, google_id FROM users ORDER BY id`) : null,
          vehicles: await rows(`SELECT id, user_id, year, make, model, engine, vin, created_at FROM garage_vehicles ORDER BY id`),
          records: await rows(`SELECT id, user_id, vehicle_id, type, date, mileage, notes, created_at FROM maintenance_records ORDER BY id`),
          costs: shape.hasCosts ? await rows(`SELECT id, cost FROM maintenance_records ORDER BY id`) : null,
          feedback: shape.hasFeedback ? await rows(`SELECT id, name, email, rating, message, page FROM feedback ORDER BY id`) : null,
          leftBehind: await db.leftovers(pool),
        };
        expect(Object.keys(before.leftBehind.tables).sort()).toEqual(shape.leftoverTables);

        await db.upgradeExistingDatabase(pool);

        // The app's own tables: the same structure as a database built from nothing.
        expect(await appShapeNow()).toEqual(db.appShape(expectedShape));

        // Everything older versions left behind is still there, row for row.
        expect(await db.tableNames(pool)).toEqual([...APP_TABLES, ...shape.leftoverTables].sort());
        expect(await db.leftovers(pool)).toEqual(before.leftBehind);

        // Accounts: every one is still there, with the same password and Google identity.
        const users = await rows(`SELECT id, email, first_name, created_at FROM users ORDER BY id`);
        expect(users.map((u) => u.id)).toEqual(before.users.map((u) => u.id));
        for (const [i, u] of users.entries()) {
          const was = before.users[i];
          expect(u.email, u.id).toBe(was.email === null ? null : String(was.email).toLowerCase());
          expect(u.first_name).toBe(was.first_name);
          expect(u.created_at, `${u.id} has a creation time`).not.toBeNull();
          if (was.created_at) expect(u.created_at).toEqual(was.created_at);
        }
        if (before.secrets) expect(await rows(`SELECT id, password_hash, google_id FROM users ORDER BY id`)).toEqual(before.secrets);

        // Vehicles: what the user entered is untouched, including the odd ones.
        const vehicles = await rows(`SELECT id, user_id, year, make, model, engine, vin, created_at, model_year FROM garage_vehicles ORDER BY id`);
        expect(vehicles).toHaveLength(before.vehicles.length);
        for (const [i, v] of vehicles.entries()) {
          const was = before.vehicles[i];
          expect({ id: v.id, user_id: v.user_id, year: v.year, make: v.make, model: v.model, engine: v.engine, vin: v.vin }).toEqual({
            id: was.id, user_id: was.user_id, year: was.year, make: was.make, model: was.model, engine: was.engine, vin: was.vin,
          });
          expect(v.created_at).not.toBeNull();
          if (was.created_at) expect(v.created_at).toEqual(was.created_at);
        }
        expect(Object.fromEntries(vehicles.map((v) => [v.id, v.model_year]))).toEqual({ "v-accord": 2003, "v-camry": 2015, "v-odd": null, "v-old": null });
        expect((await one(`SELECT year FROM garage_vehicles WHERE id = 'v-accord'`)).year).toBe(" 2003 ");

        // Service records: text untouched, typed copies only where the text converts cleanly.
        const records = await rows(
          `SELECT id, user_id, vehicle_id, type, date, mileage, notes, created_at,
                  to_char(service_date, 'YYYY-MM-DD') AS service_date, odometer_value, odometer_unit, cost, cost_amount::text AS cost_amount
             FROM maintenance_records ORDER BY id`,
        );
        expect(records).toHaveLength(before.records.length);
        for (const [i, r] of records.entries()) {
          const was = before.records[i];
          expect({ id: r.id, user_id: r.user_id, vehicle_id: r.vehicle_id, type: r.type, date: r.date, mileage: r.mileage, notes: r.notes }).toEqual({
            id: was.id, user_id: was.user_id, vehicle_id: was.vehicle_id, type: was.type, date: was.date, mileage: was.mileage, notes: was.notes,
          });
          expect(r.created_at).not.toBeNull();
        }
        if (before.costs) expect(records.map((r) => ({ id: r.id, cost: r.cost }))).toEqual(before.costs);
        const typed = Object.fromEntries(records.map((r) => [r.id, [r.service_date, r.odometer_value, r.odometer_unit, shape.hasCosts ? r.cost_amount : null]]));
        expect(typed).toEqual({
          "m-baddate": [null, null, null, null], //            "last tuesday", "about 90k", "120,50"
          "m-clean": ["2026-01-15", 120000, null, shape.hasCosts ? "120.00" : null],
          "m-commas": ["2026-02-01", 121500, "km", shape.hasCosts ? "1250.50" : null],
          "m-feb31": [null, null, null, null], //              "2026-02-31", "120.000", "free"
          "m-miles": ["2025-12-31", 75500, "mi", shape.hasCosts ? "89.90" : null],
          "m-nomiles": ["2026-03-05", null, null, null],
        });

        // Feedback: "page_url" is filled where it was empty, and the old "page" column keeps every value it had.
        if (before.feedback) {
          expect(await rows(`SELECT id, name, email, rating, message, page FROM feedback ORDER BY id`)).toEqual(before.feedback);
          expect((await rows(`SELECT page_url FROM feedback ORDER BY id`)).map((r) => r.page_url)).toEqual([
            "/diagnose", //                     was only in the old "page" column: copied across
            "https://www.carcodeai.com/", //    already in "page_url"
            null,
            "https://www.carcodeai.com/new", // both columns had a value: "page_url" is left alone
          ]);
          expect((await rows(`SELECT 1 FROM feedback WHERE created_at IS NULL`)).length).toBe(0);
        }
        expect(await hasColumn("feedback", "page")).toBe(shape.hasFeedback);
        expect(await hasColumn("feedback", "page_url")).toBe(true);
      });
    }

    it("classifies accounts exactly once: on a database that never had email verification", async () => {
      await buildBeforePhase1();
      await db.upgradeExistingDatabase(pool);
      const state = Object.fromEntries(
        (await rows(`SELECT id, email_verified IS NOT NULL AS verified, legacy_unverified, session_version FROM users`)).map((u) => [u.id, u]),
      );
      // Had a password: keeps working, but is not trusted as a proven email owner.
      expect(state["u-password"]).toMatchObject({ verified: false, legacy_unverified: true, session_version: 0 });
      expect(state["u-both"]).toMatchObject({ verified: false, legacy_unverified: true });
      // Google only: Google vouched for the address.
      expect(state["u-google"]).toMatchObject({ verified: true, legacy_unverified: false });
      expect((await one(`SELECT password_hash FROM users WHERE id = 'u-password'`)).password_hash).toBe("HASH-PASSWORD");
    });

    it("does not reclassify anyone on a database that already had email verification", async () => {
      await buildPhase2c();
      const before = await rows(`SELECT id, email_verified, legacy_unverified, session_version FROM users ORDER BY id`);
      await db.upgradeExistingDatabase(pool);
      expect(await rows(`SELECT id, email_verified, legacy_unverified, session_version FROM users ORDER BY id`)).toEqual(before);
      // Someone who signed up after Phase 1 and has not confirmed yet is still simply "pending".
      expect(await one(`SELECT email_verified, legacy_unverified FROM users WHERE id = 'u-pending'`)).toEqual({ email_verified: null, legacy_unverified: false });
    });

    it("removes nothing: legacy tables, the old feedback column, old indexes and old counters all stay", async () => {
      await buildPhase2c();
      // Something a person may have added by hand, which no clean-up may ever throw away unseen.
      await pool.query(`INSERT INTO oem_fault_codes (make, code, title) VALUES ('Ford', 'P1000', 'Entered by hand')`);
      const count = async (table: string) => Number((await one(`SELECT COUNT(*)::int AS n FROM "${table}"`)).n);
      const tablesBefore = await db.tableNames(pool);
      const countsBefore = Object.fromEntries(await Promise.all(tablesBefore.map(async (t) => [t, await count(t)] as const)));

      await db.upgradeExistingDatabase(pool);

      // No table went away, and no table lost a row.
      expect(await db.tableNames(pool)).toEqual(tablesBefore);
      expect(Object.fromEntries(await Promise.all(tablesBefore.map(async (t) => [t, await count(t)] as const)))).toEqual(countsBefore);
      expect(countsBefore).toMatchObject({ sessions: 2, oem_fault_codes: 5, feedback_auto_reply_log: 1, feedback: 4, rate_limits: 2, email_verification_tokens: 1 });

      // The old feedback column and both old indexes are still there.
      expect((await rows(`SELECT page FROM feedback ORDER BY id`)).map((r) => r.page)).toEqual(["/diagnose", null, null, "/old-path"]);
      expect((await rows(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users' ORDER BY 1`)).map((r) => r.indexname)).toEqual([
        "users_email_key", //         new
        "users_email_unique", //      old, kept
        "users_google_id_key", //     new
        "users_google_id_unique", //  old, kept
        "users_pkey",
      ]);

      // Counters are all kept, each now with the time it stops mattering. (The
      // running app clears expired ones itself; the migration deletes none.)
      expect(await rows(`SELECT key, count, expires_at > NOW() AS live FROM rate_limits ORDER BY key`)).toEqual([
        { key: "diag:guest:day:ip:abc", count: 3, live: true }, // from an hour ago
        { key: "login:ip:abc", count: 9, live: false }, //         from ten days ago
      ]);
      expect((await rows(`SELECT token_hash, user_id FROM email_verification_tokens`))).toEqual([{ token_hash: "token-hash-1", user_id: "u-password" }]);
    });

    it("changes nothing when run a second time", async () => {
      await buildPhase2c();
      await db.upgradeExistingDatabase(pool);
      const dump = async () => ({
        shape: await db.schemaSnapshot(pool),
        users: await rows(`SELECT * FROM users ORDER BY id`),
        vehicles: await rows(`SELECT * FROM garage_vehicles ORDER BY id`),
        records: await rows(`SELECT * FROM maintenance_records ORDER BY id`),
        feedback: await rows(`SELECT * FROM feedback ORDER BY id`),
        counters: await rows(`SELECT * FROM rate_limits ORDER BY key`),
        leftBehind: await db.leftovers(pool),
      });
      const first = await dump();
      await db.applyMigration(pool, db.CONVERGE);
      expect(await dump()).toEqual(first);
    });

    /* ───────────── refusing to guess ───────────── */

    it("stops, changing nothing at all, when two accounts share one email address", async () => {
      // Only possible on a database that never had the old uniqueness index.
      await pool.query(legacy.PROTOTYPE_SCHEMA);
      await pool.query(`INSERT INTO users (id, email) VALUES ('a', 'same@example.test'), ('b', 'SAME@example.test')`);
      const before = await db.schemaSnapshot(pool);

      await expect(db.applyMigration(pool, db.CONVERGE)).rejects.toThrow(/1 email address\(es\) are used by more than one account\. Nothing was changed/);

      // The whole migration was rolled back: not even the first new column exists.
      expect(await db.schemaSnapshot(pool)).toEqual(before);
      expect(await hasColumn("users", "password_hash")).toBe(false);
      expect((await rows(`SELECT email FROM users ORDER BY id`)).map((r) => r.email)).toEqual(["same@example.test", "SAME@example.test"]);
    });

    it("stops when one Google identity is linked to two accounts", async () => {
      await pool.query(legacy.PROTOTYPE_SCHEMA);
      await pool.query(`ALTER TABLE users ADD COLUMN google_id TEXT; INSERT INTO users (id, email, google_id) VALUES ('a', 'a@example.test', 'g-1'), ('b', 'b@example.test', 'g-1')`);
      await expect(db.applyMigration(pool, db.CONVERGE)).rejects.toThrow(/1 Google identity\(ies\) are linked to more than one account/);
    });

    it("a failed migration through the real command leaves the database as it was, and is retried only when told to", async () => {
      await pool.query(legacy.PROTOTYPE_SCHEMA);
      await pool.query(`INSERT INTO users (id, email) VALUES ('a', 'same@example.test'), ('b', 'SAME@example.test')`);
      const before = await db.schemaSnapshot(pool);

      const failed = db.runScript("db-migrate.mjs");
      expect(failed.status).not.toBe(0);
      expect(failed.output).toContain("used by more than one account");
      expect(failed.output).toContain("[db:migrate] FAILED");
      expect(await db.schemaSnapshot(pool)).toEqual(before); // nothing was applied

      // Running it again does not press on: it stops and names the migration.
      const blocked = db.runScript("db-migrate.mjs");
      expect(blocked.status).not.toBe(0);
      expect(blocked.output).toContain(`an earlier attempt at ${db.CONVERGE} failed and has not been cleared`);
      expect(blocked.output).toContain(`DB_MIGRATE_RETRY=${db.CONVERGE}`);
      // Naming a different migration clears nothing.
      expect(db.runScript("db-migrate.mjs", [], { DB_MIGRATE_RETRY: db.BASELINE }).status).not.toBe(0);
      expect(await db.schemaSnapshot(pool)).toEqual(before);

      // Fix the cause, name the migration, run again.
      await pool.query(`DELETE FROM users WHERE id = 'b'`);
      const retried = db.runScript("db-migrate.mjs", [], { DB_MIGRATE_RETRY: db.CONVERGE });
      expect(retried.output).toContain(`retrying ${db.CONVERGE}`);
      expect(retried.status, retried.output).toBe(0);
      expect(await appShapeNow()).toEqual(db.appShape(expectedShape));
      expect((await one(`SELECT email FROM users WHERE id = 'a'`)).email).toBe("same@example.test");
      // The prototype's own tables were not touched by any of this.
      expect(Object.keys((await db.leftovers(pool)).tables).sort()).toEqual(["auth_pending", "auth_tokens", "sessions"]);

      // Leaving the setting in place afterwards does nothing.
      const after = db.runScript("db-migrate.mjs", [], { DB_MIGRATE_RETRY: db.CONVERGE });
      expect(after.status, after.output).toBe(0);
      expect(after.output).toMatch(/No pending migrations to apply/);
    });

    /* ───────────── rollback: the previous version against the migrated database ───────────── */

    it("leaves in place everything the previous version (Phase 2C) reads and writes", async () => {
      await buildPhase2c();
      await db.upgradeExistingDatabase(pool);

      const columns = await rows(
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      for (const [table, model] of Object.entries(legacy.PHASE_2C_PRISMA_MODELS)) {
        const present = columns.filter((c) => c.table_name === table);
        // Every column that version's queries name still exists, with the type it expects.
        for (const [column, type] of Object.entries(model.columns)) {
          expect(present.find((c) => c.column_name === column)?.data_type, `${table}.${column}`).toBe(type);
        }
        // Every column that must have a value either has a default, or is one that version always supplies.
        for (const c of present) {
          if (c.is_nullable === "NO" && c.column_default === null) {
            expect(model.alwaysSupplied, `${table}.${c.column_name} is required and has no default`).toContain(c.column_name);
          }
        }
      }
      // What this release added is optional or has a default, so writes that do not mention it still succeed.
      const added = columns.filter((c) => legacy.PHASE_2C_PRISMA_MODELS[c.table_name] && !(c.column_name in legacy.PHASE_2C_PRISMA_MODELS[c.table_name].columns));
      expect(added.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
        "feedback.page_url", // (that version writes this one with plain SQL)
        "garage_vehicles.model_year",
        "maintenance_records.cost_amount",
        "maintenance_records.odometer_unit",
        "maintenance_records.odometer_value",
        "maintenance_records.service_date",
        "rate_limits.expires_at",
      ]);
      for (const c of added) expect(c.is_nullable === "YES" || c.column_default !== null, `${c.table_name}.${c.column_name}`).toBe(true);
    });

    it("the previous version's start-up routine and its own statements still work, and change nothing in the structure", async () => {
      await buildPhase2c();
      await db.upgradeExistingDatabase(pool);
      const structure = await db.schemaSnapshot(pool);

      // Its start-up routine runs on every cold start. It must not fail, and since
      // nothing it expects was removed, it must find nothing to create...
      await pool.query(legacy.PREVIOUS_VERSION_STARTUP_SQL);
      await pool.query(legacy.PREVIOUS_VERSION_STARTUP_SQL);
      expect(await db.schemaSnapshot(pool)).toEqual(structure);
      // ...and it must not re-classify anyone.
      expect(await one(`SELECT email_verified, legacy_unverified FROM users WHERE id = 'u-pending'`)).toEqual({ email_verified: null, legacy_unverified: false });

      // Its reads: every column of every table it knows, the way its database client asks for them.
      for (const [table, model] of Object.entries(legacy.PHASE_2C_PRISMA_MODELS)) {
        await pool.query(`SELECT ${Object.keys(model.columns).map((c) => `"${c}"`).join(", ")} FROM "${table}" LIMIT 5`);
      }

      // Its writes, which know nothing of the new columns.
      await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, created_at, session_version, legacy_unverified) VALUES ('old-user', 'old.code@example.test', 'H', NULL, NULL, NOW(), 0, FALSE)`);
      await pool.query(`INSERT INTO garage_vehicles (id, user_id, year, make, model, engine, vin, nickname, is_active, created_at) VALUES ('old-veh', 'old-user', '2019', 'Kia', 'Soul', NULL, NULL, NULL, FALSE, NOW())`);
      await pool.query(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, notes, cost, created_at) VALUES ('old-rec', 'old-user', 'old-veh', 'Oil Change', '2026-10-01', '50000', NULL, '80', NOW())`);
      await pool.query(`INSERT INTO feedback (name, email, rating, message, page_url) VALUES (NULL, NULL, 5, 'from the old code', 'https://www.carcodeai.com/')`);
      await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ('old:key', NOW(), 1) ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`);
      await pool.query(`INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at) VALUES ('old-token', 'old-user', NOW() + INTERVAL '1 day', NOW())`);
      await pool.query(`UPDATE users SET email_verified = NOW() WHERE id = 'old-user'`);
      await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = 'old-user'`);

      expect(await one(`SELECT id, year, is_active, model_year FROM garage_vehicles WHERE id = 'old-veh'`)).toEqual({ id: "old-veh", year: "2019", is_active: false, model_year: null });
      expect((await one(`SELECT expires_at > NOW() AS live FROM rate_limits WHERE key = 'old:key'`)).live).toBe(true);
      // Its admin page query.
      expect((await rows(`SELECT created_at, rating, name, email, page_url, message FROM feedback ORDER BY created_at DESC LIMIT 200`)).length).toBe(5);
      // Its vehicle delete: the vehicle's records first, then the vehicle.
      await pool.query(`DELETE FROM maintenance_records WHERE vehicle_id = 'old-veh' AND user_id = 'old-user'`);
      await pool.query(`DELETE FROM garage_vehicles WHERE id = 'old-veh'`);

      // The structure is still exactly what the migrations left.
      expect(await db.schemaSnapshot(pool)).toEqual(structure);
    });

    it.skipIf(!hasPreviousRelease)("the real previous version (Phase 2C code) runs against a database migrated by this release", () => {
      // scripts/rollback-check: the previous version builds and fills a database,
      // this release's migrations are applied, and the previous version is then
      // started again and exercised. See docs/database.md, "Rollback check".
      const run = db.runScript("rollback-check/run.mjs", [PREVIOUS_RELEASE]);
      expect(run.output).toContain("PASSED: the previous version");
      expect(run.status, run.output).toBe(0);
    });

    it("refuses an account email that is not lower case, so a lookup can never miss it", async () => {
      await db.buildFromEmpty(pool);
      await expect(pool.query(`INSERT INTO users (id, email) VALUES ('x', 'Mixed@Example.test')`)).rejects.toThrow(/users_email_lowercase/);
      await pool.query(`INSERT INTO users (id, email) VALUES ('x', 'mixed@example.test')`);
      await expect(pool.query(`INSERT INTO users (id, email) VALUES ('y', 'mixed@example.test')`)).rejects.toThrow(/users_email_key/);
    });

    /* ───────────── the SQL backfill and the app agree ───────────── */

    it("converts existing values by exactly the rules the app uses for new ones", async () => {
      const dates = ["2026-01-15", "2026-02-31", "2026-13-01", "15/01/2026", "2026-1-5", " 2026-03-01 ", "", "0000-01-01", "2024-02-29", "2023-02-29", "tomorrow"];
      const odometers = ["120000", "120,000", "1,234,567", "12,34", "120000 km", "120000km", "75,500 miles", "90 MI", "120.000", "about 90k", "0", "12345678", "1,234,567,890", " 5000 ", "", "5000 kilometres", "km"];
      const costs = ["120", "120.5", "120.50", "$120", "$ 120", "$1,250.50", "1,250", "120,50", "free", "0", "1234567890", "-5", "12.345", "$$5", "", "999999999.99"];
      const years = ["2015", " 2003 ", "1899", "2100", "2099", "1900", "20155", "abcd", ""];

      await db.applyMigration(pool, db.BASELINE);
      await pool.query(`INSERT INTO users (id, email) VALUES ('u', 'u@example.test')`);
      for (const [i, year] of years.entries()) {
        await pool.query(`INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ($1, 'u', $2, 'Make', 'Model')`, [`y${i}`, year]);
      }
      const n = Math.max(dates.length, odometers.length, costs.length);
      for (let i = 0; i < n; i++) {
        await pool.query(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, cost) VALUES ($1, 'u', 'y0', 'T', $2, $3, $4)`, [
          `r${i}`, dates[i] ?? "", odometers[i] ?? null, costs[i] ?? null,
        ]);
      }

      await db.upgradeExistingDatabase(pool);

      for (const v of await rows(`SELECT year, model_year FROM garage_vehicles`)) {
        expect(v.model_year, `year ${JSON.stringify(v.year)}`).toBe(parseModelYear(v.year));
      }
      const converted = await rows(
        `SELECT date, to_char(service_date, 'YYYY-MM-DD') AS service_date, mileage, odometer_value, odometer_unit, cost, cost_amount::text AS cost_amount FROM maintenance_records`,
      );
      for (const r of converted) {
        expect(r.service_date, `date ${JSON.stringify(r.date)}`).toBe(parseServiceDate(r.date)?.toISOString().slice(0, 10) ?? null);
        const reading = parseOdometer(r.mileage);
        expect([r.odometer_value, r.odometer_unit], `odometer ${JSON.stringify(r.mileage)}`).toEqual([reading?.value ?? null, reading?.unit ?? null]);
        expect(r.cost_amount, `cost ${JSON.stringify(r.cost)}`).toBe(parseCost(r.cost));
      }
      // The original text of every value is exactly as it was entered.
      expect((await rows(`SELECT date FROM maintenance_records ORDER BY id`)).map((r) => r.date).sort()).toEqual([...dates, ...Array(n - dates.length).fill("")].sort());
      // And the samples really do exercise both outcomes.
      expect(converted.filter((r) => r.service_date).length).toBeGreaterThan(2);
      expect(converted.filter((r) => r.service_date === null).length).toBeGreaterThan(2);
      expect(converted.filter((r) => r.odometer_value !== null).length).toBeGreaterThan(5);
      expect(converted.filter((r) => r.cost_amount !== null).length).toBeGreaterThan(5);
    });

    /* ───────────── the scripts ───────────── */

    it("never migrates from a preview build, without a database address, or when switched off", async () => {
      await buildPhase2c();
      const before = await db.schemaSnapshot(pool);

      const preview = db.runScript("db-migrate.mjs", ["--vercel"], { VERCEL_ENV: "preview" });
      expect(preview.status).toBe(0);
      expect(preview.output).toContain("skipped: not a production build (VERCEL_ENV=preview)");

      const local = db.runScript("db-migrate.mjs", ["--vercel"]);
      expect(local.output).toContain("skipped: not a production build (VERCEL_ENV=unset)");

      const noAddress = db.runScript("db-migrate.mjs", [], { DATABASE_URL: "" });
      expect(noAddress.status).toBe(0);
      expect(noAddress.output).toContain("skipped: no database address is configured");

      const off = db.runScript("db-migrate.mjs", [], { SKIP_DB_MIGRATE: "1" });
      expect(off.output).toContain("skipped (SKIP_DB_MIGRATE=1)");

      expect(await db.schemaSnapshot(pool)).toEqual(before);
      expect(await db.tableNames(pool)).not.toContain("_prisma_migrations");
    });

    it("migrates on a production build, preferring the direct connection address", async () => {
      await buildPhase2c();
      const leftBehind = await db.leftovers(pool);
      // The app's pooled address is unusable here; the direct one must be the one used.
      const run = db.runScript("db-migrate.mjs", ["--vercel"], {
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        DIRECT_URL: db.TEST_DB,
      });
      expect(run.status, run.output).toBe(0);
      expect(await appShapeNow()).toEqual(db.appShape(expectedShape));
      expect(await db.leftovers(pool)).toEqual(leftBehind);
    });

    it("reports on a database without changing it, and names what needs a decision", async () => {
      await buildBeforePhase1();
      await pool.query(`DROP INDEX users_email_unique; INSERT INTO users (id, email) VALUES ('dupe', 'PW.USER@example.test')`);
      await pool.query(`INSERT INTO oem_fault_codes (make, code, title) VALUES ('Ford', 'P1000', 'Entered by hand')`);
      const before = { shape: await db.schemaSnapshot(pool), users: await rows(`SELECT * FROM users ORDER BY id`) };

      const text = db.runScript("db-inspect.mjs");
      expect(text.status, text.output).toBe(0);
      expect(text.output).toContain("none: this database was built by the app's old start-up code");
      expect(text.output).toMatch(/1 email address\(es\) are used by more than one account/);
      expect(text.output).toMatch(/oem_fault_codes holds 1 row\(s\) the app did not create/);
      // Structure and counts only: no row contents.
      expect(text.output).not.toMatch(/pw\.user@example\.test|HASH-PASSWORD|Written by the first version/i);

      const report = JSON.parse(db.runScript("db-inspect.mjs", ["--json"]).output);
      expect(report.checks.users).toMatchObject({ total: 5, emailsNotLowerCaseOrTrimmed: 2, emailsSharedByMoreThanOneAccount: 1 });
      expect(report.checks.garage_vehicles).toMatchObject({ total: 4, yearNotAFourDigitYear: 2 });
      expect(report.checks.maintenance_records).toMatchObject({ total: 6, dateNotYearMonthDay: 1, odometerPresentButNotConvertible: 2, costPresentButNotConvertible: 2 });
      expect(report.checks.feedback).toMatchObject({ total: 4, valuesInOldPageColumn: 2, valueOnlyInOldPageColumn: 1, bothColumnsWithDifferentValues: 1 });
      expect(report.tables.find((t: { name: string }) => t.name === "sessions")).toMatchObject({ kind: "legacy", rows: 2 });

      expect({ shape: await db.schemaSnapshot(pool), users: await rows(`SELECT * FROM users ORDER BY id`) }).toEqual(before);
    });

    it("lists what older versions left behind, before and after migrating", async () => {
      await buildPhase2c();
      const expected = [
        "table feedback_auto_reply_log (1 row(s))",
        "table oem_fault_codes (4 row(s))",
        "table sessions (2 row(s))",
        "column feedback.page (2 value(s))",
        "index users_email_unique",
        "index users_google_id_unique",
      ];
      expect(JSON.parse(db.runScript("db-inspect.mjs", ["--json"]).output).leftovers).toEqual(expected);

      await db.upgradeExistingDatabase(pool);
      const after = db.runScript("db-inspect.mjs");
      expect(JSON.parse(db.runScript("db-inspect.mjs", ["--json"]).output).leftovers).toEqual(expected);
      expect(after.output).toContain("LEFT FROM OLDER VERSIONS (not used by the app; kept until a later clean-up)");
      expect(after.output).toContain("  - table sessions (2 row(s))");

      // A database built from nothing has none.
      await db.buildFromEmpty(pool);
      expect(JSON.parse(db.runScript("db-inspect.mjs", ["--json"]).output).leftovers).toEqual([]);
    });

    it("the report cannot write, even if it tried", async () => {
      await db.buildFromEmpty(pool);
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await expect(client.query(`INSERT INTO users (id, email) VALUES ('nope', 'nope@example.test')`)).rejects.toThrow(/read-only/);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });

    it("prunes only what has expired", async () => {
      await db.buildFromEmpty(pool);
      await pool.query(`
        INSERT INTO users (id, email) VALUES ('u', 'u@example.test');
        INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES
          ('live',    NOW(),                      1, NOW() + INTERVAL '1 hour'),
          ('expired', NOW() - INTERVAL '3 days',  9, NOW() - INTERVAL '1 day');
        INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES
          ('fresh',      'u', NOW() + INTERVAL '1 day'),
          ('just-ended', 'u', NOW() - INTERVAL '1 day'),
          ('long-gone',  'u', NOW() - INTERVAL '30 days');
      `);

      const dry = db.runScript("db-prune.mjs", ["--dry-run"]);
      expect(dry.output).toContain("would remove 1 expired counter(s) and 1 expired token(s)");
      expect((await one(`SELECT COUNT(*)::int AS n FROM rate_limits`)).n).toBe(2);

      const real = db.runScript("db-prune.mjs");
      expect(real.output).toContain("removed 1 expired counter(s) and 1 expired token(s)");
      expect((await rows(`SELECT key FROM rate_limits`)).map((r) => r.key)).toEqual(["live"]);
      expect((await rows(`SELECT token_hash FROM email_verification_tokens ORDER BY 1`)).map((r) => r.token_hash)).toEqual(["fresh", "just-ended"]);
      expect((await one(`SELECT COUNT(*)::int AS n FROM users`)).n).toBe(1);
    });
  });
}
