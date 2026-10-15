import { auth } from "@/app/lib/auth-config";
import { listDiagnoses } from "@/app/lib/garage-store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The signed-in user's saved diagnoses, newest first. `?vehicleId=` and `?status=` narrow the list. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const diagnoses = await listDiagnoses(session.user.id, {
    vehicleId: searchParams.get("vehicleId") || undefined,
    status: searchParams.get("status") || undefined,
  });
  return NextResponse.json({ diagnoses }, { headers: { "Cache-Control": "no-store" } });
}
