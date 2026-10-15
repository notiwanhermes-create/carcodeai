import { auth } from "@/app/lib/auth-config";
import { redirect } from "next/navigation";
import VehicleClient from "./VehicleClient";

export const dynamic = "force-dynamic";

/** One vehicle in the garage. Signed-in users only; the API checks it is theirs. */
export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/garage/${id}`)}`);
  }
  return <VehicleClient vehicleId={id} />;
}
