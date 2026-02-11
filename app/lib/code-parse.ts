/**
 * Deterministic code classification for OBD-II and OEM fault codes.
 */

export type CodeType = "obd2" | "oem_hex" | "unknown";

export type ParseCodeResult = {
  normalized: string;
  type: CodeType;
};

/** Uppercase, remove spaces and hyphens. */
export function normalizeCode(s: string): string {
  return (s || "").trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Generic OBD-II: P/B/C/U + 4 hex digits. */
export function isObd2(code: string): boolean {
  return /^[PBCU][0-9A-F]{4}$/.test(normalizeCode(code));
}

/** Manufacturer-specific hex code: 4–6 hex digits, no leading letter. */
export function isOemHex(code: string): boolean {
  return /^[0-9A-F]{4,6}$/.test(normalizeCode(code));
}

/**
 * Normalize then classify:
 * - /^[PBCU][0-9A-F]{4}$/ => obd2
 * - /^[0-9A-F]{4,6}$/ => oem_hex
 * - else => unknown
 */
export function parseCode(input: string): ParseCodeResult {
  const normalized = normalizeCode(input);

  if (!normalized) {
    return { normalized: "", type: "unknown" };
  }

  if (isObd2(normalized)) {
    return { normalized, type: "obd2" };
  }

  if (isOemHex(normalized)) {
    return { normalized, type: "oem_hex" };
  }

  return { normalized, type: "unknown" };
}
