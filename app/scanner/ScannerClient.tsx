"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { scannerBackLink, type ScannerVehicleContext } from "@/app/lib/scanner-preview";
import { pidDefinition } from "@/app/lib/vehicle-communication/obd/pids";
import { MAX_LIVE_CYCLES, MAX_LIVE_INTERVAL_MS, MAX_LIVE_PIDS, type LiveSelection } from "@/app/lib/vehicle-communication/scanner/controller";
import type { DiscoveryReport } from "@/app/lib/vehicle-communication/scanner/report";
import { DOCUMENTED_BLE_PROFILES } from "@/app/lib/vehicle-communication/transport/ble-profiles";
import { WEB_BLUETOOTH_LIMITATIONS } from "@/app/lib/vehicle-communication/transport/web-bluetooth";
import { DEFAULT_SERIAL_SETTINGS, WEB_SERIAL_LIMITATIONS } from "@/app/lib/vehicle-communication/transport/web-serial";
import { AdapterLog, DiscoverySummary, LiveReadings, ModuleLabel, ScanResults, UnverifiedBadge, UnverifiedNote } from "@/components/scanner/ScannerPanels";
import { Card, GaragePage, SectionTitle, inputClass, primaryButton, quietButton } from "@/components/garage/shared";
import { ScannerSession, type ScannerSnapshot, type TransportOffer } from "./scanner-session";

export const PREVIEW_BANNER = "Preview. Generic OBD-II only. Not all modules or codes are visible. Not tested with your adapter or vehicle.";

const PHASE_LABEL: Record<string, string> = {
  open: "Opening the link",
  initialise: "Initialising the adapter",
  identify: "Reading what the adapter reports about itself",
  protocol: "Searching for the vehicle protocol",
  current_data_support: "Reading which data each ECU lists",
  vin: "Reading the reported VIN",
  readiness: "Reading readiness",
  dtcs: "Reading stored, pending and permanent codes",
  freeze_frame: "Reading freeze frame 0",
  current_data: "Reading current data",
  live: "Polling current data",
};

function statusLine(view: ScannerSnapshot): string {
  if (view.stopping) return "Stopping…";
  if (view.link === "choosing") return "Waiting for the browser's chooser. It can only be dismissed in the browser.";
  if (view.link === "closing") return "Closing the link…";
  if (view.phase) return `${PHASE_LABEL[view.phase]}…`;
  if (view.link === "connecting") return "Connecting…";
  if (view.link === "open") return view.vehicleFound ? "Connected. A vehicle answered." : "Connected to the adapter. No vehicle was read.";
  if (view.link === "ended") return "The link has ended.";
  return "Not connected.";
}

function Limitations({ items }: { items: readonly string[] }) {
  return (
    <details className="mt-2 text-xs text-slate-400">
      <summary className="cursor-pointer">Browser and adapter limitations</summary>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function Unavailable({ offer }: { offer: TransportOffer }) {
  if (offer.status === "checking") return <p className="text-sm text-slate-400">Checking this browser…</p>;
  if (offer.status === "unavailable") return <p data-unavailable className="text-sm text-amber-200">Not available here: {offer.detail}.</p>;
  return null;
}

/** The current-data PIDs each ECU's own bitmap lists and the reviewed table can decode. */
function pollable(discovery: DiscoveryReport | null): LiveSelection[] {
  return (discovery?.ecus ?? []).flatMap((ecu) => ecu.currentData.supportedPids.filter((pid) => pidDefinition(pid)).map((pid) => ({ module: ecu.module, pid })));
}

const keyOf = (entry: LiveSelection) => `${entry.module}:${entry.pid}`;

/**
 * The scanner preview. Everything stays in this page's memory: nothing is
 * saved, sent or attached to a diagnosis. Decoded values are shown as
 * pending / unverified, and no conclusion is drawn from anything read.
 */
export default function ScannerClient({ vehicle }: { vehicle: ScannerVehicleContext | null }) {
  const [session] = useState(() => new ScannerSession());
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [profile, setProfile] = useState("documented");
  const [showAllDevices, setShowAllDevices] = useState(false);
  const [manual, setManual] = useState({ service: "", notify: "", write: "" });
  const [baudRate, setBaudRate] = useState(String(DEFAULT_SERIAL_SETTINGS.baudRate));
  const [chosen, setChosen] = useState<string[]>([]);
  const [cycles, setCycles] = useState("10");
  const [intervalMs, setIntervalMs] = useState("1000");

  useEffect(() => {
    void session.detect();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") session.pageHidden();
    };
    const onPageHide = () => void session.teardown();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void session.teardown();
    };
  }, [session]);

  const idle = view.link === "none" || view.link === "ended";
  const ready = view.link === "open" && view.lifecycle === "ready" && !view.activity;
  const canRead = ready && view.vehicleFound && !view.needsRecovery;
  const options = pollable(view.discovery);
  const selection = options.filter((entry) => chosen.includes(keyOf(entry)));
  const vehicleName = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.engine ? ` (${vehicle.engine})` : ""}` : null;

  return (
    <GaragePage title="Connect Scanner" subtitle="Read-only OBD-II preview" back={scannerBackLink(vehicle)}>
      <p data-preview-banner role="note" className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
        {PREVIEW_BANNER}
      </p>

      <Card>
        <SectionTitle>Vehicle</SectionTitle>
        <p data-vehicle-context className="text-sm text-slate-200">
          {vehicleName ?? "No vehicle chosen. You can still connect."}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {vehicleName ? "This is the vehicle you came from. Nothing checks that it is the car the adapter is plugged into. " : ""}
          Nothing read here is saved, sent or attached to a diagnosis. No sign-in is needed.
        </p>
      </Card>

      {view.notice && (
        <p role={view.notice.tone === "error" ? "alert" : "status"} data-notice={view.notice.tone} className={view.notice.tone === "error" ? "rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200" : "rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-slate-200"}>
          {view.notice.text}
        </p>
      )}

      {idle && (
        <>
          <Card>
            <SectionTitle>Bluetooth Low Energy adapter</SectionTitle>
            <Unavailable offer={view.offers.bluetooth} />
            {view.offers.bluetooth.status === "available" && (
              <div className="space-y-3">
                <label className="block text-xs text-slate-300">
                  Adapter profile
                  <select aria-label="Adapter profile" className={`${inputClass} mt-1`} value={profile} onChange={(event) => setProfile(event.target.value)}>
                    <option value="documented">All documented profiles (community-reported, unverified)</option>
                    {DOCUMENTED_BLE_PROFILES.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}: {candidate.reportedFor}
                      </option>
                    ))}
                    <option value="manual">Enter UUIDs manually</option>
                  </select>
                </label>
                {profile === "manual" && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(["service", "notify", "write"] as const).map((field) => (
                      <label key={field} className="block text-xs text-slate-300">
                        {field === "service" ? "Service UUID" : field === "notify" ? "Notify UUID" : "Write UUID"}
                        <input aria-label={`${field} UUID`} className={`${inputClass} mt-1`} value={manual[field]} onChange={(event) => setManual({ ...manual, [field]: event.target.value })} />
                      </label>
                    ))}
                  </div>
                )}
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={showAllDevices} onChange={(event) => setShowAllDevices(event.target.checked)} />
                  Show all nearby devices (use if your adapter is not listed)
                </label>
                <button type="button" data-connect-ble className={primaryButton} onClick={() => void session.connectBluetooth({ profile, showAllDevices, manual })}>
                  Choose Bluetooth adapter
                </button>
              </div>
            )}
            <Limitations items={WEB_BLUETOOTH_LIMITATIONS} />
          </Card>

          <Card>
            <SectionTitle>Paired COM port or USB serial adapter</SectionTitle>
            <Unavailable offer={view.offers.serial} />
            {view.offers.serial.status === "available" && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">Pair a Bluetooth Classic adapter in Windows Bluetooth settings first. Windows then offers it as a COM port in the browser&apos;s list.</p>
                <label className="block text-xs text-slate-300">
                  Baud rate
                  <input aria-label="Baud rate" inputMode="numeric" className={`${inputClass} mt-1`} value={baudRate} onChange={(event) => setBaudRate(event.target.value)} />
                </label>
                <button type="button" data-connect-serial className={primaryButton} onClick={() => void session.connectSerial({ baudRate: Number(baudRate) })}>
                  Choose COM port
                </button>
              </div>
            )}
            <Limitations items={WEB_SERIAL_LIMITATIONS} />
          </Card>
        </>
      )}

      <Card>
        <SectionTitle aside={view.transport && <span className="text-xs text-slate-400">{view.transport === "web_bluetooth" ? "Web Bluetooth" : "Web Serial"}</span>}>Connection</SectionTitle>
        <p data-status aria-live="polite" className="text-sm text-slate-200">
          {statusLine(view)}
        </p>
        {view.linkInfo?.kind === "web_bluetooth" && (
          <p data-link-info className="mt-1 text-xs text-slate-400">
            {view.linkInfo.deviceName ?? "Unnamed device"}: {view.linkInfo.profile.label}, {view.linkInfo.profile.provenance === "user_supplied" ? "entered by you" : "community-reported"}, real-adapter validation pending. A matching profile shows only that bytes can move.
          </p>
        )}
        {view.linkInfo?.kind === "web_serial" && (
          <p data-link-info className="mt-1 text-xs text-slate-400">
            Serial port at {view.linkInfo.settings.baudRate} baud. An open port shows only that bytes can move.
          </p>
        )}
        {view.needsRecovery && <p className="mt-2 text-sm text-amber-200">The adapter must be reset before anything else is read.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" data-scan className={primaryButton} disabled={!canRead} onClick={() => void session.scan()}>
            Read codes and data
          </button>
          {(view.activity === "scan" || view.activity === "discovery") && (
            <button type="button" data-cancel className={quietButton} disabled={view.stopping} onClick={() => session.cancel()}>
              Cancel
            </button>
          )}
          {ready && (
            <button type="button" data-recover className={quietButton} onClick={() => void session.recover()}>
              Reset adapter and search again
            </button>
          )}
          {(view.link === "open" || view.link === "connecting") && (
            <button type="button" data-disconnect className={quietButton} onClick={() => void session.disconnect()}>
              Disconnect
            </button>
          )}
          {idle && view.canReconnect && (
            <button type="button" data-reconnect className={primaryButton} onClick={() => void session.reconnect()}>
              Connect again
            </button>
          )}
        </div>
      </Card>

      {view.discovery && <DiscoverySummary discovery={view.discovery} />}

      {view.vehicleFound && view.discovery && (
        <Card>
          <SectionTitle aside={<UnverifiedBadge />}>Current-data readings (OBD $01): polling</SectionTitle>
          <UnverifiedNote source="formulas" />
          <p className="text-xs text-slate-400">
            Polling runs only when you start it, for the number of cycles you set, one command at a time. It stops on Stop, a disconnect, or when you leave or hide this page. Pick up to {MAX_LIVE_PIDS} PIDs.
          </p>
          {options.length === 0 ? (
            <p className="mt-2 text-sm text-slate-300">No ECU listed a PID this preview can read.</p>
          ) : (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {options.map((entry) => (
                <label key={keyOf(entry)} className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    data-poll-option={keyOf(entry)}
                    checked={chosen.includes(keyOf(entry))}
                    onChange={(event) => setChosen(event.target.checked ? [...chosen, keyOf(entry)] : chosen.filter((key) => key !== keyOf(entry)))}
                  />
                  <span>
                    {pidDefinition(entry.pid)?.quantity} <ModuleLabel module={entry.module} />
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-slate-300">
              Cycles (1 to {MAX_LIVE_CYCLES})
              <input aria-label="Cycles" inputMode="numeric" className={`${inputClass} mt-1`} value={cycles} onChange={(event) => setCycles(event.target.value)} />
            </label>
            <label className="block text-xs text-slate-300">
              Pause between cycles, ms (0 to {MAX_LIVE_INTERVAL_MS})
              <input aria-label="Pause between cycles" inputMode="numeric" className={`${inputClass} mt-1`} value={intervalMs} onChange={(event) => setIntervalMs(event.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-poll-start className={primaryButton} disabled={!canRead || selection.length === 0} onClick={() => void session.startPolling({ selection, cycles: Number(cycles), intervalMs: Number(intervalMs) })}>
              Start polling
            </button>
            {view.activity === "live" && (
              <button type="button" data-poll-stop className={quietButton} disabled={view.stopping} onClick={() => session.stopPolling()}>
                Stop polling
              </button>
            )}
          </div>
          {view.live && <LiveReadings live={view.live} />}
        </Card>
      )}

      {view.scan && <ScanResults scan={view.scan} connection={view.connection} />}

      {view.logTotal > 0 && <AdapterLog log={view.log} total={view.logTotal} />}
    </GaragePage>
  );
}
