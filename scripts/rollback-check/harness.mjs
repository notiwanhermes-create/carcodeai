/**
 * Rollback check, part 2: the tests that run INSIDE a checkout of the previous
 * version of the app (Phase 2C). `run.mjs` copies this file there as a test
 * file; it is not run from this checkout.
 *
 * It uses that version's real code, not a description of it:
 *   A. the previous version builds its own database and stores data in it;
 *   B. this release's migrations are applied on top;
 *   C. the previous version is started again (a rollback) and must find all its
 *      data and keep reading and writing as before.
 *
 * Only the signed-in session is faked. Everything else is that version's code
 * talking to a real (local, throwaway) database.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import pg from "pg";

const TEST_DB = process.env.TEST_DATABASE_URL || "";
/** The checkout whose migrations are being checked (the new release). */
const NEW_RELEASE = process.env.CARCODE_NEW_RELEASE || "";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

/** Who is signed in for the next request. */
let signedIn = null;
const links = [];

const request = (url, method = "GET", body, ip = "203.0.113.77") =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const withId = (id) => ({ params: Promise.resolve({ id }) });

const closers = [];
/** A newly started instance of the previous version: fresh modules, nothing in memory. */
async function startPreviousVersion() {
  for (const close of closers.splice(0)) await close().catch(() => {});
  delete globalThis.prisma;
  vi.resetModules();
  process.env.DATABASE_URL = TEST_DB;
  const db = await import("../app/lib/db");
  const prisma = (await import("../app/lib/prisma")).default;
  closers.push(() => db.default.end(), () => prisma.$disconnect());
  return {
    ensureDB: db.ensureDB,
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

describe("the previous version of the app against this release's database", () => {
  let pool;
  const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const one = async (sql, params = []) => (await rows(sql, params))[0];
  const structure = async () => ({
    columns: await rows(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY 1, 2`),
    indexes: await rows(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1, 2`),
  });
  const migrate = () => {
    const r = spawnSync(process.execPath, [path.join(NEW_RELEASE, "scripts", "db-migrate.mjs")], {
      cwd: NEW_RELEASE,
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
    vi.spyOn(console, "log").mockImplementation((...args) => void links.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    for (const close of closers.splice(0)) await close().catch(() => {});
    await pool.end();
  });

  it("A. the previous version builds its own database and stores data in it", async () => {
    const app = await startPreviousVersion();
    await app.ensureDB();

    // A password sign-up (left unconfirmed) and a Google account.
    expect((await app.register.POST(request("/api/account/register", "POST", { email: "Before.Upgrade@Example.test", password: "correct horse" }))).status).toBe(200);
    const google = await app.accounts.resolveGoogleAccount({ googleId: "g-before", email: "google.before@example.test", emailVerified: true, picture: null, givenName: "Gil", familyName: null });
    expect(google.ok && google.action).toBe("create");
    made.googleUser = google.user.id;

    // A garage with service history, including text that does not convert.
    signedIn = { id: made.googleUser, email: "google.before@example.test" };
    made.camry = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry", nickname: "Daily" }))).json()).vehicle.id;
    made.accord = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2003", make: "Honda", model: "Accord" }))).json()).vehicle.id;
    for (const body of [
      { vehicleId: made.camry, date: "2026-01-15", serviceType: "Oil Change", odometer: "120,000 km", cost: "$1,250.50", notes: "Synthetic" },
      { vehicleId: made.camry, date: "last tuesday", serviceType: "Other", odometer: "about 90k", cost: "120,50" },
      { vehicleId: made.accord, date: "2025-12-31", serviceType: "Brake Service", odometer: "75,500 miles" },
    ]) {
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", body))).status).toBe(200);
    }

    // Feedback, and some counters.
    expect((await app.feedback.POST(request("/api/feedback", "POST", { message: "Before the upgrade", rating: 5, pageUrl: "https://www.carcodeai.com/diagnose?x=1" }))).status).toBe(200);
    expect(await app.guard.consumeDiagnosisQuota({ ipKey: "guest-ip", userId: null })).toEqual({ allowed: true });
    made.ticket = app.tickets.issueTicket(app.tickets.requestFingerprint({ year: "2015", make: "Toyota", model: "Camry", engine: "", code: "P0300", symptoms: "rough idle" })).ticket;
    expect(await app.guard.consumeFollowUp(made.ticket)).toMatchObject({ allowed: true, remaining: 1 });

    expect((await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name)).toEqual([
      "email_verification_tokens", "feedback", "garage_vehicles", "maintenance_records", "rate_limits", "sessions", "users",
    ]);
  });

  it("B. this release's migrations apply on top, keeping everything", async () => {
    const before = {
      users: await rows(`SELECT id, email, password_hash, google_id, email_verified, legacy_unverified, session_version FROM users ORDER BY id`),
      vehicles: await rows(`SELECT id, user_id, year, make, model, nickname FROM garage_vehicles ORDER BY id`),
      records: await rows(`SELECT id, user_id, vehicle_id, type, date, mileage, cost, notes FROM maintenance_records ORDER BY id`),
      feedback: await rows(`SELECT id, message, rating, page_url FROM feedback ORDER BY id`),
      tokens: await rows(`SELECT token_hash, user_id FROM email_verification_tokens ORDER BY 1`),
      counters: await rows(`SELECT key, count FROM rate_limits ORDER BY key`),
      tables: (await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name),
    };

    const run = migrate();
    expect(run.output).toContain("recording the baseline as already applied");
    expect(run.status, run.output).toBe(0);

    expect(await rows(`SELECT id, email, password_hash, google_id, email_verified, legacy_unverified, session_version FROM users ORDER BY id`)).toEqual(before.users);
    expect(await rows(`SELECT id, user_id, year, make, model, nickname FROM garage_vehicles ORDER BY id`)).toEqual(before.vehicles);
    expect(await rows(`SELECT id, user_id, vehicle_id, type, date, mileage, cost, notes FROM maintenance_records ORDER BY id`)).toEqual(before.records);
    expect(await rows(`SELECT id, message, rating, page_url FROM feedback ORDER BY id`)).toEqual(before.feedback);
    expect(await rows(`SELECT token_hash, user_id FROM email_verification_tokens ORDER BY 1`)).toEqual(before.tokens);
    expect(await rows(`SELECT key, count FROM rate_limits ORDER BY key`)).toEqual(before.counters);
    // No table was removed; only the migration history table is new.
    expect((await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name)).toEqual([...before.tables, "_prisma_migrations"].sort());
    // And the typed copies were filled in where the text is clear.
    expect(await rows(`SELECT date, to_char(service_date, 'YYYY-MM-DD') AS service_date, odometer_value, odometer_unit, cost_amount::text AS cost_amount FROM maintenance_records ORDER BY date`)).toEqual([
      { date: "2025-12-31", service_date: "2025-12-31", odometer_value: 75500, odometer_unit: "mi", cost_amount: null },
      { date: "2026-01-15", service_date: "2026-01-15", odometer_value: 120000, odometer_unit: "km", cost_amount: "1250.50" },
      { date: "last tuesday", service_date: null, odometer_value: null, odometer_unit: null, cost_amount: null },
    ]);
  });

  it("C. after a rollback, the previous version starts, finds all its data, and keeps working", async () => {
    const migrated = await structure();
    const app = await startPreviousVersion();

    // Its start-up routine runs on every cold start. It must succeed, and because
    // nothing it expects was removed, it must find nothing to create or change.
    await app.ensureDB();
    expect(await structure()).toEqual(migrated);

    // Everything stored before the upgrade is read back exactly as it was.
    signedIn = { id: made.googleUser, email: "google.before@example.test" };
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

    // Accounts: the Google user signs in, and a new one can be created.
    const again = await app.accounts.resolveGoogleAccount({ googleId: "g-before", email: "google.before@example.test", emailVerified: true, picture: null, givenName: "Gil", familyName: null });
    expect(again).toMatchObject({ ok: true, action: "sign_in", user: { id: made.googleUser } });
    const fresh = await app.accounts.resolveGoogleAccount({ googleId: "g-after", email: "google.after@example.test", emailVerified: true, picture: null, givenName: null, familyName: null });
    expect(fresh.ok && fresh.action).toBe("create");

    // Sign-up: a new pending account, and the earlier pending one can still be redone.
    expect((await app.register.POST(request("/api/account/register", "POST", { email: "After.Rollback@Example.test", password: "correct horse" }, "203.0.113.78"))).status).toBe(200);
    expect((await app.register.POST(request("/api/account/register", "POST", { email: "before.upgrade@example.test", password: "another password" }, "203.0.113.79"))).status).toBe(200);
    expect(await rows(`SELECT email, email_verified IS NULL AS pending FROM users WHERE email LIKE '%.rollback@%' OR email LIKE 'before.%' ORDER BY email`)).toEqual([
      { email: "after.rollback@example.test", pending: true },
      { email: "before.upgrade@example.test", pending: true },
    ]);
    expect((await one(`SELECT COUNT(*)::int AS n FROM email_verification_tokens`)).n).toBe(2);

    // Garage and service records: add, list, delete (its three-step vehicle delete).
    const added = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2020", make: "Kia", model: "Soul" }))).json()).vehicle.id;
    expect(await one(`SELECT is_active, created_at IS NOT NULL AS stamped, model_year FROM garage_vehicles WHERE id = $1`, [added])).toEqual({ is_active: false, stamped: true, model_year: null });
    const record = (await (await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: added, date: "2026-10-11", serviceType: "Inspection", odometer: "10" }))).json()).record.id;
    expect((await app.maintenanceItem.DELETE(request(`/api/maintenance/${record}`, "DELETE"), withId(record))).status).toBe(200);
    expect((await app.garageItem.DELETE(request(`/api/garage/${made.camry}`, "DELETE"), withId(made.camry))).status).toBe(200);
    expect((await rows(`SELECT id FROM garage_vehicles ORDER BY id`)).map((r) => r.id).sort()).toEqual([made.accord, added].sort());
    expect((await one(`SELECT COUNT(*)::int AS n FROM maintenance_records WHERE vehicle_id = $1`, [made.camry])).n).toBe(0);

    // Feedback through its own connection pool, and its admin list.
    expect((await app.feedback.POST(request("/api/feedback", "POST", { message: "After the rollback", pageUrl: "https://www.carcodeai.com/" }, "203.0.113.80"))).status).toBe(200);
    expect((await app.adminFeedback.getFeedbackRows()).map((r) => r.message).sort()).toEqual(["After the rollback", "Before the upgrade"]);

    // Counters: the daily allowance carries on from where it was, and so does the follow-up count.
    expect(await app.guard.consumeDiagnosisQuota({ ipKey: "guest-ip", userId: null })).toEqual({ allowed: true });
    expect((await one(`SELECT count, expires_at > NOW() AS live FROM rate_limits WHERE key = 'diag:guest:day:ip:guest-ip'`))).toEqual({ count: 2, live: true });
    expect(await app.guard.consumeFollowUp(made.ticket)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await app.guard.consumeFollowUp(made.ticket)).toMatchObject({ allowed: false, code: "followup_limit" });
    // A counter it creates without knowing about expiry still gets one.
    expect((await app.limits.consumeRateLimit("rollback:new", 5, 60)).store).toBe("database");
    expect((await one(`SELECT expires_at > NOW() AS live FROM rate_limits WHERE key = 'rollback:new'`)).live).toBe(true);

    // After all of that the structure is still exactly what the migrations left.
    expect(await structure()).toEqual(migrated);
  });

  it("D. rolling forward again needs no database change", async () => {
    const run = migrate();
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/No pending migrations to apply/);
  });
});
