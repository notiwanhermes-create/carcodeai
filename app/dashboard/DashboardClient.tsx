"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VehicleDeleteButton } from "@/components/VehicleDeleteButton";
import { MaintenanceForm, MaintenanceRow } from "@/components/garage/VehicleParts";
import { formatDay } from "@/components/garage/shared";
import { track } from "@/app/lib/analytics";
import type { MaintenanceDto, VehicleDto } from "@/app/lib/garage-types";
import { formatOdometer } from "@/app/lib/odometer";
import { useGarageVehicles, type GarageVehicle } from "@/app/lib/useGarageVehicles";
import { tr, type LangCode } from "@/app/data/translations";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

type Vehicle = GarageVehicle;

export default function DashboardClient() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const lang: LangCode = "en";
  const theme = "dark" as const;

  const {
    vehicles,
    hydrated: vehiclesHydrated,
    syncing: vehiclesSyncing,
    refresh: refreshVehicles,
    addVehicle: addGarageVehicle,
    deleteVehicle: deleteGarageVehicle,
  } = useGarageVehicles({ userId: session?.user?.id, ready: status !== "loading" });
  const [records, setRecords] = useState<MaintenanceDto[]>([]);
  // Vehicles the user removed that still have history. Nothing of theirs was deleted.
  const [archived, setArchived] = useState<VehicleDto[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [notice, setNotice] = useState("");

  const [vYear, setVYear] = useState("");
  const [vMake, setVMake] = useState("");
  const [vModel, setVModel] = useState("");
  const [vEngine, setVEngine] = useState("");
  const [vVin, setVVin] = useState("");
  const [vNickname, setVNickname] = useState("");
  const [vehicleError, setVehicleError] = useState("");
  const [vehicleSaving, setVehicleSaving] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login?callbackUrl=/dashboard");
    }
  }, [status, router]);

  const fetchMaintenance = useCallback(async () => {
    setMaintenanceLoading(true);
    try {
      const res = await fetch("/api/maintenance", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setRecords(data.records || []);
    } finally {
      setMaintenanceLoading(false);
    }
  }, []);

  const fetchArchived = useCallback(async () => {
    try {
      const res = await fetch("/api/garage?archived=1", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setArchived(Array.isArray(data.vehicles) ? data.vehicles : []);
    } catch {
      // The list of archived vehicles is not essential to the page.
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      void fetchMaintenance();
      void fetchArchived();
    }
  }, [status, fetchMaintenance, fetchArchived]);

  useEffect(() => {
    setSelectedVehicleId((prev) => {
      if (prev && vehicles.some((v) => v.id === prev)) return prev;
      return vehicles[0]?.id ?? null;
    });
  }, [vehicles]);

  async function addVehicle() {
    setVehicleError("");
    if (!vYear || !vMake || !vModel) {
      setVehicleError("Year, make, and model are required.");
      return;
    }
    setVehicleSaving(true);
    try {
      const v = await addGarageVehicle({
        year: vYear,
        make: vMake,
        model: vModel,
        engine: vEngine || undefined,
        vin: vVin || undefined,
        nickname: vNickname || undefined,
      });
      track("vehicle_added", { signed_in: true, source: "dashboard" });
      setSelectedVehicleId(v.id);
      setShowAddVehicle(false);
      setVYear("");
      setVMake("");
      setVModel("");
      setVEngine("");
      setVVin("");
      setVNickname("");
    } catch (e: unknown) {
      setVehicleError(e instanceof Error ? e.message : "Failed to add vehicle.");
    } finally {
      setVehicleSaving(false);
    }
  }

  /**
   * Removing a vehicle never deletes its history. A vehicle with service
   * records or diagnoses is archived and can be restored; only a vehicle with
   * nothing attached is deleted. The server decides; the wording here says
   * which one to expect.
   */
  function requestDeleteVehicle(v: Vehicle) {
    const hasHistory = records.some((r) => r.vehicleId === v.id) || (v.stats ? v.stats.diagnoses + v.stats.maintenanceRecords > 0 : false);
    setNotice("");
    setConfirmDialog({
      open: true,
      title: hasHistory ? tr("archiveVehicleTitle", lang) : tr("deleteVehicle", lang),
      message: hasHistory ? tr("archiveVehicleMsg", lang) : tr("deleteVehicleMsg", lang),
      confirmLabel: hasHistory ? tr("archiveVehicleConfirm", lang) : tr("delete", lang),
      onConfirm: async () => {
        const outcome = await deleteGarageVehicle(v.id);
        if (outcome.archived) {
          setNotice(tr("vehicleArchived", lang));
          void fetchArchived();
        } else {
          setRecords((prev) => prev.filter((r) => r.vehicleId !== v.id));
        }
        setSelectedVehicleId((prev) => (prev === v.id ? null : prev));
      },
    });
  }

  async function restoreVehicle(id: string) {
    setNotice("");
    try {
      const res = await fetch(`/api/garage/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ archived: false }),
      });
      if (!res.ok) throw new Error();
      await Promise.all([refreshVehicles(), fetchArchived()]);
    } catch {
      setNotice("Could not restore that vehicle. Please try again.");
    }
  }

  async function deleteRecord(id: string) {
    const res = await fetch(`/api/maintenance/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store" });
    if (!res.ok) return;
    setRecords((prev) => prev.filter((r) => r.id !== id));
    // The vehicle's "last maintenance" may have changed with it.
    refreshVehicles().catch(() => {});
  }

  const filteredRecords = records.filter((r) => {
    if (selectedVehicleId && r.vehicleId !== selectedVehicleId) return false;
    return true;
  });

  if (status === "loading") {
    return (
      <main className="min-h-screen bg-[#0f172a] text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </main>
    );
  }

  if (status === "unauthenticated") return null;

  const selectedVehicle = vehicles.find((v) => v.id === selectedVehicleId);

  return (
    <main className="min-h-screen bg-[#0f172a] text-slate-100">
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
      <div className="mesh-background">
        <div className="mesh-blob mesh-blob-1" />
        <div className="mesh-blob mesh-blob-2" />
        <div className="mesh-blob mesh-blob-3" />
      </div>

      <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 py-6">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Link href="/">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-500 shadow-lg shadow-blue-500/30">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                  <path d="M9 17h6" />
                </svg>
              </div>
            </Link>
            <div>
              <h1 className="text-xl font-bold text-white">My Dashboard</h1>
              <p className="text-xs text-slate-400">{session?.user?.email}</p>
            </div>
          </div>
          <Link
            href="/"
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 hover:bg-white/10 transition-all"
          >
            Back to Diagnostics
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">My Garage</h2>
              <button
                onClick={() => setShowAddVehicle(!showAddVehicle)}
                className="rounded-xl bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-blue-500/20 hover:bg-blue-400 transition-all"
              >
                + Add Vehicle
              </button>
            </div>

            {notice && (
              <div role="status" data-garage-notice className="glass-card rounded-2xl p-3 text-xs text-blue-200">
                {notice}
              </div>
            )}

            {showAddVehicle && (
              <div className="glass-card-strong rounded-2xl p-5 space-y-3">
                <div className="text-sm font-semibold text-white mb-2">New Vehicle</div>
                <input
                  placeholder="Year *"
                  value={vYear}
                  onChange={(e) => setVYear(e.target.value)}
                  className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                />
                <input
                  placeholder="Make *"
                  value={vMake}
                  onChange={(e) => setVMake(e.target.value)}
                  className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                />
                <input
                  placeholder="Model *"
                  value={vModel}
                  onChange={(e) => setVModel(e.target.value)}
                  className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                />
                <input
                  placeholder="Engine (optional)"
                  value={vEngine}
                  onChange={(e) => setVEngine(e.target.value)}
                  className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                />
                <input
                  placeholder="VIN (optional)"
                  value={vVin}
                  onChange={(e) => setVVin(e.target.value)}
                  className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                />
                <input
                  placeholder="Nickname (optional)"
                  value={vNickname}
                  onChange={(e) => setVNickname(e.target.value)}
                  className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                />
                {vehicleError && <div className="text-xs text-red-400">{vehicleError}</div>}
                <div className="flex gap-2">
                  <button
                    onClick={addVehicle}
                    disabled={vehicleSaving}
                    className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-2 text-xs font-semibold text-white transition-all"
                  >
                    {vehicleSaving ? "Saving..." : "Save Vehicle"}
                  </button>
                  <button
                    onClick={() => setShowAddVehicle(false)}
                    className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-slate-400 hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {!vehiclesHydrated ? (
              <div className="glass-card rounded-2xl p-6 text-center">
                <div className="text-slate-400 text-sm">Loading...</div>
              </div>
            ) : vehicles.length === 0 && !showAddVehicle ? (
              <div className="glass-card rounded-2xl p-6 text-center">
                <div className="text-slate-400 text-sm">No vehicles yet. Add your first one!</div>
              </div>
            ) : (
              vehicles.map((v) => {
                // Facts from the account's own records. Nothing here is scored or estimated.
                const mileage = formatOdometer(v.odometerValue ?? null, v.odometerUnit ?? null);
                const openIssues = v.stats?.openIssues ?? 0;
                return (
                  <div
                    key={v.id}
                    data-vehicle-card
                    onClick={() => setSelectedVehicleId(v.id)}
                    className={cn(
                      "glass-card rounded-2xl p-4 cursor-pointer transition-all",
                      selectedVehicleId === v.id
                        ? "ring-2 ring-blue-500/50 bg-blue-500/10"
                        : "hover:bg-white/5"
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        {v.nickname && (
                          <div className="text-xs font-medium text-cyan-400 mb-0.5">
                            {v.nickname}
                          </div>
                        )}
                        <div className="text-sm font-semibold text-white">
                          {v.year} {v.make} {v.model}
                          {v.trim ? ` ${v.trim}` : ""}
                        </div>
                        {v.engine && <div className="text-xs text-slate-400 mt-0.5">{v.engine}</div>}
                        {v.vin && (
                          <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
                            VIN: {v.vin}
                          </div>
                        )}
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <VehicleDeleteButton
                          theme={theme}
                          lang={lang}
                          disabled={vehiclesSyncing}
                          onClick={() => requestDeleteVehicle(v)}
                        />
                      </div>
                    </div>
                    <dl data-vehicle-card-facts className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                      <div>
                        <dt className="text-slate-500">Mileage</dt>
                        <dd className={mileage ? "text-slate-200" : "text-slate-500"}>{mileage || "Not set"}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Open issues</dt>
                        <dd data-open-issues className={openIssues > 0 ? "font-semibold text-amber-300" : "text-slate-200"}>{openIssues}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Last diagnosis</dt>
                        <dd className={v.stats?.lastDiagnosisAt ? "text-slate-200" : "text-slate-500"}>
                          {v.stats?.lastDiagnosisAt ? formatDay(v.stats.lastDiagnosisAt) : "None yet"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Last maintenance</dt>
                        <dd className={v.stats?.lastMaintenance ? "text-slate-200" : "text-slate-500"}>
                          {v.stats?.lastMaintenance ? `${v.stats.lastMaintenance.serviceType} · ${formatDay(v.stats.lastMaintenance.date)}` : "None yet"}
                        </dd>
                      </div>
                    </dl>
                    <Link
                      href={`/garage/${encodeURIComponent(v.id)}`}
                      data-open-vehicle
                      onClick={(e) => e.stopPropagation()}
                      className="mt-3 inline-block rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/20 transition-all"
                    >
                      Open vehicle
                    </Link>
                  </div>
                );
              })
            )}

            {archived.length > 0 && (
              <div data-archived-list className="pt-2">
                <div className="mb-2 text-xs font-semibold text-slate-400">Archived vehicles ({archived.length})</div>
                <div className="space-y-2">
                  {archived.map((v) => (
                    <div key={v.id} className="glass-card flex items-center justify-between gap-2 rounded-2xl p-3">
                      <Link href={`/garage/${encodeURIComponent(v.id)}`} className="min-w-0 truncate text-xs text-slate-300 hover:text-blue-300">
                        {v.year} {v.make} {v.model}
                      </Link>
                      <button
                        type="button"
                        data-restore
                        onClick={() => restoreVehicle(v.id)}
                        className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10 transition-all"
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-lg font-semibold text-white">
                Maintenance Records
                {selectedVehicle && (
                  <span className="text-sm font-normal text-slate-400 ml-2">
                    for{" "}
                    {selectedVehicle.nickname ||
                      `${selectedVehicle.year} ${selectedVehicle.make} ${selectedVehicle.model}`}
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAddRecord(!showAddRecord)}
                  disabled={!selectedVehicleId}
                  className={cn(
                    "rounded-xl px-3 py-1.5 text-xs font-semibold text-white transition-all",
                    selectedVehicleId
                      ? "bg-blue-500 shadow-lg shadow-blue-500/20 hover:bg-blue-400"
                      : "bg-white/5 text-slate-500 cursor-not-allowed"
                  )}
                >
                  + Add Record
                </button>
              </div>
            </div>

            {showAddRecord && selectedVehicle && (
              <div className="glass-card-strong rounded-2xl p-5">
                <div className="text-sm font-semibold text-white mb-3">New Maintenance Record</div>
                <MaintenanceForm
                  key={selectedVehicle.id}
                  vehicle={selectedVehicle}
                  source="dashboard"
                  onCancel={() => setShowAddRecord(false)}
                  onAdded={(record) => {
                    setRecords((prev) => [record, ...prev]);
                    setShowAddRecord(false);
                    // The vehicle's mileage and "last maintenance" may have changed with it.
                    refreshVehicles().catch(() => {});
                  }}
                />
              </div>
            )}

            {maintenanceLoading ? (
              <div className="glass-card rounded-2xl p-8 text-center">
                <div className="text-slate-400 text-sm">Loading...</div>
              </div>
            ) : filteredRecords.length === 0 ? (
              <div className="glass-card rounded-2xl p-8 text-center">
                <div className="text-slate-400 text-sm">
                  {selectedVehicleId
                    ? "No maintenance records yet. Start tracking your vehicle service!"
                    : "Select a vehicle to see its records."}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredRecords.map((r) => (
                  <MaintenanceRow key={r.id} record={r} onDelete={deleteRecord} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
