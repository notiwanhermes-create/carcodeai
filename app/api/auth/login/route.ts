import { getLoginUrl } from "@/app/lib/auth";
import { headers } from "next/headers";

export async function GET() {
  const h = await headers();
  const hostname = h.get("host") || h.get("x-forwarded-host") || "";
  const loginUrl = await getLoginUrl(hostname);
  return Response.redirect(loginUrl);
}
