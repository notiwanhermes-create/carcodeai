import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { readJsonBody } from "@/app/lib/http";
import { decideMileageUpdate, isOdometerUnit, parseOdometerValue } from "@/app/lib/odometer";
import { findOwnedVehicle, toVehicleDto, vehicleDetail } from "@/app/lib/garage-store";
import { NextRequest, NextResponse } from "next/server";

type Context = { params: Promise<{ id: string }> };

const noStore = { "Cache-Control": "no-store" };

/** One vehicle with its open issues, history and service records. */
export async function GET(_req: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;
  const detail = await vehicleDetail(session.user.id, id);
  if (!detail) return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  return NextResponse.json(detail, { headers: noStore });
}

/**
 * Change a vehicle: its trim or nickname, its current odometer reading, or
 * whether it is archived.
 *
 * Mileage: a higher reading is stored. A lower one, or one in the other unit,
 * is refused with code "mileage_confirm" unless the request says
 * `confirm: true`, so a slip cannot wind the reading back but a real correction
 * is possible.
 */
export async function PATCH(req: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const parsed = await readJsonBody(req, 4 * 1024);
  if (!parsed.ok) return NextResponse.json({ error: "Invalid request." }, { status: parsed.status });
  const body = (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const vehicle = await findOwnedVehicle(session.user.id, id);
  if (!vehicle) return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });

  const data: { trim?: string | null; nickname?: string | null; odometerValue?: number; odometerUnit?: string | null; odometerUpdatedAt?: Date; archivedAt?: Date | null } = {};

  for (const key of ["trim", "nickname"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== "string") return NextResponse.json({ error: "Invalid vehicle details." }, { status: 400 });
    const value = String(body[key] ?? "").trim();
    if (value.length > 60) return NextResponse.json({ error: "That is too long (max 60 characters)." }, { status: 400 });
    data[key] = value || null;
  }

  if (body.mileage !== undefined) {
    const m = (body.mileage && typeof body.mileage === "object" ? body.mileage : {}) as Record<string, unknown>;
    const value = parseOdometerValue(m.value);
    if (value === null) return NextResponse.json({ error: "Mileage must be a whole number." }, { status: 400 });
    if (!isOdometerUnit(m.unit)) return NextResponse.json({ error: "Choose km or mi." }, { status: 400 });

    const current = vehicle.odometerValue === null ? null : { value: vehicle.odometerValue, unit: isOdometerUnit(vehicle.odometerUnit) ? vehicle.odometerUnit : null };
    const decision = decideMileageUpdate(current, { value, unit: m.unit }, m.confirm === true);
    if (decision.action === "confirm") {
      return NextResponse.json(
        {
          error:
            decision.reason === "lower"
              ? "That is lower than the mileage on file. Confirm to correct it."
              : "That is in a different unit from the mileage on file. Confirm to replace it.",
          code: "mileage_confirm",
          reason: decision.reason,
          current,
        },
        { status: 409 },
      );
    }
    if (decision.action === "set") {
      data.odometerValue = value;
      data.odometerUnit = m.unit;
      data.odometerUpdatedAt = new Date();
    }
  }

  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    data.archivedAt = body.archived ? (vehicle.archivedAt ?? new Date()) : null;
  }

  if (Object.keys(data).length > 0) {
    // Scoped to the owner again in the statement itself.
    await prisma.vehicle.updateMany({ where: { id, userId: session.user.id }, data });
  }
  const fresh = await findOwnedVehicle(session.user.id, id);
  return NextResponse.json({ vehicle: fresh ? toVehicleDto(fresh) : null }, { headers: noStore });
}

/**
 * Remove a vehicle from the garage.
 *
 * This ARCHIVES the vehicle. It leaves the garage, nothing recorded for it is
 * deleted, and it can be restored. No vehicle is ever deleted by this request,
 * whether or not it has history: deleting for good is a separate, explicit step
 * that only works on a vehicle that is already archived (see
 * ./permanent-delete/route.ts).
 */
export async function DELETE(_req: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const vehicle = await findOwnedVehicle(userId, id);
  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  }

  // One statement, scoped to the signed-in user: someone else's vehicle id matches nothing.
  if (!vehicle.archivedAt) {
    await prisma.vehicle.updateMany({ where: { id, userId, archivedAt: null }, data: { archivedAt: new Date() } });
  }
  return NextResponse.json({ ok: true, archived: true });
}
