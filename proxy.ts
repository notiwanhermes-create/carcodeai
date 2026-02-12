import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

function getCanonicalUrl(): URL | null {
  const raw = process.env.NEXTAUTH_URL || process.env.AUTH_URL;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function getRequestHost(req: NextRequest): string {
  const hostHeader = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  return hostHeader.split(",")[0]?.trim().toLowerCase() ?? "";
}

function stripPort(host: string): string {
  // Handles "example.com:3000"
  return host.replace(/:\d+$/, "");
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Canonical domain redirect: apex -> www (driven by NEXTAUTH_URL/AUTH_URL)
  // Important: only redirect real HTML navigations. Redirecting API/RSC/fetch requests can break Auth.js
  // (next-auth/react uses same-origin credentialed fetches).
  const accept = request.headers.get("accept") ?? "";
  const isNavigate = request.headers.get("sec-fetch-mode") === "navigate";
  const wantsHtml = accept.includes("text/html");
  const shouldRedirect = request.method === "GET" && (isNavigate || wantsHtml);

  if (shouldRedirect) {
    const canonical = getCanonicalUrl();
    if (canonical) {
      const canonicalHostname = canonical.hostname.toLowerCase();
      if (canonicalHostname.startsWith("www.")) {
        const apexHostname = canonicalHostname.replace(/^www\./, "");
        const reqHostname = stripPort(getRequestHost(request));

        if (reqHostname === apexHostname) {
          const url = request.nextUrl.clone();
          url.protocol = canonical.protocol;
          url.hostname = canonical.hostname;
          url.port = canonical.port;
          return NextResponse.redirect(url, 308);
        }
      }
    }
  }

  if (path.startsWith("/admin") || path.startsWith("/api/admin")) {
    const res = NextResponse.next();
    Object.entries(noCacheHeaders).forEach(([key, value]) => {
      res.headers.set(key, value);
    });
    return res;
  }
  return NextResponse.next();
}
