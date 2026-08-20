import { NextResponse } from "next/server";
import { getEntry, getEntryHistory } from "@/lib/fpl-client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const teamId = Number(id);
  if (!Number.isFinite(teamId)) {
    return NextResponse.json({ error: "invalid team id" }, { status: 400 });
  }
  try {
    const [entry, history] = await Promise.all([
      getEntry(teamId),
      getEntryHistory(teamId),
    ]);
    return NextResponse.json({ entry, history });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 }
    );
  }
}
