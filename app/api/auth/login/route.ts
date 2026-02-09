import { loginUser, createSession } from "@/app/lib/auth";
import pool, { ensureDB } from "@/app/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    const result = await loginUser(email, password);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    const sid = await createSession(result.userId);

    await ensureDB();
    const userResult = await pool.query(
      "SELECT id, email, first_name, last_name, profile_image FROM users WHERE id = $1",
      [result.userId]
    );
    const user = userResult.rows[0] || null;

    const response = NextResponse.json({ success: true, user });
    response.cookies.set("carcode_sid", sid, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return response;
  } catch (e: any) {
    console.error("Login error:", e?.message || e);
    return NextResponse.json({ error: "An unexpected error occurred." }, { status: 500 });
  }
}
