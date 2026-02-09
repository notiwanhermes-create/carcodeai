import * as client from "openid-client";
import { cookies } from "next/headers";
import pool, { ensureDB } from "./db";
import { randomBytes, createHash } from "crypto";

let configCache: Awaited<ReturnType<typeof client.discovery>> | null = null;

const FALLBACK_CLIENT_ID = "513227df-7af3-4ecf-b6fb-3dd6b112bc28";
const FALLBACK_REPLIT_DOMAIN = "513227df-7af3-4ecf-b6fb-3dd6b112bc28-00-3mrjts8yngnmn.riker.replit.dev";

function getClientId(): string {
  return process.env.REPL_ID || process.env.OIDC_CLIENT_ID || FALLBACK_CLIENT_ID;
}

async function getOidcConfig() {
  if (!configCache) {
    const clientId = getClientId();
    if (!clientId) throw new Error("Missing REPL_ID or OIDC_CLIENT_ID");
    const timeoutMs = 10000;
    const discoveryPromise = client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      clientId
    );
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OIDC discovery timed out after 10s")), timeoutMs)
    );
    configCache = await Promise.race([discoveryPromise, timeoutPromise]);
  }
  return configCache;
}

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

function getReplitDomain(): string {
  return process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS || FALLBACK_REPLIT_DOMAIN;
}

function isAllowedOriginHost(host: string): boolean {
  const clean = host.split(":")[0].toLowerCase();
  const replitDomain = getReplitDomain().toLowerCase();
  if (clean === replitDomain) return true;
  const allowedCustomDomains = ["carcodeai.com", "www.carcodeai.com"];
  if (allowedCustomDomains.includes(clean)) return true;
  if (clean.endsWith(".replit.dev") || clean.endsWith(".repl.co")) return true;
  return false;
}

function sanitizeOriginHost(host: string): string {
  const clean = host.split(":")[0].toLowerCase();
  if (isAllowedOriginHost(clean)) return clean;
  return getReplitDomain();
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function createSession(userId: string): Promise<string> {
  await ensureDB();
  const sid = generateSessionId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    "INSERT INTO sessions (sid, user_id, expires_at) VALUES ($1, $2, $3)",
    [sid, userId, expiresAt]
  );
  return sid;
}

export async function getSessionUser(): Promise<{
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_image: string | null;
} | null> {
  try {
    await ensureDB();
    const cookieStore = await cookies();
    const sid = cookieStore.get("carcode_sid")?.value;
    if (!sid) return null;

    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.profile_image
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.sid = $1 AND s.expires_at > NOW()`,
      [sid]
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

export async function getLoginUrl(requestHostname: string): Promise<string> {
  await ensureDB();
  const config = await getOidcConfig();
  const replitDomain = getReplitDomain();
  const redirectUri = `https://${replitDomain}/api/auth/callback`;
  const state = randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const originHost = sanitizeOriginHost(requestHostname);

  await pool.query(
    "INSERT INTO auth_pending (state, code_verifier, origin_host) VALUES ($1, $2, $3)",
    [state, codeVerifier, originHost]
  );

  await pool.query(
    "DELETE FROM auth_pending WHERE created_at < NOW() - INTERVAL '10 minutes'"
  );

  const authUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return authUrl.href;
}

export async function handleCallback(
  code: string,
  state: string
): Promise<{ userId: string; originHost: string } | null> {
  await ensureDB();
  const config = await getOidcConfig();
  const replitDomain = getReplitDomain();
  const redirectUri = `https://${replitDomain}/api/auth/callback`;

  const pendingResult = await pool.query(
    "SELECT code_verifier, origin_host FROM auth_pending WHERE state = $1 AND created_at > NOW() - INTERVAL '10 minutes'",
    [state]
  );

  if (pendingResult.rows.length === 0) {
    console.error("Auth callback: no matching pending state found");
    return null;
  }

  const { code_verifier: codeVerifier, origin_host: originHost } = pendingResult.rows[0];

  await pool.query("DELETE FROM auth_pending WHERE state = $1", [state]);

  try {
    console.log("Auth callback: redirectUri =", redirectUri);
    const tokens = await client.authorizationCodeGrant(
      config,
      new URL(`${redirectUri}?code=${code}&state=${state}`),
      {
        expectedState: state,
        pkceCodeVerifier: codeVerifier,
      }
    );

    const claims = tokens.claims();
    if (!claims) {
      console.error("Auth callback: no claims returned");
      return null;
    }

    const userId = claims.sub;
    const email = (claims as any).email || null;
    const firstName = (claims as any).first_name || null;
    const lastName = (claims as any).last_name || null;
    const profileImage = (claims as any).profile_image_url || null;

    await pool.query(
      `INSERT INTO users (id, email, first_name, last_name, profile_image)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET email = $2, first_name = $3, last_name = $4, profile_image = $5`,
      [userId, email, firstName, lastName, profileImage]
    );

    return { userId, originHost };
  } catch (e: any) {
    console.error("OIDC callback error:", e?.message || e);
    console.error("OIDC callback details - redirectUri:", redirectUri);
    return null;
  }
}

export async function createAuthToken(sid: string, originHost: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO auth_tokens (token, sid, origin_host) VALUES ($1, $2, $3)",
    [token, sid, originHost]
  );
  await pool.query(
    "DELETE FROM auth_tokens WHERE created_at < NOW() - INTERVAL '5 minutes'"
  );
  return token;
}

export async function consumeAuthToken(token: string): Promise<{ sid: string; originHost: string } | null> {
  const result = await pool.query(
    "SELECT sid, origin_host FROM auth_tokens WHERE token = $1 AND created_at > NOW() - INTERVAL '5 minutes'",
    [token]
  );
  if (result.rows.length === 0) return null;
  await pool.query("DELETE FROM auth_tokens WHERE token = $1", [token]);
  return { sid: result.rows[0].sid, originHost: result.rows[0].origin_host };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sid = cookieStore.get("carcode_sid")?.value;
  if (sid) {
    await pool.query("DELETE FROM sessions WHERE sid = $1", [sid]);
  }
  cookieStore.delete("carcode_sid");
}
