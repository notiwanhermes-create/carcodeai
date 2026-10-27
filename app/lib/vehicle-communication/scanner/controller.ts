/**
 * The scanner controller: discovery, one-shot scan, live polling, cancellation
 * and recovery over the elm and OBD layers (module-discovery.md, "Proposed
 * discovery sequence"; scan-flow.md, "Code-read sequence", "Freeze-frame
 * probe", "Lifecycle"; live-data.md, "Live polling").
 *
 * RESEARCH PROTOTYPE. Pure TypeScript over a ByteTransport: no DOM, no
 * database, no network, no Guided Diagnostics. Rules:
 *
 * - One activity at a time (connect / recover, scan, live polling); a second
 *   is refused `busy`, never queued. The executor runs one command at a time.
 * - Every command goes through the executor and its read-only allowlist.
 * - Every ECU's answer to every command is judged on its own and attributed to
 *   its response identifier; one ECU's problem never stops the run. Only a
 *   link-level problem (session failure, adapter needing a reset) or a
 *   cancellation ends a run early, and everything already read is kept.
 * - A PID is requested only when an ECU's own bitmap for that service lists
 *   it, and its answer is used only for those ECUs. $01 bitmaps never imply
 *   $02 support. No answer is `support_unknown` / `no_response`, never
 *   `unsupported` and never "no codes".
 * - Only CAN protocols are read; anything else stops discovery before any
 *   further OBD request.
 * - Live polling runs only when the caller starts it, for supported PIDs, for
 *   a bounded number of cycles; cancel / close / dispose / disconnect end it,
 *   and it never restarts by itself.
 * - Recovery is person-started (`recover()`): re-initialise and rediscover on
 *   the same link. A failed session is not recovered; a new link is needed.
 *   An initialisation that did not complete fails the session (fail closed).
 * - Decoded values and readiness are `Unverified` (primary-source check
 *   pending), display-only. Reports are sealed when their run ends.
 */
import { buildObdCommand, type ObdRequest } from "../elm/command-policy";
import { ElmCommandExecutor, type CommandResult, type ElmExecutorOptions, type ElmStatus } from "../elm/executor";
import { INITIALISATION_SEQUENCE } from "../elm/initialise";
import { mergeDtcReads, readDtcs, type DtcList, type DtcService } from "../obd/dtc";
import type { ProtocolFamily } from "../obd/frames";
import { protocolFromDpn } from "../obd/frames";
import {
  PID_TABLE,
  PID_TABLE_REVIEW,
  pidDefinition,
  readCurrentPid,
  readFreezeFrameDtc,
  readFreezeFramePid,
  type FreezeFrameDtc,
  type FreezeFrameValue,
  type LiveValue,
} from "../obd/pids";
import { compareDtcCounts, READINESS_TABLE_REVIEW, readReadiness, type Readiness } from "../obd/readiness";
import type { EcuIdentity, ServiceRead } from "../obd/response";
import {
  BITMAP_PIDS,
  bitmapChain,
  bitmapSet,
  pidSupport,
  readCurrentDataSupport,
  readFreezeFrameSupport,
  readInfoTypeSupport,
  type SupportedPidBitmap,
} from "../obd/support";
import { compareVins, readVin } from "../obd/vin";
import type { ByteTransport } from "../transport/types";
import { canTransition, type ScanEndReason, type ScannerLifecycleState, type SessionFailure } from "../types";
import {
  SCANNER_VERSION,
  sealed,
  unverifiedPid,
  unverifiedReadiness,
  type ActivityKind,
  type BitmapProblem,
  type CurrentReading,
  type DiscoveredEcu,
  type DiscoveryReport,
  type EcuCapabilities,
  type EcuRead,
  type FreezeFrameEntry,
  type LiveCycle,
  type LiveReport,
  type Phase,
  type ReadinessEntry,
  type ReportedText,
  type ScanReport,
  type StepEcu,
  type StepRecord,
} from "./report";

/**
 * Current-data PIDs read once per scan, where each ECU's own bitmap lists them
 * (engine speed, vehicle speed, coolant, load, short / long-term fuel trims
 * banks 1 and 2, throttle, module voltage).
 */
export const BASIC_CURRENT_PIDS: readonly number[] = Object.freeze([0x0c, 0x0d, 0x05, 0x04, 0x06, 0x07, 0x08, 0x09, 0x11, 0x42]);
/** live-data.md rule 6: at most 8 PIDs per refresh cycle. */
export const MAX_LIVE_PIDS = 8;
export const MAX_LIVE_CYCLES = 1000;
export const MAX_LIVE_INTERVAL_MS = 10000;

const DTC_SERVICES: readonly DtcService[] = ["03", "07", "0A"];

export type ScannerRefusal = {
  status: "refused";
  reason: "busy" | "not_ready" | "no_vehicle" | "needs_recovery" | "session_unavailable" | "invalid_request" | "disposed";
  detail: string;
};

export type ScannerProgress =
  | { type: "state"; state: ScannerLifecycleState; at: string }
  | { type: "phase"; activity: ActivityKind; phase: Phase; at: string }
  | { type: "step"; step: StepRecord }
  /**
   * A record already published as `step` was finalised; it replaces the one
   * with the same `seq`. Only discovery's first `0100`, which is sent before
   * the protocol is known and is read per ECU afterwards.
   */
  | { type: "step_updated"; step: StepRecord }
  | { type: "live_cycle"; cycle: LiveCycle }
  | { type: "activity_ended"; activity: ActivityKind; ended: ScanEndReason; detail: string | null; at: string };

export type ScannerStatus = {
  state: ScannerLifecycleState;
  activity: ActivityKind | null;
  phase: Phase | null;
  /** The adapter must be reset before anything else is read: call `recover()`. */
  needsRecovery: boolean;
  vehicleFound: boolean;
};

export type ScannerOptions = {
  /** Timestamp source (ISO 8601). Supplied by the caller, as in GD. */
  now?: () => string;
  executor?: ElmExecutorOptions;
};

export type LiveSelection = { module: string; pid: number };

export type LivePollingRequest = { selection: LiveSelection[]; cycles: number; intervalMs?: number };

/** Ends a run early. `fatal`: the session cannot go on. */
class Halt extends Error {
  constructor(
    readonly reason: ScanEndReason,
    readonly detail: string,
    readonly fatal = false,
  ) {
    super(detail);
  }
}

type Run = { kind: ActivityKind; abort: AbortController; steps: StepRecord[]; phase: Phase | null; startedAt: string };

const refusal = (reason: ScannerRefusal["reason"], detail: string): ScannerRefusal => ({ status: "refused", reason, detail });

function endFor(failure: SessionFailure): ScanEndReason {
  if (failure === "transport_lost") return "transport_lost";
  if (failure === "adapter_unresponsive") return "adapter_unresponsive";
  return "failed";
}

const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

function stepEcus<T>(read: ServiceRead<T>): StepEcu[] {
  return read.ecus.map((answer) => ({
    responseId: answer.responseId,
    module: answer.module,
    outcome: answer.outcome,
    detail: answer.outcome === "ok" ? null : answer.outcome === "negative_response" ? `negative response code ${hex(answer.code)}` : answer.reason,
    rawLines: answer.rawLines,
    payloads: answer.payloads,
  }));
}

/** One ECU's part of a read, or why it has none. */
function answerOf<T>(read: ServiceRead<T> | undefined, ecu: EcuIdentity): EcuRead<T> {
  const base = { responseId: ecu.responseId, module: ecu.module, rawLines: [] as string[], payloads: [] as number[][] };
  if (!read) return { ...base, outcome: "not_read", detail: "not read in this run" };
  if (read.outcome !== "ok") return { ...base, outcome: read.outcome, detail: read.detail };
  const answer = read.ecus.find((candidate) => candidate.module === ecu.module);
  if (!answer) return { ...base, outcome: "no_response", detail: "this ECU sent nothing while others answered" };
  const evidence = { ...base, rawLines: answer.rawLines, payloads: answer.payloads };
  if (answer.outcome === "ok") return { ...evidence, outcome: "ok", detail: null, value: answer.value };
  if (answer.outcome === "negative_response") return { ...evidence, outcome: "negative_response", detail: `negative response code ${hex(answer.code)}`, code: answer.code };
  return { ...evidence, outcome: "malformed", detail: answer.reason };
}

/** A read that was never sent for this ECU because its own bitmap does not list the PID. */
function notRequested<T>(ecu: EcuIdentity, support: "unsupported" | "support_unknown", what: string): EcuRead<T> {
  return {
    responseId: ecu.responseId,
    module: ecu.module,
    outcome: support,
    detail: `${what} is ${support === "unsupported" ? "not listed" : "not known to be listed"} in this ECU's bitmap; not requested`,
    rawLines: [],
    payloads: [],
  };
}

function mapValue<T, U>(read: EcuRead<T>, wrap: (value: T) => U): EcuRead<U> {
  const { value, ...rest } = read;
  return value === undefined ? (rest as EcuRead<U>) : { ...rest, value: wrap(value) };
}

function identity(ecu: EcuIdentity): EcuIdentity {
  return { responseId: ecu.responseId, module: ecu.module };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type BitmapChainResult = Map<string, { bitmaps: SupportedPidBitmap[]; problems: BitmapProblem[] }>;

export class ScannerController {
  private lifecycle: ScannerLifecycleState = "idle";
  private executor: ElmCommandExecutor | null = null;
  private run: Run | null = null;
  private running: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly listeners = new Set<(progress: ScannerProgress) => void>();
  private readonly sessionLog: StepRecord[] = [];
  private seq = 0;
  private scans = 0;
  private disposed = false;
  private resetNeeded = false;
  private discovered: DiscoveryReport | null = null;
  private readonly now: () => string;

  constructor(
    private readonly transport: ByteTransport,
    private readonly options: ScannerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get state(): ScannerLifecycleState {
    return this.lifecycle;
  }

  get status(): ScannerStatus {
    return {
      state: this.lifecycle,
      activity: this.run?.kind ?? null,
      phase: this.run?.phase ?? null,
      needsRecovery: this.resetNeeded,
      vehicleFound: this.discovered?.result.status === "vehicle_found",
    };
  }

  /** The discovery in effect (sealed), or null. */
  get discovery(): DiscoveryReport | null {
    return this.discovered;
  }

  /** Every command sent through this controller, in order (raw log; a sealed copy). */
  get log(): readonly StepRecord[] {
    return sealed(this.sessionLog);
  }

  onProgress(listener: (progress: ScannerProgress) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Opens the link, initialises the adapter and discovers responding ECUs. */
  async connect(): Promise<DiscoveryReport | ScannerRefusal> {
    const refused = this.refuseStart(["idle"]);
    if (refused) return refused;
    return this.discoveryRun(true);
  }

  /** Person-started recovery on the same link: reset, re-initialise and rediscover. */
  async recover(): Promise<DiscoveryReport | ScannerRefusal> {
    const refused = this.refuseStart(["ready"]);
    if (refused) return refused;
    this.discovered = null;
    return this.discoveryRun(false);
  }

  private async discoveryRun(openLink: boolean): Promise<DiscoveryReport> {
    return this.execute(
      "discovery",
      (run, draft: DiscoveryDraft) => this.discover(run, openLink, draft),
      (run, ended, detail, draft) => this.discoveryReport(run, ended, detail, draft),
      (): DiscoveryDraft => ({
        result: { status: "no_vehicle", reason: "not_completed", outcome: null, detail: "discovery did not finish" },
        adapter: { identity: [], ati: { outcome: "not_read", lines: [] }, description: { outcome: "not_read", lines: [] } },
        protocol: null,
        ecus: [],
        rejectedAnswers: [],
        vinComparison: { status: "none" },
      }),
      (report) => (this.discovered = report),
    );
  }

  /** Readiness, stored / pending / permanent DTCs, freeze frame 0 and basic current data, once. */
  async scan(): Promise<ScanReport | ScannerRefusal> {
    const refused = this.refuseStart(["ready"]) ?? this.refuseWithoutVehicle();
    if (refused) return refused;
    const discovery = this.discovered as DiscoveryReport;
    const scanNumber = ++this.scans;
    return this.execute(
      "scan",
      (run, draft: ScanDraft) => this.scanFlow(run, discovery, draft),
      (run, ended, detail, draft) => this.scanReport(run, ended, detail, discovery, scanNumber, draft),
      () => ({ dtc: {}, ffPids: new Map(), current: new Map(), sections: new Set() }) as ScanDraft,
    );
  }

  /** User-started, bounded, sequential live polling of supported current-data PIDs. */
  async startLivePolling(request: LivePollingRequest): Promise<LiveReport | ScannerRefusal> {
    const refused = this.refuseStart(["ready"]) ?? this.refuseWithoutVehicle();
    if (refused) return refused;
    const discovery = this.discovered as DiscoveryReport;
    const plan = planLive(request, discovery);
    if ("status" in plan) return plan;
    return this.execute(
      "live",
      (run, draft: LiveCycle[]) => this.liveFlow(run, discovery, plan, draft),
      (run, ended, detail, draft) => ({
        kind: "live" as const,
        startedAt: run.startedAt,
        endedAt: this.now(),
        ended,
        endDetail: detail,
        diagnosticUse: "display_only" as const,
        verification: { pidTable: PID_TABLE_REVIEW },
        selection: plan.selection,
        cyclesRequested: plan.cycles,
        cycles: draft,
        steps: run.steps,
      }),
      () => [] as LiveCycle[],
    );
  }

  /** Cancels the running activity (scan, live polling or discovery). No-op when nothing runs. */
  cancel(): void {
    this.run?.abort.abort();
  }

  stopLivePolling(): void {
    if (this.run?.kind === "live") this.cancel();
  }

  /** Ends the session: cancels any run, closes the link. Idempotent. */
  close(): Promise<void> {
    if (this.lifecycle === "closed") return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.run?.abort.abort();
      if (this.lifecycle !== "failed") this.setState("closing");
      if (this.executor) await this.executor.close();
      else await this.transport.close().catch(() => undefined);
      if (this.running) await this.running;
      this.setState("closed");
    })();
    return this.closing;
  }

  /** Unmount: no progress is delivered from now on, and the session is closed. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    return this.close();
  }

  // ---- activity plumbing ----

  private refuseStart(allowed: ScannerLifecycleState[]): ScannerRefusal | null {
    if (this.disposed) return refusal("disposed", "the scanner was disposed");
    if (this.run) return refusal("busy", `${this.run.kind} is running`);
    if (this.lifecycle === "failed" || this.lifecycle === "closing" || this.lifecycle === "closed") {
      return refusal("session_unavailable", `the session is ${this.lifecycle}; a new connection is needed`);
    }
    if (!allowed.includes(this.lifecycle)) return refusal("not_ready", `not allowed while ${this.lifecycle}`);
    return null;
  }

  private refuseWithoutVehicle(): ScannerRefusal | null {
    if (this.resetNeeded) return refusal("needs_recovery", "the adapter must be reset first: recover()");
    if (this.discovered?.result.status !== "vehicle_found") return refusal("no_vehicle", "no vehicle was discovered: check the ignition, then recover()");
    return null;
  }

  private async execute<D, R>(
    kind: ActivityKind,
    body: (run: Run, draft: D) => Promise<void>,
    build: (run: Run, ended: ScanEndReason, detail: string | null, draft: D) => R,
    makeDraft: () => D,
    install: (report: R) => void = () => undefined,
  ): Promise<R> {
    const run: Run = { kind, abort: new AbortController(), steps: [], phase: null, startedAt: this.now() };
    const draft = makeDraft();
    this.run = run;
    let ended: ScanEndReason = "finished";
    let detail: string | null = null;
    let fatal = false;
    const work = body(run, draft).catch((error: unknown) => {
      const halt = error instanceof Halt ? error : new Halt("failed", `internal error: ${error instanceof Error ? error.message : String(error)}`, true);
      ended = halt.reason;
      detail = halt.detail;
      fatal = halt.fatal;
    });
    this.running = work;
    await work;
    const report = sealed(build(run, ended, detail, draft));
    // In effect before `ready` / `activity_ended`, so a listener starting the next activity sees it.
    install(report);
    this.run = null;
    this.running = null;
    await this.settle(fatal);
    this.emit({ type: "activity_ended", activity: kind, ended, detail, at: this.now() });
    return report;
  }

  private async settle(fatal: boolean): Promise<void> {
    if (this.closing || this.lifecycle === "failed") return;
    if (fatal || !this.executor || this.executor.status.failure || this.executor.state === "closed") {
      this.setState("failed");
      await (this.executor ? this.executor.close() : this.transport.close().catch(() => undefined));
      return;
    }
    if (this.lifecycle !== "ready") this.setState("ready");
  }

  private setState(next: ScannerLifecycleState): void {
    if (this.lifecycle === next) return;
    if (this.closing && next !== "closing" && next !== "closed") throw new Halt("cancelled", "the session is closing", true);
    if (!canTransition(this.lifecycle, next)) throw new Halt("failed", `internal: ${this.lifecycle} -> ${next} is not allowed`, true);
    this.lifecycle = next;
    this.emit({ type: "state", state: next, at: this.now() });
  }

  private emit(progress: ScannerProgress): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(progress);
      } catch {
        // A listener's failure never affects the scan.
      }
    }
  }

  private enter(run: Run, phase: Phase): void {
    run.phase = phase;
    this.emit({ type: "phase", activity: run.kind, phase, at: this.now() });
  }

  private onExecutorStatus(status: ElmStatus): void {
    if (!status.failure) return;
    // A lost link ends the running activity at once (even while it waits between cycles).
    if (this.run) this.run.abort.abort();
    else if (!this.closing && this.lifecycle !== "failed" && this.lifecycle !== "closed") void this.settle(true);
  }

  /** Stops the run when the link, the adapter or the caller says so. */
  private guard(run: Run, result?: CommandResult): void {
    const executor = this.executor;
    if (!executor) throw new Halt("failed", "no adapter session", true);
    const status = executor.status;
    if (status.failure) throw new Halt(endFor(status.failure), `the session ended: ${status.failure}`, true);
    if (executor.state === "closed") throw new Halt("cancelled", "the session was closed", true);
    if (run.abort.signal.aborted) throw new Halt("cancelled", "cancelled");
    if (status.state === "needs_reset") {
      this.resetNeeded = true;
      throw new Halt("failed", `${result?.command ?? "the adapter"}: ${result?.outcome ?? "needs_reset"}; the adapter must be reset (recover)`);
    }
    if (result && ["busy", "session_unavailable", "adapter_not_initialised", "adapter_needs_reset", "command_not_allowed"].includes(result.outcome)) {
      throw new Halt("failed", `${result.command} refused: ${result.outcome}`);
    }
  }

  /** Sends one command and records it. The caller finishes the record (`commit`). */
  private async send(run: Run, phase: Phase, command: string, timeout?: "search"): Promise<{ result: CommandResult; step: StepRecord }> {
    const executor = this.executor;
    if (!executor) throw new Halt("failed", "no adapter session", true);
    const startedAt = this.now();
    const result = await executor.run(command, { signal: run.abort.signal, timeout });
    const step: StepRecord = {
      seq: ++this.seq,
      activity: run.kind,
      phase,
      command: result.command,
      startedAt,
      endedAt: this.now(),
      written: result.written,
      outcome: result.outcome,
      token: result.token,
      detail: result.detail,
      perEcu: [],
      raw: result.raw,
    };
    run.steps.push(step);
    this.sessionLog.push(step);
    return { result, step };
  }

  private commit(run: Run, step: StepRecord, result: CommandResult): void {
    this.emit({ type: "step", step: sealed(step) });
    this.guard(run, result);
  }

  private async command(run: Run, phase: Phase, command: string, timeout?: "search"): Promise<CommandResult> {
    const { result, step } = await this.send(run, phase, command, timeout);
    this.commit(run, step, result);
    return result;
  }

  /**
   * Sends one OBD request and reads it per ECU. `keep` stores the read before
   * the run may be stopped, so a read that ended the run (interrupted, lost
   * link, framing error) still shows its outcome; such a read holds no data.
   */
  private async obd<T>(
    run: Run,
    phase: Phase,
    request: ObdRequest,
    read: (result: CommandResult) => ServiceRead<T>,
    keep?: (read: ServiceRead<T>, at: string) => void,
  ): Promise<{ read: ServiceRead<T>; at: string }> {
    const built = buildObdCommand(request);
    if (!built.allowed) throw new Halt("failed", `internal: ${built.reason}`, true);
    const { result, step } = await this.send(run, phase, built.command);
    const parsed = read(result);
    step.perEcu = stepEcus(parsed);
    if (parsed.outcome !== result.outcome) {
      step.outcome = parsed.outcome;
      step.detail = parsed.detail;
    }
    keep?.(parsed, step.endedAt);
    this.commit(run, step, result);
    return { read: parsed, at: step.endedAt };
  }

  // ---- discovery ----

  private async discover(run: Run, openLink: boolean, d: DiscoveryDraft): Promise<void> {
    if (openLink) {
      this.setState("connecting");
      this.enter(run, "open");
      try {
        await this.transport.open(run.abort.signal);
      } catch (error) {
        throw new Halt(run.abort.signal.aborted ? "cancelled" : "transport_lost", `the link did not open: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      this.executor = new ElmCommandExecutor(this.transport, this.options.executor);
      this.executor.onStatus((status) => this.onExecutorStatus(status));
    }
    this.setState("initialising");
    this.enter(run, "initialise");
    for (const command of INITIALISATION_SEQUENCE) {
      const { result, step } = await this.send(run, "initialise", command);
      try {
        this.commit(run, step, result);
      } catch (error) {
        throw error instanceof Halt ? new Halt(error.reason, error.detail, true) : error;
      }
      if (result.outcome !== "ok") {
        d.result = { status: "no_vehicle", reason: "adapter_initialisation_failed", outcome: result.outcome, detail: `${command} answered ${result.outcome}; no OBD request was sent` };
        throw new Halt("failed", `initialisation failed at ${command}: ${result.outcome}`, true);
      }
      if (command === "ATZ") d.adapter.identity = result.lines;
    }
    this.resetNeeded = false;

    this.setState("discovering");
    this.enter(run, "identify");
    for (const [command, key] of [["ATI", "ati"], ["AT@1", "description"]] as const) {
      const result = await this.command(run, "identify", command);
      d.adapter[key] = { outcome: result.outcome, lines: result.outcome === "ok" ? result.lines : [] };
    }

    this.enter(run, "protocol");
    const { result: first, step: firstStep } = await this.send(run, "protocol", "0100", "search");
    this.commit(run, firstStep, first);
    if (first.outcome !== "ok") {
      const reason = first.outcome === "no_response" ? "no_ecu_answered" : first.outcome === "no_vehicle_protocol" || first.outcome === "bus_init_failed" ? "no_vehicle_protocol" : "adapter_error";
      const hint = reason === "no_ecu_answered" ? "; check that the ignition is on" : "";
      d.result = { status: "no_vehicle", reason, outcome: first.outcome, detail: `0100 answered ${first.outcome}${hint}; nothing is concluded about the vehicle` };
      return;
    }
    // The 0100 record was published before the protocol was known; once it is read (or cannot be), it is finalised and published again.
    const finaliseFirst = (outcome: StepRecord["outcome"], detail: string | null, perEcu: StepRecord["perEcu"]) => {
      firstStep.outcome = outcome;
      firstStep.detail = detail;
      firstStep.perEcu = perEcu;
      this.emit({ type: "step_updated", step: sealed(firstStep) });
    };
    const dpn = await this.command(run, "protocol", "ATDPN");
    const protocol = dpn.outcome === "ok" && dpn.lines.length === 1 ? protocolFromDpn(dpn.lines[0]) : null;
    d.protocol = protocol;
    if (!protocol) {
      finaliseFirst(first.outcome, "not read per ECU: the protocol is unknown", []);
      d.result = { status: "no_vehicle", reason: "protocol_unknown", outcome: dpn.outcome, detail: "the adapter did not report a protocol number; no further OBD request" };
      return;
    }
    if (!protocol.supported) {
      finaliseFirst(first.outcome, `not read per ECU: protocol ${protocol.number} is not CAN`, []);
      d.result = { status: "no_vehicle", reason: "unsupported_protocol", outcome: null, detail: `protocol ${protocol.number} is not CAN; the preview reads CAN only, no further OBD request` };
      return;
    }
    const family = protocol.family;
    const support = readCurrentDataSupport(first, family, 0);
    // As obd() does for every other request: the parsed outcome replaces the adapter-level one when they differ.
    finaliseFirst(support.outcome, support.outcome !== first.outcome ? support.detail : first.detail, stepEcus(support));
    if (support.outcome !== "ok") {
      d.result = { status: "no_vehicle", reason: "no_valid_answer", outcome: support.outcome, detail: support.detail ?? "0100 reply had no attributable data" };
      return;
    }
    const answers = support.ecus.map((ecu) => answerOf(support, ecu));
    d.rejectedAnswers = answers.filter((answer) => answer.outcome !== "ok");
    const ecus = answers.filter((answer) => answer.outcome === "ok").map(identity);
    if (ecus.length === 0) {
      d.result = { status: "no_vehicle", reason: "no_valid_answer", outcome: null, detail: "no ECU gave a valid 0100 answer" };
      return;
    }
    d.ecus = ecus.map((ecu) => ({
      ...ecu,
      currentData: { bitmaps: [], supportedPids: [], supportKnownUpTo: null, problems: [] },
      infoTypes: answerOf<SupportedPidBitmap>(undefined, ecu),
      vin: answerOf(undefined, ecu),
    }));

    this.enter(run, "current_data_support");
    // Kept on the draft after every range, so a run stopped mid-chain still reports the ranges already read.
    const chains: BitmapChainResult = new Map();
    const apply = () => {
      for (const ecu of d.ecus) {
        const chain = chains.get(ecu.module);
        if (!chain) continue;
        ecu.currentData = {
          bitmaps: [...chain.bitmaps],
          supportedPids: chain.bitmaps.flatMap((bitmap) => bitmap.supported),
          supportKnownUpTo: bitmapChain(bitmapSet(chain.bitmaps)).supportKnownUpTo,
          problems: [...chain.problems],
        };
      }
    };
    await this.bitmapChain(run, "current_data_support", "01", family, support, ecus, chains, apply);
    d.result = { status: "vehicle_found" };

    this.enter(run, "vin");
    // Both reads are kept on the draft before the run may stop, like the bitmap chain.
    await this.obd(
      run,
      "vin",
      { service: "09", infoType: 0 },
      (result) => readInfoTypeSupport(result, family),
      (read) => {
        for (const ecu of d.ecus) ecu.infoTypes = answerOf(read, ecu);
      },
    );
    const eligible: EcuIdentity[] = [];
    for (const ecu of d.ecus) {
      const listed = ecu.infoTypes.value ? pidSupport(bitmapSet([ecu.infoTypes.value]), 2) : "support_unknown";
      if (listed === "supported") eligible.push(identity(ecu));
      else ecu.vin = notRequested(ecu, listed, "infotype 02 (VIN)");
    }
    if (eligible.length === 0) return;
    await this.obd(
      run,
      "vin",
      { service: "09", infoType: 2 },
      (result) => readVin(result, family),
      (vin) => {
        for (const ecu of d.ecus) if (eligible.some((e) => e.module === ecu.module)) ecu.vin = answerOf(vin, ecu);
        d.vinComparison = compareVins({ ...vin, ecus: vin.ecus.filter((answer) => eligible.some((e) => e.module === answer.module)) });
      },
    );
  }

  /**
   * Follows each ECU's own bitmap chain from its `00` answer (module-discovery.md
   * step 4). A range is requested once, if any ECU's chain needs it, and its
   * answers are used only for those ECUs. An ECU that stops answering keeps
   * the ranges it gave; later ranges stay `support_unknown`. Results go into
   * the caller's `chains` (draft-owned) as each read is parsed, before the run
   * may be stopped, so a cancelled or lost run keeps every range already read
   * and records the stopping read as a problem.
   */
  private async bitmapChain(
    run: Run,
    phase: Phase,
    service: "01" | "02",
    family: ProtocolFamily,
    first: ServiceRead<SupportedPidBitmap>,
    ecus: readonly EcuIdentity[],
    chains: BitmapChainResult,
    changed: () => void = () => undefined,
  ): Promise<void> {
    for (const ecu of ecus) chains.set(ecu.module, { bitmaps: [], problems: [] });
    const absorb = (read: ServiceRead<SupportedPidBitmap>, needing: readonly EcuIdentity[]) => {
      for (const ecu of needing) {
        const chain = chains.get(ecu.module);
        const answer = answerOf(read, ecu);
        if (!chain) continue;
        if (answer.value) chain.bitmaps.push(answer.value);
        else chain.problems.push({ command: read.command, outcome: answer.outcome as BitmapProblem["outcome"], detail: answer.detail });
      }
      changed();
    };
    absorb(first, ecus);
    for (const base of BITMAP_PIDS.slice(1)) {
      const needing = ecus.filter((ecu) => bitmapChain(bitmapSet(chains.get(ecu.module)?.bitmaps ?? [])).next === base);
      if (needing.length === 0) break;
      const request: ObdRequest = service === "01" ? { service, pid: base } : { service, pid: base, frame: 0 };
      await this.obd(
        run,
        phase,
        request,
        (result) => (service === "01" ? readCurrentDataSupport(result, family, base) : readFreezeFrameSupport(result, family, base)),
        (read) => absorb(read, needing),
      );
    }
  }

  private discoveryReport(run: Run, ended: ScanEndReason, detail: string | null, draft: DiscoveryDraft): DiscoveryReport {
    return {
      kind: "discovery",
      scannerVersion: SCANNER_VERSION,
      transport: this.transport.kind,
      startedAt: run.startedAt,
      endedAt: this.now(),
      ended,
      endDetail: detail,
      result: draft.result,
      adapter: draft.adapter,
      protocol: draft.protocol,
      ecus: draft.ecus,
      rejectedAnswers: draft.rejectedAnswers,
      vinComparison: draft.vinComparison,
      steps: run.steps,
    };
  }

  // ---- scan ----

  private async scanFlow(run: Run, discovery: DiscoveryReport, draft: ScanDraft): Promise<void> {
    this.setState("scanning");
    const family = (discovery.protocol as { family: ProtocolFamily }).family;
    const ecus = discovery.ecus;
    const currentSet = new Map(ecus.map((ecu) => [ecu.module, bitmapSet(ecu.currentData.bitmaps)]));
    const supporting = (pid: number, sets: Map<string, ReturnType<typeof bitmapSet>>, among: readonly EcuIdentity[] = ecus) =>
      among.filter((ecu) => pidSupport(sets.get(ecu.module) ?? bitmapSet([]), pid) === "supported");

    draft.sections.add("readiness");
    this.enter(run, "readiness");
    if (supporting(0x01, currentSet).length > 0) {
      await this.obd(run, "readiness", { service: "01", pid: 0x01 }, (result) => readReadiness(result, family), (read) => (draft.readiness = read));
    }
    draft.done = "readiness";

    draft.sections.add("dtcs");
    this.enter(run, "dtcs");
    for (const service of DTC_SERVICES) {
      await this.obd(run, "dtcs", { service }, (result) => readDtcs(result, family, service), (read) => (draft.dtc[service] = read));
    }
    draft.done = "dtcs";

    draft.sections.add("freeze_frame");
    this.enter(run, "freeze_frame");
    const { read: ffFirst } = await this.obd(
      run,
      "freeze_frame",
      { service: "02", pid: 0x00, frame: 0 },
      (result) => readFreezeFrameSupport(result, family, 0),
      (read) => (draft.ffFirst = read),
    );
    const withBitmap = ecus.filter((ecu) => answerOf(ffFirst, ecu).outcome === "ok");
    draft.ffChains = new Map();
    await this.bitmapChain(run, "freeze_frame", "02", family, ffFirst, withBitmap, draft.ffChains);
    const ffSets = new Map([...draft.ffChains].map(([module, chain]) => [module, bitmapSet(chain.bitmaps)]));
    const dtcEligible = supporting(0x02, ffSets, withBitmap);
    if (dtcEligible.length > 0) {
      await this.obd(run, "freeze_frame", { service: "02", pid: 0x02, frame: 0 }, (result) => readFreezeFrameDtc(result, family), (read) => (draft.ffDtc = read));
    }
    // Only an ECU whose own $02 bitmap lists PID 02 is steered by its 020200 answer; any other answer stays in the step log only.
    const noneStored = (ecu: EcuIdentity) => dtcEligible.some((e) => e.module === ecu.module) && answerOf(draft.ffDtc, ecu).value?.status === "none_stored";
    const reading = withBitmap.filter((ecu) => !noneStored(ecu));
    for (const { pid } of PID_TABLE) {
      if (supporting(pid, ffSets, reading).length === 0) continue;
      await this.obd(run, "freeze_frame", { service: "02", pid, frame: 0 }, (result) => readFreezeFramePid(result, family, pid), (read, at) => draft.ffPids.set(pid, { read, at }));
    }
    draft.done = "freeze_frame";

    draft.sections.add("current_data");
    this.enter(run, "current_data");
    for (const pid of BASIC_CURRENT_PIDS) {
      if (supporting(pid, currentSet).length === 0) continue;
      await this.obd(run, "current_data", { service: "01", pid }, (result) => readCurrentPid(result, family, pid), (read, at) => draft.current.set(pid, { read, at }));
    }
    draft.done = "current_data";
  }

  private scanReport(run: Run, ended: ScanEndReason, detail: string | null, discovery: DiscoveryReport, scanNumber: number, draft: ScanDraft): ScanReport {
    const ecus = discovery.ecus;
    const order = ["readiness", "dtcs", "freeze_frame", "current_data"] as const;
    const doneIndex = draft.done ? order.indexOf(draft.done) : -1;
    const sections = Object.fromEntries(
      order.map((name, index) => [name, index <= doneIndex ? "done" : draft.sections.has(name) ? "interrupted" : "not_run"]),
    ) as ScanReport["sections"];
    const currentSet = (ecu: DiscoveredEcu) => bitmapSet(ecu.currentData.bitmaps);

    const readiness: ReadinessEntry[] = ecus.map((ecu) => {
      const support = pidSupport(currentSet(ecu), 0x01);
      if (support !== "supported") return notRequested(ecu, support, "PID 01 (readiness)");
      return mapValue(answerOf<Readiness>(draft.readiness, ecu), unverifiedReadiness);
    });

    const merged = mergeDtcReads(draft.dtc, ecus.map(identity));
    const servicesOkForEveryEcu = DTC_SERVICES.filter((service) => merged.every((ecu) => ecu.outcomes[service] === "ok") && merged.length > 0);
    // Only ECUs whose own bitmap lists PID 01 are compared; another ECU's answer to the functional 0101 stays in the step log only.
    const listsReadiness = (module: string) => ecus.some((ecu) => ecu.module === module && pidSupport(currentSet(ecu), 0x01) === "supported");
    const readinessForCounts = draft.readiness && { ...draft.readiness, ecus: draft.readiness.ecus.filter((answer) => listsReadiness(answer.module)) };
    const countChecks = readinessForCounts && draft.dtc["03"] ? compareDtcCounts(readinessForCounts, draft.dtc["03"]) : [];

    const freezeFrames: FreezeFrameEntry[] = ecus.map((ecu) => {
      const chain = draft.ffChains?.get(ecu.module);
      const first = answerOf(draft.ffFirst, ecu);
      const support = mapValue(first, (bitmap) => (chain ? chain.bitmaps : [bitmap]));
      const supportProblems = chain ? chain.problems : [];
      if (!chain || chain.bitmaps.length === 0) {
        return { ...identity(ecu), support, supportProblems, storedDtc: answerOf<FreezeFrameDtc>(undefined, ecu), frame: "unknown", values: [] };
      }
      const set = bitmapSet(chain.bitmaps);
      const dtcSupport = pidSupport(set, 0x02);
      const storedDtc = dtcSupport === "supported" ? answerOf(draft.ffDtc, ecu) : notRequested<FreezeFrameDtc>(ecu, dtcSupport, "freeze-frame PID 02");
      const frame = storedDtc.value ? (storedDtc.value.status === "stored" ? "stored" : "none_stored") : "unknown";
      const values =
        frame === "none_stored"
          ? []
          : PID_TABLE.map(({ pid }) => {
              const status = pidSupport(set, pid);
              const taken = status === "supported" ? draft.ffPids.get(pid) : undefined;
              const read: EcuRead<FreezeFrameValue> = status === "supported" ? answerOf(taken?.read, ecu) : notRequested(ecu, status, `freeze-frame PID ${hex(pid)}`);
              return { ...mapValue(read, unverifiedPid), pid, readAt: taken?.at ?? null };
            });
      return { ...identity(ecu), support, supportProblems, storedDtc, frame, values };
    });

    const currentData: CurrentReading[] = ecus.flatMap((ecu) =>
      BASIC_CURRENT_PIDS.map((pid) => {
        const status = pidSupport(currentSet(ecu), pid);
        const taken = draft.current.get(pid);
        const read: EcuRead<LiveValue> = status === "supported" ? answerOf(taken?.read, ecu) : notRequested(ecu, status, `PID ${hex(pid)}`);
        return { ...mapValue(read, unverifiedPid), pid, at: taken?.at ?? run.startedAt };
      }),
    );

    const capabilities: EcuCapabilities[] = ecus.map((ecu) => {
      const ff = freezeFrames.find((entry) => entry.module === ecu.module);
      const dtcs = merged.find((entry) => entry.module === ecu.module);
      const outcome = ff?.support.outcome;
      return {
        ...identity(ecu),
        currentDataPids: ecu.currentData.supportedPids,
        currentDataSupportKnownUpTo: ecu.currentData.supportKnownUpTo,
        readiness: pidSupport(currentSet(ecu), 0x01),
        vin: ecu.infoTypes.value ? pidSupport(bitmapSet([ecu.infoTypes.value]), 2) : "support_unknown",
        freezeFrame: outcome === "ok" ? "bitmap_read" : outcome === "negative_response" ? "declined" : outcome === "not_read" ? "not_read" : "support_unknown",
        dtcServices: dtcs?.outcomes ?? { "03": "not_read", "07": "not_read", "0A": "not_read" },
      };
    });

    return {
      kind: "scan",
      scannerVersion: SCANNER_VERSION,
      scanNumber,
      startedAt: run.startedAt,
      endedAt: this.now(),
      ended,
      endDetail: detail,
      completeness: "partial",
      diagnosticUse: "display_only",
      verification: { pidTable: PID_TABLE_REVIEW, readinessTable: READINESS_TABLE_REVIEW },
      discovery,
      sections,
      readiness,
      dtcs: { ecus: merged, servicesOkForEveryEcu, countChecks },
      freezeFrames,
      currentData,
      capabilities,
      steps: run.steps,
    };
  }

  // ---- live polling ----

  private async liveFlow(run: Run, discovery: DiscoveryReport, plan: LivePlan, cycles: LiveCycle[]): Promise<void> {
    this.setState("polling");
    this.enter(run, "live");
    const family = (discovery.protocol as { family: ProtocolFamily }).family;
    const pids = [...new Set(plan.selection.map((entry) => entry.pid))];
    for (let cycle = 1; cycle <= plan.cycles; cycle++) {
      // On the report from its start: a cycle stopped part-way keeps its readings and the stopping read's outcome.
      const current: LiveCycle = { cycle, startedAt: this.now(), complete: false, readings: [] };
      cycles.push(current);
      for (const pid of pids) {
        await this.obd(
          run,
          "live",
          { service: "01", pid },
          (result) => readCurrentPid(result, family, pid),
          (read, at) => {
            for (const entry of plan.selection.filter((selected) => selected.pid === pid)) {
              current.readings.push({ ...mapValue(answerOf(read, entry), unverifiedPid), pid, at });
            }
          },
        );
      }
      current.complete = true;
      this.emit({ type: "live_cycle", cycle: sealed(current) });
      if (cycle < plan.cycles) {
        await pause(plan.intervalMs, run.abort.signal);
        this.guard(run);
      }
    }
  }
}

type DiscoveryDraft = {
  result: DiscoveryReport["result"];
  adapter: { identity: string[]; ati: ReportedText; description: ReportedText };
  protocol: DiscoveryReport["protocol"];
  ecus: DiscoveredEcu[];
  rejectedAnswers: DiscoveryReport["rejectedAnswers"];
  vinComparison: DiscoveryReport["vinComparison"];
};

type ScanSection = "readiness" | "dtcs" | "freeze_frame" | "current_data";

type ScanDraft = {
  sections: Set<ScanSection>;
  done?: ScanSection;
  readiness?: ServiceRead<Readiness>;
  dtc: Partial<Record<DtcService, ServiceRead<DtcList>>>;
  ffFirst?: ServiceRead<SupportedPidBitmap>;
  ffChains?: BitmapChainResult;
  ffDtc?: ServiceRead<FreezeFrameDtc>;
  ffPids: Map<number, { read: ServiceRead<FreezeFrameValue>; at: string }>;
  current: Map<number, { read: ServiceRead<LiveValue>; at: string }>;
};

type LivePlan = { selection: Array<EcuIdentity & { pid: number }>; cycles: number; intervalMs: number };

/** Validates a live-polling request against the discovery; anything not provably supported is refused before sending. */
function planLive(request: LivePollingRequest, discovery: DiscoveryReport): LivePlan | ScannerRefusal {
  const problems: string[] = [];
  const { selection, cycles } = request ?? ({} as LivePollingRequest);
  const intervalMs = request?.intervalMs ?? 0;
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > MAX_LIVE_CYCLES) problems.push(`cycles must be an integer 1-${MAX_LIVE_CYCLES}`);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > MAX_LIVE_INTERVAL_MS) problems.push(`intervalMs must be an integer 0-${MAX_LIVE_INTERVAL_MS}`);
  if (!Array.isArray(selection) || selection.length === 0) problems.push("select at least one PID");
  const planned: LivePlan["selection"] = [];
  for (const entry of Array.isArray(selection) ? selection : []) {
    const ecu = discovery.ecus.find((candidate) => candidate.module === entry?.module);
    const pid = entry?.pid;
    if (!ecu) {
      problems.push(`${String(entry?.module)} is not a discovered ECU`);
      continue;
    }
    if (typeof pid !== "number" || !pidDefinition(pid)) {
      problems.push(`PID ${String(pid)} is not in the reviewed table`);
      continue;
    }
    const support = pidSupport(bitmapSet(ecu.currentData.bitmaps), pid);
    if (support !== "supported") {
      problems.push(`PID ${hex(pid)} is ${support} for ${ecu.module}`);
      continue;
    }
    if (planned.some((p) => p.module === ecu.module && p.pid === pid)) {
      problems.push(`PID ${hex(pid)} for ${ecu.module} is selected twice`);
      continue;
    }
    planned.push({ ...identity(ecu), pid });
  }
  if (new Set(planned.map((p) => p.pid)).size > MAX_LIVE_PIDS) problems.push(`at most ${MAX_LIVE_PIDS} PIDs per cycle`);
  if (problems.length > 0) return refusal("invalid_request", problems.join("; "));
  return { selection: planned, cycles, intervalMs };
}
