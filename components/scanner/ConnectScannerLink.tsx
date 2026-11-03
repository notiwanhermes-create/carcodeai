"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { tr, type LangCode } from "@/app/data/translations";
import { scannerRouteAnswers } from "@/app/lib/scanner-entry";
import { scannerEntryBuilt, scannerHref, type ScannerReturn, type ScannerVehicle } from "@/app/lib/scanner-preview";
import { cn } from "@/components/garage/shared";
import { PortIcon } from "@/components/scanner/ScannerIcons";

/** Whether `/scanner` is open on this site: at once under development or test, otherwise once the route answers. */
function useScannerAvailable(): boolean {
  const [available, setAvailable] = useState(scannerEntryBuilt);
  useEffect(() => {
    if (available) return;
    let current = true;
    void scannerRouteAnswers().then((answers) => {
      if (current && answers) setAvailable(true);
    });
    return () => {
      current = false;
    };
  }, [available]);
  return available;
}

/** The Connect Scanner entry on the client-rendered home garage (guests and signed-in). */
export function ConnectScannerLink({ vehicle, returnTo, className }: { vehicle: ScannerVehicle | null; returnTo: ScannerReturn; className?: string }) {
  const available = useScannerAvailable();
  if (!available) return null;
  return (
    <Link href={scannerHref(vehicle, returnTo)} data-connect-scanner className={className}>
      Connect Scanner
    </Link>
  );
}

/**
 * The home page's first section: plug in an OBD-II adapter and scan, and the
 * scanner identifies the car from its VIN. No vehicle is passed, so the car
 * itself, not the garage, says what it is.
 */
export function ScanCarCard({ lang, dark, className }: { lang: LangCode; dark: boolean; className?: string }) {
  const available = useScannerAvailable();
  if (!available) return null;
  return (
    <section
      data-scan-car
      className={cn(
        "relative overflow-hidden rounded-3xl p-5 sm:p-6",
        dark ? "border border-cyan-300/20 bg-gradient-to-br from-blue-600/25 via-slate-900/60 to-cyan-500/10" : "border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-cyan-50 shadow-sm",
        className,
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl", dark ? "bg-cyan-400/15 text-cyan-300" : "bg-blue-100 text-blue-600")}>
            <PortIcon className="size-6" />
          </div>
          <div>
            <h2 className={cn("text-lg font-semibold tracking-tight sm:text-xl", dark ? "text-white" : "text-slate-900")}>{tr("scanCarTitle", lang)}</h2>
            <p className={cn("mt-1 max-w-xl text-sm", dark ? "text-slate-300" : "text-slate-600")}>{tr("scanCarDesc", lang)}</p>
          </div>
        </div>
        <Link
          href={scannerHref(null, "garage")}
          data-scan-car-start
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-2xl bg-blue-500 px-6 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        >
          {tr("scanCarButton", lang)}
        </Link>
      </div>
    </section>
  );
}
