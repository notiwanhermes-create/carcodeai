import { headers } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const h = await headers();
  const hostname = h.get("x-forwarded-host") || h.get("host") || "";
  const forwardedFor = h.get("x-forwarded-for") || "";
  const forwardedProto = h.get("x-forwarded-proto") || "";

  return NextResponse.json({
    hostname,
    forwardedFor: forwardedFor.substring(0, 20) + "...",
    forwardedProto,
    hasReplId: !!process.env.REPL_ID,
    hasDevDomain: !!process.env.REPLIT_DEV_DOMAIN,
    hasDomains: !!process.env.REPLIT_DOMAINS,
    replEnv: process.env.REPLIT_ENVIRONMENT || "unknown",
    nodeEnv: process.env.NODE_ENV || "unknown",
    timestamp: new Date().toISOString(),
  });
}
