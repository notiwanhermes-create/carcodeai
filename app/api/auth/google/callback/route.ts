import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { findOrCreateGoogleUser, createSession } from "@/app/lib/auth";

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
    return `https://${host}`;
  }
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS || "";
  if (domain) return `https://${domain.split(",")[0]}`;
  return "https://localhost:5000";
}

export async function GET(req: NextRequest) {
  const baseUrl = getBaseUrl(req);

  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return NextResponse.redirect(`${baseUrl}/?auth_error=google_not_configured`);
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return NextResponse.redirect(`${baseUrl}/?auth_error=google_denied`);
    }

    if (!code || !state) {
      return NextResponse.redirect(`${baseUrl}/?auth_error=missing_params`);
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get("google_oauth_state")?.value;
    cookieStore.delete("google_oauth_state");

    if (!savedState || savedState !== state) {
      return NextResponse.redirect(`${baseUrl}/?auth_error=invalid_state`);
    }

    const redirectUri = `${baseUrl}/api/auth/google/callback`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("Google token error:", tokenData);
      return NextResponse.redirect(`${baseUrl}/?auth_error=token_failed`);
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    if (!userInfo.email || !userInfo.verified_email) {
      return NextResponse.redirect(`${baseUrl}/?auth_error=email_not_verified`);
    }

    const userId = await findOrCreateGoogleUser(
      userInfo.id,
      userInfo.email,
      userInfo.given_name,
      userInfo.family_name,
      userInfo.picture
    );

    const sid = await createSession(userId);

    const response = NextResponse.redirect(`${baseUrl}/`);
    response.cookies.set("carcode_sid", sid, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return response;
  } catch (e: any) {
    console.error("Google OAuth callback error:", e?.message || e);
    return NextResponse.redirect(`${baseUrl}/?auth_error=unexpected`);
  }
}
