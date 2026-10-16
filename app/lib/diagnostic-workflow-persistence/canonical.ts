/**
 * One canonical serialization for persisted diagnostic sessions (V2G).
 *
 * RESEARCH PROTOTYPE. Plain data only: objects, arrays, strings, finite
 * numbers, booleans and null. Keys are written in sorted order, so the result
 * never depends on key order, and the same value always gives the same text
 * and the same digest. Anything that is not plain data (a function, a class
 * instance such as a Date, a Map, a symbol, a bigint, NaN or Infinity, a
 * cycle) is refused rather than silently changed, so nothing executable and
 * nothing ambiguous is ever stored.
 *
 * Properties whose value is `undefined` are left out, the same way the engine's
 * own comparisons (JSON.stringify) treat them.
 */
import { createHash, createHmac } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class NotPlainDataError extends Error {
  constructor(readonly path: string, readonly found: string) {
    super(`not plain data at ${path || "(root)"}: ${found}`);
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new NotPlainDataError(path, String(value));
      // -0 and 0 are the same reading; JSON has no -0.
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (seen.has(value)) throw new NotPlainDataError(path, "a cycle");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((v, i) => {
            if (v === undefined) throw new NotPlainDataError(`${path}[${i}]`, "undefined");
            return write(v, `${path}[${i}]`, seen);
          }).join(",")}]`;
        }
        if (!isPlainObject(value)) throw new NotPlainDataError(path, `an instance of ${value.constructor?.name ?? "an unknown class"}`);
        if (Object.getOwnPropertySymbols(value).length) throw new NotPlainDataError(path, "a symbol key");
        const parts: string[] = [];
        for (const key of Object.keys(value).sort()) {
          const v = (value as Record<string, unknown>)[key];
          if (v === undefined) continue;
          parts.push(`${JSON.stringify(key)}:${write(v, path ? `${path}.${key}` : key, seen)}`);
        }
        return `{${parts.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new NotPlainDataError(path, typeof value);
  }
}

/** The canonical text of a plain-data value. Throws NotPlainDataError for anything else. */
export function canonicalJson(value: unknown): string {
  return write(value, "", new Set());
}

/** A plain-data copy of the value, as it will be stored and read back. */
export function toPlainData(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

/** True when both values have the same canonical form (layout and key order do not matter). */
export function sameData(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/**
 * How a stored record's digest is made.
 * - "sha256": detects corruption and any edit made without recomputing it.
 * - "hmac-sha256": the same, keyed with a server-side secret, so a record
 *   edited by someone without the secret cannot be given a valid digest.
 */
export type IntegrityAlgorithm = "sha256" | "hmac-sha256";
export type IntegrityConfig = { algorithm: "sha256" } | { algorithm: "hmac-sha256"; secret: string };

export const DEFAULT_INTEGRITY: IntegrityConfig = { algorithm: "sha256" };

export function digestOf(canonicalText: string, integrity: IntegrityConfig = DEFAULT_INTEGRITY): string {
  if (integrity.algorithm === "hmac-sha256") {
    if (!integrity.secret) throw new Error("hmac-sha256 needs a secret");
    return `hmac-sha256:${createHmac("sha256", integrity.secret).update(canonicalText, "utf8").digest("hex")}`;
  }
  return `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`;
}

/** A content fingerprint of a workflow definition: same content, same fingerprint, whatever its key order. */
export function workflowFingerprint(workflow: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(workflow), "utf8").digest("hex")}`;
}
