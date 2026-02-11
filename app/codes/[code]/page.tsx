import type { Metadata } from "next";
import { COMMON_CODES } from "../../data/common-codes";
import { getCodeDefinition, getCodeParseOnly } from "../../lib/code-definition";
import { getDtcDefinition } from "../../lib/dtc-definition";
import Link from "next/link";

const OEM_MAKE_OPTIONS = ["BMW", "Mercedes", "VW", "Audi", "Volvo", "Porsche", "Ford", "GM", "Toyota", "Honda", "Hyundai", "Kia"] as const;

type CodeData = {
  code: string;
  title: string;
  meaning: string;
  symptoms: string[];
  causes: string[];
  fixes: string[];
  canDrive: string;
  severity: "Low" | "Medium" | "High";
  category: string;
  hasDefinition: boolean;
  /** For badge: "Generic OBD-II" vs "Manufacturer-specific" */
  codeKind: "obd2" | "oem" | "unknown";
  /** OEM hex code but no make in URL yet */
  oemNeedsMake?: boolean;
  /** OEM with make selected but not in DB */
  oemNotFound?: boolean;
  oemMake?: string;
};

function normalizeCode(raw: string) {
  return decodeURIComponent(raw).trim().toUpperCase().replace(/[\s-]/g, "");
}

function getRelatedCodes(code: string): { code: string; description: string }[] {
  const c = code.toUpperCase();
  const prefix = c[0];
  const numPart = c.slice(1);
  const num = parseInt(numPart, 10);
  if (isNaN(num)) return [];

  const related: { code: string; description: string }[] = [];

  const candidates = [
    num - 2, num - 1, num + 1, num + 2, num + 3, num + 4,
  ];

  for (const n of candidates) {
    if (n < 0 || n > 9999) continue;
    const candidate = `${prefix}${n.toString().padStart(4, "0")}`;
    if (candidate === c) continue;
    const def = getDtcDefinition(candidate);
    const entry = COMMON_CODES.find((e) => e.code === candidate);
    const description = def?.title ?? entry?.description ?? "Trouble code";
    if (def || entry) {
      related.push({ code: candidate, description });
    }
    if (related.length >= 6) break;
  }

  if (related.length < 3) {
    const entry = COMMON_CODES.find((e) => e.code === c);
    if (entry) {
      const sameCategory = COMMON_CODES.filter(
        (e) => e.category === entry.category && e.code !== c && !related.some((r) => r.code === e.code)
      );
      for (const s of sameCategory) {
        const desc = getDtcDefinition(s.code)?.title ?? s.description;
        related.push({ code: s.code, description: desc });
        if (related.length >= 6) break;
      }
    }
  }

  return related;
}

function getCategoryLabel(cat: string) {
  const labels: Record<string, string> = {
    engine: "Engine / Powertrain",
    transmission: "Transmission",
    emissions: "Emissions",
    fuel: "Fuel System",
    electrical: "Electrical",
    brakes: "Brakes / ABS",
    body: "Body / Airbag",
    network: "Network / Communication",
  };
  return labels[cat] || "General";
}

function getSeverityColor(s: string) {
  if (s === "High") return "text-red-400 border-red-500/40 bg-red-500/10";
  if (s === "Medium") return "text-yellow-400 border-yellow-500/40 bg-yellow-500/10";
  return "text-green-400 border-green-500/40 bg-green-500/10";
}

const severityMap: Record<string, "Low" | "Medium" | "High"> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const genericSections = {
  symptoms: [
    "Check Engine Light (CEL) or warning indicator",
    "Reduced engine performance or limp mode",
    "Rough idle, hesitation, or stalling",
    "Poor fuel economy",
  ],
  causes: [
    "Faulty sensor or wiring issue",
    "Vacuum leak or air/fuel imbalance",
    "Ignition or fuel system problem",
    "Mechanical issue (less common)",
  ],
  fixes: [
    "Scan freeze-frame data and confirm the code",
    "Inspect wiring, connectors, and relevant sensors",
    "Check for intake or vacuum leaks",
    "Test components per your vehicle's service manual",
    "Clear the code and verify it does not return",
  ],
  canDrive:
    "It depends on the specific issue. If the engine is misfiring, overheating, or running poorly, stop driving and diagnose immediately. Otherwise, drive cautiously and repair soon.",
};

async function getCodeData(code: string, make?: string | null): Promise<CodeData> {
  const c = normalizeCode(code);
  const lookup = await getCodeDefinition(code, make ?? undefined);
  const entry = COMMON_CODES.find((e) => e.code === c);

  if (lookup.found && lookup.definition) {
    const def = lookup.definition;
    const category = entry?.category ?? "engine";
    const commonCause = entry?.commonCause ?? "Faulty sensor, wiring, or related component";
    const isObd2 = def.codeType === "obd2";
    const meaning = isObd2
      ? `${def.code} is an OBD-II diagnostic trouble code indicating: ${def.title}. ${def.description !== def.title ? def.description : ""} This code falls under the ${getCategoryLabel(category)} category. The most common cause is: ${commonCause}.`.trim()
      : `${def.code} (${def.make}): ${def.title}. ${def.description}`.trim();
    return {
      hasDefinition: true,
      code: def.code,
      title: def.title,
      meaning,
      symptoms: genericSections.symptoms,
      causes: [commonCause, "Wiring or connector damage", "Related sensor failure", "ECM/PCM software issue"],
      fixes: [
        "Scan for freeze-frame data and confirm the code",
        "Inspect wiring, connectors, and related sensors",
        `Address primary cause: ${commonCause}`,
        "Clear the code and perform a test drive",
        "Re-scan to verify the code does not return",
      ],
      canDrive:
        entry?.severity === "high"
          ? "Not recommended. This is a high-severity code that could cause further damage or safety issues. Diagnose and repair as soon as possible."
          : entry?.severity === "medium"
            ? "You may drive short distances cautiously, but schedule a diagnosis soon. Continued driving may worsen the issue."
            : "Generally safe to drive short-term, but get the issue diagnosed when convenient to prevent it from becoming a bigger problem.",
      severity: entry ? severityMap[entry.severity] || "Medium" : "Medium",
      category,
      codeKind: def.codeType === "obd2" ? "obd2" : "oem",
      oemMake: def.make,
    };
  }

  if (lookup.parseType === "oem_hex") {
    if (lookup.needsMake) {
      return {
        hasDefinition: false,
        code: c,
        title: "Manufacturer-specific code",
        meaning: `"${c}" is a manufacturer-specific (OEM) fault code. Select your vehicle make below to look up a verified definition. We do not show AI-generated meanings for OEM codes.`,
        ...genericSections,
        severity: "Medium",
        category: "engine",
        codeKind: "oem",
        oemNeedsMake: true,
      };
    }
    return {
      hasDefinition: false,
      code: c,
      title: "Manufacturer-specific code",
      meaning: `We don't have a verified definition for ${c} (${make ?? "this make"}) yet. Please provide the scan tool output text or try selecting a different make. We never guess OEM code meanings with AI.`,
      ...genericSections,
      severity: "Medium",
      category: "engine",
      codeKind: "oem",
      oemNotFound: true,
      oemMake: make ?? undefined,
    };
  }

  if (lookup.parseType === "obd2") {
    return {
      hasDefinition: false,
      code: c,
      title: "Unknown OBD-II code",
      meaning: `${c} is not in our standard OBD-II database. Exact meaning can vary by vehicle. Enter your vehicle details and this code in CarCode AI to get a diagnosis tailored to your car.`,
      ...genericSections,
      severity: "Medium",
      category: "engine",
      codeKind: "obd2",
    };
  }

  return {
    hasDefinition: false,
    code: c,
    title: "Unknown code format",
    meaning: `"${c}" doesn't match a standard OBD-II code (e.g. P0300) or a manufacturer hex code (e.g. 480A12). Check the code format and try again, or describe your symptoms on the home page.`,
    ...genericSections,
    severity: "Medium",
    category: "engine",
    codeKind: "unknown",
  };
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ make?: string }>;
}): Promise<Metadata> {
  const { code: rawCode } = await params;
  const { make } = await searchParams;
  const code = normalizeCode(decodeURIComponent(rawCode));
  const d = await getCodeData(code, make ?? undefined);

  const title = `${d.code} Code – ${d.title} | CarCode AI`;
  const description = `${d.code}: ${d.title}. Learn about symptoms, causes, and fixes. Diagnose the issue faster with CarCode AI.`;
  const canonicalPath = make ? `/codes/${encodeURIComponent(d.code)}?make=${encodeURIComponent(make)}` : `/codes/${encodeURIComponent(d.code)}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title,
      description,
      url: canonicalPath,
      type: "article",
    },
  };
}

function FAQJsonLd({ code, title }: { code: string; title: string }) {
  const json = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What does ${code} mean?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${code} indicates: ${title}. Exact meaning can vary by make, model, and year.`,
        },
      },
      {
        "@type": "Question",
        name: `Is it safe to drive with ${code}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `It depends on severity. If the vehicle is misfiring, overheating, or has severe drivability issues, stop driving and diagnose immediately. Otherwise, drive cautiously and repair soon.`,
        },
      },
      {
        "@type": "Question",
        name: `What are common causes of ${code}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Common causes include wiring or connector issues, sensor faults, vacuum leaks, ignition/fuel system problems, and sometimes mechanical issues. Use CarCode AI for a diagnosis specific to your vehicle.`,
        },
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(json) }}
    />
  );
}

export default async function CodePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ make?: string }>;
}) {
  const { code: rawCode } = await params;
  const { make } = await searchParams;
  const code = normalizeCode(decodeURIComponent(rawCode));
  const d = await getCodeData(code, make ?? undefined);

  const badgeLabel = d.codeKind === "obd2" ? "Generic OBD-II" : d.codeKind === "oem" ? "Manufacturer-specific" : "Unknown format";

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#0a0e1a] via-[#101829] to-[#0c1220] text-white">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <FAQJsonLd code={d.code} title={d.title} />

        <nav className="text-sm text-gray-400 mb-6">
          <Link className="hover:text-cyan-400 transition-colors" href="/">
            Home
          </Link>{" "}
          /{" "}
          <Link className="hover:text-cyan-400 transition-colors" href="/codes">
            OBD-II Codes
          </Link>{" "}
          / <span className="text-white font-semibold">{d.code}</span>
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${
              d.codeKind === "obd2" ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40" : d.codeKind === "oem" ? "bg-amber-500/20 text-amber-300 border border-amber-500/40" : "bg-slate-500/20 text-slate-400 border border-slate-500/40"
            }`}
          >
            {badgeLabel}
          </span>
          {d.oemMake && <span className="text-xs text-gray-500">Make: {d.oemMake}</span>}
        </div>

        <h1 className="text-3xl md:text-4xl font-bold mt-4">
          <span className="text-cyan-400">{d.code}</span> – {d.title}
        </h1>

        <p className="mt-4 text-gray-300 leading-relaxed">{d.meaning}</p>

        {d.oemNeedsMake && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-amber-200 mb-3">
              Select your vehicle make to look up a verified definition. We do not guess OEM code meanings.
            </p>
            <div className="flex flex-wrap gap-2">
              {OEM_MAKE_OPTIONS.map((m) => (
                <Link
                  key={m}
                  href={`/codes/${encodeURIComponent(d.code)}?make=${encodeURIComponent(m)}`}
                  className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20 border border-white/20 transition-colors"
                >
                  {m}
                </Link>
              ))}
            </div>
          </div>
        )}

        {d.oemNotFound && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-amber-200">
              We don&apos;t have a verified definition for this code yet. Please provide the scan tool output text or select your vehicle make. We never show AI-generated meanings for OEM codes.
            </p>
            <Link
              className="mt-3 inline-block rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-shadow"
              href={`/?code=${encodeURIComponent(d.code)}`}
            >
              Diagnose with your vehicle details
            </Link>
          </div>
        )}

        {!d.hasDefinition && !d.oemNeedsMake && !d.oemNotFound && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-amber-200">
              This code is not in our database. For an accurate diagnosis, provide your vehicle make, model, and year.
            </p>
            <Link
              className="mt-3 inline-block rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-shadow"
              href={`/?code=${encodeURIComponent(d.code)}`}
            >
              Diagnose {d.code} with your vehicle details
            </Link>
          </div>
        )}

        <div className="mt-6 flex gap-4">
          <div
            className={`rounded-xl border px-5 py-3 backdrop-blur-sm ${getSeverityColor(d.severity)}`}
          >
            <div className="text-xs uppercase tracking-wider opacity-70">Severity</div>
            <div className="text-lg font-bold">{d.severity}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-wider text-gray-400">Category</div>
            <div className="text-lg font-semibold text-white">{getCategoryLabel(d.category)}</div>
          </div>
        </div>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-cyan-400">Common Symptoms</h2>
          <ul className="mt-4 space-y-2">
            {d.symptoms.map((s) => (
              <li key={s} className="flex items-start gap-3 text-gray-300">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-cyan-400" />
                {s}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-cyan-400">Common Causes</h2>
          <ul className="mt-4 space-y-2">
            {d.causes.map((c) => (
              <li key={c} className="flex items-start gap-3 text-gray-300">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-yellow-400" />
                {c}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-cyan-400">How to Fix</h2>
          <ol className="mt-4 space-y-3">
            {d.fixes.map((f, i) => (
              <li key={f} className="flex items-start gap-3 text-gray-300">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-400 text-sm font-bold">
                  {i + 1}
                </span>
                {f}
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm">
          <h2 className="text-xl font-semibold text-white">Can I Drive With This Code?</h2>
          <p className="mt-3 text-gray-300 leading-relaxed">{d.canDrive}</p>
        </section>

        {(() => {
          if (d.codeKind !== "obd2") return null;
          const related = getRelatedCodes(d.code);
          if (related.length === 0) return null;
          return (
            <section className="mt-10">
              <h2 className="text-xl font-semibold text-cyan-400">Related Codes</h2>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {related.map((r) => (
                  <Link
                    key={r.code}
                    href={`/codes/${r.code.toLowerCase()}`}
                    className="rounded-xl border border-white/10 bg-white/5 p-4 hover:bg-white/10 hover:border-white/20 transition-all backdrop-blur-sm group"
                  >
                    <span className="text-base font-bold text-cyan-400 group-hover:text-cyan-300">{r.code}</span>
                    <span className="block text-sm text-gray-400 mt-0.5">{r.description}</span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })()}

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-3 text-white font-semibold shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-shadow"
            href={`/?code=${encodeURIComponent(d.code)}`}
          >
            Diagnose {d.code} with AI
          </Link>
          <Link
            className="rounded-xl border border-white/20 bg-white/5 px-6 py-3 font-semibold text-white hover:bg-white/10 transition-colors backdrop-blur-sm"
            href="/codes"
          >
            Browse All Codes
          </Link>
        </div>
      </div>
    </main>
  );
}
