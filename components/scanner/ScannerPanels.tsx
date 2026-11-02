"use client";

import type { ReactNode } from "react";
import type { PreviewMeasurement } from "@/app/lib/vehicle-communication/evidence/scan-evidence";
import { pidDefinition } from "@/app/lib/vehicle-communication/obd/pids";
import type { CurrentReading, DiscoveryReport, StepRecord } from "@/app/lib/vehicle-communication/scanner/report";
import type { LiveView, ScanView } from "@/app/scanner/scanner-session";
import { Card, SectionTitle } from "@/components/garage/shared";

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

const UNITS: Record<string, string> = { degC: "°C", deg_before_tdc: "° before TDC" };

function formatDecoded(value: number, unit: string): string {
  return `${Number(value.toFixed(2))} ${UNITS[unit] ?? unit}`;
}

export function UnverifiedBadge() {
  return (
    <span data-unverified className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
      Pending / unverified
    </span>
  );
}

/** Beside every decoded section, with its badge (live-data.md, "Primary-source check (pending)"). */
export function UnverifiedNote({ source }: { source: "formulas" | "bit table" | "formulas and bit table" }) {
  return (
    <p data-unverified-note className="mt-1 text-xs text-amber-200/80">
      Decoded with public secondary {source}. The check against the licensed SAE J1979 standard is pending, so this is not SAE-verified. For display only.
    </p>
  );
}

/** Which ECU answered. `obd-can11-7e8` style labels are opaque: shown, never parsed. */
export function ModuleLabel({ module, responseId, discovered }: { module: string; responseId?: string; discovered?: boolean }) {
  return (
    <span data-module={module} className="text-xs text-slate-400">
      {responseId ? `ECU ${responseId} · ` : ""}
      {module}
      {discovered === false ? " (answered a request, not discovery)" : ""}
    </span>
  );
}

function RawBytes({ rawLines, payloads }: { rawLines: readonly string[]; payloads: readonly (readonly number[])[] }) {
  if (rawLines.length === 0 && payloads.length === 0) return <span className="text-xs text-slate-500">no raw data</span>;
  return (
    <details data-raw className="text-xs text-slate-400">
      <summary className="cursor-pointer">Raw bytes</summary>
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
    </details>
  );
}

function Row({ pid, label, module, value, at, rawLines, payloads }: { pid: number; label: string; module: ReactNode; value: string; at: string | null; rawLines: readonly string[]; payloads: readonly (readonly number[])[] }) {
  return (
    <li data-reading={hex(pid)} className="rounded-xl border border-white/10 bg-white/5 p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-slate-200">{label}</span>
        <span data-value className="text-sm font-semibold text-white">
          {value}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {module}
        <span className="text-xs text-slate-500">read {time(at)}</span>
        <RawBytes rawLines={rawLines} payloads={payloads} />
      </div>
    </li>
  );
}

const pidLabel = (pid: number) => pidDefinition(pid)?.quantity ?? `PID ${hex(pid)}`;

function measurementValue(m: PreviewMeasurement): string {
  if (m.reading?.status === "decoded") return formatDecoded(m.reading.value, m.reading.unit);
  if (m.reading?.status === "not_decoded") return `Not decoded: ${m.reading.reason}`;
  return outcomeText(m.outcome);
}

function currentValue(reading: CurrentReading): string {
  const decoded = reading.value?.decoded;
  if (decoded?.status === "decoded") return formatDecoded(decoded.value, decoded.unit);
  if (decoded?.status === "not_decoded") return `Not decoded: ${decoded.reason}`;
  return outcomeText(reading.outcome);
}

function Measurements({ items }: { items: readonly PreviewMeasurement[] }) {
  const shown = items.filter((m) => m.outcome !== "unsupported" && m.outcome !== "support_unknown");
  const skipped = items.length - shown.length;
  return (
    <>
      <ul className="space-y-2">
        {shown.map((m) => (
          <Row key={`${m.module}:${m.pid}`} pid={m.pid} label={pidLabel(m.pid)} module={<ModuleLabel module={m.module} responseId={m.responseId} discovered={m.discovered} />} value={measurementValue(m)} at={m.readAt} rawLines={m.rawLines} payloads={m.payloads} />
        ))}
      </ul>
      {shown.length === 0 && <p className="text-sm text-slate-300">Nothing was read in this section.</p>}
      {skipped > 0 && <p className="mt-2 text-xs text-slate-500">{skipped} other readings were not requested because the ECU did not list them, or its list was not known.</p>}
    </>
  );
}

export function DiscoverySummary({ discovery }: { discovery: DiscoveryReport }) {
  const { adapter, protocol, ecus } = discovery;
  return (
    <Card>
      <SectionTitle>What answered</SectionTitle>
      <p className="text-xs text-slate-400">Reported by the adapter; this is not proof of what it is.</p>
      <p data-adapter className="mt-1 text-sm text-slate-200">
        {[...adapter.ati.lines, ...adapter.description.lines].join(" · ") || "The adapter reported no identity."}
      </p>
      <p className="mt-1 text-xs text-slate-400">{protocol ? `Protocol ${protocol.number}${protocol.supported ? "" : " (not CAN; not read by this preview)"}` : "Protocol not known"}</p>
      <ul className="mt-2 space-y-1">
        {ecus.map((ecu) => (
          <li key={ecu.module} data-ecu className="text-sm text-slate-200">
            <ModuleLabel module={ecu.module} responseId={ecu.responseId} /> · {ecu.currentData.supportedPids.length} current-data PIDs listed
            {ecu.vin.value ? ` · reported VIN ${ecu.vin.value.text}` : ` · VIN: ${outcomeText(ecu.vin.outcome)}`}
          </li>
        ))}
      </ul>
      {discovery.vinComparison.status === "conflicting" && <p className="mt-2 text-sm text-amber-200">ECUs reported different VINs. All are kept; none is picked.</p>}
      {discovery.rejectedAnswers.length > 0 && <p className="mt-2 text-xs text-amber-200">{discovery.rejectedAnswers.length} answers to the first request could not be used and were left out.</p>}
    </Card>
  );
}

export function ScanResults({ scan, connection }: { scan: ScanView; connection: number }) {
  const { evidence } = scan;
  const summary = Object.entries(evidence.sections) as [keyof typeof evidence.sections, keyof typeof SECTION_STATE][];
  return (
    <>
      <Card>
        <SectionTitle aside={<span className="text-xs text-slate-400">Partial</span>}>Scan {evidence.scanNumber}</SectionTitle>
        {scan.connection !== connection && <p data-earlier-link className="mb-2 text-sm text-amber-200">Read on an earlier connection.</p>}
        <p className="text-xs text-slate-400">
          Generic OBD-II shows only some modules and codes. Nothing here says that a code is absent or that anything is fine. Nothing here is sent to Guided Diagnostics.
        </p>
        <ul className="mt-2 flex flex-wrap gap-2 text-xs text-slate-300">
          {summary.map(([name, state]) => (
            <li key={name} data-section={name}>
              {name.replace(/_/g, " ")}: {SECTION_STATE[state]}
            </li>
          ))}
        </ul>
        {evidence.conflicts.length > 0 && (
          <ul data-conflicts className="mt-2 list-disc pl-4 text-sm text-amber-200">
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
        )}
        {evidence.conflicts.some((conflict) => PENDING_CONFLICTS.has(conflict.kind)) && <UnverifiedNote source="formulas and bit table" />}
      </Card>

      <Card>
        <SectionTitle aside={<span className="text-xs text-slate-400">Partial: absence not established</span>}>Trouble codes</SectionTitle>
        <div className="space-y-3">
          {evidence.dtcs.modules.map((module) => (
            <div key={module.module} data-dtc-module={module.module}>
              <ModuleLabel module={module.module} responseId={module.responseId} discovered={module.discovered} />
              <ul className="mt-1 space-y-1 text-xs text-slate-300">
                {module.services.map((service) => (
                  <li key={service.service} className="flex flex-wrap items-center gap-2">
                    <span>
                      ${service.service} {service.kind}: {outcomeText(service.outcome)}
                    </span>
                    {service.raw && <RawBytes rawLines={service.raw.rawLines} payloads={service.raw.payloads} />}
                  </li>
                ))}
              </ul>
              {module.codes.length === 0 ? (
                <p className="mt-1 text-sm text-slate-300">No code was listed in these reads. This does not show that none exist.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {module.codes.map((code) => (
                    <li key={code.code} data-code={code.code} className="text-sm text-slate-100">
                      <span className="font-semibold">{code.code}</span>{" "}
                      <span className="text-xs text-slate-400">
                        {(["stored", "pending", "permanent"] as const).map((kind) => `${kind}: ${kindText(code.kinds[kind])}`).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle aside={<UnverifiedBadge />}>Readiness</SectionTitle>
        <UnverifiedNote source="bit table" />
        <p className="text-xs text-slate-400">A monitor that is incomplete has not finished its self-test. That is a monitor status, not a fault.</p>
        <div className="mt-2 space-y-3">
          {evidence.readiness.map((entry) => (
            <div key={entry.module} data-readiness={entry.module}>
              <ModuleLabel module={entry.module} responseId={entry.responseId} discovered={entry.discovered} />
              {entry.readiness ? (
                <>
                  <p className="text-sm text-slate-200">
                    Check-engine light reported {entry.readiness.decoded.milOn ? "on" : "off"} · {entry.readiness.decoded.dtcCount} codes reported in the count
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-400">
                    {entry.readiness.decoded.monitors.map((monitor) => (
                      <li key={monitor.id}>
                        {monitor.id.replace(/_/g, " ")}: {monitor.status === "not_available" ? "not available" : monitor.status}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-slate-300">{outcomeText(entry.outcome)}</p>
              )}
              <RawBytes rawLines={entry.rawLines} payloads={entry.payloads} />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle aside={<UnverifiedBadge />}>Freeze frame 0</SectionTitle>
        <UnverifiedNote source="formulas" />
        <p className="text-xs text-slate-400">Values the ECU stored when it set a code, not current values. The read time is when CarCode read them, not when the ECU stored them.</p>
        <div className="mt-2 space-y-3">
          {evidence.freezeFrames.map((frame) => (
            <div key={frame.module} data-freeze-frame={frame.module}>
              <ModuleLabel module={frame.module} responseId={frame.responseId} discovered={frame.discovered} />
              <p className="mb-1 text-sm text-slate-300">{freezeFrameStatus(frame)}</p>
              {frame.frame === "unknown" && frame.support.outcome === "ok" && <RawBytes rawLines={frame.storedDtc.rawLines} payloads={frame.storedDtc.payloads} />}
              {frame.values.length > 0 && <Measurements items={frame.values} />}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle aside={<UnverifiedBadge />}>Current-data readings (OBD $01)</SectionTitle>
        <UnverifiedNote source="formulas" />
        <p className="mb-2 text-xs text-slate-400">Each value was read once, at the time shown.</p>
        <Measurements items={evidence.currentData} />
      </Card>

      <Card>
        <details data-gd-mapping className="text-xs text-slate-400">
          <summary className="cursor-pointer text-sm text-slate-200">Why this stays out of Guided Diagnostics</summary>
          <p className="mt-1">{evidence.gd.status === "mapped" ? `A partial scan input covering ${evidence.gd.input.coverage?.modules.length ?? 0} modules could be built. It is shown here only; nothing uses it.` : `No scan input could be built: ${evidence.gd.detail}.`}</p>
          <ul className="mt-1 list-disc pl-4">
            {evidence.droppedForMapping.map((item, index) => (
              <li key={index}>
                {item.what}
                {item.module ? ` (${item.module})` : ""}: {item.why}
              </li>
            ))}
          </ul>
        </details>
      </Card>
    </>
  );
}

function kindText(kind: { state: "reported" } | { state: "not_listed" } | { state: "unknown"; outcome: string }): string {
  if (kind.state === "reported") return "reported";
  return kind.state === "not_listed" ? "not listed" : `unknown (${outcomeText(kind.outcome)})`;
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

export function LiveReadings({ live }: { live: LiveView }) {
  const latest = live.cycles.at(-1);
  return (
    <div data-live className="mt-3">
      <p data-live-status className="text-xs text-slate-400">
        {live.running ? "Polling" : `Stopped: ${live.ended === "finished" ? "all cycles read" : (live.ended ?? "").replace(/_/g, " ")}`} · {live.cycles.length} of {live.cyclesRequested} cycles
        {latest && !latest.complete ? " · the last cycle stopped part-way" : ""}
      </p>
      {latest && (
        <ul className="mt-2 space-y-2">
          {latest.readings.map((reading) => (
            <Row key={`${reading.module}:${reading.pid}`} pid={reading.pid} label={pidLabel(reading.pid)} module={<ModuleLabel module={reading.module} responseId={reading.responseId} />} value={currentValue(reading)} at={reading.at} rawLines={reading.rawLines} payloads={reading.payloads} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Raw text as kept, with line endings visible. Stays on this device. */
function visible(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function AdapterLog({ log, total }: { log: readonly StepRecord[]; total: number }) {
  return (
    <Card>
      <details data-adapter-log className="text-xs text-slate-400">
        <summary className="cursor-pointer text-sm text-slate-200">
          Adapter log ({total} commands{total > log.length ? `, newest ${log.length} shown` : ""})
        </summary>
        <p className="mt-1">Every command sent and the reply as received. It may include your VIN; it stays on this device.</p>
        <ol className="mt-2 space-y-2">
          {log.map((step) => (
            <li key={step.seq} data-log-step={step.command}>
              <div className="text-slate-200">
                #{step.seq} {step.command} · {outcomeText(step.outcome)}
                {step.written ? "" : " · not sent"}
                {step.detail ? ` · ${step.detail}` : ""}
              </div>
              {step.raw.received !== null && <code className="block break-all">{visible(step.raw.received)}</code>}
              {step.raw.incomplete !== null && <code className="block break-all text-amber-200">incomplete: {visible(step.raw.incomplete)}</code>}
              {step.raw.truncated && <span className="text-amber-200">Bytes past the cap were dropped.</span>}
            </li>
          ))}
        </ol>
      </details>
    </Card>
  );
}
