import { consumeAuthToken } from "@/app/lib/auth";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.redirect(new URL("/?auth_error=missing_token", req.url));
    }

    const result = await consumeAuthToken(token);

    if (!result) {
      return NextResponse.redirect(new URL("/?auth_error=invalid_token", req.url));
    }

    const h = await headers();
    const currentHost = (h.get("x-forwarded-host") || h.get("host") || "").split(":")[0].toLowerCase();
    const expectedHost = result.originHost.toLowerCase();

    if (currentHost !== expectedHost && currentHost !== expectedHost.replace(/^www\./, "") && `www.${currentHost}` !== expectedHost) {
      console.error("Auth complete: host mismatch. Current:", currentHost, "Expected:", expectedHost);
      return NextResponse.redirect(new URL("/?auth_error=host_mismatch", req.url));
    }

    const response = NextResponse.redirect(new URL("/", `https://${currentHost}`));
    response.cookies.set("carcode_sid", result.sid, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return response;
  } catch (e: any) {
    console.error("Auth complete error:", e?.message || e);
    return NextResponse.redirect(new URL("/?auth_error=server_error", req.url));
  }
}
