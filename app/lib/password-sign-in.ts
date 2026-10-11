/**
 * Signing in with an email and password: the database side.
 *
 * Kept apart from the Auth.js configuration so that it can be tested against a
 * real database on its own. The rules themselves (who may sign in, and when an
 * account counts as verified) live in account-policy.ts. Server-only.
 */
import bcrypt from "bcryptjs";
import prisma from "./prisma";
import { decidePasswordLogin } from "./account-policy";
import { ACCOUNT_SELECT, type AccountRow } from "./account-store";
import { isValidVerificationToken } from "./email-verification";
import { consumeRateLimit, envInt } from "./rate-limit";
import type { AuthErrorCode } from "./auth-errors";

/** Compared against when the email is unknown, so response time does not reveal which emails exist. */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5KQ5QbT1HqFqUuSFOYJYxS6xXKX9fLa";

export type PasswordSignInInput = {
  email: string;
  password: string;
  /** The token from an emailed confirmation link, or "". */
  verifyToken: string;
  /** Hashed client IP, for the per-IP attempt limit. */
  ipKey: string;
};

export type PasswordSignInResult = { ok: true; user: AccountRow } | { ok: false; code: AuthErrorCode };

/**
 * Check an email and password. Returns the account, or the reason sign-in is
 * refused. Throws only when the database or another dependency fails.
 */
export async function signInWithPassword(input: PasswordSignInInput): Promise<PasswordSignInResult> {
  const email = input.email.toLowerCase().trim();
  const password = input.password;
  const verifyToken = input.verifyToken.trim();

  if (!email || !password || email.length > 254 || password.length > 200) {
    return { ok: false, code: "invalid_credentials" };
  }

  // Slow down password guessing. Per IP only, so nobody can lock another
  // person out of their account by guessing against it.
  const throttle = await consumeRateLimit(
    `login:ip:${input.ipKey}`,
    envInt("AUTH_LOGIN_IP_LIMIT", 30),
    envInt("AUTH_LOGIN_WINDOW_SECONDS", 900),
  );
  if (!throttle.allowed) return { ok: false, code: "rate_limited" };

  const user: AccountRow | null = await prisma.user.findUnique({ where: { email }, select: ACCOUNT_SELECT });

  const hashMatches = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  const passwordMatches = Boolean(user?.passwordHash) && hashMatches;
  const verificationTokenValid =
    user && passwordMatches && verifyToken ? await isValidVerificationToken(verifyToken, user.id) : false;

  const decision = decidePasswordLogin(user, { passwordMatches, verificationTokenValid });

  if (decision.action === "deny") {
    // A link was presented but is no longer valid: say so instead of "check your email".
    if (decision.code === "email_not_verified" && verifyToken) return { ok: false, code: "verification_invalid" };
    return { ok: false, code: decision.code };
  }

  // `user` is non-null for every non-deny decision.
  const account = user as AccountRow;
  if (decision.action === "allow_and_verify") {
    // Mark the address as proven and use up the link, together or not at all.
    await prisma.$transaction([
      prisma.user.update({ where: { id: account.id }, data: { emailVerified: new Date() } }),
      prisma.emailVerificationToken.deleteMany({ where: { userId: account.id } }),
    ]);
  }
  return { ok: true, user: account };
}
