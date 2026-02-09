"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { COMMON_CODES, CATEGORY_LABELS } from "./data/common-codes";
import { LANGUAGES, tr, type LangCode } from "./data/translations";
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

type Cause = {
  title: string;
  why?: string;
  severity?: "high" | "medium" | "low";
  difficulty?: "DIY Easy" | "DIY Moderate" | "Mechanic Recommended";
  confirm?: string[];
  fix?: string[];
};

type ApiOk = {
  causes: Cause[];
  summary_title?: string;
};

type ApiErr = { error: string };

type MaintenanceRecord = {
  id: string;
  vehicleId: string;
  type: string;
  date: string;
  mileage: string;
  notes: string;
};

function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel, theme, lang }: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  theme: "dark" | "light";
  lang: LangCode;
}) {
  if (!open) return null;
  const t = (dark: string, light: string) => theme === "dark" ? dark : light;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md" style={{ background: theme === "dark" ? "rgba(15,23,42,0.7)" : "rgba(255,255,255,0.7)" }}>
      <div className={cn("w-full max-w-sm rounded-3xl p-6 animate-scale-in", t("glass-card-strong", "bg-white border border-slate-200 shadow-xl"))}>
        <div className={cn("text-base font-semibold", t("text-white", "text-slate-900"))}>{title}</div>
        <div className={cn("mt-2 text-sm", t("text-slate-400", "text-slate-600"))}>{message}</div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onCancel} className={cn("rounded-xl px-4 py-2 text-sm font-semibold transition-all", t("border border-white/10 bg-white/10 text-slate-300 hover:bg-white/20", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"))}>{tr("cancel", lang)}</button>
          <button onClick={onConfirm} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-red-500/25 transition-all hover:bg-red-400">{confirmLabel || tr("confirm", lang)}</button>
        </div>
      </div>
    </div>
  );
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
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

function LikelyCausesPanel({
  result,
  theme,
  code,
  symptoms,
  vehicle,
  onShare,
  onDownload,
  lang,
}: {
  result: ApiOk | null;
  theme: "dark" | "light";
  code?: string;
  symptoms?: string;
  vehicle?: { year: string; make: string; model: string; engine?: string } | null;
  onShare?: () => void;
  onDownload?: () => void;
  lang: LangCode;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const t = (dark: string, light: string) => theme === "dark" ? dark : light;

  if (!result?.causes?.length) {
    return (
      <div className={cn("rounded-3xl p-6", t("glass-card-strong", "bg-white border border-slate-200 shadow-sm"))}>
        <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("likelyCauses", lang)}</div>
        <div className={cn("mt-2 text-sm", t("text-slate-400", "text-slate-500"))}>Run a diagnostic to see causes here.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={cn("rounded-3xl p-6", t("glass-card-strong", "bg-white border border-slate-200 shadow-sm"))}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={cn("text-[11px] font-medium", t("text-slate-400", "text-slate-500"))}>DIAGNOSTIC SUMMARY</div>
            <div className={cn("mt-1 text-2xl font-semibold tracking-tight", t("text-white", "text-slate-900"))}>
              {result?.summary_title || tr("likelyCauses", lang)}
            </div>
            <div className={cn("mt-1 text-sm", t("text-slate-400", "text-slate-500"))}>
              Tap a cause to see how to confirm it and how to fix it.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onDownload && (
              <button
                onClick={onDownload}
                className={cn(
                  "shrink-0 flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all",
                  t("border border-white/10 bg-white/10 text-slate-300 hover:bg-blue-500/20 hover:text-blue-300 hover:border-blue-400/30", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300")
                )}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {tr("download", lang)}
              </button>
            )}
            {onShare && (
              <button
                onClick={onShare}
                className={cn(
                  "shrink-0 flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all",
                  t("border border-white/10 bg-white/10 text-slate-300 hover:bg-blue-500/20 hover:text-blue-300 hover:border-blue-400/30", "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300")
                )}
              >
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

      <div className="space-y-3">
        {result.causes.map((c, idx) => {
          const isOpen = openIdx === idx;
          const severityConfig = {
            high: { label: tr("mostLikely", lang), bg: t("bg-red-500/15 text-red-300 border-red-500/30", "bg-red-50 text-red-600 border-red-200"), dot: "bg-red-400" },
            medium: { label: tr("possible", lang), bg: t("bg-yellow-500/15 text-yellow-300 border-yellow-500/30", "bg-yellow-50 text-yellow-600 border-yellow-200"), dot: "bg-yellow-400" },
            low: { label: tr("lessLikely", lang), bg: t("bg-slate-500/15 text-slate-300 border-slate-500/30", "bg-slate-100 text-slate-500 border-slate-200"), dot: "bg-slate-400" },
          };
          const sev = severityConfig[c.severity || "medium"];
          const diffConfig: Record<string, { icon: React.ReactNode; color: string }> = {
            "DIY Easy": { icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>, color: t("text-emerald-400", "text-emerald-600") },
            "DIY Moderate": { icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>, color: t("text-yellow-400", "text-yellow-600") },
            "Mechanic Recommended": { icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>, color: t("text-orange-400", "text-orange-600") },
          };
          const diff = diffConfig[c.difficulty || "DIY Moderate"] || diffConfig["DIY Moderate"];

          return (
            <div key={`${c.title}-${idx}`} className={cn("rounded-3xl animate-scale-in", t("glass-card", "bg-white border border-slate-200 shadow-sm"))} style={{ animationDelay: `${idx * 0.05}s` }}>
              <button
                type="button"
                onClick={() => setOpenIdx(isOpen ? null : idx)}
                className={cn(
                  "w-full rounded-3xl border border-transparent bg-transparent px-5 py-4 text-left transition",
                  t("hover:bg-blue-500/20 hover:border-blue-400/30", "hover:bg-blue-50 hover:border-blue-200"),
                  "focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{c.title}</div>
                      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold", sev.bg)}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", sev.dot)} />
                        {sev.label}
                      </span>
                    </div>
                    {c.why && <div className={cn("mt-1 text-sm", t("text-slate-400", "text-slate-500"))}>{c.why}</div>}
                    {c.difficulty && (
                      <div className="mt-2 flex items-center gap-3 flex-wrap">
                        <span className={cn("inline-flex items-center gap-1 text-xs", diff.color)}>
                          {diff.icon}
                          {c.difficulty}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className={cn("shrink-0 mt-1 text-sm font-semibold", t("text-slate-400", "text-slate-500"))}>{isOpen ? "−" : "+"}</div>
                </div>
              </button>

              {isOpen && (
                <div className={cn("border-t px-5 py-5", t("border-white/10", "border-slate-200"))}>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className={cn("rounded-2xl p-4", t("border border-white/10 bg-white/5", "border border-slate-200 bg-slate-50"))}>
                      <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("howToConfirm", lang)}</div>
                      <ul className={cn("mt-2 space-y-2 text-sm", t("text-slate-300", "text-slate-600"))}>
                        {(c.confirm || []).length ? (
                          c.confirm!.map((v: string, i: number) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-2 h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                              {v}
                            </li>
                          ))
                        ) : (
                          <li className={t("text-slate-500", "text-slate-400")}>{tr("noConfirmSteps", lang)}</li>
                        )}
                      </ul>
                    </div>

                    <div className={cn("rounded-2xl p-4", t("border border-white/10 bg-white/5", "border border-slate-200 bg-slate-50"))}>
                      <div className={cn("text-xs font-semibold", t("text-white", "text-slate-900"))}>{tr("howToFix", lang)}</div>
                      <ul className={cn("mt-2 space-y-2 text-sm", t("text-slate-300", "text-slate-600"))}>
                        {(c.fix || []).length ? (
                          c.fix!.map((v: string, i: number) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-2 h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                              {v}
                            </li>
                          ))
                        ) : (
                          <li className={t("text-slate-500", "text-slate-400")}>{tr("noFixSteps", lang)}</li>
                        )}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
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

type AuthUser = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_image: string | null;
};

export default function Home() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [tab, setTab] = useState<"diagnose" | "garage" | "service" | "codes">("diagnose");
  const [serviceVehicleFilter, setServiceVehicleFilter] = useState<string | null>(null);
  const [vehiclePickerOpen, setVehiclePickerOpen] = useState(false);
  const [garage, setGarage] = useState<Vehicle[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authFirstName, setAuthFirstName] = useState("");
  const [authLastName, setAuthLastName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const theme = "dark" as const;
  const t = (dark: string, _light: string) => dark;

  const [lang, setLang] = useState<LangCode>("en");
  const [langMenuOpen, setLangMenuOpen] = useState(false);

  const [toastMsg, setToastMsg] = useState("");
  const [toastVisible, setToastVisible] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState<{open:boolean, title:string, message:string, confirmLabel?:string, onConfirm:()=>void} | null>(null);

  const [maintenanceRecords, setMaintenanceRecords] = useState<Record<string, MaintenanceRecord[]>>({});

  const [codesSearch, setCodesSearch] = useState("");
  const [codesCategory, setCodesCategory] = useState<string | null>(null);

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
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

  const [result, setResult] = useState<ApiOk | null>(null);
  const [lastCode, setLastCode] = useState("");
  const [lastSymptoms, setLastSymptoms] = useState("");
  const [lastVehicle, setLastVehicle] = useState<{ year: string; make: string; model: string; engine?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(true);


  useEffect(() => {
    try {
      const raw = localStorage.getItem("carcode_garage_v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { garage: Vehicle[]; activeId: string | null };
        setGarage(parsed.garage || []);
        setActiveId(parsed.activeId || (parsed.garage?.[0]?.id ?? null));
      }
    } catch {}
    try {
      const rawMaint = localStorage.getItem("carcode_maintenance_v1");
      if (rawMaint) {
        setMaintenanceRecords(JSON.parse(rawMaint));
      }
    } catch {}
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
      setInstallPrompt(e);
      const dismissed = localStorage.getItem("carcode_install_dismissed");
      if (!dismissed && isMobile) setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handleInstall);

    const urlParams = new URLSearchParams(window.location.search);
    const authError = urlParams.get("auth_error");
    if (authError) {
      const messages: Record<string, string> = {
        invalid_redirect_uri: "Sign in failed: domain not recognized. Please try again.",
        state_mismatch: "Sign in failed: session expired. Please try again.",
        missing_verifier: "Sign in failed: cookies not available. Please try again.",
        callback_failed: "Sign in failed: could not complete authentication.",
        server_error: "Sign in failed: server error. Please try again.",
        missing_params: "Sign in failed: incomplete response.",
      };
      showToast(messages[authError] || `Sign in failed: ${authError}`);
      window.history.replaceState({}, "", "/");
    }

    fetch("/api/auth/user")
      .then((r) => r.json())
      .then((u) => {
        if (u && u.id) {
          setAuthUser(u);
          return fetch("/api/garage").then((r) => r.ok ? r.json() : null).then((data) => {
            if (data && data.garage) {
              setGarage(data.garage);
              setActiveId(data.activeId || data.garage[0]?.id || null);
              if (data.maintenance) setMaintenanceRecords(data.maintenance);
            }
          });
        }
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));

    return () => window.removeEventListener("beforeinstallprompt", handleInstall);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("carcode_garage_v1", JSON.stringify({ garage, activeId }));
    } catch {}
    if (authUser) {
      fetch("/api/garage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", garage, activeId, maintenance: maintenanceRecords }),
      }).catch(() => {});
    }
  }, [garage, activeId]);

  useEffect(() => {
    try {
      localStorage.setItem("carcode_maintenance_v1", JSON.stringify(maintenanceRecords));
    } catch {}
    if (authUser && Object.keys(maintenanceRecords).length > 0) {
      fetch("/api/garage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", garage, activeId, maintenance: maintenanceRecords }),
      }).catch(() => {});
    }
  }, [maintenanceRecords]);

  useEffect(() => {
    try {
      localStorage.setItem("carcode_lang", lang);
    } catch {}
  }, [lang]);

  function addMaintenanceRecord(vehicleId: string, fd: FormData) {
    const rec: MaintenanceRecord = {
      id: uid(),
      vehicleId,
      type: String(fd.get("maint_type") || "Other"),
      date: String(fd.get("maint_date") || new Date().toISOString().slice(0, 10)),
      mileage: String(fd.get("maint_mileage") || ""),
      notes: String(fd.get("maint_notes") || ""),
    };
    setMaintenanceRecords((prev) => ({
      ...prev,
      [vehicleId]: [rec, ...(prev[vehicleId] || [])],
    }));
    showToast(tr("maintenanceAdded", lang));
  }

  function addVehicle(fd: FormData) {
    const year = String(fd.get("year") || "").trim();
    const make = String(fd.get("make") || "").trim();
    const model = String(fd.get("model") || "").trim();
    const engine = String(fd.get("engine") || "").trim();
    const vin = String(fd.get("vin") || "").trim();

    if (!year || !make || !model) return;

    const v: Vehicle = {
      id: uid(),
      year,
      make,
      model,
      engine: engine || undefined,
      vin: vin || undefined,
    };

    setGarage((prev) => [v, ...prev]);
    setActiveId(v.id);
    setTab("diagnose");
  }

  function removeVehicle(id: string) {
    setGarage((prev) => prev.filter((v) => v.id !== id));
    if (activeId === id) {
      const next = garage.find((v) => v.id !== id)?.id ?? null;
      setActiveId(next);
    }
  }

  async function runDiagnostic(fd: FormData) {
    setLoading(true);
    setError(null);
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

    if (!code && !symptoms) {
      setError(tr("enterCodeOrSymptom", lang));
      setLoading(false);
      return;
    }

    setLastCode(code);
    setLastSymptoms(symptoms);
    setLastVehicle({ year: activeVehicle.year, make: activeVehicle.make, model: activeVehicle.model, engine: activeVehicle.engine });

    const payload = {
      year: activeVehicle.year,
      make: activeVehicle.make,
      model: activeVehicle.model,
      engine: activeVehicle.engine || "",
      code,
      symptoms,
      lang,
    };

    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as ApiOk | ApiErr;

      if (!res.ok) {
        setError("error" in data ? data.error : "Request failed.");
      } else {
        const apiResult = data as ApiOk;
        setResult(apiResult);
        setSearchPanelOpen(false);
      }
    } catch (e: any) {
      setError(e?.message || "Network error.");
    } finally {
      setLoading(false);
    }
  }

  function generateShareText(): string {
    const veh = lastVehicle || activeVehicle || { year: "", make: "", model: "", engine: "" };
    const lines: string[] = [
      "CarCode AI Diagnosis",
      `Vehicle: ${veh.year} ${veh.make} ${veh.model}${veh.engine ? ` (${veh.engine})` : ""}`,
      `Code: ${lastCode || "N/A"} | Symptoms: ${lastSymptoms || "N/A"}`,
      "---",
      result?.summary_title || "Likely Causes",
      "",
    ];
    result?.causes.forEach((c, i) => {
      const sev = c.severity === "high" ? "Most Likely" : c.severity === "low" ? "Less Likely" : "Possible";
      lines.push(`Cause ${i + 1}: ${c.title} [${sev}]`);
      if (c.why) lines.push(`  Why: ${c.why}`);
      if (c.difficulty) lines.push(`  Difficulty: ${c.difficulty}`);
      if (c.confirm?.length) lines.push(`  Confirm: ${c.confirm.join("; ")}`);
      if (c.fix?.length) lines.push(`  Fix: ${c.fix.join("; ")}`);
      lines.push("");
    });
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

  function positionEngineDropdown() {
    const el = engineInputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setEngineDropStyle({
      position: "fixed",
      top: r.bottom + 8,
      left: r.left,
      width: r.width,
      zIndex: 9999,
    });
  }

  const [gYear, setGYear] = useState("");
  const [gMake, setGMake] = useState("");
  const [gModel, setGModel] = useState("");
  const [gVin, setGVin] = useState("");
  const [gEngine, setGEngine] = useState("");
  const engineInputRef = useRef<HTMLInputElement | null>(null);
  const [engineDropStyle, setEngineDropStyle] = useState<React.CSSProperties>({});

  const [makeOptions, setMakeOptions] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [engineOptions, setEngineOptions] = useState<any[]>([]);

  const selectMake = (m: string) => {
    setGMake(m);
    setGModel("");
    setGEngine("");
    setModelOptions([]);
    setEngineOptions([]);
    setModelOpen(false);
    setEngineOpen(false);
    setMakeOpen(false);
  };

  const [makeOpen, setMakeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  const modelRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef<HTMLInputElement | null>(null);

  const makeDrop = useDropPosition();
  const modelDrop = useDropPosition();
  const engineDrop = useDropPosition();

  const [vinLocked, setVinLocked] = useState(false);

  const makeQ = useDebouncedValue(gMake, 200);
  const modelQ = useDebouncedValue(gModel, 200);
  const vinQ = useDebouncedValue(gVin, 250);

  const makeInputRef = useRef<HTMLInputElement | null>(null);

  const [makeMenuPos, setMakeMenuPos] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!makeOpen || !makeInputRef.current) return;
    const update = () => {
      const r = makeInputRef.current!.getBoundingClientRect();
      setMakeMenuPos({ left: r.left, top: r.bottom, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [makeOpen, makeOptions.length, gMake]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!makeQ.trim()) { setMakeOptions([]); return; }
      const r = await fetch(`/api/vehicles/makes?q=${encodeURIComponent(makeQ.trim())}`);
      const d = await r.json();
      if (!cancelled) setMakeOptions(Array.isArray(d.makes) ? d.makes : []);
    }
    run().catch(() => { if (!cancelled) setMakeOptions([]); });
    return () => { cancelled = true; };
  }, [makeQ]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!gMake.trim()) { setModelOptions([]); return; }
      const url =
        `/api/vehicles/models?make=${encodeURIComponent(gMake.trim())}` +
        (gYear.trim() ? `&year=${encodeURIComponent(gYear.trim())}` : "") +
        `&q=${encodeURIComponent(modelQ.trim())}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!cancelled) setModelOptions(Array.isArray(d.models) ? d.models : []);
    }
    run().catch(() => { if (!cancelled) setModelOptions([]); });
    return () => { cancelled = true; };
  }, [gMake, gYear, modelQ]);

  useEffect(() => {
    if (!gYear.trim() || !gMake.trim() || !gModel.trim()) { setEngineOptions([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/vehicles/engines?year=${encodeURIComponent(gYear.trim())}&make=${encodeURIComponent(gMake.trim())}&model=${encodeURIComponent(gModel.trim())}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        const list = Array.isArray(data?.engines) ? data.engines : [];
        if (!cancelled) {
          setEngineOptions(list);
          if (list.length) setEngineOpen(true);
        }
      } catch { if (!cancelled) setEngineOptions([]); }
    })();
    return () => { cancelled = true; };
  }, [gYear, gMake, gModel]);

  function selectModel(m: string) {
    setGModel(m);
    setModelOpen(false);
    setModelOptions([]);
    setGEngine("");
    setEngineOptions([]);
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const vin = vinQ.trim().toUpperCase();
      if (vin.length < 11) { setVinLocked(false); return; }
      const r = await fetch(`/api/vehicles/vin?vin=${encodeURIComponent(vin)}`);
      const data = await r.json();
      if (cancelled) return;
      const decoded = data?.decoded;
      const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setEngineOptions(suggestions);
      const canFill = !vinLocked || (!gYear.trim() && !gMake.trim() && !gModel.trim());
      if (decoded?.year && decoded?.make && decoded?.model && canFill) {
        setGYear(decoded.year);
        setGMake(decoded.make);
        setGModel(decoded.model);
        setVinLocked(true);
        setMakeOpen(false);
        setModelOpen(false);
      }
      if (!gEngine.trim() && suggestions.length > 0) {
        setGEngine(suggestions[0]);
      }
    }
    run().catch(() => {
      if (!cancelled) { setEngineOptions([]); setVinLocked(false); }
    });
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

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSubmitting(true);
    try {
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body: any = { email: authEmail, password: authPassword };
      if (authMode === "register") {
        body.firstName = authFirstName;
        body.lastName = authLastName;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "Something went wrong.");
        return;
      }
      setAuthModalOpen(false);
      setAuthEmail("");
      setAuthPassword("");
      setAuthFirstName("");
      setAuthLastName("");
      const userRes = await fetch("/api/auth/user");
      const user = await userRes.json();
      if (user && user.id) {
        setAuthUser(user);
        const garageRes = await fetch("/api/garage");
        if (garageRes.ok) {
          const gData = await garageRes.json();
          if (gData && gData.garage) {
            setGarage(gData.garage);
            setActiveId(gData.activeId || gData.garage[0]?.id || null);
            if (gData.maintenance) setMaintenanceRecords(gData.maintenance);
          }
        }
      }
      showToast(authMode === "login" ? "Signed in successfully!" : "Account created successfully!");
    } catch {
      setAuthError("Connection error. Please try again.");
    } finally {
      setAuthSubmitting(false);
    }
  };

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
          onConfirm={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}
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

            {!authLoading && (
              authUser ? (
                <div className="relative">
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className={cn(
                      "flex h-10 items-center gap-2 px-2.5 shrink-0 rounded-xl transition-all",
                      t("border border-white/10 bg-white/10 hover:bg-white/20", "border border-slate-200 bg-slate-50 hover:bg-slate-100")
                    )}
                  >
                    {authUser.profile_image ? (
                      <img src={authUser.profile_image} alt="" className="h-6 w-6 rounded-full" />
                    ) : (
                      <div className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold", t("bg-blue-500 text-white", "bg-blue-100 text-blue-700"))}>
                        {(authUser.first_name || authUser.email || "U")[0].toUpperCase()}
                      </div>
                    )}
                    <span className={cn("hidden sm:inline text-sm font-medium truncate max-w-[80px]", t("text-slate-200", "text-slate-700"))}>
                      {authUser.first_name || authUser.email?.split("@")[0] || tr("myAccount", lang)}
                    </span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={t("#94a3b8", "#64748b")} strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                  {userMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                      <div className={cn("absolute right-0 top-full mt-2 z-50 rounded-xl shadow-xl overflow-hidden w-48", t("glass-dropdown", "bg-white border border-slate-200 shadow-lg"))}>
                        <div className={cn("px-4 py-3 border-b", t("border-white/10", "border-slate-100"))}>
                          <div className={cn("text-sm font-semibold truncate", t("text-white", "text-slate-900"))}>
                            {authUser.first_name ? `${authUser.first_name}${authUser.last_name ? ` ${authUser.last_name}` : ""}` : authUser.email || tr("myAccount", lang)}
                          </div>
                          {authUser.email && authUser.first_name && (
                            <div className={cn("text-xs truncate mt-0.5", t("text-slate-400", "text-slate-500"))}>{authUser.email}</div>
                          )}
                          <div className="flex items-center gap-1.5 mt-2">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                            <span className="text-[10px] text-emerald-500">{tr("dataSynced", lang)}</span>
                          </div>
                        </div>
                        <a
                          href="/api/auth/logout"
                          className={cn("w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 transition-colors", t("text-red-400 hover:bg-white/10", "text-red-500 hover:bg-red-50"))}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                          {tr("signOut", lang)}
                        </a>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => { setAuthMode("login"); setAuthError(""); setAuthModalOpen(true); }}
                  className="flex h-10 items-center gap-2 px-4 shrink-0 rounded-xl bg-blue-500 text-white text-sm font-semibold transition-all hover:bg-blue-400 shadow-md shadow-blue-500/25"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                  {tr("signIn", lang)}
                </button>
              )
            )}
          </div>
        </div>

        <div className={cn("mt-4 flex items-center gap-1 rounded-2xl p-1 overflow-x-auto", cardClass)}>
          {(["diagnose", "garage", "service", "codes"] as const).map((tabName) => (
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
              {tabName === "diagnose" ? tr("diagnose", lang) : tabName === "garage" ? tr("garage", lang) : tabName === "service" ? tr("service", lang) : tr("codes", lang)}
            </button>
          ))}
        </div>

        <div className="mt-4 relative z-30">
          {activeVehicle ? (
            <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 sm:px-5 py-4 overflow-visible", cardStrongClass)}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/20">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                    <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                    <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                    <path d="M9 17h6" />
                  </svg>
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
                    onShare={result ? handleShare : undefined}
                    onDownload={result ? handleDownload : undefined}
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
                      <input name="code" placeholder={tr("codePlaceholder", lang)} className={cn(inputClass, "rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")} />
                      <textarea name="symptoms" placeholder={tr("symptomsPlaceholder", lang)} value={symptomsValue} onChange={(e) => setSymptomsValue(e.target.value)} className={cn(inputClass, "min-h-[100px] rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors resize-none")} />

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
                        onShare={result ? handleShare : undefined}
                        onDownload={result ? handleDownload : undefined}
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
          <div key="tab-garage" className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[440px_1fr] animate-slide-in">
            <div ref={garageFormRef} className={cn("rounded-3xl p-5 sm:p-6 animate-fade-in-up relative z-20 overflow-visible", cardStrongClass)}>
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/20">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </div>
                <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("addVehicle", lang)}</div>
              </div>
              <div className={cn("mt-1 ml-9 text-xs", t("text-slate-400", "text-slate-500"))}>{tr("savedLocally", lang)}</div>

              <form className="mt-5 grid gap-3" onSubmit={(e) => { e.preventDefault(); addVehicle(new FormData(e.currentTarget)); (e.currentTarget as HTMLFormElement).reset(); setGYear(""); setGMake(""); setGModel(""); setGVin(""); setGEngine(""); }}>
                <input
                  name="vin"
                  placeholder={tr("vinPlaceholder", lang)}
                  value={gVin}
                  onChange={(e) => setGVin(e.target.value)}
                  className={cn(inputClass, "rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="relative">
                    <input
                      name="make"
                      placeholder={tr("make", lang)}
                      value={gMake}
                      onChange={(e) => { setGMake(e.target.value); setMakeOpen(true); }}
                      onFocus={() => setMakeOpen(true)}
                      onBlur={() => { setTimeout(() => setMakeOpen(false), 200); }}
                      className={cn(inputClass, "w-full rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                    />
                    {makeOpen && makeOptions.length > 0 && (
                      <div className={cn("absolute z-[100] mt-1 max-h-48 w-full overflow-auto rounded-xl shadow-xl", dropdownClass)}>
                        {makeOptions.map((m, idx) => (
                          <button key={`${m}-${idx}`} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => selectMake(m)} className={cn("w-full px-4 py-2 text-left text-sm transition-colors hover:bg-blue-500 hover:text-white", t("text-slate-200", "text-slate-700"))}>{m}</button>
                        ))}
                      </div>
                    )}
                  </div>

                  <input
                    name="year"
                    placeholder={tr("year", lang)}
                    value={gYear}
                    onChange={(e) => setGYear(e.target.value)}
                    className={cn(inputClass, "rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                  />

                  <div className="relative">
                    <input
                      name="model"
                      placeholder={tr("model", lang)}
                      value={gModel}
                      onChange={(e) => { setGModel(e.target.value); setModelOpen(true); }}
                      onFocus={() => setModelOpen(true)}
                      onBlur={() => { setTimeout(() => setModelOpen(false), 200); }}
                      className={cn(inputClass, "w-full rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                    />
                    {modelOpen && modelOptions.length > 0 && (
                      <div className={cn("absolute z-[100] mt-1 max-h-48 w-full overflow-auto rounded-xl shadow-xl", dropdownClass)}>
                        {modelOptions.map((m, idx) => (
                          <button key={`${m}-${idx}`} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => selectModel(m)} className={cn("w-full px-4 py-2 text-left text-sm transition-colors hover:bg-blue-500 hover:text-white", t("text-slate-200", "text-slate-700"))}>{m}</button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <input
                      name="engine"
                      ref={engineInputRef}
                      placeholder={tr("engine", lang)}
                      value={gEngine}
                      onChange={(e) => { setGEngine(e.target.value); setEngineOpen(true); }}
                      onFocus={() => { setEngineOpen(true); }}
                      onBlur={() => { setTimeout(() => setEngineOpen(false), 200); }}
                      className={cn(inputClass, "w-full rounded-2xl px-4 py-3 text-sm sm:text-sm text-base transition-colors")}
                    />
                    {engineOpen && engineOptions.length > 0 && (
                      <div className={cn("absolute z-[100] mt-1 max-h-48 w-full overflow-auto rounded-xl shadow-xl", dropdownClass)}>
                        {engineOptions.map((e: any, idx: number) => {
                          const label = typeof e === "string" ? e : e.label || e.engine;
                          const details = typeof e === "string" ? "" : e.details;
                          const engineKey = typeof e === "string" ? `${e}-${idx}` : `${e.id || label}-${idx}`;
                          return (
                            <button
                              key={engineKey}
                              type="button"
                              onMouseDown={(ev) => ev.preventDefault()}
                              onClick={() => { setGEngine(label); setEngineOpen(false); }}
                              className={cn("group w-full px-4 py-2 text-left text-sm transition-colors hover:bg-blue-500 hover:text-white", t("text-slate-200", "text-slate-700"))}
                            >
                              <div className="font-medium">{label}</div>
                              {details && <div className={cn("text-[10px] group-hover:text-blue-100", t("text-slate-400", "text-slate-500"))}>{details}</div>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
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
                            <button onClick={() => setConfirmDialog({ open: true, title: tr("deleteVehicle", lang), message: tr("deleteVehicleMsg", lang), confirmLabel: tr("delete", lang), onConfirm: () => removeVehicle(v.id) })} className={cn("rounded-xl px-2 py-1.5 text-xs transition-colors", t("text-slate-500 hover:text-red-400", "text-slate-400 hover:text-red-500"))}>{tr("delete", lang)}</button>
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
                              <input name="maint_mileage" placeholder={tr("mileage", lang)} className={cn(inputClass, "rounded-xl px-3 py-2 text-xs transition-colors")} />
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
                                    <span className={cn(t("text-slate-400", "text-slate-500"))}>{mr.date}</span>
                                  </div>
                                  {mr.mileage && <div className={cn("mt-0.5", t("text-slate-400", "text-slate-500"))}>{mr.mileage} mi</div>}
                                  {mr.notes && <div className={cn("mt-0.5", t("text-slate-400", "text-slate-500"))}>{mr.notes}</div>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className={cn("text-center py-4 text-xs", t("text-slate-500", "text-slate-400"))}>
                              {tr("noServiceRecords", lang)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div key="tab-codes" className="mt-8 animate-slide-in">
            <div className={cn("rounded-3xl p-5 sm:p-6", cardStrongClass)}>
              <div className="flex items-center gap-2 mb-4">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/20">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </div>
                <div className={cn("text-sm font-semibold", t("text-white", "text-slate-900"))}>{tr("commonCodes", lang)}</div>
              </div>

              <input
                placeholder={tr("searchCodes", lang)}
                value={codesSearch}
                onChange={(e) => setCodesSearch(e.target.value)}
                className={cn(inputClass, "w-full rounded-2xl px-4 py-3 text-sm transition-colors mb-4")}
              />

              <div className="flex flex-wrap gap-2 mb-4">
                <button
                  onClick={() => setCodesCategory(null)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[11px] font-medium transition-all",
                    codesCategory === null
                      ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30"
                      : t("border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:text-blue-300", "border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:text-blue-600")
                  )}
                >
                  {tr("all", lang)}
                </button>
                {Object.entries(CATEGORY_LABELS).map(([key, cat]) => (
                  <button
                    key={key}
                    onClick={() => setCodesCategory(codesCategory === key ? null : key)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[11px] font-medium transition-all",
                      codesCategory === key
                        ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30"
                        : t("border border-white/10 bg-white/5 text-slate-300 hover:border-blue-400/30 hover:text-blue-300", "border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:text-blue-600")
                    )}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              <div className="space-y-3 max-h-[600px] overflow-y-auto">
                {COMMON_CODES
                  .filter((c) => {
                    const q = codesSearch.toLowerCase();
                    const matchesSearch = !q || c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
                    const matchesCategory = !codesCategory || c.category === codesCategory;
                    return matchesSearch && matchesCategory;
                  })
                  .map((c, idx) => {
                    const cat = CATEGORY_LABELS[c.category];
                    const sevConfig = {
                      high: { label: "High", bg: t("bg-red-500/15 text-red-300 border-red-500/30", "bg-red-50 text-red-600 border-red-200"), dot: "bg-red-400" },
                      medium: { label: "Medium", bg: t("bg-yellow-500/15 text-yellow-300 border-yellow-500/30", "bg-yellow-50 text-yellow-600 border-yellow-200"), dot: "bg-yellow-400" },
                      low: { label: "Low", bg: t("bg-slate-500/15 text-slate-300 border-slate-500/30", "bg-slate-100 text-slate-500 border-slate-200"), dot: "bg-slate-400" },
                    };
                    const sev = sevConfig[c.severity];
                    return (
                      <div key={c.code} className={cn("rounded-2xl border p-4 transition-all animate-scale-in", t("border-white/10 bg-white/5 hover:border-white/20", "border-slate-200 bg-slate-50 hover:border-slate-300"))} style={{ animationDelay: `${idx * 0.02}s` }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={cn("text-sm font-bold font-mono", t("text-cyan-300", "text-cyan-700"))}>{c.code}</span>
                              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold", sev.bg)}>
                                <span className={cn("h-1.5 w-1.5 rounded-full", sev.dot)} />
                                {sev.label}
                              </span>
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${cat?.color}20`, color: cat?.color, border: `1px solid ${cat?.color}40` }}>
                                {cat?.label}
                              </span>
                            </div>
                            <div className={cn("mt-1 text-sm", t("text-white", "text-slate-900"))}>{c.description}</div>
                            <div className={cn("mt-1 text-xs", t("text-slate-400", "text-slate-500"))}>{tr("commonCause", lang)}: {c.commonCause}</div>
                          </div>
                          <button
                            onClick={() => {
                              setTab("diagnose");
                              setSearchPanelOpen(true);
                              setHasSearched(false);
                              setTimeout(() => {
                                const codeInput = document.querySelector<HTMLInputElement>('input[name="code"]');
                                if (codeInput) { codeInput.value = c.code; codeInput.focus(); }
                              }, 100);
                            }}
                            className={cn("shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all", t("border border-white/10 bg-white/5 text-blue-300 hover:bg-blue-500/20 hover:border-blue-400/30", "border border-slate-200 bg-slate-50 text-blue-600 hover:bg-blue-50 hover:border-blue-300"))}
                          >
                            {tr("diagnoseThis", lang)}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                {COMMON_CODES.filter((c) => {
                  const q = codesSearch.toLowerCase();
                  return (!q || c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) && (!codesCategory || c.category === codesCategory);
                }).length === 0 && (
                  <div className={cn("rounded-2xl p-8 text-center", t("border border-dashed border-white/15 bg-white/5", "border border-dashed border-slate-200 bg-slate-50"))}>
                    <div className={cn("text-sm font-medium", t("text-slate-400", "text-slate-500"))}>{tr("noCodesFound", lang)}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
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

        {!authUser && !authLoading && (
          <div className={cn("mt-4 mb-6 rounded-2xl px-4 py-3 flex items-center gap-3", t("bg-amber-500/10 border border-amber-500/20", "bg-amber-50 border border-amber-200"))}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div className="flex-1 min-w-0">
              <div className={cn("text-xs sm:text-sm", t("text-amber-200/80", "text-amber-800"))}>{tr("guestWarning", lang)}</div>
            </div>
            <button
              onClick={() => { setAuthMode("login"); setAuthError(""); setAuthModalOpen(true); }}
              className="shrink-0 rounded-lg bg-amber-500 text-white px-3 py-1.5 text-xs font-semibold transition hover:bg-amber-400"
            >
              {tr("signIn", lang)}
            </button>
          </div>
        )}
      </div>
      {authModalOpen && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setAuthModalOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="relative w-full max-w-sm rounded-2xl bg-slate-800/95 border border-white/10 shadow-2xl p-6 backdrop-blur-xl">
              <button
                onClick={() => setAuthModalOpen(false)}
                className="absolute top-4 right-4 text-slate-400 hover:text-white transition"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>

              <h2 className="text-xl font-bold text-white mb-1">
                {authMode === "login" ? tr("signIn", lang) : tr("signUp", lang)}
              </h2>
              <p className="text-sm text-slate-400 mb-5">
                {authMode === "login" ? tr("guestWarning", lang).split(".")[0] + "." : tr("guestWarning", lang).split(".")[0] + "."}
              </p>

              {authError && (
                <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
                  {authError}
                </div>
              )}

              <a
                href="/api/auth/google"
                className="flex items-center justify-center gap-3 w-full rounded-xl border border-white/10 bg-slate-700/40 py-2.5 text-sm font-medium text-white hover:bg-slate-700/70 transition"
              >
                <svg width="18" height="18" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                {authMode === "login" ? tr("signInGoogle", lang) : tr("signUpGoogle", lang)}
              </a>

              <div className="flex items-center gap-3 my-1">
                <div className="flex-1 h-px bg-white/10"></div>
                <span className="text-xs text-slate-500">{tr("orLabel", lang)}</span>
                <div className="flex-1 h-px bg-white/10"></div>
              </div>

              <form onSubmit={handleAuthSubmit} className="space-y-3">
                {authMode === "register" && (
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-xs text-slate-400 mb-1">{tr("firstName", lang)}</label>
                      <input
                        type="text"
                        value={authFirstName}
                        onChange={(e) => setAuthFirstName(e.target.value)}
                        className="w-full rounded-lg bg-slate-700/50 border border-white/10 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition"
                        placeholder="John"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs text-slate-400 mb-1">{tr("lastName", lang)}</label>
                      <input
                        type="text"
                        value={authLastName}
                        onChange={(e) => setAuthLastName(e.target.value)}
                        className="w-full rounded-lg bg-slate-700/50 border border-white/10 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition"
                        placeholder="Doe"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-slate-400 mb-1">{tr("email", lang)}</label>
                  <input
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="w-full rounded-lg bg-slate-700/50 border border-white/10 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition"
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">{tr("password", lang)}</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="w-full rounded-lg bg-slate-700/50 border border-white/10 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition"
                    placeholder="••••••••"
                    autoComplete={authMode === "login" ? "current-password" : "new-password"}
                  />
                </div>

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full rounded-xl bg-blue-500 text-white py-2.5 text-sm font-semibold transition hover:bg-blue-400 disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-blue-500/25 mt-2"
                >
                  {authSubmitting ? "..." : authMode === "login" ? tr("signIn", lang) : tr("signUp", lang)}
                </button>
              </form>

              <div className="mt-4 text-center text-sm text-slate-400">
                {authMode === "login" ? tr("noAccount", lang) : tr("haveAccount", lang)}{" "}
                <button
                  onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}
                  className="text-blue-400 hover:text-blue-300 font-semibold transition"
                >
                  {authMode === "login" ? tr("signUp", lang) : tr("signIn", lang)}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
