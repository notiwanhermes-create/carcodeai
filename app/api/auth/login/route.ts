import { getLoginUrl } from "@/app/lib/auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const h = await headers();
    const hostname = h.get("x-forwarded-host") || h.get("host") || "";
    console.log("Login route: hostname =", hostname);
    const loginUrl = await getLoginUrl(hostname);
    console.log("Login route: redirecting to", loginUrl.substring(0, 80) + "...");
    return NextResponse.redirect(loginUrl);
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error("Login route error:", msg);
    return NextResponse.json(
      { error: "Login failed: " + msg },
      { status: 500 }
    );
  }
}
