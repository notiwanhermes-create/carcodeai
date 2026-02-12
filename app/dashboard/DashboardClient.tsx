"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

type Vehicle = {
  id: string;
  year: string;
  make: string;
  model: string;
  engine?: string;
  vin?: string;
  nickname?: string;
};

type MaintenanceRecord = {
  id: string;
  vehicleId: string;
  serviceType: string;
  date: string;
  odometer?: string;
  notes?: string;
  cost?: string;
};

const SERVICE_TYPES = [
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

export default function DashboardClient() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [records, setRecords] = useState<MaintenanceRecord[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [filterType, setFilterType] = useState("");

  const [vYear, setVYear] = useState("");
  const [vMake, setVMake] = useState("");
  const [vModel, setVModel] = useState("");
  const [vEngine, setVEngine] = useState("");
  const [vVin, setVVin] = useState("");
  const [vNickname, setVNickname] = useState("");
  const [vehicleError, setVehicleError] = useState("");
  const [vehicleSaving, setVehicleSaving] = useState(false);

  const [rDate, setRDate] = useState(new Date().toISOString().split("T")[0]);
  const [rOdometer, setROdometer] = useState("");
  const [rServiceType, setRServiceType] = useState("Oil Change");
  const [rNotes, setRNotes] = useState("");
  const [rCost, setRCost] = useState("");
  const [recordError, setRecordError] = useState("");
  const [recordSaving, setRecordSaving] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login?callbackUrl=/dashboard");
    }
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function fetchData() {
    setLoading(true);
    try {
      const [vRes, mRes] = await Promise.all([fetch("/api/garage"), fetch("/api/maintenance")]);
      if (vRes.ok) {
        const vData = await vRes.json();
        setVehicles(vData.vehicles || []);
        if (!selectedVehicleId && vData.vehicles?.length > 0) {
          setSelectedVehicleId(vData.vehicles[0].id);
        }
      }
      if (mRes.ok) {
        const mData = await mRes.json();
        setRecords(mData.records || []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function addVehicle() {
    setVehicleError("");
    if (!vYear || !vMake || !vModel) {
      setVehicleError("Year, make, and model are required.");
      return;
    }
    setVehicleSaving(true);
    try {
      const res = await fetch("/api/garage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: vYear,
          make: vMake,
          model: vModel,
          engine: vEngine || undefined,
          vin: vVin || undefined,
          nickname: vNickname || undefined,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVehicleError(d.error || "Failed to add vehicle.");
        return;
      }
      setVehicles((prev) => [d.vehicle, ...prev]);
      setSelectedVehicleId(d.vehicle.id);
      setShowAddVehicle(false);
      setVYear("");
      setVMake("");
      setVModel("");
      setVEngine("");
      setVVin("");
      setVNickname("");
    } catch {
      setVehicleError("Failed to add vehicle.");
    } finally {
      setVehicleSaving(false);
    }
  }

  async function deleteVehicle(id: string) {
    if (!confirm("Delete this vehicle and all its maintenance records?")) return;
    await fetch(`/api/garage/${id}`, { method: "DELETE" });
    setVehicles((prev) => prev.filter((v) => v.id !== id));
    setRecords((prev) => prev.filter((r) => r.vehicleId !== id));
    if (selectedVehicleId === id) {
      setSelectedVehicleId(vehicles.find((v) => v.id !== id)?.id || null);
    }
  }

  async function addRecord() {
    setRecordError("");
    if (!selectedVehicleId) {
      setRecordError("Select a vehicle first.");
      return;
    }
    if (!rDate || !rServiceType) {
      setRecordError("Date and service type are required.");
      return;
    }
    setRecordSaving(true);
    try {
      const res = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleId: selectedVehicleId,
          date: rDate,
          odometer: rOdometer || undefined,
          serviceType: rServiceType,
          notes: rNotes || undefined,
          cost: rCost || undefined,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRecordError(d.error || "Failed to add record.");
        return;
      }
      setRecords((prev) => [d.record, ...prev]);
      setShowAddRecord(false);
      setRDate(new Date().toISOString().split("T")[0]);
      setROdometer("");
      setRServiceType("Oil Change");
      setRNotes("");
      setRCost("");
    } catch {
      setRecordError("Failed to add record.");
    } finally {
      setRecordSaving(false);
    }
  }

  async function deleteRecord(id: string) {
    if (!confirm("Delete this maintenance record?")) return;
    await fetch(`/api/maintenance/${id}`, { method: "DELETE" });
    setRecords((prev) => prev.filter((r) => r.id !== id));
  }

  const filteredRecords = records.filter((r) => {
    if (selectedVehicleId && r.vehicleId !== selectedVehicleId) return false;
    if (filterType && r.serviceType !== filterType) return false;
    return true;
  });

  if (status === "loading" || loading) {
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

            {vehicles.length === 0 && !showAddVehicle ? (
              <div className="glass-card rounded-2xl p-6 text-center">
                <div className="text-slate-400 text-sm">No vehicles yet. Add your first one!</div>
              </div>
            ) : (
              vehicles.map((v) => (
                <div
                  key={v.id}
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
                      </div>
                      {v.engine && <div className="text-xs text-slate-400 mt-0.5">{v.engine}</div>}
                      {v.vin && (
                        <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
                          VIN: {v.vin}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteVehicle(v.id);
                      }}
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-400 transition-all"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-500">
                    {records.filter((r) => r.vehicleId === v.id).length} maintenance records
                  </div>
                </div>
              ))
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
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="glass-input rounded-xl px-3 py-2 text-xs"
                >
                  <option value="">All types</option>
                  {SERVICE_TYPES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
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

            {showAddRecord && selectedVehicleId && (
              <div className="glass-card-strong rounded-2xl p-5 space-y-3">
                <div className="text-sm font-semibold text-white mb-2">New Maintenance Record</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Date *</label>
                    <input
                      type="date"
                      value={rDate}
                      onChange={(e) => setRDate(e.target.value)}
                      className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Service Type *</label>
                    <select
                      value={rServiceType}
                      onChange={(e) => setRServiceType(e.target.value)}
                      className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                    >
                      {SERVICE_TYPES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Odometer</label>
                    <input
                      placeholder="e.g. 45000"
                      value={rOdometer}
                      onChange={(e) => setROdometer(e.target.value)}
                      className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Cost</label>
                    <input
                      placeholder="e.g. 49.99"
                      value={rCost}
                      onChange={(e) => setRCost(e.target.value)}
                      className="glass-input w-full rounded-xl px-3 py-2.5 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Notes</label>
                  <textarea
                    placeholder="Any additional details..."
                    value={rNotes}
                    onChange={(e) => setRNotes(e.target.value)}
                    rows={2}
                    className="glass-input w-full rounded-xl px-3 py-2.5 text-sm resize-none"
                  />
                </div>
                {recordError && <div className="text-xs text-red-400">{recordError}</div>}
                <div className="flex gap-2">
                  <button
                    onClick={addRecord}
                    disabled={recordSaving}
                    className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-2 text-xs font-semibold text-white transition-all"
                  >
                    {recordSaving ? "Saving..." : "Save Record"}
                  </button>
                  <button
                    onClick={() => setShowAddRecord(false)}
                    className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-slate-400 hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {filteredRecords.length === 0 ? (
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
                  <div key={r.id} className="glass-card rounded-2xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center rounded-lg bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400 border border-blue-500/20">
                            {r.serviceType}
                          </span>
                          <span className="text-xs text-slate-500">{r.date}</span>
                          {r.cost && <span className="text-xs text-emerald-400">${r.cost}</span>}
                        </div>
                        {r.odometer && (
                          <div className="text-xs text-slate-400 mt-1">{r.odometer} miles</div>
                        )}
                        {r.notes && <div className="text-xs text-slate-400 mt-1">{r.notes}</div>}
                      </div>
                      <button
                        onClick={() => deleteRecord(r.id)}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-400 transition-all"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

