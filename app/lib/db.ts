import { Pool } from "pg";

const dbUrl = process.env.DATABASE_URL || "";
const needsSsl = dbUrl.includes("neon.tech") || dbUrl.includes("neon/") ||
                 (process.env.NODE_ENV === "production" && !dbUrl.includes("sslmode=disable"));

const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

export default pool;

let initialized = false;

export async function ensureDB() {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      password_hash TEXT,
      google_id TEXT,
      first_name TEXT,
      last_name TEXT,
      profile_image TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_unique ON users (google_id) WHERE google_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS garage_vehicles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      year TEXT NOT NULL,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      engine TEXT,
      vin TEXT,
      nickname TEXT,
      is_active BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS maintenance_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vehicle_id TEXT NOT NULL REFERENCES garage_vehicles(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      mileage TEXT,
      cost TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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

  // Backfill columns for older databases (CREATE TABLE IF NOT EXISTS doesn't add new columns).
  await pool.query(`
    ALTER TABLE garage_vehicles ADD COLUMN IF NOT EXISTS nickname TEXT;
    ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS cost TEXT;
  `);
  initialized = true;
}
