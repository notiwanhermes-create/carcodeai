/**
 * Email verification for password accounts: single-use tokens and the email
 * that carries them. Server-only.
 */
import { createHash, randomBytes } from "crypto";
import { Resend } from "resend";
import prisma from "./prisma";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Replace any outstanding tokens for the user with a fresh one. Returns the raw token (never stored). */
export async function issueVerificationToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.create({
      data: { tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
    }),
  ]);
  return token;
}

/** True when `token` is a live verification token belonging to `userId`. */
export async function isValidVerificationToken(token: string | null | undefined, userId: string): Promise<boolean> {
  if (!token || token.length < 32 || token.length > 128 || !/^[a-f0-9]+$/i.test(token)) return false;
  const row = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  return !!row && row.userId === userId && row.expiresAt.getTime() > Date.now();
}

function emailFrom(): string | undefined {
  return process.env.AUTH_EMAIL_FROM?.trim() || process.env.FEEDBACK_FROM?.trim() || undefined;
}

export function verificationEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY?.trim() && !!emailFrom();
}

/**
 * Whether new password sign-ups can be completed in this environment.
 * In production that needs a working email sender. In development the link is
 * printed to the server log instead, so local work does not need one.
 */
export function canSendVerification(): boolean {
  return verificationEmailConfigured() || process.env.NODE_ENV !== "production";
}

/** Site address used in emailed links. Prefers configuration over request headers. */
export function appBaseUrl(req?: Request): string {
  const configured = process.env.NEXTAUTH_URL?.trim() || process.env.AUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (req) {
    try {
      return new URL(req.url).origin;
    } catch {
      /* fall through */
    }
  }
  return "http://localhost:5000";
}

export type SendResult = "sent" | "logged" | "unavailable";

/**
 * Send the confirmation link. The message is fixed text plus the link — it
 * contains nothing typed by the person who registered.
 */
export async function sendVerificationEmail(email: string, token: string, req?: Request): Promise<SendResult> {
  // The address is deliberately not put in the link: URLs end up in logs and analytics.
  const link = `${appBaseUrl(req)}/login?verify=${token}`;

  if (!verificationEmailConfigured()) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[auth] Email is not configured. DEV-ONLY verification link for ${email}: ${link}`);
      return "logged";
    }
    console.error("[auth] Cannot send verification email: RESEND_API_KEY and AUTH_EMAIL_FROM (or FEEDBACK_FROM) are required.");
    return "unavailable";
  }

  const text = [
    "Confirm your email to finish creating your CarCode AI account.",
    "",
    `Open this link and sign in with the password you chose: ${link}`,
    "",
    "The link works for 24 hours.",
    "If you didn't create a CarCode AI account, you can ignore this email — nothing will happen.",
  ].join("\n");
  const html = [
    "<p>Confirm your email to finish creating your CarCode AI account.</p>",
    `<p><a href="${link}">Confirm my email</a></p>`,
    "<p>You'll be asked for the password you chose. The link works for 24 hours.</p>",
    "<p>If you didn't create a CarCode AI account, you can ignore this email — nothing will happen.</p>",
  ].join("");

  try {
    const resend = new Resend(process.env.RESEND_API_KEY as string);
    const { error } = await resend.emails.send({
      from: emailFrom() as string,
      to: [email],
      subject: "Confirm your email — CarCode AI",
      text,
      html,
    });
    if (error) {
      console.error("[auth] verification email failed:", error.message);
      return "unavailable";
    }
    return "sent";
  } catch (e) {
    console.error("[auth] verification email error:", (e as Error)?.message);
    return "unavailable";
  }
}
