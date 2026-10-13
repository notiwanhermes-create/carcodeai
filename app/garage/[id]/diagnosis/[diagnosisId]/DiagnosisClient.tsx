"use client";

import { useEffect, useState } from "react";
import { track } from "@/app/lib/analytics";
import type { DiagnosisDetailDto, VehicleDetailDto } from "@/app/lib/garage-types";
import type { OdometerUnit } from "@/app/lib/odometer";
import { OutcomePanel } from "@/components/garage/OutcomePanel";
import { StoredDiagnosisView } from "@/components/garage/StoredDiagnosisView";
import { Card, GaragePage, StatusBadge, formatDay } from "@/components/garage/shared";

/**
 * One saved diagnosis, reopened. Everything shown is read from the database:
 * what the user entered, what the AI answered at the time, the follow-up
 * answers, and the outcome the user reported. The AI is not called.
 */
export default function DiagnosisClient({ vehicleId, diagnosisId }: { vehicleId: string; diagnosisId: string }) {
  const [diagnosis, setDiagnosis] = useState<DiagnosisDetailDto | null>(null);
  const [unit, setUnit] = useState<OdometerUnit>("km");
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/diagnoses/${encodeURIComponent(diagnosisId)}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) return setState("missing");
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.diagnosis) return setState("error");
        setDiagnosis(data.diagnosis as DiagnosisDetailDto);
        setState("ready");
        track("diagnosis_reopened", { signed_in: true, source: "diagnosis_page" });

        // The vehicle's own unit is the default for a repair's mileage.
        const vehicleRes = await fetch(`/api/garage/${encodeURIComponent((data.diagnosis as DiagnosisDetailDto).vehicleId)}`, { cache: "no-store" });
        const detail = (await vehicleRes.json().catch(() => null)) as VehicleDetailDto | null;
        if (!cancelled && vehicleRes.ok && detail?.vehicle?.odometerUnit) setUnit(detail.vehicle.odometerUnit);
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diagnosisId]);

  const back = { href: `/garage/${encodeURIComponent(diagnosis?.vehicleId || vehicleId)}`, label: "Back to vehicle" };

  if (state !== "ready" || !diagnosis) {
    return (
      <GaragePage title="Saved diagnosis" back={back}>
        <Card>
          <p className="text-sm text-slate-300">
            {state === "loading" ? "Loading…" : state === "missing" ? "This diagnosis could not be found in your garage." : "Could not load this diagnosis. Please try again."}
          </p>
        </Card>
      </GaragePage>
    );
  }

  return (
    <GaragePage title={diagnosis.title} subtitle={`Diagnosed ${formatDay(diagnosis.diagnosedAt)}${diagnosis.updateCount > 0 ? ` · updated with your answers ${formatDay(diagnosis.updatedAt)}` : ""}`} back={back}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={diagnosis.status} />
        <span className="text-xs text-slate-400">This is the diagnosis as it was saved. Opening it does not run a new one.</span>
      </div>
      <OutcomePanel diagnosis={diagnosis} defaultUnit={unit} onChange={setDiagnosis} />
      <StoredDiagnosisView diagnosis={diagnosis} />
    </GaragePage>
  );
}
