/**
 * Scanner foundation (S4, S5): the simulated transport, the scripted adapter
 * model and the prompt-terminated ELM command executor.
 *
 * Design: docs/research/scanner-engine/protocol-stack.md ("Framing",
 * "Cancellation", "Timeouts") and scan-flow.md ("Simulated test matrix").
 * Rows covered here: 1-9 through the executor, 26 (zero bytes written), and
 * the elm-level parts of 28-34. Rows 31-32 are asserted at command level; the
 * scan-level parts (kept `03` results in a ScannerReport, a second `scan()`)
 * belong to S8.
 *
 * Every adapter here is SCRIPTED. Passing shows the executor behaves as
 * designed against scripted adapters, not that any real adapter does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialiseAdapter, INITIALISATION_SEQUENCE } from "../app/lib/vehicle-communication/elm/initialise";
import { DEFAULT_ELM_TIMEOUTS, ElmCommandExecutor, MAX_SYNC_PROBES, SYNC_PROBES, type CommandResult, type ElmStatus } from "../app/lib/vehicle-communication/elm/executor";
import { ScriptedElmAdapter, SimulatedTransport, type ScriptedElmOptions, type SimulatedTransportOptions } from "../app/lib/vehicle-communication/transport/simulated";
import { TransportError } from "../app/lib/vehicle-communication/transport/types";
import { DENIED_EXAMPLES, MALFORMED_EXAMPLES, NOT_ALLOWED_EXAMPLES } from "./vehicle-communication-fixtures";

const { commandMs, searchMs, interruptMs } = DEFAULT_ELM_TIMEOUTS;
/** The answer to the ATRV synchronisation probe sent after every interrupt. */
const PROBE_ANSWER = "12.6V\r\r>";
const SYNC_ANSWER = { reason: "sync_answer", text: PROBE_ANSWER, lines: ["12.6V"], overflowed: false, byteCount: PROBE_ANSWER.length };
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Runs a command to completion against a scripted adapter. */
async function runToEnd(executor: ElmCommandExecutor, command: string, options?: Parameters<ElmCommandExecutor["run"]>[1]): Promise<CommandResult> {
  const pending = executor.run(command, options);
  await vi.runAllTimersAsync();
  return pending;
}

/** A transport with a scripted adapter attached, initialised (steps 1-6). */
async function scripted(options: ScriptedElmOptions = {}, transportOptions: SimulatedTransportOptions = {}) {
  const transport = new SimulatedTransport(transportOptions);
  const adapter = new ScriptedElmAdapter(options);
  transport.attach(adapter);
  await transport.open();
  const executor = new ElmCommandExecutor(transport);
  const init = initialiseAdapter(executor);
  await vi.runAllTimersAsync();
  return { transport, adapter, executor, init: await init };
}

/**
 * A transport the test answers by hand, initialised. `writes` is cleared after
 * initialisation so assertions see only the test's own traffic.
 */
async function manual(transportOptions: SimulatedTransportOptions = {}) {
  const transport = new SimulatedTransport(transportOptions);
  await transport.open();
  const executor = new ElmCommandExecutor(transport);
  for (const command of INITIALISATION_SEQUENCE) {
    const pending = executor.run(command);
    await advance(transportOptions.writeDelayMs ?? 0);
    transport.receive(command === "ATZ" ? "ATZ\r\rELM327 v1.5\r\r>" : "OK\r\r>");
    expect((await pending).outcome, command).toBe("ok");
  }
  expect(executor.initialised).toBe(true);
  transport.writes.length = 0;
  return { transport, executor };
}

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

describe("simulated transport", () => {
  it("opens once, refuses use when not open, and reports a close once with its reason", async () => {
    const transport = new SimulatedTransport();
    await expect(transport.write(new Uint8Array([0x30]))).rejects.toMatchObject({ code: "not_open" });
    await transport.open();
    await expect(transport.open()).rejects.toBeInstanceOf(TransportError);
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));
    const chunks: string[] = [];
    transport.onData((chunk) => chunks.push(String.fromCharCode(...chunk)));
    transport.receive("OK>");
    transport.disconnect();
    transport.disconnect();
    await transport.close();
    transport.receive("ignored>");
    expect(reasons).toEqual(["disconnected"]);
    expect(chunks).toEqual(["OK>"]);
    expect(transport.state).toBe("closed");
    await expect(transport.open()).rejects.toMatchObject({ code: "closed" });
    await expect(transport.write(new Uint8Array([0x30]))).rejects.toMatchObject({ code: "not_open" });
  });

  it("refuses an aborted open and an aborted write", async () => {
    const transport = new SimulatedTransport();
    await expect(transport.open(AbortSignal.abort())).rejects.toMatchObject({ code: "aborted" });
    await transport.open();
    await expect(transport.write(new Uint8Array([0x30]), AbortSignal.abort())).rejects.toMatchObject({ code: "aborted" });
    expect(transport.bytesWritten).toBe(0);
  });

  it("an abort during a delayed or stalled write rejects it aborted and delivers nothing; a close ends an unstoppable one", async () => {
    const transport = new SimulatedTransport({ writeDelayMs: 50 });
    const adapter = new ScriptedElmAdapter();
    transport.attach(adapter);
    await transport.open();
    const delayed = new AbortController();
    const write = transport.write(new Uint8Array([0x30, 0x0d]), delayed.signal);
    await advance(10);
    delayed.abort();
    await expect(write).rejects.toMatchObject({ code: "aborted" });
    transport.stallNextWrites(1, { ignoreAbort: true });
    const stuck = new AbortController();
    const stalled = transport.write(new Uint8Array([0x30, 0x0d]), stuck.signal);
    const outcome = stalled.catch((error: unknown) => error);
    stuck.abort();
    await advance(60_000);
    await transport.close();
    expect(await outcome).toMatchObject({ code: "closed" });
    expect(transport.writes).toEqual([]);
    expect(adapter.received).toEqual([]);
  });
});

describe("executor construction", () => {
  it("needs an open transport and bounded timeouts", async () => {
    expect(() => new ElmCommandExecutor(new SimulatedTransport())).toThrow();
    const transport = new SimulatedTransport();
    await transport.open();
    for (const timeouts of [{ commandMs: 0 }, { searchMs: Number.POSITIVE_INFINITY }, { interruptMs: Number.NaN }, { interruptMs: 30001 }, { maxLateReplies: 11 }, { maxLateReplies: 1.5 }]) {
      expect(() => new ElmCommandExecutor(transport, { timeouts }), JSON.stringify(timeouts)).toThrow(RangeError);
    }
    expect(() => new ElmCommandExecutor(transport, { timeouts: { commandMs: 30000 } })).not.toThrow();
  });
});

describe("initialisation (steps 1-6) and echo (row 4)", () => {
  it("sends exactly the sequence, removes the echo only until ATE0 returns OK, and keeps the raw reply", async () => {
    const { transport, adapter, executor, init } = await scripted();
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    expect(init.identity).toEqual(["ELM327 v1.5"]);
    expect(transport.writes).toEqual(INITIALISATION_SEQUENCE.map((command) => `${command}\r`));
    const [atz, ate0, atl0] = init.steps;
    expect(atz.raw).toMatchObject({ received: "ATZ\r\rELM327 v1.5\r\r>", lines: ["ATZ", "ELM327 v1.5"], echoRemoved: true });
    expect(ate0).toMatchObject({ outcome: "ok", lines: ["OK"], raw: { received: "ATE0\rOK\r\r>", echoRemoved: true } });
    expect(atl0).toMatchObject({ outcome: "ok", raw: { received: "OK\r\r>", echoRemoved: false } });
    expect(adapter.echoOn).toBe(false);
    expect(executor.initialised).toBe(true);
    expect(executor.state).toBe("ready");
  });

  it("row 6: '?' to ATH1 fails initialisation and no OBD request can be sent", async () => {
    const { transport, executor, init } = await scripted({ replies: { ATH1: { lines: ["?"] } } });
    expect(init).toMatchObject({ ok: false, failedAt: "ATH1", outcome: "adapter_rejected_command" });
    expect(transport.writes).toEqual(["ATZ\r", "ATE0\r", "ATL0\r", "ATS1\r", "ATH1\r"]);
    expect(executor.initialised).toBe(false);
    const result = await runToEnd(executor, "0100");
    expect(result).toMatchObject({ outcome: "adapter_not_initialised", written: false });
    expect(transport.writes).toHaveLength(5);
  });

  it("an unexpected reply to a setup command fails initialisation as a rejection", async () => {
    const { init } = await scripted({ replies: { ATS1: { lines: ["OK", "OK"] } } });
    expect(init).toMatchObject({ ok: false, failedAt: "ATS1", outcome: "adapter_rejected_command" });
  });

  it("refuses OBD requests before ATE0 and ATH1 are confirmed, writing nothing", async () => {
    const transport = new SimulatedTransport();
    transport.attach(new ScriptedElmAdapter());
    await transport.open();
    const executor = new ElmCommandExecutor(transport);
    for (const command of ["0100", "03", "07", "0A", "020200", "0902"]) {
      expect(await executor.run(command), command).toMatchObject({ outcome: "adapter_not_initialised", written: false });
    }
    expect(transport.bytesWritten).toBe(0);
  });

  it("a non-OK reply to a later setup command clears the confirmation", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("ATH1");
    await advance(0);
    transport.receive("?\r\r>");
    expect(await pending).toMatchObject({ outcome: "adapter_rejected_command", token: "?" });
    expect(executor.initialised).toBe(false);
    expect(await executor.run("03")).toMatchObject({ outcome: "adapter_not_initialised", written: false });
  });
});

describe("row 26: the command policy is the only path to the adapter", () => {
  it("refuses every denied, malformed and off-list command with zero bytes written, on an initialised session", async () => {
    const { transport, executor } = await manual();
    for (const command of [...DENIED_EXAMPLES, ...MALFORMED_EXAMPLES, ...NOT_ALLOWED_EXAMPLES]) {
      const result = await executor.run(command);
      expect(result, JSON.stringify(command)).toMatchObject({ outcome: "command_not_allowed", written: false, lines: [] });
      expect(result.raw.received).toBeNull();
    }
    for (const value of [undefined, null, 4, ["04"]]) {
      expect(await executor.run(value as unknown as string)).toMatchObject({ outcome: "command_not_allowed", written: false });
    }
    expect(transport.bytesWritten).toBe(0);
    expect(executor.state).toBe("ready");
  });
});

describe("fragmented framing through the executor (rows 1-3)", () => {
  const reply = ["7E8 06 41 00 BE 3F A8 13", "7E9 06 41 00 98 18 80 11"];

  it("gives the same data lines for every chunk size 1-20 and for CRLF line endings", async () => {
    for (const lineEnding of ["\r", "\r\n"]) {
      for (let chunkSize = 1; chunkSize <= 20; chunkSize++) {
        const { executor } = await scripted({ lineEnding, replies: { "0100": { lines: reply, chunkSize, chunkIntervalMs: 3 } } });
        const result = await runToEnd(executor, "0100");
        expect(result, `${JSON.stringify(lineEnding)} / ${chunkSize}`).toMatchObject({ outcome: "ok", lines: reply });
        expect(result.raw.received).toBe(`${reply.map((l) => l + lineEnding).join("")}${lineEnding}>`);
      }
    }
  });

  it("does not complete a response at a chunk boundary", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(0);
    transport.receive("7E8 06 43 02 01 33 01 71\r");
    await advance(100);
    expect(pending.settled).toBe(false);
    transport.receive("\r");
    await advance(100);
    expect(pending.settled).toBe(false);
    transport.receive(">");
    await advance(0);
    expect(pending.value).toMatchObject({ outcome: "ok", lines: ["7E8 06 43 02 01 33 01 71"] });
  });

  it("drops NUL bytes from lines but keeps them in the raw reply", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("07");
    await advance(0);
    transport.receive("\u00007E8 02 47 00\r\u0000\r>");
    expect(await pending).toMatchObject({ outcome: "ok", lines: ["7E8 02 47 00"], raw: { received: "\u00007E8 02 47 00\r\u0000\r>" } });
  });
});

describe("adapter error tokens through the executor (rows 6-9)", () => {
  const cases: [string, string, string][] = [
    ["03", "NO DATA", "no_response"],
    ["0100", "UNABLE TO CONNECT", "no_vehicle_protocol"],
    ["0100", "BUS INIT: ...ERROR", "bus_init_failed"],
    ["0100", "CAN ERROR", "bus_error"],
    ["07", "BUS BUSY", "bus_error"],
    ["0902", "7E8 10 14 49 02 01 31 47 31\rBUFFER FULL", "adapter_overflow"],
    ["0A", "7E8 03 4A <DATA ERROR", "data_error"],
    ["03", "ERR94", "adapter_internal_error"],
    ["03", "?", "adapter_rejected_command"],
    ["03", "hello", "unexpected_reply"],
    ["03", "", "unexpected_reply"],
  ];

  it.each(cases)("%s answered %j ends %s with no data, raw kept, session usable", async (command, body, outcome) => {
    const { transport, executor } = await manual();
    const pending = executor.run(command);
    await advance(0);
    const raw = `${body}\r\r>`;
    transport.receive(raw);
    const result = await pending;
    expect(result).toMatchObject({ outcome, written: true, lines: [] });
    expect(result.raw.received).toBe(raw);
    expect(result.detail).toBeTruthy();
    expect(executor.state).toBe("ready");
    expect(executor.initialised).toBe(true);
    // The next command still gets its own answer.
    const next = executor.run("07");
    await advance(0);
    transport.receive("7E8 02 47 00\r\r>");
    expect(await next).toMatchObject({ outcome: "ok", lines: ["7E8 02 47 00"] });
  });
});

describe("searching state", () => {
  // "SEARCHING...\r" first, then the data 9 s later: longer than a normal command's bound.
  const searching = { lines: ["SEARCHING...", "7E8 06 41 00 BE 3F A8 13"], chunkSize: 13, chunkIntervalMs: 3000 };

  it("reports searching while the adapter searches, records the progress line, and completes within the search bound", async () => {
    const { executor } = await scripted({ replies: { "0100": searching } });
    const statuses: ElmStatus[] = [];
    executor.onStatus((status) => statuses.push(status));
    const pending = track(executor.run("0100", { timeout: "search" }));
    await advance(1);
    expect(executor.status).toMatchObject({ state: "busy", command: "0100", searching: true });
    await advance(searchMs);
    expect(pending.value).toMatchObject({ outcome: "ok", lines: ["7E8 06 41 00 BE 3F A8 13"], info: ["SEARCHING..."] });
    expect(statuses.some((s) => s.searching && s.command === "0100")).toBe(true);
    expect(statuses.at(-1)).toEqual({ state: "ready", command: null, searching: false, failure: null });
  });

  it("a search under the normal bound times out, is interrupted, and yields no data", async () => {
    const { transport, adapter, executor } = await scripted({ replies: { "0100": searching } });
    const pending = track(executor.run("0100"));
    await advance(commandMs - 1);
    expect(pending.settled).toBe(false);
    await advance(1 + 10);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.raw.received).toBe("SEARCHING...\r7E8 06 41 00 STOPPED\r\r>");
    expect(pending.value?.raw.discardedAfter).toEqual([SYNC_ANSWER]);
    expect(transport.writes.slice(-3)).toEqual(["0100\r", "\r", "ATRV\r"]);
    expect(adapter.interrupts).toBe(1);
    expect(executor.state).toBe("ready");
  });

  it("an unsuccessful search keeps its progress line and its own outcome", async () => {
    const { executor } = await scripted({ replies: { "0100": { lines: ["SEARCHING...", "UNABLE TO CONNECT"] } } });
    expect(await runToEnd(executor, "0100", { timeout: "search" })).toMatchObject({ outcome: "no_vehicle_protocol", token: "UNABLE TO CONNECT", info: ["SEARCHING..."], lines: [] });
  });
});

describe("single command in flight (row 32 at command level)", () => {
  it("refuses a second command as busy without writing, and the first is unaffected", async () => {
    const { transport, executor } = await scripted({ replies: { "03": { lines: ["7E8 02 43 00"], delayMs: 1000 } } });
    const writesBefore = transport.writes.length;
    const first = executor.run("03");
    await advance(0);
    for (const command of ["07", "03", "ATZ", "ATRV"]) {
      expect(await executor.run(command), command).toMatchObject({ outcome: "busy", written: false });
    }
    expect(transport.writes.length).toBe(writesBefore + 1);
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ outcome: "ok", lines: ["7E8 02 43 00"] });
    expect(await runToEnd(executor, "ATRV")).toMatchObject({ outcome: "ok", lines: ["12.6V"] });
  });

  it("stays busy while recovering from a timeout", async () => {
    const { transport, executor } = await manual();
    const first = track(executor.run("03"));
    await advance(commandMs);
    expect(transport.writes).toEqual(["03\r", "\r"]);
    expect(executor.state).toBe("busy");
    expect(await executor.run("07")).toMatchObject({ outcome: "busy", written: false });
    transport.receive("STOPPED\r\r>");
    await advance(interruptMs - 1);
    // Still synchronising: busy until the probe's answer.
    expect(first.settled).toBe(false);
    expect(await executor.run("07")).toMatchObject({ outcome: "busy", written: false });
    transport.receive(PROBE_ANSWER);
    await advance(0);
    expect(first.value).toMatchObject({ outcome: "timeout" });
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r"]);
  });
});

describe("bounded timeouts", () => {
  it("a silent adapter times out at the command bound and is interrupted", async () => {
    const { transport, adapter, executor } = await scripted({ replies: { "03": { silent: true } } });
    const pending = track(executor.run("03"));
    await advance(commandMs - 1);
    expect(pending.settled).toBe(false);
    await advance(1 + 10);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [], written: true, raw: { received: "STOPPED\r\r>" } });
    expect(adapter.interrupts).toBe(1);
    expect(transport.writes.slice(-3)).toEqual(["03\r", "\r", "ATRV\r"]);
    expect(await runToEnd(executor, "ATRV")).toMatchObject({ outcome: "ok" });
  });

  it("a hung adapter ends the session adapter_unresponsive within commandMs + interruptMs and closes the transport", async () => {
    const { transport, executor } = await scripted({ onInterrupt: "ignore", replies: { "03": { silent: true } } });
    const pending = track(executor.run("03"));
    await advance(commandMs + interruptMs);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.detail).toMatch(/no prompt within/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
    expect(transport.state).toBe("closed");
    const writes = transport.writes.length;
    expect(await executor.run("ATZ")).toMatchObject({ outcome: "session_unavailable", written: false });
    expect(transport.writes.length).toBe(writes);
  });

  it("a command write that never completes is aborted at the command bound; the stalled link ends the session", async () => {
    const { transport, executor } = await manual();
    transport.stallNextWrites(1);
    const pending = track(executor.run("03"));
    await advance(commandMs - 1);
    expect(pending.settled).toBe(false);
    await advance(1);
    expect(pending.value).toMatchObject({ outcome: "timeout", written: false, lines: [] });
    expect(pending.value?.detail).toMatch(/nothing was sent/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
    expect(transport.writes).toEqual([]);
  });

  it("a command write that ignores the abort ends the session within commandMs + interruptMs, delivery uncertain", async () => {
    const { transport, executor } = await manual();
    transport.stallNextWrites(1, { ignoreAbort: true });
    const pending = track(executor.run("03"));
    await advance(commandMs + interruptMs - 1);
    expect(pending.settled).toBe(false);
    await advance(1);
    expect(pending.value).toMatchObject({ outcome: "timeout", written: true, lines: [] });
    expect(pending.value?.detail).toMatch(/delivery is uncertain/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
  });

  it("a command write that ignores the abort but finishes in the grace period is a timeout; the reply after the deadline is never data", async () => {
    const { transport, executor } = await manual();
    transport.stallNextWrites(1, { ignoreAbort: true, completeAfterMs: commandMs + interruptMs / 2 });
    const pending = track(executor.run("03"));
    await advance(commandMs + interruptMs / 2);
    // The write finished after the bound: the executor interrupts at once instead of waiting for a reply.
    expect(transport.writes).toEqual(["03\r", "\r"]);
    transport.receive("7E8 06 43 02 01 33 01 71\r\r>");
    await advance(0);
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r"]);
    transport.receive(PROBE_ANSWER);
    await advance(0);
    expect(pending.value).toMatchObject({ outcome: "timeout", written: true, lines: [], detail: `the write did not complete within ${commandMs} ms` });
    expect(pending.value?.raw.received).toBe("7E8 06 43 02 01 33 01 71\r\r>");
    expect(pending.value?.raw.discardedAfter).toEqual([SYNC_ANSWER]);
    expect(executor.state).toBe("ready");
  });

  it.each([false, true])("an interrupt write that never completes (ignoring abort: %s) ends the session, bounded", async (ignoreAbort) => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(0);
    transport.receive("7E8 06");
    transport.stallNextWrites(1, { ignoreAbort });
    const bound = commandMs + interruptMs + (ignoreAbort ? interruptMs : 0);
    await advance(bound - 1);
    expect(pending.settled).toBe(false);
    await advance(1);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [], raw: { incomplete: "7E8 06" } });
    expect(pending.value?.detail).toMatch(/the interrupt could not be written/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.writes).toEqual(["03\r"]);
  });

  it("a probe write that never completes ends the session, bounded", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(commandMs);
    transport.stallNextWrites(1);
    transport.receive("STOPPED\r\r>");
    await advance(interruptMs);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.detail).toMatch(/the ATRV probe could not be written/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.writes).toEqual(["03\r", "\r"]);
  });

  it("an adapter that keeps answering after an interrupt is declared unresponsive", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(commandMs);
    transport.receive("STOPPED\r\r>");
    for (let i = 0; i <= DEFAULT_ELM_TIMEOUTS.maxLateReplies; i++) {
      await advance(10);
      transport.receive("7E8 02 43 00\r\r>");
    }
    await advance(0);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.raw.discardedAfter).toHaveLength(DEFAULT_ELM_TIMEOUTS.maxLateReplies + 1);
    expect(pending.value?.detail).toMatch(/kept answering/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r"]);
  });

  it("bytes left without a prompt while synchronising are waited for, bounded, and kept as incomplete", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(commandMs);
    transport.receive("STOPPED\r\r>7E8 02");
    await advance(interruptMs);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.raw).toMatchObject({ received: "STOPPED\r\r>", incomplete: "7E8 02", truncated: false, byteCount: 16 });
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
  });

  it("an adapter that never answers the probe is declared unresponsive after a bounded number of probes, each sent once", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(commandMs);
    transport.receive("STOPPED\r\r>");
    await advance(MAX_SYNC_PROBES * interruptMs + 1);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.detail).toMatch(/no answer to ATRV \/ ATDPN after 2 probes/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
    expect(transport.writes).toEqual(["03\r", "\r", ...SYNC_PROBES.map((probe) => `${probe}\r`)]);
  });

  it("an interrupted ATRV is synchronised by ATDPN alone, never by a second voltage", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("ATRV"));
    await advance(commandMs);
    transport.receive("STOPPED\r\r>");
    await advance(0);
    expect(transport.writes).toEqual(["ATRV\r", "\r", "ATDPN\r"]);
    // ATRV's own late answer is not the probe's.
    transport.receive("12.6V\r\r>");
    await advance(interruptMs - 1);
    expect(pending.settled).toBe(false);
    await advance(1);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.detail).toMatch(/no answer to ATDPN after 1 probe$/);
    expect(pending.value?.raw.discardedAfter.map((d) => d.reason)).toEqual(["late_reply"]);
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
    expect(transport.writes).toEqual(["ATRV\r", "\r", "ATDPN\r"]);
  });

  it.each(["ATZ", "ATWS", "ATI", "AT@1", "ATDP"])(
    "an interrupted free-text command (%s) cannot be resynchronised: no probe is sent and the session ends resync_impossible",
    async (command) => {
      const { transport, executor } = await manual();
      const pending = track(executor.run(command));
      await advance(commandMs);
      transport.receive("STOPPED\r\r>");
      await advance(0);
      // Its late answer may be any line (an AT@1 description could read "12.6V"), so no probe is written.
      expect(transport.writes).toEqual([`${command}\r`, "\r"]);
      expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
      expect(pending.value?.detail).toMatch(/cannot be resynchronised$/);
      expect(executor.status).toMatchObject({ state: "failed", failure: "resync_impossible" });
      expect(transport.state).toBe("closed");
      // A voltage-shaped late answer can never become a later ATRV's data: nothing more runs on this session.
      transport.receive("12.6V\r\r>");
      expect(await executor.run("ATRV")).toMatchObject({ outcome: "session_unavailable", written: false, lines: [] });
      expect(transport.writes).toEqual([`${command}\r`, "\r"]);
    },
  );

  it("a timeout whose interrupt gets no prompt keeps the partial reply as incomplete, never as data", async () => {
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(0);
    transport.receive("7E8 06 43 02");
    await advance(commandMs + interruptMs);
    expect(pending.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(pending.value?.raw).toMatchObject({ received: null, incomplete: "7E8 06 43 02", truncated: false, byteCount: 12 });
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
  });
});

describe("cancellation (rows 28-29)", () => {
  it("row 28: cancel while waiting for the prompt: STOPPED handled, interrupted, no partial data", async () => {
    const { transport, adapter, executor } = await scripted({ replies: { "03": { lines: ["7E8 06 43 02 01 33 01 71"], chunkSize: 5, chunkIntervalMs: 100 } } });
    const controller = new AbortController();
    const pending = track(executor.run("03", { signal: controller.signal }));
    await advance(150);
    controller.abort();
    await advance(10);
    expect(pending.value).toMatchObject({ outcome: "interrupted", detail: "cancelled", lines: [], written: true });
    expect(pending.value?.raw.received).toBe("7E8 06 43 STOPPED\r\r>");
    expect(pending.value?.raw.discardedAfter).toEqual([SYNC_ANSWER]);
    expect(adapter.interrupts).toBe(1);
    expect(transport.writes.slice(-3)).toEqual(["03\r", "\r", "ATRV\r"]);
    expect(executor.state).toBe("ready");
    expect(await runToEnd(executor, "ATRV")).toMatchObject({ outcome: "ok", lines: ["12.6V"] });
  });

  it("row 29: cancel when the adapter never prompts: adapter_unresponsive, transport closed, nothing more written", async () => {
    const { transport, executor } = await scripted({ onInterrupt: "ignore", replies: { "07": { silent: true } } });
    const controller = new AbortController();
    const pending = track(executor.run("07", { signal: controller.signal }));
    await advance(10);
    controller.abort();
    await advance(interruptMs);
    expect(pending.value).toMatchObject({ outcome: "interrupted", lines: [] });
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
    expect(transport.state).toBe("closed");
    const writes = transport.writes.length;
    expect(await executor.run("07")).toMatchObject({ outcome: "session_unavailable", written: false });
    expect(transport.writes.length).toBe(writes);
  });

  it("cancel with no prompt after the interrupt keeps the partial reply as incomplete, never as data", async () => {
    const { transport, executor } = await manual();
    const controller = new AbortController();
    const pending = track(executor.run("03", { signal: controller.signal }));
    await advance(0);
    transport.receive("7E8 06 43");
    controller.abort();
    await advance(interruptMs);
    expect(pending.value).toMatchObject({ outcome: "interrupted", lines: [] });
    expect(pending.value?.raw).toMatchObject({ received: null, incomplete: "7E8 06 43", truncated: false, byteCount: 9 });
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_unresponsive" });
  });

  it("cancel during the command's write: nothing is sent and the session stays usable", async () => {
    const { transport, adapter, executor } = await scripted({}, { writeDelayMs: 50 });
    const writes = transport.writes.length;
    const controller = new AbortController();
    const pending = track(executor.run("03", { signal: controller.signal }));
    await advance(10);
    controller.abort();
    await advance(0);
    expect(pending.value).toMatchObject({ outcome: "interrupted", written: false, lines: [], detail: "cancelled before it was sent" });
    await advance(100);
    expect(transport.writes.length).toBe(writes);
    expect(adapter.received).not.toContain("03");
    expect(executor.state).toBe("ready");
    expect(await runToEnd(executor, "ATRV")).toMatchObject({ outcome: "ok", lines: ["12.6V"] });
  });

  it("cancel during a write the link cannot stop: delivery uncertain, the session ends within interruptMs", async () => {
    const { transport, executor } = await manual();
    transport.stallNextWrites(1, { ignoreAbort: true });
    const controller = new AbortController();
    const pending = track(executor.run("03", { signal: controller.signal }));
    await advance(10);
    controller.abort();
    await advance(interruptMs - 1);
    expect(pending.settled).toBe(false);
    await advance(1);
    expect(pending.value).toMatchObject({ outcome: "interrupted", written: true, lines: [] });
    expect(pending.value?.detail).toMatch(/delivery is uncertain/);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
    expect(transport.writes).toEqual([]);
  });

  it("an already-aborted signal writes nothing", async () => {
    const { transport, executor } = await manual();
    expect(await executor.run("03", { signal: AbortSignal.abort() })).toMatchObject({ outcome: "interrupted", written: false });
    expect(transport.bytesWritten).toBe(0);
  });

  it("cancel while draining an earlier partial reply writes nothing", async () => {
    const { transport, executor } = await manual();
    transport.receive("7E8 02 4");
    const controller = new AbortController();
    const pending = track(executor.run("03", { signal: controller.signal }));
    await advance(10);
    controller.abort();
    await advance(0);
    expect(pending.value).toMatchObject({ outcome: "interrupted", written: false, lines: [], raw: { incomplete: null } });
    expect(pending.value?.raw.discardedBefore).toEqual([{ reason: "unsolicited_incomplete", text: "7E8 02 4", lines: ["7E8 02 4"], overflowed: false, byteCount: 8 }]);
    expect(transport.bytesWritten).toBe(0);
  });

  it("an abort after the reply completed changes nothing", async () => {
    const { transport, executor } = await manual();
    const controller = new AbortController();
    const pending = executor.run("03", { signal: controller.signal });
    await advance(0);
    transport.receive("7E8 02 43 00\r\r>");
    const result = await pending;
    controller.abort();
    await advance(interruptMs);
    expect(result).toMatchObject({ outcome: "ok", lines: ["7E8 02 43 00"] });
    expect(transport.writes).toEqual(["03\r"]);
  });
});

describe("late-response isolation (row 30)", () => {
  it("a late reply after a timeout is drained; the next command's answer is its own", async () => {
    const { transport, executor } = await manual();
    const first = track(executor.run("03"));
    await advance(commandMs);
    expect(transport.writes).toEqual(["03\r", "\r"]);
    // The original answer arrives late and serves as the interrupt's prompt; a repeat follows.
    transport.receive("7E8 06 43 02 01 33 01 71\r\r>");
    await advance(100);
    transport.receive("7E8 06 43 02 01 33 01 71\r\r>");
    await advance(100);
    transport.receive(PROBE_ANSWER);
    await advance(0);
    expect(first.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(first.value?.raw.received).toBe("7E8 06 43 02 01 33 01 71\r\r>");
    expect(first.value?.raw.discardedAfter).toEqual([
      { reason: "late_reply", text: "7E8 06 43 02 01 33 01 71\r\r>", lines: ["7E8 06 43 02 01 33 01 71"], overflowed: false, byteCount: 27 },
      SYNC_ANSWER,
    ]);

    const second = executor.run("07");
    await advance(0);
    transport.receive("7E8 02 47 00\r\r>");
    expect(await second).toMatchObject({ outcome: "ok", lines: ["7E8 02 47 00"], raw: { discardedBefore: [] } });
  });

  it("a quiet interval is not proof: an old reply long after the interrupt never answers the next request for the same service", async () => {
    const { transport, executor } = await manual();
    const OLD = "7E8 06 43 02 01 33 01 71";
    const first = track(executor.run("03"));
    await advance(commandMs);
    transport.receive("STOPPED\r\r>");
    // Well past any short quiet window: still synchronising, so the next 03 is refused and not written.
    await advance(interruptMs - 1);
    expect(first.settled).toBe(false);
    expect(await executor.run("03")).toMatchObject({ outcome: "busy", written: false });
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r"]);
    // The old answer finally arrives: discarded, because it is not the probe's answer.
    transport.receive(`${OLD}\r\r>`);
    await advance(interruptMs - 1);
    expect(first.settled).toBe(false);
    transport.receive(PROBE_ANSWER);
    await advance(0);
    expect(first.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(first.value?.raw.discardedAfter.map((d) => d.reason)).toEqual(["late_reply", "sync_answer"]);

    // The second 03 is written only now, and its answer is its own.
    const second = executor.run("03");
    await advance(0);
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r", "03\r"]);
    transport.receive("7E8 02 43 00\r\r>");
    expect(await second).toMatchObject({ outcome: "ok", lines: ["7E8 02 43 00"], raw: { discardedBefore: [] } });
  });

  it("an interrupt crossing a completed reply makes the adapter repeat the command; the repeat never answers the next 03", async () => {
    // Writes take 50 ms. The first answer lands 25 ms after the timeout, before the interrupt CR
    // reaches the adapter, which is then idle and repeats 03 on the bare CR (answer 2 s later).
    const OLD = "7E8 06 43 02 01 33 01 71";
    const REPEAT = "7E8 04 43 01 01 71";
    const NEW = "7E8 02 43 00";
    const { transport, adapter, executor } = await scripted(
      { replies: { "03": [{ lines: [OLD], delayMs: commandMs - 25 }, { lines: [REPEAT], delayMs: 2000 }, { lines: [NEW] }] } },
      { writeDelayMs: 50 },
    );
    const first = await runToEnd(executor, "03");
    expect(first).toMatchObject({ outcome: "timeout", lines: [] });
    expect(first.raw.received).toBe(`${OLD}\r\r>`);
    // The probe reached the adapter while it was answering the repeat: it interrupted it, so the next probe was sent.
    expect(first.raw.discardedAfter.map((d) => [d.reason, d.lines])).toEqual([
      ["late_reply", ["STOPPED"]],
      ["sync_answer", ["A6"]],
    ]);
    // The first probe was consumed as an interrupt, so the adapter executed only the second.
    expect(transport.writes.slice(-4)).toEqual(["03\r", "\r", "ATRV\r", "ATDPN\r"]);
    expect(adapter.received.slice(-3)).toEqual(["03", "", "ATDPN"]);
    expect(adapter.interrupts).toBe(1);
    expect(executor.state).toBe("ready");

    const second = await runToEnd(executor, "03");
    expect(second).toMatchObject({ outcome: "ok", lines: [NEW], raw: { discardedBefore: [] } });
    expect(JSON.stringify(second)).not.toContain(REPEAT);
  });

  it("a first probe answering during the retry probe's write never ends recovery; a later ATRV gets its own voltage", async () => {
    // Writes take 50 ms. The first ATRV probe looks consumed (quiet for interruptMs), but its answer lands while the
    // retry is being written, and the retry still executes. Only the retry's (differently shaped) answer ends recovery.
    const W = 50;
    const { transport, executor } = await manual({ writeDelayMs: W });
    const first = track(executor.run("03"));
    await advance(commandMs + W);
    expect(transport.writes).toEqual(["03\r", "\r"]);
    transport.receive("STOPPED\r\r>");
    await advance(W);
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r"]);
    await advance(interruptMs + W / 2); // quiet: the retry probe's write is in progress
    transport.receive("12.6V\r\r>"); // the first probe's late answer
    await advance(W / 2);
    expect(transport.writes).toEqual(["03\r", "\r", "ATRV\r", "ATDPN\r"]);
    expect(first.settled).toBe(false);
    expect(await executor.run("ATRV")).toMatchObject({ outcome: "busy", written: false });
    transport.receive("A6\r\r>"); // the retry probe's own answer
    await advance(0);
    expect(first.value).toMatchObject({ outcome: "timeout", lines: [] });
    expect(first.value?.raw.discardedAfter.map((d) => [d.reason, d.lines])).toEqual([
      ["late_reply", ["12.6V"]],
      ["sync_answer", ["A6"]],
    ]);
    expect(executor.state).toBe("ready");

    // Nothing written before the A6 can still answer: the next ATRV's data is its own.
    const voltage = track(executor.run("ATRV"));
    await advance(W / 2);
    expect(voltage.settled).toBe(false);
    await advance(W / 2);
    expect(transport.writes.at(-1)).toBe("ATRV\r");
    transport.receive("13.1V\r\r>");
    await advance(0);
    expect(voltage.value).toMatchObject({ outcome: "ok", lines: ["13.1V"], raw: { discardedBefore: [] } });
    expect(JSON.stringify(voltage.value)).not.toContain("12.6V");
  });

  it("a reply that arrives while idle is discarded and recorded on the next command", async () => {
    const { transport, executor } = await manual();
    transport.receive("7E8 06 43 02 01 33 01 71\r\r>");
    await advance(0);
    expect(executor.state).toBe("ready");
    const next = executor.run("07");
    await advance(0);
    transport.receive("7E8 02 47 00\r\r>");
    const result = await next;
    expect(result).toMatchObject({ outcome: "ok", lines: ["7E8 02 47 00"] });
    expect(result.raw.discardedBefore).toEqual([{ reason: "unsolicited", text: "7E8 06 43 02 01 33 01 71\r\r>", lines: ["7E8 06 43 02 01 33 01 71"], overflowed: false, byteCount: 27 }]);
  });

  it("a partial earlier reply is drained to its prompt before the next command is written", async () => {
    const { transport, executor } = await manual();
    transport.receive("7E8 06 43 02");
    const next = executor.run("07");
    await advance(500);
    expect(transport.writes).toEqual([]);
    transport.receive(" 01 33 01 71\r\r>");
    await advance(0);
    expect(transport.writes).toEqual(["07\r"]);
    transport.receive("7E8 02 47 00\r\r>");
    const result = await next;
    expect(result).toMatchObject({ outcome: "ok", lines: ["7E8 02 47 00"] });
    expect(result.raw.discardedBefore.map((d) => d.lines)).toEqual([["7E8 06 43 02 01 33 01 71"]]);
  });

  it("a partial earlier reply that never prompts ends the session before anything is written, and is kept as earlier provenance", async () => {
    const { transport, executor } = await manual();
    transport.receive("7E8 06 43 02");
    const pending = track(executor.run("07"));
    await advance(interruptMs);
    expect(pending.value).toMatchObject({ outcome: "adapter_unresponsive", written: false, lines: [], raw: { received: null, incomplete: null, byteCount: 0 } });
    expect(pending.value?.raw.discardedBefore).toEqual([{ reason: "unsolicited_incomplete", text: "7E8 06 43 02", lines: ["7E8 06 43 02"], overflowed: false, byteCount: 12 }]);
    expect(transport.writes).toEqual([]);
    expect(transport.state).toBe("closed");
  });

  it("an earlier partial reply cut off by a disconnect is kept as earlier provenance", async () => {
    const { transport, executor } = await manual();
    transport.receive("7E8 06 43");
    const pending = track(executor.run("07"));
    await advance(10);
    transport.disconnect();
    await advance(0);
    expect(pending.value).toMatchObject({ outcome: "transport_lost", written: false, lines: [], raw: { incomplete: null } });
    expect(pending.value?.raw.discardedBefore).toEqual([{ reason: "unsolicited_incomplete", text: "7E8 06 43", lines: ["7E8 06 43"], overflowed: false, byteCount: 9 }]);
    expect(transport.writes).toEqual([]);
  });

  it("an earlier reply overflowing without a prompt is kept truncated, with its full byte count", async () => {
    const { transport, executor } = await manual();
    transport.receive("4".repeat(5000));
    const pending = track(executor.run("ATZ"));
    await advance(interruptMs);
    expect(pending.value).toMatchObject({ outcome: "adapter_unresponsive", written: false });
    const [kept] = pending.value?.raw.discardedBefore ?? [];
    expect(kept).toMatchObject({ reason: "unsolicited_incomplete", overflowed: true, byteCount: 5000 });
    expect(kept.text.length).toBeLessThan(5000);
    expect(transport.writes).toEqual([]);
  });
});

describe("disconnect and close (rows 31, 33)", () => {
  it("row 31: disconnect during a command ends it transport_lost; earlier results are untouched", async () => {
    const { transport, executor } = await manual();
    const codes = executor.run("03");
    await advance(0);
    transport.receive("7E8 06 43 02 01 33 01 71\r\r>");
    const stored = await codes;
    const pending = executor.run("07");
    await advance(0);
    transport.receive("7E8 02 47");
    transport.disconnect();
    const lost = await pending;
    expect(lost).toMatchObject({ outcome: "transport_lost", lines: [], written: true });
    expect(lost.raw).toMatchObject({ received: null, lines: [], incomplete: "7E8 02 47", truncated: false, byteCount: 9 });
    expect(stored).toMatchObject({ outcome: "ok", lines: ["7E8 06 43 02 01 33 01 71"] });
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(await executor.run("0A")).toMatchObject({ outcome: "session_unavailable", written: false });
    expect(transport.writes).toEqual(["03\r", "07\r"]);
  });

  it("a disconnect while idle fails the session", async () => {
    const { transport, executor } = await manual();
    transport.disconnect();
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
  });

  it("a disconnect right after a complete reply keeps that reply and still fails the session", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("03");
    await advance(0);
    transport.receive("7E8 02 43 00\r\r>");
    transport.disconnect();
    expect(await pending).toMatchObject({ outcome: "ok", lines: ["7E8 02 43 00"] });
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
  });

  it("a failed write ends the session transport_lost", async () => {
    const { transport, executor } = await manual();
    transport.failNextWrites();
    expect(await executor.run("03")).toMatchObject({ outcome: "transport_lost", written: true });
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
  });

  it("a write that fails after replies began arriving keeps every received byte as provenance, never as data", async () => {
    const { transport, executor } = await manual();
    transport.failNextWrites(1, { afterMs: 50 });
    const pending = track(executor.run("03"));
    await advance(10);
    // Delivery is uncertain: a complete reply and part of another arrive before the write fails.
    transport.receive("7E8 02 43 00\r\r>");
    transport.receive("7E8 06 43");
    await advance(40);
    expect(pending.value).toMatchObject({ outcome: "transport_lost", written: true, lines: [] });
    expect(pending.value?.raw).toMatchObject({ received: "7E8 02 43 00\r\r>", incomplete: "7E8 06 43", truncated: false });
    expect(pending.value?.raw.byteCount).toBe("7E8 02 43 00\r\r>".length + "7E8 06 43".length);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
  });

  it("an interrupt write that fails after the late answer arrived keeps it, and the partial bytes, as provenance", async () => {
    const OLD = "7E8 06 43 02 01 33 01 71\r\r>";
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(0);
    transport.failNextWrites(1, { afterMs: 50 });
    await advance(commandMs); // timed out: the interrupt's write starts and fails 50 ms later
    transport.receive(OLD);
    transport.receive("7E8 06 43");
    await advance(50);
    expect(pending.value).toMatchObject({ outcome: "timeout", written: true, lines: [] });
    expect(pending.value?.detail).toMatch(/the interrupt could not be written$/);
    expect(pending.value?.raw).toMatchObject({ received: OLD, incomplete: "7E8 06 43", truncated: false, discardedAfter: [] });
    expect(pending.value?.raw.byteCount).toBe(OLD.length + "7E8 06 43".length);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
    expect(transport.writes).toEqual(["03\r"]);
  });

  it("a probe write that fails after a late reply arrived keeps it as a late reply, never as the probe's answer or data", async () => {
    const OLD = "7E8 06 43 02 01 33 01 71\r\r>";
    const { transport, executor } = await manual();
    const pending = track(executor.run("03"));
    await advance(commandMs);
    expect(transport.writes).toEqual(["03\r", "\r"]);
    transport.failNextWrites(1, { afterMs: 50 });
    transport.receive("STOPPED\r\r>"); // the interrupt's prompt: the ATRV probe's write starts and fails 50 ms later
    await advance(10);
    transport.receive(OLD);
    transport.receive("12.");
    await advance(40);
    expect(pending.value).toMatchObject({ outcome: "timeout", written: true, lines: [] });
    expect(pending.value?.detail).toMatch(/the ATRV probe could not be written$/);
    expect(pending.value?.raw).toMatchObject({ received: "STOPPED\r\r>", incomplete: "12.", truncated: false });
    expect(pending.value?.raw.discardedAfter).toEqual([{ reason: "late_reply", text: OLD, lines: ["7E8 06 43 02 01 33 01 71"], overflowed: false, byteCount: OLD.length }]);
    expect(pending.value?.raw.byteCount).toBe("STOPPED\r\r>".length + "12.".length);
    expect(executor.status).toMatchObject({ state: "failed", failure: "transport_lost" });
    expect(transport.state).toBe("closed");
    expect(transport.writes).toEqual(["03\r", "\r"]);
  });

  it("row 33: close() during a write rejects the write; state closed; no further writes", async () => {
    const transport = new SimulatedTransport({ writeDelayMs: 50 });
    transport.attach(new ScriptedElmAdapter());
    await transport.open();
    const executor = new ElmCommandExecutor(transport);
    const pending = executor.run("ATZ");
    await advance(10);
    await executor.close();
    expect(await pending).toMatchObject({ outcome: "interrupted", lines: [] });
    expect(transport.writes).toEqual([]);
    expect(executor.state).toBe("closed");
    expect(await executor.run("ATZ")).toMatchObject({ outcome: "session_unavailable", written: false });
    await vi.runAllTimersAsync();
    expect(transport.writes).toEqual([]);
  });

  it("close() while waiting for a reply interrupts it without writing an interrupt", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("03");
    await advance(0);
    transport.receive("7E8 06 43");
    await executor.close();
    expect(await pending).toMatchObject({ outcome: "interrupted", lines: [], raw: { incomplete: "7E8 06 43" } });
    expect(transport.writes).toEqual(["03\r"]);
    expect(transport.state).toBe("closed");
    expect(executor.state).toBe("closed");
    await executor.close(); // idempotent
  });
});

describe("power events and framing errors (rows 5, 34)", () => {
  it("row 34: a spontaneous reset mid-command ends the session adapter_power_event", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("07");
    await advance(0);
    transport.receive("\r\rELM327 v1.5\r\r>");
    expect(await pending).toMatchObject({ outcome: "adapter_power_event", lines: [] });
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_power_event" });
    expect(transport.state).toBe("closed");
  });

  it.each(["ATDP", "AT@1"])("an identity banner answering %s is a spontaneous reset: the session ends, nothing more is written", async (command) => {
    const { transport, executor } = await manual();
    const pending = executor.run(command);
    await advance(0);
    transport.receive("\r\rELM327 v1.5\r\r>");
    expect(await pending).toMatchObject({ outcome: "adapter_power_event", token: "ELM327 v1.5", lines: [] });
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_power_event" });
    expect(executor.initialised).toBe(false);
    expect(transport.state).toBe("closed");
    expect(await executor.run("03")).toMatchObject({ outcome: "session_unavailable", written: false });
    expect(transport.writes).toEqual([`${command}\r`]);
  });

  it("the identity line is ATI's own answer", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("ATI");
    await advance(0);
    transport.receive("ELM327 v1.5\r\r>");
    expect(await pending).toMatchObject({ outcome: "ok", lines: ["ELM327 v1.5"] });
    expect(executor.initialised).toBe(true);
  });

  it("the echo coming back after ATE0 is a reset", async () => {
    const { transport, executor } = await manual();
    const pending = executor.run("03");
    await advance(0);
    transport.receive("03\r7E8 02 43 00\r\r>");
    expect(await pending).toMatchObject({ outcome: "adapter_power_event", lines: [] });
    expect(executor.status.failure).toBe("adapter_power_event");
  });

  it("LV RESET while idle fails the session at once", async () => {
    const { transport, executor } = await manual();
    transport.receive("LV RESET\r\r>");
    expect(executor.status).toMatchObject({ state: "failed", failure: "adapter_power_event" });
    expect(await executor.run("03")).toMatchObject({ outcome: "session_unavailable", written: false });
  });

  it("row 5: no prompt past the byte cap is a framing error; only ATZ / ATWS is accepted until a reset", async () => {
    const transport = new SimulatedTransport();
    await transport.open();
    const executor = new ElmCommandExecutor(transport, { byteCap: 64 });
    for (const command of INITIALISATION_SEQUENCE) {
      const step = executor.run(command);
      await advance(0);
      transport.receive(command === "ATZ" ? "ELM327 v1.5\r\r>" : "OK\r\r>");
      await step;
    }
    transport.writes.length = 0;
    const pending = executor.run("0902");
    await advance(0);
    transport.receive("7E8 ".repeat(20));
    await advance(0);
    expect(transport.writes).toEqual(["0902\r", "\r"]);
    transport.receive("STOPPED\r\r>");
    await advance(0);
    expect(transport.writes).toEqual(["0902\r", "\r", "ATRV\r"]);
    transport.receive(PROBE_ANSWER);
    await advance(0);
    const result = await pending;
    expect(result).toMatchObject({ outcome: "framing_error", lines: [] });
    // 80 bytes, then "STOPPED\r\r" (9) and the prompt; only the first 65 were kept.
    expect(result.raw).toMatchObject({ truncated: true, byteCount: 90, incomplete: null });
    expect(result.raw.received).toBe(`${"7E8 ".repeat(20).slice(0, 65)}>`);
    expect(executor.state).toBe("needs_reset");
    expect(executor.initialised).toBe(false);
    for (const command of ["03", "ATE0", "ATH1", "ATRV"]) {
      expect(await executor.run(command), command).toMatchObject({ outcome: "adapter_needs_reset", written: false });
    }
    expect(transport.writes).toEqual(["0902\r", "\r", "ATRV\r"]);
    const reset = executor.run("ATZ");
    await advance(0);
    transport.receive("ATZ\r\rELM327 v1.5\r\r>");
    expect(await reset).toMatchObject({ outcome: "ok", lines: ["ELM327 v1.5"] });
    expect(executor.state).toBe("ready");
    expect(await executor.run("03")).toMatchObject({ outcome: "adapter_not_initialised", written: false });
  });

  it("a status listener that throws never affects the session", async () => {
    const { transport, executor } = await manual();
    executor.onStatus(() => {
      throw new Error("listener failure");
    });
    const pending = executor.run("03");
    await advance(0);
    transport.receive("7E8 02 43 00\r\r>");
    expect(await pending).toMatchObject({ outcome: "ok" });
  });
});
