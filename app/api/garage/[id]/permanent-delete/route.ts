import { auth } from "@/app/lib/auth-config";
import { readJsonBody } from "@/app/lib/http";
import { deleteVehiclePermanently } from "@/app/lib/garage-store";
import { PERMANENT_DELETE_CONFIRMATION } from "@/app/lib/garage-types";
import { NextRequest, NextResponse } from "next/server";

type Context = { params: Promise<{ id: string }> };

/**
 * Delete an archived vehicle for good, with all of its service records,
 * diagnoses and reported repairs.
 *
 * Three separate checks, all on the server:
 *  - the vehicle belongs to the signed-in user (someone else's answers "not found");
 *  - it is already archived (a vehicle still in the garage answers 409);
 *  - the request carries the confirmation the user typed: { "confirm": "DELETE" }.
 *    A request without it changes nothing, so no single click and no older page
 *    can delete a vehicle by accident.
 */
export async function POST(req: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const parsed = await readJsonBody(req, 1024);
  if (!parsed.ok) return NextResponse.json({ error: "Invalid request." }, { status: parsed.status });
  const body = (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : {}) as Record<string, unknown>;
  if (body.confirm !== PERMANENT_DELETE_CONFIRMATION) {
    return NextResponse.json(
      { error: `Type ${PERMANENT_DELETE_CONFIRMATION} to confirm. Nothing was deleted.`, code: "confirm_required" },
      { status: 400 },
    );
  }

  const result = await deleteVehiclePermanently(session.user.id, id);
  if (result.outcome === "not_found") return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  if (result.outcome === "not_archived") {
    return NextResponse.json({ error: "Archive the vehicle first. Only an archived vehicle can be deleted for good.", code: "not_archived" }, { status: 409 });
  }
  return NextResponse.json(
    { ok: true, deleted: { maintenance: result.maintenance, diagnoses: result.diagnoses, repairs: result.repairs } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
