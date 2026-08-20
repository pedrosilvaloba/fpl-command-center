import { NextResponse } from "next/server";
import { getBootstrap } from "@/lib/fpl-client";

// Thin JSON passthrough — kept as a real API route (not just a server
// component fetch) so other pieces of this app (the future shadow-team
// simulator, the automation engine, a mobile client) can hit one stable
// internal endpoint instead of each re-implementing the FPL call.
export async function GET() {
  try {
    const data = await getBootstrap();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 }
    );
  }
}
