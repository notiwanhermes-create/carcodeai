import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/app/lib/prisma";
import { ensureDB } from "@/app/lib/db";
import { readJsonBody } from "@/app/lib/http";
import { consumeRateLimit, envInt } from "@/app/lib/rate-limit";
import { clientIpKey, hashForRateLimit } from "@/app/lib/client-ip";
import { decideRegistration } from "@/app/lib/account-policy";
import { canSendVerification, issueVerificationToken, sendVerificationEmail } from "@/app/lib/email-verification";
import { AUTH_ERROR_MESSAGES, isValidEmailFormat, type AuthErrorCode } from "@/app/lib/auth-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR_SECONDS = 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;
const NAME_MAX = 60;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function fail(status: number, code: AuthErrorCode, headers?: Record<string, string>) {
  return NextResponse.json(
    { ok: false, code, error: AUTH_ERROR_MESSAGES[code] },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return cleaned || null;
}

/**
 * Create a password account. No session is started here: the account can only
 * be used after the emailed link is opened and the password entered again
 * (see app/lib/account-policy.ts for why).
 */
export async function POST(req: Request) {
  try {
    const ipKey = clientIpKey(req);
    const perIp = await consumeRateLimit(`register:ip:${ipKey}`, envInt("AUTH_REGISTER_IP_HOURLY_LIMIT", 10), HOUR_SECONDS);
    if (!perIp.allowed) return fail(429, "rate_limited", { "Retry-After": String(perIp.retryAfterSeconds) });

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) return fail(body.status, "invalid_request");
    const data = (body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {}) as Record<string, unknown>;

    const email = typeof data.email === "string" ? data.email.toLowerCase().trim() : "";
    const password = typeof data.password === "string" ? data.password : "";
    if (!email || !isValidEmailFormat(email)) return fail(400, "invalid_email");
    if (password.length < PASSWORD_MIN) return fail(400, "weak_password");
    if (password.length > PASSWORD_MAX) return fail(400, "password_too_long");

    // Without a way to deliver the link, the account could never be activated.
    if (!canSendVerification()) return fail(503, "email_unavailable");

    await ensureDB();
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, googleId: true, emailVerified: true, legacyUnverified: true },
    });
    const decision = decideRegistration(existing);
    if (decision.action === "deny") return fail(409, decision.code);

    // Cap confirmation emails per address, so sign-up cannot be used to flood someone's inbox.
    const perAddress = await consumeRateLimit(
      `verify:email:${hashForRateLimit(email)}`,
      envInt("AUTH_VERIFY_EMAIL_HOURLY_LIMIT", 3),
      HOUR_SECONDS,
    );
    if (!perAddress.allowed) return fail(429, "rate_limited", { "Retry-After": String(perAddress.retryAfterSeconds) });

    const passwordHash = await bcrypt.hash(password, 12);
    const firstName = cleanName(data.firstName);
    const lastName = cleanName(data.lastName);

    const user =
      decision.action === "replace_pending"
        ? await prisma.user.update({
            where: { id: decision.userId },
            data: { passwordHash, firstName, lastName },
            select: { id: true },
          })
        : await prisma.user.create({
            data: { email, passwordHash, firstName, lastName },
            select: { id: true },
          });

    const token = await issueVerificationToken(user.id);
    const delivery = await sendVerificationEmail(email, token, req);
    if (delivery === "unavailable") return fail(503, "email_unavailable");

    return NextResponse.json({ ok: true, verification: "sent" }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // Two sign-ups for the same new address at once: the unique index rejects the second.
    if ((err as { code?: string })?.code === "P2002") return fail(409, "account_exists");
    console.error("[POST /api/account/register]", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return fail(500, "server_error");
  }
}
