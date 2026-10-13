"use client";

/**
 * "Did you fix this problem?" The outcome of a diagnosis, reported by the user.
 *
 * What the user reports here is stored as a confirmed repair, next to the
 * diagnosis and never inside it: the diagnosis stays exactly what the AI said.
 * The listed causes are offered as shortcuts, but the repair can be anything
 * the user types.
 */
import { useState } from "react";
import { track } from "@/app/lib/analytics";
import type { DiagnosisDetailDto } from "@/app/lib/garage-types";
import { formatOdometer, type OdometerUnit } from "@/app/lib/odometer";
import { Card, SectionTitle, cn, formatDay, inputClass, primaryButton, quietButton } from "./shared";

type Props = {
  diagnosis: DiagnosisDetailDto;
  /** The unit the vehicle's mileage is kept in, offered as the default. */
  defaultUnit: OdometerUnit;
  onChange: (next: DiagnosisDetailDto) => void;
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The causes the diagnosis listed, as { rank, title }. */
function listedCauses(diagnosis: DiagnosisDetailDto): Array<{ rank: number; title: string }> {
  if (diagnosis.result.kind === "structured") return diagnosis.result.diagnosis.causes.map((c) => ({ rank: c.rank, title: c.title }));
  return diagnosis.result.causes.map((c, i) => ({ rank: i + 1, title: c.title }));
}

export function OutcomePanel({ diagnosis, defaultUnit, onChange }: Props) {
  const fix = diagnosis.confirmedFix;
  const causes = listedCauses(diagnosis);

  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(fix?.description ?? "");
  const [matchedRank, setMatchedRank] = useState<number | null>(fix?.matchedCauseRank ?? null);
  const [fixedOn, setFixedOn] = useState(fix?.fixedOn ?? today());
  const [mileage, setMileage] = useState(fix?.odometerValue != null ? String(fix.odometerValue) : "");
  const [unit, setUnit] = useState<OdometerUnit>(fix?.odometerUnit ?? defaultUnit);
  const [notes, setNotes] = useState(fix?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirmReopen, setConfirmReopen] = useState(false);

  async function send(body: Record<string, unknown>): Promise<DiagnosisDetailDto | null> {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const res = await fetch(`/api/diagnoses/${encodeURIComponent(diagnosis.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.diagnosis) {
        setError(typeof data.error === "string" ? data.error : "Could not save that. Please try again.");
        return null;
      }
      onChange(data.diagnosis as DiagnosisDetailDto);
      return data.diagnosis as DiagnosisDetailDto;
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveFix() {
    if (!description.trim()) {
      setError("Describe what fixed the problem.");
      return;
    }
    const saved = await send({
      outcome: "fixed",
      description: description.trim(),
      matchedCauseRank: matchedRank,
      fixedOn,
      odometerValue: mileage.trim() || undefined,
      odometerUnit: mileage.trim() ? unit : undefined,
      notes: notes.trim() || undefined,
    });
    if (saved) {
      setEditing(false);
      track("diagnosis_resolved", { outcome: "fixed", signed_in: true, source: "diagnosis_page" });
      track("confirmed_fix_added", { matched_prediction: matchedRank !== null, has_mileage: !!mileage.trim(), signed_in: true });
    }
  }

  async function answer(outcome: "not_yet" | "dismissed" | "reopen") {
    const saved = await send({ outcome });
    if (!saved) return;
    setConfirmReopen(false);
    if (outcome === "not_yet") setNote("Thanks. This stays open in your garage.");
    track("diagnosis_resolved", { outcome: outcome === "reopen" ? "reopened" : outcome, signed_in: true, source: "diagnosis_page" });
  }

  const fixForm = (
    <div data-fix-form className="mt-3 space-y-3">
      {causes.length > 0 && (
        <div>
          <div className="text-xs text-slate-400">Was it one of the causes listed? (optional)</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {causes.map((c) => (
              <button
                key={c.rank}
                type="button"
                data-cause-option={c.rank}
                onClick={() => {
                  setMatchedRank(c.rank);
                  if (!description.trim() || causes.some((x) => x.title === description.trim())) setDescription(c.title);
                }}
                className={cn("rounded-xl border px-3 py-1.5 text-xs transition-all", matchedRank === c.rank ? "border-blue-400/50 bg-blue-500/20 text-blue-200" : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20")}
              >
                {c.title}
              </button>
            ))}
            <button
              type="button"
              data-cause-option="other"
              onClick={() => {
                setMatchedRank(null);
                if (causes.some((x) => x.title === description.trim())) setDescription("");
              }}
              className={cn("rounded-xl border px-3 py-1.5 text-xs transition-all", matchedRank === null ? "border-blue-400/50 bg-blue-500/20 text-blue-200" : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20")}
            >
              Something else
            </button>
          </div>
        </div>
      )}
      <label className="block">
        <span className="text-xs text-slate-400">What actually fixed it?</span>
        <input data-fix-description className={cn(inputClass, "mt-1")} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Ignition coil on cylinder 3" />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-slate-400">Date</span>
          <input type="date" className={cn(inputClass, "mt-1")} value={fixedOn} max={today()} onChange={(e) => setFixedOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Mileage (optional)</span>
          <input inputMode="numeric" className={cn(inputClass, "mt-1")} value={mileage} onChange={(e) => setMileage(e.target.value.replace(/[^0-9,]/g, ""))} placeholder="e.g. 138200" />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Unit</span>
          <select className={cn(inputClass, "mt-1")} value={unit} onChange={(e) => setUnit(e.target.value === "mi" ? "mi" : "km")}>
            <option value="km">km</option>
            <option value="mi">mi</option>
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-slate-400">Notes (optional)</span>
        <textarea className={cn(inputClass, "mt-1")} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-save-fix className={primaryButton} disabled={busy} onClick={saveFix}>
          {busy ? "Saving…" : "Save repair"}
        </button>
        <button type="button" className={quietButton} disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <Card>
      {diagnosis.status === "open" && (
        <div data-outcome="open">
          <SectionTitle>Did you fix this problem?</SectionTitle>
          {!editing ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" data-outcome-fixed className={primaryButton} disabled={busy} onClick={() => setEditing(true)}>
                Yes, fixed
              </button>
              <button type="button" data-outcome-not-yet className={quietButton} disabled={busy} onClick={() => answer("not_yet")}>
                Not yet
              </button>
              <button type="button" data-outcome-dismiss className={quietButton} disabled={busy} onClick={() => answer("dismissed")}>
                Problem went away
              </button>
            </div>
          ) : (
            fixForm
          )}
        </div>
      )}

      {diagnosis.status === "resolved" && (
        <div data-outcome="resolved">
          <SectionTitle>Confirmed repair</SectionTitle>
          {fix && !editing && (
            <div>
              <div data-confirmed-fix className="text-sm font-semibold text-emerald-300">{fix.description}</div>
              <div className="mt-1 text-xs text-slate-400">
                {formatDay(fix.fixedOn)}
                {fix.odometerValue != null ? ` · ${formatOdometer(fix.odometerValue, fix.odometerUnit)}` : ""}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {fix.matchedCauseTitle ? `You said this matched cause ${fix.matchedCauseRank} in the diagnosis: ${fix.matchedCauseTitle}.` : "Reported by you. It was not one of the causes the diagnosis listed."}
              </div>
              {fix.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{fix.notes}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={quietButton} disabled={busy} onClick={() => setEditing(true)}>
                  Edit
                </button>
                {!confirmReopen ? (
                  <button type="button" data-outcome-reopen className={quietButton} disabled={busy} onClick={() => setConfirmReopen(true)}>
                    It came back
                  </button>
                ) : (
                  <>
                    <span className="self-center text-xs text-amber-300">This reopens the issue and removes the recorded repair.</span>
                    <button type="button" data-outcome-reopen-confirm className={primaryButton} disabled={busy} onClick={() => answer("reopen")}>
                      Reopen
                    </button>
                    <button type="button" className={quietButton} disabled={busy} onClick={() => setConfirmReopen(false)}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {editing && fixForm}
        </div>
      )}

      {diagnosis.status === "dismissed" && (
        <div data-outcome="dismissed">
          <SectionTitle>Dismissed</SectionTitle>
          <p className="text-sm text-slate-300">You said the problem went away{diagnosis.statusChangedAt ? ` (${formatDay(diagnosis.statusChangedAt)})` : ""}.</p>
          <button type="button" data-outcome-reopen-confirm className={cn(quietButton, "mt-3")} disabled={busy} onClick={() => answer("reopen")}>
            It came back: reopen
          </button>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {note && <p className="mt-3 text-sm text-slate-300">{note}</p>}
    </Card>
  );
}
