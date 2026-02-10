import { NextRequest, NextResponse } from "next/server";
import pool, { ensureDB } from "../../lib/db";

export async function POST(req: NextRequest) {
  try {
    await ensureDB();
    const body = await req.json();
    const { name, email, rating, message, page } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (message.trim().length > 2000) {
      return NextResponse.json({ error: "Message too long (max 2000 characters)" }, { status: 400 });
    }

    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
      return NextResponse.json({ error: "Rating must be between 1 and 5" }, { status: 400 });
    }

    await pool.query(
      `INSERT INTO feedback (name, email, rating, message, page) VALUES ($1, $2, $3, $4, $5)`,
      [
        name?.trim() || null,
        email?.trim() || null,
        rating || null,
        message.trim(),
        page || null,
      ]
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Feedback error:", err);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
