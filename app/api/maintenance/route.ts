import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { isOdometerUnit } from "@/app/lib/odometer";
import { addMaintenance, MAINTENANCE_FIELDS, toMaintenanceDto } from "@/app/lib/garage-store";
import { NextRequest, NextResponse } from "next/server";

/** Longest value accepted for each field. Everything here is free text from the browser. */
const LIMITS = { vehicleId: 64, date: 40, odometer: 40, serviceType: 80, notes: 2000, cost: 40 } as const;

/**
 * A signed-in user's service records. This is the one place they are kept.
 *
 * Each record comes back with the text as the user entered it (`date`,
 * `odometer`, `cost`) and, where that text was clear, the typed values
 * (`serviceDate`, `odometerValue`, `odometerUnit`), so a page can show
 * "130,250 km" without guessing a unit.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const vehicleId = searchParams.get("vehicleId");

  // Always scoped to the signed-in user: another user's vehicle id returns nothing.
  const where: { userId: string; vehicleId?: string } = { userId: session.user.id };
  if (vehicleId) where.vehicleId = vehicleId;

  const records = await prisma.maintenanceRecord.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: MAINTENANCE_FIELDS,
  });

  return NextResponse.json({ records: records.map(toMaintenanceDto) });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const fields: Record<keyof typeof LIMITS, string> = { vehicleId: "", date: "", odometer: "", serviceType: "", notes: "", cost: "" };
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const raw = (body as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" && typeof raw !== "number") {
      return NextResponse.json({ error: "Invalid service record." }, { status: 400 });
    }
    const value = String(raw).trim();
    if (value.length > LIMITS[key]) {
      return NextResponse.json({ error: "One of the fields is too long." }, { status: 400 });
    }
    fields[key] = value;
  }
  const { vehicleId, date, odometer, serviceType, notes, cost } = fields;

  if (!vehicleId || !date || !serviceType) {
    return NextResponse.json({ error: "Vehicle, date, and service type are required." }, { status: 400 });
  }

  // The unit chosen in the form, when the reading itself does not say one.
  const rawUnit = (body as Record<string, unknown>).odometerUnit;
  const odometerUnit = isOdometerUnit(rawUnit) ? rawUnit : null;

  // The record can only be attached to a vehicle this user owns.
  const record = await addMaintenance(session.user.id, { vehicleId, serviceType, date, odometerText: odometer, odometerUnit, cost, notes });
  if (!record) {
    return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  }

  return NextResponse.json({ record });
}
