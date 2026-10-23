import { NextResponse } from "next/server";

/**
 * SECURITY: this is a public, single-user dashboard without an authenticated
 * browser session. The former endpoint exposed the Redis squad to everyone
 * and let anonymous callers overwrite it.
 *
 * Until first-party authentication is added, Shadow Team persists ONLY in
 * browser localStorage. Existing Redis data is retained (not deleted) for
 * migration behind future authentication; it is no longer publicly readable.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { configured: false, ids: null, mode: "local-only" },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST() {
  return NextResponse.json(
    { error: "Sincronização no servidor desativada: falta autenticação do utilizador." },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}
