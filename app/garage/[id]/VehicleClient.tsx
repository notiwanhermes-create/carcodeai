"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/app/lib/analytics";
import type { VehicleDetailDto, VehicleDto } from "@/app/lib/garage-types";
import { formatOdometer } from "@/app/lib/odometer";
import { MaintenanceForm, MaintenanceRow, MileageEditor, TimelineList } from "@/components/garage/VehicleParts";
import { Card, CodeChips, GaragePage, SectionTitle, cn, formatDay, inputClass, primaryButton, quietButton } from "@/components/garage/shared";

const RECENT = 8;

type Panel = null | "mileage" | "maintenance" | "details" | "remove";

/**
 * One vehicle: what it is, what is still open, what has happened to it, and its
 * service records. Everything comes from the account's own records.
 */
export default function VehicleClient({ vehicleId }: { vehicleId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<VehicleDetailDto | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [panel, setPanel] = useState<Panel>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trim, setTrim] = useState("");
  const [nickname, setNickname] = useState("");
  const opened = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/garage/${encodeURIComponent(vehicleId)}`, { cache: "no-store" });
      if (res.status === 404) return setState("missing");
      const data = (await res.json().catch(() => null)) as VehicleDetailDto | null;
      if (!res.ok || !data?.vehicle) return setState("error");
      setDetail(data);
      setState("ready");
      if (!opened.current) {
        opened.current = true;
        track("vehicle_opened", { signed_in: true, source: "vehicle_page" });
      }
    } catch {
      setState("error");
    }
  }, [vehicleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = { href: "/dashboard", label: "My garage" };

  if (state !== "ready" || !detail) {
    return (
      <GaragePage title="Vehicle" back={back}>
        <Card>
          <p className="text-sm text-slate-300">
            {state === "loading" ? "Loading…" : state === "missing" ? "This vehicle could not be found in your garage." : "Could not load this vehicle. Please try again."}
          </p>
        </Card>
      </GaragePage>
    );
  }

  const { vehicle, openIssues, timeline, maintenance } = detail;
  const name = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  const archived = !!vehicle.archivedAt;
  const mileage = formatOdometer(vehicle.odometerValue, vehicle.odometerUnit);
  const hasHistory = timeline.length > 0;

  function open(next: Panel) {
    setError("");
    if (next === "details") {
      setTrim(vehicle.trim ?? "");
      setNickname(vehicle.nickname ?? "");
    }
    setPanel((current) => (current === next ? null : next));
  }

  function replaceVehicle(next: VehicleDto) {
    setDetail((d) => (d ? { ...d, vehicle: next } : d));
  }

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/garage/${encodeURIComponent(vehicle.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.vehicle) {
        setError(typeof data.error === "string" ? data.error : "Could not save that. Please try again.");
        return false;
      }
      replaceVehicle(data.vehicle as VehicleDto);
      return true;
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/garage/${encodeURIComponent(vehicle.id)}`, { method: "DELETE", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not remove the vehicle.");
        return;
      }
      router.push("/dashboard");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord(id: string) {
    try {
      const res = await fetch(`/api/maintenance/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store" });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("Could not delete that record. Please try again.");
    }
  }

  const facts: Array<[string, string]> = [
    ["Year", vehicle.year],
    ["Make", vehicle.make],
    ["Model", vehicle.model],
    ["Trim", vehicle.trim || "Not set"],
    ["Engine", vehicle.engine || "Not set"],
  ];

  return (
    <GaragePage title={vehicle.nickname || name} subtitle={vehicle.nickname ? name : undefined} back={back}>
      {archived && (
        <div data-archived-banner className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm text-amber-200">This vehicle is archived. It is out of your garage, and all of its history is kept.</p>
          <button type="button" data-restore-vehicle className={cn(quietButton, "mt-3")} disabled={busy} onClick={() => patch({ archived: false })}>
            Restore to my garage
          </button>
        </div>
      )}

      <Card>
        <SectionTitle
          aside={
            !archived && (
              <button type="button" data-edit-details className="text-xs text-blue-300 hover:text-blue-200" onClick={() => open("details")}>
                Edit details
              </button>
            )
          }
        >
          Vehicle
        </SectionTitle>
        <dl data-vehicle-identity className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
              <dd className={cn("mt-0.5", value === "Not set" ? "text-slate-500" : "text-slate-200")}>{value}</dd>
            </div>
          ))}
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Mileage</dt>
            <dd data-vehicle-mileage className={cn("mt-0.5", mileage ? "text-slate-200" : "text-slate-500")}>
              {mileage || "Not set"}
            </dd>
            {mileage && vehicle.odometerUpdatedAt && <dd className="text-[11px] text-slate-500">as of {formatDay(vehicle.odometerUpdatedAt)}</dd>}
          </div>
        </dl>
        {vehicle.vin && <div className="mt-3 font-mono text-[11px] text-slate-500">VIN: {vehicle.vin}</div>}

        {panel === "details" && (
          <div data-details-editor className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-slate-400">Trim (optional)</span>
                <input data-trim-input className={cn(inputClass, "mt-1")} maxLength={60} value={trim} onChange={(e) => setTrim(e.target.value)} placeholder="e.g. SE, Limited" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Nickname (optional)</span>
                <input className={cn(inputClass, "mt-1")} maxLength={60} value={nickname} onChange={(e) => setNickname(e.target.value)} />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-details-save
                className={primaryButton}
                disabled={busy}
                onClick={async () => {
                  if (await patch({ trim, nickname })) setPanel(null);
                }}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" className={quietButton} disabled={busy} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {panel === "mileage" && (
          <MileageEditor
            vehicle={vehicle}
            onCancel={() => setPanel(null)}
            onUpdated={(next) => {
              replaceVehicle(next);
              setPanel(null);
            }}
          />
        )}

        {!archived && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4">
            <Link href={`/?vehicle=${encodeURIComponent(vehicle.id)}`} data-action-diagnose className={primaryButton}>
              Diagnose new problem
            </Link>
            <button type="button" data-action-maintenance className={quietButton} onClick={() => open("maintenance")}>
              Add maintenance
            </button>
            <button type="button" data-action-mileage className={quietButton} onClick={() => open("mileage")}>
              Update mileage
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      </Card>

      <Card>
        <SectionTitle aside={<span data-open-count className="text-xs text-slate-400">{openIssues.length}</span>}>Open issues</SectionTitle>
        {openIssues.length === 0 ? (
          <p className="text-sm text-slate-400">No open issues.</p>
        ) : (
          <ul data-open-issues className="space-y-2">
            {openIssues.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/garage/${encodeURIComponent(vehicle.id)}/diagnosis/${encodeURIComponent(d.id)}`}
                  className="block rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 transition-all hover:border-amber-500/40"
                >
                  <div className="text-sm font-medium text-slate-100">{d.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>{formatDay(d.diagnosedAt)}</span>
                    <CodeChips codes={d.codes} />
                    <span className="text-blue-300">Open · did this get fixed?</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle>Recent history</SectionTitle>
        <TimelineList vehicleId={vehicle.id} items={timeline} limit={showAll ? undefined : RECENT} />
        {timeline.length > RECENT && (
          <button type="button" data-timeline-toggle className="mt-3 text-xs text-blue-300 hover:text-blue-200" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show recent only" : `Show all ${timeline.length}`}
          </button>
        )}
      </Card>

      <Card>
        <SectionTitle
          aside={
            !archived && (
              <button type="button" className="text-xs text-blue-300 hover:text-blue-200" onClick={() => open("maintenance")}>
                + Add record
              </button>
            )
          }
        >
          Maintenance
        </SectionTitle>
        {panel === "maintenance" && (
          <div className="mb-3">
            <MaintenanceForm
              vehicle={vehicle}
              source="vehicle_page"
              onCancel={() => setPanel(null)}
              onAdded={() => {
                setPanel(null);
                void load();
              }}
            />
          </div>
        )}
        {maintenance.length === 0 ? (
          <p className="text-sm text-slate-400">No service records yet.</p>
        ) : (
          <div data-maintenance-list className="space-y-2">
            {maintenance.map((r) => (
              <MaintenanceRow key={r.id} record={r} onDelete={deleteRecord} />
            ))}
          </div>
        )}
      </Card>

      {!archived && (
        <div className="pt-2">
          {panel !== "remove" ? (
            <button type="button" data-remove-vehicle className="text-xs text-slate-500 hover:text-red-300" onClick={() => open("remove")}>
              Remove this vehicle from my garage
            </button>
          ) : (
            <div data-remove-confirm className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm text-slate-200">
                {hasHistory
                  ? "This vehicle has history, so it will be archived, not deleted. It leaves your garage, its diagnoses, repairs and service records are kept, and you can restore it later."
                  : "This vehicle has no history. It will be deleted. This cannot be undone."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" data-remove-confirm-yes className={primaryButton} disabled={busy} onClick={remove}>
                  {hasHistory ? "Archive vehicle" : "Delete vehicle"}
                </button>
                <button type="button" className={quietButton} disabled={busy} onClick={() => setPanel(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </GaragePage>
  );
}
