export async function GET() {
  return Response.json({
    google: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
}
