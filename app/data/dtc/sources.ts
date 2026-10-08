/**
 * Where trouble-code definitions come from.
 *
 * This list is the only place data is plugged into the lookup. To add a
 * provider, add its records as a file and one entry below; `buildRegistry` in
 * `app/lib/dtc.ts` checks every record and the lookup code does not change.
 *
 * Two provider roles are planned. Neither has been purchased or integrated.
 *
 *  1. role "standardized": SAE J2012-DA (the SAE J2012 Digital Annex).
 *     The authoritative definitions of ISO/SAE controlled codes. Records from it
 *     would use `verification: "verified"` and name the annex revision in
 *     `source`. List it ABOVE the curated core so it takes priority.
 *
 *  2. role "manufacturer": a licensed OEM data provider such as MOTOR, or a
 *     maker's own service information. Every record names its make and is only
 *     ever served for that make.
 *
 * Licensed data must not be committed to a public repository. Before adding
 * either provider, decide where the files live (a private repository, or
 * storage read at build time) and check that the licence allows the data to be
 * shown to end users.
 *
 * See ATTRIBUTION.md in this folder for the full notes.
 */
import type { DtcDataSource, GenericDtc, ManufacturerDtc } from "../../lib/dtc";
import curatedCore from "./generic.json";
import manufacturerStore from "./manufacturer.json";

export const DTC_SOURCES: DtcDataSource[] = [
  {
    id: "curated-core",
    role: "standardized",
    provider: "CarCode AI (entered by hand)",
    licence: "Not from a licensed dataset. A small interim set; never reported as verified.",
    records: curatedCore as GenericDtc[],
  },
  {
    id: "manufacturer-store",
    role: "manufacturer",
    provider: "None yet",
    licence: "Empty until a licensed OEM provider is chosen.",
    records: manufacturerStore as ManufacturerDtc[],
  },
];
