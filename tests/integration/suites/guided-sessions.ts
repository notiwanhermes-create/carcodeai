/**
 * Guided Diagnostics V2G against a real PostgreSQL database: the Prisma
 * adapter must give the session store exactly the in-memory repository's
 * behaviour, and the new tables must fit the garage's delete behaviour.
 *
 * Runs only with TEST_DATABASE_URL pointing at a database on this machine
 * (see ../db.ts). Never against production. Everything here is
 * SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../app/generated/prisma/client";
import * as db from "../db";
import { createInMemoryWorkflowResolver, createSessionStore } from "../../../app/lib/diagnostic-workflow-persistence";
import { createPrismaSessionRepository } from "../../../app/lib/diagnostic-workflow-persistence/prisma-repository";
import { ANN, sessionStoreContract } from "../../helpers/session-store-contract";
import { FUEL_FACTS, FUEL_ROUTE, W, persistThrough } from "../../helpers/persisted-sessions";

export function guidedSessionSuite() {
  db.dbDescribe("guided diagnostic sessions (V2G) in PostgreSQL", () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let n = 0;

    const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM "${table}"`))[0].n);

    /** Empty the garage and the session tables, then two users with one vehicle each. */
    async function resetGarage() {
      await pool.query(`TRUNCATE guided_diagnostic_session_revisions, guided_diagnostic_sessions, confirmed_fixes, diagnoses, maintenance_records, garage_vehicles, users CASCADE`);
      await pool.query(`
        INSERT INTO users (id, email) VALUES ('ann', 'ann@example.test'), ('bob', 'bob@example.test');
        INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES
          ('car-ann', 'ann', '2015', 'Synthetic', 'Test Car'),
          ('car-bob', 'bob', '2018', 'Synthetic', 'Other Car');
      `);
    }
    const store = () => createSessionStore({ repository: createPrismaSessionRepository(prisma), workflows: createInMemoryWorkflowResolver([W]), newId: () => `pg-${++n}` });

    beforeAll(async () => {
      pool = db.newPool();
      await db.buildFromEmpty(pool);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.TEST_DB, max: 4 }) });
    });
    afterAll(async () => {
      await prisma.$disconnect();
      await pool.end();
    });

    // Every contract test, against the real tables.
    sessionStoreContract("prisma", {
      repository: async () => {
        await resetGarage();
        return createPrismaSessionRepository(prisma);
      },
    });

    it("stores the session as one row plus one revision row per transition, with nothing but metadata in the history", async () => {
      await resetGarage();
      const { id } = await persistThrough(store(), ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE);
      expect(await rows(`SELECT user_id, vehicle_id, revision, lifecycle, current_step, persistence_version, session_format_version FROM guided_diagnostic_sessions`)).toEqual([
        { user_id: "ann", vehicle_id: "car-ann", revision: 6, lifecycle: "active", current_step: "verify_fuel_repair", persistence_version: 1, session_format_version: 1 },
      ]);
      expect((await rows(`SELECT revision, transition, step_id FROM guided_diagnostic_session_revisions WHERE session_id = $1 ORDER BY revision`, [id])).map((r) => r.transition)).toEqual(["start", "input", "input", "input", "input", "input"]);
      expect(Object.keys((await rows(`SELECT * FROM guided_diagnostic_session_revisions LIMIT 1`))[0]).sort()).not.toContain("payload");
    });

    it("keeps the pinned vehicle when the garage vehicle is edited", async () => {
      await resetGarage();
      const s = store();
      const { id, final } = await persistThrough(s, ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE);
      await pool.query(`UPDATE garage_vehicles SET make = 'Edited', model = 'Renamed', engine = 'v8', trim = 'X' WHERE id = 'car-ann'`);
      const again = await s.load(ANN, id);
      expect(again.status === "loaded" && again.session.facts.vehicle).toEqual(final.session.facts.vehicle);
    });

    it("fails closed on a row edited in the database", async () => {
      await resetGarage();
      const s = store();
      const { id } = await persistThrough(s, ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE);
      await pool.query(`UPDATE guided_diagnostic_sessions SET payload = jsonb_set(payload, '{supportedCauses}', '["ignition_coil"]') WHERE id = $1`, [id]);
      expect(await s.load(ANN, id)).toEqual({ status: "corrupted", reason: "digest_mismatch" });
      await pool.query(`UPDATE guided_diagnostic_sessions SET payload = jsonb_set(payload, '{supportedCauses}', '["fuel_supply"]'), workflow_version = 5 WHERE id = $1`, [id]);
      expect(await s.load(ANN, id)).toMatchObject({ status: "corrupted" });
      await pool.query(`UPDATE guided_diagnostic_sessions SET workflow_version = $2, persistence_version = 2 WHERE id = $1`, [id, W.version]);
      expect(await s.load(ANN, id)).toMatchObject({ status: "unsupported_version" });
    });

    it("enforces lifecycle, provenance and revision rules in the database itself", async () => {
      await resetGarage();
      const { id } = await persistThrough(store(), ANN, "car-ann", FUEL_FACTS, []);
      await expect(pool.query(`UPDATE guided_diagnostic_sessions SET lifecycle = 'paused' WHERE id = $1`, [id])).rejects.toThrow(/lifecycle_check/);
      await expect(pool.query(`UPDATE guided_diagnostic_sessions SET lifecycle = 'completed' WHERE id = $1`, [id])).rejects.toThrow(/completed_check/);
      await expect(pool.query(`UPDATE guided_diagnostic_sessions SET revision = 0 WHERE id = $1`, [id])).rejects.toThrow(/revision_check/);
      const rev = (origin: string, ref: string | null, revision = 2) =>
        pool.query(`INSERT INTO guided_diagnostic_session_revisions (session_id, revision, transition, input_count, lifecycle, payload_digest, input_origin, ai_text_ref) VALUES ($1, $4, 'input', 1, 'active', 'x', $2, $3)`, [id, origin, ref, revision]);
      await expect(rev("ai_parser", null)).rejects.toThrow(/ai_ref_check/);
      await expect(rev("direct", "fnv1a32:00000000")).rejects.toThrow(/ai_ref_check/);
      await expect(rev("model", null)).rejects.toThrow(/origin_check/);
      await expect(rev("direct", null, 1)).rejects.toThrow(/guided_diagnostic_session_revisions_pkey/);
    });

    it("archiving a vehicle keeps its sessions; deleting it for good (the existing, unchanged code) removes them and does not fail", async () => {
      await resetGarage();
      const { id } = await persistThrough(store(), ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE.slice(0, 2));
      await persistThrough(store(), ANN, "car-ann", FUEL_FACTS, []);
      await db.freshApp();
      const garageStore = await import("../../../app/lib/garage-store");
      try {
        expect(await garageStore.deleteVehiclePermanently("ann", "car-ann")).toEqual({ outcome: "not_archived" });
        await pool.query(`UPDATE garage_vehicles SET archived_at = now() WHERE id = 'car-ann'`);
        expect(await count("guided_diagnostic_sessions")).toBe(2);
        expect((await store().load(ANN, id)).status).toBe("loaded");
        expect(await garageStore.deleteVehiclePermanently("ann", "car-ann")).toMatchObject({ outcome: "deleted" });
      } finally {
        await db.closeAppConnections();
      }
      expect(await rows(`SELECT id FROM garage_vehicles ORDER BY id`)).toEqual([{ id: "car-bob" }]);
      expect([await count("guided_diagnostic_sessions"), await count("guided_diagnostic_session_revisions")]).toEqual([0, 0]);
      expect(await store().load(ANN, id)).toEqual({ status: "not_found" });
    });

    it("deleting an account removes its sessions and their history", async () => {
      await resetGarage();
      await persistThrough(store(), ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE.slice(0, 1));
      await pool.query(`DELETE FROM users WHERE id = 'ann'`);
      expect([await count("guided_diagnostic_sessions"), await count("guided_diagnostic_session_revisions")]).toEqual([0, 0]);
    });
  });
}
