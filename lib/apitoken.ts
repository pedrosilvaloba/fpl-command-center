/**
 * The shared token check for every write/expensive endpoint.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT TRIMS.
 *
 * Four routes had four copies of the same three lines, and all four rejected
 * a token that differed from the configured one by a single trailing
 * newline. That is not a hypothetical: an environment variable pasted into a
 * dashboard text field picks up trailing whitespace routinely, and the
 * failure it produces is maximally confusing — the value LOOKS identical
 * wherever you inspect it, and every request still returns 401.
 *
 * The weekly research tasks had never once managed to write to this app.
 * `lastRun` sat at null for a week while the dashboard showed active notes
 * (seeded by hand) that made the layer look alive.
 *
 * Trimming both sides costs nothing — no legitimate token has leading or
 * trailing whitespace — and removes a whole class of silent failure.
 *
 * THE DIAGNOSTIC. When a check fails, `describe()` returns whether the
 * variable is set at all and the two LENGTHS. That is enough to tell apart
 * "not configured", "configured but a different value", and "same value with
 * whitespace" without ever revealing a character of the secret.
 */

export interface TokenCheck {
  ok: boolean;
  /** Is INSIGHTS_API_TOKEN set on the server at all? */
  configured: boolean;
  expectedLength: number;
  providedLength: number;
}

export function checkApiToken(provided: string | null | undefined): TokenCheck {
  const expected = (process.env.INSIGHTS_API_TOKEN ?? "").trim();
  const given = (provided ?? "").trim();
  return {
    // No token configured means writes are disabled, not that anything goes.
    ok: expected.length > 0 && given.length > 0 && given === expected,
    configured: expected.length > 0,
    expectedLength: expected.length,
    providedLength: given.length,
  };
}

export interface CronAuth {
  ok: boolean;
  via: "cron" | "token" | "none";
  reason?: string;
}

/**
 * Authentication for the scheduled job endpoint.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on every scheduled
 * invocation — that is the primary path. A `?token=` matching
 * INSIGHTS_API_TOKEN is accepted too, so the job can also be fired by hand
 * from a browser or from a tool that can only issue plain GETs (the same
 * constraint that shaped /api/insights/push).
 *
 * THE CASE THAT MATTERS. When NEITHER secret is configured, this refuses. The
 * tempting shortcut is to let an unconfigured deployment through so the cron
 * "just works" — but this endpoint runs the most expensive computation in the
 * project, so an open version of it is a denial-of-service button, and "it is
 * only my little app" is exactly how those get found. Refusing loudly also
 * surfaces the misconfiguration rather than hiding it behind a job that
 * appears to work.
 *
 * Pure, and taking its secrets as arguments, so the refusal can be tested
 * without a running server.
 */
export function checkCronAuth(
  authorizationHeader: string | null | undefined,
  queryToken: string | null | undefined,
  secrets: { cronSecret?: string | null; apiToken?: string | null } = {}
): CronAuth {
  const cronSecret = (secrets.cronSecret ?? process.env.CRON_SECRET ?? "").trim();
  const header = (authorizationHeader ?? "").trim();
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (cronSecret.length > 0 && bearer.length > 0 && bearer === cronSecret) {
    return { ok: true, via: "cron" };
  }

  const expected = (secrets.apiToken ?? process.env.INSIGHTS_API_TOKEN ?? "").trim();
  const given = (queryToken ?? "").trim();
  if (expected.length > 0 && given.length > 0 && given === expected) {
    return { ok: true, via: "token" };
  }

  if (cronSecret.length === 0 && expected.length === 0) {
    return {
      ok: false,
      via: "none",
      reason:
        "nem CRON_SECRET nem INSIGHTS_API_TOKEN estão definidas no servidor — a tarefa automática está desligada por segurança em vez de ficar aberta a qualquer pedido",
    };
  }
  return { ok: false, via: "none", reason: "não autorizado" };
}

/** A 401 body that helps diagnose without leaking the secret. */
export function unauthorizedBody(check: TokenCheck): Record<string, unknown> {
  return {
    error: check.configured
      ? "não autorizado — o token enviado não corresponde a INSIGHTS_API_TOKEN"
      : "não autorizado — INSIGHTS_API_TOKEN não está definida no servidor, por isso as escritas estão desligadas",
    configured: check.configured,
    // Lengths only, never content. Comprimentos diferentes indicam quase
    // sempre espaço/quebra de linha colada por engano no painel da Vercel.
    expectedLength: check.expectedLength,
    providedLength: check.providedLength,
    hint: !check.configured
      ? "Define INSIGHTS_API_TOKEN nas Environment Variables do projeto (ambiente Production) e faz Redeploy — as variáveis só entram em vigor num deploy novo."
      : check.expectedLength !== check.providedLength
        ? "Os comprimentos não batem certo: o valor guardado no servidor é diferente do enviado (muitas vezes por espaço ou quebra de linha colada a mais)."
        : "Os comprimentos batem certo mas o conteúdo não — provavelmente um carácter trocado.",
  };
}
