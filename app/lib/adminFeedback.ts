/**
 * Reading stored feedback for the admin page and the admin API.
 * Both use this one function, so they always agree on the fields.
 */
import prisma from "./prisma";

/** One feedback entry as the admin page shows it. */
export type FeedbackRow = {
  created_at: string;
  rating: number | null;
  name: string | null;
  email: string | null;
  /** Where the feedback was sent from (stored in the `page_url` column). */
  page_url: string | null;
  message: string;
};

/** The most recent feedback, newest first. */
export async function getFeedbackRows(limit = 200): Promise<FeedbackRow[]> {
  const rows = await prisma.feedback.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { createdAt: true, rating: true, name: true, email: true, pageUrl: true, message: true },
  });
  return rows.map((r) => ({
    created_at: r.createdAt.toISOString(),
    rating: r.rating,
    name: r.name,
    email: r.email,
    page_url: r.pageUrl,
    message: r.message,
  }));
}
