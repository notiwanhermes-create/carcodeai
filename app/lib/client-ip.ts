import { createHash } from "crypto";

type HeaderSource = { headers: { get(name: string): string | null } };

function firstIp(value: string | null): string {
  return (value ?? "").split(",")[0]?.trim() ?? "";
}

/**
 * Best-effort client IP.
 *
 * On Vercel, `x-forwarded-for` / `x-real-ip` are set by the platform and cannot
 * be spoofed by the caller. If the site sits behind another proxy (for example
 * Cloudflare), set TRUSTED_IP_HEADER (e.g. "cf-connecting-ip") so the real
 * visitor address is used instead of the proxy's.
 */
export function getClientIp(req: HeaderSource): string {
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) {
    const ip = firstIp(req.headers.get(trusted));
    if (ip) return ip;
  }
  return (
    firstIp(req.headers.get("x-vercel-forwarded-for")) ||
    firstIp(req.headers.get("x-real-ip")) ||
    firstIp(req.headers.get("x-forwarded-for")) ||
    "unknown"
  );
}

/** One-way hash so raw IP addresses are never stored in rate-limit keys. */
export function hashForRateLimit(value: string): string {
  const salt = process.env.RATE_LIMIT_SALT || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "carcode";
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}

/** Convenience: hashed client IP for use in a rate-limit key. */
export function clientIpKey(req: HeaderSource): string {
  return hashForRateLimit(getClientIp(req));
}
