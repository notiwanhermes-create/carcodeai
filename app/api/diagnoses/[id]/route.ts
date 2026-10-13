import { auth } from "@/app/lib/auth-config";
import { readJsonBody } from "@/app/lib/http";
import { isOdometerUnit, parseOdometerValue } from "@/app/lib/odometer";
import { getDiagnosis, recordOutcome, type OutcomeInput } from "@/app/lib/garage-store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

const LIMITS = { description: 300, notes: 1000 } as const;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * One saved diagnosis, read entirely from the database. Opening it again never
 * calls the AI model.
 */
export async function GET(_req: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;
  const diagnosis = await getDiagnosis(session.user.id, id);
  if (!diagnosis) return NextResponse.json({ error: "Diagnosis not found." }, { status: 404 });
  return NextResponse.json({ diagnosis }, { headers: noStore });
}

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, " ").trim();
  return cleaned.length > max ? null : cleaned;
}

function parseOutcome(body: Record<string, unknown>): { ok: true; value: OutcomeInput } | { ok: false; error: string } {
  switch (body.outcome) {
    case "not_yet":
    case "dismissed":
    case "reopen":
      return { ok: true, value: { outcome: body.outcome } };
    case "fixed": {
      const description = text(body.description, LIMITS.description);
      const notes = text(body.notes, LIMITS.notes);
      const fixedOn = text(body.fixedOn, 10);
      if (description === null || notes === null || fixedOn === null) return { ok: false, error: "One of the fields is too long." };
      if (!description) return { ok: false, error: "Describe what fixed the problem." };

      let matchedCauseRank: number | null = null;
      if (body.matchedCauseRank !== undefined && body.matchedCauseRank !== null) {
        if (typeof body.matchedCauseRank !== "number" || !Number.isInteger(body.matchedCauseRank) || body.matchedCauseRank < 1 || body.matchedCauseRank > 20) {
          return { ok: false, error: "Invalid request." };
        }
        matchedCauseRank = body.matchedCauseRank;
      }

      let mileage: { value: number; unit: "km" | "mi" | null } | null = null;
      if (body.odometerValue !== undefined && body.odometerValue !== null && body.odometerValue !== "") {
        const value = parseOdometerValue(body.odometerValue);
        if (value === null) return { ok: false, error: "Mileage must be a whole number." };
        mileage = { value, unit: isOdometerUnit(body.odometerUnit) ? body.odometerUnit : null };
      }
      return { ok: true, value: { outcome: "fixed", description, matchedCauseRank, fixedOn, mileage, notes } };
    }
    default:
      return { ok: false, error: "Invalid request." };
  }
}

/**
 * "Did this fix it?" Record the outcome of a diagnosis: fixed (with what
 * actually fixed it), not yet, dismissed, or reopen. See recordOutcome.
 */
export async function PATCH(req: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const raw = await readJsonBody(req, 8 * 1024);
  if (!raw.ok) return NextResponse.json({ error: "Invalid request." }, { status: raw.status });
  const body = (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const parsed = parseOutcome(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await recordOutcome(session.user.id, id, parsed.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ diagnosis: result.diagnosis }, { headers: noStore });
}
