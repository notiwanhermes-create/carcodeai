"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { scannerBackLink, type ScannerVehicleContext } from "@/app/lib/scanner-preview";
import { identifyVehicle, type VehicleIdentity } from "@/app/lib/scanner-vin";
import { pidDefinition } from "@/app/lib/vehicle-communication/obd/pids";
import { MAX_LIVE_CYCLES, MAX_LIVE_INTERVAL_MS, MAX_LIVE_PIDS } from "@/app/lib/vehicle-communication/scanner/controller";
import type { DiscoveryReport } from "@/app/lib/vehicle-communication/scanner/report";
import { DEFAULT_SERIAL_SETTINGS } from "@/app/lib/vehicle-communication/transport/web-serial";
import { cn } from "@/components/garage/shared";
import { AdvancedConnection, ConnectedSummary, type GarageVehicle, ConnectOptions, Disclosure, FailurePanel, focusRing, mainAction, NoticeBanner, ProgressSteps, quietAction, type ManualUuids } from "@/components/scanner/ConnectionPanels";
import { ConnectorGraphic } from "@/components/scanner/ConnectorGraphic";
import { ShieldIcon } from "@/components/scanner/ScannerIcons";
import { AdvancedDiagnostics, FaultCodesCard, FreezeFrameCard, LiveDataCard, pollKey, ReadinessCard, ScanSkeleton, ScanSummary, VehicleCard, type PollOption } from "@/components/scanner/ScannerPanels";
import { ScannerSession, type LinkInfo, type ScannerSnapshot } from "./scanner-session";
import { connectionSteps, describeNotice, pinsFor, scanSteps, stageOf, type Stage } from "./scanner-view";

export const PREVIEW_BANNER = "Preview. Generic OBD-II only. Not all modules or codes are visible. Not tested with your adapter or vehicle.";

const PHASE_LABEL: Record<string, string> = {
  open: "Opening the connection",
  initialise: "Setting up the adapter",
  identify: "Asking the adapter what it is",
  protocol: "Looking for the vehicle",
  current_data_support: "Checking what each module can report",
  vin: "Reading the VIN",
  readiness: "Reading readiness",
  dtcs: "Reading stored, pending and permanent codes",
  freeze_frame: "Reading the freeze frame",
  current_data: "Reading current data",
  live: "Updating current data",
};

function statusLine(view: ScannerSnapshot): string {
  if (view.stopping) return "Stopping…";
  if (view.link === "choosing") return "Waiting for you to choose an adapter in the browser window.";
  if (view.link === "closing") return "Closing the connection…";
  if (view.phase) return `${PHASE_LABEL[view.phase]}…`;
  if (view.link === "connecting") return "Connecting…";
  if (view.link === "open") return view.vehicleFound ? "Connected. A vehicle answered." : "Connected to the adapter. No vehicle was read.";
  if (view.link === "ended") return "The connection has ended.";
  return "Not connected.";
}

/** The current-data PIDs each ECU's own bitmap lists and the reviewed table can decode. */
function pollable(discovery: DiscoveryReport | null): PollOption[] {
  return (discovery?.ecus ?? []).flatMap((ecu) => ecu.currentData.supportedPids.filter((pid) => pidDefinition(pid)).map((pid) => ({ module: ecu.module, responseId: ecu.responseId, pid })));
}

const headline = "text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl";

const HEADLINE: Partial<Record<Stage, string>> = {
  disconnected: "Connect your scanner",
  choosing: "Choose your adapter",
  connecting: "Connecting to your scanner",
  scanning: "Scanning your vehicle",
  closing: "Disconnecting",
};

function Frame({ back, children }: { back: { href: string; label: string }; children: ReactNode }) {
  return (
    <main className="relative min-h-screen bg-[#0f172a] text-slate-100">
      <div aria-hidden className="pointer-events-none fixed inset-0 bg-[radial-gradient(56rem_30rem_at_78%_-8%,rgba(59,130,246,0.16),transparent_70%)]" />
      <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-5 sm:px-6 lg:px-8">
        <header className="mb-8 flex items-center justify-between gap-3 lg:mb-12">
          <h1 className="text-lg font-semibold tracking-tight text-white">CarCode Scanner</h1>
          <Link href={back.href} className={cn("shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10", focusRing)}>
            {back.label}
          </Link>
        </header>
        {children}
      </div>
    </main>
  );
}

/** What each VIN decodes to, asked once per VIN; a VIN not yet answered reads as identifying. */
function useVehicleIdentities(vins: (string | null)[]): (vin: string | null) => VehicleIdentity | null {
  const [known, setKnown] = useState<Record<string, VehicleIdentity>>({});
  const wanted = [...new Set(vins.filter((vin): vin is string => Boolean(vin)))].filter((vin) => !known[vin]).join(",");
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    for (const vin of wanted.split(",")) {
      void identifyVehicle(vin).then((identity) => {
        if (live) setKnown((previous) => ({ ...previous, [vin]: identity }));
      });
    }
    return () => {
      live = false;
    };
  }, [wanted]);
  return (vin) => (vin ? (known[vin] ?? { status: "identifying" }) : null);
}

/**
 * The scanner page. Everything stays in this page's memory: nothing is saved,
 * sent or attached to a diagnosis. Decoded values are shown as pending
 * verification, and no conclusion is drawn from anything read.
 */
export default function ScannerClient({ vehicle }: { vehicle: ScannerVehicleContext | null }) {
  const [session] = useState(() => new ScannerSession());
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [pendingKind, setPendingKind] = useState<LinkInfo["kind"] | null>(null);
  const [profile, setProfile] = useState("documented");
  const [showAllDevices, setShowAllDevices] = useState(false);
  const [manual, setManual] = useState<ManualUuids>({ service: "", notify: "", write: "" });
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

  const stage = stageOf(view);
  const idle = view.link === "none" || view.link === "ended";
  const ready = view.link === "open" && view.lifecycle === "ready" && !view.activity;
  const canRead = ready && view.vehicleFound && !view.needsRecovery;
  const options = pollable(view.discovery);
  const selection = options.filter((entry) => chosen.includes(pollKey(entry))).map(({ module, pid }) => ({ module, pid }));
  const vehicleName = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.engine ? ` (${vehicle.engine})` : ""}` : null;
  const garage: GarageVehicle = vehicle && vehicleName
    ? {
        name: vehicleName,
        sameAs: (identity) => identity.year === vehicle.year && identity.make.toLowerCase() === vehicle.make.toLowerCase() && identity.model.toLowerCase() === vehicle.model.toLowerCase(),
      }
    : null;
  // Only a VIN every answering module agreed on is decoded; conflicting VINs identify nothing.
  const connectedVin = view.discovery?.vinComparison.status === "consistent" ? view.discovery.vinComparison.text : null;
  const scanVin = view.scan?.evidence.vehicle.vin.comparison.status === "consistent" ? view.scan.evidence.vehicle.vin.comparison.text : null;
  const identityOf = useVehicleIdentities([connectedVin, scanVin]);
  const kind = view.link === "choosing" ? pendingKind : (view.transport ?? pendingKind);
  const inlineNotice = view.notice && stage !== "failed" && stage !== "no_vehicle";
  const hasResults = Boolean(view.scan || view.discovery?.ecus.length);
  // Connecting again is the one main action, unless it cannot help: then the other ways to connect come first.
  const canRetry = view.canReconnect && !(view.notice && describeNotice(view.notice).noRetry);

  const connectBluetooth = () => {
    setPendingKind("web_bluetooth");
    void session.connectBluetooth({ profile, showAllDevices, manual });
  };
  const connectSerial = () => {
    setPendingKind("web_serial");
    void session.connectSerial({ baudRate: Number(baudRate) });
  };

  const disconnect = (
    <button type="button" data-disconnect className={quietAction} onClick={() => void session.disconnect()}>
      Disconnect
    </button>
  );
  const recover = (label: string, primary: boolean) => (
    <button type="button" data-recover className={primary ? mainAction : quietAction} onClick={() => void session.recover()}>
      {label}
    </button>
  );
  const reconnect = canRetry && (
    <button type="button" data-reconnect className={mainAction} onClick={() => void session.reconnect()}>
      Connect again
    </button>
  );

  const connectionChoices = (
    <>
      <ConnectOptions bluetooth={view.offers.bluetooth} serial={view.offers.serial} onBluetooth={connectBluetooth} onSerial={connectSerial} />
      <AdvancedConnection
        bluetooth={view.offers.bluetooth}
        serial={view.offers.serial}
        profile={profile}
        onProfile={setProfile}
        showAllDevices={showAllDevices}
        onShowAllDevices={setShowAllDevices}
        manual={manual}
        onManual={setManual}
        baudRate={baudRate}
        onBaudRate={setBaudRate}
      />
    </>
  );

  return (
    <Frame back={scannerBackLink(vehicle)}>
      <section data-stage={stage} className="grid items-center gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0">
          {stage === "failed" && (
            <FailurePanel notice={view.notice} fallback="Connection failed" hasResults={hasResults}>
              {reconnect}
            </FailurePanel>
          )}
          {stage === "no_vehicle" && (
            <FailurePanel notice={view.notice} fallback="Vehicle not responding" hasResults={hasResults}>
              {ready && recover("Try Again", true)}
              {disconnect}
            </FailurePanel>
          )}
          {HEADLINE[stage] && <h2 className={headline}>{HEADLINE[stage]}</h2>}
          {stage === "connected" && (
            <>
              <h2 className={cn(headline, "flex items-center gap-3")}>
                <span aria-hidden className="mt-1.5 size-3 shrink-0 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(103,232,249,0.8)]" />
                Connected
              </h2>
              {view.discovery && <ConnectedSummary identity={identityOf(connectedVin)} garage={garage} discovery={view.discovery} linkInfo={view.linkInfo} />}
              {view.needsRecovery && <p className="mt-3 text-sm text-amber-200">The adapter needs a reset before anything else is read.</p>}
              <div className="mt-6 flex flex-wrap gap-2">
                <button type="button" data-scan className={mainAction} disabled={!canRead} onClick={() => void session.scan()}>
                  {view.scan ? "Scan Again" : "Scan Vehicle"}
                </button>
                {disconnect}
                {ready && recover("Reset adapter", view.needsRecovery)}
              </div>
            </>
          )}
          {stage === "disconnected" && (
            <p className="mt-3 max-w-xl text-base text-slate-300 sm:text-lg">
              Plug your Vgate into the vehicle&apos;s OBD-II port and turn the ignition on.
            </p>
          )}
          {(stage === "disconnected" || stage === "failed") && !view.discovery && (
            <div className="mt-3 text-sm text-slate-400">
              {vehicleName && <p data-vehicle-context>{vehicleName}</p>}
              <p data-identify-hint>{vehicleName ? "CarCode confirms the car from its VIN once connected." : "No vehicle needed: CarCode identifies the car from its VIN once connected."}</p>
            </div>
          )}
          {stage === "disconnected" && reconnect && <div className="mt-5">{reconnect}</div>}
          {(stage === "choosing" || stage === "connecting") && <ProgressSteps steps={connectionSteps(view, kind)} />}
          {stage === "scanning" && <ProgressSteps steps={scanSteps(view)} />}
          <p data-status aria-live="polite" className={cn("text-sm text-slate-400", stage === "choosing" || stage === "connecting" || stage === "scanning" || stage === "closing" ? "mt-4" : "sr-only")}>
            {statusLine(view)}
          </p>
          {(stage === "connecting" || stage === "scanning") && (
            <div className="mt-4 flex flex-wrap gap-2">
              {(view.activity === "scan" || view.activity === "discovery") && (
                <button type="button" data-cancel className={quietAction} disabled={view.stopping} onClick={() => session.cancel()}>
                  Cancel
                </button>
              )}
              {disconnect}
            </div>
          )}
        </div>
        <ConnectorGraphic pins={pinsFor(stage, view)} className="order-first mx-auto w-40 sm:w-52 lg:order-none lg:w-full" />
      </section>

      <div className="mt-8 space-y-4">
        {inlineNotice && <NoticeBanner notice={view.notice!} hasResults={hasResults} />}

        {idle && !canRetry && connectionChoices}
        {idle && canRetry && (
          <Disclosure summary="Use a different adapter">
            <div className="space-y-4">{connectionChoices}</div>
          </Disclosure>
        )}

        {stage === "scanning" && !view.scan && <ScanSkeleton />}

        {(view.scan || (view.discovery && view.vehicleFound)) && (
          <div className="grid gap-4 lg:grid-cols-5">
            {view.scan && <ScanSummary scan={view.scan} connection={view.connection} />}
            {view.scan && <VehicleCard scan={view.scan} identity={identityOf(scanVin)} garage={garage} className="lg:col-span-2" />}
            {view.scan && <FaultCodesCard scan={view.scan} className="lg:col-span-3" />}
            {view.scan && <ReadinessCard scan={view.scan} className="lg:col-span-2" />}
            {view.scan && <FreezeFrameCard scan={view.scan} className="lg:col-span-3" />}
            <LiveDataCard
              connected={view.link === "open" && view.vehicleFound}
              scan={view.scan}
              live={view.live}
              options={options}
              chosen={chosen}
              onToggle={(key, on) => setChosen(on ? [...chosen, key] : chosen.filter((entry) => entry !== key))}
              cycles={cycles}
              onCycles={setCycles}
              intervalMs={intervalMs}
              onInterval={setIntervalMs}
              maxPids={MAX_LIVE_PIDS}
              maxCycles={MAX_LIVE_CYCLES}
              maxInterval={MAX_LIVE_INTERVAL_MS}
              canStart={canRead && selection.length > 0}
              running={view.activity === "live"}
              stopping={view.stopping}
              onStart={() => void session.startPolling({ selection, cycles: Number(cycles), intervalMs: Number(intervalMs) })}
              onStop={() => session.stopPolling()}
            />
          </div>
        )}

        {(view.logTotal > 0 || view.linkInfo) && <AdvancedDiagnostics log={view.log} total={view.logTotal} discovery={view.discovery} linkInfo={view.linkInfo} evidence={view.scan?.evidence ?? null} />}

        <footer className="flex gap-2 pt-4 text-xs text-slate-500">
          <ShieldIcon className="size-4 shrink-0" />
          <div>
            <p>Read-only. Nothing read here is saved, sent or attached to a diagnosis.</p>
            <p data-preview-banner role="note">
              {PREVIEW_BANNER}
            </p>
          </div>
        </footer>
      </div>
    </Frame>
  );
}
