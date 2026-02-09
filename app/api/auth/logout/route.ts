import { destroySession } from "@/app/lib/auth";
import { headers } from "next/headers";

export async function GET() {
  await destroySession();
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const clean = host.split(":")[0];
  const baseUrl = clean && !clean.includes("localhost") && !clean.includes("0.0.0.0")
    ? `https://${clean}`
    : "http://localhost:5000";
  return Response.redirect(new URL("/", baseUrl));
}

export async function POST() {
  await destroySession();
  return Response.json({ success: true });
}
