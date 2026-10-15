import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { parseModelYear } from "@/app/lib/maintenance-values";
import { isOdometerUnit, parseOdometerValue } from "@/app/lib/odometer";
import { listVehicles, toVehicleDto } from "@/app/lib/garage-store";
import { NextRequest, NextResponse } from "next/server";

/** The user's garage. `?archived=1` lists the vehicles they removed but that still have history. */
export async function GET(req?: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const archived = req ? new URL(req.url).searchParams.get("archived") === "1" : false;
  return NextResponse.json({ vehicles: await listVehicles(session.user.id, { archived }) });
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
  const LIMITS = { year: 4, make: 60, model: 60, engine: 100, vin: 17, nickname: 60, trim: 60 } as const;
  const fields: Record<keyof typeof LIMITS, string> = { year: "", make: "", model: "", engine: "", vin: "", nickname: "", trim: "" };
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
  const { year, make, model, engine, vin, nickname, trim } = fields;

  if (!year || !make || !model) {
    return NextResponse.json({ error: "Year, make, and model are required." }, { status: 400 });
  }
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "Year must be a 4-digit year." }, { status: 400 });
  }

  // An optional starting odometer reading.
  const rawOdometer = (body as Record<string, unknown>).odometerValue;
  let odometerValue: number | null = null;
  if (rawOdometer !== undefined && rawOdometer !== null && rawOdometer !== "") {
    odometerValue = parseOdometerValue(rawOdometer);
    if (odometerValue === null) {
      return NextResponse.json({ error: "Mileage must be a whole number." }, { status: 400 });
    }
  }
  const rawUnit = (body as Record<string, unknown>).odometerUnit;
  const odometerUnit = odometerValue !== null && isOdometerUnit(rawUnit) ? rawUnit : null;

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
      trim: trim || null,
      odometerValue,
      odometerUnit,
      odometerUpdatedAt: odometerValue === null ? null : new Date(),
    },
    select: {
      id: true, year: true, make: true, model: true, engine: true, vin: true, nickname: true, trim: true,
      odometerValue: true, odometerUnit: true, odometerUpdatedAt: true, archivedAt: true,
    },
  });

  return NextResponse.json({ vehicle: toVehicleDto(vehicle) });
}
