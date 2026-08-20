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

export async function POST(req: NextRequest) {
  const redis = getRedis();
  if (!redis) {
    // Not an error — the frontend just keeps using localStorage until the
    // Upstash Redis integration is connected.
    return NextResponse.json({ configured: false, ok: false });
  }
  const body = await req.json().catch(() => null);
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.every((n) => typeof n === "number")) {
    return NextResponse.json({ error: "ids inválido" }, { status: 400 });
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
