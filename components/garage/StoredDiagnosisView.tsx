"use client";

/**
 * A saved diagnosis, shown from stored data only. Nothing here asks the AI
 * model for anything: it renders what was saved when the diagnosis was made.
 *
 * The labels (likelihood, urgency, who can do a check) use the language the
 * diagnosis was written in, so labels and text match.
 */
import { tr, LANGUAGES, type LangCode } from "@/app/data/translations";
import type { Diagnosis } from "@/app/lib/diagnosis-schema";
import type { DiagnosisDetailDto } from "@/app/lib/garage-types";
import { formatOdometer } from "@/app/lib/odometer";
import { Card, CodeChips, SectionTitle, cn, formatDay } from "./shared";

const LIKELIHOOD_KEY: Record<string, string> = { very_likely: "likelihoodVeryLikely", likely: "likelihoodLikely", possible: "likelihoodPossible", unlikely: "likelihoodUnlikely" };
const URGENCY_KEY: Record<string, string> = { normal: "urgencyNormal", caution: "urgencyCaution", stop: "urgencyStop", unknown: "urgencyUnknown" };
const DRIVE_KEY: Record<string, string> = { normal: "driveNormal", caution: "driveCaution", stop: "driveStop", unknown: "driveUnknown" };
const CHECK_LEVEL_KEY: Record<string, string> = { owner: "checkOwner", diy: "checkDiy", professional: "checkProfessional" };
const REPAIR_LEVEL_KEY: Record<string, string> = { diy_easy: "repairDiyEasy", diy_moderate: "repairDiyModerate", professional: "repairProfessional" };

const DRIVE_TONE: Record<string, string> = {
  normal: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  caution: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  stop: "border-red-500/40 bg-red-500/10 text-red-200",
  unknown: "border-slate-500/30 bg-slate-500/10 text-slate-200",
};

function languageOf(code: string): LangCode {
  return LANGUAGES.some((l) => l.code === code) ? (code as LangCode) : "en";
}

/** The reason shown with the safety level. If the server changed the level, its own wording is used. */
function driveReason(diagnosis: Diagnosis, lang: LangCode): string {
  const { reason, adjusted, level } = diagnosis.drive_guidance;
  if (!adjusted) return reason;
  const cause = diagnosis.causes.find((c) => c.id === adjusted.cause_id)?.title || "";
  const key = level === "stop" ? "driveAdjustedStop" : level === "caution" ? "driveAdjustedCaution" : "driveAdjustedUnknown";
  return tr(key, lang).replace("{cause}", cause);
}

function StructuredDiagnosis({ diagnosis, lang, unidentifiedCodes }: { diagnosis: Diagnosis; lang: LangCode; unidentifiedCodes: number }) {
  // Anything unrecognised is shown as "could not be assessed", never as fine to drive.
  const level = diagnosis.drive_guidance?.level in DRIVE_KEY ? diagnosis.drive_guidance.level : "unknown";
  const limitations = [...(diagnosis.limitations || [])];
  if (unidentifiedCodes > 0) limitations.push(tr(unidentifiedCodes === 1 ? "unidentifiedCodeNote" : "unidentifiedCodesNote", lang));

  return (
    <>
      <Card>
        <SectionTitle>Summary</SectionTitle>
        <p data-stored-summary className="text-sm leading-relaxed text-slate-200">{diagnosis.summary}</p>
        <p className="mt-2 text-xs text-slate-400">{tr("hypothesisNoteStored", lang)}</p>
      </Card>

      <div data-drive-level={level} className={cn("rounded-2xl border p-4", DRIVE_TONE[level])}>
        <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{tr("driveGuidance", lang)}</div>
        <div className="mt-1 text-sm font-semibold">{tr(DRIVE_KEY[level], lang)}</div>
        {driveReason(diagnosis, lang) && <p className="mt-1 text-sm">{driveReason(diagnosis, lang)}</p>}
        <p className="mt-2 text-[11px] leading-relaxed opacity-80">{tr("driveGuidanceNote", lang)}</p>
      </div>

      <Card>
        <SectionTitle>{tr("likelyCauses", lang)}</SectionTitle>
        <ol className="space-y-4">
          {diagnosis.causes.map((c) => (
            <li key={c.id || c.rank} data-cause-rank={c.rank} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  {c.rank}. {c.title}
                </span>
                <span className="rounded-md border border-blue-500/20 bg-blue-500/15 px-1.5 py-0.5 text-[11px] text-blue-300">{tr(LIKELIHOOD_KEY[c.likelihood] || "likelihoodPossible", lang)}</span>
                <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-300">{tr(URGENCY_KEY[c.urgency] || "urgencyUnknown", lang)}</span>
              </div>
              {c.explanation && <p className="mt-2 text-sm text-slate-300">{c.explanation}</p>}
              {c.why_it_fits?.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tr("whyLikely", lang)}</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-300">
                    {c.why_it_fits.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {c.checks?.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tr("howToConfirm", lang)}</div>
                  <ul className="mt-1 space-y-1 text-sm text-slate-300">
                    {c.checks.map((k, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-2">
                        <span>{k.instruction}</span>
                        <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-400">{tr(CHECK_LEVEL_KEY[k.level] || "checkProfessional", lang)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {c.recommended_action && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tr("recommendedAction", lang)}</div>
                  <p className="mt-1 text-sm text-slate-300">{c.recommended_action}</p>
                </div>
              )}
              <div className="mt-2 text-[11px] text-slate-500">{tr(REPAIR_LEVEL_KEY[c.repair_level] || "repairProfessional", lang)}</div>
            </li>
          ))}
        </ol>
      </Card>

      {limitations.length > 0 && (
        <Card>
          <SectionTitle>{tr("diagnosisLimits", lang)}</SectionTitle>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
            {limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

export function StoredDiagnosisView({ diagnosis }: { diagnosis: DiagnosisDetailDto }) {
  const lang = languageOf(diagnosis.language);
  const vehicle = [diagnosis.vehicle.year, diagnosis.vehicle.make, diagnosis.vehicle.model, diagnosis.vehicle.trim].filter(Boolean).join(" ");
  const mileage = formatOdometer(diagnosis.odometerValue, diagnosis.odometerUnit);
  const unidentified = diagnosis.codeDetails.filter((c) => c.trust === "none" && c.status !== "invalid").length;

  return (
    <>
      <Card>
        <SectionTitle>What you told us</SectionTitle>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Vehicle</dt>
            <dd data-stored-vehicle className="mt-0.5 text-slate-200">
              {vehicle}
              {diagnosis.vehicle.engine ? ` (${diagnosis.vehicle.engine})` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Diagnosed</dt>
            <dd className="mt-0.5 text-slate-200">
              {formatDay(diagnosis.diagnosedAt)}
              {mileage ? ` · ${mileage}` : ""}
            </dd>
          </div>
          {diagnosis.symptoms && (
            <div className="sm:col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Symptoms</dt>
              <dd data-stored-symptoms className="mt-0.5 whitespace-pre-wrap text-slate-200">{diagnosis.symptoms}</dd>
            </div>
          )}
          {diagnosis.codes.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Codes submitted</dt>
              <dd className="mt-1">
                <CodeChips codes={diagnosis.codes} />
                {diagnosis.codeDetails.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400">
                    {diagnosis.codeDetails.map((c) => (
                      <li key={c.code}>
                        <span className="font-mono text-slate-300">{c.code}</span>
                        {c.definition ? `: ${c.definition}` : ""}
                        {c.message ? ` — ${c.message}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          )}
        </dl>
        {diagnosis.followUps.length > 0 && (
          <div className="mt-4 border-t border-white/10 pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Follow-up answers</div>
            <ul className="mt-1 space-y-1 text-sm text-slate-300">
              {diagnosis.followUps.map((f, i) => (
                <li key={i}>
                  <span className="text-slate-400">{f.question}</span> <span className="font-medium text-slate-200">{f.answer}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {diagnosis.result.kind === "structured" ? (
        <StructuredDiagnosis diagnosis={diagnosis.result.diagnosis} lang={lang} unidentifiedCodes={unidentified} />
      ) : (
        <Card>
          <SectionTitle aside={<span className="text-[11px] text-slate-500">Copied from a device: a summary only</span>}>{tr("likelyCauses", lang)}</SectionTitle>
          {diagnosis.result.causes.length === 0 ? (
            <p className="text-sm text-slate-400">No details were kept for this diagnosis.</p>
          ) : (
            <ol className="space-y-3">
              {diagnosis.result.causes.map((c, i) => (
                <li key={i} data-cause-rank={i + 1} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-sm font-semibold text-white">
                    {i + 1}. {c.title}
                  </div>
                  {[
                    ["whyLikely", c.why],
                    ["howToConfirm", c.checks],
                    ["recommendedAction", c.fix],
                  ].map(([key, items]) =>
                    (items as string[]).length > 0 ? (
                      <div key={key as string} className="mt-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{tr(key as string, lang)}</div>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-300">
                          {(items as string[]).map((t, j) => (
                            <li key={j}>{t}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null,
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}
    </>
  );
}
