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
import { createPrismaVehicleDirectory } from "../../../app/lib/diagnostic-workflow-service/prisma-vehicles";
import { ANN, BOB, GARAGE_CAR, guidedServiceContract } from "../../helpers/guided-service-contract";

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
  });
}
