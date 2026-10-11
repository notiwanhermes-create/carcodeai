#!/usr/bin/env node
/**
 * Read-only report on a CarCode database:  npm run db:inspect
 *
 * Shows what is actually there (tables, columns, indexes, constraints,
 * migration history) and counts the rows a migration has to be careful with.
 * Run it against a database BEFORE migrating it, and again afterwards.
 *
 * It changes nothing: everything runs inside a READ ONLY transaction, so the
 * database itself refuses any write. It prints counts and structure only,
 * never the contents of a row.
 *
 *   --json   print the report as JSON instead of text
 */
import process from "node:process";
import pg from "pg";

const url = (process.env.DIRECT_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
const asJson = process.argv.includes("--json");

const APP_TABLES = ["users", "email_verification_tokens", "garage_vehicles", "maintenance_records", "rate_limits", "feedback"];
const LEGACY_TABLES = ["sessions", "auth_pending", "auth_tokens", "feedback_auto_reply_log", "oem_fault_codes", "legacy_oem_fault_codes_archive"];
const OEM_SEED = "UPPER(BTRIM(make)) = 'BMW' AND UPPER(BTRIM(code)) IN ('480A12', '480A0C', '480A11', '481A01')";

// The same patterns the converge_and_expand migration uses.
const YEAR_OK = `BTRIM("year") ~ '^(19|20)[0-9]{2}$'`;
const DATE_SHAPE_OK = `BTRIM("date") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
const ODOMETER_OK = `LOWER(BTRIM("mileage")) ~ '^([0-9]{1,3}(,[0-9]{3})+|[0-9]{1,7}) ?(km|kms|kilometers|kilometres|mi|mile|miles)?$'`;
const COST_TEXT = `BTRIM(LTRIM(BTRIM("cost"), '$'))`;
const COST_OK = `(${COST_TEXT} ~ '^[0-9]{1,3}(,[0-9]{3})+(\\.[0-9]{1,2})?$' OR ${COST_TEXT} ~ '^[0-9]{1,9}(\\.[0-9]{1,2})?$')`;

function target(u) {
  try {
    const p = new URL(u);
    return `${p.hostname}${p.pathname}`;
  } catch {
    return "(unreadable address)";
  }
}

async function main() {
  if (!url) {
    console.error("No database address is configured. Set DIRECT_URL or DATABASE_URL.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const report = { database: target(url), generatedAt: new Date().toISOString() };

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const rows = async (sql, params = []) => (await client.query(sql, params)).rows;
    const one = async (sql, params = []) => (await rows(sql, params))[0];
    const count = async (sql) => Number((await one(`SELECT COUNT(*)::bigint AS n FROM ${sql}`)).n);

    const tableNames = (
      await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`)
    ).map((r) => r.table_name);
    const has = (t) => tableNames.includes(t);
    const columnsOf = async (t) =>
      rows(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [t],
      );
    const hasColumn = async (t, c) => has(t) && (await columnsOf(t)).some((col) => col.column_name === c);

    // ── migration history ──
    report.migrations = has("_prisma_migrations")
      ? await rows(`SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY started_at`)
      : null;

    // ── structure ──
    report.tables = [];
    for (const t of tableNames) {
      if (t === "_prisma_migrations") continue;
      report.tables.push({
        name: t,
        kind: APP_TABLES.includes(t) ? "app" : LEGACY_TABLES.includes(t) ? "legacy" : "unknown",
        rows: await count(`"${t}"`),
        columns: (await columnsOf(t)).map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
          default: c.column_default,
        })),
        indexes: (await rows(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY 1`, [t])).map(
          (i) => ({ name: i.indexname, definition: i.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, (_, u) => (u ? "UNIQUE " : "")) }),
        ),
        constraints: (
          await rows(
            `SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY contype, conname`,
            [t],
          )
        ).map((c) => ({ name: c.conname, type: { p: "primary key", f: "foreign key", u: "unique", c: "check" }[c.contype] || c.contype, definition: c.def })),
      });
    }

    // ── rows a migration has to be careful with (counts only) ──
    const checks = {};
    if (has("users")) {
      checks.users = {
        total: await count(`users`),
        emailsNotLowerCaseOrTrimmed: await count(`users WHERE email IS NOT NULL AND email <> LOWER(BTRIM(email))`),
        emailsSharedByMoreThanOneAccount: await count(
          `(SELECT LOWER(BTRIM(email)) FROM users WHERE email IS NOT NULL AND BTRIM(email) <> '' GROUP BY 1 HAVING COUNT(*) > 1) d`,
        ),
        missingCreatedAt: await count(`users WHERE created_at IS NULL`),
      };
      if (await hasColumn("users", "google_id")) {
        checks.users.googleIdsSharedByMoreThanOneAccount = await count(
          `(SELECT google_id FROM users WHERE google_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1) d`,
        );
      }
      if (await hasColumn("users", "email_verified")) {
        checks.users.verified = await count(`users WHERE email_verified IS NOT NULL`);
        checks.users.legacyUnverified = await count(`users WHERE legacy_unverified`);
      }
    }
    if (has("garage_vehicles")) {
      checks.garage_vehicles = {
        total: await count(`garage_vehicles`),
        yearNotAFourDigitYear: await count(`garage_vehicles WHERE NOT (${YEAR_OK})`),
        missingCreatedAt: await count(`garage_vehicles WHERE created_at IS NULL`),
      };
      if (await hasColumn("garage_vehicles", "model_year")) {
        checks.garage_vehicles.withoutTypedYear = await count(`garage_vehicles WHERE model_year IS NULL`);
      }
    }
    if (has("maintenance_records")) {
      const hasCost = await hasColumn("maintenance_records", "cost");
      checks.maintenance_records = {
        total: await count(`maintenance_records`),
        dateNotYearMonthDay: await count(`maintenance_records WHERE NOT (${DATE_SHAPE_OK})`),
        odometerPresentButNotConvertible: await count(`maintenance_records WHERE mileage IS NOT NULL AND BTRIM(mileage) <> '' AND NOT (${ODOMETER_OK})`),
        costPresentButNotConvertible: hasCost
          ? await count(`maintenance_records WHERE cost IS NOT NULL AND BTRIM(cost) <> '' AND NOT ${COST_OK}`)
          : 0,
        missingCreatedAt: await count(`maintenance_records WHERE created_at IS NULL`),
        orphanedFromVehicle: has("garage_vehicles")
          ? await count(`maintenance_records m WHERE NOT EXISTS (SELECT 1 FROM garage_vehicles v WHERE v.id = m.vehicle_id)`)
          : 0,
        ownerDiffersFromVehicleOwner: has("garage_vehicles")
          ? await count(`maintenance_records m JOIN garage_vehicles v ON v.id = m.vehicle_id WHERE v.user_id <> m.user_id`)
          : 0,
      };
      if (await hasColumn("maintenance_records", "service_date")) {
        Object.assign(checks.maintenance_records, {
          withoutTypedDate: await count(`maintenance_records WHERE service_date IS NULL`),
          withOdometerTextButNoTypedValue: await count(`maintenance_records WHERE mileage IS NOT NULL AND BTRIM(mileage) <> '' AND odometer_value IS NULL`),
          withCostTextButNoTypedValue: await count(`maintenance_records WHERE cost IS NOT NULL AND BTRIM(cost) <> '' AND cost_amount IS NULL`),
        });
      }
    }
    if (has("feedback")) {
      const hasPage = await hasColumn("feedback", "page");
      const hasPageUrl = await hasColumn("feedback", "page_url");
      checks.feedback = {
        total: await count(`feedback`),
        hasPageColumn: hasPage,
        hasPageUrlColumn: hasPageUrl,
        valueOnlyInOldPageColumn: hasPage ? await count(`feedback WHERE page IS NOT NULL ${hasPageUrl ? "AND page_url IS NULL" : ""}`) : 0,
        bothColumnsWithDifferentValues: hasPage && hasPageUrl ? await count(`feedback WHERE page IS NOT NULL AND page_url IS NOT NULL AND page <> page_url`) : 0,
      };
    }
    if (has("oem_fault_codes")) {
      checks.oem_fault_codes = {
        total: await count(`oem_fault_codes`),
        rowsTheAppDidNotCreate: await count(`oem_fault_codes WHERE NOT (${OEM_SEED})`),
      };
    }
    if (has("rate_limits")) {
      checks.rate_limits = { total: await count(`rate_limits`) };
      if (await hasColumn("rate_limits", "expires_at")) checks.rate_limits.expired = await count(`rate_limits WHERE expires_at < NOW()`);
      else checks.rate_limits.olderThanTwoDays = await count(`rate_limits WHERE window_start < NOW() - INTERVAL '2 days'`);
    }
    if (has("email_verification_tokens")) {
      checks.email_verification_tokens = {
        total: await count(`email_verification_tokens`),
        expired: await count(`email_verification_tokens WHERE expires_at < NOW()`),
      };
    }
    report.checks = checks;

    // ── things that need a person ──
    const blockers = [];
    if (checks.users?.emailsSharedByMoreThanOneAccount) blockers.push(`${checks.users.emailsSharedByMoreThanOneAccount} email address(es) are used by more than one account: the migration will stop until this is resolved.`);
    if (checks.users?.googleIdsSharedByMoreThanOneAccount) blockers.push(`${checks.users.googleIdsSharedByMoreThanOneAccount} Google identity(ies) are linked to more than one account: the migration will stop until this is resolved.`);
    const notes = [];
    if (checks.oem_fault_codes?.rowsTheAppDidNotCreate) notes.push(`oem_fault_codes holds ${checks.oem_fault_codes.rowsTheAppDidNotCreate} row(s) the app did not create: it will be kept and renamed, not dropped.`);
    if (checks.feedback?.bothColumnsWithDifferentValues) notes.push(`${checks.feedback.bothColumnsWithDifferentValues} feedback row(s) have different values in "page" and "page_url": both values will be kept, joined with " | ".`);
    if (checks.maintenance_records?.orphanedFromVehicle) notes.push(`${checks.maintenance_records.orphanedFromVehicle} service record(s) point at a vehicle that no longer exists.`);
    if (checks.maintenance_records?.ownerDiffersFromVehicleOwner) notes.push(`${checks.maintenance_records.ownerDiffersFromVehicleOwner} service record(s) belong to a different account than their vehicle.`);
    const unknown = report.tables.filter((t) => t.kind === "unknown").map((t) => t.name);
    if (unknown.length) notes.push(`Tables the app does not know about: ${unknown.join(", ")}. They are left untouched.`);
    report.blockers = blockers;
    report.notes = notes;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const line = (s = "") => console.log(s);
  line(`CarCode database report  (read-only)`);
  line(`Database : ${report.database}`);
  line(`Generated: ${report.generatedAt}`);
  line();
  line(`MIGRATION HISTORY`);
  if (!report.migrations) line(`  none: this database was built by the app's old start-up code (or is empty).`);
  else for (const m of report.migrations) line(`  ${m.finished ? "applied " : m.rolled_back ? "rolled back" : "UNFINISHED"}  ${m.migration_name}`);
  line();
  line(`TABLES`);
  for (const t of report.tables) {
    line(`  ${t.name}  [${t.kind}]  ${t.rows} row(s)`);
    for (const c of t.columns) line(`      ${c.name.padEnd(20)} ${c.type}${c.nullable ? "" : " NOT NULL"}${c.default ? ` DEFAULT ${c.default}` : ""}`);
    for (const i of t.indexes) line(`      index       ${i.name}  ${i.definition}`);
    for (const c of t.constraints) line(`      ${c.type.padEnd(11)} ${c.name}  ${c.definition}`);
  }
  line();
  line(`ROW CHECKS (counts only)`);
  for (const [table, values] of Object.entries(report.checks)) {
    line(`  ${table}`);
    for (const [k, v] of Object.entries(values)) line(`      ${k.padEnd(36)} ${v}`);
  }
  line();
  line(`NEEDS A DECISION BEFORE MIGRATING`);
  if (report.blockers.length === 0) line(`  nothing`);
  for (const b of report.blockers) line(`  - ${b}`);
  line();
  line(`WORTH KNOWING`);
  if (report.notes.length === 0) line(`  nothing`);
  for (const n of report.notes) line(`  - ${n}`);
}

main().catch((err) => {
  console.error(`[db:inspect] failed: ${err?.message || err}`);
  process.exit(1);
});
