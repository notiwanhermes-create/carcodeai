/**
 * The ELM command executor: one prompt-terminated command at a time.
 *
 * RESEARCH PROTOTYPE (protocol-stack.md, "Framing", "Cancellation",
 * "Timeouts"; scan-flow.md, "Lifecycle"). Rules:
 *
 * - Every command passes the read-only policy before any byte is written.
 * - One command in flight. A second command while one is running (or while
 *   the executor is recovering from one) is refused `busy`, never queued.
 * - A command is written only when no earlier reply can still arrive: bytes
 *   received while idle are drained to their prompt and discarded first.
 * - Every write is bounded and abortable. A command's bound covers its write
 *   and its reply. A write the transport confirms was not sent (`aborted`)
 *   after a cancellation leaves the session usable; a write that stalled past
 *   its bound, failed, or could not be stopped (delivery uncertain) ends the
 *   session `transport_lost`.
 * - On timeout or cancellation the executor sends one CR to interrupt the
 *   adapter and waits (bounded) for its prompt. It then synchronises: it sends
 *   a read-only probe whose answer cannot be mistaken for the interrupted
 *   command's, and discards every reply until that answer. A probe consumed
 *   as an interrupt is followed by a different probe, so only the last one
 *   written is ever accepted. The adapter answers in order, so nothing the
 *   interrupted command (a repeat of it, or an earlier probe) printed can
 *   follow the last probe's answer. Only then does `run` resolve. A quiet
 *   period is never taken as proof. No prompt, no probe answer, or too many
 *   late replies: the session ends `adapter_unresponsive` and the transport
 *   is closed. A free-text command (ATZ, ATWS, ATI, AT@1, ATDP) may print
 *   anything, including a line shaped like a probe's answer, so after one is
 *   interrupted no probe can establish a boundary: the session ends
 *   `resync_impossible` and the transport is closed (fail closed).
 * - Only `ok` carries data. A timed-out, cancelled, overflowed or failed
 *   command never yields partial data.
 * - OBD requests are refused until echo off (ATE0) and headers on (ATH1) are
 *   confirmed on this adapter session. A reset, a framing error, or a setup
 *   command that did not end `ok` clears that confirmation.
 * - After a framing error only ATZ / ATWS is accepted until one succeeds.
 * - A power event (including an identity line from any command other than
 *   ATZ / ATWS / ATI), a lost link or an unresponsive adapter ends the
 *   session; nothing more is written.
 *
 * Every response keeps its raw text and lines for provenance, including bytes
 * that never reached a prompt and whether any were dropped past the byte cap.
 */
import { textToBytes } from "../bytes";
import { TransportError, type ByteTransport } from "../transport/types";
import type { CommandOutcome, SessionFailure } from "../types";
import { classifyResponse } from "./classify";
import { checkCommand, type CommandCheck } from "./command-policy";
import { DEFAULT_RESPONSE_BYTE_CAP, PromptFramer, splitLines, type FramedResponse, type FramerEvent } from "./framer";

export type ElmTimeouts = {
  /** Outer bound for a normal command, its write included (protocol-stack.md: 5 s). */
  commandMs: number;
  /** Outer bound for the request that may trigger a protocol search (15 s). */
  searchMs: number;
  /**
   * Bound on each recovery step: writing the interrupt or the probe, the
   * prompt after an interrupt, each reply while synchronising, an idle
   * reply's prompt, and a stuck write's response to an abort (1 s).
   */
  interruptMs: number;
  /** Late replies tolerated in one recovery before the adapter is declared unresponsive. */
  maxLateReplies: number;
};

export const DEFAULT_ELM_TIMEOUTS: Readonly<ElmTimeouts> = Object.freeze({
  commandMs: 5000,
  searchMs: 15000,
  interruptMs: 1000,
  maxLateReplies: 3,
});

/** No configured bound may exceed this. */
export const MAX_TIMEOUT_MS = 30000;

/**
 * Synchronisation probes, in the order they are sent. Their answers have
 * shapes no other allowed command's answer has, and differ from each other,
 * so each probe is sent at most once per recovery and one whose own kind was
 * interrupted is skipped.
 */
export const SYNC_PROBES = Object.freeze(["ATRV", "ATDPN"] as const);

/** Synchronisation probes sent in one recovery, at most, before the adapter is declared unresponsive. */
export const MAX_SYNC_PROBES = SYNC_PROBES.length;

export type ElmExecutorOptions = { timeouts?: Partial<ElmTimeouts>; byteCap?: number };

export type RunOptions = {
  signal?: AbortSignal;
  /** "search" for the first request after ATSP0, which may trigger a protocol search. */
  timeout?: "normal" | "search";
};

export type DiscardedReply = {
  /**
   * `late_reply`: after an interrupt. `unsolicited`: while no command was in
   * flight. `unsolicited_incomplete`: bytes received while no command was in
   * flight that had not reached a prompt when draining them ended (timeout,
   * lost link, cancellation); a snapshot, so if the session goes on, the
   * finished reply is recorded again on the next command. `sync_answer`: the
   * synchronisation probe's own answer, which ends recovery (never data).
   */
  reason: "late_reply" | "unsolicited" | "unsolicited_incomplete" | "sync_answer";
  /** Exact text with its prompt (none for `unsolicited_incomplete`; truncated when `overflowed`). */
  text: string;
  lines: string[];
  overflowed: boolean;
  /** Bytes received for this reply, its prompt and any dropped past the cap included. */
  byteCount: number;
};

export type CommandResult = {
  /** The command as requested (refused input is kept as given). */
  command: string;
  /** Whether the command's bytes were handed to the transport (false when it confirmed none were sent). */
  written: boolean;
  outcome: CommandOutcome;
  /** The adapter token behind a reply outcome, when there was one. */
  token: string | null;
  detail: string | null;
  /** Data lines. Non-empty only when `outcome` is "ok". */
  lines: string[];
  /** Progress lines such as "SEARCHING...". */
  info: string[];
  raw: {
    /** Every prompt-terminated reply to this command and its interrupt, exactly as kept, with prompts; null when none arrived. */
    received: string | null;
    /** Every line of those replies, before echo and progress lines were removed. */
    lines: string[];
    echoRemoved: boolean;
    /** Bytes received without a closing prompt when the command ended (lost link, failed write, no prompt). Never data. */
    incomplete: string | null;
    /** Bytes were dropped past the byte cap: `received` / `incomplete` are truncated. */
    truncated: boolean;
    /** Bytes received for `received` and `incomplete`, prompts and dropped bytes included. */
    byteCount: number;
    /** Earlier replies drained before this command was written (or that stopped it being written). */
    discardedBefore: DiscardedReply[];
    /** Replies drained after this command was interrupted, ending with the probe's answer when the session goes on. */
    discardedAfter: DiscardedReply[];
  };
};

export type ElmSessionState = "ready" | "busy" | "needs_reset" | "failed" | "closed";

export type ElmStatus = {
  state: ElmSessionState;
  /** The command in flight, if any. */
  command: string | null;
  /** The adapter printed "SEARCHING..." for the command in flight. */
  searching: boolean;
  failure: SessionFailure | null;
};

type AllowedCheck = Extract<CommandCheck, { allowed: true }>;

type Wake = FramerEvent | { type: "timeout" } | { type: "aborted" } | { type: "closed" };

type Reply = { type: "response"; response: FramedResponse } | { type: "timeout" } | { type: "closed" };

/**
 * `written`: the write completed. `not_sent`: aborted, and the transport
 * confirmed no byte was sent. `failed`: rejected otherwise (delivery
 * uncertain). `stalled`: still pending `interruptMs` after it was aborted.
 */
type WriteResult = { status: "written" | "not_sent" | "failed" | "stalled"; timedOut: boolean };

function validTimeouts(input: Partial<ElmTimeouts> | undefined): ElmTimeouts {
  const timeouts = { ...DEFAULT_ELM_TIMEOUTS, ...input };
  for (const key of ["commandMs", "searchMs", "interruptMs"] as const) {
    const value = timeouts[key];
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
      throw new RangeError(`${key} must be a positive bound no greater than ${MAX_TIMEOUT_MS} ms`);
    }
  }
  if (!Number.isInteger(timeouts.maxLateReplies) || timeouts.maxLateReplies < 0 || timeouts.maxLateReplies > 10) {
    throw new RangeError("maxLateReplies must be an integer 0-10");
  }
  return timeouts;
}

/**
 * The probes whose answers cannot be confused with the interrupted command's
 * or with each other's: a voltage ("12.6V") and a protocol number ("A6") are
 * neither multi-byte hex data, "OK" nor an identity line, and the probe of
 * the interrupted command's own kind is skipped. INFERRED: relies on the
 * adapter answering in order, on ATRV / ATDPN being supported, and on OBD
 * replies (headers on) never being a single protocol-number token; an
 * adapter answering "?" to a probe ends the session.
 *
 * None, for a free-text command: its late answer may be any printable line
 * (an AT@1 description could read "12.6V"), so no probe's answer is disjoint
 * from it and no boundary can be established.
 */
function syncProbesFor(interrupted: AllowedCheck): AllowedCheck[] {
  if (interrupted.kind === "text") return [];
  return SYNC_PROBES.map((command) => {
    const probe = checkCommand(command);
    if (!probe.allowed) throw new Error("a synchronisation probe must be on the allowlist");
    return probe;
  }).filter((probe) => probe.kind !== interrupted.kind);
}

export class ElmCommandExecutor {
  private readonly timeouts: ElmTimeouts;
  private readonly framer: PromptFramer;
  private readonly backlog: FramerEvent[] = [];
  private readonly idleDiscards: DiscardedReply[] = [];
  private readonly statusListeners = new Set<(status: ElmStatus) => void>();
  private readonly unsubscribe: Array<() => void>;
  private waiter: (() => void) | null = null;
  private active: { command: string; abort: AbortController } | null = null;
  private activeDone: Promise<CommandResult> | null = null;
  private transportClosed = false;
  private closing = false;
  private closed = false;
  private failure: SessionFailure | null = null;
  private resetRequired = false;
  private searching = false;
  /** Confirmed on this adapter session. */
  private echoOff = false;
  private headersOn = false;

  constructor(
    private readonly transport: ByteTransport,
    options: ElmExecutorOptions = {},
  ) {
    if (transport.state !== "open") throw new Error("the transport must be open");
    this.timeouts = validTimeouts(options.timeouts);
    this.framer = new PromptFramer(options.byteCap ?? DEFAULT_RESPONSE_BYTE_CAP);
    this.unsubscribe = [transport.onData((chunk) => this.handleData(chunk)), transport.onClose(() => this.handleClose())];
  }

  get state(): ElmSessionState {
    if (this.closed) return "closed";
    if (this.failure) return "failed";
    if (this.active) return "busy";
    if (this.resetRequired) return "needs_reset";
    return "ready";
  }

  get status(): ElmStatus {
    return { state: this.state, command: this.active?.command ?? null, searching: this.searching, failure: this.failure };
  }

  /** Whether echo off and headers on are confirmed, so OBD requests are accepted. */
  get initialised(): boolean {
    return this.echoOff && this.headersOn && !this.resetRequired;
  }

  onStatus(listener: (status: ElmStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Runs one command. Never throws; every failure is a typed outcome. */
  run(command: string, options: RunOptions = {}): Promise<CommandResult> {
    const check = checkCommand(command);
    if (!check.allowed) return Promise.resolve(refused(command, "command_not_allowed", `${check.refusal}: ${check.reason}`));
    if (this.closed || this.closing) return Promise.resolve(refused(command, "session_unavailable", "the session is closed"));
    if (this.failure) return Promise.resolve(refused(command, "session_unavailable", `the session failed: ${this.failure}`));
    if (this.active) return Promise.resolve(refused(command, "busy", `"${this.active.command}" is in flight`));
    if (this.resetRequired && !check.resetsAdapter) {
      return Promise.resolve(refused(command, "adapter_needs_reset", "after a framing error only ATZ or ATWS is accepted"));
    }
    if (check.group === "obd" && !this.initialised) {
      return Promise.resolve(refused(command, "adapter_not_initialised", "echo off and headers on are not confirmed"));
    }
    if (options.signal?.aborted) return Promise.resolve(refused(command, "interrupted", "cancelled before it was sent"));

    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeoutMs = options.timeout === "search" ? this.timeouts.searchMs : this.timeouts.commandMs;
    this.active = { command, abort };
    this.emitStatus();
    const done = this.execute(check, timeoutMs, abort.signal).finally(() => {
      options.signal?.removeEventListener("abort", onCallerAbort);
      this.active = null;
      this.activeDone = null;
      this.searching = false;
      // The link may have closed after the reply completed; the session is over either way.
      if (this.transportClosed) this.fail("transport_lost");
      this.emitStatus();
      this.processIdle();
    });
    this.activeDone = done;
    return done;
  }

  /**
   * Ends the session: the transport is closed at once (rejecting any write in
   * progress), a command in flight ends `interrupted`, and nothing more is
   * written. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.active?.abort.abort();
    await this.transport.close().catch(() => undefined);
    if (this.activeDone) await this.activeDone;
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.emitStatus();
  }

  private async execute(check: AllowedCheck, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
    const { command } = check;
    const result = refused(command, "interrupted", null);

    // 1. Nothing earlier may still be answering; re-checked right before the write.
    do {
      const drained = await this.drainIdle(signal, check.resetsAdapter);
      result.raw.discardedBefore.push(...drained.discarded);
      if (drained.outcome !== "ok") return finish(result, drained.outcome, drained.detail);
    } while (this.backlog.length > 0 || this.framer.pendingBytes > 0);

    // 2. Write, inside the command's bound. From here a reset (even one that fails) leaves the adapter's settings unknown.
    if (check.resetsAdapter) this.forgetSettings();
    const deadline = Date.now() + timeoutMs;
    const write = await this.writeBounded(`${command}\r`, timeoutMs, signal);
    if (write.status !== "written") return this.commandWriteFailed(result, write, timeoutMs);
    result.written = true;
    if (write.timedOut || Date.now() >= deadline) {
      // The write finished only after the bound (a link may complete a write it could not stop): whatever arrives is not this command's data.
      return this.recover(result, "timeout", `the write did not complete within ${timeoutMs} ms`, check);
    }

    // 3. Wait for the prompt for the rest of the bound.
    const wake = await this.wait(Math.max(1, deadline - Date.now()), signal, true);
    switch (wake.type) {
      case "response":
        this.complete(result, wake.response, check);
        return result;
      case "closed":
        this.captureIncomplete(result);
        if (this.closing) return finish(result, "interrupted", "the session was closed");
        this.fail("transport_lost");
        return finish(result, "transport_lost", "the link closed while waiting for the reply");
      case "overflow":
        return this.recover(result, "framing_error", `more than ${this.framer.byteCap} bytes without a prompt`, check);
      case "timeout":
        return this.recover(result, "timeout", `no prompt within ${timeoutMs} ms`, check);
      case "aborted":
        return this.recover(result, "interrupted", "cancelled", check);
    }
  }

  /** The command's own write did not complete. Only a confirmed-unsent cancellation keeps the session. */
  private commandWriteFailed(result: CommandResult, write: WriteResult, timeoutMs: number): CommandResult {
    result.written = write.status !== "not_sent";
    if (this.closing) {
      this.captureReceived(result);
      return finish(result, "interrupted", "the session was closed");
    }
    // The session goes on: anything that arrived meanwhile is drained (and recorded) before the next command.
    if (write.status === "not_sent" && !write.timedOut) return finish(result, "interrupted", "cancelled before it was sent");
    // The session ends here: keep every byte received as provenance (never as data).
    this.captureReceived(result);
    this.fail("transport_lost");
    if (write.status === "failed") return finish(result, "transport_lost", "the write failed");
    const what = write.timedOut ? `the write did not complete within ${timeoutMs} ms` : "cancelled during the write";
    return finish(
      result,
      write.timedOut ? "timeout" : "interrupted",
      write.status === "not_sent" ? `${what}; nothing was sent, but the link is stalled` : `${what} and could not be stopped; delivery is uncertain`,
    );
  }

  /** A complete reply arrived for the command in flight. */
  private complete(result: CommandResult, response: FramedResponse, check: AllowedCheck): void {
    recordRaw(result, response);
    const command = result.command;
    let lines = response.lines;
    if (!this.echoOff && lines[0] === command) {
      lines = lines.slice(1);
      result.raw.echoRemoved = true;
    } else if (this.echoOff && lines.includes(command)) {
      // INFERRED: the echo is back, so the adapter reset itself and lost its settings.
      finish(result, "adapter_power_event", "the command echo reappeared after ATE0: the adapter reset itself");
      this.fail("adapter_power_event");
      return;
    }
    const classification = classifyResponse(lines, check.kind, check.printsIdentity);
    result.info = classification.infoLines;
    if (classification.outcome === "ok") {
      result.outcome = "ok";
      result.lines = classification.dataLines;
      if (command === "ATE0") this.echoOff = true;
      if (command === "ATH1") this.headersOn = true;
      if (command === "ATH0") this.headersOn = false;
      if (check.resetsAdapter) this.resetRequired = false;
      return;
    }
    result.token = classification.token;
    finish(result, classification.outcome, classification.detail);
    if (check.kind === "ok_only") this.forgetSettings();
    if (classification.outcome === "adapter_power_event") this.fail("adapter_power_event");
  }

  /**
   * Interrupt (one CR), wait bounded for the prompt, then synchronise. The
   * command keeps `outcome`; it never yields data.
   */
  private async recover(result: CommandResult, outcome: CommandOutcome, detail: string, check: AllowedCheck): Promise<CommandResult> {
    finish(result, outcome, detail);
    if (check.kind === "ok_only") this.forgetSettings();
    if (outcome === "framing_error") this.requireReset();
    if (this.closing) {
      // close() is ending the session; nothing more is written.
      this.captureReceived(result);
      return result;
    }
    if (!(await this.writeRecovery(result, "\r", "the interrupt", false))) return result;
    const prompt = await this.nextReply(this.timeouts.interruptMs);
    if (prompt.type !== "response") return this.recoveryEnded(result, prompt.type, "of the interrupt");
    recordRaw(result, prompt.response);
    if (this.isPowerEvent(prompt.response, check)) {
      this.fail("adapter_power_event");
      return result;
    }
    await this.synchronise(result, check);
    return result;
  }

  /**
   * Sends a probe and discards every reply until its answer. A probe that
   * reaches a still-busy adapter only interrupts it (and is consumed), so after
   * a quiet `interruptMs` with no answer the next, different probe is sent.
   * Only the answer to the last probe written ends recovery: an earlier
   * probe's answer may still arrive (even after a later probe was written)
   * and is discarded like any late reply. The same probe is never sent twice,
   * because its answers could not be told apart.
   */
  private async synchronise(result: CommandResult, check: AllowedCheck): Promise<void> {
    const probes = syncProbesFor(check);
    if (probes.length === 0) {
      // Fail closed: a late answer could be taken for a probe's, and then a later command's data.
      result.detail = `${result.detail}; ${check.command} prints free text, so no probe can tell its late answer apart and the session cannot be resynchronised`;
      this.fail("resync_impossible");
      return;
    }
    const after = result.raw.discardedAfter;
    for (let sent = 0; ; sent++) {
      if (sent === probes.length) {
        const names = probes.map((probe) => probe.command).join(" / ");
        result.detail = `${result.detail}; no answer to ${names} after ${probes.length} probe${probes.length === 1 ? "" : "s"}`;
        this.fail("adapter_unresponsive");
        return;
      }
      const probe = probes[sent];
      if (!(await this.writeRecovery(result, `${probe.command}\r`, `the ${probe.command} probe`, true))) return;
      for (;;) {
        const reply = await this.nextReply(this.timeouts.interruptMs);
        if (reply.type === "closed") {
          this.recoveryEnded(result, "closed", "");
          return;
        }
        if (reply.type === "timeout") {
          if (this.framer.pendingBytes > 0) {
            this.recoveryEnded(result, "timeout", "of a reply while synchronising");
            return;
          }
          break; // quiet: the probe was consumed as an interrupt; send it again
        }
        if (this.isProbeAnswer(reply.response, probe)) {
          after.push(discardedReply(reply.response, "sync_answer"));
          return;
        }
        if (!this.discard(reply.response, "late_reply", after, check)) return;
        if (after.filter((entry) => entry.reason === "late_reply").length > this.timeouts.maxLateReplies) {
          result.detail = `${result.detail}; the adapter kept answering after the interrupt`;
          this.fail("adapter_unresponsive");
          return;
        }
      }
    }
  }

  private isProbeAnswer(response: FramedResponse, probe: AllowedCheck): boolean {
    if (response.overflowed) return false;
    let lines = response.lines;
    if (!this.echoOff && lines[0] === probe.command) lines = lines.slice(1);
    return classifyResponse(lines, probe.kind, probe.printsIdentity).outcome === "ok";
  }

  /**
   * Writes a recovery byte sequence, bounded. On failure the session ends and
   * every byte received meanwhile is kept as provenance (never as data):
   * before the interrupt's prompt as the command's own replies, after it
   * (`afterInterrupt`, a probe's write) as late replies. Returns false.
   */
  private async writeRecovery(result: CommandResult, text: string, what: string, afterInterrupt: boolean): Promise<boolean> {
    const write = await this.writeBounded(text, this.timeouts.interruptMs);
    if (write.status === "written") return true;
    if (afterInterrupt) this.captureLate(result);
    else this.captureReceived(result);
    if (!this.closing) {
      result.detail = `${result.detail}; ${what} could not be written`;
      this.fail("transport_lost");
    }
    return false;
  }

  /** Recovery got no prompt (or lost the link): the session ends. */
  private recoveryEnded(result: CommandResult, reason: "timeout" | "closed", what: string): CommandResult {
    this.captureIncomplete(result);
    if (reason === "closed") {
      if (!this.closing) this.fail("transport_lost");
      return result;
    }
    result.detail = `${result.detail}; no prompt within ${this.timeouts.interruptMs} ms ${what}`;
    this.fail("adapter_unresponsive");
    return result;
  }

  /** The next complete reply within `ms`; an overflow on the way requires a reset and is skipped to its prompt. */
  private async nextReply(ms: number): Promise<Reply> {
    const deadline = Date.now() + ms;
    for (;;) {
      const wake = await this.wait(Math.max(1, deadline - Date.now()), undefined, false);
      if (wake.type === "response" || wake.type === "timeout" || wake.type === "closed") return wake;
      if (wake.type === "overflow") this.requireReset();
    }
  }

  /**
   * Writes with a bound and an abort. On the bound or an abort the transport
   * write is aborted; if it has not settled `interruptMs` later it is `stalled`.
   */
  private writeBounded(text: string, ms: number, signal?: AbortSignal): Promise<WriteResult> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      let timedOut = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const done = (status: WriteResult["status"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(bound);
        clearTimeout(grace);
        signal?.removeEventListener("abort", stop);
        resolve({ status, timedOut });
      };
      const stop = () => {
        if (controller.signal.aborted) return;
        controller.abort();
        grace = setTimeout(() => done("stalled"), this.timeouts.interruptMs);
      };
      const bound = setTimeout(() => {
        timedOut = true;
        stop();
      }, ms);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      let writing: Promise<void>;
      try {
        writing = this.transport.write(textToBytes(text), controller.signal);
      } catch (error) {
        writing = Promise.reject(error);
      }
      writing.then(
        () => done("written"),
        (error: unknown) => done(error instanceof TransportError && error.code === "aborted" && controller.signal.aborted ? "not_sent" : "failed"),
      );
    });
  }

  /** Before a write: replies received while idle are discarded; a partial one is drained to its prompt. */
  private async drainIdle(signal: AbortSignal, resetsAdapter: boolean): Promise<{ outcome: CommandOutcome; detail: string | null; discarded: DiscardedReply[] }> {
    const discarded: DiscardedReply[] = this.idleDiscards.splice(0);
    const stopped = (outcome: CommandOutcome, detail: string) => {
      // Earlier bytes still short of a prompt are kept as provenance, never as this (unsent) command's data.
      if (this.framer.pendingBytes > 0) {
        const text = this.framer.pendingText();
        discarded.push({ reason: "unsolicited_incomplete", text, lines: splitLines(text), overflowed: this.framer.overflowing, byteCount: this.framer.pendingBytes });
      }
      return { outcome, detail, discarded };
    };
    const ended = () => stopped(this.closing ? "interrupted" : (this.failure ?? "adapter_unresponsive"), "the session ended before the command was sent");
    for (;;) {
      for (let event = this.backlog.shift(); event; event = this.backlog.shift()) {
        if (event.type === "overflow") this.requireReset();
        else if (!this.discard(event.response, "unsolicited", discarded)) return ended();
      }
      if (this.failure || this.closing) return ended();
      if (this.framer.pendingBytes === 0) break;
      const wake = await this.wait(this.timeouts.interruptMs, signal, false);
      if (wake.type === "aborted") return stopped("interrupted", "cancelled before it was sent");
      if (wake.type === "closed") {
        if (!this.closing) this.fail("transport_lost");
        return ended();
      }
      if (wake.type === "timeout") {
        this.fail("adapter_unresponsive");
        return stopped("adapter_unresponsive", "earlier bytes never reached a prompt");
      }
      this.backlog.unshift(wake);
    }
    if (this.resetRequired && !resetsAdapter) {
      return { outcome: "adapter_needs_reset", detail: "unsolicited bytes overflowed; reset the adapter", discarded };
    }
    if (signal.aborted) return { outcome: "interrupted", detail: "cancelled before it was sent", discarded };
    return { outcome: "ok", detail: null, discarded };
  }

  /** Whether a reply judged against `check` (unsolicited: as OBD data) reports a power event. */
  private isPowerEvent(response: FramedResponse, check?: AllowedCheck): boolean {
    return classifyResponse(response.lines, check?.kind ?? "obd", check?.printsIdentity ?? false).outcome === "adapter_power_event";
  }

  /**
   * Records a discarded reply; a power event in it ends the session. `check`
   * is the interrupted command's (a late identity line after ATZ is its own
   * answer); unsolicited bytes are judged as OBD data. Returns false when the
   * session ended.
   */
  private discard(response: FramedResponse, reason: DiscardedReply["reason"], into: DiscardedReply[], check?: AllowedCheck): boolean {
    into.push(discardedReply(response, reason));
    if (this.isPowerEvent(response, check)) {
      this.fail("adapter_power_event");
      return false;
    }
    return true;
  }

  /** Idle bytes are handled as they arrive, so a power event is seen at once. */
  private processIdle(): void {
    if (this.active || this.failure || this.closed) return;
    for (let event = this.backlog.shift(); event; event = this.backlog.shift()) {
      if (event.type === "overflow") {
        this.requireReset();
        this.emitStatus();
      } else if (!this.discard(event.response, "unsolicited", this.idleDiscards)) {
        return;
      }
    }
  }

  /**
   * The session is ending: keeps every byte received for the command as
   * provenance, never as data: complete replies still queued (in `received`)
   * and bytes that never reached a prompt (in `incomplete`).
   */
  private captureReceived(result: CommandResult): void {
    for (let event = this.backlog.shift(); event; event = this.backlog.shift()) {
      if (event.type === "overflow") result.raw.truncated = true;
      else recordRaw(result, event.response);
    }
    this.captureIncomplete(result);
  }

  /**
   * The session is ending while synchronising: complete replies still queued
   * arrived after the interrupt's prompt, so they are kept as late replies
   * (none can be taken for the probe's answer); bytes that never reached a
   * prompt go to `incomplete`. An overflowed reply carries its own flag.
   */
  private captureLate(result: CommandResult): void {
    for (let event = this.backlog.shift(); event; event = this.backlog.shift()) {
      if (event.type === "response") result.raw.discardedAfter.push(discardedReply(event.response, "late_reply"));
    }
    this.captureIncomplete(result);
  }

  /** Keeps bytes that never reached a prompt as provenance (never as data). */
  private captureIncomplete(result: CommandResult): void {
    if (this.framer.pendingBytes === 0 || result.raw.incomplete !== null) return;
    result.raw.incomplete = this.framer.pendingText();
    result.raw.byteCount += this.framer.pendingBytes;
    if (this.framer.overflowing) result.raw.truncated = true;
  }

  private wait(ms: number, signal: AbortSignal | undefined, inFlight: boolean): Promise<Wake> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finishWait({ type: "timeout" }), ms);
      const onAbort = () => finishWait({ type: "aborted" });
      const finishWait = (wake: Wake) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = null;
        resolve(wake);
      };
      const check = () => {
        const event = this.backlog.shift();
        if (event) return finishWait(event);
        if (this.transportClosed) return finishWait({ type: "closed" });
        if (inFlight && !this.searching && /SEARCHING\.\.\.[\r\n]/.test(this.framer.pendingText())) {
          this.searching = true;
          this.emitStatus();
        }
      };
      if (signal?.aborted) return finishWait({ type: "aborted" });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = check;
      check();
    });
  }

  private handleData(chunk: Uint8Array): void {
    if (this.closed || this.failure) return;
    this.backlog.push(...this.framer.push(chunk));
    if (this.waiter) this.waiter();
    else this.processIdle();
  }

  private handleClose(): void {
    this.transportClosed = true;
    if (this.waiter) this.waiter();
    else if (!this.closing && !this.active) this.fail("transport_lost");
  }

  private forgetSettings(): void {
    this.echoOff = false;
    this.headersOn = false;
  }

  private requireReset(): void {
    this.forgetSettings();
    this.resetRequired = true;
  }

  private fail(failure: SessionFailure): void {
    if (this.failure || this.closed || this.closing) return;
    this.failure = failure;
    this.forgetSettings();
    this.emitStatus();
    if (!this.transportClosed) void this.transport.close().catch(() => undefined);
  }

  private emitStatus(): void {
    const status = this.status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // A listener's failure never affects the session.
      }
    }
  }
}

function refused(command: string, outcome: CommandOutcome, detail: string | null): CommandResult {
  return {
    command,
    written: false,
    outcome,
    token: null,
    detail,
    lines: [],
    info: [],
    raw: { received: null, lines: [], echoRemoved: false, incomplete: null, truncated: false, byteCount: 0, discardedBefore: [], discardedAfter: [] },
  };
}

function finish(result: CommandResult, outcome: CommandOutcome, detail: string | null): CommandResult {
  result.outcome = outcome;
  result.detail = detail;
  result.lines = [];
  return result;
}

function recordRaw(result: CommandResult, response: FramedResponse): void {
  result.raw.received = (result.raw.received ?? "") + `${response.text}>`;
  result.raw.lines.push(...response.lines);
  result.raw.byteCount += response.byteCount + 1;
  if (response.overflowed) result.raw.truncated = true;
}

function discardedReply(response: FramedResponse, reason: DiscardedReply["reason"]): DiscardedReply {
  return { reason, text: `${response.text}>`, lines: response.lines, overflowed: response.overflowed, byteCount: response.byteCount + 1 };
}
