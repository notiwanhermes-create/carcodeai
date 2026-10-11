/**
 * Follow-up tickets: the link between a diagnosis and its follow-up updates.
 *
 * A first diagnosis uses one unit of the caller's allowance and comes back with
 * a ticket. An update with follow-up answers must present that ticket instead
 * of using another unit. The ticket is what makes the relationship explicit:
 *
 *  - it is signed by the server (HMAC-SHA256), so it cannot be made up;
 *  - it names the diagnosis it belongs to (a fingerprint of the vehicle, codes
 *    and symptoms), so it cannot be attached to a different problem;
 *  - it expires;
 *  - the server counts the updates made with it (see diagnose-guard.ts) and
 *    stops at the limit, so copying the ticket or replaying it gains nothing.
 *
 * So the only way to get another update is to run, and be charged for, another
 * diagnosis.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";

/** How long a diagnosis can still be updated. */
export const TICKET_TTL_SECONDS = 2 * 60 * 60;

export type DiagnosisTicket = {
  /** Random id of the diagnosis. The follow-up counter is keyed on it. */
  id: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expires at, seconds since the epoch. */
  exp: number;
  /** Fingerprint of the request the ticket was issued for. */
  fp: string;
};

export type TicketCheck = { ok: true; ticket: DiagnosisTicket } | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" | "mismatch" | "unavailable" };

let devSecret: string | null = null;

/**
 * The signing secret. In production one must be configured; without it no
 * tickets are issued and follow-up updates are simply unavailable. Outside
 * production a random per-process secret keeps local development working.
 */
function signingKey(): Buffer | null {
  const configured = (process.env.DIAGNOSE_TICKET_SECRET || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "").trim();
  let secret = configured;
  if (!secret) {
    if (process.env.NODE_ENV === "production") return null;
    devSecret ??= randomBytes(32).toString("hex");
    secret = devSecret;
  }
  return createHash("sha256").update(`carcode-diagnosis-ticket:v1:${secret}`).digest();
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function sign(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** What identifies "the same diagnosis": the vehicle, the codes and the symptoms. Follow-up answers are not part of it. */
export function requestFingerprint(input: { year: string; make: string; model: string; engine: string; code: string; symptoms: string }): string {
  const parts = [input.year, input.make, input.model, input.engine, input.code, input.symptoms].map((p) => p.trim().toLowerCase());
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
}

/** A new ticket for a diagnosis that has just been charged for, or null if tickets cannot be signed. */
export function issueTicket(fingerprint: string, nowMs: number = Date.now()): { token: string; ticket: DiagnosisTicket } | null {
  const key = signingKey();
  if (!key) return null;
  const iat = Math.floor(nowMs / 1000);
  const ticket: DiagnosisTicket = { id: randomUUID(), iat, exp: iat + TICKET_TTL_SECONDS, fp: fingerprint };
  const payload = b64url(JSON.stringify(ticket));
  return { token: `${payload}.${b64url(sign(payload, key))}`, ticket };
}

/** Check a ticket presented with a follow-up request. */
export function verifyTicket(token: string, fingerprint: string, nowMs: number = Date.now()): TicketCheck {
  if (!token) return { ok: false, reason: "missing" };
  const key = signingKey();
  if (!key) return { ok: false, reason: "unavailable" };

  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return { ok: false, reason: "malformed" };

  const expected = sign(payload, key);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  let ticket: DiagnosisTicket;
  try {
    ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DiagnosisTicket;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!ticket || typeof ticket.id !== "string" || typeof ticket.iat !== "number" || typeof ticket.exp !== "number" || typeof ticket.fp !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (ticket.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  if (ticket.fp !== fingerprint) return { ok: false, reason: "mismatch" };
  return { ok: true, ticket };
}
