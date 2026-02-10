import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { Pool } from "pg";
import { Resend } from "resend";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

const AUTO_REPLY_MAX_PER_HOUR = 3;

/** Basic email format validation (RFC 5322 simplified). */
function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length > 254) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(trimmed);
}

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip + (process.env.RATE_LIMIT_SALT ?? "feedback")).digest("hex").slice(0, 32);
}

const GENERIC_ERROR = "Unable to send feedback right now. Please try again later.";

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
let rateLimitTableReady = false;

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
  `);
  tableReady = true;
}

async function ensureRateLimitTable(client: import("pg").PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS feedback_auto_reply_log (
      id SERIAL PRIMARY KEY,
      email_lower TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_auto_reply_log_lookup
    ON feedback_auto_reply_log (email_lower, ip_hash, created_at);
  `);
  rateLimitTableReady = true;
}

async function canSendAutoReply(
  client: import("pg").PoolClient,
  emailLower: string,
  ipHash: string
): Promise<boolean> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM feedback_auto_reply_log
     WHERE email_lower = $1 AND ip_hash = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
    [emailLower, ipHash]
  );
  return (r.rows[0]?.n ?? 0) < AUTO_REPLY_MAX_PER_HOUR;
}

async function recordAutoReplySent(
  client: import("pg").PoolClient,
  emailLower: string,
  ipHash: string
): Promise<void> {
  await client.query(
    `INSERT INTO feedback_auto_reply_log (email_lower, ip_hash) VALUES ($1, $2)`,
    [emailLower, ipHash]
  );
}

function safeLog(msg: string, meta?: Record<string, unknown>) {
  console.error("[feedback]", msg, meta ?? "");
}

/** Send feedback notification email via Resend. Logs on failure; does not throw. */
async function sendFeedbackEmail(payload: {
  name: string;
  email: string;
  rating: number | null;
  message: string;
  pageUrl: string | null;
  createdAt: string;
}) {
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
      replyTo: to,
      subject,
      text: body,
    });
    if (error) {
      safeLog("email failed", { error: error.message });
    }
  } catch (e) {
    safeLog("email error", { err: (e as Error)?.message });
  }
}

/** Send auto-reply to user. Logs on failure; does not throw. */
async function sendAutoReplyToUser(payload: {
  name: string;
  email: string;
  rating: number | null;
  message: string;
  pageUrl: string | null;
  createdAt: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FEEDBACK_FROM;
  const to = process.env.FEEDBACK_TO;
  if (!apiKey || !from || !to) return;
  const subject =
    process.env.FEEDBACK_REPLY_SUBJECT?.trim() || "We got your feedback — CarCode AI";
  const snippet =
    payload.message.length > 200
      ? payload.message.slice(0, 200).replace(/\n/g, " ") + "…"
      : payload.message.replace(/\n/g, " ");
  const text = [
    "Thanks for your feedback! We've received it and will use it to improve CarCode AI.",
    "",
    "Here's what you sent:",
    snippet,
    "",
    `If you have more to add, just reply to this email or contact us at ${to}.`,
  ].join("\n");
  const html = [
    "<p>Thanks for your feedback! We've received it and will use it to improve CarCode AI.</p>",
    "<p><strong>What you sent:</strong></p>",
    `<p>${escapeHtml(snippet)}</p>`,
    `<p>If you have more to add, just reply to this email or contact us at <a href="mailto:${escapeHtml(to)}">${escapeHtml(to)}</a>.</p>`,
  ].join("");
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: [payload.email],
      replyTo: to,
      subject,
      text,
      html,
    });
    if (error) safeLog("auto-reply failed", { hasUserEmail: true, messageLen: payload.message.length });
  } catch {
    safeLog("auto-reply error", { hasUserEmail: true, messageLen: payload.message.length });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Fallback when DATABASE_URL is missing: write to file and log, then return success. */
async function saveFeedbackFallback(payload: {
  name: string;
  email: string;
  rating: number | null;
  message: string;
  pageUrl: string | null;
  createdAt: string;
}) {
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
    const file = join(dir, "feedback.jsonl");
    await appendFile(file, line, "utf8");
  } catch (e) {
    safeLog("fallback file write failed", { err: (e as Error)?.message });
  }
}

function json(status: number, body: { ok: true } | { ok: false; error: string }) {
  return NextResponse.json(body, { status });
}

export function GET() {
  try {
    return json(200, { ok: true });
  } catch {
    return json(500, { ok: false, error: GENERIC_ERROR });
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { ok: false, error: "Invalid request body (expected JSON)" });
    }

    const name = typeof body.name === "string" ? body.name : "";
    const email = typeof body.email === "string" ? body.email : "";
    const rating = body.rating;
    const message = typeof body.message === "string" ? body.message : "";
    const pageUrl =
      (typeof body.pageUrl === "string" ? body.pageUrl : null) ||
      (typeof body.page === "string" ? body.page : null);

    if (!message.trim()) {
      return json(400, { ok: false, error: "Please enter your feedback message" });
    }
    if (message.trim().length > 2000) {
      return json(400, { ok: false, error: "Message is too long (max 2000 characters)" });
    }
    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
      return json(400, { ok: false, error: "Rating must be between 1 and 5" });
    }

    const createdAt = new Date().toISOString();
    const payload = {
      name: name.trim() || "",
      email: email.trim() || "",
      rating: rating == null ? null : Number(rating),
      message: message.trim(),
      pageUrl: pageUrl?.trim() || null,
      createdAt,
    };

    if (process.env.DATABASE_URL) {
      try {
        const p = getPool();
        const client = await p.connect();
        try {
          if (!tableReady) await ensureFeedbackTable(client);
          if (!rateLimitTableReady) await ensureRateLimitTable(client);
          await client.query(
            `INSERT INTO feedback (name, email, rating, message, page_url) VALUES ($1, $2, $3, $4, $5)`,
            [
              payload.name || null,
              payload.email || null,
              payload.rating,
              payload.message,
              payload.pageUrl ?? null,
            ]
          );
          safeLog("submitted", { hasUserEmail: !!payload.email, messageLen: payload.message.length });
          await sendFeedbackEmail(payload);

          const userEmail = payload.email.trim();
          if (userEmail && isValidEmail(userEmail)) {
            const from = process.env.FEEDBACK_FROM;
            if (!from?.trim()) {
              safeLog("auto-reply config missing", {});
              return json(500, {
                ok: false,
                error: "Server configuration error. Please try again later.",
              });
            }
            const ip = getClientIp(req);
            const ipHash = hashIp(ip);
            const emailLower = userEmail.toLowerCase();
            const allowed = await canSendAutoReply(client, emailLower, ipHash);
            if (allowed) {
              await sendAutoReplyToUser(payload);
              await recordAutoReplySent(client, emailLower, ipHash);
            }
          }
        } finally {
          client.release();
        }
        return json(200, { ok: true });
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        const msg = (err as { message?: string })?.message ?? "Unknown error";
        safeLog("db failure", { code, message: msg });
        return json(500, { ok: false, error: GENERIC_ERROR });
      }
    }

    await saveFeedbackFallback(payload);
    return json(200, { ok: true });
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? "Unknown error";
    safeLog("unexpected error", { message: msg });
    return json(500, { ok: false, error: GENERIC_ERROR });
  }
}
