/**
 * Sign-in / sign-up error codes and the text shown for them.
 * Safe to import from client components: no server-only code here.
 */

export const AUTH_ERROR_MESSAGES = {
  invalid_credentials: "Incorrect email or password.",
  use_google: "This account signs in with Google. Use the Google button below.",
  account_exists: "An account with this email already exists. Try signing in instead.",
  email_not_verified: "Please confirm your email first. Open the link we emailed you, then sign in.",
  verification_invalid: "That confirmation link has expired or was already used. Request a new one below.",
  weak_password: "Password must be at least 6 characters.",
  password_too_long: "Password is too long (max 200 characters).",
  invalid_email: "Please enter a valid email address.",
  invalid_request: "Please check the form and try again.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  email_unavailable: "Email sign-up isn't available right now. Please use Google sign-in instead.",
  google_email_unverified: "Google hasn't verified that email address yet. Verify it with Google, then try again.",
  google_unavailable: "Google sign-in isn't available right now. Please use your email and password.",
  server_error: "We couldn't complete that right now. Please try again in a moment.",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

/** Errors Auth.js itself puts in `?error=` (for example after a failed Google sign-in). */
const AUTHJS_ERROR_TO_CODE: Record<string, AuthErrorCode> = {
  CredentialsSignin: "invalid_credentials",
  AccessDenied: "server_error",
  Configuration: "server_error",
  CallbackRouteError: "server_error",
  OAuthSignInError: "server_error",
  OAuthCallbackError: "server_error",
  OAuthAccountNotLinked: "use_google",
  InvalidProvider: "google_unavailable",
  MissingCSRF: "server_error",
  Verification: "verification_invalid",
};

/**
 * Turn whatever came back from a sign-in attempt into a sentence a person can
 * act on. Unknown values fall back to a generic message — raw codes such as
 * "Configuration" are never shown.
 */
export function authErrorMessage(code?: string | null, authJsError?: string | null): string {
  if (code && code in AUTH_ERROR_MESSAGES) return AUTH_ERROR_MESSAGES[code as AuthErrorCode];
  if (authJsError && authJsError in AUTH_ERROR_MESSAGES) return AUTH_ERROR_MESSAGES[authJsError as AuthErrorCode];
  if (authJsError && authJsError in AUTHJS_ERROR_TO_CODE) return AUTH_ERROR_MESSAGES[AUTHJS_ERROR_TO_CODE[authJsError]];
  return AUTH_ERROR_MESSAGES.server_error;
}

/** Only allow same-site relative paths as post-login destinations. */
export function safeCallbackUrl(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}

export function isValidEmailFormat(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
