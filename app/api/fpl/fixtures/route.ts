import { NextResponse } from "next/server";
import { getFixtures } from "@/lib/fpl-client";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const event = searchParams.get("event");
  const future = searchParams.get("future");
  try {
    const data = await getFixtures({
      event: event ? Number(event) : undefined,
      future: future === "1",
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 }
    );
  }
}
