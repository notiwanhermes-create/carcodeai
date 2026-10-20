/**
 * Guided Diagnostics V2I against a real PostgreSQL database: the service over
 * the Prisma session repository and the Prisma garage directory must behave
 * exactly as over the in-memory ones.
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
import { createPrismaSessionRepository } from "../../../app/lib/diagnostic-workflow-persistence/prisma-repository";
import type { DiagnosticSessionRepository } from "../../../app/lib/diagnostic-workflow-persistence";
import { createPrismaVehicleDirectory } from "../../../app/lib/diagnostic-workflow-service/prisma-vehicles";
import { createGuidedDiagnosticsService, type SubmitRequest } from "../../../app/lib/diagnostic-workflow-service";
import { ANN, BOB, CATALOG, GARAGE_CAR, SYNTHETIC_FOR_TESTS, fuelStart, guidedServiceContract } from "../../helpers/guided-service-contract";
import { FUEL_ROUTE, SPECS, at } from "../../helpers/persisted-sessions";

export function guidedServiceSuite() {
  db.dbDescribe("guided diagnostics service (V2I) in PostgreSQL", () => {
    let pool: Pool;
    let prisma: PrismaClient;

    /** Empty the garage and the session tables, then the contract's garage. */
    async function resetGarage() {
      await pool.query(`TRUNCATE guided_diagnostic_session_revisions, guided_diagnostic_sessions, confirmed_fixes, diagnoses, maintenance_records, garage_vehicles, users CASCADE`);
      await pool.query(`
        INSERT INTO users (id, email) VALUES ('ann', 'ann@example.test'), ('bob', 'bob@example.test');
        INSERT INTO garage_vehicles (id, user_id, year, model_year, make, model, engine, archived_at) VALUES
          ('car-ann', 'ann', '2015', 2015, 'Synthetic', 'Test Car', 'synthetic-i4-a', NULL),
          ('car-bob', 'bob', '2018', 2018, 'Synthetic', 'Other Car', NULL, NULL),
          ('car-ann-old', 'ann', '2003', 2003, 'Synthetic', 'Old Car', NULL, NOW());
      `);
    }

    beforeAll(async () => {
      pool = db.newPool();
      await db.buildFromEmpty(pool);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.TEST_DB, max: 4 }) });
    });
    afterAll(async () => {
      await prisma.$disconnect();
      await pool.end();
    });

    guidedServiceContract("prisma", {
      fresh: async () => {
        await resetGarage();
        return { repository: createPrismaSessionRepository(prisma), vehicles: createPrismaVehicleDirectory(prisma) };
      },
      corruptCurrentStep: async (sessionId) => {
        await pool.query(`UPDATE guided_diagnostic_sessions SET current_step = 'somewhere_else' WHERE id = $1`, [sessionId]);
      },
    });

    it("reads the garage owner-filtered, as the garage records it, and never writes to it", async () => {
      await resetGarage();
      const before = (await pool.query(`SELECT * FROM garage_vehicles ORDER BY id`)).rows;
      const garage = createPrismaVehicleDirectory(prisma);
      expect(await garage.find(ANN, "car-ann")).toEqual({ id: "car-ann", archived: false, context: GARAGE_CAR });
      expect(await garage.find(ANN, "car-bob")).toBeNull();
      expect(await garage.find(BOB, "car-ann")).toBeNull();
      expect(await garage.find(ANN, "car-ann-old")).toMatchObject({ archived: true });
      // A vehicle without a numeric year or an engine leaves them unknown, never guessed.
      await pool.query(`INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ('car-ann-vague', 'ann', 'about 2010', 'Synthetic', 'Vague Car')`);
      expect(await garage.find(ANN, "car-ann-vague")).toEqual({ id: "car-ann-vague", archived: false, context: { make: "Synthetic", model: "Vague Car" } });
      await pool.query(`DELETE FROM garage_vehicles WHERE id = 'car-ann-vague'`);
      expect((await pool.query(`SELECT * FROM garage_vehicles ORDER BY id`)).rows).toEqual(before);
    });

    it("on real PostgreSQL, a stale update after a competing update completes the session is a conflict, not immutable, and appends no revision", async () => {
      // Exercises the Prisma repository's compare-and-set FAILURE path directly: the store's own guards
      // cannot reach it when completion is already visible, so a deterministic race is used. Revision
      // conflict must take precedence over immutability, and the rejected writer must append nothing.
      await resetGarage();
      const base = createPrismaSessionRepository(prisma);
      let competitor: (() => Promise<unknown>) | null = null;
      const updates: string[] = [];
      const repository: DiagnosticSessionRepository = {
        create: (o, s, r) => base.create(o, s, r),
        async update(o, id, exp, c, r) {
          const race = competitor;
          competitor = null;
          if (race) await race();
          const out = await base.update(o, id, exp, c, r);
          updates.push(out.status);
          return out;
        },
        get: (o, id) => base.get(o, id),
        history: (o, id) => base.history(o, id),
      };
      const beforeNextUpdate = <T>(race: () => Promise<T>) => new Promise<T>((resolve, reject) => void (competitor = () => race().then(resolve, reject)));
      let ids = 0;
      const makeService = (clock: () => string) =>
        createGuidedDiagnosticsService({ catalog: CATALOG, repository, vehicles: createPrismaVehicleDirectory(prisma), contentPolicy: SYNTHETIC_FOR_TESTS, specifications: SPECS.specifications, clock, newId: () => `prisma-race-${++ids}` });

      const started = await makeService(() => at(0)).startGuidedSession(ANN, fuelStart());
      if (started.status !== "started") throw new Error(JSON.stringify(started));
      const id = started.meta.id;
      expect((await makeService(() => at(1)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 1, input: FUEL_ROUTE[0] })).status).toBe("saved");

      // Winner answers flashing_light = yes (completes the session); the loser's different answer loses the race.
      const completing: SubmitRequest = { sessionId: id, expectedRevision: 2, input: { nodeId: "flashing_light", kind: "yes_no", answer: "yes" } };
      const other: SubmitRequest = { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] };
      const won = beforeNextUpdate(() => makeService(() => at(5)).submitGuidedStep(ANN, completing));
      const loser = await makeService(() => at(5)).submitGuidedStep(ANN, other);
      const winner = await won;

      if (winner.status !== "saved") throw new Error(JSON.stringify(winner));
      expect(winner.meta.lifecycle).toBe("completed");
      expect(loser).toEqual({ status: "conflict", currentRevision: 3 });
      expect(updates).toEqual(["updated", "updated", "conflict"]);
      // The rejected writer appended nothing: exactly three revisions, no silent overwrite.
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM guided_diagnostic_session_revisions WHERE session_id = $1`, [id])).rows[0].n).toBe(3);
    });
  });
}
