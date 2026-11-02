/**
 * Scanner foundation (S1): the read-only command policy, the lifecycle
 * transition table, and the import boundary of app/lib/vehicle-communication/.
 *
 * Design: docs/research/scanner-engine/protocol-stack.md ("Fail-closed command
 * policy") and carcode-scanner-architecture.md ("Scanner independence").
 * Simulated test matrix rows 26-27 are asserted here as a pure check; the
 * executor suite asserts that a refused command writes zero bytes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_AT_COMMANDS,
  DENIED_COMMANDS,
  MAX_COMMAND_LENGTH,
  buildObdCommand,
  checkCommand,
  type ObdRequest,
} from "../app/lib/vehicle-communication/elm/command-policy";
import { LIFECYCLE_TRANSITIONS, canTransition, type ScannerLifecycleState } from "../app/lib/vehicle-communication/types";

import { DENIED_EXAMPLES, MALFORMED_EXAMPLES, NOT_ALLOWED_EXAMPLES } from "./vehicle-communication-fixtures";

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const allowed = (command: unknown) => checkCommand(command).allowed;

describe("command policy: allowed forms", () => {
  it("accepts every adapter setup command exactly as listed", () => {
    expect([...ALLOWED_AT_COMMANDS].sort()).toEqual(["AT@1", "ATDP", "ATDPN", "ATE0", "ATH0", "ATH1", "ATI", "ATL0", "ATRV", "ATS0", "ATS1", "ATSP0", "ATWS", "ATZ"]);
    for (const command of ALLOWED_AT_COMMANDS) {
      const check = checkCommand(command);
      expect(check, command).toMatchObject({ allowed: true, command, group: "adapter_setup" });
    }
    expect(checkCommand("ATZ")).toMatchObject({ resetsAdapter: true, kind: "text" });
    expect(checkCommand("ATWS")).toMatchObject({ resetsAdapter: true });
    expect(checkCommand("ATH1")).toMatchObject({ resetsAdapter: false, kind: "ok_only" });
    // Only ATZ, ATWS and ATI answer with the identity line; for any other command it is a reset.
    const printsIdentity = ALLOWED_AT_COMMANDS.filter((command) => {
      const check = checkCommand(command);
      return check.allowed && check.printsIdentity;
    });
    expect(printsIdentity).toEqual(["ATZ", "ATWS", "ATI"]);
    expect(checkCommand("ATDP")).toMatchObject({ kind: "text", printsIdentity: false });
    expect(checkCommand("AT@1")).toMatchObject({ kind: "text", printsIdentity: false });
    expect(checkCommand("03")).toMatchObject({ printsIdentity: false });
    expect(checkCommand("ATDPN")).toMatchObject({ kind: "protocol_number" });
    expect(checkCommand("ATRV")).toMatchObject({ kind: "voltage" });
  });

  it("accepts exactly 03, 07 and 0A among all one-byte requests", () => {
    const accepted = Array.from({ length: 256 }, (_, s) => hex(s)).filter(allowed);
    expect(accepted).toEqual(["03", "07", "0A"]);
  });

  it("accepts exactly 01 + any PID and 09 + 00/02 among all two-byte requests", () => {
    const accepted: string[] = [];
    for (let s = 0; s < 256; s++) for (let p = 0; p < 256; p++) if (allowed(hex(s) + hex(p))) accepted.push(hex(s) + hex(p));
    const expected = [...Array.from({ length: 256 }, (_, p) => `01${hex(p)}`), "0900", "0902"];
    expect(accepted.sort()).toEqual(expected.sort());
    for (const command of accepted) expect(checkCommand(command)).toMatchObject({ group: "obd", kind: "obd" });
  });

  it("accepts exactly 02 + any PID + frame 00 among three-byte requests", () => {
    const accepted: string[] = [];
    for (let p = 0; p < 256; p++) for (let f = 0; f < 256; f++) if (allowed(`02${hex(p)}${hex(f)}`)) accepted.push(`02${hex(p)}${hex(f)}`);
    expect(accepted).toEqual(Array.from({ length: 256 }, (_, p) => `02${hex(p)}00`));
    for (let s = 0; s < 256; s++) {
      if (s === 2) continue;
      for (let p = 0; p < 256; p++) expect(allowed(`${hex(s)}${hex(p)}00`)).toBe(false);
    }
  });
});

describe("command policy: refusals (rows 26-27)", () => {
  it.each(DENIED_EXAMPLES)("refuses %j as denied, with a reason", (command) => {
    const check = checkCommand(command);
    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(check.refusal).toBe("denied");
      expect(check.reason.length).toBeGreaterThan(10);
    }
  });

  it("refuses clear-codes and on-board control in every request length", () => {
    for (const prefix of ["04", "08"]) {
      expect(allowed(prefix)).toBe(false);
      for (let p = 0; p < 256; p++) {
        expect(allowed(prefix + hex(p))).toBe(false);
        expect(allowed(`${prefix}${hex(p)}00`)).toBe(false);
      }
    }
  });

  it.each(MALFORMED_EXAMPLES)("refuses the variant %j as malformed", (command) => {
    expect(checkCommand(command)).toMatchObject({ allowed: false, refusal: "malformed" });
  });

  it.each(NOT_ALLOWED_EXAMPLES)("refuses %j (well-formed but not on the allowlist)", (command) => {
    expect(checkCommand(command).allowed).toBe(false);
  });

  it("refuses anything longer than the longest allowed command", () => {
    expect(MAX_COMMAND_LENGTH).toBe(6);
    expect(checkCommand("0100000")).toMatchObject({ allowed: false, refusal: "malformed" });
    expect(checkCommand("ATZATZ0")).toMatchObject({ allowed: false });
  });

  it("refuses non-text input", () => {
    for (const value of [undefined, null, 3, 0x03, ["03"], { command: "03" }, true]) {
      expect(checkCommand(value)).toMatchObject({ allowed: false, refusal: "malformed" });
    }
  });

  it("explains every denied group with an example that is refused", () => {
    for (const rule of DENIED_COMMANDS) {
      expect(DENIED_EXAMPLES.some((example) => rule.match.test(example)), String(rule.match)).toBe(true);
    }
  });
});

describe("command policy: typed builders", () => {
  it("builds the canonical text and re-checks it", () => {
    expect(buildObdCommand({ service: "01", pid: 0x0c })).toMatchObject({ allowed: true, command: "010C" });
    expect(buildObdCommand({ service: "01", pid: 0 })).toMatchObject({ allowed: true, command: "0100" });
    expect(buildObdCommand({ service: "02", pid: 0x02, frame: 0 })).toMatchObject({ allowed: true, command: "020200" });
    expect(buildObdCommand({ service: "03" })).toMatchObject({ allowed: true, command: "03" });
    expect(buildObdCommand({ service: "07" })).toMatchObject({ allowed: true, command: "07" });
    expect(buildObdCommand({ service: "0A" })).toMatchObject({ allowed: true, command: "0A" });
    expect(buildObdCommand({ service: "09", infoType: 2 })).toMatchObject({ allowed: true, command: "0902" });
  });

  it("refuses requests outside the typed forms, including forged ones", () => {
    const forged = [
      { service: "01", pid: 256 },
      { service: "01", pid: -1 },
      { service: "01", pid: 1.5 },
      { service: "01", pid: "0C" },
      { service: "01", pid: Number.NaN },
      { service: "02", pid: 2, frame: 1 },
      { service: "09", infoType: 4 },
      { service: "04" },
      { service: "08" },
      { service: "01\r04", pid: 0 },
    ] as unknown as ObdRequest[];
    for (const request of forged) expect(buildObdCommand(request).allowed, JSON.stringify(request)).toBe(false);
  });
});

describe("scanner lifecycle transitions", () => {
  it("follows the documented path and allows failure from every live state", () => {
    const path: ScannerLifecycleState[] = ["idle", "connecting", "initialising", "discovering", "ready", "scanning", "ready", "closing", "closed"];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i]), `${path[i - 1]} -> ${path[i]}`).toBe(true);
    for (const state of Object.keys(LIFECYCLE_TRANSITIONS) as ScannerLifecycleState[]) {
      if (state === "closed" || state === "failed") continue;
      expect(canTransition(state, "failed"), state).toBe(true);
    }
  });

  it("refuses skipped, backward and terminal transitions", () => {
    expect(canTransition("idle", "scanning")).toBe(false);
    expect(canTransition("connecting", "ready")).toBe(false);
    expect(canTransition("ready", "discovering")).toBe(false);
    expect(canTransition("failed", "ready")).toBe(false);
    expect(canTransition("failed", "closed")).toBe(true);
    for (const state of Object.keys(LIFECYCLE_TRANSITIONS) as ScannerLifecycleState[]) expect(canTransition("closed", state)).toBe(false);
    expect(canTransition("bogus" as ScannerLifecycleState, "idle")).toBe(false);
    expect(canTransition("toString" as ScannerLifecycleState, "idle")).toBe(false);
  });
});

describe("scanner independence (architecture rules 1-4)", () => {
  const root = path.resolve(__dirname, "..");
  const listTs = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return listTs(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });
  const specifiers = (file: string) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]);

  it("vehicle-communication imports nothing from GD, the AI bridge, Prisma, the network or the server", () => {
    const files = listTs(path.join(root, "app/lib/vehicle-communication"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const spec of specifiers(file)) {
        expect(spec, `${path.relative(root, file)} imports ${spec}`).not.toMatch(/diagnostic-workflow|prisma|openai|^next|server-only|\/api\/|^node:|^pg$|resend/);
        expect(spec.startsWith("."), `${path.relative(root, file)} imports ${spec} from outside the layer`).toBe(true);
      }
      const source = readFileSync(file, "utf8");
      expect(source, path.relative(root, file)).not.toMatch(/\bfetch\s*\(|process\.env|"use server"|XMLHttpRequest|WebSocket/);
    }
  });

  it("Guided Diagnostics never imports vehicle-communication", () => {
    const gdDirs = readdirSync(path.join(root, "app/lib")).filter((name) => name.startsWith("diagnostic-workflow"));
    expect(gdDirs.length).toBeGreaterThan(0);
    for (const dir of gdDirs) {
      for (const file of listTs(path.join(root, "app/lib", dir))) {
        for (const spec of specifiers(file)) expect(spec, path.relative(root, file)).not.toMatch(/vehicle-communication/);
      }
    }
  });
});
