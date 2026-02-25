"use client";

import { SessionProvider } from "next-auth/react";

/**
 * If you see ClientFetchError "Failed to fetch":
 * 1. Copy .env.local.example to .env.local
 * 2. Set NEXTAUTH_URL and AUTH_URL to the URL you open in the browser (e.g. http://localhost:5000)
 * 3. Restart the dev server and open the app at that same URL
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
