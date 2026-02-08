"use client";

import { useEffect, useMemo, useState, useRef } from "react";
type EngineOption =
  | string
  | {
      id?: string;
      label?: string;
      details?: string;
      displacementL?: number;
      cylinders?: number;
      engineType?: string;
      aspiration?: string;
      fuel?: string;
      source?: string;
    };

import * as ReactDOM from "react-dom";



type Vehicle = {
  id: string;
  year: string;
  make: string;
  model: string;
  engine?: string;
  nickname?: string;
  vin?: string; // NEW
};

type Cause = {
  title: string;
  why?: string;
  confirm?: string[];
  fix?: string[];
};

type ApiOk = {
  causes: Cause[];
  questions?: string[];
};

type ApiErr = { error: string };

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/* ===================== SMALL DEBOUNCE HOOK ===================== */
function useDebouncedValue<T>(value: T, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/* ===================== LOADER (WHITE/BLUE) ===================== */
function CarScanLoader() {
  return (
    <div className="w-full max-w-3xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
      <style>{`
        @keyframes scanY {
          0%   { transform: translateY(10px); opacity: .25; }
          50%  { transform: translateY(92px); opacity: .95; }
          100% { transform: translateY(10px); opacity: .25; }
        }
        .scan-line { animation: scanY 1.6s ease-in-out infinite; }
      `}</style>

      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-sm font-semibold text-slate-900">Scanning vehicle…</div>
          <div className="mt-1 text-xs text-slate-500">
            Matching symptoms • pulling likely causes • building fixes
          </div>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" />
          Scanning
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center">
        <div className="relative h-28 w-56 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
          <div className="absolute left-1/2 top-1/2 h-14 w-44 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-300 bg-white" />
          <div className="absolute left-[18%] top-[66%] h-9 w-9 rounded-full border border-slate-300 bg-slate-100" />
          <div className="absolute right-[18%] top-[66%] h-9 w-9 rounded-full border border-slate-300 bg-slate-100" />
          <div className="scan-line absolute left-0 top-0 h-1 w-full bg-blue-600/70 blur-[0.5px]" />
        </div>
      </div>

      <div className="mt-4 text-center text-xs text-slate-500 animate-pulse">
        This can take a few seconds…
      </div>
    </div>
  );
}

/* ===================== LIKELY CAUSES PANEL ===================== */
function LikelyCausesPanel({ result }: { result: ApiOk | null }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  if (!result?.causes?.length) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm font-semibold text-slate-900">Likely Causes</div>
        <div className="mt-2 text-sm text-slate-500">Run a diagnostic to see causes here.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[11px] font-medium text-slate-500">DIAGNOSTIC SUMMARY</div>
        <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Likely Causes</div>
        <div className="mt-1 text-sm text-slate-500">
          Tap a cause to see how to confirm it and how to fix it.
        </div>
      </div>

      <div className="space-y-3">
        {result.causes.map((c, idx) => {
          const isOpen = openIdx === idx;

          return (
            <div key={`${c.title}-${idx}`} className="rounded-3xl border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => setOpenIdx(isOpen ? null : idx)}
                className={cn(
                  "w-full rounded-3xl border border-transparent bg-transparent px-5 py-5 text-left transition",
                  "hover:bg-blue-600 hover:text-white hover:border-blue-600",
                  "focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold">{c.title}</div>
                    {c.why && <div className="mt-1 text-sm text-slate-500">{c.why}</div>}
                  </div>
                  <div className="shrink-0 text-sm font-semibold">{isOpen ? "−" : "+"}</div>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-slate-200 px-5 py-5">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs font-semibold text-slate-900">How to confirm</div>
                      <ul className="mt-2 space-y-2 text-sm text-slate-700">
                        {(c.confirm || []).length ? (
                          c.confirm!.map((v, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-2 h-2 w-2 rounded-full bg-blue-600" />
                              {v}
                            </li>
                          ))
                        ) : (
                          <li className="text-slate-500">No confirm steps provided.</li>
                        )}
                      </ul>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs font-semibold text-slate-900">How to fix</div>
                      <ul className="mt-2 space-y-2 text-sm text-slate-700">
                        {(c.fix || []).length ? (
                          c.fix!.map((v, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-2 h-2 w-2 rounded-full bg-blue-600" />
                              {v}
                            </li>
                          ))
                        ) : (
                          <li className="text-slate-500">No fix steps provided.</li>
                        )}
                      </ul>
                    </div>
                  </div>

                  {result.questions?.length ? (
                    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="text-xs font-semibold text-slate-900">
                        Quick questions (to improve accuracy)
                      </div>
                      <ul className="mt-2 space-y-2 text-sm text-slate-700">
                        {result.questions.slice(0, 2).map((q, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="mt-2 h-2 w-2 rounded-full bg-blue-600" />
                            {q}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===================== PAGE ===================== */
function useDropPosition() {
  const [style, setStyle] = useState<React.CSSProperties>({});
  function update(el: HTMLInputElement | null) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setStyle({
      position: "fixed",
      top: r.bottom + 6,
      left: r.left,
      width: r.width,
      zIndex: 9999,
    });
  }
  return { style, update };
}

export default function Home() {
  const [tab, setTab] = useState<"diagnose" | "garage">("diagnose");
  async function loadEnginesFor(yr: string, mk: string, mdl: string) {
  const year = yr.trim();
  const make = mk.trim();
  const model = mdl.trim();

  console.log("loadEnginesFor()", { year, make, model });

  if (!year || !make || !model) {
    console.log("missing year/make/model -> no engines");
    setEngineOptions([]);
    return;
  }

  const url =
    `/api/vehicles/engines?year=${encodeURIComponent(year)}` +
    `&make=${encodeURIComponent(make)}` +
    `&model=${encodeURIComponent(model)}`;

  console.log("ENGINES URL:", url);

  const r = await fetch(url);
  const d = await r.json();

  console.log("ENGINES API RESULT:", d);

  const list = Array.isArray(d.engines) ? d.engines : [];
  setEngineOptions(list);
  setEngineOpen(true);
}

  

  const [garage, setGarage] = useState<Vehicle[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const makeRef = useRef<HTMLInputElement | null>(null);
const [makeDropStyle, setMakeDropStyle] = useState<React.CSSProperties>({});

function positionMakeDropdown() {
  const el = makeRef.current;
  if (!el) return;
  const r = el.getBoundingClientRect();
  setMakeDropStyle({
    position: "fixed",
    top: r.bottom + 8,
    left: r.left,
    width: r.width,
    zIndex: 9999,
  });
}


  const activeVehicle = useMemo(
    () => garage.find((v) => v.id === activeId) || null,
    [garage, activeId]
  );

  const [result, setResult] = useState<ApiOk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [review, setReview] = useState<{ id: string; title: string; done: boolean }[]>([]);
  

  const stats = useMemo(() => {
    const total = review.length || 0;
    const done = review.filter((i) => i.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { total, done, pct };
  }, [review]);
  

  // Load from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem("carcode_garage_v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { garage: Vehicle[]; activeId: string | null };
        setGarage(parsed.garage || []);
        setActiveId(parsed.activeId || (parsed.garage?.[0]?.id ?? null));
      }
    } catch {}
  }, []);

  // Save to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("carcode_garage_v1", JSON.stringify({ garage, activeId }));
    } catch {}
  }, [garage, activeId]);

  function addVehicle(fd: FormData) {
    const year = String(fd.get("year") || "").trim();
    const make = String(fd.get("make") || "").trim();
    const model = String(fd.get("model") || "").trim();
    const engine = String(fd.get("engine") || "").trim();
    const nickname = String(fd.get("nickname") || "").trim();
    const vin = String(fd.get("vin") || "").trim(); // NEW

    if (!year || !make || !model) return;

    const v: Vehicle = {
      id: uid(),
      year,
      make,
      model,
      engine: engine || undefined,
      nickname: nickname || undefined,
      vin: vin || undefined,
    };

    setGarage((prev) => [v, ...prev]);
    setActiveId(v.id);
    setTab("diagnose");
  }

  function removeVehicle(id: string) {
    setGarage((prev) => prev.filter((v) => v.id !== id));
    if (activeId === id) {
      const next = garage.find((v) => v.id !== id)?.id ?? null;
      setActiveId(next);
    }
  }

  async function runDiagnostic(fd: FormData) {
    setLoading(true);
    setError(null);
    setResult(null);

    if (!activeVehicle) {
      setError("Add a vehicle to your Garage first.");
      setLoading(false);
      setTab("garage");
      return;
    }

    const code = String(fd.get("code") || "").trim();
    const symptoms = String(fd.get("symptoms") || "").trim();

    if (!code && !symptoms) {
      setError("Enter a trouble code OR describe symptoms.");
      setLoading(false);
      return;
    }

    const payload = {
      year: activeVehicle.year,
      make: activeVehicle.make,
      model: activeVehicle.model,
      engine: activeVehicle.engine || "",
      code,
      symptoms,
    };

    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as ApiOk | ApiErr;

      if (!res.ok) {
        setError("error" in data ? data.error : "Request failed.");
        setReview([]);
      } else {
        setResult(data as ApiOk);
        const list = (data as ApiOk).causes.map((c) => ({
          id: uid(),
          title: c.title,
          done: false,
        }));
        setReview(list);
      }
    } catch (e: any) {
      setError(e?.message || "Network error.");
      setReview([]);
    } finally {
      setLoading(false);
    }
  }

  function toggleDone(id: string) {
    setReview((prev) => prev.map((it) => (it.id === id ? { ...it, done: !it.done } : it)));
  }
function positionEngineDropdown() {
  const el = engineInputRef.current;
  if (!el) return;
  const r = el.getBoundingClientRect();
  setEngineDropStyle({
    position: "fixed",
    top: r.bottom + 8,
    left: r.left,
    width: r.width,
    zIndex: 9999,
  });
}

  /* ===================== GARAGE FORM STATE + SUGGESTIONS ===================== */
  const [gYear, setGYear] = useState("");
  const [gMake, setGMake] = useState("");
  const [gModel, setGModel] = useState("");
  const [gVin, setGVin] = useState(""); // NEW
  const [gEngine, setGEngine] = useState(""); // NEW (so engine can be controlled)
  const engineInputRef = useRef<HTMLInputElement | null>(null);
const [engineDropStyle, setEngineDropStyle] = useState<React.CSSProperties>({});


  const [makeOptions, setMakeOptions] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [engineOptions, setEngineOptions] = useState<any[]>([]);
 // NEW
  
  const selectMake = (m: string) => {
  // set the make
  setGMake(m);

  // reset downstream selections
  setGModel("");
  setGEngine("");

  // reset downstream option lists
  setModelOptions([]);
  setEngineOptions([]);

  // close downstream dropdowns
  setModelOpen(false);
  setEngineOpen(false);

  // close the make dropdown
  setMakeOpen(false);
};

  

  const [makeOpen, setMakeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false); // NEW
const modelRef = useRef<HTMLInputElement | null>(null);
const engineRef = useRef<HTMLInputElement | null>(null);

const makeDrop = useDropPosition();
const modelDrop = useDropPosition();
const engineDrop = useDropPosition();

  const [vinLocked, setVinLocked] = useState(false);


  const makeQ = useDebouncedValue(gMake, 200);
  const modelQ = useDebouncedValue(gModel, 200);
  const vinQ = useDebouncedValue(gVin, 250); // NEW
  // ===== MAKE DROPDOWN PORTAL POSITION =====
const makeInputRef = useRef<HTMLInputElement | null>(null);

const [makeMenuPos, setMakeMenuPos] = useState<{
  left: number;
  top: number;
  width: number;
} | null>(null);

useEffect(() => {
  if (!makeOpen || !makeInputRef.current) return;

  const update = () => {
    const r = makeInputRef.current!.getBoundingClientRect();
    setMakeMenuPos({
      left: r.left,
      top: r.bottom,
      width: r.width,
    });
  };

  update();

  window.addEventListener("scroll", update, true);
  window.addEventListener("resize", update);

  return () => {
    window.removeEventListener("scroll", update, true);
    window.removeEventListener("resize", update);
  };
}, [makeOpen, makeOptions.length, gMake]);


  // Makes
  useEffect(() => {
  let cancelled = false;

  async function run() {
    if (!makeQ.trim()) {
      setMakeOptions([]);
      return;
    }

    const r = await fetch(`/api/vehicles/makes?q=${encodeURIComponent(makeQ.trim())}`);
    const d = await r.json();

    if (!cancelled) setMakeOptions(Array.isArray(d.makes) ? d.makes : []);
  }

  run().catch(() => {
    if (!cancelled) setMakeOptions([]);
  });

  return () => {
    cancelled = true;
  };
}, [makeQ]);


  // Models
  useEffect(() => {
  let cancelled = false;

  async function run() {
    if (!gMake.trim()) {
      setModelOptions([]);
      return;
    }

    const url =
      `/api/vehicles/models?make=${encodeURIComponent(gMake.trim())}` +
      (gYear.trim() ? `&year=${encodeURIComponent(gYear.trim())}` : "") +
      `&q=${encodeURIComponent(modelQ.trim())}`;

    const r = await fetch(url);
    const d = await r.json();

    if (!cancelled) setModelOptions(Array.isArray(d.models) ? d.models : []);
  }

  run().catch(() => {
    if (!cancelled) setModelOptions([]);
  });

  return () => {
    cancelled = true;
  };
}, [gMake, gYear, modelQ]);
useEffect(() => {
  if (!gYear.trim() || !gMake.trim() || !gModel.trim()) {
    setEngineOptions([]);
    return;
  }

  let cancelled = false;

  (async () => {
    try {
      const res = await fetch(
        `/api/vehicles/engines?year=${encodeURIComponent(gYear.trim())}&make=${encodeURIComponent(
          gMake.trim()
        )}&model=${encodeURIComponent(gModel.trim())}`,
        { cache: "no-store" }
      );

      const data = await res.json();
      const list = Array.isArray(data?.engines) ? data.engines : [];

      if (!cancelled) {
        setEngineOptions(list);
        // auto-open if we have results
        if (list.length) setEngineOpen(true);
      }
    } catch {
      if (!cancelled) setEngineOptions([]);
    }
  })();

  return () => {
    cancelled = true;
  };
}, [gYear, gMake, gModel]);




  async function fetchEnginesFor(year: string, make: string, model: string) {
  const y = year.trim();
  const mk = make.trim();
  const md = model.trim();

  if (!y || !mk || !md) {
    setEngineOptions([]);
    return;
  }

  try {
    const url =
      `/api/vehicles/engines?year=${encodeURIComponent(y)}` +
      `&make=${encodeURIComponent(mk)}` +
      `&model=${encodeURIComponent(md)}`;

    const r = await fetch(url);
const d: any = await r.json();
console.log("ENGINES RAW RESPONSE:", d);


const raw =
  d?.engines ??
  d?.options ??
  d?.items ??
  d?.results ??
  d?.data ??
  [];

const list = (Array.isArray(raw) ? raw : [])
  .map((x: any) =>
    typeof x === "string"
      ? x
      : x?.name || x?.label || x?.engine || x?.value || x?.title || ""
  )
  .filter(Boolean);

setEngineOptions(list);
  } catch {
  }
}

function selectModel(m: string) {
  setGModel(m);
  setModelOpen(false);
  setModelOptions([]);

  // reset engine selection only
  setGEngine("");
  setEngineOpen(true);
}








  // Engine suggestions via VIN decode
  useEffect(() => {
  let cancelled = false;

  async function run() {
    const vin = vinQ.trim().toUpperCase();

    // Reset if VIN cleared/short
    if (vin.length < 11) {
  setVinLocked(false);
  return;
}


    const r = await fetch(`/api/vehicles/vin?vin=${encodeURIComponent(vin)}`);
    const data = await r.json();

    if (cancelled) return;

    const decoded = data?.decoded;
    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];

    setEngineOptions(suggestions);

    // ✅ Auto-fill Year/Make/Model from VIN (only after successful decode)
    // We fill if:
    // - vinLocked is false (first good decode), OR
    // - fields are empty (helpful)
    const canFill =
      !vinLocked ||
      (!gYear.trim() && !gMake.trim() && !gModel.trim());

    if (decoded?.year && decoded?.make && decoded?.model && canFill) {
      setGYear(decoded.year);
      setGMake(decoded.make);
      setGModel(decoded.model);
      setVinLocked(true);

      // Close dropdowns (optional)
      setMakeOpen(false);
      setModelOpen(false);
    }

    // ✅ Auto-fill engine if empty
    if (!gEngine.trim() && suggestions.length > 0) {
      setGEngine(suggestions[0]);
    }
  }

  run().catch(() => {
    if (!cancelled) {
      setEngineOptions([]);
      setVinLocked(false);
    }
  });

  return () => {
    cancelled = true;
  };
  }, [vinQ]);


  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {loading && (
        <div className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-sm">
          <div className="mx-auto mt-16 max-w-4xl px-6">
            <CarScanLoader />
          </div>
        </div>
      )}

      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-medium text-slate-500">Car Diagnostics</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">CarCode AI Helper</h1>
            <p className="mt-1 text-sm text-slate-500">Save vehicles in your Garage, then diagnose by code or symptoms.</p>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            <button onClick={() => setTab("diagnose")} className={cn("rounded-xl px-4 py-2 text-sm font-semibold transition", tab === "diagnose" ? "bg-blue-600 text-white" : "text-slate-700 hover:bg-slate-50")}>
              Diagnose
            </button>
            <button onClick={() => setTab("garage")} className={cn("rounded-xl px-4 py-2 text-sm font-semibold transition", tab === "garage" ? "bg-blue-600 text-white" : "text-slate-700 hover:bg-slate-50")}>
              Garage
            </button>
          </div>
        </div>

        <div className="mt-6">
          {activeVehicle ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <div>
                <div className="text-xs font-medium text-slate-500">ACTIVE VEHICLE</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">
                  {activeVehicle.nickname ? `${activeVehicle.nickname} • ` : ""}
                  {activeVehicle.year} {activeVehicle.make} {activeVehicle.model}
                  {activeVehicle.engine ? ` (${activeVehicle.engine})` : ""}
                </div>
              </div>
              <button onClick={() => setTab("garage")} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold shadow-sm transition hover:bg-blue-600 hover:text-white hover:border-blue-600">Change</button>
            </div>
          ) : (
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="text-sm font-semibold">No vehicle selected</div>
              <div className="mt-1 text-sm text-slate-500">Add one in Garage to start diagnosing.</div>
            </div>
          )}
        </div>

        {tab === "diagnose" ? (
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr]">
            <div className="space-y-6">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="text-sm font-semibold">Search Issue</div>
                <div className="mt-1 text-xs text-slate-500">Use a code or symptoms.</div>

                <form className="mt-5 grid gap-3" onSubmit={(e) => { e.preventDefault(); runDiagnostic(new FormData(e.currentTarget)); }}>
                  <input name="code" placeholder="Trouble Code (optional)" className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                  <textarea name="symptoms" placeholder="Describe symptoms" className="min-h-[130px] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                  <button type="submit" disabled={loading} className="mt-1 rounded-2xl bg-blue-600 text-white py-3 text-sm font-semibold">{loading ? "Scanning..." : "FIX IT"}</button>
                </form>

                {error && <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="text-sm font-semibold">Causes Review</div>
                <div className="mt-4 space-y-2">
                  {review.length === 0 ? <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Run a diagnostic to generate causes.</div> : review.map((it) => (
                    <button key={it.id} onClick={() => toggleDone(it.id)} className={cn("w-full rounded-2xl border px-4 py-3 text-left text-sm", it.done ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white")}>{it.title}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <LikelyCausesPanel result={result} />
            </div>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr]">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="text-sm font-semibold">Add a Vehicle</div>
              <div className="mt-1 text-xs text-slate-500">Saved in this browser (local).</div>

              <form className="mt-5 grid gap-3" onSubmit={(e) => { e.preventDefault(); addVehicle(new FormData(e.currentTarget)); (e.currentTarget as HTMLFormElement).reset(); setGYear(""); setGMake(""); setGModel(""); setGVin(""); setGEngine(""); }}>
                <input name="nickname" placeholder="Nickname (optional)" className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                <input name="vin" placeholder="VIN (optional)" value={gVin} onChange={(e) => setGVin(e.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                <div className="grid grid-cols-2 gap-3">
                  <input name="year" placeholder="Year" value={gYear} onChange={(e) => setGYear(e.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                  <input name="make" placeholder="Make" value={gMake} onChange={(e) => setGMake(e.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                  <input name="model" placeholder="Model" value={gModel} onChange={(e) => setGModel(e.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                  <input name="engine" placeholder="Engine" value={gEngine} onChange={(e) => setGEngine(e.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                </div>

                <button type="submit" className="mt-3 rounded-2xl border border-slate-200 bg-white py-3 text-sm font-semibold">Save to Garage</button>
              </form>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="text-sm font-semibold">My Garage</div>
              <div className="mt-4 space-y-3">
                {garage.length === 0 ? <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No vehicles yet. Add one on the left.</div> : garage.map((v) => {
                  const isActive = v.id === activeId;
                  return (
                    <div key={v.id} className={cn("rounded-2xl border p-4", isActive ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white")}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-semibold">{v.nickname ? `${v.nickname} • ` : ""}{v.year} {v.make} {v.model}{v.engine ? ` (${v.engine})` : ""}</div>
                          {v.vin ? <div className="text-xs text-slate-400">VIN saved</div> : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setActiveId(v.id)} className={cn("rounded-2xl px-4 py-2 text-sm font-semibold", isActive ? "bg-blue-600 text-white" : "border border-slate-200 bg-white")}>{isActive ? "Active" : "Set Active"}</button>
                          <button onClick={() => removeVehicle(v.id)} className="rounded-2xl px-3 py-2 text-sm">Delete</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

