import NextAuth, { CredentialsSignin, type User } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import prisma from "./prisma";
import { ensureDB } from "./db";
import { decidePasswordLogin } from "./account-policy";
import { ACCOUNT_SELECT, resolveGoogleAccount, type AccountRow } from "./account-store";
import { isValidVerificationToken } from "./email-verification";
import { consumeRateLimit, envInt } from "./rate-limit";
import { clientIpKey } from "./client-ip";
import type { AuthErrorCode } from "./auth-errors";

const authBaseUrl = process.env.NEXTAUTH_URL || process.env.AUTH_URL;

if (!authBaseUrl && process.env.NODE_ENV === "production") {
  console.warn(
    "[auth] Missing NEXTAUTH_URL/AUTH_URL in production. Set NEXTAUTH_URL to your canonical https://www.<domain> to ensure correct callback URLs."
  );
}

const authSecret =
  process.env.AUTH_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  (process.env.NODE_ENV !== "production" ? "dev-only-auth-secret-change-me" : undefined);

if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET && process.env.NODE_ENV !== "production") {
  console.warn(
    "[auth] Using dev-only fallback secret. Set AUTH_SECRET (recommended) or NEXTAUTH_SECRET to silence this warning."
  );
}

// Accept the names this project has used, plus the Auth.js defaults.
const googleClientId =
  process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.AUTH_GOOGLE_ID || process.env.GOOGLE_CLIENT_ID;
const googleClientSecret =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || process.env.GOOGLE_CLIENT_SECRET;

/**
 * A sign-in failure the browser is allowed to see. Auth.js forwards only the
 * short `code`; anything else thrown from authorize() reaches the browser as
 * the unhelpful word "Configuration".
 */
class SignInError extends CredentialsSignin {
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

/** How often a session is re-checked against the database. */
const SESSION_RECHECK_MS = 60_000;
/** Compared against when the email is unknown, so response time does not reveal which emails exist. */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5KQ5QbT1HqFqUuSFOYJYxS6xXKX9fLa";

type SessionUser = User & { sessionVersion?: number };

function toSessionUser(u: AccountRow): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: [u.firstName, u.lastName].filter(Boolean).join(" ") || undefined,
    image: u.profileImage,
    sessionVersion: u.sessionVersion,
  };
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  secret: authSecret,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        verifyToken: { label: "Verification token", type: "text" },
      },
      async authorize(credentials, request) {
        const email = typeof credentials.email === "string" ? credentials.email.toLowerCase().trim() : "";
        const password = typeof credentials.password === "string" ? credentials.password : "";
        const verifyToken = typeof credentials.verifyToken === "string" ? credentials.verifyToken.trim() : "";

        if (!email || !password || email.length > 254 || password.length > 200) {
          throw new SignInError("invalid_credentials");
        }

        try {
          // Slow down password guessing. Per IP only, so nobody can lock another
          // person out of their account by guessing against it.
          const throttle = await consumeRateLimit(
            `login:ip:${clientIpKey(request)}`,
            envInt("AUTH_LOGIN_IP_LIMIT", 30),
            envInt("AUTH_LOGIN_WINDOW_SECONDS", 900),
          );
          if (!throttle.allowed) throw new SignInError("rate_limited");

          await ensureDB();
          const user: AccountRow | null = await prisma.user.findUnique({ where: { email }, select: ACCOUNT_SELECT });

          const hashMatches = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
          const passwordMatches = Boolean(user?.passwordHash) && hashMatches;
          const verificationTokenValid =
            user && passwordMatches && verifyToken ? await isValidVerificationToken(verifyToken, user.id) : false;

          const decision = decidePasswordLogin(user, { passwordMatches, verificationTokenValid });

          if (decision.action === "deny") {
            // A link was presented but is no longer valid: say so instead of "check your email".
            if (decision.code === "email_not_verified" && verifyToken) throw new SignInError("verification_invalid");
            throw new SignInError(decision.code);
          }

          // `user` is non-null for every non-deny decision.
          const account = user as AccountRow;
          if (decision.action === "allow_and_verify") {
            await prisma.$transaction([
              prisma.user.update({ where: { id: account.id }, data: { emailVerified: new Date() } }),
              prisma.emailVerificationToken.deleteMany({ where: { userId: account.id } }),
            ]);
          }
          return toSessionUser(account);
        } catch (err) {
          if (err instanceof CredentialsSignin) throw err;
          // Database or other server failure: log the cause, show a generic message.
          console.error("[auth] sign-in failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
          throw new SignInError("server_error");
        }
      },
    }),
    ...(googleClientId && googleClientSecret
      ? [
          Google({
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          }),
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
  },
  logger: {
    error(error) {
      // Wrong passwords are routine, not server errors: one short line, no stack trace.
      if (error instanceof CredentialsSignin) {
        console.warn(`[auth] sign-in rejected: ${error.code}`);
        return;
      }
      console.error("[auth][error]", error.name, error.message, error.cause ?? "");
    },
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      const email = typeof profile?.email === "string" ? profile.email.toLowerCase().trim() : "";
      const googleId = account.providerAccountId;
      if (!email || !googleId) return "/login?error=server_error";

      try {
        const result = await resolveGoogleAccount({
          googleId,
          email,
          emailVerified: profile?.email_verified === true,
          picture: typeof profile?.picture === "string" ? profile.picture : null,
          givenName: typeof profile?.given_name === "string" ? profile.given_name : null,
          familyName: typeof profile?.family_name === "string" ? profile.family_name : null,
        });
        if (!result.ok) return `/login?error=${result.code}`;

        user.id = result.user.id;
        (user as SessionUser).sessionVersion = result.user.sessionVersion;
        return true;
      } catch (err) {
        console.error("[auth] Google sign-in failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
        return "/login?error=server_error";
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.sv = (user as SessionUser).sessionVersion ?? 0;
        token.svCheckedAt = Date.now();
        return token;
      }

      // Periodically confirm the session is still valid: the account exists and
      // its sessions were not revoked (session_version bumped). Database trouble
      // must not sign everyone out, so a failed check keeps the session as it is.
      const userId = typeof token.userId === "string" ? token.userId : null;
      const lastChecked = typeof token.svCheckedAt === "number" ? token.svCheckedAt : 0;
      if (userId && Date.now() - lastChecked > SESSION_RECHECK_MS) {
        try {
          await ensureDB();
          const row = await prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
          const tokenVersion = typeof token.sv === "number" ? token.sv : 0;
          if (!row || row.sessionVersion !== tokenVersion) return null;
          token.svCheckedAt = Date.now();
        } catch (err) {
          console.error("[auth] session re-check skipped:", err instanceof Error ? err.message : err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) {
        session.user.id = token.userId as string;
      }
      return session;
    },
  },
  trustHost: true,
});
