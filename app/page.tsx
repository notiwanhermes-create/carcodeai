"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { ComboSelect } from "../components/ComboSelect";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { VehicleDeleteButton } from "../components/VehicleDeleteButton";
import { LANGUAGES, tr, type LangCode } from "./data/translations";
import { useGarageVehicles } from "./lib/useGarageVehicles";
import { getMakeLogo } from "./lib/make-logos";
import { isValidVinFormat, normalizeVin } from "./lib/vin";
import type { DtcResult } from "./lib/dtc";
import type { CheckLevel, DiagnoseNoDefinition, DiagnoseOk, Diagnosis, Likelihood, RepairLevel, Urgency } from "./lib/diagnosis-schema";
import { completeMakeName } from "./data/vehicle-makes";
type EngineOption =
  | string
  | {
      id?: string;
      label?: string;
      details?: string;
      displacementL?: number;
      cylinders?: number;
      engineType?: string;
      aspiration?: string;
      fuel?: string;
      source?: string;
    };

import * as ReactDOM from "react-dom";

type Vehicle = {
  id: string;
  year: string;
  make: string;
  model: string;
  engine?: string;
  nickname?: string;
  vin?: string;
};

type ApiOk = DiagnoseOk;
type ApiNoDefinition = DiagnoseNoDefinition;

type ApiErr = { error: string };

/** The body sent to /api/diagnose. */
type DiagnosePayload = {
  year: string;
  make: string;
  model: string;
  engine: string;
  vin: string;
  mileage: string;
  mileageUnit: "km" | "mi";
  code: string;
  symptoms: string;
  lang: LangCode;
  followUps?: { question: string; answer: string }[];
};

type MaintenanceRecord = {
  id: string;
  vehicleId: string;
  type: string;
  date: string;
  mileageValue?: number;
  mileageUnit?: "km" | "mi";
  mileageKm?: number;
  notes: string;
};


/** Renders make logo image; on load error shows fallback letter so no broken image icon. */
function MakeLogoImg({
  src,
  alt,
  fallbackLetter,
  theme,
}: { src: string; alt: string; fallbackLetter: string | null; theme: "dark" | "light" }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className={cn("text-sm font-semibold", theme === "dark" ? "text-white/80" : "text-slate-600")}>
        {fallbackLetter ?? "?"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="h-7 w-7 object-contain"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Records saved by older versions stored the odometer as a single "mileage" value. */
type LegacyMaintenanceRecord = MaintenanceRecord & { mileage?: string | number };

/** The browser's "install this app" prompt event (not in the standard DOM typings). */
type InstallPromptEvent = Event & { prompt: () => Promise<unknown> };

/** A cause as stored in saved diagnosis history (kept small and stable across versions). */
type DiagnosisCauseSnapshot = {
  id: string;
  title: string;
  whyLikely: string[];
  confirm?: string[];
  fix?: string[];
};

type DiagnosisSession = {
  id: string;
  vehicleId: string;
  timestamp: string; // ISO
  issueText: string;
  code?: string;
  symptoms?: string;
  vehicle: { year: string; make: string; model: string; engine?: string };
  followUpAnswers: Record<string, string>;
  finalRankedCauses: DiagnosisCauseSnapshot[];
  confirmedFix?: { causeId: string; causeTitle: string; fix: string };
};

const MAINTENANCE_STORAGE_KEY = "carcode_maintenance_v1";
const DIAGNOSIS_ANON_STORAGE_KEY = "carcode_diagnosis_sessions_v1:anon";

/** Saved diagnoses for one storage key, or an empty object if missing/unreadable. */
function readDiagnosisSessions(key: string): Record<string, DiagnosisSession[]> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, DiagnosisSession[]>)
      : {};
  } catch {
    return {};
  }
}

function AuthButtons({ theme }: { theme: "dark" | "light" }) {
  const { data: session, status } = useSession();
  const t = (dark: string, light: string) => theme === "dark" ? dark : light;

  if (status === "loading") return null;

  if (session?.user) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard"
          className={cn(
            "flex h-9 sm:h-10 items-center gap-1.5 px-2.5 sm:px-3 rounded-xl transition-all text-xs sm:text-sm font-medium",
            t("border border-white/10 bg-white/10 text-slate-300 hover:bg-white/20", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100")
          )}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span className="hidden sm:inline">{session.user.email?.split("@")[0] || "Account"}</span>
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className={cn(
            "flex h-9 sm:h-10 items-center px-2.5 sm:px-3 rounded-xl transition-all text-xs sm:text-sm font-medium",
            t("border border-white/10 bg-white/10 text-slate-400 hover:bg-red-500/20 hover:text-red-400", "border border-slate-200 bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-red-600")
          )}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    );
  }

  return (
    <Link
      href="/login"
      className={cn(
        "flex h-9 sm:h-10 items-center gap-1.5 px-3 sm:px-4 rounded-xl transition-all text-xs sm:text-sm font-semibold",
        "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40"
      )}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      <span>Sign In</span>
    </Link>
  );
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function useDebouncedValue<T>(value: T, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function CarScanLoader({ theme, vehicle, lang }: { theme: "dark" | "light"; vehicle?: { year: string; make: string; model: string; engine?: string } | null; lang: LangCode }) {
  const t = (dark: string, light: string) => theme === "dark" ? dark : light;
  const vehicleLabel = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : tr("vehicle", lang);

  const systems = [
    { label: tr("sysEngine", lang), icon: (c: string) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4m4 0h4"/><path d="M12 6V2m0 20v-4"/><circle cx="12" cy="12" r="2"/></svg>, color: "#22d3ee", delay: 0 },
    { label: tr("sysTrans", lang), icon: (c: string) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v8a2 2 0 002 2h0"/><path d="M18 8v8a2 2 0 01-2 2h0"/><path d="M12 8v8"/></svg>, color: "#a78bfa", delay: 0.8 },
    { label: tr("sysExhaust", lang), icon: (c: string) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6a2 2 0 012 2v0a2 2 0 002 2h6"/><path d="M8 8c1-2 3-2 4 0s3 2 4 0"/><path d="M6 11c1-2 3-2 4 0s3 2 4 0"/></svg>, color: "#60a5fa", delay: 1.6 },
    { label: tr("sysElectric", lang), icon: (c: string) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>, color: "#fbbf24", delay: 2.4 },
    { label: tr("sysBrakes", lang), icon: (c: string) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>, color: "#f472b6", delay: 3.2 },
    { label: tr("sysFuel", lang), icon: (c: string) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 22V6a2 2 0 012-2h8a2 2 0 012 2v16"/><path d="M15 10h2a2 2 0 012 2v4a2 2 0 002 2"/><path d="M3 22h12"/><rect x="6" y="8" width="6" height="4" rx="1"/></svg>, color: "#34d399", delay: 4.0 },
  ];

  const cx = 150, cy = 120, r = 80;
  const nodePositions = systems.map((_, i) => {
    const angle = (i * 2 * Math.PI) / systems.length - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  return (
    <div className={cn("w-full max-w-3xl rounded-3xl p-6 sm:p-8 shadow-2xl overflow-hidden", t("glass-card-strong", "bg-white border border-slate-200 shadow-lg"))}>
      <style>{`
        @keyframes dotPulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
        @keyframes nodePulse { 0%, 100% { transform: scale(1); filter: brightness(1); } 50% { transform: scale(1.12); filter: brightness(1.3); } }
        @keyframes ringPulse { 0%, 100% { opacity: 0.15; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.08); } }
        @keyframes centerSpin { 0% { transform: translate(-50%, -50%) rotate(0deg); } 100% { transform: translate(-50%, -50%) rotate(360deg); } }
        @keyframes centerGlow { 0%, 100% { box-shadow: 0 0 20px rgba(34,211,238,0.15), 0 0 60px rgba(34,211,238,0.05); } 50% { box-shadow: 0 0 30px rgba(34,211,238,0.35), 0 0 80px rgba(34,211,238,0.15); } }
        @keyframes lineFlow { 0% { stroke-dashoffset: 20; } 100% { stroke-dashoffset: 0; } }
        @keyframes scanLine { 0%, 100% { opacity: 0.05; } 50% { opacity: 0.15; } }
        @keyframes checkPop { 0%, 85% { opacity: 0; transform: scale(0); } 100% { opacity: 1; transform: scale(1); } }
      `}</style>

      <div>
        <div className={cn("text-base font-semibold", t("text-white", "text-slate-900"))}>{tr("scanningVehicle", lang)} {vehicleLabel}...</div>
        <div className={cn("mt-1 text-xs", t("text-slate-400", "text-slate-500"))}>
          {tr("analyzingSystems", lang)}
        </div>
      </div>

      <div className="mt-6 sm:mt-8">
        <div className="relative mx-auto" style={{ width: 300, height: 280 }}>
          <svg className="absolute inset-0" width="300" height="280" viewBox="0 0 300 280">
            <defs>
              <radialGradient id="bgGlow">
                <stop offset="0%" stopColor={theme === "dark" ? "rgba(34,211,238,0.06)" : "rgba(59,130,246,0.04)"} />
                <stop offset="100%" stopColor="transparent" />
              </radialGradient>
            </defs>
            <circle cx={cx} cy={cy} r="110" fill="url(#bgGlow)" />

            {nodePositions.map((pos, i) => (
              <line key={`line-${i}`} x1={cx} y1={cy} x2={pos.x} y2={pos.y}
                stroke={theme === "dark" ? systems[i].color : systems[i].color}
                strokeWidth="1" opacity="0.15"
                strokeDasharray="4 4"
                style={{ animation: `lineFlow 2s linear infinite ${systems[i].delay}s` }}
              />
            ))}

            <circle cx={cx} cy={cy} r={r} fill="none"
              stroke={theme === "dark" ? "rgba(34,211,238,0.08)" : "rgba(59,130,246,0.06)"}
              strokeWidth="1" strokeDasharray="6 4"
              style={{ animation: "scanLine 3s ease-in-out infinite" }}
            />
          </svg>

          <div className="absolute rounded-full flex items-center justify-center" style={{
            width: 52, height: 52,
            top: cy, left: cx, transform: "translate(-50%, -50%)",
            background: theme === "dark" ? "rgba(34,211,238,0.06)" : "rgba(59,130,246,0.04)",
            border: `1.5px solid ${theme === "dark" ? "rgba(34,211,238,0.25)" : "rgba(59,130,246,0.2)"}`,
            animation: "centerGlow 3s ease-in-out infinite",
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={theme === "dark" ? "#22d3ee" : "#3b82f6"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6m-3-3h6"/>
            </svg>
          </div>

          <div className="absolute rounded-full" style={{
            width: 64, height: 64,
            top: cy, left: cx,
            transform: "translate(-50%, -50%)",
            border: `1px solid ${theme === "dark" ? "rgba(34,211,238,0.1)" : "rgba(59,130,246,0.08)"}`,
            animation: "ringPulse 3s ease-in-out infinite",
            borderRadius: "50%",
          }} />

          <svg className="absolute" style={{ top: cy, left: cx, transform: "translate(-50%, -50%)", animation: "centerSpin 12s linear infinite" }} width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" fill="none" stroke={theme === "dark" ? "rgba(34,211,238,0.12)" : "rgba(59,130,246,0.1)"} strokeWidth="1" strokeDasharray="8 12" />
          </svg>

          {systems.map((sys, i) => {
            const pos = nodePositions[i];
            return (
              <div key={i} className="absolute flex flex-col items-center" style={{
                left: pos.x, top: pos.y, transform: "translate(-50%, -50%)",
              }}>
                <div className="relative">
                  <div className="rounded-full flex items-center justify-center" style={{
                    width: 40, height: 40,
                    background: theme === "dark" ? `${sys.color}12` : `${sys.color}0a`,
                    border: `1.5px solid ${theme === "dark" ? `${sys.color}35` : `${sys.color}25`}`,
                    boxShadow: `0 0 16px ${sys.color}30`,
                    animation: `nodePulse 2.5s ease-in-out infinite ${sys.delay}s`,
                  }}>
                    {sys.icon(sys.color)}
                  </div>
                  <div className="absolute -top-0.5 -right-0.5" style={{
                    animation: `checkPop 5s ease-out infinite ${sys.delay + 1.5}s`,
                    opacity: 0,
                  }}>
                    <div className="rounded-full flex items-center justify-center" style={{
                      width: 14, height: 14,
                      background: theme === "dark" ? "#0f172a" : "#fff",
                      border: `1.5px solid ${sys.color}`,
                    }}>
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={sys.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                    </div>
                  </div>
                </div>
                <span className={cn("mt-1.5 text-[10px] font-medium", t("text-slate-400", "text-slate-500"))}>{sys.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex justify-center">
        <div className={cn("inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs", t("border border-cyan-500/20 bg-cyan-500/10 text-cyan-300", "border border-blue-200 bg-blue-50 text-blue-600"))}>
          <span className="h-2 w-2 rounded-full bg-cyan-400" style={{ animation: "dotPulse 1.2s ease-in-out infinite" }} />
          {tr("scanningVehicle", lang)}
        </div>
      </div>
    </div>
  );
}

/**
 * The codes the user entered, each with a plain-language note on how far its
 * definition can be trusted. A definition is shown only when one is on file.
 */
function CodeStatusList({ codes, lang }: { codes: DtcResult[]; lang: LangCode }) {
  return (
    <div className="mt-2 space-y-3">
      {codes.map((c) => {
        const tone = c.definition ? "ok" : c.status === "invalid" ? "bad" : "warn";
        const chip =
          tone === "ok"
            ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
            : tone === "bad"
              ? "bg-red-500/15 text-red-300 border border-red-500/30"
              : "bg-amber-500/20 text-amber-400 border border-amber-500/30";
        const note =
          c.status === "generic_definition"
            ? tr(c.trust === "verified" ? "codeVerifiedDefinition" : "codeReferenceTitle", lang)
            : c.status === "generic_unverified" || c.status === "uncertain_unavailable"
              ? tr("codeDefinitionNotVerified", lang)
              : c.status === "manufacturer_definition"
                ? `${c.make}: ${tr("codeManufacturerSpecific", lang)}`
                : c.status === "manufacturer_unavailable"
                  ? tr("codeManufacturerUnavailable", lang)
                  : tr("codeInvalid", lang);
        return (
          <div key={c.code} data-code-trust={c.trust} className="flex items-start gap-3">
            <span className={cn("shrink-0 rounded-lg px-2.5 py-1 text-sm font-bold tracking-wide", chip)}>{c.code}</span>
            <div className="min-w-0">
              {c.definition && <div className="text-lg font-semibold tracking-tight leading-tight text-white">{c.definition}</div>}
              <div
                className={cn(
                  "text-xs",
                  c.definition ? "mt-0.5" : "mt-1.5",
                  // A hand-entered title is shown, but not in the colour used for verified data.
                  c.trust === "local_reference" ? "text-slate-300/90" : tone === "ok" ? "text-blue-300/80" : tone === "bad" ? "text-red-300/90" : "text-amber-300/90",
                )}
              >
                {note}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Translation keys for the diagnosis enums. The page never decides anything
 * from the wording of a diagnosis: likelihood, urgency, drive guidance and
 * check levels are read from these structured values only.
 */
const LIKELIHOOD_KEY: Record<Likelihood, string> = {
  very_likely: "likelihoodVeryLikely",
  likely: "likelihoodLikely",
  possible: "likelihoodPossible",
  unlikely: "likelihoodUnlikely",
};
const URGENCY_KEY: Record<Urgency, string> = {
  normal: "urgencyNormal",
  caution: "urgencyCaution",
  stop: "urgencyStop",
  unknown: "urgencyUnknown",
};
const DRIVE_KEY: Record<Urgency, string> = {
  normal: "driveNormal",
  caution: "driveCaution",
  stop: "driveStop",
  unknown: "driveUnknown",
};
const CHECK_LEVEL_KEY: Record<CheckLevel, string> = {
  owner: "checkOwner",
  diy: "checkDiy",
  professional: "checkProfessional",
};
const REPAIR_LEVEL_KEY: Record<RepairLevel, string> = {
  diy_easy: "repairDiyEasy",
  diy_moderate: "repairDiyModerate",
  professional: "repairProfessional",
};

/** An answer to a follow-up question, as sent back to the server. */
type FollowUpAnswerPayload = { question: string; answer: string };

/** Stable English answers for yes/no questions, whatever language the page is in. */
const YES_NO_ANSWERS = [
  { id: "yes", key: "answerYes", text: "Yes" },
  { id: "no", key: "answerNo", text: "No" },
  { id: "not_sure", key: "answerNotSure", text: "Not sure" },
] as const;

/** The safety level shown for the whole diagnosis. Read from the structured result, never inferred. */
function DriveGuidanceBanner({ guidance, theme, lang }: { guidance: Diagnosis["drive_guidance"]; theme: "dark" | "light"; lang: LangCode }) {
  const t = (dark: string, light: string) => (theme === "dark" ? dark : light);
  const level: Urgency = guidance.level in DRIVE_KEY ? guidance.level : "unknown";
  const tone = {
    stop: { box: t("bg-red-500/15 border border-red-500/40", "bg-red-50 border border-red-200"), title: t("text-red-200", "text-red-800"), body: t("text-red-200/90", "text-red-700") },
    caution: { box: t("bg-amber-500/15 border border-amber-500/30", "bg-amber-50 border border-amber-200"), title: t("text-amber-200", "text-amber-800"), body: t("text-amber-200/90", "text-amber-700") },
    normal: { box: t("glass-card", "bg-white border border-slate-200 shadow-sm"), title: t("text-slate-100", "text-slate-900"), body: t("text-slate-300", "text-slate-600") },
    unknown: { box: t("glass-card", "bg-white border border-slate-200 shadow-sm"), title: t("text-slate-100", "text-slate-900"), body: t("text-slate-300", "text-slate-600") },
  }[level];
  return (
    <div data-drive-guidance={level} className={cn("rounded-3xl p-5", tone.box)}>
      <div className={cn("text-[11px] font-medium uppercase tracking-wide", tone.body)}>{tr("driveGuidance", lang)}</div>
      <div className={cn("mt-1 text-sm font-semibold", tone.title)}>{tr(DRIVE_KEY[level], lang)}</div>
      {guidance.reason && <p className={cn("mt-1 text-sm", tone.body)}>{guidance.reason}</p>}
      <p className={cn("mt-2 text-[11px] leading-relaxed", tone.body)}>{tr("driveGuidanceNote", lang)}</p>
    </div>
  );
}

type LikelyCausesPanelProps = {
  result: ApiOk | ApiNoDefinition | null;
  theme: "dark" | "light";
  code?: string;
  symptoms?: string;
  vehicle?: { year: string; make: string; model: string; engine?: string } | null;
  onShare?: () => void;
  onDownload?: () => void;
  onSaveToHistory?: (session: DiagnosisSession) => void;
  vehicleId?: string | null;
  lang: LangCode;
  /** Follow-up answers that were already part of this diagnosis (question → answer). */
  followUpAnswers?: Record<string, string>;
  /** Ask the server for an updated diagnosis that takes these answers into account. */
  onRefine?: (answers: FollowUpAnswerPayload[]) => void;
  refining?: boolean;
  refineError?: string | null;
};

/**
 * Wrapper that only decides WHICH state to show. It owns no hooks, so it can
 * return early freely. All stateful logic lives in LikelyCausesResults, which is
 * mounted only while there are causes to show — so its hooks always run in the
 * same order (this is what used to crash the page on a second diagnosis).
 */
function LikelyCausesPanel(props: LikelyCausesPanelProps) {
  const { result, theme, lang } = props;
  const t = (dark: string, light: string) => theme === "dark" ? dark : light;

  if (result && "noDefinition" in result && result.noDefinition) {
    return (
      <div className={cn("rounded-3xl p-6", t("glass-card-strong", "bg-white border border-slate-200 shadow-sm"))}>
        <div className={cn("text-sm font-semibold", t("text-amber-200", "text-amber-800"))}>No verified definition</div>
        <p className={cn("mt-2 text-sm", t("text-slate-300", "text-slate-600"))}>{result.message}</p>
        {result.codes && result.codes.length > 0 && <CodeStatusList codes={result.codes} lang={lang} />}
      </div>
    );
  }

  // Anything that is not a complete diagnosis (including a malformed reply) shows
  // the empty state. The page never fills in a diagnosis of its own.
  if (!result || !("diagnosis" in result) || !Array.isArray(result.diagnosis?.causes) || result.diagnosis.causes.length === 0) {
    return (
      <div className={cn("rounded-3xl p-6", t("glass-card-strong", "bg-white border border-slate-200 shadow-sm"))}>
        <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("likelyCauses", lang)}</div>
        <div className={cn("mt-2 text-sm", t("text-slate-400", "text-slate-500"))}>Run a diagnostic to see causes here.</div>
      </div>
    );
  }

  // A new result gets a new key, so the results view starts from a clean state.
  return <LikelyCausesResults key={keyForResult(result)} {...props} result={result} />;
}

/** A stable number for each result object, used as a React key. */
const resultKeys = new WeakMap<object, number>();
let nextResultKey = 1;
function keyForResult(result: object): number {
  let key = resultKeys.get(result);
  if (!key) {
    key = nextResultKey++;
    resultKeys.set(result, key);
  }
  return key;
}

function LikelyCausesResults({
  result,
  theme,
  code,
  symptoms,
  vehicle,
  onShare,
  onDownload,
  onSaveToHistory,
  vehicleId,
  lang,
  followUpAnswers,
  onRefine,
  refining,
  refineError,
}: Omit<LikelyCausesPanelProps, "result"> & { result: ApiOk }) {
  const diagnosis = result.diagnosis;
  // Already ranked by the server from the model's own ranking. The page keeps that order.
  const causes = diagnosis.causes;
  const followUps = diagnosis.follow_up_questions || [];
  const limitations = diagnosis.limitations || [];

  const [openCauseId, setOpenCauseId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [guideMode, setGuideMode] = useState(false);
  const [guideCauseIdx, setGuideCauseIdx] = useState(0);
  const [guideStepIdx, setGuideStepIdx] = useState(0);
  const [guideFixMode, setGuideFixMode] = useState(false);
  const [confirmedFix, setConfirmedFix] = useState<DiagnosisSession["confirmedFix"] | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const guideRef = useRef<HTMLDivElement | null>(null);
  const t = (dark: string, light: string) => theme === "dark" ? dark : light;

  // No reset effect is needed: the panel is given a new key for every result,
  // so answers, the open cause and the guide all start fresh with it.

  function handleGuideMeClick() {
    const next = !guideMode;
    setGuideMode(next);
    if (next) setTimeout(() => guideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  /** The user's answers as plain text for the server. Unanswered questions are left out. */
  function collectAnswers(): FollowUpAnswerPayload[] {
    const out: FollowUpAnswerPayload[] = [];
    for (const q of followUps) {
      const value = (answers[q.id] || "").trim();
      if (!value) continue;
      let answer = value;
      if (q.answer_type === "yes_no") answer = YES_NO_ANSWERS.find((a) => a.id === value)?.text || "";
      else if (q.answer_type === "single_choice") answer = q.options.find((o) => o.id === value)?.label || "";
      if (answer) out.push({ question: q.question, answer });
    }
    return out;
  }

  const answeredCount = followUps.filter((q) => (answers[q.id] || "").trim()).length;

  function buildSession(): DiagnosisSession | null {
    if (!vehicleId || !vehicle) return null;
    const finalRankedCauses: DiagnosisCauseSnapshot[] = causes.map((c) => ({
      id: c.id,
      title: c.title,
      whyLikely: c.why_it_fits,
      confirm: c.checks.map((k) => k.instruction),
      fix: c.recommended_action ? [c.recommended_action] : [],
    }));
    const issueText = [code?.trim() ? `Code: ${code.trim()}` : "", symptoms?.trim() ? `Symptoms: ${symptoms.trim()}` : ""].filter(Boolean).join(" | ") || "Diagnosis";
    return {
      id: uid(),
      vehicleId,
      timestamp: new Date().toISOString(),
      issueText,
      code: code?.trim() || undefined,
      symptoms: symptoms?.trim() || undefined,
      vehicle: { year: vehicle.year, make: vehicle.make, model: vehicle.model, engine: vehicle.engine },
      followUpAnswers: followUpAnswers || {},
      finalRankedCauses,
      confirmedFix: confirmedFix || undefined,
    };
  }

  function handleSave() {
    const session = buildSession();
    if (!session || !onSaveToHistory) return;
    onSaveToHistory(session);
  }

  async function handleExportPdf() {
    const session = buildSession();
    if (!session || exportingPdf) return;
    setExportingPdf(true);
    try {
      const mod = await import("jspdf");
      const doc = new mod.jsPDF({ unit: "pt", format: "letter" });

      const marginX = 40;
      let y = 48;
      const lineGap = 14;
      const maxW = 535;

      function addWrapped(text: string, fontSize = 10, bold = false, extraGap = 0) {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(fontSize);
        const lines = doc.splitTextToSize(text, maxW);
        for (const ln of lines) {
          doc.text(ln, marginX, y);
          y += lineGap;
          if (y > 760) { doc.addPage(); y = 48; }
        }
        y += extraGap;
      }

      addWrapped("CarCode AI Diagnosis", 16, true, 10);
      addWrapped(`Vehicle: ${session.vehicle.year} ${session.vehicle.make} ${session.vehicle.model}${session.vehicle.engine ? ` (${session.vehicle.engine})` : ""}`, 11, true);
      addWrapped(`Date: ${new Date(session.timestamp).toLocaleString()}`, 10, false, 6);
      addWrapped(session.issueText, 10, false, 10);

      if (diagnosis.summary) addWrapped(diagnosis.summary, 10, false, 6);
      addWrapped(`${tr("driveGuidance", "en")}: ${tr(DRIVE_KEY[diagnosis.drive_guidance.level] || "driveUnknown", "en")}${diagnosis.drive_guidance.reason ? `. ${diagnosis.drive_guidance.reason}` : ""}`, 10, false, 10);

      if (session.confirmedFix) {
        addWrapped("Confirmed fix (from guided flow):", 11, true, 2);
        addWrapped(`${session.confirmedFix.causeTitle}: ${session.confirmedFix.fix}`, 10, false, 10);
      }

      const ansLines = Object.entries(session.followUpAnswers || {}).map(([k, v]) => `- ${k}: ${v}`);
      if (ansLines.length) {
        addWrapped("Follow-up answers:", 11, true, 2);
        addWrapped(ansLines.join("\n"), 10, false, 10);
      }

      addWrapped("Possible causes, most likely first:", 12, true, 6);
      causes.forEach((c, i) => {
        addWrapped(`${i + 1}. ${c.title} (${tr(LIKELIHOOD_KEY[c.likelihood] || "likelihoodPossible", "en")})`, 11, true, 2);
        if (c.explanation) addWrapped(c.explanation, 10, false, 2);
        if (c.why_it_fits.length) addWrapped(`Why it fits:\n- ${c.why_it_fits.join("\n- ")}`, 10, false, 2);
        if (c.checks.length) addWrapped(`How to confirm:\n- ${c.checks.map((k) => k.instruction).join("\n- ")}`, 10, false, 2);
        if (c.recommended_action) addWrapped(`Recommended next step: ${c.recommended_action}`, 10, false, 8);
        y += 6;
      });

      if (limitations.length) addWrapped(`Limits of this diagnosis:\n- ${limitations.join("\n- ")}`, 10, false, 8);

      addWrapped("Disclaimer: AI-generated guidance, not a professional inspection. These are possible causes, not a confirmed repair. Use safe lifting procedures and stop driving if the vehicle is unsafe to operate.", 9, false);

      doc.save(`carcode-diagnosis-${Date.now()}.pdf`);
    } catch {
      // ignore
    } finally {
      setExportingPdf(false);
    }
  }

  const actionButton = cn(
    "shrink-0 flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed",
    t("border border-white/10 bg-white/10 text-slate-300 hover:bg-blue-500/20 hover:text-blue-300 hover:border-blue-400/30", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300"),
  );
  const subCard = t("border border-white/10 bg-white/5", "border border-slate-200 bg-slate-50");
  const pill = (selected: boolean) =>
    cn(
      "rounded-full px-3 py-1.5 text-[11px] font-medium transition-all",
      selected
        ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30"
        : t("border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:text-blue-300", "border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-600"),
    );

  const likelihoodTone: Record<Likelihood, string> = {
    very_likely: t("bg-blue-500/25 text-blue-200 border-blue-400/40", "bg-blue-100 text-blue-800 border-blue-300"),
    likely: t("bg-blue-500/15 text-blue-300 border-blue-500/30", "bg-blue-50 text-blue-700 border-blue-200"),
    possible: t("bg-slate-500/15 text-slate-300 border-slate-500/30", "bg-slate-100 text-slate-600 border-slate-200"),
    unlikely: t("bg-slate-500/10 text-slate-400 border-slate-500/20", "bg-slate-50 text-slate-500 border-slate-200"),
  };
  const urgencyTone: Record<Urgency, string> = {
    stop: t("bg-red-500/15 text-red-300 border-red-500/30", "bg-red-50 text-red-700 border-red-200"),
    caution: t("bg-amber-500/15 text-amber-300 border-amber-500/30", "bg-amber-50 text-amber-700 border-amber-200"),
    normal: t("bg-slate-500/10 text-slate-400 border-slate-500/20", "bg-slate-50 text-slate-500 border-slate-200"),
    unknown: t("bg-slate-500/10 text-slate-400 border-slate-500/20 border-dashed", "bg-slate-50 text-slate-500 border-slate-300 border-dashed"),
  };
  const repairTone: Record<RepairLevel, string> = {
    diy_easy: t("text-emerald-400", "text-emerald-600"),
    diy_moderate: t("text-yellow-400", "text-yellow-600"),
    professional: t("text-orange-400", "text-orange-600"),
  };

  return (
    <div className="space-y-4">
      <div className={cn("rounded-3xl p-6", t("glass-card-strong", "bg-white border border-slate-200 shadow-sm"))}>
        {/* Stacked: the summary needs the full width, so the actions sit under it at every size. */}
        <div className="flex flex-col gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className={cn("text-[11px] font-medium", t("text-slate-400", "text-slate-500"))}>DIAGNOSTIC SUMMARY</div>
              {result.refined && (
                <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium", t("bg-blue-500/20 text-blue-300 border border-blue-500/30", "bg-blue-50 text-blue-700 border border-blue-200"))}>
                  {tr("updatedBasedOnAnswers", lang)}
                </span>
              )}
            </div>
            {result.codes && result.codes.length > 0 && <CodeStatusList codes={result.codes} lang={lang} />}
            {diagnosis.summary && (
              <p className={cn("mt-3 text-base font-medium leading-snug", t("text-white", "text-slate-900"))}>{diagnosis.summary}</p>
            )}
            <p className={cn("mt-2 text-sm block whitespace-normal break-normal", t("text-slate-400", "text-slate-500"))}>
              {tr("hypothesisNote", lang)}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2 min-w-0">
            <button type="button" onClick={handleGuideMeClick} className={actionButton}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18h6" />
                <path d="M10 22h4" />
                <path d="M12 2a7 7 0 0 0-4 12c.3.3.6.8.7 1.2l.3 1.6h6l.3-1.6c.1-.4.4-.9.7-1.2A7 7 0 0 0 12 2z" />
              </svg>
              {tr("guideMe", lang)}
            </button>
            <button type="button" onClick={handleSave} disabled={!vehicleId || !onSaveToHistory} className={actionButton}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              {tr("saveToHistory", lang)}
            </button>
            <button type="button" onClick={handleExportPdf} disabled={!vehicleId || exportingPdf} className={actionButton}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M8 13h8" />
                <path d="M8 17h8" />
              </svg>
              {exportingPdf ? "Exporting…" : tr("exportPdf", lang)}
            </button>
            {onDownload && (
              <button onClick={onDownload} className={actionButton}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {tr("download", lang)}
              </button>
            )}
            {onShare && (
              <button onClick={onShare} className={actionButton}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                {tr("share", lang)}
              </button>
            )}
          </div>
        </div>
      </div>

      <DriveGuidanceBanner guidance={diagnosis.drive_guidance} theme={theme} lang={lang} />

      {followUps.length > 0 && (
        <div id="refine-diagnosis" className={cn("rounded-3xl p-6", t("glass-card", "bg-white border border-slate-200 shadow-sm"))}>
          <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("refineDiagnosis", lang)}</div>
          <div className={cn("mt-1 text-xs", t("text-slate-400", "text-slate-500"))}>{tr("refineHint", lang)}</div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {followUps.map((fq) => (
              <div key={fq.id} data-follow-up={fq.answer_type} className={cn("rounded-2xl p-4", subCard)}>
                <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{fq.question}</div>
                {fq.why_it_matters && (
                  <div className={cn("mt-1 text-[11px] leading-relaxed", t("text-slate-400", "text-slate-500"))}>{fq.why_it_matters}</div>
                )}
                {fq.answer_type === "free_text" ? (
                  <input
                    type="text"
                    maxLength={200}
                    value={answers[fq.id] || ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [fq.id]: e.target.value }))}
                    placeholder={tr("typeYourAnswer", lang)}
                    aria-label={fq.question}
                    className={cn("mt-3 w-full rounded-xl px-3 py-2 text-xs transition-colors", t("glass-input", "bg-white border border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"))}
                  />
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(fq.answer_type === "yes_no" ? YES_NO_ANSWERS.map((a) => ({ id: a.id as string, label: tr(a.key, lang) })) : fq.options).map((opt) => {
                      const selected = answers[fq.id] === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setAnswers((prev) => ({ ...prev, [fq.id]: selected ? "" : opt.id }))}
                          className={pill(selected)}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!onRefine || refining || answeredCount === 0}
              onClick={() => onRefine?.(collectAnswers())}
              className="rounded-xl bg-blue-500 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-blue-500/25 transition-all hover:bg-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {refining ? tr("updatingDiagnosis", lang) : tr("updateDiagnosis", lang)}
            </button>
            {refineError && <span role="alert" className="text-xs text-red-300">{refineError}</span>}
          </div>
        </div>
      )}

      {guideMode && (
        <div ref={guideRef} className={cn("rounded-3xl p-6 transition-all duration-300", t("glass-card-strong", "bg-white border border-slate-200 shadow-sm"))}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("guideMe", lang)}</div>
              <div className={cn("mt-1 text-xs", t("text-slate-400", "text-slate-500"))}>Work through the top causes one check at a time. If a check points to the cause, we’ll show the recommended next step.</div>
            </div>
            <button
              type="button"
              onClick={() => setGuideMode(false)}
              className={cn("rounded-xl px-3 py-2 text-xs font-semibold transition-all", t("border border-white/10 bg-white/10 text-slate-300 hover:bg-white/20", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"))}
            >
              Close
            </button>
          </div>

          <div className="mt-5">
            {(() => {
              const cause = causes[Math.min(guideCauseIdx, causes.length - 1)];
              const tests = cause.checks;
              const step = tests[Math.min(guideStepIdx, Math.max(0, tests.length - 1))];
              const nextCause = () => {
                setGuideFixMode(false);
                setGuideCauseIdx((i) => Math.min(i + 1, causes.length - 1));
                setGuideStepIdx(0);
              };
              const plainButton = cn("rounded-xl px-3 py-2 text-xs font-semibold transition-all", t("border border-white/10 bg-white/10 text-slate-300 hover:bg-white/20", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"));
              return (
                <div className={cn("rounded-2xl p-4", subCard)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className={cn("text-xs font-semibold", t("text-slate-300", "text-slate-600"))}>
                        {tests.length > 0 ? `Step ${Math.min(guideStepIdx + 1, tests.length)} of ${tests.length} • ` : ""}Cause {Math.min(guideCauseIdx + 1, causes.length)} of {causes.length}
                      </div>
                      <div className={cn("mt-1 text-sm font-semibold", t("text-white", "text-slate-900"))}>{cause.title}</div>
                      {!guideFixMode ? (
                        step ? (
                          <div className="mt-3">
                            <div className={cn("text-sm", t("text-slate-300", "text-slate-600"))}>{step.instruction}</div>
                            <div className={cn("mt-1 text-[11px]", t("text-slate-400", "text-slate-500"))}>{tr(CHECK_LEVEL_KEY[step.level] || "checkProfessional", lang)}</div>
                          </div>
                        ) : (
                          <div className={cn("mt-3 text-sm", t("text-slate-500", "text-slate-400"))}>{tr("noConfirmSteps", lang)}</div>
                        )
                      ) : (
                        <div className="mt-3">
                          <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("recommendedAction", lang)}</div>
                          {cause.recommended_action ? (
                            <div className={cn("mt-2 flex items-start gap-2 text-sm", t("text-slate-300", "text-slate-600"))}>
                              <span className="min-w-0">{cause.recommended_action}</span>
                              <button
                                type="button"
                                onClick={() => setConfirmedFix({ causeId: cause.id, causeTitle: cause.title, fix: cause.recommended_action })}
                                className={cn("ml-auto shrink-0 rounded-xl px-2.5 py-1 text-[11px] font-semibold transition-all", t("border border-white/10 bg-white/10 text-slate-300 hover:bg-blue-500/20 hover:text-blue-300", "border border-slate-200 bg-white text-slate-600 hover:bg-blue-50 hover:text-blue-600"))}
                              >
                                Choose
                              </button>
                            </div>
                          ) : (
                            <div className={cn("mt-2 text-sm", t("text-slate-500", "text-slate-400"))}>{tr("noFixSteps", lang)}</div>
                          )}
                          {confirmedFix?.causeId === cause.id && (
                            <div className={cn("mt-3 rounded-xl p-3 text-xs", t("border border-emerald-500/20 bg-emerald-500/10 text-emerald-300", "border border-emerald-200 bg-emerald-50 text-emerald-800"))}>
                              Selected: {confirmedFix.fix}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 flex flex-col gap-2">
                      {!guideFixMode ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (guideStepIdx + 1 < tests.length) setGuideStepIdx(guideStepIdx + 1);
                              else nextCause();
                            }}
                            className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-md shadow-emerald-500/25 transition-all hover:bg-emerald-400"
                          >
                            Pass
                          </button>
                          <button
                            type="button"
                            onClick={() => setGuideFixMode(true)}
                            className={cn("rounded-xl px-3 py-2 text-xs font-semibold transition-all", t("border border-white/10 bg-white/10 text-slate-300 hover:bg-red-500/20 hover:text-red-300", "border border-slate-200 bg-white text-slate-600 hover:bg-red-50 hover:text-red-600"))}
                          >
                            Fail
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={nextCause} className={plainButton}>Next cause</button>
                          <button type="button" onClick={() => setGuideFixMode(false)} className={plainButton}>Back to tests</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <div className="space-y-3 [&>div]:transition-all [&>div]:duration-300 [&>div]:ease-out">
        {causes.map((c, idx) => {
          const isOpen = openCauseId === c.id;
          return (
            <div key={c.id} data-cause-rank={c.rank} className={cn("rounded-3xl animate-scale-in", t("glass-card", "bg-white border border-slate-200 shadow-sm"))} style={{ animationDelay: `${idx * 0.05}s` }}>
              <button
                type="button"
                onClick={() => setOpenCauseId(isOpen ? null : c.id)}
                aria-expanded={isOpen}
                className={cn(
                  "w-full rounded-3xl border border-transparent bg-transparent px-5 py-4 text-left transition",
                  t("hover:bg-blue-500/20 hover:border-blue-400/30", "hover:bg-blue-50 hover:border-blue-200"),
                  "focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>
                        <span className={cn("mr-1.5", t("text-slate-400", "text-slate-400"))}>{c.rank}.</span>
                        {c.title}
                      </div>
                      <span data-likelihood={c.likelihood} className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", likelihoodTone[c.likelihood] || likelihoodTone.possible)}>
                        {tr(LIKELIHOOD_KEY[c.likelihood] || "likelihoodPossible", lang)}
                      </span>
                      <span data-urgency={c.urgency} className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", urgencyTone[c.urgency] || urgencyTone.unknown)}>
                        {tr(URGENCY_KEY[c.urgency] || "urgencyUnknown", lang)}
                      </span>
                    </div>
                    {c.explanation && <div className={cn("mt-1 text-sm", t("text-slate-400", "text-slate-500"))}>{c.explanation}</div>}
                    <div className={cn("mt-2 text-xs", repairTone[c.repair_level] || repairTone.professional)}>
                      {tr(REPAIR_LEVEL_KEY[c.repair_level] || "repairProfessional", lang)}
                    </div>
                  </div>
                  <div className={cn("shrink-0 mt-1 text-sm font-semibold", t("text-slate-400", "text-slate-500"))}>{isOpen ? "−" : "+"}</div>
                </div>
              </button>

              {isOpen && (
                <div className={cn("border-t px-5 py-5", t("border-white/10", "border-slate-200"))}>
                  <div className={cn("rounded-2xl p-4", subCard)}>
                    <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("whyLikely", lang)}</div>
                    <ul className={cn("mt-2 space-y-2 text-sm", t("text-slate-300", "text-slate-600"))}>
                      {c.why_it_fits.map((w, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-2 h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                          {w}
                        </li>
                      ))}
                    </ul>
                    <div className={cn("mt-3 text-[11px] leading-relaxed", t("text-slate-400", "text-slate-500"))}>
                      This is guidance, not an inspection. If symptoms are severe or safety-related, stop driving and have the vehicle towed.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 mt-4">
                    <div className={cn("rounded-2xl p-4", subCard)}>
                      <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("howToConfirm", lang)}</div>
                      <ul className={cn("mt-2 space-y-3 text-sm", t("text-slate-300", "text-slate-600"))}>
                        {c.checks.length ? (
                          c.checks.map((k, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-2 h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                              <span className="min-w-0">
                                {k.instruction}
                                <span data-check-level={k.level} className={cn("mt-0.5 block text-[11px]", t("text-slate-400", "text-slate-500"))}>
                                  {tr(CHECK_LEVEL_KEY[k.level] || "checkProfessional", lang)}
                                </span>
                              </span>
                            </li>
                          ))
                        ) : (
                          <li className={t("text-slate-500", "text-slate-400")}>{tr("noConfirmSteps", lang)}</li>
                        )}
                      </ul>
                    </div>

                    <div className={cn("rounded-2xl p-4", subCard)}>
                      <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("recommendedAction", lang)}</div>
                      <p className={cn("mt-2 text-sm", c.recommended_action ? t("text-slate-300", "text-slate-600") : t("text-slate-500", "text-slate-400"))}>
                        {c.recommended_action || tr("noFixSteps", lang)}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {limitations.length > 0 && (
        <div className={cn("rounded-3xl p-5", t("glass-card", "bg-white border border-slate-200 shadow-sm"))}>
          <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("diagnosisLimits", lang)}</div>
          <ul className={cn("mt-2 space-y-1.5 text-sm", t("text-slate-400", "text-slate-500"))}>
            {limitations.map((l, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0" />
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function useDropPosition() {
  const [style, setStyle] = useState<React.CSSProperties>({});
  function update(el: HTMLInputElement | null) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setStyle({
      position: "fixed",
      top: r.bottom + 6,
      left: r.left,
      width: r.width,
      zIndex: 9999,
    });
  }
  return { style, update };
}

function Toast({ message, visible }: { message: string; visible: boolean }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999]">
      <div className={cn(
        "rounded-2xl bg-blue-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/30",
        visible ? "animate-toast-in" : "animate-toast-out"
      )}>
        {message}
      </div>
    </div>
  );
}


export default function Home() {
  const { data: session, status: sessionStatus } = useSession();
  // Until we know whether this is a guest or a signed-in user, no per-user data is loaded.
  const sessionReady = sessionStatus !== "loading";
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [tab, setTab] = useState<"diagnose" | "garage" | "service">("garage");
  const [serviceVehicleFilter, setServiceVehicleFilter] = useState<string | null>(null);
  const [vehiclePickerOpen, setVehiclePickerOpen] = useState(false);
  const {
    vehicles: garage,
    activeId,
    setActiveId,
    syncing: garageSyncing,
    addVehicle: addGarageVehicle,
    deleteVehicle: deleteGarageVehicle,
    guestVehicles,
    importGuestVehicles,
    dismissGuestVehicles,
  } = useGarageVehicles({ userId: session?.user?.id, ready: sessionReady });
  const [importingGuest, setImportingGuest] = useState(false);
  const [guestImportNote, setGuestImportNote] = useState("");


  const theme = "dark" as const;
  const t = (dark: string, _light: string) => dark;

  const [lang, setLang] = useState<LangCode>("en");
  const [langMenuOpen, setLangMenuOpen] = useState(false);

  const [toastMsg, setToastMsg] = useState("");
  const [toastVisible, setToastVisible] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState<{open:boolean, title:string, message:string, confirmLabel?:string, onConfirm:()=>void | Promise<void>} | null>(null);

  const [maintenanceRecords, setMaintenanceRecords] = useState<Record<string, MaintenanceRecord[]>>({});
  // Nothing is written back to storage until the stored copy has been read,
  // otherwise the initial empty state could overwrite saved data.
  const [maintenanceLoaded, setMaintenanceLoaded] = useState(false);

  const [diagnosisSessions, setDiagnosisSessions] = useState<Record<string, DiagnosisSession[]>>({});
  const diagnosisStorageKey = session?.user?.id
    ? `carcode_diagnosis_sessions_v1:user:${session.user.id}`
    : DIAGNOSIS_ANON_STORAGE_KEY;
  // Which key `diagnosisSessions` was loaded from; writes only go back to that key.
  const [diagnosisLoadedKey, setDiagnosisLoadedKey] = useState<string | null>(null);

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  const garageFormRef = useRef<HTMLDivElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2000);
    setTimeout(() => setToastMsg(""), 2300);
  }

  const activeVehicle = useMemo(
    () => garage.find((v) => v.id === activeId) || null,
    [garage, activeId]
  );

  const [result, setResult] = useState<ApiOk | ApiNoDefinition | null>(null);
  const [lastCode, setLastCode] = useState("");
  const [lastSymptoms, setLastSymptoms] = useState("");
  const [lastVehicle, setLastVehicle] = useState<{ year: string; make: string; model: string; engine?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The last diagnosis request, kept so follow-up answers can be added to it.
  const [lastRequest, setLastRequest] = useState<DiagnosePayload | null>(null);
  const [lastFollowUps, setLastFollowUps] = useState<{ question: string; answer: string }[]>([]);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(true);


  useEffect(() => {
    try {
      const rawMaint = localStorage.getItem(MAINTENANCE_STORAGE_KEY);
      if (rawMaint) {
        const parsed = JSON.parse(rawMaint);
        if (parsed && typeof parsed === "object") setMaintenanceRecords(parsed);
      }
    } catch {}
    setMaintenanceLoaded(true);
    // Diagnosis sessions are loaded in a dedicated effect (keyed by user/anon).
    try {
      if (!localStorage.getItem("carcode_onboarded_v1")) {
        setShowOnboarding(true);
      }
    } catch {}
    try {
      const savedLang = localStorage.getItem("carcode_lang") as LangCode;
      if (savedLang && LANGUAGES.some(l => l.code === savedLang)) setLang(savedLang);
    } catch {}

    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const handleInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as InstallPromptEvent);
      const dismissed = localStorage.getItem("carcode_install_dismissed");
      if (!dismissed && isMobile) setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handleInstall);


    return () => window.removeEventListener("beforeinstallprompt", handleInstall);
  }, []);

  // Saved diagnoses live only in this browser (one list for guests, one per
  // account). Switching between them just changes which list is shown —
  // nothing is deleted on sign-in or sign-out.
  useEffect(() => {
    if (typeof window === "undefined" || !sessionReady) return;
    setDiagnosisSessions(readDiagnosisSessions(diagnosisStorageKey));
    setDiagnosisLoadedKey(diagnosisStorageKey);
  }, [diagnosisStorageKey, sessionReady]);

  useEffect(() => {
    if (!maintenanceLoaded) return;
    try {
      localStorage.setItem(MAINTENANCE_STORAGE_KEY, JSON.stringify(maintenanceRecords));
    } catch {}
  }, [maintenanceLoaded, maintenanceRecords]);

  useEffect(() => {
    if (diagnosisLoadedKey !== diagnosisStorageKey) return;
    try {
      localStorage.setItem(diagnosisStorageKey, JSON.stringify(diagnosisSessions));
    } catch {}
  }, [diagnosisLoadedKey, diagnosisSessions, diagnosisStorageKey]);

  /**
   * "Import vehicles from this device": copy guest vehicles into the signed-in
   * account, then move their on-device service records and saved diagnoses
   * over to the new vehicle ids so that history follows the vehicle.
   */
  async function handleImportGuestVehicles() {
    if (importingGuest) return;
    setImportingGuest(true);
    setGuestImportNote("");
    try {
      const outcome = await importGuestVehicles();

      if (outcome.imported.length > 0) {
        const idMap = new Map(outcome.imported.map(({ from, to }) => [from.id, to.id]));

        setMaintenanceRecords((prev) => {
          const next = { ...prev };
          for (const [oldId, newId] of idMap) {
            const moved = (next[oldId] || []).map((r) => ({ ...r, vehicleId: newId }));
            if (moved.length) next[newId] = [...moved, ...(next[newId] || [])];
            delete next[oldId];
          }
          return next;
        });

        const guestSessions = readDiagnosisSessions(DIAGNOSIS_ANON_STORAGE_KEY);
        const remainingGuestSessions = { ...guestSessions };
        const movedSessions: Record<string, DiagnosisSession[]> = {};
        for (const [oldId, newId] of idMap) {
          const list = (guestSessions[oldId] || []).map((s) => ({ ...s, vehicleId: newId }));
          if (list.length) movedSessions[newId] = list;
          delete remainingGuestSessions[oldId];
        }
        if (Object.keys(movedSessions).length > 0) {
          setDiagnosisSessions((prev) => {
            const next = { ...prev };
            for (const [newId, list] of Object.entries(movedSessions)) next[newId] = [...list, ...(next[newId] || [])];
            return next;
          });
          try {
            localStorage.setItem(DIAGNOSIS_ANON_STORAGE_KEY, JSON.stringify(remainingGuestSessions));
          } catch {}
        }
      }

      const parts: string[] = [];
      if (outcome.imported.length) parts.push(`${outcome.imported.length} ${tr("importResultImported", lang)}`);
      if (outcome.duplicates.length) parts.push(`${outcome.duplicates.length} ${tr("importResultDuplicates", lang)}`);
      if (outcome.failed.length) parts.push(`${outcome.failed.length} ${tr("importResultFailed", lang)}`);
      setGuestImportNote(parts.join(" · "));
    } catch {
      setGuestImportNote(tr("importResultError", lang));
    } finally {
      setImportingGuest(false);
    }
  }

  function saveDiagnosisSession(sessionToSave: DiagnosisSession) {
    if (!sessionToSave?.vehicleId) return;
    setDiagnosisSessions((prev) => ({
      ...prev,
      [sessionToSave.vehicleId]: [sessionToSave, ...(prev[sessionToSave.vehicleId] || [])],
    }));
    showToast(tr("savedToHistory", lang));
  }

  function deleteDiagnosisSession(vehicleId: string, sessionId: string) {
    if (!vehicleId || !sessionId) return;
    setDiagnosisSessions((prev) => ({
      ...prev,
      [vehicleId]: (prev[vehicleId] || []).filter((s) => s.id !== sessionId),
    }));
  }

  useEffect(() => {
    try {
      localStorage.setItem("carcode_lang", lang);
    } catch {}
  }, [lang]);

  function addMaintenanceRecord(vehicleId: string, fd: FormData) {
    const mileageUnitRaw = String(fd.get("maint_mileage_unit") || "km").toLowerCase();
    const mileageUnit: "km" | "mi" = mileageUnitRaw === "mi" ? "mi" : "km";
    const mileageRaw = String(fd.get("maint_mileage") || "").trim();
    const mileageValue = mileageRaw ? Number(mileageRaw) : undefined;
    if (mileageValue !== undefined && (!Number.isFinite(mileageValue) || mileageValue <= 0)) {
      showToast("Mileage must be a positive number.");
      return;
    }
    const mileageKm =
      mileageValue === undefined ? undefined : mileageUnit === "mi" ? mileageValue * 1.60934 : mileageValue;

    const rec: MaintenanceRecord = {
      id: uid(),
      vehicleId,
      type: String(fd.get("maint_type") || "Other"),
      date: String(fd.get("maint_date") || new Date().toISOString().slice(0, 10)),
      mileageValue,
      mileageUnit,
      mileageKm,
      notes: String(fd.get("maint_notes") || ""),
    };
    setMaintenanceRecords((prev) => ({
      ...prev,
      [vehicleId]: [rec, ...(prev[vehicleId] || [])],
    }));
    showToast(tr("maintenanceAdded", lang));
  }

  function deleteMaintenanceRecord(vehicleId: string, recordId: string) {
    setMaintenanceRecords((prev) => ({
      ...prev,
      [vehicleId]: (prev[vehicleId] || []).filter((r) => r.id !== recordId),
    }));
  }

  async function addVehicle(fd: FormData) {
    const year = String(fd.get("year") || "").trim();
    const make = String(fd.get("make") || "").trim();
    const model = String(fd.get("model") || "").trim();
    const engine = String(fd.get("engine") || "").trim();
    const vin = String(fd.get("vin") || "").trim();

    if (!year || !make || !model) return;

    try {
      await addGarageVehicle({
        year,
        make,
        model,
        engine: engine || undefined,
        vin: vin || undefined,
      });
      setTab("diagnose");
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : "Failed to save vehicle.");
    }
  }

  async function removeVehicle(id: string) {
    await deleteGarageVehicle(id);
    setMaintenanceRecords((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setServiceVehicleFilter((prev) => (prev === id ? null : prev));
  }

  /**
   * One request to /api/diagnose. Returns the result or a message that is safe
   * to show. Never throws, so a failed diagnosis cannot crash the page.
   */
  async function postDiagnosis(payload: DiagnosePayload): Promise<{ ok: true; data: ApiOk | ApiNoDefinition } | { ok: false; error: string }> {
    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const raw = await res.text();
      let data: unknown;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        return { ok: false, error: res.ok ? "Invalid response from server." : `Request failed (${res.status}).` };
      }
      const body = (data && typeof data === "object" ? data : {}) as Partial<ApiOk> & Partial<ApiNoDefinition> & Partial<ApiErr>;

      if (!res.ok) return { ok: false, error: typeof body.error === "string" ? body.error : "Request failed." };
      // Only a complete result is accepted. Anything else is an error, not a diagnosis.
      if (body.noDefinition === true || Array.isArray(body.diagnosis?.causes)) {
        return { ok: true, data: body as ApiOk | ApiNoDefinition };
      }
      return { ok: false, error: "Invalid response from server." };
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your internet connection and try again." };
    }
  }

  async function runDiagnostic(fd: FormData) {
    setLoading(true);
    setError(null);
    setRefineError(null);
    setResult(null);
    setHasSearched(true);

    if (!activeVehicle) {
      setError(tr("addVehicleFirst", lang));
      setLoading(false);
      setTab("garage");
      return;
    }

    const code = String(fd.get("code") || "").trim();
    const symptoms = String(fd.get("symptoms") || "").trim();
    const mileage = String(fd.get("mileage") || "").trim();
    const mileageUnit = String(fd.get("mileageUnit") || "km") === "mi" ? "mi" : "km";

    if (!code && !symptoms) {
      setError(tr("enterCodeOrSymptom", lang));
      setLoading(false);
      return;
    }

    setLastCode(code);
    setLastSymptoms(symptoms);
    setLastVehicle({ year: activeVehicle.year, make: activeVehicle.make, model: activeVehicle.model, engine: activeVehicle.engine });

    const payload: DiagnosePayload = {
      year: activeVehicle.year,
      make: activeVehicle.make,
      model: activeVehicle.model,
      engine: activeVehicle.engine || "",
      // Used on the server to look up vehicle details. It is not sent to the AI model.
      vin: activeVehicle.vin || "",
      mileage,
      mileageUnit,
      code,
      symptoms,
      lang,
    };
    setLastRequest(payload);
    setLastFollowUps([]);

    const outcome = await postDiagnosis(payload);
    if (outcome.ok) {
      setResult(outcome.data);
      setSearchPanelOpen(false);
    } else {
      setError(outcome.error);
    }
    setLoading(false);
  }

  /**
   * Ask for an updated diagnosis that takes the user's follow-up answers into
   * account. The ranking always comes from the server; nothing is re-ranked in
   * the browser. If the update fails, the current diagnosis stays on screen.
   */
  async function refineDiagnosis(newAnswers: { question: string; answer: string }[]) {
    if (!lastRequest || refining || newAnswers.length === 0) return;
    const followUps = [...lastFollowUps, ...newAnswers].slice(-6);
    setRefining(true);
    setRefineError(null);
    const outcome = await postDiagnosis({ ...lastRequest, lang, followUps });
    if (outcome.ok) {
      setResult(outcome.data);
      setLastFollowUps(followUps);
    } else {
      setRefineError(outcome.error);
    }
    setRefining(false);
  }

  function generateShareText(): string {
    const veh = lastVehicle || activeVehicle || { year: "", make: "", model: "", engine: "" };
    const lines: string[] = [
      "CarCode AI Diagnosis",
      `Vehicle: ${veh.year} ${veh.make} ${veh.model}${veh.engine ? ` (${veh.engine})` : ""}`,
      `Code: ${lastCode || "N/A"} | Symptoms: ${lastSymptoms || "N/A"}`,
      "---",
    ];
    if (result && "noDefinition" in result) {
      lines.push(result.message, "");
    } else if (result && "diagnosis" in result) {
      const d = result.diagnosis;
      if (d.summary) lines.push(d.summary);
      lines.push(`${tr("driveGuidance", lang)}: ${tr(DRIVE_KEY[d.drive_guidance.level] || "driveUnknown", lang)}${d.drive_guidance.reason ? `. ${d.drive_guidance.reason}` : ""}`, "");
      d.causes.forEach((c) => {
        lines.push(`${c.rank}. ${c.title} [${tr(LIKELIHOOD_KEY[c.likelihood] || "likelihoodPossible", lang)}] [${tr(URGENCY_KEY[c.urgency] || "urgencyUnknown", lang)}]`);
        if (c.explanation) lines.push(`  ${c.explanation}`);
        if (c.why_it_fits.length) lines.push(`  ${tr("whyLikely", lang)}: ${c.why_it_fits.join("; ")}`);
        if (c.checks.length) lines.push(`  ${tr("howToConfirm", lang)}: ${c.checks.map((k) => k.instruction).join("; ")}`);
        if (c.recommended_action) lines.push(`  ${tr("recommendedAction", lang)}: ${c.recommended_action}`);
        lines.push("");
      });
      if (d.limitations.length) lines.push(`${tr("diagnosisLimits", lang)}: ${d.limitations.join("; ")}`, "");
      lines.push(tr("hypothesisNote", lang));
    }
    return lines.join("\n");
  }

  function handleShare() {
    const text = generateShareText();
    navigator.clipboard.writeText(text).then(() => {
      showToast(tr("copiedToClipboard", lang));
    }).catch(() => {
      showToast(tr("failedToCopy", lang));
    });
  }

  function handleDownload() {
    const text = generateShareText();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `carcode-diagnosis-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Report downloaded!");
  }

  const [gYear, setGYear] = useState("");
  const [gMake, setGMake] = useState("");
  const [makeConfirmed, setMakeConfirmed] = useState(false);
  const [gModel, setGModel] = useState("");
  const [gVin, setGVin] = useState("");
  const [gEngine, setGEngine] = useState("");

  const [makeOptions, setMakeOptions] = useState<{ id: number; name: string }[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [engineOptions, setEngineOptions] = useState<string[]>([]);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years: string[] = [];
    for (let y = currentYear; y >= 1985; y--) years.push(String(y));
    return years;
  }, []);

  const [vinStatus, setVinStatus] = useState<
    | { kind: "idle" | "loading" }
    | { kind: "ok" | "warn"; vehicle: string }
    | { kind: "error"; code: "invalid_format" | "not_recognized" | "unavailable" }
  >({ kind: "idle" });

  const makeQ = useDebouncedValue(gMake, 150);
  const modelQ = useDebouncedValue(gModel, 200);
  const vinQ = useDebouncedValue(gVin, 250);

  useEffect(() => {
    if (!makeQ.trim() || makeQ.trim().length < 1) { setMakeOptions([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/vehicles/makes?q=${encodeURIComponent(makeQ.trim())}`);
        const d = await r.json();
        if (cancelled) return;
        const raw = Array.isArray(d.makes) ? d.makes : [];
        const items = raw
          .map((entry: unknown) => {
            if (typeof entry === "string") return { id: 0, name: entry };
            const m = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            const name = String(m.name ?? m.MakeName ?? m.Make_Name ?? "").trim();
            const id = Number(m.id ?? m.MakeId ?? m.Make_ID ?? 0);
            return id && name ? { id, name } : null;
          })
          .filter((x: { id: number; name: string } | null): x is { id: number; name: string } => x != null && x.name !== "");
        setMakeOptions(items);
      } catch { if (!cancelled) setMakeOptions([]); }
    })();
    return () => { cancelled = true; };
  }, [makeQ]);

  useEffect(() => {
    if (!makeConfirmed || !gMake.trim()) {
      setModelOptions([]);
      return;
    }
    let cancelled = false;
    async function run() {
      const make = gMake.trim();
      let url = `/api/vehicles/models?make=${encodeURIComponent(make)}`;
      if (gYear.trim()) url += `&year=${encodeURIComponent(gYear.trim())}`;
      if (modelQ.trim()) url += `&q=${encodeURIComponent(modelQ.trim())}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!cancelled) setModelOptions(Array.isArray(d.models) ? d.models : []);
    }
    run().catch(() => { if (!cancelled) setModelOptions([]); });
    return () => { cancelled = true; };
  }, [makeConfirmed, gMake, gYear, modelQ]);

  // Engine is free text. The engine lookup this form used to call depended on a
  // third-party API that no longer exists, so the only suggestions offered are
  // the ones decoded from a VIN (see the VIN effect below).

  function selectModel(m: string) {
    setGModel(m);
    setModelOptions([]);
  }

  // VIN decode. Only a complete, well-formed 17-character VIN is sent: partial
  // VINs used to be decoded from the 11th character on, which filled the form
  // with guesses. A decoded VIN is authoritative, so it replaces what was typed.
  useEffect(() => {
    const vin = normalizeVin(vinQ);
    if (vin.length < 17) {
      setVinStatus({ kind: "idle" });
      return;
    }
    if (!isValidVinFormat(vin)) {
      setVinStatus({ kind: "error", code: "invalid_format" });
      return;
    }

    let cancelled = false;
    setVinStatus({ kind: "loading" });
    (async () => {
      try {
        const r = await fetch(`/api/vehicles/vin?vin=${encodeURIComponent(vin)}`);
        const data = (await r.json()) as {
          ok?: boolean;
          decoded?: { year?: string; make?: string; model?: string } | null;
          suggestions?: unknown;
          code?: string;
        };
        if (cancelled) return;

        const decoded = data?.decoded;
        if (!data?.ok || !decoded?.year || !decoded?.make || !decoded?.model) {
          setVinStatus({ kind: "error", code: data?.code === "unavailable" ? "unavailable" : "not_recognized" });
          return;
        }

        const suggestions = Array.isArray(data.suggestions)
          ? data.suggestions.filter((s): s is string => typeof s === "string" && s.length > 0)
          : [];
        setGYear(decoded.year);
        setGMake(decoded.make);
        setMakeConfirmed(true);
        setGModel(decoded.model);
        setEngineOptions(suggestions);
        setGEngine(suggestions[0] ?? "");
        setVinStatus({
          kind: data.code === "check_digit" ? "warn" : "ok",
          vehicle: `${decoded.year} ${decoded.make} ${decoded.model}`,
        });
      } catch {
        if (!cancelled) setVinStatus({ kind: "error", code: "unavailable" });
      }
    })();
    return () => { cancelled = true; };
  }, [vinQ]);

  const quickSymptoms = [
    { label: tr("checkEngineLight", lang), value: tr("checkEngineLightDesc", lang) },
    { label: tr("strangeNoise", lang), value: tr("strangeNoiseDesc", lang) },
    { label: tr("wontStart", lang), value: tr("wontStartDesc", lang) },
    { label: tr("overheating", lang), value: tr("overheatingDesc", lang) },
    { label: tr("roughIdle", lang), value: tr("roughIdleDesc", lang) },
    { label: tr("poorFuelEconomy", lang), value: tr("poorFuelEconomyDesc", lang) },
  ];

  const [symptomsValue, setSymptomsValue] = useState("");


  if (!mounted) return <main className="min-h-screen bg-[#0f172a]" />;

  const inputClass = t(
    "glass-input",
    "bg-slate-50 border border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
  );

  const cardClass = t("glass-card", "bg-white border border-slate-200 shadow-sm");
  const cardStrongClass = t("glass-card-strong", "bg-white border border-slate-200 shadow-sm");
  const dropdownClass = t("glass-dropdown", "bg-white border-slate-200 border shadow-lg");

  return (
    <main className={cn(
      "relative min-h-screen transition-colors duration-300 overflow-x-hidden",
      t("text-slate-100", "bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900")
    )}>
      {theme === "dark" && (
        <div className="mesh-background">
          <div className="mesh-blob mesh-blob-1" />
          <div className="mesh-blob mesh-blob-2" />
          <div className="mesh-blob mesh-blob-3" />
          <div className="mesh-blob mesh-blob-4" />
        </div>
      )}

      {loading && (
        <div className={cn("fixed inset-0 z-50 backdrop-blur-md", t("bg-slate-900/50", "bg-white/60"))}>
          <div className="mx-auto mt-16 max-w-4xl px-6">
            <CarScanLoader theme={theme} vehicle={activeVehicle} lang={lang} />
          </div>
        </div>
      )}

      <Toast message={toastMsg} visible={toastVisible} />

      {confirmDialog && (
        <ConfirmDialog
          open={confirmDialog.open}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
          theme={theme}
          lang={lang}
        />
      )}

      {showOnboarding && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center backdrop-blur-md" style={{ background: theme === "dark" ? "rgba(15,23,42,0.8)" : "rgba(255,255,255,0.8)" }}>
          <div className={cn("w-full max-w-md rounded-3xl p-8 animate-scale-in", t("glass-card-strong", "bg-white border border-slate-200 shadow-xl"))}>
            <div className="text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500 shadow-lg shadow-blue-500/30">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                  <path d="M9 17h6" />
                  <path d="M14 8V3" />
                  <path d="M10 5h8" />
                </svg>
              </div>
              <h2 className={cn("mt-5 text-2xl font-bold tracking-tight", t("text-white", "text-slate-900"))}>{tr("welcomeTitle", lang)}</h2>
              <p className={cn("mt-2 text-sm", t("text-slate-400", "text-slate-500"))}>{tr("welcomeSubtitle", lang)}</p>
            </div>
            <div className="mt-6 space-y-3">
              {[
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>, title: tr("smartDiagnostics", lang), desc: tr("smartDiagDesc", lang) },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>, title: tr("yourGarage", lang), desc: tr("garageDesc", lang) },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>, title: tr("codeLibrary", lang), desc: tr("codeLibDesc", lang) },
              ].map((f) => (
                <div key={f.title} className={cn("flex items-start gap-3 rounded-2xl p-3", t("border border-white/5 bg-white/5", "border border-slate-100 bg-slate-50"))}>
                  <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", t("bg-blue-500/20", "bg-blue-50"))}>{f.icon}</div>
                  <div>
                    <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{f.title}</div>
                    <div className={cn("text-xs", t("text-slate-400", "text-slate-500"))}>{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => { setShowOnboarding(false); try { localStorage.setItem("carcode_onboarded_v1", "1"); } catch {} }}
              className="mt-6 w-full rounded-2xl bg-blue-500 text-white py-3.5 text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400 hover:shadow-xl"
            >
              {tr("getStarted", lang)}
            </button>
          </div>
        </div>
      )}

      <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6 py-4 sm:py-10 overflow-x-hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-500 shadow-lg shadow-blue-500/30 animate-float">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                <path d="M9 17h6" />
                <path d="M14 8V3" />
                <path d="M10 5h8" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className={cn("text-lg sm:text-2xl font-bold tracking-tight bg-gradient-to-r bg-clip-text text-transparent truncate", t("from-white to-blue-200", "from-slate-900 to-blue-600"))}>{tr("appTitle", lang)}</h1>
              <p className={cn("text-xs sm:text-sm truncate", t("text-slate-400", "text-slate-500"))}>{tr("appSubtitle", lang)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="relative">
              <button
                onClick={() => setLangMenuOpen(!langMenuOpen)}
                className={cn(
                  "flex h-9 sm:h-10 items-center gap-1 px-2 sm:px-3 rounded-xl transition-all text-sm font-medium",
                  t("border border-white/10 bg-white/10 text-slate-300 hover:bg-white/20", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100")
                )}
              >
                <span>{LANGUAGES.find(l => l.code === lang)?.flag}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              {langMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setLangMenuOpen(false)} />
                  <div className={cn("absolute right-0 top-full mt-2 z-50 rounded-xl shadow-xl overflow-hidden w-44", t("glass-dropdown", "bg-white border border-slate-200 shadow-lg"))}>
                    {LANGUAGES.map((l) => (
                      <button
                        key={l.code}
                        onClick={() => { setLang(l.code); setLangMenuOpen(false); }}
                        className={cn(
                          "w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 transition-colors",
                          lang === l.code ? "bg-blue-500 text-white" : t("text-slate-200 hover:bg-white/10", "text-slate-700 hover:bg-slate-50")
                        )}
                      >
                        <span>{l.flag}</span>
                        <span>{l.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <AuthButtons theme={theme} />
          </div>
        </div>

        <div className={cn("mt-4 flex items-center gap-1 rounded-2xl p-1 overflow-x-auto", cardClass)}>
          {(["garage", "diagnose", "service"] as const).map((tabName) => (
            <button
              key={tabName}
              onClick={() => setTab(tabName)}
              className={cn(
                "rounded-xl px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold transition-all flex-1 whitespace-nowrap",
                tab === tabName
                  ? "bg-blue-500 text-white shadow-md shadow-blue-500/30"
                  : t("text-slate-400 hover:bg-white/10 hover:text-white", "text-slate-500 hover:bg-slate-100 hover:text-slate-900")
              )}
            >
              {tabName === "diagnose" ? tr("diagnose", lang) : tabName === "garage" ? tr("garage", lang) : tr("service", lang)}
            </button>
          ))}
        </div>

        <div className="mt-4 relative z-30">
          {activeVehicle ? (
            <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 sm:px-5 py-4 overflow-visible", cardStrongClass)}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 shrink-0 rounded-full bg-white/10 flex items-center justify-center overflow-hidden relative">
                  {(() => {
                    const labelRaw = (activeVehicle as { label?: string })?.label;
                    const make =
                      activeVehicle?.make ??
                      (activeVehicle as { vehicle?: { make?: string } })?.vehicle?.make ??
                      (typeof labelRaw === "string" ? labelRaw.split(" ")[1] ?? "" : "") ??
                      "";
                    const logoSrc = getMakeLogo(make);
                    return (
                      <>
                        {logoSrc ? (
                          <img
                            src={logoSrc}
                            alt={`${make} logo`}
                            className="h-7 w-7 object-contain"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                              const fallback = e.currentTarget.parentElement?.querySelector("[data-make-fallback]") as HTMLElement | null;
                              if (fallback) fallback.style.display = "flex";
                            }}
                            onLoad={(e) => {
                              e.currentTarget.style.display = "block";
                              const fallback = e.currentTarget.parentElement?.querySelector("[data-make-fallback]") as HTMLElement | null;
                              if (fallback) fallback.style.display = "none";
                            }}
                          />
                        ) : null}
                        <span
                          data-make-fallback
                          className={`absolute inset-0 h-full w-full flex items-center justify-center text-sm font-semibold text-white/90 ${logoSrc ? "hidden" : ""}`}
                        >
                          {(make || "?")[0].toUpperCase()}
                        </span>
                      </>
                    );
                  })()}
                </div>
                <div className="min-w-0">
                  <div className={cn("text-[10px] font-semibold uppercase tracking-wider", t("text-blue-400", "text-blue-600"))}>{tr("activeVehicle", lang)}</div>
                  <div className={cn("text-sm font-semibold truncate", t("text-white", "text-slate-900"))}>
                    {activeVehicle.year} {activeVehicle.make} {activeVehicle.model}
                    {activeVehicle.engine ? ` (${activeVehicle.engine})` : ""}
                  </div>
                </div>
              </div>
              <div className="relative shrink-0">
                <button onClick={() => setVehiclePickerOpen(!vehiclePickerOpen)} className={cn("rounded-xl px-4 py-2 text-sm font-semibold transition-all", t("border border-white/10 bg-white/10 text-blue-300 hover:bg-blue-500 hover:text-white hover:border-blue-500 hover:shadow-md hover:shadow-blue-500/20", "border border-slate-200 bg-slate-50 text-blue-600 hover:bg-blue-500 hover:text-white hover:border-blue-500"))}>{tr("change", lang)}</button>
                {vehiclePickerOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setVehiclePickerOpen(false)} />
                    <div className={cn("absolute right-0 top-full mt-2 z-50 rounded-xl shadow-xl overflow-hidden w-64", t("glass-dropdown", "bg-white border border-slate-200 shadow-lg"))}>
                      {garage.filter(v => v.id !== activeId).length === 0 ? (
                        <div className={cn("px-4 py-3 text-xs text-center", t("text-slate-400", "text-slate-500"))}>{tr("noOtherVehicles", lang)}</div>
                      ) : (
                        garage.filter(v => v.id !== activeId).map((v) => (
                          <button
                            key={v.id}
                            onClick={() => { setActiveId(v.id); setVehiclePickerOpen(false); }}
                            className={cn("w-full flex items-center gap-3 px-4 py-3 text-left transition-all", t("hover:bg-white/10", "hover:bg-slate-50"))}
                          >
                            <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", t("bg-white/10", "bg-slate-100"))}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={theme === "dark" ? "#94a3b8" : "#64748b"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                                <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                                <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                                <path d="M9 17h6" />
                              </svg>
                            </div>
                            <div className="min-w-0">
                              <div className={cn("text-sm font-semibold truncate", t("text-white", "text-slate-900"))}>{v.year} {v.make} {v.model}</div>
                              {v.engine && <div className={cn("text-[10px] truncate", t("text-slate-400", "text-slate-500"))}>{v.engine}</div>}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className={cn("rounded-2xl px-5 py-4", cardClass)} style={{ borderColor: t("rgba(251, 191, 36, 0.2)", "#fde68a") }}>
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                    <path d="M10.363 3.818l-7.329 12.952A1.5 1.5 0 0 0 4.34 19h15.32a1.5 1.5 0 0 0 1.306-2.23l-7.329-12.952a1.5 1.5 0 0 0-2.674 0z" />
                  </svg>
                </div>
                <div>
                  <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("noVehicleSelected", lang)}</div>
                  <div className={cn("text-xs", t("text-slate-400", "text-slate-500"))}>{tr("addOneInGarage", lang)}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {tab === "diagnose" ? (
          <div key="tab-diagnose" className="mt-8 animate-slide-in">
            {hasSearched && !searchPanelOpen ? (
              <div className="space-y-6">
                <div className="animate-scale-in">
                  <LikelyCausesPanel
                    result={result}
                    theme={theme}
                    code={lastCode}
                    symptoms={lastSymptoms}
                    vehicle={activeVehicle}
                    vehicleId={activeVehicle?.id}
                    onSaveToHistory={saveDiagnosisSession}
                    onShare={result ? handleShare : undefined}
                    onDownload={result ? handleDownload : undefined}
                    followUpAnswers={Object.fromEntries(lastFollowUps.map((f) => [f.question, f.answer]))}
                    onRefine={refineDiagnosis}
                    refining={refining}
                    refineError={refineError}
                    lang={lang}
                  />
                </div>

                <button
                  onClick={() => { setSearchPanelOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  className={cn(
                    "w-full rounded-2xl py-3.5 px-5 flex items-center justify-center gap-3 text-sm font-semibold transition-all",
                    t(
                      "border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:bg-blue-500/10 hover:text-blue-300 backdrop-blur-xl",
                      "border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 shadow-sm"
                    )
                  )}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                  {tr("searchNewIssue", lang)}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[440px_1fr]">
                <div className="space-y-6 animate-fade-in-up">
                  <div className={cn("rounded-3xl p-5 sm:p-6", cardStrongClass)}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/20">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.3-4.3" />
                          </svg>
                        </div>
                        <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("searchIssue", lang)}</div>
                      </div>
                      {hasSearched && (
                        <button onClick={() => setSearchPanelOpen(false)} className={cn("rounded-lg p-1.5 transition-colors", t("text-slate-400 hover:text-white hover:bg-white/10", "text-slate-400 hover:text-slate-700 hover:bg-slate-100"))}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18" />
                            <path d="M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <div className={cn("mt-1 ml-9 text-xs", t("text-slate-400", "text-slate-500"))}>{tr("enterCodeOrDescribe", lang)}</div>

                    <form className="mt-5 grid gap-3" onSubmit={(e) => { e.preventDefault(); runDiagnostic(new FormData(e.currentTarget)); }}>
                      <input name="code" maxLength={120} autoComplete="off" placeholder={tr("codePlaceholder", lang)} className={cn(inputClass, "rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")} />
                      <textarea name="symptoms" maxLength={800} placeholder={tr("symptomsPlaceholder", lang)} value={symptomsValue} onChange={(e) => setSymptomsValue(e.target.value)} className={cn(inputClass, "min-h-[100px] rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors resize-none")} />
                      <div className="flex gap-2">
                        <input
                          name="mileage"
                          inputMode="numeric"
                          type="number"
                          min={1}
                          max={2000000}
                          step={1}
                          placeholder={tr("mileageOptional", lang)}
                          aria-label={tr("mileageOptional", lang)}
                          className={cn(inputClass, "w-full rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                        />
                        <select
                          name="mileageUnit"
                          defaultValue="km"
                          className={cn(inputClass, "rounded-2xl px-3 py-3 text-sm transition-colors appearance-none")}
                          style={{ colorScheme: "dark" }}
                          aria-label="Mileage unit"
                        >
                          <option value="km" className="bg-slate-800 text-slate-200">km</option>
                          <option value="mi" className="bg-slate-800 text-slate-200">mi</option>
                        </select>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {quickSymptoms.map((qs) => (
                          <button
                            key={qs.label}
                            type="button"
                            onClick={() => setSymptomsValue(qs.value)}
                            className={cn(
                              "rounded-full px-3 py-1 text-[11px] font-medium transition-all",
                              t(
                                "border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:bg-blue-500/20 hover:text-blue-300",
                                "border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
                              )
                            )}
                          >
                            {qs.label}
                          </button>
                        ))}
                      </div>

                      <button type="submit" disabled={loading} className="mt-2 rounded-2xl bg-blue-500 text-white py-3.5 text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400 hover:shadow-xl hover:shadow-blue-500/30 disabled:opacity-50">{loading ? tr("diagnosing", lang) : tr("diagnoseBtn", lang)}</button>
                    </form>

                    {error && <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
                  </div>

                </div>

                <div className="space-y-6">
                  {hasSearched ? (
                    <div className="animate-scale-in">
                      <LikelyCausesPanel
                        result={result}
                        theme={theme}
                        code={lastCode}
                        symptoms={lastSymptoms}
                        vehicle={activeVehicle}
                        vehicleId={activeVehicle?.id}
                        onSaveToHistory={saveDiagnosisSession}
                        onShare={result ? handleShare : undefined}
                        onDownload={result ? handleDownload : undefined}
                    followUpAnswers={Object.fromEntries(lastFollowUps.map((f) => [f.question, f.answer]))}
                    onRefine={refineDiagnosis}
                    refining={refining}
                    refineError={refineError}
                        lang={lang}
                      />
                    </div>
                  ) : (
                    <div className="animate-fade-in-up">
                      <div className={cn("rounded-3xl p-6 sm:p-8", cardStrongClass)}>
                        <div className="text-center">
                          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/20">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                            </svg>
                          </div>
                          <h3 className={cn("mt-4 text-base font-semibold", t("text-white", "text-slate-900"))}>{tr("howItWorks", lang)}</h3>
                          <p className={cn("mt-1 text-sm", t("text-slate-400", "text-slate-500"))}>{tr("howItWorksSubtitle", lang)}</p>
                        </div>

                        <div className="mt-8 grid gap-4">
                          {[
                            { num: "1", title: tr("step1Title", lang), desc: tr("step1Desc", lang) },
                            { num: "2", title: tr("step2Title", lang), desc: tr("step2Desc", lang) },
                            { num: "3", title: tr("step3Title", lang), desc: tr("step3Desc", lang) },
                          ].map((step) => (
                            <div key={step.num} className={cn("flex items-start gap-4 rounded-2xl p-4", t("border border-white/5 bg-white/5", "border border-slate-100 bg-slate-50"))}>
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500 text-xs font-bold text-white shadow-md shadow-blue-500/30">{step.num}</div>
                              <div>
                                <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{step.title}</div>
                                <div className={cn("mt-0.5 text-xs", t("text-slate-400", "text-slate-500"))}>{step.desc}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : tab === "garage" ? (
          <div key="tab-garage" className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[440px_1fr] animate-slide-in relative z-40">
            {session?.user && (guestVehicles.length > 0 || guestImportNote) && (
              <div
                role="status"
                className={cn("lg:col-span-2 rounded-2xl px-4 sm:px-5 py-4 flex flex-wrap items-center gap-3", t("bg-blue-500/10 border border-blue-500/20", "bg-blue-50 border border-blue-200"))}
              >
                <div className="flex-1 min-w-[200px]">
                  {guestVehicles.length > 0 ? (
                    <>
                      <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>
                        {guestVehicles.length} {guestVehicles.length === 1 ? tr("guestVehiclesFoundOne", lang) : tr("guestVehiclesFoundMany", lang)}
                      </div>
                      <div className={cn("mt-0.5 text-xs", t("text-slate-400", "text-slate-500"))}>
                        {guestVehicles.slice(0, 3).map((v) => `${v.year} ${v.make} ${v.model}`).join(" · ")}
                        {guestVehicles.length > 3 ? " …" : ""}
                      </div>
                      <div className={cn("mt-1 text-xs", t("text-slate-400", "text-slate-500"))}>{tr("guestVehiclesHint", lang)}</div>
                    </>
                  ) : null}
                  {guestImportNote && (
                    <div className={cn("text-xs", guestVehicles.length > 0 ? "mt-2" : "", t("text-blue-200", "text-blue-800"))}>{guestImportNote}</div>
                  )}
                </div>
                {guestVehicles.length > 0 ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={handleImportGuestVehicles}
                      disabled={importingGuest || garageSyncing}
                      className="rounded-xl bg-blue-500 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-blue-500/25 transition-all hover:bg-blue-400 disabled:opacity-60"
                    >
                      {importingGuest ? tr("importing", lang) : tr("importFromDevice", lang)}
                    </button>
                    <button
                      type="button"
                      onClick={() => { dismissGuestVehicles(); setGuestImportNote(""); }}
                      disabled={importingGuest}
                      className={cn("rounded-xl px-3 py-2.5 text-xs font-semibold transition-all", t("border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10", "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"))}
                    >
                      {tr("notNow", lang)}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setGuestImportNote("")}
                    className={cn("shrink-0 rounded-xl px-3 py-2 text-xs font-semibold transition-all", t("border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10", "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"))}
                  >
                    {tr("dismiss", lang)}
                  </button>
                )}
              </div>
            )}
            <div ref={garageFormRef} className={cn("rounded-3xl p-5 sm:p-6 animate-fade-in-up relative overflow-visible", cardStrongClass)}>
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/20">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </div>
                <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("addVehicle", lang)}</div>
              </div>

              <form className="mt-5 grid gap-3 overflow-visible" onSubmit={(e) => { e.preventDefault(); addVehicle(new FormData(e.currentTarget)); (e.currentTarget as HTMLFormElement).reset(); setGYear(""); setGMake(""); setMakeConfirmed(false); setGModel(""); setGVin(""); setGEngine(""); }}>
                <input
                  name="vin"
                  placeholder={tr("vinPlaceholder", lang)}
                  value={gVin}
                  onChange={(e) => setGVin(e.target.value)}
                  maxLength={20}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="vin-status"
                  className={cn(inputClass, "rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                />
                <div id="vin-status" role="status" className="-mt-1 min-h-[1rem] px-1 text-xs">
                  {vinStatus.kind === "loading" && <span className="text-slate-400">{tr("vinDecoding", lang)}</span>}
                  {vinStatus.kind === "ok" && <span className="text-emerald-300">✓ {vinStatus.vehicle}</span>}
                  {vinStatus.kind === "warn" && (
                    <span className="text-amber-300">{vinStatus.vehicle} — {tr("vinCheckWarning", lang)}</span>
                  )}
                  {vinStatus.kind === "error" && (
                    <span className="text-red-300">
                      {tr(vinStatus.code === "invalid_format" ? "vinInvalid" : vinStatus.code === "unavailable" ? "vinUnavailable" : "vinNotRecognized", lang)}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 overflow-visible">
                  <ComboSelect
                    name="make"
                    value={gMake}
                    onValueChange={(v) => {
                      if (v !== gMake) {
                        setMakeConfirmed(false);
                        setGYear("");
                        setGModel("");
                        setGEngine("");
                        setModelOptions([]);
                        setEngineOptions([]);
                      }
                      setGMake(v);
                    }}
                    onSelect={(v) => {
                      setGMake(v);
                      setMakeConfirmed(true);
                      setGYear("");
                      setGModel("");
                      setGEngine("");
                      setModelOptions([]);
                      setEngineOptions([]);
                    }}
                    options={makeOptions.map((m) => ({ value: m.name, label: m.name }))}
                    placeholder={tr("make", lang)}
                    triggerType="input"
                    allowCustomValue
                    filterable={false}
                    onBlur={() => {
                      if (!gMake.trim()) return;
                      const listed = completeMakeName(gMake);
                      if (listed !== gMake) setGMake(listed);
                      setMakeConfirmed(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (gMake.trim()) setMakeConfirmed(true);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    triggerClassName={cn(inputClass, "w-full rounded-2xl px-4 py-3 text-sm text-base transition-colors")}
                    contentClassName={cn("rounded-xl shadow-xl w-[var(--radix-popover-trigger-width)]", dropdownClass)}
                    theme={theme}
                  />

                  <ComboSelect
                    name="year"
                    value={gYear}
                    onValueChange={(v) => {
                      setGYear(v);
                      setGEngine("");
                      setEngineOptions([]);
                    }}
                    options={yearOptions}
                    placeholder={tr("year", lang)}
                    disabled={!gMake.trim()}
                    triggerClassName={cn(
                      inputClass,
                      "w-full rounded-2xl px-4 py-3 text-sm text-base transition-colors text-left",
                      !gMake.trim() && "opacity-60 cursor-not-allowed pointer-events-none"
                    )}
                    contentClassName={cn("rounded-xl shadow-xl w-[var(--radix-popover-trigger-width)]", dropdownClass)}
                    theme={theme}
                  />

                  <ComboSelect
                    name="model"
                    value={gModel}
                    // Typed freely, with NHTSA models offered as suggestions. If the
                    // list is empty or NHTSA is down, the vehicle can still be added.
                    onValueChange={setGModel}
                    onSelect={selectModel}
                    options={modelOptions}
                    placeholder={tr("model", lang)}
                    triggerType="input"
                    allowCustomValue
                    filterable={false}
                    maxLength={60}
                    disabled={!makeConfirmed || !gMake.trim()}
                    triggerClassName={cn(
                      inputClass,
                      "w-full rounded-2xl px-4 py-3 text-sm text-base transition-colors text-left",
                      (!makeConfirmed || !gMake.trim()) && "opacity-60 cursor-not-allowed pointer-events-none"
                    )}
                    contentClassName={cn("rounded-xl shadow-xl w-[var(--radix-popover-trigger-width)]", dropdownClass)}
                    theme={theme}
                  />

                  <ComboSelect
                    name="engine"
                    value={gEngine}
                    onValueChange={setGEngine}
                    // Typed freely; a VIN-decoded engine is offered as a suggestion
                    // (hidden once it is already the field's value).
                    options={engineOptions.filter((e) => e && e !== gEngine)}
                    placeholder={tr("enginePlaceholder", lang)}
                    triggerType="input"
                    allowCustomValue
                    filterable={false}
                    maxLength={100}
                    disabled={!gMake.trim() || !gModel.trim() || !gYear.trim()}
                    triggerClassName={cn(
                      inputClass,
                      "w-full rounded-2xl px-4 py-3 text-sm text-base transition-colors text-left",
                      (!gMake.trim() || !gModel.trim() || !gYear.trim()) && "opacity-60 cursor-not-allowed pointer-events-none"
                    )}
                    contentClassName={cn("rounded-xl shadow-xl w-[var(--radix-popover-trigger-width)]", dropdownClass)}
                    theme={theme}
                  />
                </div>

                <button type="submit" className="mt-3 rounded-2xl bg-blue-500 text-white py-3 text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400 hover:shadow-xl">{tr("saveToGarage", lang)}</button>
              </form>
            </div>

            <div className={cn("rounded-3xl p-5 sm:p-6 animate-fade-in-up relative z-10", cardStrongClass)} style={{ animationDelay: "0.1s" }}>
              <div className="flex items-center gap-2">
                <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", t("bg-white/10", "bg-slate-100"))}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </div>
                <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("myGarage", lang)}</div>
                {garage.length > 0 && <span className={cn("ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold", t("bg-white/10 text-slate-300", "bg-slate-100 text-slate-600"))}>{garage.length}</span>}
              </div>
              <div className="mt-4 space-y-3">
                {garage.length === 0 ? (
                  <div className={cn("rounded-2xl border-dashed p-8 text-center", t("border border-white/15 bg-white/5", "border border-slate-200 bg-slate-50"))}>
                    <div className={cn("mx-auto flex h-16 w-16 items-center justify-center rounded-2xl", t("bg-white/10", "bg-slate-100"))}>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                        <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                        <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                        <path d="M9 17h6" />
                      </svg>
                    </div>
                    <div className={cn("mt-3 text-sm font-semibold", t("text-slate-300", "text-slate-600"))}>{tr("noVehiclesYet", lang)}</div>
                    <div className={cn("mt-1 text-xs", t("text-slate-500", "text-slate-400"))}>{tr("noVehiclesDesc", lang)}</div>
                    <button
                      onClick={() => garageFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                      className="mt-4 rounded-xl bg-blue-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400"
                    >
                      {tr("addFirstVehicle", lang)}
                    </button>
                  </div>
                ) : garage.map((v) => {
                  const isActive = v.id === activeId;
                  return (
                    <div key={v.id}>
                      <div className={cn("rounded-2xl border p-4 transition-all", isActive ? "border-blue-400/30 bg-blue-500/10" : t("border-white/10 bg-white/5 hover:border-white/20", "border-slate-200 bg-slate-50 hover:border-slate-300"))}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", isActive ? "bg-blue-500/20" : t("bg-white/10", "bg-slate-100"))}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isActive ? "#60a5fa" : "#64748b"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                                <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                                <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                                <path d="M9 17h6" />
                              </svg>
                            </div>
                            <div className="min-w-0">
                              <div className={cn("truncate text-sm font-semibold", t("text-white", "text-slate-900"))}>{v.year} {v.make} {v.model}{v.engine ? ` (${v.engine})` : ""}</div>
                              {v.vin ? <div className="text-[10px] text-slate-500">{tr("vinSaved", lang)}</div> : null}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button onClick={() => setActiveId(v.id)} className={cn("rounded-xl px-3 py-1.5 text-xs font-semibold transition-all", isActive ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30" : t("border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:text-blue-300", "border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:text-blue-600"))}>{isActive ? tr("active", lang) : tr("setActive", lang)}</button>
                            <VehicleDeleteButton
                              theme={theme}
                              lang={lang}
                              disabled={garageSyncing}
                              onClick={() =>
                                setConfirmDialog({
                                  open: true,
                                  title: tr("deleteVehicle", lang),
                                  message: tr("deleteVehicleMsg", lang),
                                  confirmLabel: tr("delete", lang),
                                  onConfirm: () => removeVehicle(v.id),
                                })
                              }
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : tab === "service" ? (
          <div key="tab-service" className="mt-8 animate-slide-in">
            <div className={cn("rounded-3xl p-5 sm:p-6", cardStrongClass)}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  </div>
                  <div>
                    <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("serviceCenter", lang)}</div>
                    <div className={cn("text-xs", t("text-slate-400", "text-slate-500"))}>{tr("serviceDesc", lang)}</div>
                  </div>
                </div>
              </div>

              {garage.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className={cn("flex h-14 w-14 items-center justify-center rounded-2xl mb-4", t("bg-white/5", "bg-slate-100"))}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={theme === "dark" ? "#475569" : "#94a3b8"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                      <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                      <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                      <path d="M9 17h6" />
                    </svg>
                  </div>
                  <div className={cn("text-sm font-semibold", t("text-slate-300", "text-slate-600"))}>{tr("addVehicleFirst", lang)}</div>
                  <button
                    onClick={() => setTab("garage")}
                    className="mt-4 rounded-xl bg-blue-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400"
                  >
                    {tr("goToGarage", lang)}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2 mb-5">
                    <button
                      onClick={() => setServiceVehicleFilter(null)}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                        serviceVehicleFilter === null
                          ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30"
                          : t("border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:text-blue-300", "border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:text-blue-600")
                      )}
                    >
                      {tr("allVehicles", lang)}
                    </button>
                    {garage.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setServiceVehicleFilter(serviceVehicleFilter === v.id ? null : v.id)}
                        className={cn(
                          "rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                          serviceVehicleFilter === v.id
                            ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30"
                            : t("border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:text-blue-300", "border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:text-blue-600")
                        )}
                      >
                        {v.year} {v.make} {v.model}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-5">
                    {(serviceVehicleFilter ? garage.filter(v => v.id === serviceVehicleFilter) : garage).map((v) => {
                      const vMaintRecords = maintenanceRecords[v.id] || [];
                      const vDiagSessions = diagnosisSessions[v.id] || [];
                      return (
                        <div key={v.id} className={cn("rounded-2xl border p-4", t("border-white/10 bg-white/5", "border-slate-200 bg-slate-50"))}>
                          <div className="flex items-center gap-3 mb-4">
                            <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", "bg-emerald-500/20")}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                                <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                                <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                                <path d="M9 17h6" />
                              </svg>
                            </div>
                            <div>
                              <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{v.year} {v.make} {v.model}{v.engine ? ` (${v.engine})` : ""}</div>
                              <div className={cn("text-xs", t("text-slate-500", "text-slate-400"))}>{vMaintRecords.length} {vMaintRecords.length === 1 ? tr("recordCountSingle", lang) : tr("recordCount", lang)}</div>
                            </div>
                          </div>

                          <form className="grid gap-2 mb-4" onSubmit={(e) => { e.preventDefault(); addMaintenanceRecord(v.id, new FormData(e.currentTarget)); (e.currentTarget as HTMLFormElement).reset(); }}>
                            <select name="maint_type" className={cn(inputClass, "rounded-xl px-3 py-2 text-xs transition-colors appearance-none")} style={{ colorScheme: "dark" }}>
                              {([["Oil Change","mtOilChange"],["Tire Rotation","mtTireRotation"],["Brake Service","mtBrakeService"],["Coolant Flush","mtCoolantFlush"],["Transmission Service","mtTransService"],["Air Filter","mtAirFilter"],["Battery","mtBattery"],["Other","mtOther"]] as const).map(([val, key]) => <option key={val} value={val} className="bg-slate-800 text-slate-200">{tr(key, lang)}</option>)}
                            </select>
                            <div className="grid grid-cols-2 gap-2">
                              <input name="maint_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={cn(inputClass, "rounded-xl px-3 py-2 text-xs transition-colors")} style={{ colorScheme: "dark" }} />
                              <div className="flex gap-2">
                                <input
                                  name="maint_mileage"
                                  inputMode="numeric"
                                  type="number"
                                  min={0}
                                  step={1}
                                  placeholder={tr("mileage", lang)}
                                  className={cn(inputClass, "w-full rounded-xl px-3 py-2 text-xs transition-colors")}
                                />
                                <select
                                  name="maint_mileage_unit"
                                  defaultValue="km"
                                  className={cn(inputClass, "rounded-xl px-2.5 py-2 text-xs transition-colors appearance-none")}
                                  style={{ colorScheme: "dark" }}
                                  aria-label="Mileage unit"
                                >
                                  <option value="km" className="bg-slate-800 text-slate-200">km</option>
                                  <option value="mi" className="bg-slate-800 text-slate-200">mi</option>
                                </select>
                              </div>
                            </div>
                            <input name="maint_notes" placeholder={tr("notesOptional", lang)} className={cn(inputClass, "rounded-xl px-3 py-2 text-xs transition-colors")} />
                            <button type="submit" className="rounded-xl bg-emerald-500 text-white py-2 text-xs font-semibold shadow-md shadow-emerald-500/25 transition-all hover:bg-emerald-400">{tr("addRecord", lang)}</button>
                          </form>

                          {vMaintRecords.length > 0 ? (
                            <div className="space-y-2">
                              {vMaintRecords.map((mr) => (
                                <div key={mr.id} className={cn("rounded-xl p-3 text-xs", t("border border-white/5 bg-white/5", "border border-slate-100 bg-white"))}>
                                  <div className="flex items-center justify-between">
                                    <span className={cn("font-semibold", t("text-white", "text-slate-900"))}>{mr.type}</span>
                                    <div className="flex items-center gap-2">
                                      <span className={cn(t("text-slate-400", "text-slate-500"))}>{mr.date}</span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setConfirmDialog({
                                            open: true,
                                            title: "Delete Record",
                                            message: "Are you sure you want to delete this maintenance record? This cannot be undone.",
                                            confirmLabel: tr("delete", lang),
                                            onConfirm: () => deleteMaintenanceRecord(v.id, mr.id),
                                          });
                                        }}
                                        className={cn(
                                          "rounded-xl px-2 py-1.5 text-xs transition-colors",
                                          t(
                                            "text-slate-500 hover:text-red-400",
                                            "text-slate-400 hover:text-red-500"
                                          )
                                        )}
                                      >
                                        {tr("delete", lang)}
                                      </button>
                                    </div>
                                  </div>
                                  {(mr.mileageValue !== undefined || (mr as LegacyMaintenanceRecord).mileage) && (
                                    <div className={cn("mt-0.5", t("text-slate-400", "text-slate-500"))}>
                                      {(
                                        mr.mileageValue !== undefined
                                          ? mr.mileageValue
                                          : Number(String((mr as LegacyMaintenanceRecord).mileage ?? "").replace(/,/g, "")) || 0
                                      ).toLocaleString()}{" "}
                                      {mr.mileageUnit || "mi"}
                                    </div>
                                  )}
                                  {mr.notes && <div className={cn("mt-0.5", t("text-slate-400", "text-slate-500"))}>{mr.notes}</div>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className={cn("text-center py-4 text-xs", t("text-slate-500", "text-slate-400"))}>
                              {tr("noServiceRecords", lang)}
                            </div>
                          )}

                          <div className={cn("mt-5 pt-5 border-t", t("border-white/10", "border-slate-200"))}>
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>Diagnosis history</div>
                                <div className={cn("mt-0.5 text-[11px]", t("text-slate-400", "text-slate-500"))}>
                                  {vDiagSessions.length} saved {vDiagSessions.length === 1 ? "session" : "sessions"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => { setTab("diagnose"); setActiveId(v.id); }}
                                className={cn("rounded-xl px-3 py-2 text-xs font-semibold transition-all", t("border border-white/10 bg-white/10 text-slate-300 hover:bg-blue-500/20 hover:text-blue-300", "border border-slate-200 bg-white text-slate-600 hover:bg-blue-50 hover:text-blue-600"))}
                              >
                                Diagnose
                              </button>
                            </div>

                            {vDiagSessions.length > 0 ? (
                              <div className="mt-3 space-y-2">
                                {vDiagSessions.slice(0, 4).map((ds) => (
                                  <div key={ds.id} className={cn("rounded-xl p-3 text-xs", t("border border-white/5 bg-white/5", "border border-slate-100 bg-white"))}>
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className={cn("font-semibold", t("text-white", "text-slate-900"))}>
                                          {new Date(ds.timestamp).toLocaleDateString()} • {ds.issueText}
                                        </div>
                                        {ds.confirmedFix?.fix ? (
                                          <div className={cn("mt-1", t("text-emerald-300", "text-emerald-700"))}>
                                            Confirmed fix: {ds.confirmedFix.fix}
                                          </div>
                                        ) : null}
                                        {ds.finalRankedCauses?.length ? (
                                          <div className={cn("mt-1", t("text-slate-400", "text-slate-500"))}>
                                            Top causes: {ds.finalRankedCauses.slice(0, 3).map((c) => c.title).join(" • ")}
                                          </div>
                                        ) : null}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setConfirmDialog({
                                            open: true,
                                            title: "Delete Diagnosis",
                                            message: "Delete this saved diagnosis session from vehicle history?",
                                            confirmLabel: tr("delete", lang),
                                            onConfirm: () => deleteDiagnosisSession(v.id, ds.id),
                                          })
                                        }
                                        className={cn("rounded-xl px-2 py-1.5 text-xs transition-colors", t("text-slate-500 hover:text-red-400", "text-slate-400 hover:text-red-500"))}
                                      >
                                        {tr("delete", lang)}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                {vDiagSessions.length > 4 && (
                                  <div className={cn("text-center pt-1 text-[11px]", t("text-slate-500", "text-slate-400"))}>
                                    Showing latest 4 sessions
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className={cn("mt-3 text-center py-3 text-xs", t("text-slate-500", "text-slate-400"))}>
                                No saved diagnosis sessions yet.
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}
        {/* Feedback is now a global widget */}

        {showInstallBanner && installPrompt && (
          <div className={cn("mt-6 rounded-2xl px-4 py-3 flex items-center gap-3", t("bg-blue-500/10 border border-blue-500/20", "bg-blue-50 border border-blue-200"))}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <div className="flex-1 min-w-0">
              <div className={cn("text-xs sm:text-sm font-medium", t("text-blue-200", "text-blue-800"))}>{tr("addToHomeScreen", lang)}</div>
            </div>
            <button
              onClick={async () => {
                try { await installPrompt.prompt(); } catch {}
                setShowInstallBanner(false);
                try { localStorage.setItem("carcode_install_dismissed", "1"); } catch {}
              }}
              className="shrink-0 rounded-lg bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold transition hover:bg-blue-400"
            >
              {tr("installApp", lang)}
            </button>
            <button
              onClick={() => {
                setShowInstallBanner(false);
                try { localStorage.setItem("carcode_install_dismissed", "1"); } catch {}
              }}
              className={cn("shrink-0 p-1 rounded-lg transition", t("text-slate-400 hover:bg-white/10", "text-slate-400 hover:bg-slate-100"))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}

      </div>
    </main>
  );
}
