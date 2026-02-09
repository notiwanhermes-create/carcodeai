import { getLoginUrl } from "@/app/lib/auth";
import { headers } from "next/headers";

export async function GET() {
  const h = await headers();
  const hostname = h.get("x-forwarded-host") || h.get("host") || "";
  const loginUrl = await getLoginUrl(hostname);
  return Response.redirect(loginUrl);
}
