/**
 * Account trust rules, as pure functions so they can be tested exhaustively.
 *
 * The problem being solved ("pre-hijacking"): anyone can register a password
 * account for an email address they do not own. If a later Google sign-in for
 * that address were simply linked to it, whoever set the password would keep
 * access to the real owner's account.
 *
 * The rules:
 *  1. A new password account cannot sign in until its email is verified, and
 *     verifying needs BOTH the emailed link and the account password. The real
 *     owner clicking a link they did not request does not activate anything.
 *  2. Google sign-in is accepted only when Google says the email is verified.
 *  3. When Google proves ownership of an email whose account is NOT verified,
 *     the account is claimed for the Google user: its password is removed and
 *     every existing session is signed out.
 *  4. Accounts that existed before these rules ("legacy") keep working, so
 *     nobody is locked out — but they are treated as unverified for rule 3,
 *     and a legacy account that already has Google attached must use Google.
 */

export type AccountRecord = {
  id: string;
  passwordHash: string | null;
  googleId: string | null;
  emailVerified: Date | null;
  legacyUnverified: boolean;
};

/** A password is trusted only on an account whose email ownership was proven. */
export function isTrustedAccount(user: AccountRecord): boolean {
  return user.emailVerified !== null;
}

/** A new password account that has not completed email verification yet. */
export function isPendingVerification(user: AccountRecord): boolean {
  return user.emailVerified === null && !user.legacyUnverified && !user.googleId && !!user.passwordHash;
}

export type RegistrationDecision =
  | { action: "create" }
  /** Same email registered but never verified: replace its password and re-send the link. */
  | { action: "replace_pending"; userId: string }
  | { action: "deny"; code: "account_exists" };

export function decideRegistration(existing: AccountRecord | null): RegistrationDecision {
  if (!existing) return { action: "create" };
  if (isPendingVerification(existing)) return { action: "replace_pending", userId: existing.id };
  return { action: "deny", code: "account_exists" };
}

export type PasswordLoginDecision =
  | { action: "allow" }
  /** Correct password plus a valid emailed token: mark verified, then allow. */
  | { action: "allow_and_verify" }
  | { action: "deny"; code: "invalid_credentials" | "use_google" | "email_not_verified" };

export function decidePasswordLogin(
  user: AccountRecord | null,
  input: { passwordMatches: boolean; verificationTokenValid: boolean },
): PasswordLoginDecision {
  if (!user) return { action: "deny", code: "invalid_credentials" };
  if (!user.passwordHash) {
    return { action: "deny", code: user.googleId ? "use_google" : "invalid_credentials" };
  }
  // Nothing about the account's state is revealed without the right password.
  if (!input.passwordMatches) return { action: "deny", code: "invalid_credentials" };

  if (isTrustedAccount(user)) return { action: "allow" };
  // Unverified from here on.
  if (user.googleId) return { action: "deny", code: "use_google" };
  if (user.legacyUnverified) return { action: "allow" };
  if (input.verificationTokenValid) return { action: "allow_and_verify" };
  return { action: "deny", code: "email_not_verified" };
}

export type GoogleSignInDecision =
  | { action: "deny"; code: "google_email_unverified" }
  /** Already linked and nothing to change. */
  | { action: "sign_in"; userId: string; markVerified: boolean }
  /** Attach Google to an account whose email was already proven. Password is kept. */
  | { action: "link_trusted"; userId: string }
  /** Take over an unverified account: verify, remove its password, sign out old sessions. */
  | { action: "claim_unverified"; userId: string }
  | { action: "create" };

export function decideGoogleSignIn(input: {
  emailVerifiedByGoogle: boolean;
  byGoogleId: AccountRecord | null;
  byEmail: AccountRecord | null;
}): GoogleSignInDecision {
  if (!input.emailVerifiedByGoogle) return { action: "deny", code: "google_email_unverified" };

  const linked = input.byGoogleId;
  if (linked) {
    if (isTrustedAccount(linked)) return { action: "sign_in", userId: linked.id, markVerified: false };
    // Linked under the old rules and never verified: a password on it may not be the owner's.
    if (linked.passwordHash) return { action: "claim_unverified", userId: linked.id };
    return { action: "sign_in", userId: linked.id, markVerified: true };
  }

  const sameEmail = input.byEmail;
  if (!sameEmail) return { action: "create" };
  if (isTrustedAccount(sameEmail)) return { action: "link_trusted", userId: sameEmail.id };
  return { action: "claim_unverified", userId: sameEmail.id };
}
