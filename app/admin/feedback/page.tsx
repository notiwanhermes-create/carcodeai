import { headers } from "next/headers";
import { getFeedbackRows } from "@/app/lib/adminFeedback";
import AdminFeedbackClient from "./AdminFeedbackClient";

export const metadata = {
  title: "Admin — Feedback | CarCode AI",
  robots: "noindex, nofollow",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getTokenFromRequest(searchParams: { token?: string }): string | null {
  const query = searchParams?.token?.trim();
  return query ?? null;
}

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const queryToken = getTokenFromRequest(params);

  let headerToken: string | null = null;
  try {
    const h = await headers();
    headerToken = h.get("x-admin-token")?.trim() ?? null;
  } catch {
    // headers() may throw in some edge runtimes
  }

  const adminToken = process.env.ADMIN_TOKEN?.trim();
  const isAuthorized =
    !!adminToken &&
    (queryToken === adminToken || (!!headerToken && headerToken === adminToken));

  const initialRows = isAuthorized ? await getFeedbackRows() : null;

  return <AdminFeedbackClient initialRows={initialRows} />;
}
