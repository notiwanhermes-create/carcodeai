/**
 * What the database itself refuses, whatever the app does: broken links between
 * rows, duplicates, and impossible values. Also the indexes the app relies on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import * as db from "../db";

export function constraintSuite() {
  db.dbDescribe("database rules", () => {
    let pool: Pool;
    const savedUrl = process.env.DATABASE_URL;
    const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
    const refuses = (sql: string, constraint: RegExp) => expect(pool.query(sql)).rejects.toThrow(constraint);

    beforeAll(() => {
      pool = db.newPool();
    });
    afterAll(async () => {
      await pool.end();
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
    });
    beforeEach(async () => {
      await db.buildFromEmpty(pool);
      await pool.query(`
        INSERT INTO users (id, email, google_id) VALUES ('ann', 'ann@example.test', 'g-ann'), ('bob', 'bob@example.test', NULL);
        INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ('ann-car', 'ann', '2015', 'Toyota', 'Camry'), ('bob-car', 'bob', '2020', 'Honda', 'Civic');
        INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date) VALUES ('ann-rec', 'ann', 'ann-car', 'Oil Change', '2026-01-15'), ('bob-rec', 'bob', 'bob-car', 'Brakes', '2026-02-01');
        INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ('ann-token', 'ann', NOW() + INTERVAL '1 day');
      `);
    });
    afterEach(async () => {
      await db.closeAppConnections();
    });

    it("refuses rows that point at something that does not exist", async () => {
      await refuses(`INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ('x', 'nobody', '2015', 'A', 'B')`, /garage_vehicles_user_id_fkey/);
      await refuses(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date) VALUES ('x', 'ann', 'no-car', 'T', '2026-01-01')`, /maintenance_records_vehicle_id_fkey/);
      await refuses(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date) VALUES ('x', 'nobody', 'ann-car', 'T', '2026-01-01')`, /maintenance_records_user_id_fkey/);
      await refuses(`INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ('x', 'nobody', NOW())`, /email_verification_tokens_user_id_fkey/);
    });

    it("deleting a vehicle removes its service records and nothing else", async () => {
      await pool.query(`DELETE FROM garage_vehicles WHERE id = 'ann-car'`);
      expect((await rows(`SELECT id FROM maintenance_records ORDER BY id`)).map((r) => r.id)).toEqual(["bob-rec"]);
      expect((await rows(`SELECT id FROM garage_vehicles ORDER BY id`)).map((r) => r.id)).toEqual(["bob-car"]);
      expect(await count("users")).toBe(2);
    });

    it("deleting an account removes that person's vehicles, records and tokens, and nobody else's", async () => {
      await pool.query(`DELETE FROM users WHERE id = 'ann'`);
      expect((await rows(`SELECT id FROM garage_vehicles`)).map((r) => r.id)).toEqual(["bob-car"]);
      expect((await rows(`SELECT id FROM maintenance_records`)).map((r) => r.id)).toEqual(["bob-rec"]);
      expect(await count("email_verification_tokens")).toBe(0);
      expect((await rows(`SELECT id FROM users`)).map((r) => r.id)).toEqual(["bob"]);
    });

    it("declares exactly the delete behaviour that was reviewed", async () => {
      const fks = await rows(`
        SELECT c.conname, c.confdeltype AS on_delete, c.confupdtype AS on_update
          FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = 'public' AND c.contype = 'f' ORDER BY c.conname`);
      // c = cascade, a = no action
      expect(fks).toEqual([
        { conname: "confirmed_fixes_diagnosis_id_fkey", on_delete: "c", on_update: "c" }, // an outcome goes with its diagnosis
        { conname: "confirmed_fixes_user_id_fkey", on_delete: "c", on_update: "c" },
        { conname: "confirmed_fixes_vehicle_id_fkey", on_delete: "a", on_update: "c" }, //   a vehicle with history cannot be deleted from under it
        { conname: "diagnoses_user_id_fkey", on_delete: "c", on_update: "c" },
        { conname: "diagnoses_vehicle_id_fkey", on_delete: "a", on_update: "c" },
        { conname: "email_verification_tokens_user_id_fkey", on_delete: "c", on_update: "c" },
        { conname: "garage_vehicles_user_id_fkey", on_delete: "c", on_update: "a" },
        { conname: "guided_diagnostic_session_revisions_session_id_fkey", on_delete: "c", on_update: "c" }, // V2G: history goes with its session
        { conname: "guided_diagnostic_sessions_user_id_fkey", on_delete: "c", on_update: "c" },
        { conname: "guided_diagnostic_sessions_vehicle_id_fkey", on_delete: "c", on_update: "c" }, //   V2G: deleting a vehicle for good (only once archived) takes its sessions with it
        { conname: "maintenance_records_user_id_fkey", on_delete: "c", on_update: "a" },
        { conname: "maintenance_records_vehicle_id_fkey", on_delete: "c", on_update: "a" },
      ]);
    });

    it("refuses a second account with the same email or the same Google identity", async () => {
      await refuses(`INSERT INTO users (id, email) VALUES ('x', 'ann@example.test')`, /users_email_key/);
      await refuses(`INSERT INTO users (id, email, google_id) VALUES ('x', 'x@example.test', 'g-ann')`, /users_google_id_key/);
      // The same address in another letter case is not a different address.
      await refuses(`INSERT INTO users (id, email) VALUES ('x', 'ANN@example.test')`, /users_email_lowercase/);
      // Accounts without an email, or without Google, do not collide with each other.
      await pool.query(`INSERT INTO users (id, email, google_id) VALUES ('n1', NULL, NULL), ('n2', NULL, NULL)`);
      expect(await count("users")).toBe(4);
    });

    it("reports a duplicate email to the app as the error it already handles", async () => {
      const { prisma } = await db.freshApp();
      await expect(prisma.user.create({ data: { email: "ann@example.test" } })).rejects.toMatchObject({ code: "P2002" });
      // Lookups by email and by Google identity use the unique indexes.
      expect((await prisma.user.findUnique({ where: { email: "ann@example.test" }, select: { id: true } }))?.id).toBe("ann");
      expect((await prisma.user.findUnique({ where: { googleId: "g-ann" }, select: { id: true } }))?.id).toBe("ann");
    });

    it("refuses impossible typed values", async () => {
      await refuses(`UPDATE garage_vehicles SET model_year = 1850 WHERE id = 'ann-car'`, /garage_vehicles_model_year_check/);
      await refuses(`UPDATE garage_vehicles SET model_year = 2101 WHERE id = 'ann-car'`, /garage_vehicles_model_year_check/);
      await refuses(`UPDATE maintenance_records SET odometer_value = -1 WHERE id = 'ann-rec'`, /maintenance_records_odometer_check/);
      await refuses(`UPDATE maintenance_records SET odometer_value = 10, odometer_unit = 'furlongs' WHERE id = 'ann-rec'`, /maintenance_records_odometer_check/);
      await refuses(`UPDATE maintenance_records SET cost_amount = -0.01 WHERE id = 'ann-rec'`, /maintenance_records_cost_amount_check/);
      await refuses(`UPDATE maintenance_records SET service_date = '2026-02-31' WHERE id = 'ann-rec'`, /date/i);
      // Sensible values, and "not known", are accepted.
      await pool.query(`UPDATE garage_vehicles SET model_year = 2015 WHERE id = 'ann-car'`);
      await pool.query(`UPDATE maintenance_records SET odometer_value = 0, odometer_unit = 'km', cost_amount = 0, service_date = '2024-02-29' WHERE id = 'ann-rec'`);
      await pool.query(`UPDATE maintenance_records SET odometer_value = NULL, odometer_unit = NULL, cost_amount = NULL, service_date = NULL WHERE id = 'ann-rec'`);
    });

    it("keeps saved diagnoses and confirmed repairs consistent", async () => {
      const diagnosis = (id: string, extra: Record<string, string> = {}) => {
        const cols = { id: `'${id}'`, user_id: "'ann'", vehicle_id: "'ann-car'", vehicle_snapshot: `'{}'`, result: `'{}'`, ...extra };
        return `INSERT INTO diagnoses (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`;
      };
      await pool.query(diagnosis("d1", { ticket_id: "'t-1'", import_key: "'k-1'" }));
      expect((await rows(`SELECT status, source, language, update_count, codes, follow_ups, diagnosed_at IS NOT NULL AS dated FROM diagnoses WHERE id = 'd1'`))[0]).toEqual({
        status: "open", source: "app", language: "en", update_count: 0, codes: [], follow_ups: [], dated: true,
      });

      // Only the three statuses and two sources exist; readings are never negative or in a made-up unit.
      await refuses(`UPDATE diagnoses SET status = 'maybe' WHERE id = 'd1'`, /diagnoses_status_check/);
      await refuses(`UPDATE diagnoses SET source = 'somewhere' WHERE id = 'd1'`, /diagnoses_source_check/);
      await refuses(`UPDATE diagnoses SET odometer_value = -1 WHERE id = 'd1'`, /diagnoses_odometer_check/);
      await refuses(`UPDATE diagnoses SET odometer_value = 10, odometer_unit = 'leagues' WHERE id = 'd1'`, /diagnoses_odometer_check/);
      await refuses(`UPDATE garage_vehicles SET odometer_value = -5 WHERE id = 'ann-car'`, /garage_vehicles_odometer_check/);
      await refuses(`UPDATE garage_vehicles SET odometer_value = 5, odometer_unit = 'leagues' WHERE id = 'ann-car'`, /garage_vehicles_odometer_check/);

      // One follow-up ticket, and one device record, map to one diagnosis per account.
      await refuses(diagnosis("d2", { ticket_id: "'t-1'" }), /diagnoses_user_id_ticket_id_key/);
      await refuses(diagnosis("d2", { import_key: "'k-1'" }), /diagnoses_user_id_import_key_key/);
      await pool.query(diagnosis("d2")); // without either, any number is fine
      await pool.query(diagnosis("d3", { user_id: "'bob'", vehicle_id: "'bob-car'", ticket_id: "'t-1'", import_key: "'k-1'" })); // another account's are its own

      // A diagnosis needs a real vehicle and a real account.
      await refuses(diagnosis("d4", { vehicle_id: "'no-car'" }), /diagnoses_vehicle_id_fkey/);
      await refuses(diagnosis("d4", { user_id: "'nobody'" }), /diagnoses_user_id_fkey/);

      // A reported repair: never blank, one row per attempt, and a known outcome.
      const fix = (id: string, description: string, attempt = 1) =>
        `INSERT INTO confirmed_fixes (id, user_id, vehicle_id, diagnosis_id, description, fixed_on, attempt) VALUES ('${id}', 'ann', 'ann-car', 'd1', '${description}', '2026-10-12', ${attempt})`;
      await refuses(fix("f0", "   "), /confirmed_fixes_description_check/);
      await pool.query(fix("f1", "Ignition coil"));
      expect((await rows(`SELECT attempt, outcome, returned_at FROM confirmed_fixes WHERE id = 'f1'`))[0]).toEqual({ attempt: 1, outcome: "fixed", returned_at: null });
      await refuses(fix("f2", "Spark plugs"), /confirmed_fixes_diagnosis_id_attempt_key/); // the same attempt twice
      await refuses(fix("f2", "Spark plugs", 0), /confirmed_fixes_attempt_check/);
      await refuses(`UPDATE confirmed_fixes SET outcome = 'maybe'`, /confirmed_fixes_outcome_check/);
      // "It came back" always carries when it was said, and only then.
      await refuses(`UPDATE confirmed_fixes SET outcome = 'did_not_hold'`, /confirmed_fixes_returned_check/);
      await refuses(`UPDATE confirmed_fixes SET returned_at = NOW()`, /confirmed_fixes_returned_check/);
      await pool.query(`UPDATE confirmed_fixes SET outcome = 'did_not_hold', returned_at = NOW()`);
      // A later attempt sits beside the earlier one: a diagnosis keeps its whole repair history.
      await pool.query(fix("f2", "Spark plugs", 2));
      expect(await count("confirmed_fixes")).toBe(2);
      await refuses(`UPDATE confirmed_fixes SET odometer_value = -1`, /confirmed_fixes_odometer_check/);
      await refuses(`INSERT INTO confirmed_fixes (id, user_id, vehicle_id, diagnosis_id, description, fixed_on) VALUES ('f3', 'ann', 'ann-car', 'no-diagnosis', 'x', '2026-10-12')`, /confirmed_fixes_diagnosis_id_fkey/);

      // A vehicle cannot be deleted from under its history...
      await refuses(`DELETE FROM garage_vehicles WHERE id = 'ann-car'`, /diagnoses_vehicle_id_fkey|confirmed_fixes_vehicle_id_fkey/);
      expect(await count("garage_vehicles")).toBe(2);
      // ...reported repairs go with their diagnosis...
      await pool.query(`DELETE FROM diagnoses WHERE id = 'd1'`);
      expect(await count("confirmed_fixes")).toBe(0);
      // ...and deleting an account takes its diagnoses with it, and nobody else's.
      await pool.query(`DELETE FROM users WHERE id = 'ann'`);
      expect((await rows(`SELECT id FROM diagnoses`)).map((r) => r.id)).toEqual(["d3"]);
      expect((await rows(`SELECT id FROM garage_vehicles`)).map((r) => r.id)).toEqual(["bob-car"]);
    });

    it("requires the values every row must have, and fills in the ones with defaults", async () => {
      await refuses(`INSERT INTO garage_vehicles (id, user_id, year, make) VALUES ('x', 'ann', '2015', 'A')`, /"model"/);
      await refuses(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type) VALUES ('x', 'ann', 'ann-car', 'T')`, /"date"/);
      await refuses(`INSERT INTO feedback (name) VALUES ('no message')`, /"message"/);
      await refuses(`UPDATE users SET created_at = NULL WHERE id = 'ann'`, /"created_at"/);
      await refuses(`UPDATE garage_vehicles SET created_at = NULL WHERE id = 'ann-car'`, /"created_at"/);

      const user = (await rows(`SELECT created_at, session_version, legacy_unverified, email_verified FROM users WHERE id = 'ann'`))[0];
      expect(user).toMatchObject({ session_version: 0, legacy_unverified: false, email_verified: null });
      expect(user.created_at).toBeInstanceOf(Date);
      expect((await rows(`SELECT is_active, created_at IS NOT NULL AS stamped FROM garage_vehicles WHERE id = 'ann-car'`))[0]).toEqual({ is_active: false, stamped: true });
    });

    it("keeps one counter per key and window, each with an expiry", async () => {
      await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ('k', '2026-10-01T00:00:00Z', 1)`);
      await refuses(`INSERT INTO rate_limits (key, window_start, count) VALUES ('k', '2026-10-01T00:00:00Z', 1)`, /rate_limits_pkey/);
      await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ('k', '2026-10-02T00:00:00Z', 1)`);
      await refuses(`UPDATE rate_limits SET expires_at = NULL`, /"expires_at"/);
      // A writer that does not know about expiry (the previous version of the app) still gets one.
      expect((await rows(`SELECT COUNT(*)::int AS n FROM rate_limits WHERE expires_at > NOW()`))[0].n).toBe(2);
    });

    it("has an index for every lookup the app makes", async () => {
      const indexes = Object.fromEntries((await rows(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`)).map((i) => [i.indexname, i.indexdef as string]));
      expect(Object.keys(indexes).sort()).toEqual([
        "confirmed_fixes_diagnosis_id_attempt_key", //  one row per reported repair of a diagnosis
        "confirmed_fixes_pkey",
        "confirmed_fixes_user_id_created_at_idx",
        "confirmed_fixes_vehicle_id_fixed_on_idx", //   a vehicle's timeline
        "diagnoses_pkey",
        "diagnoses_user_id_import_key_key", //          an import cannot create the same diagnosis twice
        "diagnoses_user_id_status_diagnosed_at_idx", // a user's open issues
        "diagnoses_user_id_ticket_id_key", //           a follow-up finds its diagnosis
        "diagnoses_vehicle_id_diagnosed_at_idx", //     a vehicle's timeline
        "email_verification_tokens_expires_at_idx", // clearing out expired tokens
        "email_verification_tokens_pkey", //            checking a link
        "email_verification_tokens_user_id_idx", //     replacing a user's tokens
        "feedback_created_at_idx", //                   admin list, newest first
        "feedback_pkey",
        "garage_vehicles_pkey",
        "garage_vehicles_user_id_created_at_idx", //    a user's garage, newest first
        "guided_diagnostic_session_revisions_pkey", //  V2G: one row per revision of a session
        "guided_diagnostic_sessions_pkey",
        "guided_diagnostic_sessions_user_id_create_key_key", //       V2G: a retried start finds its session
        "guided_diagnostic_sessions_user_id_lifecycle_updated_at_idx", // V2G: a user's active sessions
        "guided_diagnostic_sessions_vehicle_id_created_at_idx", //    V2G: one vehicle's sessions
        "maintenance_records_pkey",
        "maintenance_records_user_id_created_at_idx", // a user's service history
        "maintenance_records_vehicle_id_created_at_idx", // one vehicle's service history
        "rate_limits_expires_at_idx", //                clearing out expired counters
        "rate_limits_pkey", //                          the counter itself
        "users_email_key", //                           sign-in by email
        "users_google_id_key", //                       sign-in with Google
        "users_pkey",
      ]);
      expect(indexes.users_email_key).toMatch(/UNIQUE INDEX users_email_key ON public\.users USING btree \(email\)$/);
      expect(indexes.users_google_id_key).toMatch(/UNIQUE INDEX users_google_id_key ON public\.users USING btree \(google_id\)$/);
      expect(indexes.garage_vehicles_user_id_created_at_idx).toMatch(/\(user_id, created_at\)$/);
      expect(indexes.maintenance_records_vehicle_id_created_at_idx).toMatch(/\(vehicle_id, created_at\)$/);
    });

    it("stores each kind of value as the right type", async () => {
      const types = Object.fromEntries(
        (await rows(`SELECT table_name || '.' || column_name AS col, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`)).map((c) => [c.col, c.data_type]),
      );
      expect(types).toMatchObject({
        "users.created_at": "timestamp with time zone",
        "users.email_verified": "timestamp with time zone",
        "users.session_version": "integer",
        "users.legacy_unverified": "boolean",
        "garage_vehicles.year": "text", //                 exactly what the user typed
        "garage_vehicles.model_year": "integer",
        "garage_vehicles.is_active": "boolean",
        "garage_vehicles.created_at": "timestamp with time zone",
        "garage_vehicles.odometer_value": "integer",
        "garage_vehicles.odometer_unit": "text",
        "garage_vehicles.odometer_updated_at": "timestamp with time zone",
        "garage_vehicles.archived_at": "timestamp with time zone",
        "diagnoses.result": "jsonb", //                    the structured answer
        "diagnoses.codes": "jsonb",
        "diagnoses.follow_ups": "jsonb",
        "diagnoses.vehicle_snapshot": "jsonb",
        "diagnoses.symptoms": "text",
        "diagnoses.diagnosed_at": "timestamp with time zone",
        "diagnoses.odometer_value": "integer",
        "confirmed_fixes.description": "text",
        "confirmed_fixes.fixed_on": "date",
        "confirmed_fixes.matched_cause_rank": "integer",
        "confirmed_fixes.attempt": "integer",
        "confirmed_fixes.outcome": "text",
        "confirmed_fixes.returned_at": "timestamp with time zone",
        "maintenance_records.date": "text", //             exactly what the user typed
        "maintenance_records.service_date": "date",
        "maintenance_records.mileage": "text", //          exactly what the user typed
        "maintenance_records.odometer_value": "integer",
        "maintenance_records.odometer_unit": "text",
        "maintenance_records.cost": "text", //             exactly what the user typed
        "maintenance_records.cost_amount": "numeric",
        "maintenance_records.created_at": "timestamp with time zone",
        "rate_limits.window_start": "timestamp with time zone",
        "rate_limits.expires_at": "timestamp with time zone",
        "rate_limits.count": "integer",
        "feedback.id": "bigint", //                         as in production
        "feedback.page_url": "text",
        "feedback.rating": "integer",
        "feedback.created_at": "timestamp with time zone",
        "email_verification_tokens.expires_at": "timestamp with time zone",
      });
      expect(types["feedback.page"]).toBeUndefined();
    });
  });
}
