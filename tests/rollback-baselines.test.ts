/**
 * The rollback check's choice of release (scripts/rollback-check): which
 * harness runs for which baseline, and that anything else is refused before a
 * file is copied or a database is touched. No database is needed here; the
 * check itself runs from tests/integration (see suites/migrations.ts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASELINES, DEFAULT_BASELINE, isLocalTestDbUrl, selectBaseline } from "../scripts/rollback-check/baselines.mjs";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "scripts", "rollback-check");

const PHASE_2C = "e79758c5e5b157d36d6b655d8f2a198f902e42d5";
const PHASE_2D = "bdf96deb70dd24e22664dbd3d908f401f80b91cf";
const PHASE_2E = "7bb5408581cecbf9060d764ff086a898a99aa7fe";
const NOT_A_RELEASE = "21e831b0000000000000000000000000000000aa";

/** Whether this copy of the repository has the commit (a shallow clone may not). */
const hasCommit = (commit: string) => spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ROOT }).status === 0;

/** A stand-in for git: short ids and full ids of the listed commits resolve, plus one commit that is no release. */
function fakeGit(extra: Record<string, string> = {}) {
  const known: Record<string, string> = {
    e79758c: PHASE_2C, [PHASE_2C]: PHASE_2C,
    bdf96de: PHASE_2D, [PHASE_2D]: PHASE_2D,
    "7bb5408": PHASE_2E, [PHASE_2E]: PHASE_2E,
    HEAD: NOT_A_RELEASE,
    ...extra,
  };
  return vi.fn((ref: string) => known[ref] ?? null);
}

const pick = (arg: string | undefined, resolve = fakeGit()) => {
  const r = selectBaseline(arg, resolve);
  if (!r.ok) throw new Error(`expected a baseline for ${arg}: ${r.message}`);
  return r.baseline;
};

describe("rollback check: the list of baselines", () => {
  it("lists each release once, by full commit id, with its own harness file", () => {
    expect(BASELINES.map((b) => [b.name, b.commit, b.harness])).toEqual([
      ["phase-2c", PHASE_2C, "harness.phase-2c.mjs"],
      ["phase-2d", PHASE_2D, "harness.phase-2d.mjs"],
      ["phase-2e", PHASE_2E, "harness.phase-2e.mjs"],
    ]);
    for (const b of BASELINES) expect(fs.existsSync(path.join(DIR, b.harness)), b.harness).toBe(true);
    expect(Object.isFrozen(BASELINES) && BASELINES.every((b) => Object.isFrozen(b))).toBe(true);
  });

  it("defaults to the release in production, Phase 2E", () => {
    expect(DEFAULT_BASELINE).toBe("phase-2e");
    expect(pick(undefined)).toMatchObject({ name: "phase-2e", commit: PHASE_2E, harness: "harness.phase-2e.mjs" });
    expect(pick("")).toMatchObject({ name: "phase-2e" });
  });
});

describe("rollback check: the local-database guard (destructive DROP SCHEMA)", () => {
  it("accepts only a local authority", () => {
    for (const ok of ["postgres://u:p@localhost:5432/db", "postgres://127.0.0.1/db?sslmode=disable", "postgres://[::1]:5432/db"]) {
      expect(isLocalTestDbUrl(ok), ok).toBe(true);
    }
    for (const bad of ["postgres://db.example.com/db", "postgres://10.0.0.5:5432/db", "not a url", ""]) {
      expect(isLocalTestDbUrl(bad), bad).toBe(false);
    }
  });

  it("rejects a local authority that redirects the real host via a query parameter (pg honours host/hostaddr)", () => {
    expect(isLocalTestDbUrl("postgres://localhost:5432/db?host=evil.example.com")).toBe(false);
    expect(isLocalTestDbUrl("postgres://localhost:5432/db?hostaddr=203.0.113.9")).toBe(false);
    expect(isLocalTestDbUrl("postgres://localhost:5432/db?host=/cloudsql/project:region:instance")).toBe(false);
  });
});

describe("rollback check: choosing a baseline", () => {
  it("Phase 2D, by name or by commit, runs the Phase 2D harness, as before", () => {
    for (const arg of ["phase-2d", "bdf96de", PHASE_2D]) {
      expect(pick(arg), arg).toMatchObject({ name: "phase-2d", commit: PHASE_2D, harness: "harness.phase-2d.mjs" });
    }
  });

  it("Phase 2E, by name or by commit, runs the Phase 2E harness (no fallback to 2D any more)", () => {
    for (const arg of ["phase-2e", "7bb5408", PHASE_2E]) {
      expect(pick(arg), arg).toMatchObject({ name: "phase-2e", commit: PHASE_2E, harness: "harness.phase-2e.mjs" });
    }
  });

  it("Phase 2C keeps its own harness", () => {
    expect(pick("e79758c")).toMatchObject({ name: "phase-2c", harness: "harness.phase-2c.mjs" });
  });

  it("refuses a commit that is not a listed release, instead of using another release's harness", () => {
    const r = selectBaseline("HEAD", fakeGit());
    expect(r).toMatchObject({ ok: false, reason: "unsupported" });
    expect(!r.ok && r.message).toMatch(/has no rollback harness/);
    expect(!r.ok && r.message).toMatch(/phase-2d \(bdf96de\).*phase-2e \(7bb5408\)/);
  });

  it("refuses a ref that names nothing in this repository", () => {
    expect(selectBaseline("no-such-release", fakeGit())).toMatchObject({ ok: false, reason: "missing" });
    expect(selectBaseline("phase-2f", fakeGit())).toMatchObject({ ok: false, reason: "missing" });
  });

  it("refuses a listed release whose commit is not in this copy", () => {
    const r = selectBaseline("phase-2e", vi.fn(() => null));
    expect(r).toMatchObject({ ok: false, reason: "missing" });
    expect(!r.ok && r.message).toMatch(/Phase 2E \(7bb5408\) is not in this copy/);
  });

  it("refuses something that looks like an option without asking git", () => {
    const resolve = fakeGit();
    expect(selectBaseline("--output=x", resolve)).toMatchObject({ ok: false, reason: "unsupported" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("matches the exact commit, never a name that only resembles one", () => {
    // A ref git resolves to some other commit is refused even if its name looks like a release.
    expect(selectBaseline("bdf96de", fakeGit({ bdf96de: NOT_A_RELEASE }))).toMatchObject({ ok: false, reason: "unsupported" });
  });
});

describe("rollback check: the runner refuses before doing anything", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const runner = (args: string[], env: Record<string, string> = {}) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "carcode-rollback-select-"));
    made.push(scratch);
    const r = spawnSync(process.execPath, [path.join(DIR, "run.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TEST_DATABASE_URL: "", DATABASE_URL: "", ROLLBACK_CHECK_DIR: scratch, ...env },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}`, copies: fs.readdirSync(scratch) };
  };
  const headIsRelease = BASELINES.some((b) => b.commit === execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim());
  it.skipIf(headIsRelease)("an unsupported baseline exits with an error, copies nothing and never reaches the database", () => {
    // A local database address is given on purpose: the refusal must come first.
    const r = runner(["HEAD"], { TEST_DATABASE_URL: "postgres://localhost:1/never-used" });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/has no rollback harness/);
    expect(r.output).toMatch(/Nothing was run/);
    expect(r.output).not.toMatch(/copying the previous version/);
    expect(r.copies).toEqual([]);
  });

  it("an unknown ref exits with an error and copies nothing", () => {
    const r = runner(["no-such-release-ref"], { TEST_DATABASE_URL: "postgres://localhost:1/never-used" });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/is not in this copy of the repository/);
    expect(r.copies).toEqual([]);
  });

  it.skipIf(!hasCommit(PHASE_2D))("selects the Phase 2D harness for phase-2d, then still insists on a local test database", () => {
    const r = runner(["phase-2d"]);
    expect(r.output).toMatch(/baseline: Phase 2D \(phase-2d, bdf96de\), harness harness\.phase-2d\.mjs/);
    expect(r.output).toMatch(/TEST_DATABASE_URL must be set/);
    expect(r.status).toBe(1);
    expect(r.copies).toEqual([]);
  });

  it.skipIf(!hasCommit(PHASE_2E))("selects the Phase 2E harness by default, then still insists on a local test database", () => {
    const r = runner([]);
    expect(r.output).toMatch(/baseline: Phase 2E \(phase-2e, 7bb5408\), harness harness\.phase-2e\.mjs/);
    expect(r.output).toMatch(/TEST_DATABASE_URL must be set/);
    expect(r.status).toBe(1);
    expect(r.copies).toEqual([]);
  });

  it.skipIf(!hasCommit(PHASE_2E))("refuses a local-looking URL that redirects the host via a query parameter, before copying or connecting", () => {
    // Authority is localhost, but ?host= would send pg to another machine for the destructive DROP SCHEMA.
    const r = runner([], { TEST_DATABASE_URL: "postgres://localhost:5432/db?host=evil.example.com" });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/must be set to a database on this machine/);
    expect(r.output).not.toMatch(/copying the previous version/);
    expect(r.copies).toEqual([]);
  });
});

describe("rollback check: the Phase 2E harness covers the V2G additions", () => {
  const harness = fs.readFileSync(path.join(DIR, "harness.phase-2e.mjs"), "utf8");

  it("requires the guided session tables and migration this release adds", () => {
    expect(harness).toContain(`"guided_diagnostic_session_revisions", "guided_diagnostic_sessions"`);
    expect(harness).toContain(`"20261016120000_guided_diagnostic_sessions"`);
    expect(fs.existsSync(path.join(ROOT, "prisma", "migrations", "20261016120000_guided_diagnostic_sessions", "migration.sql"))).toBe(true);
  });

  it.skipIf(!hasCommit(PHASE_2E))(
    "expects exactly the migrations and tables Phase 2E itself created",
    () => {
      const migrations = execFileSync("git", ["ls-tree", "--name-only", `${PHASE_2E}:prisma/migrations`], { cwd: ROOT, encoding: "utf8" })
        .split("\n")
        .filter((n) => /^\d{14}_/.test(n));
      expect(harness).toContain(`const PHASE_2E_MIGRATIONS = ${JSON.stringify(migrations).replace(/,/g, ", ")};`);
      const sql = migrations.map((m) => execFileSync("git", ["show", `${PHASE_2E}:prisma/migrations/${m}/migration.sql`], { cwd: ROOT, encoding: "utf8" })).join("\n");
      const created = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/g)].map((m) => m[1]);
      for (const table of new Set(created)) expect(harness, table).toMatch(new RegExp(`PHASE_2E_TABLES = \\[[^\\]]*"${table}"`));
    },
  );
});
