import type { JobHealth } from "@/lib/joblog";

/**
 * The automation panel.
 *
 * Its only job is to make silence audible. Three maintenance jobs failed
 * every week for a month and a half and nothing on this screen changed,
 * because a job that dies before it writes leaves the same trace as a job
 * that never ran. Old numbers look exactly like current numbers when nothing
 * says when they were computed.
 *
 * So this panel reports the LAST SUCCESS, not the last attempt. A job failing
 * every day is not a job running every day, and a panel that showed "ran
 * today" for a run that returned an error would be the same lie in a new
 * place.
 */

function ago(iso: string | null | undefined): string {
  if (!iso) return "nunca";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `há ${days} dia${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `há ${hours}h`;
  return "há minutos";
}

export default function AutomationPanel({
  jobs,
  cronSecretConfigured,
}: {
  jobs: JobHealth[];
  cronSecretConfigured: boolean;
}) {
  return (
    <div className="mb-5 rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base font-bold tracking-tight">
          Tarefas automáticas
        </h3>
        <p className="font-mono text-[11px] tabular text-text-muted">
          mostra o último SUCESSO — falhar todos os dias não é correr todos os dias
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {jobs.map((j) => {
          const tone = j.stale
            ? "border-danger/50 bg-danger/10"
            : "border-success/40 bg-success/5";
          return (
            <div key={j.job} className={`rounded-lg border p-3 ${tone}`}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="font-display text-sm font-bold text-text">{j.label}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    j.stale ? "border-danger text-danger" : "border-success text-success"
                  }`}
                >
                  {j.stale ? "parada" : "ok"}
                </span>
              </div>
              <p className="mb-1 font-mono text-[11px] tabular text-text-muted">
                último sucesso{" "}
                <strong className="text-text">
                  {ago(j.lastSuccess?.finishedAt ?? j.lastSuccess?.startedAt)}
                </strong>
                {" · esperada a cada "}
                {j.expectedEveryDays}d
              </p>
              <p className="text-xs leading-relaxed text-text-muted">
                {j.lastSuccess
                  ? j.lastSuccess.summary
                  : "Nunca concluiu com sucesso."}
              </p>
              {j.last && j.last.ok !== true && (
                <p className="mt-1 text-xs leading-relaxed text-danger">
                  {j.last.finishedAt === null
                    ? `Última tentativa (${ago(j.last.startedAt)}) começou e nunca terminou — provavelmente morreu no limite de tempo da função.`
                    : `Última tentativa (${ago(j.last.finishedAt)}) falhou: ${j.last.summary}`}
                  {j.consecutiveFailures > 1 && ` · ${j.consecutiveFailures} falhas seguidas.`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!cronSecretConfigured && (
        <p className="mt-3 rounded-lg border border-warn/50 bg-warn/10 p-3 text-xs leading-relaxed text-text">
          <strong>Falta CRON_SECRET.</strong> A Vercel só assina os pedidos
          automáticos quando essa variável existe, por isso sem ela a tarefa
          diária bate na porta e leva 401 — todos os dias, em silêncio. Define
          <code className="mx-1 font-mono">CRON_SECRET</code> nas Environment
          Variables do projeto (qualquer valor longo serve) e faz Redeploy. Está
          escrito aqui em vez de descoberto daqui a um mês.
        </p>
      )}

      <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-text-muted">
        O <strong className="text-text">backtest</strong> e a{" "}
        <strong className="text-text">calibração</strong> correm sozinhos, todos os
        dias às 6h UTC, dentro da própria aplicação — não dependem de ninguém nem
        de nenhuma sessão. A{" "}
        <strong className="text-text">investigação tática</strong> é a única que
        precisa mesmo de uma sessão semanal, porque envolve ler notícias e decidir
        o que é relevante; se aparecer &quot;parada&quot;, é essa sessão que falhou.
      </p>
    </div>
  );
}
