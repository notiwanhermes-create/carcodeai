"use client";

import type { ReactNode } from "react";
import { lookupCode } from "@/app/lib/dtc";
import type { DtcKind } from "@/app/lib/vehicle-communication/obd/dtc";
import { pidDefinition } from "@/app/lib/vehicle-communication/obd/pids";
import type { CodeEvidence, FreezeFrameEvidence, KindState, ModuleDtcEvidence, PreviewMeasurement } from "@/app/lib/vehicle-communication/evidence/scan-evidence";
import type { CurrentReading, DiscoveryReport, StepRecord } from "@/app/lib/vehicle-communication/scanner/report";
import type { LinkInfo, LiveView, ScanView } from "@/app/scanner/scanner-session";
import { Card, cn, inputClass, SectionTitle } from "@/components/garage/shared";
import { Disclosure, focusRing, mainAction, quietAction } from "@/components/scanner/ConnectionPanels";

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const bytes = (data: readonly number[]) => data.map(hex).join(" ");
const time = (at: string | null) => (at ? new Date(at).toLocaleTimeString() : "not read");

const OUTCOMES: Record<string, string> = {
  ok: "Read",
  no_response: "No response. This does not mean no codes or unsupported",
  unsupported: "Not listed in this ECU's support list, so not requested",
  support_unknown: "Support unknown, so not requested",
  not_read: "Not read in this run",
  negative_response: "Declined by the ECU",
  malformed: "Malformed reply; no data used",
  interrupted: "Interrupted",
  timeout: "No answer in time",
};

export function outcomeText(outcome: string): string {
  return OUTCOMES[outcome] ?? outcome.replace(/_/g, " ");
}

const SECTION_STATE = { done: "Read", interrupted: "Stopped part-way", not_run: "Not run" } as const;
const SECTION_LABEL = { readiness: "Readiness", dtcs: "Fault codes", freeze_frame: "Freeze frame", current_data: "Live data" } as const;

const UNITS: Record<string, string> = { degC: "°C", deg_before_tdc: "° before TDC" };

function formatDecoded(value: number, unit: string): string {
  return `${Number(value.toFixed(2))} ${UNITS[unit] ?? unit}`;
}

export function UnverifiedBadge() {
  return (
    <span data-unverified className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-200">
      <span aria-hidden className="size-1.5 rounded-full bg-amber-300" />
      Pending verification
    </span>
  );
}

/** Beside every decoded section, with its badge (live-data.md, "Primary-source check (pending)"). */
export function UnverifiedNote({ source }: { source: "formulas" | "bit table" | "formulas and bit table" }) {
  return (
    <p data-unverified-note className="text-xs text-slate-400">
      Decoded with public secondary {source}. The check against the licensed SAE J1979 standard is pending, so this is not SAE-verified. For display only.
    </p>
  );
}

/** Which ECU answered. `obd-can11-7e8` style labels are opaque: kept and shown as they are, never parsed. */
export function ModuleLabel({ module, responseId, discovered }: { module: string; responseId?: string; discovered?: boolean }) {
  return (
    <span data-module={module} className="text-xs text-slate-400">
      {responseId ? `Module ${responseId}` : module}
      {discovered === false ? " (answered a request, not discovery)" : ""}
    </span>
  );
}

function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <Disclosure data-technical summary="Technical details" className="mt-4 border-t border-white/10 pt-3">
      <div className="space-y-3 text-xs">{children}</div>
    </Disclosure>
  );
}

function RawBytes({ rawLines, payloads }: { rawLines: readonly string[]; payloads: readonly (readonly number[])[] }) {
  if (rawLines.length === 0 && payloads.length === 0) return <span className="text-slate-500">no raw data</span>;
  return (
    <div data-raw>
      {rawLines.map((line, index) => (
        <code key={`l${index}`} className="block break-all">
          {line}
        </code>
      ))}
      {payloads.map((payload, index) => (
        <code key={`p${index}`} className="block break-all text-slate-500">
          payload: {bytes(payload)}
        </code>
      ))}
    </div>
  );
}

type Reading = { pid: number; label: string; module: string; responseId?: string; discovered?: boolean; value: string; decoded: boolean; at: string | null; rawLines: readonly string[]; payloads: readonly (readonly number[])[] };

function ReadingTiles({ readings, className }: { readings: readonly Reading[]; className?: string }) {
  return (
    <ul className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", className)}>
      {readings.map((reading) => (
        <li key={`${reading.module}:${reading.pid}`} data-reading={hex(reading.pid)} className="flex min-w-0 flex-col rounded-xl bg-white/[0.05] p-3">
          <span className="text-sm text-slate-300">{reading.label}</span>
          <span data-value className={reading.decoded ? "mt-auto pt-2 text-2xl font-semibold tabular-nums tracking-tight text-white" : "mt-auto pt-2 text-sm text-slate-400"}>
            {reading.value}
          </span>
          <ModuleLabel module={reading.module} responseId={reading.responseId} discovered={reading.discovered} />
        </li>
      ))}
    </ul>
  );
}

function ReadingDetails({ readings }: { readings: readonly Reading[] }) {
  return (
    <ul className="space-y-2">
      {readings.map((reading) => (
        <li key={`${reading.module}:${reading.pid}`} data-raw-reading={hex(reading.pid)}>
          <p className="text-slate-300">
            {reading.label}, {reading.module}, read {time(reading.at)}
          </p>
          <RawBytes rawLines={reading.rawLines} payloads={reading.payloads} />
        </li>
      ))}
    </ul>
  );
}

const pidLabel = (pid: number) => pidDefinition(pid)?.quantity ?? `PID ${hex(pid)}`;

function measurementReading(m: PreviewMeasurement): Reading {
  const decoded = m.reading?.status === "decoded";
  const value = m.reading?.status === "decoded" ? formatDecoded(m.reading.value, m.reading.unit) : m.reading?.status === "not_decoded" ? `Not decoded: ${m.reading.reason}` : outcomeText(m.outcome);
  return { pid: m.pid, label: pidLabel(m.pid), module: m.module, responseId: m.responseId, discovered: m.discovered, value, decoded, at: m.readAt, rawLines: m.rawLines, payloads: m.payloads };
}

function currentReading(reading: CurrentReading): Reading {
  const decoded = reading.value?.decoded;
  const value = decoded?.status === "decoded" ? formatDecoded(decoded.value, decoded.unit) : decoded?.status === "not_decoded" ? `Not decoded: ${decoded.reason}` : outcomeText(reading.outcome);
  return { pid: reading.pid, label: pidLabel(reading.pid), module: reading.module, responseId: reading.responseId, value, decoded: decoded?.status === "decoded", at: reading.at, rawLines: reading.rawLines, payloads: reading.payloads };
}

/** Readings that were requested; the ECU did not list the rest, or its list was not known. */
function requested(items: readonly PreviewMeasurement[]) {
  const shown = items.filter((m) => m.outcome !== "unsupported" && m.outcome !== "support_unknown");
  return { readings: shown.map(measurementReading), skipped: items.length - shown.length };
}

function SkippedNote({ count }: { count: number }) {
  if (count === 0) return null;
  return <p>{count} other readings were not requested because the ECU did not list them, or its list was not known.</p>;
}

export function ScanSkeleton() {
  return (
    <div aria-hidden className="grid gap-4 lg:grid-cols-5">
      {["lg:col-span-3", "lg:col-span-2", "lg:col-span-2", "lg:col-span-3"].map((span, index) => (
        <div key={index} className={cn("glass-card space-y-3 rounded-2xl p-5", span)}>
          <div className="h-4 w-1/3 rounded bg-white/10 motion-safe:animate-pulse" />
          <div className="h-16 rounded-xl bg-white/5 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** What this scan's own discovery reported: a later connection never changes it. */
export function VehicleCard({ scan, vehicleName, className }: { scan: ScanView; vehicleName: string | null; className?: string }) {
  const { vehicle, capabilities } = scan.evidence;
  const vin = vehicle.vin.comparison.status === "consistent" ? vehicle.vin.comparison.text : null;
  return (
    <Card className={className}>
      <div data-vehicle-card>
        <SectionTitle>Vehicle</SectionTitle>
        {vehicleName && (
          <div className="mb-2">
            <p className="text-base font-medium text-slate-100">{vehicleName}</p>
            <p className="text-xs text-slate-400">Chosen in your garage, not confirmed by the car.</p>
          </div>
        )}
        {vin && (
          <p data-scan-vin className="mb-3 break-all font-mono text-sm text-slate-300">
            {vin}
          </p>
        )}
        {vehicle.vin.comparison.status === "conflicting" && <p className="mb-3 text-sm text-amber-200">Modules reported different VINs. All are kept; none is picked.</p>}
        <ul className="space-y-2">
          {vehicle.vin.reports.map((report) => (
            <li key={report.module} data-ecu className="rounded-xl bg-white/[0.05] p-3">
              <p className="text-sm font-medium text-white">Module {report.responseId}</p>
              <p className="text-sm text-slate-300">{capabilities.find((entry) => entry.module === report.module)?.currentDataPids.length ?? 0} values listed</p>
              <p className="text-sm text-slate-400">{report.text ? "Reported a VIN" : `VIN: ${outcomeText(report.outcome)}`}</p>
            </li>
          ))}
        </ul>
        <TechnicalDetails>
          {vehicle.vin.reports.map((report) => (
            <div key={report.module}>
              <p className="text-slate-300">{report.module}</p>
              {report.text && (
                <p>
                  Reported VIN {report.text}, read {time(report.readAt)}
                </p>
              )}
              <RawBytes rawLines={report.rawLines} payloads={report.payloads} />
            </div>
          ))}
        </TechnicalDetails>
      </div>
    </Card>
  );
}

export function ScanSummary({ scan, connection }: { scan: ScanView; connection: number }) {
  const { evidence } = scan;
  const finished = evidence.ended === "finished";
  const sections = Object.entries(evidence.sections) as [keyof typeof evidence.sections, keyof typeof SECTION_STATE][];
  const pendingConflict = evidence.conflicts.some((conflict) => PENDING_CONFLICTS.has(conflict.kind));
  return (
    <Card className="lg:col-span-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-white">
          Scan {evidence.scanNumber} {finished ? "complete" : "stopped part-way"}
        </h2>
        <span className="rounded-lg bg-white/10 px-2 py-0.5 text-xs font-medium text-slate-200">Partial scan</span>
      </div>
      {scan.connection !== connection && <p data-earlier-link className="mt-1 text-sm text-amber-200">Read on an earlier connection.</p>}
      <p className="mt-2 max-w-3xl text-sm text-slate-300">Generic OBD-II shows only some modules and codes. Nothing here says that a code is absent or that anything is fine. Nothing here is sent to Guided Diagnostics.</p>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-400">
        {sections.map(([name, state]) => (
          <li key={name} data-section={name}>
            {SECTION_LABEL[name]}: <span className={state === "done" ? "text-slate-200" : "text-amber-200"}>{SECTION_STATE[state]}</span>
          </li>
        ))}
      </ul>
      {evidence.conflicts.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
          <ul data-conflicts className="space-y-2 text-sm text-amber-100">
            {evidence.conflicts.map((conflict, index) => (
              <li key={index} data-conflict={conflict.kind}>
                {PENDING_CONFLICTS.has(conflict.kind) && (
                  <>
                    <UnverifiedBadge />{" "}
                  </>
                )}
                {conflictText(conflict)}
              </li>
            ))}
          </ul>
          {pendingConflict && <UnverifiedNote source="formulas and bit table" />}
        </div>
      )}
    </Card>
  );
}

const KIND_ORDER: readonly DtcKind[] = ["stored", "pending", "permanent"];

const KIND_STYLE: Record<DtcKind, string> = {
  stored: "bg-blue-500/20 text-blue-100",
  pending: "bg-white/10 text-slate-200",
  permanent: "bg-indigo-400/20 text-indigo-100",
};

const KIND_LABEL: Record<DtcKind, string> = { stored: "Stored", pending: "Pending", permanent: "Permanent" };

function kindText(kind: KindState): string {
  if (kind.state === "reported") return "reported";
  return kind.state === "not_listed" ? "not listed" : `unknown (${outcomeText(kind.outcome)})`;
}

function CodeRow({ code }: { code: CodeEvidence }) {
  const { definition } = lookupCode(code.code);
  return (
    <li data-code={code.code} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white/[0.05] p-4">
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-mono text-xl font-semibold tracking-tight text-white">{code.code}</p>
        <p data-code-title className={cn("text-sm", definition ? "text-slate-200" : "text-slate-400")}>
          {definition ?? "No definition on file yet"}
        </p>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {KIND_ORDER.filter((kind) => code.kinds[kind].state === "reported").map((kind) => (
          <li key={kind} data-kind={kind} className={cn("rounded-lg px-2.5 py-1 text-sm font-medium", KIND_STYLE[kind])}>
            {KIND_LABEL[kind]}
          </li>
        ))}
      </ul>
    </li>
  );
}

function ModuleCodes({ module, labelled }: { module: ModuleDtcEvidence; labelled: boolean }) {
  const unread = module.services.filter((service) => service.outcome !== "ok");
  return (
    <div data-dtc-module={module.module}>
      {labelled && (
        <p className="mb-2">
          <ModuleLabel module={module.module} responseId={module.responseId} discovered={module.discovered} />
        </p>
      )}
      {module.codes.length === 0 ? (
        <p className="rounded-xl bg-white/[0.05] p-4 text-sm text-slate-300">No code was listed in these reads. This does not show that none exist.</p>
      ) : (
        <ul className="space-y-2">
          {module.codes.map((code) => (
            <CodeRow key={code.code} code={code} />
          ))}
        </ul>
      )}
      {unread.map((service) => (
        <p key={service.service} data-unread-service={service.service} className="mt-2 text-sm text-amber-200">
          {KIND_LABEL[service.kind]} codes not read: {outcomeText(service.outcome)}.
        </p>
      ))}
    </div>
  );
}

export function FaultCodesCard({ scan, className }: { scan: ScanView; className?: string }) {
  const { modules } = scan.evidence.dtcs;
  const referenced = modules.some((module) => module.codes.some((code) => lookupCode(code.code).trust === "local_reference"));
  return (
    <Card className={className}>
      <SectionTitle>Fault Codes</SectionTitle>
      <div className="space-y-4">
        {modules.map((module) => (
          <ModuleCodes key={module.module} module={module} labelled={modules.length > 1} />
        ))}
      </div>
      {referenced && <p className="mt-3 text-xs text-slate-400">Descriptions come from CarCode&apos;s own short reference list, not licensed SAE data.</p>}
      <TechnicalDetails>
        {modules.map((module) => (
          <div key={module.module} className="space-y-2">
            <p className="text-slate-300">{module.module}</p>
            {module.services.map((service) => (
              <div key={service.service}>
                <p>
                  ${service.service} {service.kind}: {outcomeText(service.outcome)}
                </p>
                {service.raw && <RawBytes rawLines={service.raw.rawLines} payloads={service.raw.payloads} />}
              </div>
            ))}
            {module.codes.map((code) => (
              <p key={code.code} data-code-detail={code.code}>
                {code.code}: {KIND_ORDER.map((kind) => `${kind}: ${kindText(code.kinds[kind])}`).join(", ")}
              </p>
            ))}
          </div>
        ))}
      </TechnicalDetails>
    </Card>
  );
}

const MONITOR_NAMES: Record<string, string> = { egr_vvt_system: "EGR / VVT system", nmhc_catalyst: "NMHC catalyst", nox_scr_monitor: "NOx / SCR monitor", pm_filter: "PM filter", comprehensive_components: "Components" };

function monitorName(id: string): string {
  const name = MONITOR_NAMES[id] ?? id.replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const MONITOR_STATE = {
  complete: { label: "Complete", mark: "bg-cyan-300" },
  incomplete: { label: "Incomplete", mark: "border-2 border-slate-300" },
  not_available: { label: "Not available", mark: "bg-slate-600" },
} as const;

export function ReadinessCard({ scan, className }: { scan: ScanView; className?: string }) {
  const { readiness } = scan.evidence;
  return (
    <Card className={className}>
      <SectionTitle aside={<UnverifiedBadge />}>Readiness</SectionTitle>
      <div className="space-y-4">
        {readiness.map((entry) => (
          <div key={entry.module} data-readiness={entry.module}>
            {readiness.length > 1 && <ModuleLabel module={entry.module} responseId={entry.responseId} discovered={entry.discovered} />}
            {entry.readiness ? (
              <>
                <p className="text-sm text-slate-100">
                  Check engine light reported {entry.readiness.decoded.milOn ? "on" : "off"}, {entry.readiness.decoded.dtcCount} {entry.readiness.decoded.dtcCount === 1 ? "code" : "codes"} in its count
                </p>
                <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-1">
                  {entry.readiness.decoded.monitors.map((monitor) => (
                    <li key={monitor.id} data-monitor={monitor.id} className="flex items-center gap-2 text-sm text-slate-300">
                      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", MONITOR_STATE[monitor.status].mark)} />
                      <span className="min-w-0 flex-1">{monitorName(monitor.id)}</span>
                      <span className="text-slate-400">{MONITOR_STATE[monitor.status].label}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-slate-300">{outcomeText(entry.outcome)}</p>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-1">
        <UnverifiedNote source="bit table" />
        <p className="text-xs text-slate-400">A monitor that is incomplete has not finished its self-test. That is a monitor status, not a fault.</p>
      </div>
      <TechnicalDetails>
        {readiness.map((entry) => (
          <div key={entry.module}>
            <p className="text-slate-300">
              {entry.module}, read {time(entry.readAt)}
            </p>
            <RawBytes rawLines={entry.rawLines} payloads={entry.payloads} />
          </div>
        ))}
      </TechnicalDetails>
    </Card>
  );
}

function FreezeFrame({ frame, labelled }: { frame: FreezeFrameEvidence; labelled: boolean }) {
  const { readings, skipped } = requested(frame.values);
  const storedCode = frame.frame === "stored" && frame.storedDtc.value?.status === "stored" ? frame.storedDtc.value.code : null;
  return (
    <div data-freeze-frame={frame.module}>
      {labelled && <ModuleLabel module={frame.module} responseId={frame.responseId} discovered={frame.discovered} />}
      <p className="mb-2 text-sm text-slate-100">{freezeFrameStatus(frame)}</p>
      {storedCode && lookupCode(storedCode).definition && <p className="-mt-2 mb-2 text-sm text-slate-400">{lookupCode(storedCode).definition}</p>}
      {readings.length > 0 ? <ReadingTiles readings={readings} /> : frame.values.length > 0 && <p className="text-sm text-slate-300">Nothing was read in this section.</p>}
      <TechnicalDetails>
        {frame.frame === "unknown" && frame.support.outcome === "ok" && <RawBytes rawLines={frame.storedDtc.rawLines} payloads={frame.storedDtc.payloads} />}
        <p>The read time is when CarCode read a value, not when the ECU stored it.</p>
        <ReadingDetails readings={readings} />
        <SkippedNote count={skipped} />
      </TechnicalDetails>
    </div>
  );
}

export function FreezeFrameCard({ scan, className }: { scan: ScanView; className?: string }) {
  const { freezeFrames } = scan.evidence;
  return (
    <Card className={className}>
      <SectionTitle aside={<UnverifiedBadge />}>Freeze Frame</SectionTitle>
      <p className="mb-3 text-sm text-slate-400">Values the ECU stored when it set a code, not current values.</p>
      <div className="space-y-4">
        {freezeFrames.map((frame) => (
          <FreezeFrame key={frame.module} frame={frame} labelled={freezeFrames.length > 1} />
        ))}
      </div>
      <div className="mt-4">
        <UnverifiedNote source="formulas" />
      </div>
    </Card>
  );
}

type Evidence = ScanView["evidence"];

/** Conflicts built from pending PID or readiness decoding; the others come from the VIN and the code lists. */
const PENDING_CONFLICTS: ReadonlySet<Evidence["conflicts"][number]["kind"]> = new Set(["dtc_count_mismatch", "mil_status_differs", "current_value_differs"]);

function freezeFrameStatus(frame: Evidence["freezeFrames"][number]): string {
  if (frame.frame === "stored" && frame.storedDtc.value?.status === "stored") return `Stored for ${frame.storedDtc.value.code}`;
  if (frame.frame === "none_stored") return "The ECU reports no stored freeze frame.";
  if (frame.support.outcome !== "ok") return `Not known: ${outcomeText(frame.support.outcome)}`;
  const { outcome, detail } = frame.storedDtc;
  return `Freeze-frame support was read, but the code it was stored for is not known: ${outcomeText(outcome)}${detail ? ` (${detail})` : ""}.`;
}

function conflictText(conflict: Evidence["conflicts"][number]): string {
  switch (conflict.kind) {
    case "vin_differs":
      return `ECUs reported different VINs: ${conflict.reports.map((r) => `${r.module} ${r.text}`).join("; ")}.`;
    case "dtc_count_mismatch":
      return `${conflict.module} counted ${conflict.readinessCount} codes but listed ${conflict.storedCount}.`;
    case "mil_status_differs":
      return `ECUs disagree on the check-engine light: ${conflict.reports.map((r) => `${r.module} ${r.milOn ? "on" : "off"}`).join("; ")}.`;
    case "current_value_differs":
      return `ECUs gave different ${pidLabel(conflict.pid)} values: ${conflict.readings.map((r) => `${r.module} ${formatDecoded(r.value, r.unit)}`).join("; ")}.`;
    case "freeze_frame_code_not_stored":
      return `${conflict.module} stored a freeze frame for ${conflict.code}, which its stored-code read did not list.`;
  }
}

export type PollOption = { module: string; responseId: string; pid: number };

export const pollKey = (entry: { module: string; pid: number }) => `${entry.module}:${entry.pid}`;

function LiveReadings({ live }: { live: LiveView }) {
  const latest = live.cycles.at(-1);
  const readings = latest?.readings.map(currentReading) ?? [];
  return (
    <div data-live className="mt-4">
      <p data-live-status className="text-sm text-slate-400">
        {live.running ? "Updating" : `Stopped: ${live.ended === "finished" ? "all cycles read" : (live.ended ?? "").replace(/_/g, " ")}`}, {live.cycles.length} of {live.cyclesRequested} cycles
        {latest && !latest.complete ? ", the last cycle stopped part-way" : ""}
      </p>
      {readings.length > 0 && (
        <>
          <ReadingTiles readings={readings} className="mt-2 lg:grid-cols-4" />
          <TechnicalDetails>
            <ReadingDetails readings={readings} />
          </TechnicalDetails>
        </>
      )}
    </div>
  );
}

export function LiveDataCard({ connected, scan, live, options, chosen, onToggle, cycles, onCycles, intervalMs, onInterval, maxPids, maxCycles, maxInterval, canStart, running, stopping, onStart, onStop }: {
  connected: boolean;
  scan: ScanView | null;
  live: LiveView | null;
  options: readonly PollOption[];
  chosen: readonly string[];
  onToggle: (key: string, on: boolean) => void;
  cycles: string;
  onCycles: (value: string) => void;
  intervalMs: string;
  onInterval: (value: string) => void;
  maxPids: number;
  maxCycles: number;
  maxInterval: number;
  canStart: boolean;
  running: boolean;
  stopping: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const fromScan = scan ? requested(scan.evidence.currentData) : null;
  const severalModules = new Set(options.map((entry) => entry.module)).size > 1;
  return (
    <Card className="lg:col-span-5">
      <SectionTitle aside={<UnverifiedBadge />}>Live Data</SectionTitle>
      {fromScan && (
        <div>
          <p className="mb-2 text-sm text-slate-400">Each value was read once during this scan.</p>
          <ReadingTiles readings={fromScan.readings} className="lg:grid-cols-6" />
          {fromScan.readings.length === 0 && <p className="text-sm text-slate-300">Nothing was read in this section.</p>}
          <TechnicalDetails>
            <ReadingDetails readings={fromScan.readings} />
            <SkippedNote count={fromScan.skipped} />
          </TechnicalDetails>
        </div>
      )}
      {connected && (
        <div className={fromScan ? "mt-4 border-t border-white/10 pt-4" : undefined}>
          <h3 className="text-base font-medium text-white">Follow values live</h3>
          <p className="mt-0.5 text-sm text-slate-400">Pick up to {maxPids} values. Updates run only after you start them, and stop on Stop, a disconnect, or when you leave or hide this page.</p>
          {options.length === 0 ? (
            <p className="mt-2 text-sm text-slate-300">No ECU listed a value this preview can read.</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {options.map((entry) => (
                <label key={pollKey(entry)} className="relative cursor-pointer">
                  <input type="checkbox" data-poll-option={pollKey(entry)} className="peer sr-only" checked={chosen.includes(pollKey(entry))} onChange={(event) => onToggle(pollKey(entry), event.target.checked)} />
                  <span className="flex min-h-10 items-center rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-200 transition-colors peer-checked:border-cyan-300/50 peer-checked:bg-cyan-300/10 peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-cyan-300">
                    {pidDefinition(entry.pid)?.quantity}
                    {severalModules ? `, module ${entry.responseId}` : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
          <Disclosure summary="Update options" className="mt-3">
            <div className="grid max-w-md gap-3 sm:grid-cols-2">
              <label className="block text-sm text-slate-300">
                Cycles (1 to {maxCycles})
                <input aria-label="Cycles" inputMode="numeric" className={cn(inputClass, "mt-1 min-h-11", focusRing)} value={cycles} onChange={(event) => onCycles(event.target.value)} />
              </label>
              <label className="block text-sm text-slate-300">
                Pause, ms (0 to {maxInterval})
                <input aria-label="Pause between cycles" inputMode="numeric" className={cn(inputClass, "mt-1 min-h-11", focusRing)} value={intervalMs} onChange={(event) => onInterval(event.target.value)} />
              </label>
            </div>
          </Disclosure>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-poll-start className={mainAction} disabled={!canStart} onClick={onStart}>
              Start live updates
            </button>
            {running && (
              <button type="button" data-poll-stop className={quietAction} disabled={stopping} onClick={onStop}>
                Stop
              </button>
            )}
          </div>
        </div>
      )}
      {live && <LiveReadings live={live} />}
      <div className="mt-4">
        <UnverifiedNote source="formulas" />
      </div>
    </Card>
  );
}

/** Raw text as kept, with line endings visible. Stays on this device. */
function visible(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function linkDetails(linkInfo: LinkInfo): string {
  if (linkInfo.kind === "web_bluetooth") {
    return `${linkInfo.deviceName ?? "Unnamed device"}: ${linkInfo.profile.label}, ${linkInfo.profile.provenance === "user_supplied" ? "entered by you" : "community-reported"}, real-adapter validation pending. A matching profile shows only that bytes can move.`;
  }
  return `Serial port at ${linkInfo.settings.baudRate} baud. An open port shows only that bytes can move.`;
}

/** Everything a normal scan does not need: closed by default, last on the page. */
export function AdvancedDiagnostics({ log, total, discovery, linkInfo, evidence }: { log: readonly StepRecord[]; total: number; discovery: DiscoveryReport | null; linkInfo: LinkInfo | null; evidence: Evidence | null }) {
  return (
    <Disclosure data-advanced-diagnostics summary="Advanced diagnostics" className="px-1">
      <div className="space-y-2">
        {(linkInfo || discovery) && (
          <Disclosure summary="Connection details">
            <div className="space-y-1 text-xs">
              {linkInfo && <p data-link-info>{linkDetails(linkInfo)}</p>}
              {discovery && (
                <>
                  <p>Reported by the adapter; this is not proof of what it is: {[...discovery.adapter.ati.lines, ...discovery.adapter.description.lines].join(", ") || "The adapter reported no identity."}</p>
                  <p>{discovery.protocol ? `Protocol ${discovery.protocol.number}${discovery.protocol.supported ? "" : " (not CAN; not read by this preview)"}` : "Protocol not known"}</p>
                  {discovery.ecus.map((ecu) => (
                    <p key={ecu.module} data-module-detail={ecu.module}>
                      {ecu.module}: {ecu.currentData.supportedPids.length} values listed, {ecu.vin.value ? `reported VIN ${ecu.vin.value.text}` : `VIN: ${outcomeText(ecu.vin.outcome)}`}
                    </p>
                  ))}
                  {discovery.rejectedAnswers.length > 0 && <p className="text-amber-200">{discovery.rejectedAnswers.length} answers to the first request could not be used and were left out.</p>}
                </>
              )}
            </div>
          </Disclosure>
        )}
        {total > 0 && (
          <Disclosure data-adapter-log summary={`Adapter communication log (${total} commands${total > log.length ? `, newest ${log.length} shown` : ""})`}>
            <p className="text-xs">Every command sent and the reply as received. It may include your VIN; it stays on this device.</p>
            <ol className="mt-2 space-y-2 text-xs">
              {log.map((step) => (
                <li key={step.seq} data-log-step={step.command}>
                  <div className="text-slate-200">
                    #{step.seq} {step.command}, {outcomeText(step.outcome)}
                    {step.written ? "" : ", not sent"}
                    {step.detail ? `, ${step.detail}` : ""}
                  </div>
                  {step.raw.received !== null && <code className="block break-all">{visible(step.raw.received)}</code>}
                  {step.raw.incomplete !== null && <code className="block break-all text-amber-200">incomplete: {visible(step.raw.incomplete)}</code>}
                  {step.raw.truncated && <span className="text-amber-200">Bytes past the cap were dropped.</span>}
                </li>
              ))}
            </ol>
          </Disclosure>
        )}
        {evidence && (
          <Disclosure data-gd-mapping summary="Why this stays out of Guided Diagnostics">
            <p className="text-xs">{evidence.gd.status === "mapped" ? `A partial scan input covering ${evidence.gd.input.coverage?.modules.length ?? 0} modules could be built. It is shown here only; nothing uses it.` : `No scan input could be built: ${evidence.gd.detail}.`}</p>
            <ul className="mt-1 list-disc pl-4 text-xs">
              {evidence.droppedForMapping.map((item, index) => (
                <li key={index}>
                  {item.what}
                  {item.module ? ` (${item.module})` : ""}: {item.why}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </Disclosure>
  );
}
