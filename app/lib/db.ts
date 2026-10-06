import { Pool } from "pg";

const dbUrl = process.env.DATABASE_URL || "";
const needsSsl = dbUrl.includes("neon.tech") || dbUrl.includes("neon/") ||
                 (process.env.NODE_ENV === "production" && !dbUrl.includes("sslmode=disable"));

const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

export default pool;

let initPromise: Promise<void> | null = null;

/**
 * Create/upgrade tables this app needs. Safe to call on every request: the
 * work runs once per server instance (concurrent callers share one promise)
 * and every statement is idempotent.
 */
export function ensureDB(): Promise<void> {
  if (!initPromise) {
    initPromise = runSchemaBootstrap().catch((err) => {
      initPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return initPromise;
}

async function runSchemaBootstrap() {
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

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key, window_start)
    );

  `);

  // Backfill columns for older databases (CREATE TABLE IF NOT EXISTS doesn't add new columns).
  await pool.query(`
    ALTER TABLE garage_vehicles ADD COLUMN IF NOT EXISTS nickname TEXT;
    ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS cost TEXT;
  `);

  // Email verification + safe account linking.
  //
  // The DO block runs its body exactly once: the first time the columns are
  // added. That is when existing accounts are classified, so nobody who could
  // sign in before is locked out:
  //   - Google-only accounts are marked verified (Google vouched for the email
  //     and there is no password that someone else could have set).
  //   - Accounts that have a password are marked "legacy_unverified": they keep
  //     working, but are not treated as proven owners of the email address.
  // No password is changed or removed here.
  await pool.query(`
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(727274001);
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified'
      ) THEN
        ALTER TABLE users ADD COLUMN email_verified TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_unverified BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE users SET email_verified = COALESCE(created_at, NOW())
          WHERE google_id IS NOT NULL AND password_hash IS NULL;
        UPDATE users SET legacy_unverified = TRUE
          WHERE password_hash IS NOT NULL;
      END IF;
    END $$;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_unverified BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
