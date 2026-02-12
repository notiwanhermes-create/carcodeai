import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const vehicles = await prisma.vehicle.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
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

  const body = await req.json();
  const { year, make, model, engine, vin, nickname } = body;

  if (!year || !make || !model) {
    return NextResponse.json({ error: "Year, make, and model are required." }, { status: 400 });
  }

  const vehicle = await prisma.vehicle.create({
    data: {
      userId: session.user.id,
      year,
      make,
      model,
      engine: engine || null,
      vin: vin || null,
      nickname: nickname || null,
    },
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
