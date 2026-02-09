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
    configCache = await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      clientId
    );
  }
  return configCache;
}

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

function getPublicHostname(): string {
  return process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS || FALLBACK_REPLIT_DOMAIN;
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

export async function getLoginUrl(hostname: string): Promise<string> {
  const config = await getOidcConfig();
  const publicHost = getPublicHostname();
  const redirectUri = `https://${publicHost}/api/auth/callback`;
  const state = randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const cookieStore = await cookies();
  cookieStore.set("carcode_auth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  cookieStore.set("carcode_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  const originHost = hostname.split(":")[0];
  if (originHost && originHost !== publicHost) {
    cookieStore.set("carcode_origin_host", originHost, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }

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
  state: string,
  hostname: string,
  codeVerifier: string
): Promise<{ userId: string } | null> {
  await ensureDB();
  const config = await getOidcConfig();
  const publicHost = getPublicHostname();
  const redirectUri = `https://${publicHost}/api/auth/callback`;

  try {
    console.log("Auth callback: redirectUri =", redirectUri, "hostname =", hostname);
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

    return { userId };
  } catch (e: any) {
    console.error("OIDC callback error:", e?.message || e);
    console.error("OIDC callback details - redirectUri:", redirectUri, "hostname:", hostname);
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sid = cookieStore.get("carcode_sid")?.value;
  if (sid) {
    await pool.query("DELETE FROM sessions WHERE sid = $1", [sid]);
  }
  cookieStore.delete("carcode_sid");
}
