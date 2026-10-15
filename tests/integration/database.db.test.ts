/**
 * Every test that needs a real database, registered from this one file so the
 * suites run one after another and never use the database at the same time.
 *
 * They EMPTY the database they are pointed at, so they only run when
 * TEST_DATABASE_URL is a database on this machine; otherwise they are skipped.
 * See tests/integration/db.ts and docs/database.md ("Running the database tests").
 */
import { vi } from "vitest";
import { migrationSuite } from "./suites/migrations";
import { accountSuite } from "./suites/accounts";
import { appSuite } from "./suites/app";
import { constraintSuite } from "./suites/constraints";
import { garageSuite } from "./suites/garage";

// Several of these run the real migration command, which takes a few seconds each.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

migrationSuite();
constraintSuite();
accountSuite();
appSuite();
garageSuite();
