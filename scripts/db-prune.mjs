#!/usr/bin/env node
/**
 * Delete rows whose time has passed:  npm run db:prune
 *
 *   - counters in `rate_limits` that have expired;
 *   - email-verification tokens that expired more than 7 days ago.
 *
 * The app already clears expired counters as it runs (see app/lib/rate-limit.ts),
 * so this is only for a tidy-up on demand. It never touches accounts, vehicles,
 * service records or feedback. `--dry-run` reports what would be removed and
 * deletes nothing.
 */
import process from "node:process";
import pg from "pg";

const url = (process.env.DIRECT_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!url) {
    console.error("No database address is configured. Set DIRECT_URL or DATABASE_URL.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const counters = "rate_limits WHERE expires_at < NOW()";
    const tokens = "email_verification_tokens WHERE expires_at < NOW() - INTERVAL '7 days'";
    if (dryRun) {
      const c = (await client.query(`SELECT COUNT(*)::int AS n FROM ${counters}`)).rows[0].n;
      const t = (await client.query(`SELECT COUNT(*)::int AS n FROM ${tokens}`)).rows[0].n;
      console.log(`[db:prune] dry run: would remove ${c} expired counter(s) and ${t} expired token(s).`);
      return;
    }
    const c = (await client.query(`DELETE FROM ${counters}`)).rowCount;
    const t = (await client.query(`DELETE FROM ${tokens}`)).rowCount;
    console.log(`[db:prune] removed ${c} expired counter(s) and ${t} expired token(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[db:prune] failed: ${err?.message || err}`);
  process.exit(1);
});
