import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import pool from "@/app/lib/db";

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.redirect(new URL("/?auth_error=missing_token", req.url));
    }

    const result = await pool.query(
      "SELECT sid, origin_host FROM auth_tokens WHERE token = $1 AND created_at > NOW() - INTERVAL '5 minutes'",
      [token]
    );

    if (result.rows.length === 0) {
      return NextResponse.redirect(new URL("/?auth_error=invalid_token", req.url));
    }

    const { sid, origin_host: originHost } = result.rows[0];

    await pool.query("DELETE FROM auth_tokens WHERE token = $1", [token]);
    await pool.query("DELETE FROM auth_tokens WHERE created_at < NOW() - INTERVAL '5 minutes'");

    const h = await headers();
    const currentHost = (h.get("x-forwarded-host") || h.get("host") || "").split(":")[0].toLowerCase();
    const expectedHost = originHost.toLowerCase();

    if (currentHost !== expectedHost && currentHost !== expectedHost.replace(/^www\./, "") && `www.${currentHost}` !== expectedHost) {
      console.error("Auth complete: host mismatch. Current:", currentHost, "Expected:", expectedHost);
      return NextResponse.redirect(new URL("/?auth_error=host_mismatch", req.url));
    }

    const response = NextResponse.redirect(new URL("/", `https://${currentHost}`));
    response.cookies.set("carcode_sid", sid, {
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
