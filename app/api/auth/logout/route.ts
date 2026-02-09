import { destroySession } from "@/app/lib/auth";

export async function GET() {
  await destroySession();
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS;
  const baseUrl = domain ? `https://${domain}` : "https://localhost:5000";
  return Response.redirect(new URL("/", baseUrl));
}
