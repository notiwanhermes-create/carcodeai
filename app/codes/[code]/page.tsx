import type { Metadata } from "next";
import { COMMON_CODES } from "../../data/common-codes";
import Link from "next/link";

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
};

function normalizeCode(raw: string) {
  return decodeURIComponent(raw).trim().toUpperCase();
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

function getCodeData(code: string): CodeData {
  const c = normalizeCode(code);
  const entry = COMMON_CODES.find((e) => e.code === c);

  if (entry) {
    const severityMap: Record<string, "Low" | "Medium" | "High"> = {
      low: "Low",
      medium: "Medium",
      high: "High",
    };
    return {
      code: c,
      title: entry.description,
      meaning: `${c} is an OBD-II diagnostic trouble code indicating: ${entry.description}. This code falls under the ${getCategoryLabel(entry.category)} category. The most common cause is: ${entry.commonCause}.`,
      symptoms: [
        "Check Engine Light (CEL) or warning indicator",
        "Reduced engine performance or limp mode",
        "Rough idle, hesitation, or stalling",
        "Poor fuel economy",
      ],
      causes: [entry.commonCause, "Wiring or connector damage", "Related sensor failure", "ECM/PCM software issue"],
      fixes: [
        "Scan for freeze-frame data and confirm the code",
        "Inspect wiring, connectors, and related sensors",
        `Address primary cause: ${entry.commonCause}`,
        "Clear the code and perform a test drive",
        "Re-scan to verify the code does not return",
      ],
      canDrive:
        entry.severity === "high"
          ? "Not recommended. This is a high-severity code that could cause further damage or safety issues. Diagnose and repair as soon as possible."
          : entry.severity === "medium"
            ? "You may drive short distances cautiously, but schedule a diagnosis soon. Continued driving may worsen the issue."
            : "Generally safe to drive short-term, but get the issue diagnosed when convenient to prevent it from becoming a bigger problem.",
      severity: severityMap[entry.severity] || "Medium",
      category: entry.category,
    };
  }

  const prefix = c[0];
  const categoryLabels: Record<string, string> = {
    P: "Powertrain",
    B: "Body",
    C: "Chassis",
    U: "Network/Communication",
  };
  const category = categoryLabels[prefix] || "General";

  return {
    code: c,
    title: `${category} Trouble Code`,
    meaning: `${c} is an OBD-II diagnostic trouble code in the ${category} category. Exact meaning can vary by vehicle make, model, and year. Use CarCode AI to get a detailed diagnosis for your specific vehicle.`,
    symptoms: [
      "Check Engine Light (CEL) or warning indicator",
      "Reduced performance or limp mode",
      "Rough idle or hesitation",
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
    severity: "Medium",
    category: "engine",
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code: rawCode } = await params;
  const code = normalizeCode(rawCode);
  const d = getCodeData(code);

  const title = `${d.code} Code – ${d.title} | CarCode AI`;
  const description = `${d.code}: ${d.title}. Learn about symptoms, causes, and fixes. Diagnose the issue faster with CarCode AI.`;

  return {
    title,
    description,
    alternates: { canonical: `/codes/${d.code.toLowerCase()}` },
    openGraph: {
      title,
      description,
      url: `/codes/${d.code.toLowerCase()}`,
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
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: rawCode } = await params;
  const code = normalizeCode(rawCode);
  const d = getCodeData(code);

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

        <h1 className="text-3xl md:text-4xl font-bold">
          <span className="text-cyan-400">{d.code}</span> – {d.title}
        </h1>

        <p className="mt-4 text-gray-300 leading-relaxed">{d.meaning}</p>

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
