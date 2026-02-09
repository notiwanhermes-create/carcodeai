import { handleCallback, createSession, createAuthToken } from "@/app/lib/auth";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

function errorPage(msg: string, detail: string): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login Error</title></head>
    <body style="background:#0f172a;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
    <div style="max-width:400px;text-align:center;padding:2rem">
      <h2 style="color:#f87171">Sign In Error</h2>
      <p>${msg}</p>
      <p style="font-size:0.85rem;color:#94a3b8;word-break:break-all">${detail}</p>
      <a href="/" style="display:inline-block;margin-top:1rem;padding:0.5rem 1.5rem;background:#3b82f6;color:white;border-radius:8px;text-decoration:none">Go Back</a>
    </div></body></html>`,
    { status: 500, headers: { "Content-Type": "text/html" } }
  );
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const error = req.nextUrl.searchParams.get("error");
    const errorDesc = req.nextUrl.searchParams.get("error_description");

    const h = await headers();
    const hostname = h.get("x-forwarded-host") || h.get("host") || "";

    console.log("Auth callback: hostname =", hostname);

    if (error) {
      console.error("OIDC error:", error, errorDesc);
      return errorPage("Authentication was denied or failed.", `${error}: ${errorDesc || "No details"}`);
    }

    if (!code || !state) {
      console.error("Auth callback missing code or state");
      return errorPage("Missing authentication parameters.", "code or state missing from callback");
    }

    const result = await handleCallback(code, state);

    if (!result) {
      console.error("handleCallback returned null");
      return errorPage("Authentication failed.", "Could not complete the sign-in process. Please try again.");
    }

    const sid = await createSession(result.userId);
    const { originHost } = result;

    const currentHost = hostname.split(":")[0];
    const isCustomDomain = currentHost !== originHost && originHost && !originHost.includes("replit.dev");

    if (isCustomDomain) {
      const token = await createAuthToken(sid, originHost);
      return NextResponse.redirect(new URL(`https://${originHost}/api/auth/complete?token=${token}`));
    }

    const response = NextResponse.redirect(new URL(`https://${currentHost}/`));
    response.cookies.set("carcode_sid", sid, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return response;
  } catch (e: any) {
    console.error("Auth callback unhandled error:", e?.message || e);
    return errorPage("An unexpected error occurred.", e?.message || "Unknown error");
  }
}
