import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { parseCost, parseOdometer, parseServiceDate } from "@/app/lib/maintenance-values";
import { NextRequest, NextResponse } from "next/server";

/** Longest value accepted for each field. Everything here is free text from the browser. */
const LIMITS = { vehicleId: 64, date: 40, odometer: 40, serviceType: 80, notes: 2000, cost: 40 } as const;

type RecordRow = {
  id: string;
  vehicleId: string;
  serviceType: string;
  date: string;
  odometer: string | null;
  notes: string | null;
  cost: string | null;
};

/** The shape the page has always received: what the user typed, as text. */
function toResponse(r: RecordRow) {
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    serviceType: r.serviceType,
    date: r.date,
    odometer: r.odometer || undefined,
    notes: r.notes || undefined,
    cost: r.cost || undefined,
  };
}

const RESPONSE_FIELDS = { id: true, vehicleId: true, serviceType: true, date: true, odometer: true, notes: true, cost: true } as const;

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
    select: RESPONSE_FIELDS,
  });

  return NextResponse.json({ records: records.map(toResponse) });
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

  // The record can only be attached to a vehicle this user owns.
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, userId: session.user.id },
    select: { id: true },
  });
  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  }

  // What the user typed is stored as typed. The typed copies are filled in only
  // when the text converts cleanly (see maintenance-values.ts).
  const reading = parseOdometer(odometer);
  const record = await prisma.maintenanceRecord.create({
    data: {
      userId: session.user.id,
      vehicleId,
      serviceType,
      notes: notes || null,
      date,
      serviceDate: parseServiceDate(date),
      odometer: odometer || null,
      odometerValue: reading?.value ?? null,
      odometerUnit: reading?.unit ?? null,
      cost: cost || null,
      costAmount: parseCost(cost),
    },
    select: RESPONSE_FIELDS,
  });

  return NextResponse.json({ record: toResponse(record) });
}
