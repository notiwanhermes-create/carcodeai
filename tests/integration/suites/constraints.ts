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
        { conname: "email_verification_tokens_user_id_fkey", on_delete: "c", on_update: "c" },
        { conname: "garage_vehicles_user_id_fkey", on_delete: "c", on_update: "a" },
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
        "email_verification_tokens_expires_at_idx", // clearing out expired tokens
        "email_verification_tokens_pkey", //            checking a link
        "email_verification_tokens_user_id_idx", //     replacing a user's tokens
        "feedback_created_at_idx", //                   admin list, newest first
        "feedback_pkey",
        "garage_vehicles_pkey",
        "garage_vehicles_user_id_created_at_idx", //    a user's garage, newest first
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
