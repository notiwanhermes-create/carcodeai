"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { scannerRouteAnswers } from "@/app/lib/scanner-entry";
import { scannerEntryBuilt, scannerHref, type ScannerReturn, type ScannerVehicle } from "@/app/lib/scanner-preview";

/** The Connect Scanner entry on the client-rendered home garage (guests and signed-in). */
export function ConnectScannerLink({ vehicle, returnTo, className }: { vehicle: ScannerVehicle | null; returnTo: ScannerReturn; className?: string }) {
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
  if (!available) return null;
  return (
    <Link href={scannerHref(vehicle, returnTo)} data-connect-scanner className={className}>
      Connect Scanner
    </Link>
  );
}
