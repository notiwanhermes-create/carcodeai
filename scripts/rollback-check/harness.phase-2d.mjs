/**
 * Rollback check, part 2, for a rollback to Phase 2D (the release that added
 * migrations). `run.mjs` copies this file into a checkout of that release as a
 * test file; it is not run from this checkout.
 *
 * It uses that release's real code:
 *   A. the previous release builds its database with its own migrations and
 *      stores data in it;
 *   B. this release's migrations are applied on top;
 *   C. the previous release is started again (a rollback) and must find all its
 *      data and keep reading and writing as before;
 *   D. rolling forward again needs no database change.
 *
 * Only the signed-in session is faked.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import pg from "pg";

const TEST_DB = process.env.TEST_DATABASE_URL || "";
/** The checkout whose migrations are being checked (the new release). */
const NEW_RELEASE = process.env.CARCODE_NEW_RELEASE || "";
/** The previous release: this checkout. */
const PREVIOUS_RELEASE = process.cwd();

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let signedIn = null;

const request = (url, method = "GET", body, ip = "203.0.113.77") =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const withId = (id) => ({ params: Promise.resolve({ id }) });

let disconnect = null;
/** A newly started instance of the previous release: fresh modules, nothing in memory. */
async function startPreviousVersion() {
  if (disconnect) await disconnect().catch(() => {});
  delete globalThis.prisma;
  vi.resetModules();
  process.env.DATABASE_URL = TEST_DB;
  const prisma = (await import("../app/lib/prisma")).default;
  disconnect = () => prisma.$disconnect();
  return {
    prisma,
    accounts: await import("../app/lib/account-store"),
    register: await import("../app/api/account/register/route"),
    garage: await import("../app/api/garage/route"),
    garageItem: await import("../app/api/garage/[id]/route"),
    maintenance: await import("../app/api/maintenance/route"),
    maintenanceItem: await import("../app/api/maintenance/[id]/route"),
    feedback: await import("../app/api/feedback/route"),
    adminFeedback: await import("../app/lib/adminFeedback"),
    limits: await import("../app/lib/rate-limit"),
    guard: await import("../app/lib/diagnose-guard"),
    tickets: await import("../app/lib/diagnosis-ticket"),
  };
}

describe("the previous release (Phase 2D) against this release's database", () => {
  let pool;
  const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const one = async (sql, params = []) => (await rows(sql, params))[0];
  const tables = async () => (await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name);
  const structure = async () => ({
    columns: await rows(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY 1, 2`),
    indexes: await rows(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1, 2`),
  });
  const migrate = (release) => {
    const r = spawnSync(process.execPath, [path.join(release, "scripts", "db-migrate.mjs")], {
      cwd: release,
      env: { ...process.env, DATABASE_URL: TEST_DB, DIRECT_URL: "", DATABASE_URL_UNPOOLED: "", VERCEL_ENV: "", SKIP_DB_MIGRATE: "", DB_MIGRATE_RETRY: "" },
      encoding: "utf8",
    });
    return { status: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
  };

  /** Ids created in phase A, used again in phase C. */
  const made = {};

  beforeAll(async () => {
    if (!TEST_DB || !["localhost", "127.0.0.1", "::1"].includes(new URL(TEST_DB).hostname)) throw new Error("TEST_DATABASE_URL must be a database on this machine");
    if (!NEW_RELEASE) throw new Error("CARCODE_NEW_RELEASE is not set (run this through scripts/rollback-check/run.mjs)");
    pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    vi.doMock("@/app/lib/auth-config", () => ({ auth: async () => (signedIn ? { user: signedIn } : null) }));
  });
  afterAll(async () => {
    if (disconnect) await disconnect().catch(() => {});
    await pool.end();
  });

  it("A. the previous release builds its database with its own migrations and stores data", async () => {
    const built = migrate(PREVIOUS_RELEASE);
    expect(built.status, built.output).toBe(0);
    expect(await tables()).toEqual(["_prisma_migrations", "email_verification_tokens", "feedback", "garage_vehicles", "maintenance_records", "rate_limits", "users"]);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await startPreviousVersion();

    expect((await app.register.POST(request("/api/account/register", "POST", { email: "Before.Upgrade@Example.test", password: "correct horse" }))).status).toBe(200);
    const google = await app.accounts.resolveGoogleAccount({ googleId: "g-before", email: "google.before@example.test", emailVerified: true, picture: null, givenName: "Gil", familyName: null });
    expect(google.ok && google.action).toBe("create");
    made.user = google.user.id;

    signedIn = { id: made.user, email: "google.before@example.test" };
    made.camry = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry", nickname: "Daily" }))).json()).vehicle.id;
    made.accord = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2003", make: "Honda", model: "Accord" }))).json()).vehicle.id;
    for (const body of [
      { vehicleId: made.camry, date: "2026-01-15", serviceType: "Oil Change", odometer: "120,000 km", cost: "$1,250.50", notes: "Synthetic" },
      { vehicleId: made.camry, date: "last tuesday", serviceType: "Other", odometer: "about 90k", cost: "120,50" },
      { vehicleId: made.accord, date: "2025-12-31", serviceType: "Brake Service", odometer: "75,500 miles" },
    ]) {
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", body))).status).toBe(200);
    }
    expect((await app.feedback.POST(request("/api/feedback", "POST", { message: "Before the upgrade", rating: 5, pageUrl: "https://www.carcodeai.com/diagnose?x=1" }))).status).toBe(200);
    expect(await app.guard.consumeDiagnosisQuota({ ipKey: "guest-ip", userId: null })).toEqual({ allowed: true });
    made.ticket = app.tickets.issueTicket(app.tickets.requestFingerprint({ year: "2015", make: "Toyota", model: "Camry", engine: "", code: "P0300", symptoms: "rough idle" })).ticket;
    expect(await app.guard.consumeFollowUp(made.ticket)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("B. this release's migrations apply on top, keeping everything", async () => {
    const before = {
      users: await rows(`SELECT * FROM users ORDER BY id`),
      vehicles: await rows(`SELECT * FROM garage_vehicles ORDER BY id`),
      records: await rows(`SELECT * FROM maintenance_records ORDER BY id`),
      feedback: await rows(`SELECT * FROM feedback ORDER BY id`),
      tokens: await rows(`SELECT * FROM email_verification_tokens ORDER BY 1`),
      counters: await rows(`SELECT * FROM rate_limits ORDER BY key`),
      tables: await tables(),
    };

    const run = migrate(NEW_RELEASE);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/Applying migration/);

    // Every value that was there is still there, exactly. New columns are extra.
    const same = async (sql, was) => {
      const now = await rows(sql);
      expect(now).toHaveLength(was.length);
      for (const [i, row] of was.entries()) expect(now[i]).toMatchObject(row);
    };
    await same(`SELECT * FROM users ORDER BY id`, before.users);
    await same(`SELECT * FROM garage_vehicles ORDER BY id`, before.vehicles);
    await same(`SELECT * FROM maintenance_records ORDER BY id`, before.records);
    await same(`SELECT * FROM feedback ORDER BY id`, before.feedback);
    await same(`SELECT * FROM email_verification_tokens ORDER BY 1`, before.tokens);
    await same(`SELECT * FROM rate_limits ORDER BY key`, before.counters);
    // No table was removed.
    expect(await tables()).toEqual(expect.arrayContaining(before.tables));
  });

  it("C. after a rollback, the previous release finds all its data and keeps working", async () => {
    const migrated = await structure();
    const app = await startPreviousVersion();

    // Everything stored before the upgrade is read back exactly as it was.
    signedIn = { id: made.user, email: "google.before@example.test" };
    const vehicles = (await (await app.garage.GET()).json()).vehicles;
    expect(vehicles.map((v) => [v.id, v.year, v.make, v.model, v.nickname]).sort()).toEqual([
      [made.accord, "2003", "Honda", "Accord", undefined],
      [made.camry, "2015", "Toyota", "Camry", "Daily"],
    ].sort());
    const history = (await (await app.maintenance.GET(request("/api/maintenance"))).json()).records;
    expect(history.map((r) => [r.date, r.odometer, r.cost]).sort()).toEqual([
      ["2025-12-31", "75,500 miles", undefined],
      ["2026-01-15", "120,000 km", "$1,250.50"],
      ["last tuesday", "about 90k", "120,50"],
    ]);
    expect((await app.adminFeedback.getFeedbackRows()).map((r) => [r.message, r.page_url])).toEqual([["Before the upgrade", "https://www.carcodeai.com/diagnose"]]);

    // Accounts and sign-up.
    const again = await app.accounts.resolveGoogleAccount({ googleId: "g-before", email: "google.before@example.test", emailVerified: true, picture: null, givenName: "Gil", familyName: null });
    expect(again).toMatchObject({ ok: true, action: "sign_in", user: { id: made.user } });
    expect((await app.register.POST(request("/api/account/register", "POST", { email: "After.Rollback@Example.test", password: "correct horse" }, "203.0.113.78"))).status).toBe(200);
    expect((await app.register.POST(request("/api/account/register", "POST", { email: "before.upgrade@example.test", password: "another password" }, "203.0.113.79"))).status).toBe(200);
    expect((await one(`SELECT COUNT(*)::int AS n FROM email_verification_tokens`)).n).toBe(2);

    // Garage and service records: add, list, delete.
    const added = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2020", make: "Kia", model: "Soul" }))).json()).vehicle.id;
    expect(await one(`SELECT model_year, odometer_value, archived_at FROM garage_vehicles WHERE id = $1`, [added])).toEqual({ model_year: 2020, odometer_value: null, archived_at: null });
    const record = (await (await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: added, date: "2026-10-11", serviceType: "Inspection", odometer: "10" }))).json()).record.id;
    expect((await app.maintenanceItem.DELETE(request(`/api/maintenance/${record}`, "DELETE"), withId(record))).status).toBe(200);
    // Its vehicle delete removes a vehicle and that vehicle's service records.
    expect((await app.garageItem.DELETE(request(`/api/garage/${made.camry}`, "DELETE"), withId(made.camry))).status).toBe(200);
    expect((await one(`SELECT COUNT(*)::int AS n FROM maintenance_records WHERE vehicle_id = $1`, [made.camry])).n).toBe(0);

    // A vehicle that gained a saved diagnosis under the new release cannot be deleted
    // by the old code: the database refuses, and nothing is lost.
    await pool.query(`INSERT INTO diagnoses (id, user_id, vehicle_id, vehicle_snapshot, result) VALUES ('d-new', $1, $2, '{}', '{}')`, [made.user, made.accord]);
    await expect(app.garageItem.DELETE(request(`/api/garage/${made.accord}`, "DELETE"), withId(made.accord))).rejects.toThrow();
    expect((await rows(`SELECT id FROM garage_vehicles ORDER BY id`)).map((r) => r.id).sort()).toEqual([made.accord, added].sort());
    expect((await one(`SELECT COUNT(*)::int AS n FROM diagnoses`)).n).toBe(1);
    expect((await one(`SELECT COUNT(*)::int AS n FROM maintenance_records WHERE vehicle_id = $1`, [made.accord])).n).toBe(1);

    // Feedback and counters.
    expect((await app.feedback.POST(request("/api/feedback", "POST", { message: "After the rollback", pageUrl: "https://www.carcodeai.com/" }, "203.0.113.80"))).status).toBe(200);
    expect((await app.adminFeedback.getFeedbackRows()).map((r) => r.message).sort()).toEqual(["After the rollback", "Before the upgrade"]);
    expect(await app.guard.consumeDiagnosisQuota({ ipKey: "guest-ip", userId: null })).toEqual({ allowed: true });
    expect(await one(`SELECT count, expires_at > NOW() AS live FROM rate_limits WHERE key = 'diag:guest:day:ip:guest-ip'`)).toEqual({ count: 2, live: true });
    expect(await app.guard.consumeFollowUp(made.ticket)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await app.guard.consumeFollowUp(made.ticket)).toMatchObject({ allowed: false, code: "followup_limit" });
    expect(await app.limits.pruneExpiredCounters()).toBe(0);

    // The previous release changes no structure.
    expect(await structure()).toEqual(migrated);
  });

  it("D. rolling forward again needs no database change", async () => {
    const run = migrate(NEW_RELEASE);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/No pending migrations to apply/);
  });
});
