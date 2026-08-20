import { NextResponse } from "next/server";
import { getEntryPicks } from "@/lib/fpl-client";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const teamId = Number(id);
  const gw = Number(new URL(req.url).searchParams.get("event"));
  if (!Number.isFinite(teamId) || !Number.isFinite(gw)) {
    return NextResponse.json(
      { error: "invalid team id or event" },
      { status: 400 }
    );
  }
  try {
    const data = await getEntryPicks(teamId, gw);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "Não foi possível obter o plantel para essa jornada — verifica o Team ID ou tenta a jornada anterior.",
        detail: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 }
    );
  }
}
