import { handleCallback, createSession } from "@/app/lib/auth";
import { cookies, headers } from "next/headers";
import { NextRequest } from "next/server";

function getPublicBaseUrl(reqUrl: string, host: string): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS;
  if (domain) {
    return `https://${domain}`;
  }
  if (host && !host.includes("0.0.0.0") && !host.includes("localhost")) {
    return `https://${host.split(":")[0]}`;
  }
  return reqUrl;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  const errorDesc = req.nextUrl.searchParams.get("error_description");

  const h = await headers();
  const hostname = h.get("x-forwarded-host") || h.get("host") || "";
  const baseUrl = getPublicBaseUrl(req.url, hostname);

  if (error) {
    console.error("OIDC error:", error, errorDesc);
    return Response.redirect(new URL("/", baseUrl));
  }

  if (!code || !state) {
    console.error("Auth callback missing code or state");
    return Response.redirect(new URL("/", baseUrl));
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get("carcode_auth_state")?.value;

  if (!savedState || savedState !== state) {
    console.error("Auth state mismatch. Saved:", !!savedState, "Received:", !!state);
    return Response.redirect(new URL("/", baseUrl));
  }

  const codeVerifier = cookieStore.get("carcode_code_verifier")?.value;
  cookieStore.delete("carcode_auth_state");
  cookieStore.delete("carcode_code_verifier");

  if (!codeVerifier) {
    console.error("Auth callback missing code_verifier cookie");
    return Response.redirect(new URL("/", baseUrl));
  }

  const result = await handleCallback(code, state, hostname, codeVerifier);

  if (!result) {
    console.error("handleCallback returned null");
    return Response.redirect(new URL("/", baseUrl));
  }

  const sid = await createSession(result.userId);

  cookieStore.set("carcode_sid", sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });

  return Response.redirect(new URL("/", baseUrl));
}
