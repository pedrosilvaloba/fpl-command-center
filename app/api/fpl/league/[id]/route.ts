import { NextResponse } from "next/server";
import { getLeagueStandings } from "@/lib/fpl-client";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const leagueId = Number(id);
  if (!Number.isFinite(leagueId)) {
    return NextResponse.json({ error: "invalid league id" }, { status: 400 });
  }
  const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
  try {
    const data = await getLeagueStandings(leagueId, page);
    return NextResponse.json(data);
  } catch (err) {
    // Private leagues need an authenticated session, which the read-only
    // proxy layer doesn't hold — surface that distinction to the caller.
    return NextResponse.json(
      {
        error:
          "Não foi possível obter a liga. Se for uma liga privada, é preciso sessão autenticada (ver roadmap de autenticação).",
        detail: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 }
    );
  }
}
