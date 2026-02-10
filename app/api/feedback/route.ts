import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

let feedbackPool: Pool | null = null;

function getPool() {
  if (!feedbackPool) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL not configured");
    }
    const needsSsl = dbUrl.includes("neon.tech") || dbUrl.includes("neon/") || 
                     (process.env.NODE_ENV === "production" && !dbUrl.includes("sslmode=disable"));
    feedbackPool = new Pool({
      connectionString: dbUrl,
      max: 3,
      connectionTimeoutMillis: 10000,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return feedbackPool;
}

let tableReady = false;

async function ensureFeedbackTable() {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        rating INTEGER,
        message TEXT NOT NULL,
        page TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    tableReady = true;
  } finally {
    client.release();
  }
}

export async function POST(req: NextRequest) {
  try {
    const p = getPool();

    if (!tableReady) {
      await ensureFeedbackTable();
    }

    const body = await req.json();
    const { name, email, rating, message, page } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json({ error: "Please enter your feedback message" }, { status: 400 });
    }

    if (message.trim().length > 2000) {
      return NextResponse.json({ error: "Message is too long (max 2000 characters)" }, { status: 400 });
    }

    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
      return NextResponse.json({ error: "Rating must be between 1 and 5" }, { status: 400 });
    }

    const client = await p.connect();
    try {
      await client.query(
        `INSERT INTO feedback (name, email, rating, message, page) VALUES ($1, $2, $3, $4, $5)`,
        [
          name?.trim() || null,
          email?.trim() || null,
          rating || null,
          message.trim(),
          page || null,
        ]
      );
    } finally {
      client.release();
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Feedback error:", err?.message, err?.code);
    return NextResponse.json(
      { error: "Unable to send feedback right now. Please try again later." },
      { status: 500 }
    );
  }
}
