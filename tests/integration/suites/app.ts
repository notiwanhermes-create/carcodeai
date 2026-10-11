/**
 * The app as it runs today, against a database built by the migrations:
 * sign-up, sign-in, email verification, the garage, service records, feedback,
 * and the diagnosis counters. Only the signed-in session and outgoing email
 * are faked; every read and write goes to the real database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Pool } from "pg";
import * as db from "../db";

type SessionUser = { id: string; email: string | null };

export function appSuite() {
  db.dbDescribe("the app against a migrated database", () => {
    let pool: Pool;
    let expectedShape: Awaited<ReturnType<typeof db.schemaSnapshot>>;
    /** Who is signed in for the next request, or null for a guest. */
    let signedIn: SessionUser | null = null;
    const emailsSent: Array<{ to: string[]; subject: string }> = [];

    const ENV_KEYS = [
      "DATABASE_URL", "RESEND_API_KEY", "FEEDBACK_TO", "FEEDBACK_FROM", "AUTH_EMAIL_FROM", "ADMIN_TOKEN", "NEXTAUTH_URL", "AUTH_URL",
      "AUTH_LOGIN_IP_LIMIT", "DIAGNOSE_GUEST_DAILY_LIMIT", "DIAGNOSE_USER_HOURLY_LIMIT", "DIAGNOSE_USER_DAILY_LIMIT",
      "DIAGNOSE_GLOBAL_DAILY_LIMIT", "DIAGNOSE_FOLLOWUPS_PER_DIAGNOSIS", "FEEDBACK_IP_HOURLY_LIMIT", "FEEDBACK_IP_DAILY_LIMIT",
    ];
    const savedEnv: Record<string, string | undefined> = {};

    const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
    const count = async (from: string) => Number((await one(`SELECT COUNT(*)::int AS n FROM ${from}`)).n);

    const request = (url: string, method = "GET", body?: unknown, ip = "203.0.113.9") =>
      new NextRequest(`http://localhost${url}`, {
        method,
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const withId = (id: string) => ({ params: Promise.resolve({ id }) });

    /** A newly started server instance. */
    async function startApp() {
      const { prisma } = await db.freshApp();
      return {
        prisma,
        garage: await import("../../../app/api/garage/route"),
        garageItem: await import("../../../app/api/garage/[id]/route"),
        maintenance: await import("../../../app/api/maintenance/route"),
        maintenanceItem: await import("../../../app/api/maintenance/[id]/route"),
        feedback: await import("../../../app/api/feedback/route"),
        adminFeedback: await import("../../../app/api/admin/feedback/route"),
        adminFeedbackLib: await import("../../../app/lib/adminFeedback"),
        register: await import("../../../app/api/account/register/route"),
        resend: await import("../../../app/api/account/resend-verification/route"),
        signIn: await import("../../../app/lib/password-sign-in"),
        guard: await import("../../../app/lib/diagnose-guard"),
        tickets: await import("../../../app/lib/diagnosis-ticket"),
        limits: await import("../../../app/lib/rate-limit"),
      };
    }

    beforeAll(async () => {
      pool = db.newPool();
      await db.buildFromEmpty(pool);
      expectedShape = await db.schemaSnapshot(pool);
      // The session and the email sender are the only things replaced.
      vi.doMock("@/app/lib/auth-config", () => ({ auth: async () => (signedIn ? { user: signedIn } : null) }));
      vi.doMock("resend", () => ({
        Resend: class FakeResend {
          emails = {
            send: async (message: { to: string[]; subject: string }) => {
              emailsSent.push({ to: message.to, subject: message.subject });
              return { error: null };
            },
          };
        },
      }));
    });
    afterAll(async () => {
      vi.doUnmock("@/app/lib/auth-config");
      vi.doUnmock("resend");
      await pool.end();
    });
    beforeEach(async () => {
      for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
      signedIn = null;
      emailsSent.length = 0;
      await db.buildFromEmpty(pool);
      await pool.query(`INSERT INTO users (id, email, email_verified) VALUES ('ann', 'ann@example.test', NOW()), ('bob', 'bob@example.test', NOW())`);
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(async () => {
      await db.closeAppConnections();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    /* ───────────── sign-up, email verification, sign-in ───────────── */

    it("sign-up, the emailed link, and sign-in work end to end", async () => {
      const app = await startApp();
      const links: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void links.push(args.join(" ")));
      const ipKey = "test-ip";

      const res = await app.register.POST(request("/api/account/register", "POST", { email: "Dana@Example.test", password: "correct horse", firstName: "Dana" }));
      expect(res.status).toBe(200);
      const user = await one(`SELECT * FROM users WHERE email = 'dana@example.test'`);
      expect(user).toMatchObject({ email_verified: null, legacy_unverified: false, session_version: 0, first_name: "Dana" });
      // Only a hash of the link's token is stored.
      const token = /verify=([a-f0-9]{64})/.exec(links.join("\n"))?.[1] as string;
      expect(token).toBeTruthy();
      const stored = await one(`SELECT token_hash, expires_at > NOW() AS live FROM email_verification_tokens WHERE user_id = $1`, [user.id]);
      expect(stored.live).toBe(true);
      expect(stored.token_hash).not.toBe(token);

      const attempt = (password: string, verifyToken = "", email = "dana@example.test") => app.signIn.signInWithPassword({ email, password, verifyToken, ipKey });

      // Before the link is used, the right password is not enough.
      expect(await attempt("correct horse")).toEqual({ ok: false, code: "email_not_verified" });
      expect(await attempt("wrong password", token)).toMatchObject({ ok: false, code: "invalid_credentials" });
      expect(await attempt("correct horse", "0".repeat(64))).toEqual({ ok: false, code: "verification_invalid" });
      expect((await one(`SELECT email_verified FROM users WHERE id = $1`, [user.id])).email_verified).toBeNull();

      // The link plus the password proves the address, once.
      const verified = await attempt("correct horse", token, "  DANA@example.test ");
      expect(verified).toMatchObject({ ok: true, user: { id: user.id, email: "dana@example.test" } });
      expect((await one(`SELECT email_verified FROM users WHERE id = $1`, [user.id])).email_verified).toBeInstanceOf(Date);
      expect(await count(`email_verification_tokens WHERE user_id = '${user.id}'`)).toBe(0);

      // From then on the password alone signs in, and a wrong one or an unknown address does not.
      expect(await attempt("correct horse")).toMatchObject({ ok: true, user: { id: user.id } });
      expect(await attempt("wrong password")).toEqual({ ok: false, code: "invalid_credentials" });
      expect(await attempt("correct horse", "", "nobody@example.test")).toEqual({ ok: false, code: "invalid_credentials" });
    });

    it("a new link replaces the old one, and an expired link is refused", async () => {
      const app = await startApp();
      const links: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void links.push(args.join(" ")));
      const lastToken = () => /verify=([a-f0-9]{64})/.exec(links[links.length - 1])?.[1] as string;

      await app.register.POST(request("/api/account/register", "POST", { email: "eli@example.test", password: "correct horse" }));
      const first = lastToken();
      const resent = await app.resend.POST(request("/api/account/resend-verification", "POST", { email: "eli@example.test" }));
      expect(resent.status).toBe(200);
      const second = lastToken();
      expect(second).not.toBe(first);
      const user = await one(`SELECT id FROM users WHERE email = 'eli@example.test'`);
      expect(await count(`email_verification_tokens WHERE user_id = '${user.id}'`)).toBe(1);

      const attempt = (verifyToken: string) => app.signIn.signInWithPassword({ email: "eli@example.test", password: "correct horse", verifyToken, ipKey: "ip" });
      expect(await attempt(first)).toEqual({ ok: false, code: "verification_invalid" });

      await pool.query(`UPDATE email_verification_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [user.id]);
      expect(await attempt(second)).toEqual({ ok: false, code: "verification_invalid" });
      expect((await one(`SELECT email_verified FROM users WHERE id = $1`, [user.id])).email_verified).toBeNull();

      // Asking for a link for an address with no pending account says the same thing and sends nothing.
      const before = links.length;
      expect((await app.resend.POST(request("/api/account/resend-verification", "POST", { email: "ann@example.test" }))).status).toBe(200);
      expect(links.length).toBe(before);
    });

    it("an account from before email verification can still sign in with its password", async () => {
      const app = await startApp();
      const bcrypt = (await import("bcryptjs")).default;
      await pool.query(`INSERT INTO users (id, email, password_hash, legacy_unverified) VALUES ('old', 'old@example.test', $1, TRUE)`, [await bcrypt.hash("old password", 4)]);
      expect(await app.signIn.signInWithPassword({ email: "old@example.test", password: "old password", verifyToken: "", ipKey: "ip" })).toMatchObject({
        ok: true,
        user: { id: "old", legacyUnverified: true, emailVerified: null },
      });
    });

    it("limits sign-in attempts per address, counted in the database", async () => {
      process.env.AUTH_LOGIN_IP_LIMIT = "3";
      const app = await startApp();
      const attempt = () => app.signIn.signInWithPassword({ email: "ann@example.test", password: "guess", verifyToken: "", ipKey: "attacker" });
      for (let i = 0; i < 3; i++) expect(await attempt()).toEqual({ ok: false, code: "invalid_credentials" });
      expect(await attempt()).toEqual({ ok: false, code: "rate_limited" });
      // Someone else is not affected.
      expect(await app.signIn.signInWithPassword({ email: "ann@example.test", password: "guess", verifyToken: "", ipKey: "someone-else" })).toEqual({ ok: false, code: "invalid_credentials" });
      expect(await one(`SELECT count, expires_at > NOW() AS live FROM rate_limits WHERE key = 'login:ip:attacker'`)).toEqual({ count: 4, live: true });
    });

    /* ───────────── garage ───────────── */

    it("saves, lists and deletes vehicles, keeping what the user typed and a typed year", async () => {
      const app = await startApp();
      expect((await app.garage.GET()).status).toBe(401);
      expect((await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry" }))).status).toBe(401);

      signedIn = { id: "ann", email: "ann@example.test" };
      const created = await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", vin: "4T1BF1FK5FU000001", nickname: "Daily" }));
      expect(created.status).toBe(200);
      const { vehicle } = await created.json();
      expect(vehicle).toEqual({ id: expect.any(String), year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", vin: "4T1BF1FK5FU000001", nickname: "Daily" });

      expect(await one(`SELECT user_id, year, model_year, is_active, created_at IS NOT NULL AS stamped FROM garage_vehicles WHERE id = $1`, [vehicle.id])).toEqual({
        user_id: "ann", year: "2015", model_year: 2015, is_active: false, stamped: true,
      });

      // A number is accepted as well as text, as before.
      const second = await (await app.garage.POST(request("/api/garage", "POST", { year: 2020, make: "Honda", model: "Civic" }))).json();
      expect(second.vehicle).toEqual({ id: expect.any(String), year: "2020", make: "Honda", model: "Civic" });

      expect((await app.garage.POST(request("/api/garage", "POST", { year: "20x5", make: "A", model: "B" }))).status).toBe(400);
      expect((await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "A" }))).status).toBe(400);
      expect((await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "A", model: "x".repeat(61) }))).status).toBe(400);

      const listed = await (await app.garage.GET()).json();
      expect(listed.vehicles.map((v: { id: string }) => v.id).sort()).toEqual([vehicle.id, second.vehicle.id].sort());

      expect((await app.garageItem.DELETE(request(`/api/garage/${vehicle.id}`, "DELETE"), withId(vehicle.id))).status).toBe(200);
      expect((await (await app.garage.GET()).json()).vehicles.map((v: { id: string }) => v.id)).toEqual([second.vehicle.id]);
      expect((await app.garageItem.DELETE(request(`/api/garage/${vehicle.id}`, "DELETE"), withId(vehicle.id))).status).toBe(404);
    });

    it("never shows, changes or deletes another person's vehicle", async () => {
      const app = await startApp();
      await pool.query(`
        INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ('bob-car', 'bob', '2020', 'Honda', 'Civic');
        INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date) VALUES ('bob-rec', 'bob', 'bob-car', 'Brakes', '2026-02-01');
      `);
      signedIn = { id: "ann", email: "ann@example.test" };

      expect((await (await app.garage.GET()).json()).vehicles).toEqual([]);
      expect((await app.garageItem.DELETE(request("/api/garage/bob-car", "DELETE"), withId("bob-car"))).status).toBe(404);
      expect((await (await app.maintenance.GET(request("/api/maintenance?vehicleId=bob-car"))).json()).records).toEqual([]);
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: "bob-car", date: "2026-03-01", serviceType: "Sabotage" }))).status).toBe(404);
      expect((await app.maintenanceItem.DELETE(request("/api/maintenance/bob-rec", "DELETE"), withId("bob-rec"))).status).toBe(200);

      // Nothing of Bob's was touched.
      expect(await count(`garage_vehicles WHERE id = 'bob-car'`)).toBe(1);
      expect((await rows(`SELECT id, type FROM maintenance_records`))).toEqual([{ id: "bob-rec", type: "Brakes" }]);

      signedIn = { id: "bob", email: "bob@example.test" };
      expect((await (await app.garage.GET()).json()).vehicles.map((v: { id: string }) => v.id)).toEqual(["bob-car"]);
    });

    it("deleting a vehicle removes its service records with it", async () => {
      const app = await startApp();
      signedIn = { id: "ann", email: "ann@example.test" };
      const keep = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry" }))).json()).vehicle.id;
      const gone = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2003", make: "Honda", model: "Accord" }))).json()).vehicle.id;
      for (const vehicleId of [keep, gone, gone]) {
        expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, date: "2026-01-15", serviceType: "Oil Change" }))).status).toBe(200);
      }
      expect(await count("maintenance_records")).toBe(3);

      expect((await app.garageItem.DELETE(request(`/api/garage/${gone}`, "DELETE"), withId(gone))).status).toBe(200);
      expect((await rows(`SELECT vehicle_id FROM maintenance_records`)).map((r) => r.vehicle_id)).toEqual([keep]);
      expect((await rows(`SELECT id FROM garage_vehicles`)).map((r) => r.id)).toEqual([keep]);
    });

    /* ───────────── service records ───────────── */

    it("stores a service record exactly as typed, plus typed values where the text is clear", async () => {
      const app = await startApp();
      signedIn = { id: "ann", email: "ann@example.test" };
      const vehicleId = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry" }))).json()).vehicle.id;
      const add = async (body: Record<string, unknown>) => {
        const res = await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, ...body }));
        expect(res.status).toBe(200);
        return (await res.json()).record;
      };
      const stored = async (id: string) =>
        one(
          `SELECT user_id, type, date, to_char(service_date, 'YYYY-MM-DD') AS service_date, mileage, odometer_value, odometer_unit, cost, cost_amount::text AS cost_amount, notes
             FROM maintenance_records WHERE id = $1`,
          [id],
        );

      const clear = await add({ date: "2026-01-15", serviceType: "Oil Change", odometer: "120,000 km", cost: "$1,250.50", notes: "Synthetic" });
      // The page gets back what it always did: the text the user entered.
      expect(clear).toEqual({ id: expect.any(String), vehicleId, serviceType: "Oil Change", date: "2026-01-15", odometer: "120,000 km", cost: "$1,250.50", notes: "Synthetic" });
      expect(await stored(clear.id)).toEqual({
        user_id: "ann", type: "Oil Change", notes: "Synthetic",
        date: "2026-01-15", service_date: "2026-01-15",
        mileage: "120,000 km", odometer_value: 120000, odometer_unit: "km",
        cost: "$1,250.50", cost_amount: "1250.50",
      });

      // Text that is not clear is kept as text and never guessed at.
      const unclear = await add({ date: "last tuesday", serviceType: "Other", odometer: "about 90k", cost: "120,50" });
      expect(unclear).toMatchObject({ date: "last tuesday", odometer: "about 90k", cost: "120,50" });
      expect(await stored(unclear.id)).toMatchObject({
        date: "last tuesday", service_date: null, mileage: "about 90k", odometer_value: null, odometer_unit: null, cost: "120,50", cost_amount: null,
      });

      // Numbers sent as numbers, and the optional fields left out.
      const numeric = await add({ date: "2025-12-31", serviceType: "Brakes", odometer: 75500, cost: 89.9 });
      expect(await stored(numeric.id)).toMatchObject({ mileage: "75500", odometer_value: 75500, odometer_unit: null, cost: "89.9", cost_amount: "89.90", service_date: "2025-12-31" });
      const bare = await add({ date: "2026-02-31", serviceType: "Battery" });
      expect(bare).toEqual({ id: expect.any(String), vehicleId, serviceType: "Battery", date: "2026-02-31" });
      expect(await stored(bare.id)).toMatchObject({ service_date: null, mileage: null, odometer_value: null, cost: null, cost_amount: null, notes: null });

      expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, serviceType: "No date" }))).status).toBe(400);
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, date: "2026-01-01", serviceType: "x".repeat(81) }))).status).toBe(400);
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, date: "2026-01-01", serviceType: { $ne: "" } }))).status).toBe(400);

      const listed = (await (await app.maintenance.GET(request(`/api/maintenance?vehicleId=${vehicleId}`))).json()).records;
      expect(listed.map((r: { id: string }) => r.id).sort()).toEqual([clear.id, unclear.id, numeric.id, bare.id].sort());

      expect((await app.maintenanceItem.DELETE(request(`/api/maintenance/${clear.id}`, "DELETE"), withId(clear.id))).status).toBe(200);
      expect(await count(`maintenance_records WHERE id = '${clear.id}'`)).toBe(0);
      expect(await count("maintenance_records")).toBe(3);

      signedIn = null;
      expect((await app.maintenance.GET(request("/api/maintenance"))).status).toBe(401);
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, date: "2026-01-01", serviceType: "T" }))).status).toBe(401);
      expect((await app.maintenanceItem.DELETE(request(`/api/maintenance/${bare.id}`, "DELETE"), withId(bare.id))).status).toBe(401);
    });

    it("reads records written before the typed columns existed", async () => {
      const app = await startApp();
      // As the previous version wrote them: text only.
      await pool.query(`
        INSERT INTO garage_vehicles (id, user_id, year, make, model, engine) VALUES ('old-car', 'ann', ' 2003 ', 'Honda', 'Accord', NULL);
        INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, cost) VALUES ('old-rec', 'ann', 'old-car', 'Brake Service', 'spring 2024', '75,500 miles', 'free');
      `);
      signedIn = { id: "ann", email: "ann@example.test" };
      expect((await (await app.garage.GET()).json()).vehicles).toEqual([{ id: "old-car", year: " 2003 ", make: "Honda", model: "Accord" }]);
      expect((await (await app.maintenance.GET(request("/api/maintenance"))).json()).records).toEqual([
        { id: "old-rec", vehicleId: "old-car", serviceType: "Brake Service", date: "spring 2024", odometer: "75,500 miles", cost: "free" },
      ]);
    });

    /* ───────────── feedback ───────────── */

    it("saves feedback in the one page column, and the admin view reads the same column", async () => {
      process.env.ADMIN_TOKEN = "admin-token-for-tests";
      const app = await startApp();
      const send = (body: unknown, ip?: string) => app.feedback.POST(request("/api/feedback", "POST", body, ip));

      expect((await send({ message: "Great tool", rating: 5, name: "Ann", email: "ann@example.test", pageUrl: "https://www.carcodeai.com/diagnose?code=P0300&token=secret#x" })).status).toBe(200);
      // Older copies of the page send the address under "page".
      expect((await send({ message: "From an old tab", page: "https://www.carcodeai.com/garage" })).status).toBe(200);
      expect((await send({ message: "No page" })).status).toBe(200);

      expect(await rows(`SELECT name, email, rating, message, page_url, created_at IS NOT NULL AS stamped FROM feedback ORDER BY id`)).toEqual([
        { name: "Ann", email: "ann@example.test", rating: 5, message: "Great tool", page_url: "https://www.carcodeai.com/diagnose", stamped: true },
        { name: null, email: null, rating: null, message: "From an old tab", page_url: "https://www.carcodeai.com/garage", stamped: true },
        { name: null, email: null, rating: null, message: "No page", page_url: null, stamped: true },
      ]);

      // The admin page's reader and the admin API return the same rows, newest first.
      const fromLib = await app.adminFeedbackLib.getFeedbackRows();
      expect(fromLib.map((r) => [r.message, r.page_url])).toEqual([
        ["No page", null],
        ["From an old tab", "https://www.carcodeai.com/garage"],
        ["Great tool", "https://www.carcodeai.com/diagnose"],
      ]);
      expect(Object.keys(fromLib[0]).sort()).toEqual(["created_at", "email", "message", "name", "page_url", "rating"]);
      expect(fromLib[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const viaApi = await app.adminFeedback.GET(new NextRequest("http://localhost/api/admin/feedback", { headers: { "x-admin-token": "admin-token-for-tests" } }));
      expect(viaApi.status).toBe(200);
      expect(await viaApi.json()).toEqual(fromLib);
      expect((await app.adminFeedback.GET(new NextRequest("http://localhost/api/admin/feedback", { headers: { "x-admin-token": "wrong" } }))).status).toBe(401);

      // No email was sent (none is configured here), and the save did not depend on it.
      expect(emailsSent).toEqual([]);
    });

    it("limits feedback per address using counters in the database", async () => {
      process.env.FEEDBACK_IP_HOURLY_LIMIT = "2";
      const app = await startApp();
      const send = () => app.feedback.POST(request("/api/feedback", "POST", { message: "hello" }, "198.51.100.20"));
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      const refused = await send();
      expect(refused.status).toBe(429);
      expect(await count("feedback")).toBe(2);
      expect(await count(`rate_limits WHERE key LIKE 'feedback:ip:hour:%' AND count = 3 AND expires_at > NOW()`)).toBe(1);
    });

    /* ───────────── the app never changes the database structure ───────────── */

    it("no request creates or alters a table, whichever route runs first", async () => {
      // The feedback table is missing. The old code would have created it on the spot.
      await pool.query(`DROP TABLE feedback`);
      const before = await db.schemaSnapshot(pool);
      const app = await startApp();

      const res = await app.feedback.POST(request("/api/feedback", "POST", { message: "hello" }));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Unable to send feedback right now. Please try again later.");
      expect(await db.tableNames(pool)).not.toContain("feedback");

      // Everything else still works, and nothing about the structure moved.
      signedIn = { id: "ann", email: "ann@example.test" };
      expect((await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry" }))).status).toBe(200);
      expect(await app.guard.consumeDiagnosisQuota({ ipKey: "ip", userId: null })).toEqual({ allowed: true });
      expect(await db.schemaSnapshot(pool)).toEqual(before);
    });

    it("leaves the structure exactly as the migrations built it after every kind of request", async () => {
      const app = await startApp();
      vi.spyOn(console, "log").mockImplementation(() => {});
      signedIn = { id: "ann", email: "ann@example.test" };
      await app.register.POST(request("/api/account/register", "POST", { email: "new@example.test", password: "correct horse" }));
      await app.signIn.signInWithPassword({ email: "ann@example.test", password: "x", verifyToken: "", ipKey: "ip" });
      const vehicleId = (await (await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry" }))).json()).vehicle.id;
      await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, date: "2026-01-15", serviceType: "Oil Change" }));
      await app.feedback.POST(request("/api/feedback", "POST", { message: "hello" }));
      await app.guard.consumeDiagnosisQuota({ ipKey: "ip", userId: "ann" });
      await app.limits.pruneExpiredCounters();

      expect(await db.schemaSnapshot(pool)).toEqual(expectedShape);
      expect(await db.tableNames(pool)).toEqual(["email_verification_tokens", "feedback", "garage_vehicles", "maintenance_records", "rate_limits", "users"]);
      // And it was all done through one client.
      expect((globalThis as { prisma?: unknown }).prisma).toBe(app.prisma);
    });

    /* ───────────── diagnosis allowance and follow-ups ───────────── */

    it("counts a guest's daily diagnoses in the database and stops at the limit", async () => {
      process.env.DIAGNOSE_GUEST_DAILY_LIMIT = "5";
      const first = await startApp();
      const guest = { ipKey: "guest-ip", userId: null };
      for (let i = 0; i < 3; i++) expect(await first.guard.consumeDiagnosisQuota(guest)).toEqual({ allowed: true });

      // Another server instance, with nothing in memory, carries on from the same count.
      const second = await startApp();
      for (let i = 0; i < 2; i++) expect(await second.guard.consumeDiagnosisQuota(guest)).toEqual({ allowed: true });
      expect(await second.guard.consumeDiagnosisQuota(guest)).toMatchObject({ allowed: false, status: 429, code: "guest_quota" });

      // A different visitor, and a signed-in user, have their own counts.
      expect(await second.guard.consumeDiagnosisQuota({ ipKey: "other-ip", userId: null })).toEqual({ allowed: true });
      expect(await second.guard.consumeDiagnosisQuota({ ipKey: "guest-ip", userId: "ann" })).toEqual({ allowed: true });

      const counters = Object.fromEntries((await rows(`SELECT key, count FROM rate_limits`)).map((r) => [r.key, r.count]));
      expect(counters).toEqual({ "diag:guest:day:ip:guest-ip": 6, "diag:guest:day:ip:other-ip": 1, "diag:user:hour:ann": 1, "diag:user:day:ann": 1 });

      // Each counter knows when it stops mattering: two windows after it started.
      const day = await one(`SELECT EXTRACT(EPOCH FROM (expires_at - window_start))::int AS life FROM rate_limits WHERE key = 'diag:guest:day:ip:guest-ip'`);
      expect(day.life).toBe(2 * 24 * 60 * 60);
      const hour = await one(`SELECT EXTRACT(EPOCH FROM (expires_at - window_start))::int AS life FROM rate_limits WHERE key = 'diag:user:hour:ann'`);
      expect(hour.life).toBe(2 * 60 * 60);
    });

    it("counts follow-up updates per diagnosis in the database, across server instances", async () => {
      const first = await startApp();
      const fingerprint = first.tickets.requestFingerprint({ year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", code: "P0300", symptoms: "rough idle" });
      const ticket = first.tickets.issueTicket(fingerprint)!.ticket;

      expect(await first.guard.consumeFollowUp(ticket)).toMatchObject({ allowed: true, remaining: 1 });

      // Another instance, with empty memory, sees the update already made.
      const second = await startApp();
      expect(await second.guard.consumeFollowUp(ticket)).toMatchObject({ allowed: true, remaining: 0 });
      expect(await second.guard.consumeFollowUp(ticket)).toMatchObject({ allowed: false, status: 429, code: "followup_limit" });

      // A different diagnosis has its own count, and follow-ups use nobody's daily allowance.
      const other = second.tickets.issueTicket(fingerprint)!.ticket;
      expect(await second.guard.consumeFollowUp(other)).toMatchObject({ allowed: true, remaining: 1 });

      const counters = await rows(`SELECT key, count, window_start, expires_at FROM rate_limits ORDER BY count`);
      expect(counters.map((r) => [r.key, r.count])).toEqual([[`diag:followup:${other.id}`, 1], [`diag:followup:${ticket.id}`, 3]]);
      // The counter outlives the ticket it counts for, so it can never reset while the ticket is valid.
      for (const r of counters) expect((r.expires_at as Date).getTime()).toBeGreaterThanOrEqual(ticket.exp * 1000);
    });

    it("clears out expired counters and nothing else", async () => {
      const app = await startApp();
      await pool.query(`
        INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES
          ('old-1', NOW() - INTERVAL '5 days', 4, NOW() - INTERVAL '3 days'),
          ('old-2', NOW() - INTERVAL '3 hours', 9, NOW() - INTERVAL '1 second'),
          ('live',  NOW() - INTERVAL '1 hour', 2, NOW() + INTERVAL '1 hour');
      `);
      await app.guard.consumeDiagnosisQuota({ ipKey: "ip", userId: null });

      expect(await app.limits.pruneExpiredCounters()).toBe(2);
      expect((await rows(`SELECT key FROM rate_limits ORDER BY key`)).map((r) => r.key)).toEqual(["diag:guest:day:ip:ip", "live"]);
      expect(await app.limits.pruneExpiredCounters()).toBe(0);
      // A live counter keeps counting after a clean-up.
      expect((await app.limits.consumeRateLimit("diag:guest:day:ip:ip", 5, 24 * 60 * 60)).count).toBe(2);
      expect(await count("users")).toBe(2);
    });

    it("falls back to counting in memory if the database cannot be reached, and says where it counted", async () => {
      const app = await startApp();
      expect((await app.limits.consumeRateLimit("k", 5, 60)).store).toBe("database");
      await pool.query(`ALTER TABLE rate_limits RENAME TO rate_limits_away`);
      try {
        const result = await app.limits.consumeRateLimit("k", 5, 60);
        expect(result).toMatchObject({ allowed: true, store: "memory" });
        // It did not try to put the table back.
        expect(await db.tableNames(pool)).not.toContain("rate_limits");
      } finally {
        await pool.query(`ALTER TABLE rate_limits_away RENAME TO rate_limits`);
      }
    });
  });
}
