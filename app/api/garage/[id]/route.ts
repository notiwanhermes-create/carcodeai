import { auth } from "@/app/lib/auth-config";
import prisma from "@/app/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  // One statement, scoped to the signed-in user: someone else's vehicle id
  // matches nothing. The vehicle's service records go with it, because the
  // database relation is ON DELETE CASCADE, so nothing is left behind.
  const { count } = await prisma.vehicle.deleteMany({
    where: { id, userId: session.user.id },
  });
  if (count === 0) {
    return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
