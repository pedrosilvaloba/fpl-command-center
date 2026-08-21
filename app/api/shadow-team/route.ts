import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/kv";

// Single-user personal deployment — one fixed key is enough; no need for
// per-visitor keying (this app is not multi-tenant).
const KEY = "fpl-command-center:shadow-team";

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ configured: false, ids: null });
  }
  try {
    const ids = await redis.get<number[]>(KEY);
    return NextResponse.json({
      configured: true,
      ids: Array.isArray(ids) ? ids : null,
    });
  } catch {
    return NextResponse.json(
      {
        configured: true,
        ids: null,
        error: "Falha a ler o Shadow Team guardado no servidor.",
      },
      { status: 502 }
    );
  }
}

// A Shadow Team is at most 15 players. Bounding the payload strictly is
// what stops this endpoint being usable as arbitrary third-party storage.
//
// A note on why there is no bearer token here, unlike /api/insights: this
// write comes from the user's own browser, so any secret would have to
// ship inside the client bundle and would not be a secret. Real
// authentication needs a login, which this single-user app does not have.
// What IS achievable — and what this does — is bounding the damage: the
// worst an anonymous caller can do is replace a simulation squad with
// another valid-looking one, rather than store whatever they like in the
// Redis instance. Note that making the GitHub repository private would
// NOT help: the endpoint lives at a public URL either way.
const MAX_SQUAD_IDS = 15;

export async function POST(req: NextRequest) {
  const redis = getRedis();
  if (!redis) {
    // Not an error — the frontend just keeps using localStorage until the
    // Upstash Redis integration is connected.
    return NextResponse.json({ configured: false, ok: false });
  }
  const body = await req.json().catch(() => null);
  const ids = body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_SQUAD_IDS ||
    !ids.every((n) => Number.isInteger(n) && n > 0 && n < 100000)
  ) {
    return NextResponse.json(
      { error: `ids inválido — esperado até ${MAX_SQUAD_IDS} inteiros positivos` },
      { status: 400 }
    );
  }
  if (new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: "ids duplicados" }, { status: 400 });
  }
  try {
    await redis.set(KEY, ids);
    return NextResponse.json({ configured: true, ok: true });
  } catch {
    return NextResponse.json(
      {
        configured: true,
        ok: false,
        error: "Falha a guardar o Shadow Team no servidor.",
      },
      { status: 502 }
    );
  }
}
