import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { parseModelYear } from "@/app/lib/maintenance-values";
import { NextRequest, NextResponse } from "next/server";

/** The columns the page uses. Listed explicitly so a query never depends on columns it does not need. */
const VEHICLE_FIELDS = { id: true, year: true, make: true, model: true, engine: true, vin: true, nickname: true } as const;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const vehicles = await prisma.vehicle.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: VEHICLE_FIELDS,
  });

  return NextResponse.json({
    vehicles: vehicles.map((v) => ({
      id: v.id,
      year: v.year,
      make: v.make,
      model: v.model,
      engine: v.engine || undefined,
      vin: v.vin || undefined,
      nickname: v.nickname || undefined,
    })),
  });
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

  // Every field is free text from the browser: require strings and cap lengths.
  const LIMITS = { year: 4, make: 60, model: 60, engine: 100, vin: 17, nickname: 60 } as const;
  const fields: Record<keyof typeof LIMITS, string> = { year: "", make: "", model: "", engine: "", vin: "", nickname: "" };
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const raw = (body as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" && typeof raw !== "number") {
      return NextResponse.json({ error: "Invalid vehicle details." }, { status: 400 });
    }
    const value = String(raw).trim();
    if (value.length > LIMITS[key]) {
      return NextResponse.json({ error: `${key[0].toUpperCase()}${key.slice(1)} is too long (max ${LIMITS[key]} characters).` }, { status: 400 });
    }
    fields[key] = value;
  }
  const { year, make, model, engine, vin, nickname } = fields;

  if (!year || !make || !model) {
    return NextResponse.json({ error: "Year, make, and model are required." }, { status: 400 });
  }
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "Year must be a 4-digit year." }, { status: 400 });
  }

  const vehicle = await prisma.vehicle.create({
    data: {
      userId: session.user.id,
      year,
      // The same year as a number, for sorting and date maths later on.
      modelYear: parseModelYear(year),
      make,
      model,
      engine: engine || null,
      vin: vin || null,
      nickname: nickname || null,
    },
    select: VEHICLE_FIELDS,
  });

  return NextResponse.json({
    vehicle: {
      id: vehicle.id,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      engine: vehicle.engine || undefined,
      vin: vehicle.vin || undefined,
      nickname: vehicle.nickname || undefined,
    },
  });
}
