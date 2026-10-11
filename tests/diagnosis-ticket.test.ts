/**
 * Follow-up tickets: the signed link between a diagnosis and its updates.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TICKET_TTL_SECONDS, issueTicket, requestFingerprint, verifyTicket } from "../app/lib/diagnosis-ticket";

const REQUEST = { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", code: "P0300", symptoms: "rough idle" };
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const ENV = ["DIAGNOSE_TICKET_SECRET", "AUTH_SECRET", "NEXTAUTH_SECRET", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.DIAGNOSE_TICKET_SECRET;
  process.env.AUTH_SECRET = "test-secret-one";
});
afterEach(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const k of ENV) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("request fingerprint", () => {
  it("is the same for the same vehicle, codes and symptoms, and ignores case and outer spaces", () => {
    const fp = requestFingerprint(REQUEST);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(requestFingerprint({ ...REQUEST, make: " TOYOTA ", symptoms: "Rough Idle" })).toBe(fp);
  });

  it("changes when any part of the problem changes", () => {
    const fp = requestFingerprint(REQUEST);
    for (const other of [
      { ...REQUEST, year: "2016" },
      { ...REQUEST, make: "Honda" },
      { ...REQUEST, model: "Corolla" },
      { ...REQUEST, engine: "3.5L V6" },
      { ...REQUEST, code: "P0420" },
      { ...REQUEST, symptoms: "brakes grinding" },
      { ...REQUEST, code: "P0300rough idle", symptoms: "" }, // parts cannot be shuffled between fields
    ]) {
      expect(requestFingerprint(other), JSON.stringify(other)).not.toBe(fp);
    }
  });
});

describe("tickets", () => {
  const fp = requestFingerprint(REQUEST);

  it("issues a ticket that verifies for the same diagnosis", () => {
    const issued = issueTicket(fp, NOW)!;
    expect(issued.token.split(".")).toHaveLength(2);
    expect(issued.ticket).toMatchObject({ fp, iat: NOW / 1000, exp: NOW / 1000 + TICKET_TTL_SECONDS });
    const check = verifyTicket(issued.token, fp, NOW + 60_000);
    expect(check).toEqual({ ok: true, ticket: issued.ticket });
  });

  it("gives every diagnosis its own id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => issueTicket(fp, NOW)!.ticket.id));
    expect(ids.size).toBe(50);
  });

  it("cannot be used for a different vehicle, code or symptoms", () => {
    const { token } = issueTicket(fp, NOW)!;
    expect(verifyTicket(token, requestFingerprint({ ...REQUEST, symptoms: "a completely different problem" }), NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyTicket(token, requestFingerprint({ ...REQUEST, make: "Honda" }), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("expires", () => {
    const { token } = issueTicket(fp, NOW)!;
    expect(verifyTicket(token, fp, NOW + (TICKET_TTL_SECONDS - 1) * 1000).ok).toBe(true);
    expect(verifyTicket(token, fp, NOW + TICKET_TTL_SECONDS * 1000)).toEqual({ ok: false, reason: "expired" });
  });

  it("cannot be forged or altered", () => {
    const { token, ticket } = issueTicket(fp, NOW)!;
    const [payload, signature] = token.split(".");
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

    // A new id (to reset the count) or a later expiry, keeping the old signature.
    expect(verifyTicket(`${encode({ ...ticket, id: "another-id" })}.${signature}`, fp, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(`${encode({ ...ticket, exp: ticket.exp + 999_999 })}.${signature}`, fp, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    // A made-up signature, an unsigned payload, and junk.
    expect(verifyTicket(`${payload}.${Buffer.from("x".repeat(32)).toString("base64url")}`, fp, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTicket(payload, fp, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket("not-a-ticket", fp, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket(`${token}.extra`, fp, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket("", fp, NOW)).toEqual({ ok: false, reason: "missing" });
  });

  it("is useless once the signing secret changes", () => {
    const { token } = issueTicket(fp, NOW)!;
    process.env.AUTH_SECRET = "test-secret-two";
    expect(verifyTicket(token, fp, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("is not issued in production without a secret, so follow-ups are simply unavailable", () => {
    const env = process.env as Record<string, string | undefined>;
    delete env.AUTH_SECRET;
    env.NODE_ENV = "production";
    expect(issueTicket(fp, NOW)).toBeNull();
    expect(verifyTicket("a.b", fp, NOW)).toEqual({ ok: false, reason: "unavailable" });
  });
});
