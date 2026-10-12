import { NextRequest, NextResponse } from "next/server";
import { getFeedbackRows } from "@/app/lib/adminFeedback";

function getTokenFromRequest(req: NextRequest): string | null {
  const header = req.headers.get("x-admin-token");
  if (header?.trim()) return header.trim();
  const url = new URL(req.url);
  const query = url.searchParams.get("token");
  if (query?.trim()) return query.trim();
  return null;
}

function isAuthorized(req: NextRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken?.trim()) return false;
  const token = getTokenFromRequest(req);
  return token === adminToken.trim();
}

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: noCacheHeaders,
    });
  }

  try {
    return NextResponse.json(await getFeedbackRows(), { headers: noCacheHeaders });
  } catch (err) {
    console.error("[admin/feedback]", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500, headers: noCacheHeaders }
    );
  }
}
