import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { Resend } from "resend";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { consumeRateLimit, envInt } from "@/app/lib/rate-limit";
import { clientIpKey } from "@/app/lib/client-ip";
import { auth } from "@/app/lib/auth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Limits (per IP, hashed). Configurable; 0 disables a limit.
 *   FEEDBACK_IP_HOURLY_LIMIT  default 5
 *   FEEDBACK_IP_DAILY_LIMIT   default 20
 *   FEEDBACK_REPLY_DAILY_LIMIT  confirmation emails per signed-in user per day, default 2
 */
const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MAX_BODY_BYTES = 16 * 1024;
const LIMITS = { name: 100, email: 254, message: 2000, pageUrl: 500 } as const;

const GENERIC_ERROR = "Unable to send feedback right now. Please try again later.";

type FeedbackPayload = {
  name: string;
  email: string;
  rating: number | null;
  message: string;
  pageUrl: string | null;
  createdAt: string;
};

/** Basic email format validation (RFC 5322 simplified). */
function isValidEmail(email: string): boolean {
  if (email.length > LIMITS.email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Keep only origin + path: query strings can carry tokens and personal data. */
function sanitizePageUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, LIMITS.pageUrl);
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname}`.slice(0, LIMITS.pageUrl);
  } catch {
    return null;
  }
}

let feedbackPool: Pool | null = null;

function getPool(): Pool {
  if (!feedbackPool) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL not configured");
    const needsSsl =
      dbUrl.includes("neon.tech") ||
      dbUrl.includes("neon/") ||
      (process.env.NODE_ENV === "production" && !dbUrl.includes("sslmode=disable"));
    feedbackPool = new Pool({
      connectionString: dbUrl,
      max: 3,
      connectionTimeoutMillis: 10000,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return feedbackPool;
}

let tableReady = false;

async function ensureFeedbackTable(client: import("pg").PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT,
      rating INTEGER,
      message TEXT NOT NULL,
      page_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- The table may have been created elsewhere with a "page" column instead.
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS page_url TEXT;
  `);
  tableReady = true;
}

function safeLog(msg: string, meta?: Record<string, unknown>) {
  console.error("[feedback]", msg, meta ?? "");
}

/** Notify the site owner. The owner's own inbox is the only place user text is emailed to. */
async function sendFeedbackEmail(payload: FeedbackPayload) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_TO;
  const from = process.env.FEEDBACK_FROM;
  if (!apiKey || !to || !from) {
    safeLog("email skipped", { hasKey: !!apiKey, hasTo: !!to, hasFrom: !!from });
    return;
  }
  const ratingLabel = payload.rating != null ? `${payload.rating}/5` : "—/5";
  const subject = `New CarCode AI Feedback (rating ${ratingLabel})`;
  const body = [
    `Message: ${payload.message}`,
    `Rating: ${payload.rating != null ? payload.rating : "—"}`,
    `Name: ${payload.name || "—"}`,
    `Email: ${payload.email || "—"}`,
    `Page URL: ${payload.pageUrl || "—"}`,
    `Created at: ${payload.createdAt}`,
  ].join("\n");
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: [to],
      subject,
      text: body,
    });
    if (error) safeLog("email failed", { error: error.message });
  } catch (e) {
    safeLog("email error", { err: (e as Error)?.message });
  }
}

/**
 * Confirmation email. Sent ONLY to the signed-in user's own account address,
 * and it contains fixed text only — nothing the submitter typed. This is what
 * stops the endpoint from being used to send email to arbitrary people.
 */
async function sendConfirmationToAccountEmail(accountEmail: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FEEDBACK_FROM;
  const to = process.env.FEEDBACK_TO;
  if (!apiKey || !from) return;
  const subject = process.env.FEEDBACK_REPLY_SUBJECT?.trim() || "We got your feedback — CarCode AI";
  const text = [
    "Thanks for your feedback! We've received it and will use it to improve CarCode AI.",
    "",
    "If you have more to add, just reply to this email.",
  ].join("\n");
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: [accountEmail],
      ...(to ? { replyTo: to } : {}),
      subject,
      text,
    });
    if (error) safeLog("confirmation email failed", {});
  } catch {
    safeLog("confirmation email error", {});
  }
}

/** Fallback when DATABASE_URL is missing: write to file and log. */
async function saveFeedbackFallback(payload: FeedbackPayload) {
  const line = JSON.stringify(payload) + "\n";
  safeLog("no-db fallback", {
    messageLen: payload.message.length,
    hasName: !!payload.name.trim(),
    hasEmail: !!payload.email.trim(),
    hasRating: payload.rating != null,
  });
  try {
    const dir = process.env.VERCEL ? "/tmp" : join(process.cwd(), "tmp");
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      /* dir may already exist */
    }
    await appendFile(join(dir, "feedback.jsonl"), line, "utf8");
  } catch (e) {
    safeLog("fallback file write failed", { err: (e as Error)?.message });
  }
}

async function saveFeedback(payload: FeedbackPayload) {
  if (!process.env.DATABASE_URL) {
    await saveFeedbackFallback(payload);
    return;
  }
  const client = await getPool().connect();
  try {
    if (!tableReady) await ensureFeedbackTable(client);
    await client.query(
      `INSERT INTO feedback (name, email, rating, message, page_url) VALUES ($1, $2, $3, $4, $5)`,
      [payload.name || null, payload.email || null, payload.rating, payload.message, payload.pageUrl],
    );
  } finally {
    client.release();
  }
}

type ErrorBody = { ok: false; error: string; code?: string };

function json(status: number, body: { ok: true } | ErrorBody, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function GET() {
  return json(200, { ok: true });
}

export async function POST(req: NextRequest) {
  try {
    // 1) Rate limit per IP before doing any work.
    const ipKey = clientIpKey(req);
    const hourly = await consumeRateLimit(`feedback:ip:hour:${ipKey}`, envInt("FEEDBACK_IP_HOURLY_LIMIT", 5), HOUR_SECONDS);
    const daily = hourly.allowed
      ? await consumeRateLimit(`feedback:ip:day:${ipKey}`, envInt("FEEDBACK_IP_DAILY_LIMIT", 20), DAY_SECONDS)
      : hourly;
    if (!hourly.allowed || !daily.allowed) {
      const retryAfter = !hourly.allowed ? hourly.retryAfterSeconds : daily.retryAfterSeconds;
      return json(
        429,
        { ok: false, code: "rate_limited", error: "You've sent a lot of feedback recently. Please try again later." },
        { "Retry-After": String(retryAfter) },
      );
    }

    // 2) Size-capped JSON body.
    const declared = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json(413, { ok: false, code: "payload_too_large", error: "Request is too large." });
    }
    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
        return json(413, { ok: false, code: "payload_too_large", error: "Request is too large." });
      }
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { ok: false, error: "Invalid request body (expected JSON)" });
    }

    // 3) Validate every field.
    const optionalText = (v: unknown) => (v === undefined || v === null ? "" : v);
    const nameRaw = optionalText(body.name);
    const emailRaw = optionalText(body.email);
    const messageRaw = optionalText(body.message);
    const pageRaw = optionalText(body.pageUrl ?? body.page);
    if ([nameRaw, emailRaw, messageRaw, pageRaw].some((v) => typeof v !== "string")) {
      return json(400, { ok: false, error: "Invalid request body (expected JSON)" });
    }
    const name = (nameRaw as string).replace(CONTROL_CHARS, " ").trim();
    const email = (emailRaw as string).trim();
    const message = (messageRaw as string).replace(CONTROL_CHARS, " ").trim();
    const rating = body.rating;

    if (!message) {
      return json(400, { ok: false, error: "Please enter your feedback message" });
    }
    if (message.length > LIMITS.message) {
      return json(400, { ok: false, error: `Message is too long (max ${LIMITS.message} characters)` });
    }
    if (name.length > LIMITS.name) {
      return json(400, { ok: false, error: `Name is too long (max ${LIMITS.name} characters)` });
    }
    if (email && !isValidEmail(email)) {
      return json(400, { ok: false, error: "Please enter a valid email address" });
    }
    if (rating !== undefined && rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return json(400, { ok: false, error: "Rating must be between 1 and 5" });
    }

    const payload: FeedbackPayload = {
      name,
      email,
      rating: typeof rating === "number" ? rating : null,
      message,
      pageUrl: sanitizePageUrl((pageRaw as string) || null),
      createdAt: new Date().toISOString(),
    };

    // 4) Store it. This is the only step that can fail the request.
    try {
      await saveFeedback(payload);
    } catch (err: unknown) {
      safeLog("db failure", { code: (err as { code?: string })?.code, message: (err as Error)?.message });
      return json(500, { ok: false, error: GENERIC_ERROR });
    }
    safeLog("submitted", { hasUserEmail: !!payload.email, messageLen: payload.message.length });

    // 5) Emails never turn a saved submission into an error.
    await sendFeedbackEmail(payload);

    if (payload.email) {
      let session: { user?: { id?: string; email?: string | null } } | null = null;
      try {
        session = await auth();
      } catch {
        session = null;
      }
      const accountEmail = session?.user?.email?.trim().toLowerCase();
      const userId = session?.user?.id;
      if (userId && accountEmail && accountEmail === payload.email.toLowerCase()) {
        const allowed = await consumeRateLimit(
          `feedback:reply:user:${userId}`,
          envInt("FEEDBACK_REPLY_DAILY_LIMIT", 2),
          DAY_SECONDS,
        );
        if (allowed.allowed) await sendConfirmationToAccountEmail(accountEmail);
      }
    }

    return json(200, { ok: true });
  } catch (err: unknown) {
    safeLog("unexpected error", { message: (err as Error)?.message ?? "Unknown error" });
    return json(500, { ok: false, error: GENERIC_ERROR });
  }
}
