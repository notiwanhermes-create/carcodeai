import { auth } from "@/app/lib/auth-config";
import { readJsonBody } from "@/app/lib/http";
import { clientIpKey } from "@/app/lib/client-ip";
import { consumeRateLimit, envInt } from "@/app/lib/rate-limit";
import { parseImportPayload } from "@/app/lib/garage-import";
import { importDeviceData } from "@/app/lib/garage-store";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Largest import request accepted. A device's history is text only, so this is generous. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Copy what this device holds (vehicles, service records, saved diagnoses)
 * into the signed-in account. The user sees what will be copied and asks for it;
 * nothing is imported automatically.
 *
 * A vehicle that is already in the account is reported as a duplicate and left
 * alone. See importDeviceData.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const limit = await consumeRateLimit(`import:user:${session.user.id}`, envInt("GARAGE_IMPORT_HOURLY_LIMIT", 20), 60 * 60);
  const perIp = limit.allowed ? await consumeRateLimit(`import:ip:${clientIpKey(req)}`, envInt("GARAGE_IMPORT_HOURLY_LIMIT", 20) * 3, 60 * 60) : limit;
  if (!limit.allowed || !perIp.allowed) {
    return NextResponse.json({ error: "Too many imports. Please try again later.", code: "rate_limited" }, { status: 429 });
  }

  const raw = await readJsonBody(req, MAX_BODY_BYTES);
  if (!raw.ok) return NextResponse.json({ error: "Invalid request." }, { status: raw.status });
  const parsed = parseImportPayload(raw.data);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const results = await importDeviceData(session.user.id, parsed.value);
  return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
