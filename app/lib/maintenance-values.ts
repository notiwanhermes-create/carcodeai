/**
 * Typed copies of garage values that users enter as text.
 *
 * What a user typed is always stored exactly as typed. These functions produce
 * the typed copy stored next to it, and return null whenever the text does not
 * convert CLEANLY: a missing typed value is better than a wrong one.
 *
 * The same rules are written in SQL in the `converge_and_expand` migration,
 * which filled in the typed copies for rows that already existed. The
 * migration tests check that both give the same answers.
 *
 * Pure functions: no database, no network.
 */

/** Trim spaces only, as SQL BTRIM does. */
const trimSpaces = (s: string) => s.replace(/^ +| +$/g, "");

/** A vehicle year: four digits, 1900 to 2099. */
export function parseModelYear(text: string | null | undefined): number | null {
  const s = trimSpaces(text ?? "");
  return /^(19|20)[0-9]{2}$/.test(s) ? Number(s) : null;
}

/** A service date written as YYYY-MM-DD that is a real calendar day. Returned at midnight UTC. */
export function parseServiceDate(text: string | null | undefined): Date | null {
  const s = trimSpaces(text ?? "");
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year); // Date.UTC treats years 0-99 as 1900-1999
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date : null;
}

export type Odometer = { value: number; unit: "km" | "mi" | null };

/**
 * An odometer reading: whole digits, optionally with thousands commas and a
 * unit. "120000", "120,000", "120000 km", "75,500 miles".
 * Not converted: "120.000", "about 120k", "12,00".
 */
export function parseOdometer(text: string | null | undefined): Odometer | null {
  const s = trimSpaces(text ?? "").toLowerCase();
  const m = /^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,7}) ?(km|kms|kilometers|kilometres|mi|mile|miles)?$/.exec(s);
  if (!m) return null;
  const digits = m[1].replace(/,/g, "");
  if (digits.length > 7) return null;
  const unit = m[2] === undefined ? null : m[2].startsWith("k") ? "km" : "mi";
  return { value: Number(digits), unit };
}

/**
 * A cost: a plain amount, optionally with a leading "$" and thousands commas.
 * "120", "120.5", "$1,250.00". Returned as a decimal string ("1250.00").
 * Not converted: "120,50" (cannot be told apart from a thousands separator), "free".
 */
export function parseCost(text: string | null | undefined): string | null {
  const s = trimSpaces(trimSpaces(text ?? "").replace(/^\$+/, ""));
  const grouped = /^[0-9]{1,3}(,[0-9]{3})+(\.[0-9]{1,2})?$/.test(s);
  const plain = /^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(s);
  if (!grouped && !plain) return null;
  const [whole, fraction = ""] = s.replace(/,/g, "").split(".");
  if (whole.length > 9) return null;
  return `${Number(whole)}.${fraction.padEnd(2, "0")}`;
}
