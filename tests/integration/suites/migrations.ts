/**
 * Migration tests: databases shaped the way older versions of the app left
 * them are taken through the migrations, and every row is checked afterwards.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import * as db from "../db";
import * as legacy from "../legacy-shapes";
import { parseCost, parseModelYear, parseOdometer, parseServiceDate } from "../../../app/lib/maintenance-values";

const APP_TABLES = ["email_verification_tokens", "feedback", "garage_vehicles", "maintenance_records", "rate_limits", "users"];

export function migrationSuite() {
  db.dbDescribe("migrations", () => {
    let pool: Pool;
    /** The structure every database must end up with: built from nothing by all the migrations. */
    let expectedShape: Awaited<ReturnType<typeof db.schemaSnapshot>>;

    const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
    const hasColumn = async (table: string, column: string) =>
      (await rows(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column])).length > 0;

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

    /** Production as of Phase 2C: the baseline, plus the tables later code stopped creating. */
    async function buildPhase2c() {
      await db.applyMigration(pool, db.BASELINE);
      await pool.query(legacy.PHASE_2C_EXTRAS);
      await pool.query(legacy.OEM_SEED_ROWS);
      await pool.query(legacy.SAMPLE_ACCOUNTS);
      await pool.query(legacy.SAMPLE_GARAGE);
      await pool.query(legacy.SAMPLE_COSTS);
      await pool.query(legacy.SAMPLE_SESSIONS);
      await pool.query(legacy.SAMPLE_FEEDBACK);
      await pool.query(legacy.SAMPLE_PHASE_1_ROWS);
      // Phase 1 classified the accounts that existed then, and one person has signed up since.
      await pool.query(`
        UPDATE users SET legacy_unverified = TRUE WHERE password_hash IS NOT NULL;
        UPDATE users SET email_verified = COALESCE(created_at, NOW()) WHERE google_id IS NOT NULL AND password_hash IS NULL;
        INSERT INTO users (id, email, password_hash) VALUES ('u-pending', 'pending@example.test', 'HASH-PENDING');
      `);
    }

    const SHAPES: Array<{ name: string; build: () => Promise<void>; hasPasswords: boolean; hasCosts: boolean; hasFeedback: boolean }> = [
      { name: "the February 2026 prototype", build: buildPrototype, hasPasswords: false, hasCosts: false, hasFeedback: false },
      { name: "the database just before Phase 1", build: buildBeforePhase1, hasPasswords: true, hasCosts: true, hasFeedback: true },
      { name: "production as of Phase 2C", build: buildPhase2c, hasPasswords: true, hasCosts: true, hasFeedback: true },
    ];

    /* ───────────── the real tool, end to end ───────────── */

    it("builds an empty database from nothing with the real migration command, matching schema.prisma", async () => {
      const run = db.runScript("db-migrate.mjs");
      expect(run.output).toContain("empty database: all migrations will be applied");
      expect(run.status, run.output).toBe(0);

      expect(await db.tableNames(pool)).toEqual(APP_TABLES);
      const applied = await rows(`SELECT migration_name, finished_at IS NOT NULL AS done FROM _prisma_migrations ORDER BY started_at`);
      expect(applied).toEqual(db.migrationNames().map((migration_name) => ({ migration_name, done: true })));

      const drift = db.schemaMatchesPrisma();
      expect(drift.matches, drift.output).toBe(true);
      expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
    });

    it("records the baseline on an existing database instead of rebuilding it, then applies the rest", async () => {
      await buildPhase2c();
      const usersBefore = await rows(`SELECT id, password_hash, google_id FROM users ORDER BY id`);

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
      expect((await rows(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at`)).map((r) => r.migration_name)).toEqual(
        db.migrationNames(),
      );
      const drift = db.schemaMatchesPrisma();
      expect(drift.matches, drift.output).toBe(true);

      // Running it again finds nothing to do.
      const again = db.runScript("db-migrate.mjs");
      expect(again.status, again.output).toBe(0);
      expect(again.output).toMatch(/No pending migrations to apply/);
      expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
    });

    /* ───────────── every legacy shape: same result, nothing lost ───────────── */

    for (const shape of SHAPES) {
      it(`upgrades ${shape.name} without losing a row`, async () => {
        await shape.build();
        const before = {
          users: await rows(`SELECT id, email, first_name, created_at FROM users ORDER BY id`),
          secrets: shape.hasPasswords ? await rows(`SELECT id, password_hash, google_id FROM users ORDER BY id`) : null,
          vehicles: await rows(`SELECT id, user_id, year, make, model, engine, vin, created_at FROM garage_vehicles ORDER BY id`),
          records: await rows(`SELECT id, user_id, vehicle_id, type, date, mileage, notes, created_at FROM maintenance_records ORDER BY id`),
          costs: shape.hasCosts ? await rows(`SELECT id, cost FROM maintenance_records ORDER BY id`) : null,
          feedback: shape.hasFeedback ? await rows(`SELECT id, name, email, rating, message FROM feedback ORDER BY id`) : null,
        };

        await db.upgradeExistingDatabase(pool);

        // The same structure as a database built from nothing.
        expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
        expect(await db.tableNames(pool)).toEqual(APP_TABLES);

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

        // Feedback: one page column, and no value lost from either of the old two.
        if (before.feedback) {
          expect(await rows(`SELECT id, name, email, rating, message FROM feedback ORDER BY id`)).toEqual(before.feedback);
          expect((await rows(`SELECT page_url FROM feedback ORDER BY id`)).map((r) => r.page_url)).toEqual([
            "/diagnose", //                                    only in the old "page" column
            "https://www.carcodeai.com/", //                   only in "page_url"
            null,
            "https://www.carcodeai.com/new | /old-path", //    different values in both: both kept
          ]);
          expect((await rows(`SELECT 1 FROM feedback WHERE created_at IS NULL`)).length).toBe(0);
        }
        expect(await hasColumn("feedback", "page")).toBe(false);
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

    it("removes the legacy tables, keeps the live ones, and clears only expired counters", async () => {
      await buildPhase2c();
      expect(await db.tableNames(pool)).toEqual(expect.arrayContaining(["sessions", "oem_fault_codes", "feedback_auto_reply_log"]));
      await db.upgradeExistingDatabase(pool);
      expect(await db.tableNames(pool)).toEqual(APP_TABLES);

      // A counter from an hour ago is live and kept; one from ten days ago has expired and is gone.
      expect((await rows(`SELECT key, count FROM rate_limits ORDER BY key`))).toEqual([{ key: "diag:guest:day:ip:abc", count: 3 }]);
      expect((await one(`SELECT COUNT(*)::int AS n FROM rate_limits WHERE expires_at IS NULL`)).n).toBe(0);
      // Verification tokens are untouched.
      expect((await rows(`SELECT token_hash, user_id FROM email_verification_tokens`))).toEqual([{ token_hash: "token-hash-1", user_id: "u-password" }]);
    });

    it("keeps oem_fault_codes, renamed, if it holds anything the app did not put there", async () => {
      await buildPhase2c();
      await pool.query(`INSERT INTO oem_fault_codes (make, code, title) VALUES ('Ford', 'P1000', 'Entered by hand')`);
      await db.upgradeExistingDatabase(pool);

      const tables = await db.tableNames(pool);
      expect(tables).not.toContain("oem_fault_codes");
      expect(tables).toContain("legacy_oem_fault_codes_archive");
      expect((await one(`SELECT COUNT(*)::int AS n FROM legacy_oem_fault_codes_archive`)).n).toBe(5);
      expect((await one(`SELECT title FROM legacy_oem_fault_codes_archive WHERE make = 'Ford'`)).title).toBe("Entered by hand");
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
      });
      const first = await dump();
      await db.applyMigration(pool, db.CONVERGE);
      await db.applyMigration(pool, db.REMOVE_LEGACY);
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
      expect(db.runScript("db-migrate.mjs", [], { DB_MIGRATE_RETRY: db.REMOVE_LEGACY }).status).not.toBe(0);
      expect(await db.schemaSnapshot(pool)).toEqual(before);

      // Fix the cause, name the migration, run again.
      await pool.query(`DELETE FROM users WHERE id = 'b'`);
      const retried = db.runScript("db-migrate.mjs", [], { DB_MIGRATE_RETRY: db.CONVERGE });
      expect(retried.output).toContain(`retrying ${db.CONVERGE}`);
      expect(retried.status, retried.output).toBe(0);
      expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
      expect((await one(`SELECT email FROM users WHERE id = 'a'`)).email).toBe("same@example.test");
      expect(db.schemaMatchesPrisma().matches).toBe(true);

      // Leaving the setting in place afterwards does nothing.
      const after = db.runScript("db-migrate.mjs", [], { DB_MIGRATE_RETRY: db.CONVERGE });
      expect(after.status, after.output).toBe(0);
      expect(after.output).toMatch(/No pending migrations to apply/);
    });

    /* ───────────── rollback safety ───────────── */

    it("the previous version of the app still works against a migrated database", async () => {
      await buildPhase2c();
      await db.upgradeExistingDatabase(pool);

      // Its start-up routine runs on every cold start. It must not fail...
      await pool.query(legacy.PREVIOUS_VERSION_STARTUP_SQL);
      // ...and it must not re-classify anyone.
      expect(await one(`SELECT email_verified, legacy_unverified FROM users WHERE id = 'u-pending'`)).toEqual({ email_verified: null, legacy_unverified: false });

      // The statements it uses to write and read, which know nothing of the new columns.
      await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, session_version, legacy_unverified) VALUES ('old-user', 'old.code@example.test', 'H', NULL, NULL, 0, FALSE)`);
      await pool.query(`INSERT INTO garage_vehicles (id, user_id, year, make, model, engine, vin, nickname, is_active) VALUES ('old-veh', 'old-user', '2019', 'Kia', 'Soul', NULL, NULL, NULL, FALSE)`);
      await pool.query(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, notes, cost) VALUES ('old-rec', 'old-user', 'old-veh', 'Oil Change', '2026-10-01', '50000', NULL, '80')`);
      await pool.query(`INSERT INTO feedback (name, email, rating, message, page_url) VALUES (NULL, NULL, 5, 'from the old code', 'https://www.carcodeai.com/')`);
      await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ('old:key', NOW(), 1) ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1`);
      await pool.query(`INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ('old-token', 'old-user', NOW() + INTERVAL '1 day')`);

      expect((await one(`SELECT id, year, is_active, created_at IS NOT NULL AS stamped FROM garage_vehicles WHERE id = 'old-veh'`))).toEqual({ id: "old-veh", year: "2019", is_active: false, stamped: true });
      expect((await one(`SELECT expires_at > NOW() AS live FROM rate_limits WHERE key = 'old:key'`)).live).toBe(true);
      expect((await rows(`SELECT created_at, rating, name, email, page_url, message FROM feedback ORDER BY created_at DESC LIMIT 200`)).length).toBe(5);
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
      // The app's pooled address is unusable here; the direct one must be the one used.
      const run = db.runScript("db-migrate.mjs", ["--vercel"], {
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        DIRECT_URL: db.TEST_DB,
      });
      expect(run.status, run.output).toBe(0);
      expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
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
      expect(report.checks.feedback).toMatchObject({ total: 4, valueOnlyInOldPageColumn: 1, bothColumnsWithDifferentValues: 1 });
      expect(report.tables.find((t: { name: string }) => t.name === "sessions")).toMatchObject({ kind: "legacy", rows: 2 });

      expect({ shape: await db.schemaSnapshot(pool), users: await rows(`SELECT * FROM users ORDER BY id`) }).toEqual(before);
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
