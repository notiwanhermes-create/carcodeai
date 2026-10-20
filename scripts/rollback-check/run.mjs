#!/usr/bin/env node
/**
 * Rollback check:  npm run db:rollback-check
 *
 * Answers one question with the real code: if this release's migrations are
 * applied and the app is then rolled back to the previous version (Vercel
 * Instant Rollback), does the previous version still work?
 *
 * What it does:
 *  1. copies the previous version's source out of git into a temporary folder,
 *     sharing this folder's installed packages;
 *  2. generates that version's database client;
 *  3. runs the harness for that release there (see `baselines.mjs`): the
 *     previous version builds a database and stores data, this release's
 *     migrations are applied, and the previous version is started again and
 *     exercised (accounts, garage, service records, feedback, counters, and for
 *     Phase 2E its saved diagnoses, repairs, archive and permanent delete);
 *  4. removes the temporary folder.
 *
 * Only the releases listed in `baselines.mjs` can be checked. Any other ref is
 * refused before anything is copied or any database is touched.
 *
 * It EMPTIES the database it is pointed at, so it only accepts
 * TEST_DATABASE_URL on this machine (see docs/database.md).
 *
 *   node scripts/rollback-check/run.mjs [baseline]
 *     baseline: phase-2e (default, the release now in production), phase-2d,
 *     phase-2c, or a git ref naming one of those commits.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isLocalTestDbUrl, selectBaseline } from "./baselines.mjs";

/** The parts of that release the check needs (its source, schema, scripts and test configuration). */
const NEEDED = ["app", "components", "data", "prisma", "scripts", "tests", "package.json", "tsconfig.json", "vitest.config.ts", "prisma.config.ts", "next.config.ts", "proxy.ts"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testDb = (process.env.TEST_DATABASE_URL || "").trim();
const log = (msg) => console.log(`[rollback-check] ${msg}`);

function fail(msg) {
  console.error(`[rollback-check] ${msg}`);
  process.exit(1);
}

const git = (args, options = {}) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const resolveCommit = (name) => {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`]) || null;
  } catch {
    return null;
  }
};

// Which release, decided before anything is copied or any database is touched.
const selected = selectBaseline(process.argv[2], resolveCommit);
if (!selected.ok) fail(`${selected.message} Nothing was run.`);
const { baseline } = selected;
const ref = baseline.commit;
const harness = path.join(ROOT, "scripts", "rollback-check", baseline.harness);
if (!fs.existsSync(harness)) fail(`The harness for ${baseline.label} (${baseline.harness}) is missing. Nothing was run.`);
log(`baseline: ${baseline.label} (${baseline.name}, ${ref.slice(0, 7)}), harness ${baseline.harness}`);

// pg honours host/hostaddr from the URL query string, so a localhost-looking URL could still connect
// elsewhere; isLocalTestDbUrl rejects those. This check empties the database it uses.
if (!isLocalTestDbUrl(testDb)) {
  fail("TEST_DATABASE_URL must be set to a database on this machine (and must not override host/hostaddr in the query string). This check empties the database it uses.");
}

const base = process.env.ROLLBACK_CHECK_DIR || os.tmpdir();
const dir = fs.mkdtempSync(path.join(base, "carcode-previous-"));
const linkedPackages = path.join(dir, "node_modules");
let status = 1;

try {
  log(`copying the previous version (${git(["rev-parse", "--short", ref])}) into ${dir}`);
  // Through a throwaway index file, so this folder's own files and staging area are untouched.
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, ".previous-index") };
  git(["read-tree", ref], { env });
  const files = git(["ls-files", "--", ...NEEDED], { env });
  execFileSync("git", ["checkout-index", `--prefix=${dir.split(path.sep).join("/")}/`, "--stdin"], { cwd: ROOT, env, input: files, stdio: ["pipe", "ignore", "inherit"] });

  // Share this folder's installed packages instead of installing them again.
  fs.symlinkSync(path.join(ROOT, "node_modules"), linkedPackages, "junction");

  log("generating the previous version's database client");
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "generate"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });

  fs.copyFileSync(harness, path.join(dir, "tests", "rollback-check.test.ts"));

  log("running the previous version against a database migrated by this release");
  const run = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "tests/rollback-check.test.ts"], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, TEST_DATABASE_URL: testDb, CARCODE_NEW_RELEASE: ROOT, DATABASE_URL: testDb },
  });
  status = run.status ?? 1;
} finally {
  // Remove the link first, as a link (never its contents), then the copy.
  try {
    if (fs.existsSync(linkedPackages)) fs.rmdirSync(linkedPackages);
  } catch (err) {
    console.error(`[rollback-check] could not remove ${linkedPackages}: ${err?.message || err}`);
  }
  if (fs.existsSync(linkedPackages)) {
    console.error(`[rollback-check] left ${dir} in place because the link to the installed packages is still there. Delete the folder by hand.`);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const which = `${baseline.label}, ${ref.slice(0, 7)}`;
if (status === 0) log(`PASSED: the previous version (${which}) works against a database migrated by this release.`);
else console.error(`[rollback-check] FAILED: the previous version (${which}) does not work against the migrated database. Do not deploy.`);
process.exit(status);
