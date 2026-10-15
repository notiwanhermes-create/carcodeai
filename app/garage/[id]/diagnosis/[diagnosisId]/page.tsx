import { auth } from "@/app/lib/auth-config";
import { redirect } from "next/navigation";
import DiagnosisClient from "./DiagnosisClient";

export const dynamic = "force-dynamic";

/** A saved diagnosis. Signed-in users only; the API checks it is theirs. */
export default async function DiagnosisPage({ params }: { params: Promise<{ id: string; diagnosisId: string }> }) {
  const { id, diagnosisId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/garage/${id}/diagnosis/${diagnosisId}`)}`);
  }
  return <DiagnosisClient vehicleId={id} diagnosisId={diagnosisId} />;
}
