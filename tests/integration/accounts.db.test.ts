/**
 * Database-backed checks for the account rules: the one-time migration of
 * existing users, Google linking/claiming, and registration.
 *
 * These tests DROP AND RECREATE tables, so they only run when
 * TEST_DATABASE_URL points at a database on localhost. Without it they are
 * skipped (e.g. in a normal `npm test`).
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:51214/template1?sslmode=disable npm test
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(TEST_DB).hostname);
  } catch {
    return false;
  }
})();

const suite = TEST_DB && isLocal ? describe : describe.skip;

suite("accounts against a real (local) database", () => {
  let pool: Pool;
  const savedUrl = process.env.DATABASE_URL;

  const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

  async function resetToLegacySchema() {
    await pool.query(`
      DROP TABLE IF EXISTS email_verification_tokens, maintenance_records, garage_vehicles, sessions, rate_limits, users CASCADE;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT,
        password_hash TEXT,
        google_id TEXT,
        first_name TEXT,
        last_name TEXT,
        profile_image TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  // Connections opened by the app modules under test; closed after each test.
  const openConnections: Array<() => Promise<unknown>> = [];

  /** Fresh module instances so ensureDB's per-process memo does not carry over. */
  async function freshModules() {
    vi.resetModules();
    const db = await import("../../app/lib/db");
    const prismaModule = await import("../../app/lib/prisma");
    const store = await import("../../app/lib/account-store");
    openConnections.push(() => db.default.end(), () => prismaModule.default.$disconnect());
    return { ensureDB: db.ensureDB, resolveGoogleAccount: store.resolveGoogleAccount };
  }

  afterEach(async () => {
    for (const close of openConnections.splice(0)) await close().catch(() => {});
  });

  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DB;
    pool = new Pool({ connectionString: TEST_DB });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterAll(async () => {
    await pool.end();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  beforeEach(async () => {
    await resetToLegacySchema();
  });

  it("migrates existing users once, without locking anyone out or touching passwords", async () => {
    await pool.query(`
      INSERT INTO users (id, email, password_hash, google_id) VALUES
        ('legacy-pw',     'pw@example.test',     'HASH-A', NULL),
        ('legacy-google', 'google@example.test', NULL,     'g-100'),
        ('legacy-dual',   'dual@example.test',   'HASH-B', 'g-200');
    `);

    const first = await freshModules();
    await first.ensureDB();

    const pw = await one(`SELECT * FROM users WHERE id = 'legacy-pw'`);
    expect(pw.legacy_unverified).toBe(true);
    expect(pw.email_verified).toBeNull();
    expect(pw.password_hash).toBe("HASH-A");
    expect(pw.session_version).toBe(0);

    const google = await one(`SELECT * FROM users WHERE id = 'legacy-google'`);
    expect(google.email_verified).not.toBeNull();
    expect(google.legacy_unverified).toBe(false);

    const dual = await one(`SELECT * FROM users WHERE id = 'legacy-dual'`);
    expect(dual.legacy_unverified).toBe(true);
    expect(dual.password_hash).toBe("HASH-B");

    // A user who registers AFTER the migration must not be treated as legacy,
    // even though the bootstrap runs again on every cold start.
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ('new-pending', 'new@example.test', 'HASH-C')`);
    const second = await freshModules();
    await second.ensureDB();
    const pending = await one(`SELECT * FROM users WHERE id = 'new-pending'`);
    expect(pending.legacy_unverified).toBe(false);
    expect(pending.email_verified).toBeNull();
  });

  it("claims a pre-registered account: the planted password and old sessions are gone", async () => {
    const { ensureDB, resolveGoogleAccount } = await freshModules();
    await ensureDB();
    // Attacker registers the victim's address with their own password (never confirmed).
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ('squat', 'victim@example.test', 'ATTACKER-HASH')`);
    await pool.query(
      `INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ('th', 'squat', NOW() + INTERVAL '1 day')`,
    );

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
    const { ensureDB, resolveGoogleAccount } = await freshModules();
    await ensureDB();
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
    const { ensureDB, resolveGoogleAccount } = await freshModules();
    await ensureDB();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, email_verified) VALUES ('owner', 'owner@example.test', 'OWNER-HASH', NOW())`,
    );

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
    const { ensureDB, resolveGoogleAccount } = await freshModules();
    await ensureDB();
    const profile = { googleId: "g-new", email: "fresh@example.test", emailVerified: true, picture: null, givenName: "Fresh", familyName: "User" };

    const created = await resolveGoogleAccount(profile);
    expect(created.ok && created.action).toBe("create");
    const row = await one(`SELECT * FROM users WHERE email = 'fresh@example.test'`);
    expect(row.email_verified).not.toBeNull();
    expect(row.password_hash).toBeNull();

    const again = await resolveGoogleAccount(profile);
    expect(again.ok && again.action).toBe("sign_in");
    expect(again.ok && again.user.id).toBe(row.id);
    expect((await one(`SELECT COUNT(*)::int AS n FROM users`)).n).toBe(1);
  });

  it("keeps a legacy user's garage when Google claims their account", async () => {
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ('legacy', 'old@example.test', 'OLD-HASH')`);
    const { ensureDB, resolveGoogleAccount } = await freshModules();
    await ensureDB();
    await pool.query(
      `INSERT INTO garage_vehicles (id, user_id, year, make, model) VALUES ('v1', 'legacy', '2015', 'Toyota', 'Camry')`,
    );

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
    const row = await one(`SELECT * FROM users WHERE id = 'legacy'`);
    expect(row.password_hash).toBeNull();
    expect(row.legacy_unverified).toBe(false);
    expect(row.session_version).toBe(1);
  });

  it("registration creates a pending account, can be redone, and refuses real accounts", async () => {
    const { ensureDB } = await freshModules();
    await ensureDB();
    const { POST } = await import("../../app/api/account/register/route");
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
