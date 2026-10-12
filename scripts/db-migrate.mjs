#!/usr/bin/env node
/**
 * Apply database migrations. The only thing that changes the database schema.
 *
 *   npm run db:migrate              apply pending migrations
 *   npm run db:migrate -- --vercel  the same, but only on a Vercel PRODUCTION build
 *
 * What it does:
 *  1. Finds the database address (see databaseUrl below). With none configured
 *     it does nothing, so builds without a database (previews, CI) still work.
 *  2. If the database already holds the app's tables but has no migration
 *     history (it was built by the app's old start-up code), it records the
 *     baseline migration as already applied. Nothing is run or changed by that.
 *  3. Runs `prisma migrate deploy`, which applies each pending migration once,
 *     in order, and records it.
 *
 * If an earlier attempt failed, it stops and says which migration. Once the
 * cause is fixed, run it again with DB_MIGRATE_RETRY=<that migration's name>
 * (see docs/database.md, "If a migration fails").
 *
 * It never creates a migration, never resets a database and never runs
 * `prisma db push`.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const BASELINE = "20260101000000_baseline";
/** Tables the app's old start-up code created. Their presence means "existing database". */
const LEGACY_MARKER_TABLE = "users";

const args = new Set(process.argv.slice(2));
const log = (msg) => console.log(`[db:migrate] ${msg}`);

/**
 * Neon gives two addresses for one database: a pooled one for the app (host
 * name contains "-pooler") and a direct one, which migrations need. The direct
 * one is the same address without "-pooler". Any other address is returned as is.
 * @param {string} url
 * @returns {string}
 */
export function directAddress(url) {
  try {
    const u = new URL(url);
    if (!/\.neon\.tech$/i.test(u.hostname) || !u.hostname.includes("-pooler.")) return url;
    u.hostname = u.hostname.replace("-pooler.", ".");
    return u.toString();
  } catch {
    return url;
  }
}

/** The address as configured: DIRECT_URL, then DATABASE_URL_UNPOOLED, then the app's own. */
function configuredAddress(env) {
  return (env.DIRECT_URL || env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || "").trim();
}

/**
 * The address migrations use: the configured one, switched to Neon's direct
 * host whenever it is a Neon pooled address. That includes DIRECT_URL itself,
 * because Neon's connection dialog hands out the pooled address by default and
 * it is easy to paste that one by mistake.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function databaseUrl(env = process.env) {
  return directAddress(configuredAddress(env));
}

function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unreadable address)";
  }
}

function prisma(cliArgs, url) {
  const cli = path.join(path.dirname(require.resolve("prisma/package.json")), "build", "index.js");
  execFileSync(process.execPath, [cli, ...cliArgs], {
    stdio: "inherit",
    // prisma.config.ts reads the address from these.
    env: { ...process.env, DIRECT_URL: url },
  });
}

async function inspect(url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = async (table) =>
      (await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [table])).rows[0].present === true;
    const hasHistory = await exists("_prisma_migrations");
    // A migration that started and neither finished nor was marked as rolled back.
    const failed = hasHistory
      ? (
          await client.query(
            "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at",
          )
        ).rows.map((r) => r.migration_name)
      : [];
    return { hasHistory, hasAppTables: await exists(LEGACY_MARKER_TABLE), failed };
  } finally {
    await client.end();
  }
}

async function main() {
  if (process.env.SKIP_DB_MIGRATE === "1") {
    log("skipped (SKIP_DB_MIGRATE=1).");
    return;
  }
  // On Vercel, only the production build may touch a database. A preview build
  // never migrates anything, whatever variables it happens to have.
  if (args.has("--vercel") && process.env.VERCEL_ENV !== "production") {
    log(`skipped: not a production build (VERCEL_ENV=${process.env.VERCEL_ENV || "unset"}).`);
    return;
  }

  const url = databaseUrl();
  if (!url) {
    log("skipped: no database address is configured (DIRECT_URL / DATABASE_URL).");
    return;
  }
  log(`database: ${describeTarget(url)}`);
  if (url !== configuredAddress(process.env)) {
    log("the configured address is a pooled one: using the direct host of the same database (without \"-pooler\") for migrations.");
  }

  const state = await inspect(url);
  if (!state.hasHistory && state.hasAppTables) {
    log("existing database with no migration history: recording the baseline as already applied.");
    prisma(["migrate", "resolve", "--applied", BASELINE], url);
  } else if (!state.hasHistory) {
    log("empty database: all migrations will be applied.");
  }

  // An earlier attempt failed. Each migration file runs as one transaction, so
  // a failed one left nothing behind, but Prisma will not continue until a
  // person says so. That is done by naming the migration in DB_MIGRATE_RETRY.
  if (state.failed.length > 0) {
    const retry = (process.env.DB_MIGRATE_RETRY || "").trim();
    if (state.failed.length === 1 && retry === state.failed[0]) {
      log(`retrying ${retry}: marking the failed attempt as rolled back.`);
      prisma(["migrate", "resolve", "--rolled-back", retry], url);
    } else {
      throw new Error(
        `an earlier attempt at ${state.failed.join(", ")} failed and has not been cleared. ` +
          `Fix the cause, then set DB_MIGRATE_RETRY=${state.failed[0]} and run this again.`,
      );
    }
  }

  prisma(["migrate", "deploy"], url);
  log("done.");
}

// Run only when executed as a script (the tests import databaseUrl from here).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[db:migrate] FAILED: ${err?.message || err}`);
    console.error("[db:migrate] Nothing further was applied. See docs/database.md, \"If a migration fails\".");
    process.exit(1);
  });
}
