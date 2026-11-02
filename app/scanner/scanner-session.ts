/**
 * The `/scanner` page's session: browser chooser → transport → controller →
 * evidence, as one immutable snapshot for React (scan-flow.md, "Lifecycle";
 * carcode-scanner-architecture.md, "Preview acceptance criteria").
 *
 * RESEARCH PROTOTYPE. Client-only and framework-free: no database, no network,
 * no Guided Diagnostics, nothing persisted. Rules:
 *
 * - The choosers are called synchronously from the click, before any await.
 * - One link at a time. A new link starts only after the previous one has been
 *   released, and is a new transport and controller; closed ones never reopen.
 * - Every result is checked against the attempt that started it, so a chooser
 *   or run that settles after `teardown()` changes nothing and opens no link.
 * - Nothing reconnects by itself. A lost link keeps everything already read
 *   and offers `reconnect()`, which a person must press.
 * - Hiding the page cancels the running activity and any attempt still waiting
 *   on a chooser or to open: a chooser answered later starts nothing and is not
 *   kept, so connecting takes a new click. `teardown()` (unmount, navigation,
 *   pagehide) closes the link. A session survives teardown because React's
 *   development remount runs one before the page is ever used.
 */
import { mapScanEvidence, type ScanEvidence } from "@/app/lib/vehicle-communication/evidence/scan-evidence";
import { ScannerController, type LivePollingRequest, type ScannerOptions, type ScannerProgress, type ScannerRefusal } from "@/app/lib/vehicle-communication/scanner/controller";
import type { ActivityKind, DiscoveryReport, LiveCycle, LiveReport, Phase, StepRecord } from "@/app/lib/vehicle-communication/scanner/report";
import { createManualBleProfile, DOCUMENTED_BLE_PROFILES, type BleOverrideInput, type BleProfile } from "@/app/lib/vehicle-communication/transport/ble-profiles";
import type { ByteTransport } from "@/app/lib/vehicle-communication/transport/types";
import { detectWebBluetooth, requestBleAdapter, WebBluetoothTransport, type BleWriteMode, type SelectedBleAdapter } from "@/app/lib/vehicle-communication/transport/web-bluetooth";
import { browserWebBluetoothEnvironment, type WebBluetoothEnvironment } from "@/app/lib/vehicle-communication/transport/web-bluetooth-api";
import { detectWebSerial, requestSerialPort, resolveSerialSettings, WebSerialTransport, type SelectedSerialPort, type SerialSettings } from "@/app/lib/vehicle-communication/transport/web-serial";
import { browserWebSerialEnvironment, type SerialPortInfo, type WebSerialEnvironment } from "@/app/lib/vehicle-communication/transport/web-serial-api";
import type { ScanEndReason, ScannerLifecycleState } from "@/app/lib/vehicle-communication/types";

/** Log entries kept for display; the running total is always shown beside them. */
export const SHOWN_LOG_STEPS = 300;

export type TransportOffer = { status: "checking" } | { status: "available" } | { status: "unavailable"; detail: string };

/** `documented`: every documented profile. Otherwise one profile's id, or `manual`. */
export type BleChoice = { profile: string; showAllDevices: boolean; manual: BleOverrideInput };

export type LinkState = "none" | "choosing" | "connecting" | "open" | "closing" | "ended";

export type LinkInfo =
  | { kind: "web_bluetooth"; deviceName: string | null; profile: BleProfile; writeMode: BleWriteMode; writeChunkBytes: number }
  | { kind: "web_serial"; settings: SerialSettings; port: SerialPortInfo };

export type Notice = { tone: "info" | "error"; text: string };

export type LiveView = { running: boolean; cyclesRequested: number; cycles: readonly LiveCycle[]; ended: ScanEndReason | null; detail: string | null };

export type ScanView = { evidence: ScanEvidence; connection: number };

export type ScannerSnapshot = Readonly<{
  offers: { bluetooth: TransportOffer; serial: TransportOffer };
  link: LinkState;
  transport: LinkInfo["kind"] | null;
  linkInfo: LinkInfo | null;
  canReconnect: boolean;
  lifecycle: ScannerLifecycleState | null;
  activity: ActivityKind | null;
  phase: Phase | null;
  /** A cancellation was asked for and the running command has not ended yet. */
  stopping: boolean;
  needsRecovery: boolean;
  vehicleFound: boolean;
  notice: Notice | null;
  /** Counts links on this page, so a scan from an earlier link can say so. */
  connection: number;
  discovery: DiscoveryReport | null;
  scan: ScanView | null;
  live: LiveView | null;
  /** The newest `SHOWN_LOG_STEPS` commands of the current link. */
  log: readonly StepRecord[];
  logTotal: number;
}>;

const INITIAL: ScannerSnapshot = {
  offers: { bluetooth: { status: "checking" }, serial: { status: "checking" } },
  link: "none",
  transport: null,
  linkInfo: null,
  canReconnect: false,
  lifecycle: null,
  activity: null,
  phase: null,
  stopping: false,
  needsRecovery: false,
  vehicleFound: false,
  notice: null,
  connection: 0,
  discovery: null,
  scan: null,
  live: null,
  log: [],
  logTotal: 0,
};

type Selection = { kind: LinkInfo["kind"]; open: () => { transport: ByteTransport; describe: () => LinkInfo | null } };

export type ScannerSessionOptions = {
  bluetooth?: () => WebBluetoothEnvironment;
  serial?: () => WebSerialEnvironment;
  scanner?: ScannerOptions;
  /** A new id per scan. */
  newScanId?: () => string;
};

const isRefusal = (result: object): result is ScannerRefusal => "status" in result && result.status === "refused";

const ATTEMPT_CANCELLED: Notice = { tone: "info", text: "The connection attempt was cancelled, so nothing was opened. Choose the adapter again." };

function endNotice(what: string, ended: ScanEndReason, detail: string | null): Notice | null {
  const why = detail ? ` (${detail})` : "";
  if (ended === "finished") return null;
  if (ended === "cancelled") return { tone: "info", text: `${what} was cancelled. Everything already read is kept.` };
  if (ended === "transport_lost") return { tone: "error", text: `The link to the adapter was lost during ${what.toLowerCase()}${why}. Everything already read is kept.` };
  if (ended === "adapter_unresponsive") return { tone: "error", text: `The adapter stopped responding during ${what.toLowerCase()}${why}. Everything already read is kept.` };
  return { tone: "error", text: `${what} did not finish${why}. Everything already read is kept.` };
}

export class ScannerSession {
  private snapshot: ScannerSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** Bumped by `teardown()`: anything started before it is stale. */
  private generation = 0;
  /** Bumped by each connection attempt and by `disconnect()`: an attempt still waiting to open checks it. */
  private attempt = 0;
  private controller: ScannerController | null = null;
  private unsubscribe: (() => void) | null = null;
  private selection: Selection | null = null;
  /** The release of the previous link, awaited before the next one opens. */
  private closing: Promise<void> = Promise.resolve();
  private stepsSeen = 0;
  private hiddenCancel = false;
  private readonly bluetooth: () => WebBluetoothEnvironment;
  private readonly serial: () => WebSerialEnvironment;
  private readonly newScanId: () => string;

  constructor(private readonly options: ScannerSessionOptions = {}) {
    this.bluetooth = options.bluetooth ?? browserWebBluetoothEnvironment;
    this.serial = options.serial ?? browserWebSerialEnvironment;
    this.newScanId = options.newScanId ?? (() => `scan-${crypto.randomUUID()}`);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ScannerSnapshot => this.snapshot;

  /** Feature detection only: decides what is offered. Nothing is opened. */
  async detect(): Promise<void> {
    const generation = this.generation;
    const serial = detectWebSerial(this.serial());
    const offers = { ...this.snapshot.offers, serial: serial.available ? ({ status: "available" } as const) : ({ status: "unavailable", detail: serial.detail } as const) };
    this.update({ offers });
    const bluetooth = await detectWebBluetooth(this.bluetooth());
    if (generation !== this.generation) return;
    this.update({ offers: { ...this.snapshot.offers, bluetooth: bluetooth.available ? { status: "available" } : { status: "unavailable", detail: bluetooth.detail } } });
  }

  /** Call directly from the click: the chooser needs the gesture's activation. */
  async connectBluetooth(choice: BleChoice): Promise<void> {
    if (!this.mayConnect()) return;
    const override = resolveBleProfile(choice);
    if (override && "problem" in override) return this.update({ notice: { tone: "error", text: override.problem } });
    const generation = this.generation;
    const attempt = ++this.attempt;
    const previous = this.snapshot.link;
    const request = requestBleAdapter(this.bluetooth(), { override: override?.profile, chooser: choice.showAllDevices ? "all_devices" : "advertised_services" });
    this.update({ link: "choosing", notice: null });
    const result = await request;
    if (generation !== this.generation) return;
    if (attempt !== this.attempt) return this.update({ link: previous, notice: ATTEMPT_CANCELLED });
    if (!result.ok) return this.update({ link: previous, notice: { tone: result.reason === "no_device_chosen" ? "info" : "error", text: `Bluetooth: ${result.detail}.` } });
    this.selection = bleSelection(result.adapter);
    await this.begin(generation);
  }

  /** Call directly from the click: the chooser needs the gesture's activation. */
  async connectSerial(settings: Partial<SerialSettings>): Promise<void> {
    if (!this.mayConnect()) return;
    const resolved = resolveSerialSettings(settings);
    if (!resolved.ok) return this.update({ notice: { tone: "error", text: `Serial settings: ${resolved.detail}.` } });
    const generation = this.generation;
    const attempt = ++this.attempt;
    const previous = this.snapshot.link;
    const request = requestSerialPort(this.serial());
    this.update({ link: "choosing", notice: null });
    const result = await request;
    if (generation !== this.generation) return;
    if (attempt !== this.attempt) return this.update({ link: previous, notice: ATTEMPT_CANCELLED });
    if (!result.ok) return this.update({ link: previous, notice: { tone: result.reason === "no_port_chosen" ? "info" : "error", text: `Serial: ${result.detail}.` } });
    this.selection = serialSelection(result.selection, resolved.settings);
    await this.begin(generation);
  }

  /** The same adapter or port again, over a new transport, without a chooser. */
  async reconnect(): Promise<void> {
    if (!this.mayConnect() || !this.selection) return;
    await this.begin(this.generation);
  }

  async scan(): Promise<void> {
    const { controller, generation } = this;
    if (!controller) return;
    this.update({ notice: null });
    const result = await controller.scan();
    if (generation !== this.generation) return;
    if (isRefusal(result)) return this.refused(controller, result);
    const evidence = mapScanEvidence(result, { scanId: this.newScanId() });
    this.update({ ...this.status(controller), scan: { evidence, connection: this.snapshot.connection }, notice: this.ended("The scan", result.ended, result.endDetail) });
  }

  async startPolling(request: LivePollingRequest): Promise<void> {
    const { controller, generation } = this;
    if (!controller) return;
    const previous = this.snapshot.live;
    this.update({ notice: null, live: { running: true, cyclesRequested: request.cycles, cycles: [], ended: null, detail: null } });
    const result = await controller.startLivePolling(request);
    if (generation !== this.generation) return;
    if (isRefusal(result)) return this.refused(controller, result, { live: previous });
    this.update({ ...this.status(controller), live: finishedLive(result), notice: this.ended("Current-data polling", result.ended, result.endDetail) });
  }

  stopPolling(): void {
    if (this.snapshot.activity !== "live") return;
    this.controller?.stopLivePolling();
    this.update({ stopping: true });
  }

  /** Cancels the running activity. An open or an initialisation that is cancelled ends the link. */
  cancel(): void {
    if (!this.snapshot.activity) return;
    this.controller?.cancel();
    this.update({ stopping: true });
  }

  /** Reset, re-initialise and rediscover on the same link. */
  async recover(): Promise<void> {
    const { controller, generation } = this;
    if (!controller) return;
    this.update({ notice: null });
    const result = await controller.recover();
    if (generation !== this.generation) return;
    if (isRefusal(result)) return this.refused(controller, result);
    this.update({ ...this.status(controller), discovery: result, notice: this.discoveryNotice(result) });
  }

  async disconnect(): Promise<void> {
    this.attempt++;
    const controller = this.controller;
    if (this.snapshot.link === "ended") return;
    if (!controller) return this.update({ link: "none", canReconnect: this.selection !== null });
    this.update({ link: "closing", stopping: Boolean(this.snapshot.activity) });
    this.release(controller);
    await this.closing;
    if (this.controller === controller) this.update({ ...this.status(controller), link: "none", linkInfo: null, canReconnect: this.selection !== null });
  }

  /** The page was hidden: treated as cancel, so no radio session runs or starts in the background. */
  pageHidden(): void {
    const { link, activity } = this.snapshot;
    if (link === "choosing" || (link === "connecting" && !activity)) {
      this.attempt++;
      if (link === "connecting") this.update({ link: "none", canReconnect: this.selection !== null, notice: ATTEMPT_CANCELLED });
      return;
    }
    if (!activity) return;
    this.hiddenCancel = true;
    this.cancel();
  }

  /** Unmount, navigation or pagehide: closes the link and forgets everything read. */
  teardown(): Promise<void> {
    this.generation++;
    const controller = this.controller;
    this.controller = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.selection = null;
    this.hiddenCancel = false;
    this.stepsSeen = 0;
    if (controller) this.waitFor(controller.dispose());
    this.update({ ...INITIAL, offers: this.snapshot.offers });
    return this.closing;
  }

  private mayConnect(): boolean {
    const { link } = this.snapshot;
    return link === "none" || link === "ended";
  }

  private async begin(generation: number): Promise<void> {
    const selection = this.selection as Selection;
    const attempt = ++this.attempt;
    this.update({ link: "connecting", transport: selection.kind, linkInfo: null, canReconnect: false, notice: null });
    await this.closing;
    if (generation !== this.generation || attempt !== this.attempt) return;
    const { transport, describe } = selection.open();
    const controller = new ScannerController(transport, this.options.scanner);
    this.unsubscribe?.();
    this.controller = controller;
    this.unsubscribe = controller.onProgress((event) => this.onProgress(controller, event));
    this.stepsSeen = 0;
    this.update({ ...this.status(controller), connection: this.snapshot.connection + 1, discovery: null, live: null, log: [], logTotal: 0 });
    const result = await controller.connect();
    if (generation !== this.generation || controller !== this.controller) return;
    if (isRefusal(result)) return this.refused(controller, result);
    const opened = this.snapshot.link === "connecting" && controller.state === "ready";
    this.update({
      ...this.status(controller),
      discovery: result,
      ...(opened ? { link: "open" as const, linkInfo: describe() } : {}),
      notice: this.discoveryNotice(result),
    });
  }

  private onProgress(controller: ScannerController, event: ScannerProgress): void {
    if (controller !== this.controller) return;
    const patch: Partial<ScannerSnapshot> = this.status(controller);
    if (event.type === "step") {
      this.stepsSeen++;
      Object.assign(patch, { log: [...this.snapshot.log, event.step].slice(-SHOWN_LOG_STEPS), logTotal: this.stepsSeen });
    } else if (event.type === "step_updated") {
      Object.assign(patch, { log: this.snapshot.log.map((step) => (step.seq === event.step.seq ? event.step : step)) });
    } else if (event.type === "live_cycle" && this.snapshot.live) {
      Object.assign(patch, { live: { ...this.snapshot.live, cycles: [...this.snapshot.live.cycles, event.cycle] } });
    } else if (event.type === "state" && event.state === "failed" && this.snapshot.link !== "closing") {
      Object.assign(patch, { link: "ended", linkInfo: null, canReconnect: this.selection !== null, notice: { tone: "error", text: "The link to the adapter ended. Everything already read is kept." } });
      this.release(controller);
    }
    this.update(patch);
  }

  private release(controller: ScannerController): void {
    this.waitFor(controller.close());
  }

  /** Started at once, so a running command is aborted now; the next link waits for it. */
  private waitFor(release: Promise<void>): void {
    this.closing = Promise.all([this.closing, release.catch(() => undefined)]).then(() => undefined);
  }

  private refused(controller: ScannerController, refusal: ScannerRefusal, extra: Partial<ScannerSnapshot> = {}): void {
    this.update({ ...this.status(controller), ...extra, notice: { tone: "error", text: `Refused: ${refusal.detail}.` } });
  }

  private discoveryNotice(report: DiscoveryReport): Notice | null {
    const ended = this.ended("Connecting", report.ended, report.endDetail);
    if (ended) return ended;
    return report.result.status === "no_vehicle" ? { tone: "error", text: `No vehicle was read: ${report.result.detail}.` } : null;
  }

  private ended(what: string, ended: ScanEndReason, detail: string | null): Notice | null {
    const hidden = this.hiddenCancel && ended === "cancelled";
    this.hiddenCancel = false;
    return hidden ? { tone: "info", text: `${what} was cancelled because the page was hidden. Everything already read is kept.` } : endNotice(what, ended, detail);
  }

  private status(controller: ScannerController): Partial<ScannerSnapshot> {
    const status = controller.status;
    return {
      lifecycle: status.state,
      activity: status.activity,
      phase: status.phase,
      stopping: status.activity ? this.snapshot.stopping : false,
      needsRecovery: status.needsRecovery,
      vehicleFound: status.vehicleFound,
    };
  }

  private update(patch: Partial<ScannerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

function resolveBleProfile(choice: BleChoice): { profile: BleProfile } | { problem: string } | null {
  if (choice.profile === "documented") return null;
  if (choice.profile === "manual") {
    const manual = createManualBleProfile(choice.manual);
    if (manual.ok) return { profile: manual.profile };
    return { problem: manual.reason === "same_as_service" ? `The ${manual.field} UUID may not equal the service UUID.` : `The ${manual.field} UUID is not valid: use 4 or 8 hex digits, or a full 128-bit UUID.` };
  }
  const profile = DOCUMENTED_BLE_PROFILES.find((candidate) => candidate.id === choice.profile);
  return profile ? { profile } : { problem: "Choose a BLE profile." };
}

function bleSelection(adapter: SelectedBleAdapter): Selection {
  return {
    kind: "web_bluetooth",
    open: () => {
      const transport = new WebBluetoothTransport(adapter);
      return {
        transport,
        describe: () => {
          const link = transport.link;
          return link && { kind: "web_bluetooth", deviceName: adapter.device.name ?? null, profile: link.profile, writeMode: link.writeMode, writeChunkBytes: link.writeChunkBytes };
        },
      };
    },
  };
}

function serialSelection(selection: SelectedSerialPort, settings: SerialSettings): Selection {
  return {
    kind: "web_serial",
    open: () => ({
      transport: new WebSerialTransport(selection, { settings }),
      describe: () => ({ kind: "web_serial", settings, port: selection.info }),
    }),
  };
}

function finishedLive(report: LiveReport): LiveView {
  return { running: false, cyclesRequested: report.cyclesRequested, cycles: report.cycles, ended: report.ended, detail: report.endDetail };
}
