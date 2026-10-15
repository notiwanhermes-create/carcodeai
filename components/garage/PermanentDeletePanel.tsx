"use client";

/**
 * Deleting an archived vehicle for good.
 *
 * A separate, deliberate step: the vehicle must already be archived, the
 * warning says what goes with it, and the button does nothing until the user
 * has typed DELETE. The server checks ownership, the archive and the typed word
 * again, so no single click and no other page can delete a vehicle.
 */
import { useState } from "react";
import { PERMANENT_DELETE_CONFIRMATION } from "@/app/lib/garage-types";
import { cn, inputClass, quietButton } from "./shared";

type Counts = { maintenance?: number; diagnoses?: number; repairs?: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 service records, 1 diagnosis and 1 reported repair", from what is known. */
function describe(counts: Counts): string {
  const parts: string[] = [];
  if (counts.maintenance !== undefined) parts.push(plural(counts.maintenance, "service record", "service records"));
  if (counts.diagnoses !== undefined) parts.push(plural(counts.diagnoses, "diagnosis", "diagnoses"));
  if (counts.repairs !== undefined) parts.push(plural(counts.repairs, "reported repair", "reported repairs"));
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function PermanentDeletePanel({
  vehicleId,
  vehicleName,
  counts = {},
  onDeleted,
  onCancel,
}: {
  vehicleId: string;
  vehicleName: string;
  counts?: Counts;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = typed.trim() === PERMANENT_DELETE_CONFIRMATION;
  const known = describe(counts);

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/garage/${encodeURIComponent(vehicleId)}/permanent-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not delete the vehicle. Nothing was deleted.");
        return;
      }
      onDeleted();
    } catch {
      setError("Couldn't reach the server. Nothing was deleted. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-permanent-delete className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
      <p className="text-sm font-semibold text-red-200">Delete {vehicleName} permanently?</p>
      <p className="mt-1 text-sm text-red-100/90">
        This deletes the vehicle and everything recorded for it: its service records, its diagnoses and the repairs you reported
        {known ? ` (${known})` : ""}. They cannot be restored afterwards.
      </p>
      <label className="mt-3 block">
        <span className="text-xs text-red-100/80">
          Type <span className="font-mono font-semibold">{PERMANENT_DELETE_CONFIRMATION}</span> to confirm
        </span>
        <input
          data-permanent-delete-input
          aria-label={`Type ${PERMANENT_DELETE_CONFIRMATION} to confirm`}
          autoComplete="off"
          spellCheck={false}
          className={cn(inputClass, "mt-1 font-mono")}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-permanent-delete-confirm
          disabled={!ready || busy}
          onClick={remove}
          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Delete permanently"}
        </button>
        <button type="button" className={quietButton} disabled={busy} onClick={onCancel}>
          Keep it
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
