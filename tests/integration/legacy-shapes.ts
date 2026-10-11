/**
 * Databases shaped the way older versions of the app left them, with sample
 * data, for the migration tests. Each shape is reconstructed from the table
 * definitions in the project's git history.
 *
 * None of this is used by the app. It exists to prove that the migrations take
 * every one of these to the same final database without losing a row.
 */

/** February 2026 prototype: no passwords, no Google ids, no feedback, no limits. */
export const PROTOTYPE_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT,
    first_name TEXT,
    last_name TEXT,
    profile_image TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE garage_vehicles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year TEXT NOT NULL,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    engine TEXT,
    vin TEXT,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE maintenance_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_id TEXT NOT NULL REFERENCES garage_vehicles(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    mileage TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE auth_pending (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    origin_host TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE auth_tokens (
    token TEXT PRIMARY KEY,
    sid TEXT NOT NULL,
    origin_host TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

/**
 * Just before Phase 1: passwords and Google sign-in exist, feedback has BOTH
 * page columns, the OEM code table and the auto-reply log exist. No email
 * verification columns, no rate limits, no verification tokens.
 */
export const BEFORE_PHASE_1_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT,
    password_hash TEXT,
    google_id TEXT,
    first_name TEXT,
    last_name TEXT,
    profile_image TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE UNIQUE INDEX users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL;
  CREATE UNIQUE INDEX users_google_id_unique ON users (google_id) WHERE google_id IS NOT NULL;
  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE garage_vehicles (
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
  CREATE TABLE maintenance_records (
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
  CREATE TABLE feedback (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT,
    rating INTEGER,
    message TEXT NOT NULL,
    page TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE feedback ADD COLUMN page_url TEXT;
  CREATE TABLE feedback_auto_reply_log (
    id SERIAL PRIMARY KEY,
    email_lower TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX idx_feedback_auto_reply_log_lookup ON feedback_auto_reply_log (email_lower, ip_hash, created_at);
  CREATE TABLE oem_fault_codes (
    make TEXT NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (make, code)
  );
`;

/** What the old code inserted into oem_fault_codes on its own. */
export const OEM_SEED_ROWS = `
  INSERT INTO oem_fault_codes (make, code, title, source) VALUES
    ('BMW', '480A12', 'Seed A', 'seed'),
    ('BMW', '480A0C', 'Seed B', 'seed'),
    ('BMW', '480A11', 'Seed C', 'seed'),
    ('BMW', '481A01', 'Seed D', 'seed');
`;

/**
 * Extra tables that exist in a production database of the Phase 2C era on top
 * of what that version's own start-up code creates: the ones later code stopped
 * creating.
 */
export const PHASE_2C_EXTRAS = `
  CREATE TABLE feedback_auto_reply_log (
    id SERIAL PRIMARY KEY,
    email_lower TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE oem_fault_codes (
    make TEXT NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (make, code)
  );
`;

/**
 * Sample accounts and garage data, written with only the columns every shape
 * that has passwords shares. Includes the awkward rows a real database has:
 * mixed-case email, missing timestamps, and text that does not convert.
 */
export const SAMPLE_ACCOUNTS = `
  INSERT INTO users (id, email, password_hash, google_id, first_name, created_at) VALUES
    ('u-password', 'pw.user@example.test',   'HASH-PASSWORD', NULL,        'Pat',  '2026-02-11T10:00:00Z'),
    ('u-google',   'google.user@example.test', NULL,           'g-1001',    'Gil',  '2026-02-12T10:00:00Z'),
    ('u-both',     'Both.User@Example.TEST',  'HASH-BOTH',     'g-1002',    'Bo',   NULL),
    ('u-noemail',  NULL,                      NULL,            'g-1003',    NULL,   '2026-03-01T10:00:00Z');
`;

export const SAMPLE_GARAGE = `
  INSERT INTO garage_vehicles (id, user_id, year, make, model, engine, vin, created_at) VALUES
    ('v-camry',  'u-password', '2015',      'Toyota', 'Camry',  '2.5L I4', '4T1BF1FK5FU000001', '2026-02-11T11:00:00Z'),
    ('v-accord', 'u-password', ' 2003 ',    'Honda',  'Accord', NULL,      NULL,                NULL),
    ('v-odd',    'u-google',   'two thousand', 'Ford', 'F-150', NULL,      NULL,                '2026-02-13T11:00:00Z'),
    ('v-old',    'u-both',     '1899',      'Benz',   'Patent', NULL,      NULL,                '2026-02-14T11:00:00Z');

  INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, notes, created_at) VALUES
    ('m-clean',   'u-password', 'v-camry',  'Oil Change',    '2026-01-15',  '120000',       'Synthetic', '2026-02-11T12:00:00Z'),
    ('m-commas',  'u-password', 'v-camry',  'Tire Rotation', '2026-02-01',  '121,500 km',   NULL,        '2026-02-11T12:05:00Z'),
    ('m-miles',   'u-password', 'v-accord', 'Brake Service', '2025-12-31',  '75,500 miles', NULL,        NULL),
    ('m-baddate', 'u-google',   'v-odd',    'Other',         'last tuesday', 'about 90k',   NULL,        '2026-02-13T12:00:00Z'),
    ('m-feb31',   'u-google',   'v-odd',    'Battery',       '2026-02-31',  '120.000',      NULL,        '2026-02-13T12:05:00Z'),
    ('m-nomiles', 'u-both',     'v-old',    'Coolant Flush', '2026-03-05',  NULL,           NULL,        '2026-03-05T12:00:00Z');
`;

/** Cost values, for shapes whose maintenance table has the column. */
export const SAMPLE_COSTS = `
  UPDATE maintenance_records SET cost = '120'        WHERE id = 'm-clean';
  UPDATE maintenance_records SET cost = '$1,250.50'  WHERE id = 'm-commas';
  UPDATE maintenance_records SET cost = '89.9'       WHERE id = 'm-miles';
  UPDATE maintenance_records SET cost = '120,50'     WHERE id = 'm-baddate';
  UPDATE maintenance_records SET cost = 'free'       WHERE id = 'm-feb31';
`;

export const SAMPLE_SESSIONS = `
  INSERT INTO sessions (sid, user_id, expires_at) VALUES
    ('sid-old-1', 'u-password', '2026-02-20T00:00:00Z'),
    ('sid-old-2', 'u-google',   '2026-02-21T00:00:00Z');
`;

/** Feedback written by both generations of the feedback code. */
export const SAMPLE_FEEDBACK = `
  INSERT INTO feedback (name, email, rating, message, page, page_url, created_at) VALUES
    ('Old',  'old@example.test',  5,    'Written by the first version',  '/diagnose',                 NULL,                              '2026-02-10T09:00:00Z'),
    ('New',  'new@example.test',  4,    'Written by the later version',  NULL,                        'https://www.carcodeai.com/',      '2026-02-15T09:00:00Z'),
    (NULL,   NULL,                NULL, 'No page at all',                NULL,                        NULL,                              NULL),
    ('Both', 'both@example.test', 3,    'Both columns, different values', '/old-path',                'https://www.carcodeai.com/new',   '2026-02-16T09:00:00Z');
`;

export const SAMPLE_PHASE_1_ROWS = `
  INSERT INTO rate_limits (key, window_start, count) VALUES
    ('diag:guest:day:ip:abc', NOW() - INTERVAL '1 hour', 3),
    ('login:ip:abc',          NOW() - INTERVAL '10 days', 9);
  INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES
    ('token-hash-1', 'u-password', NOW() + INTERVAL '1 day');
`;

/**
 * The statements the previous version of the app ran against the database
 * every time a server instance started (its `ensureDB()` and the table check
 * in the feedback route), copied from the Phase 2C code. Used to prove that
 * rolling the application back does not break against a migrated database.
 */
export const PREVIOUS_VERSION_STARTUP_SQL = `
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
  ALTER TABLE garage_vehicles ADD COLUMN IF NOT EXISTS nickname TEXT;
  ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS cost TEXT;
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
      UPDATE users SET email_verified = COALESCE(created_at, NOW()) WHERE google_id IS NOT NULL AND password_hash IS NULL;
      UPDATE users SET legacy_unverified = TRUE WHERE password_hash IS NOT NULL;
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
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS page_url TEXT;
`;

/**
 * What the previous version of the app (Phase 2C, the one a rollback returns
 * to) reads and writes through Prisma: every column of every model in its
 * `prisma/schema.prisma`, with the column type it expects, and the columns it
 * always supplies when it creates a row (the required fields of the model).
 * Copied from that file as it stood at commit e79758c.
 *
 * Used to prove that this release's migrations leave all of it in place.
 */
export const PHASE_2C_PRISMA_MODELS: Record<string, { columns: Record<string, string>; alwaysSupplied: string[] }> = {
  users: {
    columns: {
      id: "text", email: "text", password_hash: "text", google_id: "text", first_name: "text", last_name: "text", profile_image: "text",
      created_at: "timestamp with time zone", email_verified: "timestamp with time zone", session_version: "integer", legacy_unverified: "boolean",
    },
    alwaysSupplied: ["id", "created_at", "session_version", "legacy_unverified"],
  },
  email_verification_tokens: {
    columns: { token_hash: "text", user_id: "text", expires_at: "timestamp with time zone", created_at: "timestamp with time zone" },
    alwaysSupplied: ["token_hash", "user_id", "expires_at", "created_at"],
  },
  sessions: {
    columns: { sid: "text", user_id: "text", expires_at: "timestamp with time zone", created_at: "timestamp with time zone" },
    alwaysSupplied: ["sid", "user_id", "expires_at", "created_at"],
  },
  garage_vehicles: {
    columns: {
      id: "text", user_id: "text", year: "text", make: "text", model: "text", engine: "text", vin: "text", nickname: "text",
      is_active: "boolean", created_at: "timestamp with time zone",
    },
    alwaysSupplied: ["id", "user_id", "year", "make", "model", "is_active", "created_at"],
  },
  maintenance_records: {
    columns: {
      id: "text", user_id: "text", vehicle_id: "text", type: "text", date: "text", mileage: "text", notes: "text", cost: "text",
      created_at: "timestamp with time zone",
    },
    alwaysSupplied: ["id", "user_id", "vehicle_id", "type", "date", "created_at"],
  },
  rate_limits: {
    columns: { key: "text", window_start: "timestamp with time zone", count: "integer" },
    alwaysSupplied: ["key", "window_start", "count"],
  },
  feedback: {
    columns: { id: "integer", name: "text", email: "text", rating: "integer", message: "text", page: "text", created_at: "timestamp with time zone" },
    alwaysSupplied: ["message", "created_at"],
  },
};
