import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

let adminPool: Pool | null = null;

function getPool(): Pool {
  if (!adminPool) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL not configured");
    const needsSsl =
      dbUrl.includes("neon.tech") ||
      dbUrl.includes("neon/") ||
      (process.env.NODE_ENV === "production" && !dbUrl.includes("sslmode=disable"));
    adminPool = new Pool({
      connectionString: dbUrl,
      max: 2,
      connectionTimeoutMillis: 10000,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return adminPool;
}

function getTokenFromRequest(req: NextRequest): string | null {
  const header = req.headers.get("x-admin-token");
  if (header?.trim()) return header.trim();
  const url = new URL(req.url);
  const query = url.searchParams.get("token");
  if (query?.trim()) return query.trim();
  return null;
}

function isAuthorized(req: NextRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken?.trim()) return false;
  const token = getTokenFromRequest(req);
  return token === adminToken.trim();
}

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: noCacheHeaders,
    });
  }

  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT created_at, rating, name, email, page_url, message
         FROM feedback
         ORDER BY created_at DESC
         LIMIT 200`
      );
      return NextResponse.json(result.rows, {
        headers: noCacheHeaders,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[admin/feedback]", err);
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500, headers: noCacheHeaders }
    );
  }
}
