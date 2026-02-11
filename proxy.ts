import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.startsWith("/admin") || path.startsWith("/api/admin")) {
    const res = NextResponse.next();
    Object.entries(noCacheHeaders).forEach(([key, value]) => {
      res.headers.set(key, value);
    });
    return res;
  }
  return NextResponse.next();
}
