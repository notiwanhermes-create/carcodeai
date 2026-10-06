import { NextResponse } from "next/server";
import prisma from "@/app/lib/prisma";
import { ensureDB } from "@/app/lib/db";
import { readJsonBody } from "@/app/lib/http";
import { consumeRateLimit, envInt } from "@/app/lib/rate-limit";
import { clientIpKey, hashForRateLimit } from "@/app/lib/client-ip";
import { isPendingVerification } from "@/app/lib/account-policy";
import { canSendVerification, issueVerificationToken, sendVerificationEmail } from "@/app/lib/email-verification";
import { AUTH_ERROR_MESSAGES, isValidEmailFormat, type AuthErrorCode } from "@/app/lib/auth-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR_SECONDS = 60 * 60;

function fail(status: number, code: AuthErrorCode, headers?: Record<string, string>) {
  return NextResponse.json(
    { ok: false, code, error: AUTH_ERROR_MESSAGES[code] },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

/**
 * Send a fresh confirmation link. The answer is the same whether or not the
 * address has an account waiting, so this cannot be used to discover accounts.
 */
export async function POST(req: Request) {
  try {
    const perIp = await consumeRateLimit(
      `resend:ip:${clientIpKey(req)}`,
      envInt("AUTH_REGISTER_IP_HOURLY_LIMIT", 10),
      HOUR_SECONDS,
    );
    if (!perIp.allowed) return fail(429, "rate_limited", { "Retry-After": String(perIp.retryAfterSeconds) });

    const body = await readJsonBody(req, 2 * 1024);
    if (!body.ok) return fail(body.status, "invalid_request");
    const data = (body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {}) as Record<string, unknown>;
    const email = typeof data.email === "string" ? data.email.toLowerCase().trim() : "";
    if (!email || !isValidEmailFormat(email)) return fail(400, "invalid_email");

    if (!canSendVerification()) return fail(503, "email_unavailable");

    const perAddress = await consumeRateLimit(
      `verify:email:${hashForRateLimit(email)}`,
      envInt("AUTH_VERIFY_EMAIL_HOURLY_LIMIT", 3),
      HOUR_SECONDS,
    );
    if (!perAddress.allowed) return fail(429, "rate_limited", { "Retry-After": String(perAddress.retryAfterSeconds) });

    await ensureDB();
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, googleId: true, emailVerified: true, legacyUnverified: true },
    });
    if (user && isPendingVerification(user)) {
      const token = await issueVerificationToken(user.id);
      await sendVerificationEmail(email, token, req);
    }

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[POST /api/account/resend-verification]", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return fail(500, "server_error");
  }
}
