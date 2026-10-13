"use client";

/**
 * The pieces of a vehicle's page: its mileage, the form for a service record,
 * and its timeline.
 */
import Link from "next/link";
import { useState } from "react";
import { track } from "@/app/lib/analytics";
import type { MaintenanceDto, TimelineItem, VehicleDto } from "@/app/lib/garage-types";
import { formatOdometer, type OdometerUnit } from "@/app/lib/odometer";
import { CodeChips, SERVICE_TYPES, StatusBadge, cn, formatCost, formatDay, inputClass, primaryButton, quietButton } from "./shared";

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ───────────────────────── mileage ───────────────────────── */

/**
 * Update a vehicle's current mileage. A higher reading is simply saved. A lower
 * one, or one in the other unit, is refused by the server until the user
 * confirms it here, so a slip cannot wind the reading back but a correction is
 * still possible.
 */
export function MileageEditor({ vehicle, onUpdated, onCancel }: { vehicle: VehicleDto; onUpdated: (v: VehicleDto) => void; onCancel: () => void }) {
  const [value, setValue] = useState(vehicle.odometerValue != null ? String(vehicle.odometerValue) : "");
  const [unit, setUnit] = useState<OdometerUnit>(vehicle.odometerUnit ?? "km");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null);

  async function save(confirm: boolean) {
    if (!value.trim()) {
      setError("Enter the mileage.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/garage/${encodeURIComponent(vehicle.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ mileage: { value: value.trim(), unit, confirm } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "mileage_confirm") {
        const onFile = data.current ? formatOdometer(data.current.value, data.current.unit) : "the mileage on file";
        setNeedsConfirm(
          data.reason === "lower"
            ? `That is lower than ${onFile}. Save it anyway as a correction?`
            : `The mileage on file is ${onFile}, in a different unit. Replace it with ${formatOdometer(Number(value.replace(/,/g, "")), unit)}?`,
        );
        return;
      }
      if (!res.ok || !data.vehicle) {
        setError(typeof data.error === "string" ? data.error : "Could not save the mileage.");
        return;
      }
      onUpdated(data.vehicle as VehicleDto);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-mileage-editor className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          aria-label="Mileage"
          inputMode="numeric"
          className={inputClass}
          value={value}
          onChange={(e) => {
            setValue(e.target.value.replace(/[^0-9,]/g, ""));
            setNeedsConfirm(null);
          }}
          placeholder="e.g. 138000"
        />
        <select
          aria-label="Unit"
          className={cn(inputClass, "sm:w-24")}
          value={unit}
          onChange={(e) => {
            setUnit(e.target.value === "mi" ? "mi" : "km");
            setNeedsConfirm(null);
          }}
        >
          <option value="km">km</option>
          <option value="mi">mi</option>
        </select>
      </div>
      {needsConfirm ? (
        <div data-mileage-confirm className="mt-3">
          <p className="text-sm text-amber-300">{needsConfirm}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" data-mileage-confirm-yes className={primaryButton} disabled={busy} onClick={() => save(true)}>
              Yes, save it
            </button>
            <button type="button" className={quietButton} disabled={busy} onClick={() => setNeedsConfirm(null)}>
              No, keep what is on file
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" data-mileage-save className={primaryButton} disabled={busy} onClick={() => save(false)}>
            {busy ? "Saving…" : "Save mileage"}
          </button>
          <button type="button" className={quietButton} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    </div>
  );
}

/* ───────────────────────── service records ───────────────────────── */

export function MaintenanceForm({
  vehicle,
  onAdded,
  onCancel,
  source,
}: {
  /** The vehicle the record is for. Its own unit is offered first. */
  vehicle: { id: string; odometerUnit?: OdometerUnit | null };
  onAdded: (record: MaintenanceDto) => void;
  onCancel: () => void;
  source: "vehicle_page" | "dashboard" | "home";
}) {
  const [date, setDate] = useState(localToday());
  const [serviceType, setServiceType] = useState(SERVICE_TYPES[0]);
  const [odometer, setOdometer] = useState("");
  const [unit, setUnit] = useState<OdometerUnit>(vehicle.odometerUnit ?? "km");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!date || !serviceType) {
      setError("Date and service type are required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          vehicleId: vehicle.id,
          date,
          serviceType,
          odometer: odometer.trim() || undefined,
          odometerUnit: odometer.trim() ? unit : undefined,
          cost: cost.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.record) {
        setError(typeof data.error === "string" ? data.error : "Could not add the record.");
        return;
      }
      track("maintenance_added", { signed_in: true, has_mileage: !!odometer.trim(), source });
      onAdded(data.record as MaintenanceDto);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-maintenance-form className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-slate-400">Date</span>
          <input type="date" className={cn(inputClass, "mt-1")} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Service</span>
          <select className={cn(inputClass, "mt-1")} value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
            {SERVICE_TYPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="block">
            <span className="text-xs text-slate-400">Mileage (optional)</span>
            <input aria-label="Mileage" inputMode="numeric" className={cn(inputClass, "mt-1")} value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/[^0-9,]/g, ""))} placeholder="e.g. 45000" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Unit</span>
            <select aria-label="Unit" className={cn(inputClass, "mt-1 w-20")} value={unit} onChange={(e) => setUnit(e.target.value === "mi" ? "mi" : "km")}>
              <option value="km">km</option>
              <option value="mi">mi</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-slate-400">Cost (optional)</span>
          <input className={cn(inputClass, "mt-1")} maxLength={40} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 49.99" />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-slate-400">Notes (optional)</span>
          <textarea className={cn(inputClass, "mt-1")} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional details..." />
        </label>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" data-maintenance-save className={primaryButton} disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save record"}
        </button>
        <button type="button" className={quietButton} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One service record, with the reading shown as "130,250 km" when the unit is known, and as typed otherwise. */
export function MaintenanceRow({ record, onDelete }: { record: MaintenanceDto; onDelete?: (id: string) => void | Promise<void> }) {
  const reading = formatOdometer(record.odometerValue, record.odometerUnit, record.odometer);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div data-maintenance-record className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg border border-blue-500/20 bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300">{record.serviceType}</span>
            <span className="text-xs text-slate-400">{record.serviceDate ? formatDay(record.serviceDate) : record.date}</span>
            {record.cost && <span className="text-xs text-emerald-400">{formatCost(record.cost)}</span>}
          </div>
          {reading && <div data-odometer className="mt-1 text-xs text-slate-400">{reading}</div>}
          {record.notes && <div className="mt-1 whitespace-pre-wrap text-xs text-slate-400">{record.notes}</div>}
        </div>
        {onDelete && !confirming && (
          <button type="button" aria-label="Delete this service record" onClick={() => setConfirming(true)} className="shrink-0 rounded-lg p-1.5 text-slate-500 transition-all hover:bg-red-500/10 hover:text-red-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        )}
      </div>
      {onDelete && confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
          <span className="text-xs text-amber-300">Delete this record? This cannot be undone.</span>
          <button
            type="button"
            data-maintenance-delete-confirm
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              try {
                await onDelete(record.id);
              } finally {
                setDeleting(false);
                setConfirming(false);
              }
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button type="button" className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10" disabled={deleting} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── timeline ───────────────────────── */

const KIND_LABEL: Record<TimelineItem["kind"], string> = { diagnosis: "Diagnosis", fix: "Confirmed repair", maintenance: "Maintenance" };
const KIND_DOT: Record<TimelineItem["kind"], string> = { diagnosis: "bg-amber-400", fix: "bg-emerald-400", maintenance: "bg-blue-400" };

/** A vehicle's history, newest first: diagnoses, confirmed repairs and service records together. */
export function TimelineList({ vehicleId, items, limit }: { vehicleId: string; items: TimelineItem[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) return <p className="text-sm text-slate-400">Nothing here yet. Diagnoses, repairs and service records will appear as you add them.</p>;
  return (
    <ol data-timeline className="space-y-3">
      {shown.map((item) => {
        const diagnosisHref = `/garage/${encodeURIComponent(vehicleId)}/diagnosis/${encodeURIComponent(item.kind === "fix" ? item.diagnosisId : item.id)}`;
        return (
          <li key={`${item.kind}-${item.id}`} data-timeline-kind={item.kind} className="flex gap-3">
            <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", KIND_DOT[item.kind])} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span>{item.kind === "maintenance" && !/^\d{4}-\d{2}-\d{2}$/.test(item.dateText) ? item.dateText : formatDay(item.at)}</span>
                <span className="text-slate-600">·</span>
                <span>{KIND_LABEL[item.kind]}</span>
              </div>
              {item.kind === "diagnosis" && (
                <Link href={diagnosisHref} className="mt-0.5 block text-sm text-slate-100 hover:text-blue-300">
                  <span className="font-medium">{item.title}</span>
                  <span className="ml-2 inline-flex flex-wrap items-center gap-2 align-middle">
                    <CodeChips codes={item.codes} />
                    <StatusBadge status={item.status} />
                  </span>
                </Link>
              )}
              {item.kind === "fix" && (
                <Link href={diagnosisHref} className="mt-0.5 block text-sm text-slate-100 hover:text-blue-300">
                  <span className="font-medium text-emerald-300">{item.description}</span>
                  {item.odometerValue != null && <span className="ml-2 text-xs text-slate-400">{formatOdometer(item.odometerValue, item.odometerUnit)}</span>}
                </Link>
              )}
              {item.kind === "maintenance" && (
                <div className="mt-0.5 text-sm text-slate-100">
                  <span className="font-medium">{item.serviceType}</span>
                  {formatOdometer(item.odometerValue, item.odometerUnit, item.odometer) && (
                    <span className="ml-2 text-xs text-slate-400">{formatOdometer(item.odometerValue, item.odometerUnit, item.odometer)}</span>
                  )}
                  {item.cost && <span className="ml-2 text-xs text-emerald-400">{formatCost(item.cost)}</span>}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
