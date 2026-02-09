import { registerUser, createSession } from "@/app/lib/auth";
import pool, { ensureDB } from "@/app/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, firstName, lastName } = body;

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    const result = await registerUser(email, password, firstName, lastName);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 409 });
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
    console.error("Register error:", e?.message || e);
    return NextResponse.json({ error: "An unexpected error occurred." }, { status: 500 });
  }
}
