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

export type FeedbackRow = {
  created_at: string;
  rating: number | null;
  name: string | null;
  email: string | null;
  page_url: string | null;
  message: string;
};

export async function getFeedbackRows(): Promise<FeedbackRow[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT created_at, rating, name, email, page_url, message
       FROM feedback
       ORDER BY created_at DESC
       LIMIT 200`
    );
    return result.rows as FeedbackRow[];
  } finally {
    client.release();
  }
}
