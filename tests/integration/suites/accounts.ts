/**
 * The account rules against a real database: Google linking and claiming, and
 * registration. The database is built by the migrations, exactly as production is.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import * as db from "../db";

export function accountSuite() {
  db.dbDescribe("accounts", () => {
    let pool: Pool;
    const savedUrl = process.env.DATABASE_URL;
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    /** A newly started server instance: fresh modules, connected to the test database. */
    async function startApp() {
      await db.freshApp();
      const store = await import("../../../app/lib/account-store");
      return { resolveGoogleAccount: store.resolveGoogleAccount };
    }

    beforeAll(() => {
      pool = db.newPool();
    });
    afterAll(async () => {
      await pool.end();
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
    });
    beforeEach(async () => {
      await db.buildFromEmpty(pool);
      vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(async () => {
      await db.closeAppConnections();
    });

    it("claims a pre-registered account: the planted password and old sessions are gone", async () => {
      const { resolveGoogleAccount } = await startApp();
      // Attacker registers the victim's address with their own password (never confirmed).
      await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ('squat', 'victim@example.test', 'ATTACKER-HASH')`);
      await pool.query(`INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ('th', 'squat', NOW() + INTERVAL '1 day')`);

      const result = await resolveGoogleAccount({
        googleId: "g-victim",
        email: "victim@example.test",
        emailVerified: true,
        picture: null,
        givenName: "Vic",
        familyName: "Tim",
      });

      expect(result.ok && result.action).toBe("claim_unverified");
      const row = await one(`SELECT * FROM users WHERE id = 'squat'`);
      expect(row.password_hash).toBeNull();
      expect(row.google_id).toBe("g-victim");
      expect(row.email_verified).not.toBeNull();
      expect(row.session_version).toBe(1);
      expect((await one(`SELECT COUNT(*)::int AS n FROM email_verification_tokens`)).n).toBe(0);
      expect(result.ok && result.user.sessionVersion).toBe(1);
    });

    it("refuses Google sign-in when Google has not verified the email, and changes nothing", async () => {
      const { resolveGoogleAccount } = await startApp();
      await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ('u', 'someone@example.test', 'HASH')`);

      const result = await resolveGoogleAccount({
        googleId: "g-x",
        email: "someone@example.test",
        emailVerified: false,
        picture: null,
        givenName: null,
        familyName: null,
      });

      expect(result).toEqual({ ok: false, code: "google_email_unverified" });
      const row = await one(`SELECT * FROM users WHERE id = 'u'`);
      expect(row.password_hash).toBe("HASH");
      expect(row.google_id).toBeNull();
    });

    it("links Google to a verified password account and keeps its password", async () => {
      const { resolveGoogleAccount } = await startApp();
      await pool.query(`INSERT INTO users (id, email, password_hash, email_verified) VALUES ('owner', 'owner@example.test', 'OWNER-HASH', NOW())`);

      const result = await resolveGoogleAccount({
        googleId: "g-owner",
        email: "owner@example.test",
        emailVerified: true,
        picture: "https://example.test/p.png",
        givenName: null,
        familyName: null,
      });

      expect(result.ok && result.action).toBe("link_trusted");
      const row = await one(`SELECT * FROM users WHERE id = 'owner'`);
      expect(row.password_hash).toBe("OWNER-HASH");
      expect(row.google_id).toBe("g-owner");
      expect(row.session_version).toBe(0);
    });

    it("creates a verified account for a new Google user, and signs them in next time", async () => {
      const { resolveGoogleAccount } = await startApp();
      const profile = { googleId: "g-new", email: "fresh@example.test", emailVerified: true, picture: null, givenName: "Fresh", familyName: "User" };

      const created = await resolveGoogleAccount(profile);
      expect(created.ok && created.action).toBe("create");
      const row = await one(`SELECT * FROM users WHERE email = 'fresh@example.test'`);
      expect(row.email_verified).not.toBeNull();
      expect(row.password_hash).toBeNull();
      expect(row.created_at).not.toBeNull();

      const again = await resolveGoogleAccount(profile);
      expect(again.ok && again.action).toBe("sign_in");
      expect(again.ok && again.user.id).toBe(row.id);
      expect((await one(`SELECT COUNT(*)::int AS n FROM users`)).n).toBe(1);
    });

    it("keeps a legacy user's garage when Google claims their account", async () => {
      // An account from before email verification, as the migration classifies it.
      await pool.query(`INSERT INTO users (id, email, password_hash, legacy_unverified) VALUES ('legacy', 'old@example.test', 'OLD-HASH', TRUE)`);
      await pool.query(`INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ('v1', 'legacy', '2015', 'Toyota', 'Camry')`);
      await pool.query(`INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date) VALUES ('m1', 'legacy', 'v1', 'Oil Change', '2026-01-15')`);
      const { resolveGoogleAccount } = await startApp();

      const result = await resolveGoogleAccount({
        googleId: "g-old",
        email: "old@example.test",
        emailVerified: true,
        picture: null,
        givenName: null,
        familyName: null,
      });

      expect(result.ok && result.action).toBe("claim_unverified");
      expect(result.ok && result.user.id).toBe("legacy");
      expect((await one(`SELECT COUNT(*)::int AS n FROM garage_vehicles WHERE user_id = 'legacy'`)).n).toBe(1);
      expect((await one(`SELECT COUNT(*)::int AS n FROM maintenance_records WHERE user_id = 'legacy'`)).n).toBe(1);
      const row = await one(`SELECT * FROM users WHERE id = 'legacy'`);
      expect(row.password_hash).toBeNull();
      expect(row.legacy_unverified).toBe(false);
      expect(row.session_version).toBe(1);
    });

    it("never gives one Google identity two accounts, even if two sign-ins race", async () => {
      const { resolveGoogleAccount } = await startApp();
      const profile = { googleId: "g-race", email: "race@example.test", emailVerified: true, picture: null, givenName: null, familyName: null };
      const results = await Promise.allSettled([resolveGoogleAccount(profile), resolveGoogleAccount(profile)]);
      // Whatever the interleaving, the database holds exactly one account for that identity.
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      expect((await one(`SELECT COUNT(*)::int AS n FROM users WHERE google_id = 'g-race'`)).n).toBe(1);
      expect((await one(`SELECT COUNT(*)::int AS n FROM users WHERE email = 'race@example.test'`)).n).toBe(1);
    });

    it("registration creates a pending account, can be redone, and refuses real accounts", async () => {
      await startApp();
      const { POST } = await import("../../../app/api/account/register/route");
      const register = (body: unknown, ip = "203.0.113.50") =>
        POST(
          new Request("http://localhost/api/account/register", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify(body),
          }),
        );

      const first = await register({ email: "New.User@Example.test", password: "first-password", firstName: "New" });
      expect(first.status).toBe(200);
      const row1 = await one(`SELECT * FROM users WHERE email = 'new.user@example.test'`);
      expect(row1.email_verified).toBeNull();
      expect(row1.legacy_unverified).toBe(false);
      expect(row1.password_hash).toMatch(/^\$2[aby]\$/);
      expect((await one(`SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1`, [row1.id])).n).toBe(1);

      // Same address again before confirming: password replaced, still one live token, no duplicate user.
      const second = await register({ email: "new.user@example.test", password: "second-password" });
      expect(second.status).toBe(200);
      const row2 = await one(`SELECT * FROM users WHERE email = 'new.user@example.test'`);
      expect(row2.id).toBe(row1.id);
      expect(row2.password_hash).not.toBe(row1.password_hash);
      expect((await one(`SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1`, [row1.id])).n).toBe(1);
      expect((await one(`SELECT COUNT(*)::int AS n FROM users`)).n).toBe(1);

      // A verified account cannot be re-registered over.
      await pool.query(`UPDATE users SET email_verified = NOW() WHERE id = $1`, [row1.id]);
      const third = await register({ email: "new.user@example.test", password: "third-password" });
      expect(third.status).toBe(409);
      expect((await third.json()).code).toBe("account_exists");
      expect((await one(`SELECT password_hash FROM users WHERE id = $1`, [row1.id])).password_hash).toBe(row2.password_hash);

      // Field validation.
      expect((await register({ email: "nope", password: "long-enough" })).status).toBe(400);
      expect((await register({ email: "a@b.test", password: "123" })).status).toBe(400);
    });
  });
}
