import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseScannerVehicle, scannerPreviewEnabled } from "@/app/lib/scanner-preview";
import ScannerClient from "./ScannerClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CarCode Scanner",
  robots: { index: false, follow: false },
};

/** The gated scanner preview. Open to guests: no session, no database and no API call here. */
export default async function ScannerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!scannerPreviewEnabled()) notFound();
  return <ScannerClient vehicle={parseScannerVehicle(await searchParams)} />;
}
