"use client";

import type { ReactNode } from "react";
import type { DiscoveryReport } from "@/app/lib/vehicle-communication/scanner/report";
import { DOCUMENTED_BLE_PROFILES } from "@/app/lib/vehicle-communication/transport/ble-profiles";
import { WEB_BLUETOOTH_LIMITATIONS } from "@/app/lib/vehicle-communication/transport/web-bluetooth";
import { WEB_SERIAL_LIMITATIONS } from "@/app/lib/vehicle-communication/transport/web-serial";
import type { LinkInfo, Notice, TransportOffer } from "@/app/scanner/scanner-session";
import { describeNotice, type Step } from "@/app/scanner/scanner-view";
import { cn, inputClass, primaryButton, quietButton } from "@/components/garage/shared";
import { AlertIcon, BluetoothIcon, CheckIcon, ChevronIcon, PortIcon } from "@/components/scanner/ScannerIcons";

export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300";
export const mainAction = cn(primaryButton, focusRing, "min-h-11 px-5");
export const quietAction = cn(quietButton, focusRing, "min-h-11");

/** A collapsed section in the page's voice: rotates its chevron when open, and nests safely. */
export function Disclosure({ summary, children, className, ...rest }: { summary: ReactNode; children: ReactNode; className?: string; [data: `data-${string}`]: unknown }) {
  return (
    <details className={cn("text-sm text-slate-400", className)} {...rest}>
      <summary className={cn("flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-1 font-medium text-slate-300 hover:text-white [&::-webkit-details-marker]:hidden", focusRing)}>
        <ChevronIcon className="size-4 shrink-0 transition-transform [details[open]>summary_&]:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2 pl-[1.375rem]">{children}</div>
    </details>
  );
}

/** Plain wording for a transport this browser or computer cannot offer. The browser's own reason stays in Advanced. */
function unavailableText(kind: LinkInfo["kind"], detail: string): string {
  if (/secure context/.test(detail)) return "This page must be opened over HTTPS to reach the adapter.";
  if (/radio/.test(detail)) return "Bluetooth looks turned off on this computer. Turn it on, then reload this page.";
  return kind === "web_bluetooth" ? "This browser can't reach Bluetooth adapters. Open CarCode in Chrome or Edge on a computer." : "This browser can't open COM ports. Open CarCode in Chrome or Edge on a computer.";
}

function OptionCard({ kind, primary, icon, title, tag, text, offer, action, onConnect, ...rest }: { kind: LinkInfo["kind"]; primary?: boolean; icon: ReactNode; title: string; tag?: string; text: string; offer: TransportOffer; action: string; onConnect: () => void; [data: `data-${string}`]: unknown }) {
  return (
    <div className={cn("flex flex-col rounded-2xl border p-5", primary ? "border-blue-400/30 bg-blue-500/10" : "border-white/10 bg-white/[0.04]")}>
      <div className="flex items-center gap-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", primary ? "bg-blue-500/20 text-blue-200" : "bg-white/5 text-slate-300")}>{icon}</span>
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        {tag && <span className="ml-auto rounded-lg bg-blue-400/15 px-2 py-0.5 text-xs font-medium text-blue-200">{tag}</span>}
      </div>
      <p className="mt-3 flex-1 text-sm text-slate-300">{text}</p>
      {offer.status === "checking" && <div className="mt-4 h-11 rounded-xl bg-white/5 motion-safe:animate-pulse" />}
      {offer.status === "unavailable" && (
        <p data-unavailable className="mt-4 text-sm text-amber-200">
          {unavailableText(kind, offer.detail)}
        </p>
      )}
      {offer.status === "available" && (
        <button type="button" {...rest} className={cn(primary ? mainAction : quietAction, "mt-4 w-full")} onClick={onConnect}>
          {action}
        </button>
      )}
    </div>
  );
}

export function ConnectOptions({ bluetooth, serial, onBluetooth, onSerial }: { bluetooth: TransportOffer; serial: TransportOffer; onBluetooth: () => void; onSerial: () => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-[3fr_2fr]">
      <OptionCard data-connect-ble kind="web_bluetooth" primary icon={<BluetoothIcon />} title="Bluetooth" text="Recommended for BLE Vgate adapters." offer={bluetooth} action="Connect Bluetooth" onConnect={onBluetooth} />
      <OptionCard data-connect-serial kind="web_serial" icon={<PortIcon />} title="COM Port" text="For Bluetooth Classic adapters paired with Windows." offer={serial} action="Connect COM Port" onConnect={onSerial} />
    </div>
  );
}

const fieldLabel = "block text-sm text-slate-300";
const field = cn(inputClass, "mt-1 min-h-11", focusRing);

export type ManualUuids = { service: string; notify: string; write: string };

export function AdvancedConnection({ bluetooth, serial, profile, onProfile, showAllDevices, onShowAllDevices, manual, onManual, baudRate, onBaudRate }: {
  bluetooth: TransportOffer;
  serial: TransportOffer;
  profile: string;
  onProfile: (value: string) => void;
  showAllDevices: boolean;
  onShowAllDevices: (value: boolean) => void;
  manual: ManualUuids;
  onManual: (value: ManualUuids) => void;
  baudRate: string;
  onBaudRate: (value: string) => void;
}) {
  return (
    <Disclosure data-advanced-connection summary="Advanced connection options">
      <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        {bluetooth.status === "available" && (
          <>
            <label className="relative flex min-h-11 cursor-pointer items-center gap-3 text-sm text-slate-200">
              <input type="checkbox" className="peer sr-only" checked={showAllDevices} onChange={(event) => onShowAllDevices(event.target.checked)} />
              <span aria-hidden className="relative h-6 w-10 shrink-0 rounded-full bg-white/15 transition-colors peer-checked:bg-blue-500 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-cyan-300 after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
              <span>
                Show all Bluetooth devices
                <span className="block text-slate-400">Use this if your adapter isn&apos;t listed.</span>
              </span>
            </label>
            <label className={fieldLabel}>
              Bluetooth profile
              <select aria-label="Adapter profile" className={cn(field, "[&>option]:bg-slate-900")} value={profile} onChange={(event) => onProfile(event.target.value)}>
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
              <div className="grid gap-3 sm:grid-cols-3">
                {(["service", "notify", "write"] as const).map((name) => (
                  <label key={name} className={fieldLabel}>
                    {name === "service" ? "Service UUID" : name === "notify" ? "Notify UUID" : "Write UUID"}
                    <input aria-label={`${name} UUID`} className={cn(field, "font-mono")} value={manual[name]} onChange={(event) => onManual({ ...manual, [name]: event.target.value })} />
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        {serial.status === "available" && (
          <label className={fieldLabel}>
            COM port baud rate
            <input aria-label="Baud rate" inputMode="numeric" className={cn(field, "block max-w-40")} value={baudRate} onChange={(event) => onBaudRate(event.target.value)} />
          </label>
        )}
        <Disclosure summary="Browser and adapter limitations">
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {[...WEB_BLUETOOTH_LIMITATIONS, ...WEB_SERIAL_LIMITATIONS].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </Disclosure>
  );
}

function StepMark({ state }: { state: Step["state"] }) {
  if (state === "done") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-cyan-300/15 text-cyan-200">
        <CheckIcon className="size-4" />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="grid size-6 place-items-center rounded-full border border-cyan-300/60">
        <span className="size-2.5 rounded-full bg-cyan-300 motion-safe:animate-pulse" />
      </span>
    );
  }
  return <span className="block size-6 rounded-full border border-white/15" />;
}

export function ProgressSteps({ steps }: { steps: readonly Step[] }) {
  return (
    <ol data-steps className="mt-6 space-y-3">
      {steps.map((step) => (
        <li key={step.id} data-step={step.id} data-step-state={step.state} aria-current={step.state === "active" ? "step" : undefined} className="flex items-center gap-3">
          <StepMark state={step.state} />
          <span className={cn("text-base", step.state === "waiting" ? "text-slate-500" : step.state === "active" ? "font-medium text-white" : "text-slate-200")}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** An info or error notice shown beside the current screen. */
export function NoticeBanner({ notice, hasResults }: { notice: Notice; hasResults: boolean }) {
  const message = describeNotice(notice, hasResults);
  const error = notice.tone === "error";
  return (
    <div role={error ? "alert" : "status"} data-notice={notice.tone} className={cn("flex gap-3 rounded-2xl border p-4 text-sm", error ? "border-red-400/30 bg-red-500/10 text-red-100" : "border-white/10 bg-white/5 text-slate-200")}>
      {error && <AlertIcon className="mt-0.5 size-5 shrink-0 text-red-300" />}
      <div className="min-w-0">
        {message.title && <p className="font-semibold text-white">{message.title}</p>}
        <p>{message.body}</p>
        <TechnicalNote text={message.technical} />
      </div>
    </div>
  );
}

function TechnicalNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Disclosure summary="Technical details" className="mt-2">
      <p data-notice-technical className="break-words text-xs">
        {text}
      </p>
    </Disclosure>
  );
}

/** The screen for a failed connection or a silent vehicle: what happened, then what to do. */
export function FailurePanel({ notice, fallback, hasResults, children }: { notice: Notice | null; fallback: string; hasResults: boolean; children: ReactNode }) {
  const message = notice ? describeNotice(notice, hasResults) : null;
  return (
    <div role="alert" data-notice="error">
      <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">{message?.title ?? fallback}</h2>
      {message && <p className="mt-3 max-w-xl text-base text-slate-300">{message.body}</p>}
      <div className="mt-6 flex flex-wrap gap-2">{children}</div>
      <TechnicalNote text={message?.technical ?? null} />
    </div>
  );
}

function Fact({ label, children, ...rest }: { label: string; children: ReactNode; [data: `data-${string}`]: unknown }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="shrink-0 text-sm text-slate-400 sm:w-24">{label}</dt>
      <dd {...rest} className="min-w-0 break-words text-base text-slate-100">
        {children}
      </dd>
    </div>
  );
}

function protocolLabel(protocol: DiscoveryReport["protocol"]): string | null {
  if (!protocol) return null;
  if (!protocol.supported) return `Not CAN (protocol ${protocol.number})`;
  return protocol.family === "can11" ? "CAN, 11-bit" : "CAN, 29-bit";
}

/** Only what was actually detected: a row with nothing behind it is left out. */
export function ConnectedSummary({ vehicleName, discovery, linkInfo }: { vehicleName: string | null; discovery: DiscoveryReport; linkInfo: LinkInfo | null }) {
  const { adapter, protocol, vinComparison } = discovery;
  const deviceName = linkInfo?.kind === "web_bluetooth" ? linkInfo.deviceName : null;
  const identity = [...new Set([deviceName, ...adapter.ati.lines, ...adapter.description.lines].filter(Boolean))].join(", ");
  const protocolText = protocolLabel(protocol);
  return (
    <>
      {vehicleName && (
        <>
          <p data-vehicle-context className="mt-3 text-2xl font-medium tracking-tight text-slate-100">
            {vehicleName}
          </p>
          <p className="mt-0.5 text-sm text-slate-400">Chosen in your garage, not confirmed by the car.</p>
        </>
      )}
      <dl className="mt-4 space-y-2">
        {vinComparison.status === "consistent" && (
          <Fact data-vin label="VIN">
            <span className="font-mono">{vinComparison.text}</span>
          </Fact>
        )}
        {vinComparison.status === "conflicting" && (
          <Fact data-vin label="VIN">
            <span className="text-amber-200">Modules reported different VINs. All are kept; none is picked.</span>
          </Fact>
        )}
        {identity && (
          <Fact data-adapter label="Adapter">
            {identity}
          </Fact>
        )}
        {protocolText && <Fact label="Protocol">{protocolText}</Fact>}
      </dl>
    </>
  );
}
