import type { Metadata } from "next";
import { COMMON_CODES, CATEGORY_LABELS } from "../data/common-codes";
import Link from "next/link";

export const metadata: Metadata = {
  title: "OBD-II Trouble Codes Directory | CarCode AI",
  description:
    "Browse common OBD-II diagnostic trouble codes (DTC). Find symptoms, causes, and fixes for engine, transmission, emissions, and other vehicle codes.",
  alternates: { canonical: "/codes" },
};

export default function CodesIndexPage() {
  const categories = Object.keys(CATEGORY_LABELS);

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#0a0e1a] via-[#101829] to-[#0c1220] text-white">
      <div className="mx-auto max-w-4xl px-4 py-10">
        <nav className="text-sm text-gray-400 mb-6">
          <Link className="hover:text-cyan-400 transition-colors" href="/">
            Home
          </Link>{" "}
          / <span className="text-white font-semibold">OBD-II Codes</span>
        </nav>

        <h1 className="text-3xl md:text-4xl font-bold">
          OBD-II Trouble Codes
        </h1>
        <p className="mt-3 text-gray-300 max-w-2xl">
          Browse common diagnostic trouble codes below. Click any code for
          detailed information about symptoms, causes, and fixes — or use{" "}
          <Link href="/" className="text-cyan-400 hover:underline">
            CarCode AI
          </Link>{" "}
          for a diagnosis tailored to your specific vehicle.
        </p>

        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm">
          <h2 className="text-xl font-semibold text-cyan-400 mb-3">What Are OBD-II Trouble Codes?</h2>
          <div className="space-y-3 text-gray-300 text-sm leading-relaxed">
            <p>
              OBD-II (On-Board Diagnostics, version 2) is a standardized system built into every car and light truck sold in the United States since 1996. When your vehicle detects a problem — anything from a misfiring engine to a loose gas cap — the OBD-II system stores a <strong className="text-white">Diagnostic Trouble Code (DTC)</strong> and usually turns on the Check Engine Light. Each code is a five-character identifier like P0300 or C0035 that pinpoints the system or circuit where the fault was detected. Codes starting with <strong className="text-white">P</strong> relate to the powertrain (engine and transmission), <strong className="text-white">B</strong> to body systems, <strong className="text-white">C</strong> to the chassis (brakes, steering, suspension), and <strong className="text-white">U</strong> to the communication network between modules.
            </p>
            <p>
              Symptoms are the clues your car gives you before or alongside a trouble code. Rough idling, poor fuel economy, hesitation during acceleration, unusual noises, or warning lights on your dashboard are all signs that something needs attention. Sometimes a single symptom maps to dozens of possible causes, which is why reading the specific DTC is so valuable — it narrows the search and saves time at the repair shop.
            </p>
            <p>
              <strong className="text-white">CarCode AI</strong> takes diagnostics a step further. Instead of handing you a generic code definition, it combines the trouble code with your exact vehicle — year, make, model, and engine — to deliver AI-powered analysis. You get ranked probable causes, severity ratings, step-by-step confirmation checks, and recommended fixes, all in plain language. Whether you are a weekend DIY mechanic or just want to understand what your mechanic is telling you, CarCode AI helps you make informed decisions, avoid unnecessary repairs, and keep your vehicle running safely.
            </p>
          </div>
        </div>

        {categories.map((cat) => {
          const codes = COMMON_CODES.filter((c) => c.category === cat);
          if (codes.length === 0) return null;
          const catInfo = CATEGORY_LABELS[cat];
          return (
            <section key={cat} className="mt-10">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold"
                  style={{ backgroundColor: catInfo.color + "22", color: catInfo.color }}
                >
                  {catInfo.icon}
                </span>
                <span style={{ color: catInfo.color }}>{catInfo.label}</span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {codes.map((c) => (
                  <Link
                    key={c.code}
                    className="rounded-xl border border-white/10 bg-white/5 p-4 hover:bg-white/10 hover:border-white/20 transition-all backdrop-blur-sm group"
                    href={`/codes/${c.code.toLowerCase()}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold text-cyan-400 group-hover:text-cyan-300">
                        {c.code}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          c.severity === "high"
                            ? "bg-red-500/20 text-red-400"
                            : c.severity === "medium"
                              ? "bg-yellow-500/20 text-yellow-400"
                              : "bg-green-500/20 text-green-400"
                        }`}
                      >
                        {c.severity}
                      </span>
                    </div>
                    <div className="text-sm text-gray-300 mt-1">{c.description}</div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}

        <div className="mt-12 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm text-center">
          <h2 className="text-xl font-semibold">Don't see your code?</h2>
          <p className="mt-2 text-gray-400">
            CarCode AI can diagnose any OBD-II code. Enter your code and vehicle details for a personalized diagnosis.
          </p>
          <Link
            className="mt-4 inline-block rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-3 text-white font-semibold shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-shadow"
            href="/"
          >
            Try CarCode AI
          </Link>
        </div>
      </div>
    </main>
  );
}
