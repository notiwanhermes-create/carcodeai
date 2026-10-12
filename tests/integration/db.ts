/**
 * Shared tools for the database-backed tests.
 *
 * These tests EMPTY the database they are pointed at, so they only run when
 * TEST_DATABASE_URL is a database on this machine. Without it they are skipped
 * (as in a normal `npm test`).
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:51214/template1?sslmode=disable npm test
 *
 * All database suites are registered from ONE test file (database.db.test.ts),
 * so they run one after another and never share the database at the same time.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { describe, vi } from "vitest";

export const TEST_DB = process.env.TEST_DATABASE_URL || "";

const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(TEST_DB).hostname);
  } catch {
    return false;
  }
})();

/** `describe` when a local test database is configured, otherwise a skipped suite. */
export const dbDescribe = TEST_DB && isLocal ? describe : describe.skip;

export const ROOT = path.resolve(__dirname, "../..");
export const MIGRATIONS_DIR = path.join(ROOT, "prisma", "migrations");
export const BASELINE = "20260101000000_baseline";
export const CONVERGE = "20261011010000_converge_and_expand";

/** The tables the app uses. A database built from nothing holds exactly these. */
export const APP_TABLES = ["email_verification_tokens", "feedback", "garage_vehicles", "maintenance_records", "rate_limits", "users"];

/**
 * Things older versions of the app created inside the app's own tables, which
 * this release deliberately leaves in place on an existing database. (Whole
 * tables left over from older versions are simply every table not in APP_TABLES.)
 */
export const LEFTOVER_COLUMNS = ["feedback.page"];
export const LEFTOVER_INDEXES = ["users_email_unique", "users_google_id_unique"];

/** Migration folder names, in the order they are applied. */
export function migrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function migrationSql(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

export function newPool(): Pool {
  return new Pool({ connectionString: TEST_DB, max: 2 });
}

export async function emptyDatabase(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
}

/**
 * Apply one migration file the way `prisma migrate deploy` does: the whole
 * file as a single multi-statement command, which PostgreSQL runs as one
 * transaction (all of it, or none of it).
 */
export async function applyMigration(pool: Pool, name: string): Promise<void> {
  await pool.query(migrationSql(name));
}

/** Apply every migration after the baseline: what happens to an existing database. */
export async function upgradeExistingDatabase(pool: Pool): Promise<void> {
  for (const name of migrationNames()) {
    if (name !== BASELINE) await applyMigration(pool, name);
  }
}

/** Apply every migration: what happens to an empty database. */
export async function buildFromEmpty(pool: Pool): Promise<void> {
  await emptyDatabase(pool);
  for (const name of migrationNames()) await applyMigration(pool, name);
}

const childEnv = (extra: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: TEST_DB, ...extra };
  for (const key of ["DIRECT_URL", "DATABASE_URL_UNPOOLED", "VERCEL_ENV", "SKIP_DB_MIGRATE", "DB_MIGRATE_RETRY"]) {
    if (!(key in extra)) delete env[key];
  }
  return env as NodeJS.ProcessEnv;
};

/** Run a project script (scripts/*.mjs) against the test database. */
export function runScript(script: string, args: string[] = [], extraEnv: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    env: childEnv(extraEnv),
    encoding: "utf8",
  });
  return { status: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
}

/** Run the Prisma command-line tool against the test database. */
export function runPrisma(args: string[]) {
  const cli = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, env: childEnv(), encoding: "utf8" });
  return { status: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
}

/** True when the database has exactly the tables, columns, indexes and relations schema.prisma declares. */
export function schemaMatchesPrisma(): { matches: boolean; output: string } {
  const r = runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"]);
  return { matches: r.status === 0, output: r.output };
}

/**
 * A complete, comparable description of the database structure: every table,
 * column, default, index and constraint. Two databases with equal snapshots
 * have the same shape.
 */
export async function schemaSnapshot(pool: Pool) {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  return {
    columns: await q(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
             numeric_precision, numeric_scale
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
       ORDER BY table_name, column_name`),
    indexes: await q(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
       ORDER BY tablename, indexname`),
    constraints: await q(`
      SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' AND c.conrelid::regclass::text <> '_prisma_migrations'
       ORDER BY 1, 2`),
  };
}

type Snapshot = Awaited<ReturnType<typeof schemaSnapshot>>;

/**
 * The part of a snapshot that describes the app's own tables, ignoring what
 * older versions left behind. Every database, old or new, must be equal here.
 */
export function appShape(snapshot: Snapshot, options: { exact?: boolean } = {}): Snapshot {
  const isApp = (table: string) => APP_TABLES.includes(table);
  // `feedback.id` is 64-bit in production and in every new database. A database
  // whose feedback table was created by older code (or by the convergence
  // migration on a database that had none) has a 32-bit one. The app works with
  // both, so the width is not compared unless `exact` is asked for.
  const sameWidth = (c: Snapshot["columns"][number]) =>
    !options.exact && c.table_name === "feedback" && c.column_name === "id" ? { ...c, data_type: "integer or bigint", udt_name: "int4 or int8", numeric_precision: null } : c;
  return {
    columns: snapshot.columns.filter((c) => isApp(c.table_name) && !LEFTOVER_COLUMNS.includes(`${c.table_name}.${c.column_name}`)).map(sameWidth),
    indexes: snapshot.indexes.filter((i) => isApp(i.tablename) && !LEFTOVER_INDEXES.includes(i.indexname)),
    constraints: snapshot.constraints.filter((c) => isApp(c.table_name)),
  };
}

/**
 * Everything older versions left behind, with its contents: every row of every
 * table the app does not use, every value in a leftover column, and the
 * definition of every leftover index. Equal before and after means untouched.
 */
export async function leftovers(pool: Pool) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  const tables: Record<string, unknown[]> = {};
  for (const table of await tableNames(pool)) {
    if (!APP_TABLES.includes(table)) tables[table] = await q(`SELECT * FROM "${table}" ORDER BY 1, 2`);
  }
  const columns: Record<string, unknown[]> = {};
  for (const name of LEFTOVER_COLUMNS) {
    const [table, column] = name.split(".");
    const exists = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]);
    if (exists.length > 0) columns[name] = (await q(`SELECT id, "${column}" AS value FROM "${table}" ORDER BY id`)).map((r) => [r.id, r.value]);
  }
  const indexes = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1) ORDER BY 1`, [LEFTOVER_INDEXES]);
  return { tables, columns, indexes };
}

export async function tableNames(pool: Pool): Promise<string[]> {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY 1`,
  );
  return r.rows.map((x) => x.table_name as string);
}

/* ───────────────────── app modules against the test database ───────────────────── */

type Closer = () => Promise<unknown>;
const openClients: Closer[] = [];

/**
 * Fresh copies of the app's modules, connected to the test database. Each call
 * behaves like a newly started server instance with nothing in memory.
 */
export async function freshApp() {
  await closeAppConnections();
  vi.resetModules();
  process.env.DATABASE_URL = TEST_DB;
  const prismaModule = await import("../../app/lib/prisma");
  openClients.push(() => prismaModule.default.$disconnect());
  return { prisma: prismaModule.default };
}

/** Close the app's database client. Call after every test that used freshApp(). */
export async function closeAppConnections(): Promise<void> {
  for (const close of openClients.splice(0)) await close().catch(() => {});
  delete (globalThis as { prisma?: unknown }).prisma;
}

export { execFileSync };
