import { NextResponse } from "next/server";
import { searchMakes } from "@/app/data/vehicle-makes";

/**
 * Make suggestions for the garage form, served from the curated list in
 * app/data/vehicle-makes.ts. No external request is made.
 */
export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").slice(0, 60);
  const makes = searchMakes(q).map((name, i) => ({ id: i + 1, name }));
  return NextResponse.json({ makes }, { headers: { "Cache-Control": "public, max-age=3600" } });
}
