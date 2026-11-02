/**
 * The simulated transport and a scripted ELM327-style adapter model
 * (vci-transport.md, "Simulated transport").
 *
 * RESEARCH PROTOTYPE, TEST ONLY. The only transport the automated tests use.
 * Its behaviour is SCRIPTED: passing tests against it show the code behaves as
 * designed against scripted adapters, not that any real adapter or vehicle
 * behaves this way.
 *
 * The transport records every write and lets a test push received bytes,
 * disconnect the link, or fail a write. The adapter model, when attached,
 * answers written command lines from a script, with controllable chunking,
 * delays, echo, interruption ("STOPPED") and repeat-on-bare-CR.
 */
import { bytesToText, textToBytes } from "../bytes";
import { TransportError, type ByteTransport, type TransportCloseReason, type TransportState } from "./types";

export type SimulatedTransportOptions = {
  /**
   * Delay before a write is accepted. A write is atomic: a close, disconnect or
   * abort during the delay rejects it and none of its bytes are delivered.
   */
  writeDelayMs?: number;
};

export class SimulatedTransport implements ByteTransport {
  readonly kind = "simulated" as const;
  private currentState: TransportState = "idle";
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: TransportCloseReason) => void>();
  private readonly pendingWrites = new Set<(error: TransportError) => void>();
  private failWrites = 0;
  private failWritesAfterMs: number | null = null;
  private stallWrites = 0;
  private stallIgnoresAbort = false;
  private stallCompletesAfterMs: number | null = null;
  private adapter: ScriptedElmAdapter | null = null;
  /** Every accepted write, decoded one byte per character. */
  readonly writes: string[] = [];

  constructor(private readonly options: SimulatedTransportOptions = {}) {}

  get state(): TransportState {
    return this.currentState;
  }

  /** Total bytes accepted by write(). */
  get bytesWritten(): number {
    return this.writes.reduce((sum, text) => sum + text.length, 0);
  }

  attach(adapter: ScriptedElmAdapter): this {
    this.adapter = adapter;
    adapter.connect(this);
    return this;
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.currentState === "open") throw new TransportError("already_open", "already open");
    if (this.currentState !== "idle") throw new TransportError("closed", "a closed transport cannot be reopened");
    if (signal?.aborted) throw new TransportError("aborted", "aborted");
    this.currentState = "open";
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.currentState !== "open") throw new TransportError("not_open", "not open");
    if (signal?.aborted) throw new TransportError("aborted", "aborted");
    if (this.failWrites > 0) {
      this.failWrites--;
      if (this.failWritesAfterMs) {
        // A delivery-uncertain failure: the link may have sent part of the write, and replies may arrive, before it fails.
        await new Promise<void>((resolve) => setTimeout(resolve, this.failWritesAfterMs ?? 0));
      }
      throw new TransportError("write_failed", "simulated write failure");
    }
    const copy = Uint8Array.from(bytes);
    const stalled = this.stallWrites > 0;
    if (stalled) this.stallWrites--;
    const delayMs = stalled ? this.stallCompletesAfterMs : this.options.writeDelayMs;
    if (stalled || delayMs) {
      const honoursAbort = !(stalled && this.stallIgnoresAbort);
      await new Promise<void>((resolve, reject) => {
        // A stalled write completes only after `completeAfterMs`, if set; otherwise only a close (or an abort, if honoured) ends it.
        const timer = delayMs
          ? setTimeout(() => {
              cleanup();
              resolve();
            }, delayMs)
          : undefined;
        const cancel = (error: TransportError) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => cancel(new TransportError("aborted", "aborted before any byte was sent"));
        const cleanup = () => {
          clearTimeout(timer);
          this.pendingWrites.delete(cancel);
          signal?.removeEventListener("abort", onAbort);
        };
        this.pendingWrites.add(cancel);
        if (honoursAbort) signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (this.currentState !== "open") throw new TransportError("closed", "closed during write");
    }
    this.writes.push(bytesToText(copy));
    this.adapter?.receiveFromHost(copy);
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (reason: TransportCloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.end("closed_by_client");
  }

  /** TEST: bytes arriving from the adapter, delivered as one chunk. Ignored unless open. */
  receive(data: string | Uint8Array): void {
    if (this.currentState !== "open") return;
    const chunk = typeof data === "string" ? textToBytes(data) : Uint8Array.from(data);
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  /** TEST: the link goes away (adapter unplugged, BLE disconnect). */
  disconnect(): void {
    this.end("disconnected");
  }

  /** TEST: the next `count` writes fail, at once or `afterMs` after they start (bytes may arrive meanwhile). */
  failNextWrites(count = 1, options: { afterMs?: number } = {}): void {
    this.failWrites = count;
    this.failWritesAfterMs = options.afterMs ?? null;
  }

  /**
   * TEST: the next `count` writes never complete and deliver nothing. A close
   * rejects them; an abort rejects them `aborted` unless `ignoreAbort` is set
   * (a link that cannot stop a write in progress). With `completeAfterMs` a
   * stalled write instead completes, delivering its bytes, that long after it
   * started (with `ignoreAbort`: even after an abort).
   */
  stallNextWrites(count = 1, options: { ignoreAbort?: boolean; completeAfterMs?: number } = {}): void {
    this.stallWrites = count;
    this.stallIgnoresAbort = options.ignoreAbort === true;
    this.stallCompletesAfterMs = options.completeAfterMs ?? null;
  }

  private end(reason: TransportCloseReason): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    for (const cancel of [...this.pendingWrites]) cancel(new TransportError("closed", "closed during write"));
    this.pendingWrites.clear();
    this.adapter?.stop();
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

/** One scripted reply. */
export type ScriptedReply = {
  /** Reply lines; rendered as lines + CR, an extra CR, then ">". */
  lines?: string[];
  /** Exact bytes to send instead of `lines` (no echo or prompt added). */
  raw?: string;
  /** Delay before the first chunk. */
  delayMs?: number;
  /** Split the reply into chunks of this many bytes (default: one chunk). */
  chunkSize?: number;
  /** Delay between chunks. */
  chunkIntervalMs?: number;
  /** Never answer (until interrupted). */
  silent?: boolean;
};

export type ScriptedElmOptions = {
  /** Replies by exact command text. An array is used in order, the last entry repeating. */
  replies?: Record<string, ScriptedReply | ScriptedReply[]>;
  /** The identity line printed by ATZ / ATWS / ATI. */
  identity?: string;
  /** Line ending the model prints (default "\r", as after ATL0). */
  lineEnding?: string;
  /** What an interrupt produces while a reply is pending: "STOPPED" + prompt (default), or nothing (a hung adapter). */
  onInterrupt?: "stopped" | "ignore";
  /** A bare CR while idle repeats the last command (default true). */
  repeatOnBareCr?: boolean;
};

/**
 * A scripted ELM327-style adapter. Echo starts on; ATE0 turns it off; ATZ and
 * ATWS turn it back on. Unscripted AT commands answer from defaults
 * (setup commands "OK"); any other unscripted command answers "?".
 */
export class ScriptedElmAdapter {
  private transport: SimulatedTransport | null = null;
  private inbound = "";
  private echo = true;
  private lastCommand: string | null = null;
  private busy = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly used = new Map<string, number>();
  /** Every command line the adapter received, in order ("" for a bare CR). */
  readonly received: string[] = [];
  /** Interrupts that arrived while a reply was pending. */
  interrupts = 0;

  constructor(private readonly options: ScriptedElmOptions = {}) {}

  connect(transport: SimulatedTransport): void {
    this.transport = transport;
  }

  get echoOn(): boolean {
    return this.echo;
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.busy = false;
  }

  /** TEST: the adapter prints something on its own (a spontaneous reset, noise). */
  emit(text: string, delayMs = 0): void {
    this.schedule([{ data: text, at: delayMs }], false);
  }

  receiveFromHost(bytes: Uint8Array): void {
    const text = bytesToText(bytes);
    if (this.busy) {
      // Any character interrupts a pending reply; it is consumed, not executed.
      this.interrupts++;
      this.stop();
      if ((this.options.onInterrupt ?? "stopped") === "stopped") this.schedule([{ data: `STOPPED${this.eol}${this.eol}>`, at: 0 }], false);
      else this.busy = true; // a hung adapter stays busy and never prompts
      return;
    }
    this.inbound += text;
    for (let cr = this.inbound.indexOf("\r"); cr >= 0; cr = this.inbound.indexOf("\r")) {
      const line = this.inbound.slice(0, cr);
      this.inbound = this.inbound.slice(cr + 1);
      this.received.push(line);
      this.answer(line);
      if (this.busy) {
        this.inbound = "";
        return;
      }
    }
  }

  private get eol(): string {
    return this.options.lineEnding ?? "\r";
  }

  private answer(line: string): void {
    let command = line;
    if (command === "") {
      if (!(this.options.repeatOnBareCr ?? true) || this.lastCommand === null) return;
      command = this.lastCommand;
    }
    this.lastCommand = command;
    const reply = this.replyFor(command);
    const echoed = this.echo && line !== "" ? `${command}${this.eol}` : "";
    if (command === "ATE0" && reply.lines?.[0] === "OK") this.echo = false;
    if ((command === "ATZ" || command === "ATWS") && !reply.silent) this.echo = true;
    this.busy = true;
    if (reply.silent) return;
    const text = reply.raw ?? `${echoed}${(reply.lines ?? []).map((l) => `${l}${this.eol}`).join("")}${this.eol}>`;
    const size = reply.chunkSize && reply.chunkSize > 0 ? reply.chunkSize : text.length;
    const parts: { data: string; at: number }[] = [];
    for (let i = 0, n = 0; i < text.length; i += size, n++) {
      parts.push({ data: text.slice(i, i + size), at: (reply.delayMs ?? 0) + n * (reply.chunkIntervalMs ?? 0) });
    }
    this.schedule(parts, true);
  }

  private replyFor(command: string): ScriptedReply {
    const scripted = this.options.replies?.[command];
    if (scripted) {
      if (!Array.isArray(scripted)) return scripted;
      const index = this.used.get(command) ?? 0;
      this.used.set(command, index + 1);
      return scripted[Math.min(index, scripted.length - 1)];
    }
    const identity = this.options.identity ?? "ELM327 v1.5";
    switch (command) {
      case "ATZ":
      case "ATWS":
        return { lines: ["", identity] };
      case "ATI":
        return { lines: [identity] };
      case "AT@1":
        return { lines: ["SIMULATED ADAPTER"] };
      case "ATDP":
        return { lines: ["AUTO, ISO 15765-4 (CAN 11/500)"] };
      case "ATDPN":
        return { lines: ["A6"] };
      case "ATRV":
        return { lines: ["12.6V"] };
      case "ATE0":
      case "ATE1":
      case "ATL0":
      case "ATL1":
      case "ATS0":
      case "ATS1":
      case "ATH0":
      case "ATH1":
      case "ATSP0":
        return { lines: ["OK"] };
      default:
        return { lines: ["?"] };
    }
  }

  /** Schedules chunks; when `prompts` is set, the adapter stays busy until the last one is sent. */
  private schedule(parts: { data: string; at: number }[], prompts: boolean): void {
    const transport = this.transport;
    if (!transport) return;
    parts.forEach((part, index) => {
      const timer = setTimeout(() => {
        this.timers = this.timers.filter((t) => t !== timer);
        if (prompts && index === parts.length - 1) this.busy = false;
        transport.receive(part.data);
      }, part.at);
      this.timers.push(timer);
    });
  }
}
