import { describe, expect, it } from "vitest";
import {
  decideGoogleSignIn,
  decidePasswordLogin,
  decideRegistration,
  isPendingVerification,
  type AccountRecord,
} from "../app/lib/account-policy";
import { authErrorMessage, safeCallbackUrl } from "../app/lib/auth-errors";

const NOW = new Date("2026-10-05T00:00:00Z");

function account(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return { id: "u1", passwordHash: "hash", googleId: null, emailVerified: null, legacyUnverified: false, ...overrides };
}

const pending = account(); // new password account, link not confirmed yet
const verified = account({ emailVerified: NOW });
const legacyPasswordOnly = account({ legacyUnverified: true });
const legacyDual = account({ legacyUnverified: true, googleId: "g-1" });
const googleOnly = account({ passwordHash: null, googleId: "g-1", emailVerified: NOW });

describe("registration", () => {
  it("creates an account for a new address", () => {
    expect(decideRegistration(null)).toEqual({ action: "create" });
  });

  it("lets an unconfirmed sign-up be redone (so squatting an address blocks nobody)", () => {
    expect(isPendingVerification(pending)).toBe(true);
    expect(decideRegistration(pending)).toEqual({ action: "replace_pending", userId: "u1" });
  });

  it("refuses when a real account already exists", () => {
    for (const existing of [verified, legacyPasswordOnly, legacyDual, googleOnly]) {
      expect(decideRegistration(existing)).toEqual({ action: "deny", code: "account_exists" });
    }
  });
});

describe("password sign-in", () => {
  const ok = { passwordMatches: true, verificationTokenValid: false };

  it("rejects unknown emails and wrong passwords with the same code", () => {
    expect(decidePasswordLogin(null, ok)).toEqual({ action: "deny", code: "invalid_credentials" });
    for (const u of [pending, verified, legacyPasswordOnly, legacyDual]) {
      expect(decidePasswordLogin(u, { passwordMatches: false, verificationTokenValid: true })).toEqual({
        action: "deny",
        code: "invalid_credentials",
      });
    }
  });

  it("points Google-only accounts to the Google button", () => {
    expect(decidePasswordLogin(googleOnly, ok)).toEqual({ action: "deny", code: "use_google" });
  });

  it("allows verified accounts", () => {
    expect(decidePasswordLogin(verified, ok)).toEqual({ action: "allow" });
  });

  it("blocks a new account until the emailed link AND the password are both presented", () => {
    expect(decidePasswordLogin(pending, ok)).toEqual({ action: "deny", code: "email_not_verified" });
    expect(decidePasswordLogin(pending, { passwordMatches: true, verificationTokenValid: true })).toEqual({
      action: "allow_and_verify",
    });
    // Holding the link without knowing the password activates nothing.
    expect(decidePasswordLogin(pending, { passwordMatches: false, verificationTokenValid: true }).action).toBe("deny");
  });

  it("does not lock out accounts created before verification existed", () => {
    expect(decidePasswordLogin(legacyPasswordOnly, ok)).toEqual({ action: "allow" });
  });

  it("refuses the password on an unverified account that already has Google attached", () => {
    expect(decidePasswordLogin(legacyDual, ok)).toEqual({ action: "deny", code: "use_google" });
  });
});

describe("Google sign-in", () => {
  const google = { emailVerifiedByGoogle: true, byGoogleId: null, byEmail: null };

  it("requires Google to have verified the email", () => {
    for (const byEmail of [null, pending, verified, legacyPasswordOnly]) {
      expect(decideGoogleSignIn({ emailVerifiedByGoogle: false, byGoogleId: null, byEmail })).toEqual({
        action: "deny",
        code: "google_email_unverified",
      });
    }
  });

  it("creates a new account when the email is unknown", () => {
    expect(decideGoogleSignIn(google)).toEqual({ action: "create" });
  });

  it("links to an account whose email was already proven, keeping its password", () => {
    expect(decideGoogleSignIn({ ...google, byEmail: verified })).toEqual({ action: "link_trusted", userId: "u1" });
  });

  it("claims a pre-registered, unconfirmed account instead of trusting its password", () => {
    // The attack: someone registers the victim's address with their own password.
    expect(decideGoogleSignIn({ ...google, byEmail: pending })).toEqual({ action: "claim_unverified", userId: "u1" });
    // Same for an account pre-registered before verification existed.
    expect(decideGoogleSignIn({ ...google, byEmail: legacyPasswordOnly })).toEqual({ action: "claim_unverified", userId: "u1" });
  });

  it("cleans up accounts that were auto-linked under the old rules", () => {
    expect(decideGoogleSignIn({ ...google, byGoogleId: legacyDual })).toEqual({ action: "claim_unverified", userId: "u1" });
  });

  it("signs in an already-linked account without changing it", () => {
    expect(decideGoogleSignIn({ ...google, byGoogleId: googleOnly })).toEqual({ action: "sign_in", userId: "u1", markVerified: false });
    const verifiedDual = account({ googleId: "g-1", emailVerified: NOW });
    expect(decideGoogleSignIn({ ...google, byGoogleId: verifiedDual })).toEqual({ action: "sign_in", userId: "u1", markVerified: false });
  });

  it("marks an old Google-only account verified on next sign-in", () => {
    const oldGoogleOnly = account({ passwordHash: null, googleId: "g-1", emailVerified: null });
    expect(decideGoogleSignIn({ ...google, byGoogleId: oldGoogleOnly })).toEqual({ action: "sign_in", userId: "u1", markVerified: true });
  });

  it("after a claim, the old password can no longer sign in", () => {
    // State after claim_unverified is applied: password removed, Google attached, verified.
    const claimed = account({ passwordHash: null, googleId: "g-1", emailVerified: NOW });
    expect(decidePasswordLogin(claimed, { passwordMatches: true, verificationTokenValid: false })).toEqual({
      action: "deny",
      code: "use_google",
    });
  });
});

describe("messages and redirects", () => {
  it("never shows raw Auth.js codes such as \"Configuration\"", () => {
    for (const raw of ["Configuration", "CallbackRouteError", "AccessDenied", "SomethingNew", "", null, undefined]) {
      const msg = authErrorMessage(undefined, raw);
      expect(msg).not.toMatch(/Configuration|CallbackRouteError|AccessDenied|SomethingNew/);
      expect(msg.length).toBeGreaterThan(10);
    }
  });

  it("maps known codes to specific messages", () => {
    expect(authErrorMessage("invalid_credentials", "CredentialsSignin")).toBe("Incorrect email or password.");
    expect(authErrorMessage("account_exists")).toMatch(/already exists/);
    expect(authErrorMessage("use_google", "CredentialsSignin")).toMatch(/Google/);
    expect(authErrorMessage(undefined, "CredentialsSignin")).toBe("Incorrect email or password.");
    expect(authErrorMessage("server_error")).not.toMatch(/database|prisma|stack/i);
  });

  it("only allows same-site paths as post-login destinations", () => {
    expect(safeCallbackUrl("/dashboard")).toBe("/dashboard");
    expect(safeCallbackUrl("https://evil.example")).toBe("/");
    expect(safeCallbackUrl("//evil.example")).toBe("/");
    expect(safeCallbackUrl("/\\evil.example")).toBe("/");
    expect(safeCallbackUrl(null)).toBe("/");
  });
});
