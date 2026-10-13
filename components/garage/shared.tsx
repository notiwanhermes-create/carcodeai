"use client";

/**
 * Small building blocks shared by the garage pages. They reuse the app's
 * existing look (dark glass cards, blue actions) and add no new visual language.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import type { DiagnosisStatus } from "@/app/lib/garage-types";

export function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export const SERVICE_TYPES = [
  "Oil Change",
  "Brake Service",
  "Tire Rotation",
  "Tire Replacement",
  "Air Filter",
  "Transmission Service",
  "Coolant Flush",
  "Spark Plugs",
  "Battery Replacement",
  "Alignment",
  "Inspection",
  "Other",
];

/** "Oct 12, 2026" from an ISO date or timestamp. The text itself if it is not a date. */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "";
  // A plain calendar day is shown as that day everywhere, whatever the time zone.
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})(T00:00:00(\.000)?Z)?$/.exec(value);
  const date = dayOnly ? new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A cost as the user entered it, with a "$" only when they did not write a currency themselves. */
export function formatCost(text: string | null | undefined): string {
  const value = (text ?? "").trim();
  if (!value) return "";
  return /^[0-9]/.test(value) ? `$${value}` : value;
}

const STATUS_STYLE: Record<DiagnosisStatus, string> = {
  open: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  resolved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  dismissed: "bg-slate-500/15 text-slate-300 border-slate-500/30",
};
export const STATUS_LABEL: Record<DiagnosisStatus, string> = { open: "Not resolved", resolved: "Resolved", dismissed: "Dismissed" };

export function StatusBadge({ status }: { status: DiagnosisStatus }) {
  return (
    <span data-status={status} className={cn("inline-flex items-center rounded-lg border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CodeChips({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {codes.map((c) => (
        <span key={c} className="rounded-md border border-blue-500/20 bg-blue-500/15 px-1.5 py-0.5 font-mono text-[11px] text-blue-300">
          {c}
        </span>
      ))}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("glass-card rounded-2xl p-4 sm:p-5", className)}>{children}</section>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-white">{children}</h2>
      {aside}
    </div>
  );
}

export const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:border-blue-400/50";
export const primaryButton =
  "rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400 disabled:opacity-50";
export const quietButton =
  "rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition-all hover:border-white/20 hover:bg-white/10 disabled:opacity-50";

/** The page frame the dashboard uses: dark background, soft colour blobs, centred column. */
export function GaragePage({ title, subtitle, back, children }: { title: string; subtitle?: string; back: { href: string; label: string }; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#0f172a] text-slate-100">
      <div className="mesh-background">
        <div className="mesh-blob mesh-blob-1" />
        <div className="mesh-blob mesh-blob-2" />
        <div className="mesh-blob mesh-blob-3" />
      </div>
      <div className="relative z-10 mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-bold leading-snug text-white">{title}</h1>
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          <Link href={back.href} className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition-all hover:bg-white/10">
            {back.label}
          </Link>
        </div>
        <div className="space-y-4">{children}</div>
      </div>
    </main>
  );
}
