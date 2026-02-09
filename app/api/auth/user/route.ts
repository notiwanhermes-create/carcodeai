import { getSessionUser } from "@/app/lib/auth";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json(null, { status: 200 });
  }
  return Response.json(user, { status: 200 });
}
