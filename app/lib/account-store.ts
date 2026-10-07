/**
 * Database side of the account rules in account-policy.ts. Server-only.
 */
import prisma from "./prisma";
import { ensureDB } from "./db";
import { decideGoogleSignIn, type AccountRecord } from "./account-policy";

export const ACCOUNT_SELECT = {
  id: true,
  email: true,
  passwordHash: true,
  googleId: true,
  firstName: true,
  lastName: true,
  profileImage: true,
  emailVerified: true,
  legacyUnverified: true,
  sessionVersion: true,
} as const;

export type AccountRow = AccountRecord & {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImage: string | null;
  sessionVersion: number;
};

export type GoogleProfileInput = {
  googleId: string;
  /** Lower-cased email from the Google profile. */
  email: string;
  /** Google's own `email_verified` claim. */
  emailVerified: boolean;
  picture: string | null;
  givenName: string | null;
  familyName: string | null;
};

export type GoogleAccountResult =
  | { ok: true; user: AccountRow; action: "sign_in" | "link_trusted" | "claim_unverified" | "create" }
  | { ok: false; code: "google_email_unverified" };

/**
 * Find, link, claim or create the account for a Google sign-in, applying the
 * rules in decideGoogleSignIn.
 */
export async function resolveGoogleAccount(input: GoogleProfileInput): Promise<GoogleAccountResult> {
  await ensureDB();
  const [byGoogleId, byEmail] = await Promise.all([
    prisma.user.findUnique({ where: { googleId: input.googleId }, select: ACCOUNT_SELECT }),
    prisma.user.findUnique({ where: { email: input.email }, select: ACCOUNT_SELECT }),
  ]);

  const decision = decideGoogleSignIn({ emailVerifiedByGoogle: input.emailVerified, byGoogleId, byEmail });

  switch (decision.action) {
    case "deny":
      return { ok: false, code: decision.code };

    case "sign_in": {
      const existing = byGoogleId as AccountRow;
      const user = decision.markVerified
        ? await prisma.user.update({
            where: { id: existing.id },
            data: { emailVerified: new Date(), legacyUnverified: false },
            select: ACCOUNT_SELECT,
          })
        : existing;
      return { ok: true, user, action: "sign_in" };
    }

    case "link_trusted": {
      const existing = byEmail as AccountRow;
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: { googleId: input.googleId, profileImage: input.picture || existing.profileImage },
        select: ACCOUNT_SELECT,
      });
      return { ok: true, user, action: "link_trusted" };
    }

    case "claim_unverified": {
      // Google has proven who owns this email. Whoever set the old password may
      // not be that person, so the password and all existing sessions go.
      const [user] = await prisma.$transaction([
        prisma.user.update({
          where: { id: decision.userId },
          data: {
            googleId: input.googleId,
            emailVerified: new Date(),
            legacyUnverified: false,
            passwordHash: null,
            sessionVersion: { increment: 1 },
            ...(input.picture ? { profileImage: input.picture } : {}),
          },
          select: ACCOUNT_SELECT,
        }),
        prisma.emailVerificationToken.deleteMany({ where: { userId: decision.userId } }),
      ]);
      return { ok: true, user, action: "claim_unverified" };
    }

    case "create": {
      const user = await prisma.user.create({
        data: {
          email: input.email,
          googleId: input.googleId,
          firstName: input.givenName,
          lastName: input.familyName,
          profileImage: input.picture,
          emailVerified: new Date(),
        },
        select: ACCOUNT_SELECT,
      });
      return { ok: true, user, action: "create" };
    }
  }
}
