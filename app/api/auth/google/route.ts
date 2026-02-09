import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { cookies } from "next/headers";

const ALLOWED_HOSTS = new Set([
  process.env.REPLIT_DEV_DOMAIN,
  ...(process.env.REPLIT_DOMAINS || "").split(",").filter(Boolean),
  "carcodeai.com",
  "www.carcodeai.com",
].filter(Boolean));

function getBaseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const cleanHost = host.split(":")[0];
  if (ALLOWED_HOSTS.has(cleanHost) || ALLOWED_HOSTS.has(host)) {
    return `https://${cleanHost}`;
  }
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS || "";
  if (domain) return `https://${domain.split(",")[0]}`;
  return "https://localhost:5000";
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    const baseUrl = getBaseUrl(req);
    return NextResponse.redirect(`${baseUrl}/?auth_error=google_not_configured`);
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/api/auth/google/callback`;

  const state = randomBytes(32).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set("google_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 600,
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "select_account",
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
