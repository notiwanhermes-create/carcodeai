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
 *  3. runs the harness for that release there (`harness.phase-2d.mjs`, or
 *     `harness.phase-2c.mjs` for the release before it): the previous version
 *     builds a database and stores data, this release's migrations are applied,
 *     and the previous version is started again and exercised (accounts,
 *     garage, service records, feedback, counters);
 *  4. removes the temporary folder.
 *
 * It EMPTIES the database it is pointed at, so it only accepts
 * TEST_DATABASE_URL on this machine (see docs/database.md).
 *
 *   node scripts/rollback-check/run.mjs [git-ref]     default: the release now in production (Phase 2D)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The release a rollback returns to: Phase 2D, as deployed to production. */
const PREVIOUS_RELEASE = "bdf96de";
/**
 * Each release has its own harness, because it exercises that release's own
 * modules. A ref not listed here is checked with the newest harness.
 */
const HARNESSES = { e79758c: "harness.phase-2c.mjs", bdf96de: "harness.phase-2d.mjs" };
/** The parts of that release the check needs (its source, schema, scripts and test configuration). */
const NEEDED = ["app", "components", "data", "prisma", "scripts", "tests", "package.json", "tsconfig.json", "vitest.config.ts", "prisma.config.ts", "next.config.ts", "proxy.ts"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ref = process.argv[2] || PREVIOUS_RELEASE;
const testDb = (process.env.TEST_DATABASE_URL || "").trim();
const log = (msg) => console.log(`[rollback-check] ${msg}`);

function fail(msg) {
  console.error(`[rollback-check] ${msg}`);
  process.exit(1);
}

let host = "";
try {
  host = new URL(testDb).hostname;
} catch {
  /* handled below */
}
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  fail("TEST_DATABASE_URL must be set to a database on this machine. This check empties the database it uses.");
}

const git = (args, options = {}) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
try {
  git(["cat-file", "-e", `${ref}^{commit}`]);
} catch {
  fail(`The previous version (${ref}) is not in this copy of the repository. Run "git fetch origin" and try again.`);
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

  const short = git(["rev-parse", "--short=7", ref]);
  const harness = HARNESSES[short] || HARNESSES[PREVIOUS_RELEASE];
  fs.copyFileSync(path.join(ROOT, "scripts", "rollback-check", harness), path.join(dir, "tests", "rollback-check.test.ts"));

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

if (status === 0) log(`PASSED: the previous version (${ref}) works against a database migrated by this release.`);
else console.error(`[rollback-check] FAILED: the previous version (${ref}) does not work against the migrated database. Do not deploy.`);
process.exit(status);
