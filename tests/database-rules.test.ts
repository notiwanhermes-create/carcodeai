/**
 * Rules about how the app uses its database, checked by reading the source.
 * These need no database, so they run on every `npm test`.
 *
 * They exist to stop old habits coming back: tables created by whichever
 * request happened to arrive first, several connection pools, and TLS
 * certificate checks switched off.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { databaseUrl, directAddress } from "../scripts/db-migrate.mjs";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Every source file that can run in the deployed app. */
function appSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel === "app/generated" || entry.name === "node_modules") continue;
        walk(rel);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk("app");
  walk("components");
  for (const file of ["proxy.ts", "next.config.ts"]) if (fs.existsSync(path.join(ROOT, file))) out.push(file);
  return out;
}

/** Source with comments removed, so a rule is not tripped by a sentence that merely mentions it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const filesContaining = (pattern: RegExp) => appSourceFiles().filter((f) => pattern.test(code(f)));
const migrationDir = (name: string) => `prisma/migrations/${name}/migration.sql`;
const BASELINE = "20260101000000_baseline";
const CONVERGE = "20261011010000_converge_and_expand";
const GARAGE_HISTORY = "20261012180000_garage_history";
/** Guided Diagnostics V2G (research): two new, empty tables. Nothing in the app uses them yet. */
const GUIDED_SESSIONS = "20261016120000_guided_diagnostic_sessions";
/** SQL with `--` comments removed. */
const sql = (name: string) => read(migrationDir(name)).replace(/--.*$/gm, "");

describe("the running app never changes the database structure", () => {
  it("looks at a realistic number of files", () => {
    expect(appSourceFiles().length).toBeGreaterThan(40);
    expect(appSourceFiles()).toContain("app/api/feedback/route.ts");
    expect(appSourceFiles()).toContain("app/lib/rate-limit.ts");
  });

  it("contains no statement that creates, alters or drops a table or index", () => {
    expect(filesContaining(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|UNIQUE\s+INDEX|SCHEMA|TYPE|SEQUENCE|EXTENSION)\b/i)).toEqual([]);
    // Upper case only: "truncate" in lower case is a CSS class name used by the pages.
    expect(filesContaining(/\bTRUNCATE\b/)).toEqual([]);
  });

  it("has no start-up routine that prepares the database", () => {
    expect(filesContaining(/\bensureDB\b/)).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, "app/lib/db.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "app/lib/auth.ts"))).toBe(false);
  });

  it("is not built or started by a command that pushes the schema or migrates on its own", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, `script "${name}"`).not.toMatch(/db\s+push|migrate\s+dev|migrate\s+reset/);
    }
    // Starting, installing and testing never touch a database's structure.
    for (const name of ["dev", "start", "postinstall", "test"]) {
      expect(scripts[name], `script "${name}"`).not.toMatch(/migrate/);
    }
    // The build applies migrations first, through the guarded script, and the
    // "--vercel" flag makes that happen on a Vercel PRODUCTION build only.
    expect(scripts.build).toBe("node scripts/db-migrate.mjs --vercel && prisma generate && next build");
    // One build script: there is no second one that could skip the step.
    expect(scripts["vercel-build"]).toBeUndefined();
    expect(scripts["db:migrate"]).toBe("node scripts/db-migrate.mjs");
  });

  it("migrates from a build only when Vercel says the build is for production", () => {
    const script = code("scripts/db-migrate.mjs");
    expect(script).toContain(`if (args.has("--vercel") && process.env.VERCEL_ENV !== "production") {`);
  });

  it("uses only safe Prisma commands in the migration script", () => {
    const script = code("scripts/db-migrate.mjs");
    const commands = [...script.matchAll(/prisma\(\[([^\]]+)\]/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect(commands).toEqual([
      `"migrate", "resolve", "--applied", BASELINE`,
      `"migrate", "resolve", "--rolled-back", retry`,
      `"migrate", "deploy"`,
    ]);
    expect(script).not.toMatch(/"push"|"reset"|"dev"|--accept-data-loss|--force/);
  });
});

describe("one way into the database", () => {
  it("creates the database client in exactly one place", () => {
    expect(filesContaining(/new\s+PrismaClient\s*\(/)).toEqual(["app/lib/prisma.ts"]);
    expect(filesContaining(/new\s+PrismaPg\s*\(/)).toEqual(["app/lib/prisma.ts"]);
  });

  it("opens no connection pool of its own", () => {
    expect(filesContaining(/from\s+["']pg["']|require\(\s*["']pg["']\s*\)|import\(\s*["']pg["']\s*\)/)).toEqual([]);
    expect(filesContaining(/new\s+(pg\.)?(Pool|Client)\s*\(/)).toEqual([]);
  });

  it("never switches off TLS certificate checks", () => {
    expect(filesContaining(/rejectUnauthorized/)).toEqual([]);
    expect(filesContaining(/NODE_TLS_REJECT_UNAUTHORIZED/)).toEqual([]);
    const scripts = (fs.readdirSync(path.join(ROOT, "scripts"), { recursive: true }) as string[]).filter((f) => f.endsWith(".mjs"));
    expect(scripts.length).toBeGreaterThanOrEqual(5);
    for (const script of scripts) {
      expect(read(`scripts/${script}`), script).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/);
    }
    expect(read("prisma.config.ts")).not.toMatch(/rejectUnauthorized/);
  });

  it("keeps one client per server instance and does not connect on import", () => {
    const client = code("app/lib/prisma.ts");
    expect(client).toMatch(/globalForPrisma\.prisma \?\? createPrismaClient\(\)/);
    expect(client).toMatch(/globalForPrisma\.prisma = prisma;/);
    expect(client).not.toMatch(/\$connect\(/);
    expect(client).not.toMatch(/NODE_ENV/); // cached in production too, not only in development
  });

  it("has exactly one hand-written SQL statement, with bound values", () => {
    expect(filesContaining(/\$queryRawUnsafe|\$executeRawUnsafe|Prisma\.raw\(|\$executeRaw/)).toEqual([]);
    expect(filesContaining(/\$queryRaw/)).toEqual(["app/lib/rate-limit.ts"]);
    const limiter = code("app/lib/rate-limit.ts");
    expect(limiter.match(/\$queryRaw/g)).toHaveLength(1);
    // A tagged template: every value is sent as a parameter.
    expect(limiter).toMatch(/\$queryRaw<[^>]+>`\s*INSERT INTO rate_limits \(key, window_start, count, expires_at\)/);
    expect(limiter).not.toMatch(/\$queryRaw\s*\(/);
  });
});

describe("migrations", () => {
  it("are plain SQL files, applied in name order, for PostgreSQL", () => {
    const names = fs.readdirSync(path.join(ROOT, "prisma/migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    // Exactly these. The clean-up of what older versions left behind is a
    // separate, later release.
    expect(names).toEqual([BASELINE, CONVERGE, GARAGE_HISTORY, GUIDED_SESSIONS]);
    expect(read("prisma/migrations/migration_lock.toml")).toMatch(/provider = "postgresql"/);
    for (const name of names) expect(read(migrationDir(name)).length, name).toBeGreaterThan(200);
  });

  it("say what they create, change and drop", () => {
    for (const name of [CONVERGE, GARAGE_HISTORY, GUIDED_SESSIONS]) {
      const header = read(migrationDir(name)).split("\n").filter((l) => l.startsWith("--")).join("\n");
      for (const heading of [/Creates/, /Changes/, /Backfills/, /Drops/, /Data loss/, /Locks/, /Deploy order/]) expect(header, name).toMatch(heading);
    }
    expect(read(migrationDir(BASELINE))).toMatch(/this migration is NOT run/);
  });

  it("remove nothing: no table, column, index, constraint or row", () => {
    for (const name of [BASELINE, CONVERGE, GARAGE_HISTORY, GUIDED_SESSIONS]) {
      const text = sql(name);
      // The only thing ever dropped is a temporary helper function the migration itself created.
      const drops = [...text.matchAll(/\bDROP\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, " "));
      expect(drops, name).toEqual(name === CONVERGE ? ["DROP FUNCTION pg_temp.carcode_to_date(TEXT);"] : []);
      expect(text, name).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bRENAME\b/i);
      // No column changes type, and nothing is made stricter without a default behind it.
      expect(text, name).not.toMatch(/ALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i);
      expect(text, name).not.toMatch(/DROP\s+(DEFAULT|NOT\s+NULL)/i);
    }
  });

  it("change existing rows only to fill in what was empty or to add a typed copy", () => {
    const updated = [...sql(CONVERGE).matchAll(/UPDATE\s+"(\w+)"(?:\s+AS\s+\w+)?\s+SET\s+"(\w+)"/gi)].map((m) => `${m[1]}.${m[2]}`);
    expect([...new Set(updated)].sort()).toEqual([
      "feedback.created_at", //                  only where it was empty
      "feedback.page_url", //                    only where it was empty, from the old "page" column
      "garage_vehicles.created_at", //           only where it was empty
      "garage_vehicles.is_active", //            only where it was empty
      "garage_vehicles.model_year", //           new column
      "maintenance_records.cost_amount", //      new column
      "maintenance_records.created_at", //       only where it was empty
      "maintenance_records.odometer_value", //   new column (with odometer_unit)
      "maintenance_records.service_date", //     new column
      "rate_limits.expires_at", //               new column
      "users.created_at", //                     only where it was empty
      "users.email", //                          trimmed and lower-cased
      "users.email_verified", //                 only on a database that never had the column
      "users.legacy_unverified", //              only on a database that never had the column
    ]);
    // The text a user typed is never written to.
    for (const column of ["year", "date", "mileage", "cost", "notes", "message", "password_hash", "google_id"]) {
      expect(updated.filter((u) => u.endsWith(`.${column}`)), column).toEqual([]);
    }

    // Phase 2E fills in exactly one thing: a vehicle's current reading, where it was empty.
    const garage = [...sql(GARAGE_HISTORY).matchAll(/UPDATE\s+"(\w+)"(?:\s+AS\s+\w+)?\s+SET\s+"(\w+)"/gi)].map((m) => `${m[1]}.${m[2]}`);
    expect(garage).toEqual(["garage_vehicles.odometer_value"]);
    expect(sql(GARAGE_HISTORY)).toMatch(/AND v\."odometer_value" IS NULL;/);

    // V2G changes no existing table at all: it only creates two new ones.
    expect(sql(GUIDED_SESSIONS)).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
    const altered = [...sql(GUIDED_SESSIONS).matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+(\w+\s+\w+)/gi)].map((m) => `${m[1]} ${m[2]}`);
    expect([...new Set(altered)].sort()).toEqual(["guided_diagnostic_session_revisions ADD CONSTRAINT", "guided_diagnostic_sessions ADD CONSTRAINT"]);
    expect([...sql(GUIDED_SESSIONS).matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(["guided_diagnostic_sessions", "guided_diagnostic_session_revisions"]);
  });

  it("stop rather than wait behind a busy table, and build nothing concurrently", () => {
    for (const name of [CONVERGE, GARAGE_HISTORY, GUIDED_SESSIONS]) {
      expect(sql(name), name).toMatch(/SET LOCAL lock_timeout = '15s';/);
      // The file must stay one transaction, so a failure leaves nothing half-done.
      expect(sql(name), name).not.toMatch(/\bCONCURRENTLY\b|^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    }
  });
});

describe("the schema file", () => {
  const schema = read("prisma/schema.prisma");
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));

  it("defines exactly the tables the app uses, under the names the database has always had", () => {
    const tables = Object.fromEntries(models.map((m) => [m.name, /@@map\("(\w+)"\)/.exec(m.body)?.[1]]));
    expect(tables).toEqual({
      User: "users",
      EmailVerificationToken: "email_verification_tokens",
      Vehicle: "garage_vehicles",
      MaintenanceRecord: "maintenance_records",
      Diagnosis: "diagnoses",
      ConfirmedFix: "confirmed_fixes",
      GuidedDiagnosticSession: "guided_diagnostic_sessions",
      GuidedDiagnosticSessionRevision: "guided_diagnostic_session_revisions",
      RateLimit: "rate_limits",
      Feedback: "feedback",
    });
  });

  it("has one page column on feedback, and none of the removed leftovers", () => {
    const feedback = models.find((m) => m.name === "Feedback")!.body;
    expect(feedback).toMatch(/pageUrl\s+String\?\s+@map\("page_url"\)/);
    // 64-bit, as the production table is (found by the rehearsal of 2026-10-12).
    expect(feedback).toMatch(/^\s*id\s+BigInt\s+@id\s+@default\(autoincrement\(\)\)/m);
    expect(read("prisma/migrations/20260101000000_baseline/migration.sql")).toMatch(/CREATE TABLE "feedback" \(\s+"id" BIGSERIAL NOT NULL,/);
    expect(feedback).not.toMatch(/^\s*page\s/m);
    expect(schema).not.toMatch(/^model Session\b/m);
    expect(schema).not.toMatch(/oem_fault_codes/);
  });

  it("holds no connection address", () => {
    expect(schema).not.toMatch(/postgres(ql)?:\/\//);
    expect(read("prisma.config.ts")).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe("which address migrations use", () => {
  it("prefers a direct address over the pooled one the app uses", () => {
    expect(databaseUrl({ DIRECT_URL: "direct", DATABASE_URL_UNPOOLED: "unpooled", DATABASE_URL: "pooled" })).toBe("direct");
    expect(databaseUrl({ DATABASE_URL_UNPOOLED: "unpooled", DATABASE_URL: "pooled" })).toBe("unpooled");
    expect(databaseUrl({ DATABASE_URL: " pooled " })).toBe("pooled");
    expect(databaseUrl({})).toBe("");
    expect(databaseUrl({ DIRECT_URL: "", DATABASE_URL: "pooled" })).toBe("pooled");
  });

  it("switches a Neon pooled address to the direct one when no direct address is configured", () => {
    const pooled = "postgresql://app_user:p%40ss@ep-example-123456-pooler.us-east-2.aws.neon.tech/carcode?sslmode=require&channel_binding=require";
    const direct = "postgresql://app_user:p%40ss@ep-example-123456.us-east-2.aws.neon.tech/carcode?sslmode=require&channel_binding=require";
    expect(directAddress(pooled)).toBe(direct);
    expect(directAddress(direct)).toBe(direct);
    expect(databaseUrl({ DATABASE_URL: pooled })).toBe(direct);
    // The same applies when the pooled address was put in DIRECT_URL by mistake
    // (Neon's connection dialog offers the pooled one by default).
    expect(databaseUrl({ DIRECT_URL: pooled })).toBe(direct);
    expect(databaseUrl({ DATABASE_URL_UNPOOLED: pooled, DATABASE_URL: "postgres://other/db" })).toBe(direct);
    expect(databaseUrl({ DIRECT_URL: direct, DATABASE_URL: pooled })).toBe(direct);
    // Other hosts are left exactly as they are.
    for (const other of [
      "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable",
      "postgres://u:p@db-pooler.example.com:5432/app",
      "postgres://u:p@my-pooler.internal/app",
      "not a url",
      "",
    ]) {
      expect(directAddress(other), other).toBe(other);
    }
  });

  it("is read the same way by the Prisma command-line configuration", () => {
    expect(read("prisma.config.ts")).toMatch(/process\.env\["DIRECT_URL"\] \|\| process\.env\["DATABASE_URL_UNPOOLED"\] \|\| process\.env\["DATABASE_URL"\]/);
  });

  it("is documented by name only: the example file holds no values for it", () => {
    const example = read(".env.example");
    for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
      expect(example, name).toMatch(new RegExp(`^#? ?${name}=\\s*$`, "m"));
    }
    expect(example).not.toMatch(/postgres(ql)?:\/\/[^\s<]/);
    for (const name of ["DATABASE_POOL_MAX", "SKIP_DB_MIGRATE", "DB_MIGRATE_RETRY"]) expect(example).toContain(name);
  });
});
