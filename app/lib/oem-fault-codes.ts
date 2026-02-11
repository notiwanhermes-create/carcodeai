import { Pool } from "pg";

export type OemFaultRow = {
  make: string;
  code: string;
  title: string;
  description: string | null;
  source: string | null;
};

let oemPool: Pool | null = null;

function getPool(): Pool {
  if (!oemPool) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL not configured");
    const needsSsl =
      dbUrl.includes("neon.tech") ||
      dbUrl.includes("neon/") ||
      (process.env.NODE_ENV === "production" && !dbUrl.includes("sslmode=disable"));
    oemPool = new Pool({
      connectionString: dbUrl,
      max: 2,
      connectionTimeoutMillis: 10000,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return oemPool;
}

let tableReady = false;

const BMW_SEED: OemFaultRow[] = [
  {
    make: "BMW",
    code: "480A12",
    title: "Rear brake pad wear sensor: wear limit reached / circuit open",
    description: "The rear brake pad wear sensor has reached its wear limit or the circuit is open. Replace the brake pads and the wear sensor as required.",
    source: "BMW fault code list (verified)",
  },
  {
    make: "BMW",
    code: "480A0C",
    title: "DME: Mass air flow sensor, plausibility",
    description: "The mass air flow (MAF) sensor signal is implausible compared to other engine parameters. May indicate a faulty MAF, intake leak, or wiring issue.",
    source: "BMW fault code list (verified)",
  },
  {
    make: "BMW",
    code: "480A11",
    title: "DME: Oxygen sensor before catalytic converter, signal",
    description: "Fault in the pre-cat oxygen sensor signal (Bank 1). The sensor may be faulty, contaminated, or have a wiring/connector issue.",
    source: "BMW fault code list (verified)",
  },
  {
    make: "BMW",
    code: "481A01",
    title: "DME: Crankshaft sensor, signal",
    description: "No signal or implausible signal from the crankshaft position sensor. Can cause no-start or rough running.",
    source: "BMW fault code list (verified)",
  },
];

async function ensureTable(client: import("pg").PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS oem_fault_codes (
      make TEXT NOT NULL,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (make, code)
    );
  `);
  tableReady = true;
}

async function seedBmwIfEmpty(client: import("pg").PoolClient) {
  const r = await client.query(
    `SELECT 1 FROM oem_fault_codes WHERE make = $1 LIMIT 1`,
    ["BMW"]
  );
  if (r.rowCount && r.rowCount > 0) return;
  for (const row of BMW_SEED) {
    await client.query(
      `INSERT INTO oem_fault_codes (make, code, title, description, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (make, code) DO NOTHING`,
      [row.make, row.code, row.title, row.description ?? null, row.source ?? null]
    );
  }
}

/**
 * Look up a manufacturer-specific fault code by make and code.
 * make is normalized to uppercase for storage/lookup; pass e.g. "BMW" or "bmw".
 */
export async function getOemFault(make: string, code: string): Promise<OemFaultRow | null> {
  const makeNorm = (make || "").trim().toUpperCase();
  const codeNorm = (code || "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!makeNorm || !codeNorm) return null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    if (!tableReady) await ensureTable(client);
    await seedBmwIfEmpty(client);

    const r = await client.query(
      `SELECT make, code, title, description, source
       FROM oem_fault_codes
       WHERE UPPER(TRIM(make)) = $1 AND UPPER(TRIM(REPLACE(REPLACE(code, ' ', ''), '-', ''))) = $2
       LIMIT 1`,
      [makeNorm, codeNorm]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      make: row.make,
      code: row.code,
      title: row.title,
      description: row.description ?? null,
      source: row.source ?? null,
    };
  } finally {
    client.release();
  }
}
