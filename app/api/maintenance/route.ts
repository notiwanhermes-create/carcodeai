import { auth } from "@/app/lib/auth-config";
import { ensureDB } from "@/app/lib/db";
import prisma from "@/app/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  await ensureDB();
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const vehicleId = searchParams.get("vehicleId");

  const where: any = { userId: session.user.id };
  if (vehicleId) where.vehicleId = vehicleId;

  const records = await prisma.maintenanceRecord.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    records: records.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
      serviceType: r.serviceType,
      date: r.date,
      odometer: r.odometer || undefined,
      notes: r.notes || undefined,
      cost: r.cost || undefined,
    })),
  });
}

export async function POST(req: NextRequest) {
  await ensureDB();
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { vehicleId, date, odometer, serviceType, notes, cost } = body;

  if (!vehicleId || !date || !serviceType) {
    return NextResponse.json({ error: "Vehicle, date, and service type are required." }, { status: 400 });
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, userId: session.user.id },
  });
  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  }

  const record = await prisma.maintenanceRecord.create({
    data: {
      userId: session.user.id,
      vehicleId,
      date,
      odometer: odometer || null,
      serviceType,
      notes: notes || null,
      cost: cost || null,
    },
  });

  return NextResponse.json({
    record: {
      id: record.id,
      vehicleId: record.vehicleId,
      serviceType: record.serviceType,
      date: record.date,
      odometer: record.odometer || undefined,
      notes: record.notes || undefined,
      cost: record.cost || undefined,
    },
  });
}
