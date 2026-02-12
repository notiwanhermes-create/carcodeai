import { auth } from "@/app/lib/auth-config";
import { ensureDB } from "@/app/lib/db";
import prisma from "@/app/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureDB();
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  const vehicle = await prisma.vehicle.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  }

  await prisma.maintenanceRecord.deleteMany({
    where: { vehicleId: id, userId: session.user.id },
  });

  await prisma.vehicle.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
