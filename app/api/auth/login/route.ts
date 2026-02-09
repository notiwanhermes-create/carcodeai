import { getLoginUrl } from "@/app/lib/auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

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

export async function GET() {
  let hostname = "";
  try {
    const h = await headers();
    hostname = h.get("x-forwarded-host") || h.get("host") || "";
    const bareHost = hostname.split(":")[0];

    if (bareHost.startsWith("www.")) {
      const nonWww = bareHost.replace(/^www\./, "");
      return NextResponse.redirect(new URL(`https://${nonWww}/api/auth/login`));
    }

    const loginUrl = await getLoginUrl(hostname);
    return NextResponse.redirect(new URL(loginUrl));
  } catch (e: any) {
    console.error("Login route error:", e?.message || e, "hostname:", hostname);
    return errorPage(
      "Could not start sign-in process.",
      `Host: ${hostname} | Error: ${e?.message || "Unknown error"}`
    );
  }
}
