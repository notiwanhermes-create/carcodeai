import { getCodeDefinition } from "../../../lib/code-definition";
import { getDtcDefinition } from "../../../lib/dtc-definition";

const EXPECTED_OBD2: Record<string, string> = {
  P0300: "Random/Multiple Cylinder Misfire Detected",
  P0420: "Catalyst System Efficiency Below Threshold (Bank 1)",
  P0171: "System Too Lean (Bank 1)",
  P0455: "Evaporative Emission System Leak Detected (Gross Leak)",
};

const EXPECTED_OEM = { code: "480A12", make: "BMW", title: "Rear brake pad wear sensor: wear limit reached / circuit open" };

export const dynamic = "force-dynamic";

export async function GET() {
  const results: { code: string; expected: string; actual: string | null; pass: boolean; type?: string }[] = [];

  for (const [code, expectedTitle] of Object.entries(EXPECTED_OBD2)) {
    const def = getDtcDefinition(code);
    const actual = def?.title ?? null;
    results.push({
      code,
      expected: expectedTitle,
      actual,
      pass: actual === expectedTitle,
      type: "obd2",
    });
  }

  const oemLookup = await getCodeDefinition(EXPECTED_OEM.code, EXPECTED_OEM.make);
  const oemActual = oemLookup.found && oemLookup.definition ? oemLookup.definition.title : null;
  results.push({
    code: `${EXPECTED_OEM.code} (${EXPECTED_OEM.make})`,
    expected: EXPECTED_OEM.title,
    actual: oemActual,
    pass: oemActual === EXPECTED_OEM.title,
    type: "oem",
  });

  const allPass = results.every((r) => r.pass);

  return Response.json(
    {
      ok: allPass,
      message: allPass
        ? "All code definitions (OBD2 + OEM 480A12) match the expected dataset."
        : "One or more definitions do not match.",
      results,
    },
    { status: allPass ? 200 : 500 }
  );
}
