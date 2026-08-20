import { getBootstrap, getFixtures } from "@/lib/fpl-client";
import { buildFixtureTicker } from "@/lib/fdr";
import {
  buildScoredPlayers,
  buildSuggestedSquad,
  pickCaptain,
  findDifferentials,
} from "@/lib/recommend";
import { PLAYBOOK, RULES_2026_27 } from "@/lib/strategy";
import CountdownTimer from "@/components/CountdownTimer";
import FixtureTicker from "@/components/FixtureTicker";
import PlayerTable from "@/components/PlayerTable";

// Rendered per-request (not at build time): this sandbox's build
// environment has no route to the FPL API to prerender against, and in
// production we want every visit checking the Vercel Data Cache rather
// than serving a build-time snapshot. The underlying fetch() calls still
// cache for 5 minutes each via their own `next: { revalidate }` option.
export const dynamic = "force-dynamic";

function Section({
  id,
  title,
  eyebrow,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <div className="mb-4">
        {eyebrow && (
          <p className="text-xs uppercase tracking-widest text-accent font-semibold mb-1">
            {eyebrow}
          </p>
        )}
        <h2 className="font-display text-2xl md:text-3xl tracking-wide text-text text-balance">
          {title}
        </h2>
      </div>
      <div className="rounded-xl border border-border bg-surface p-4 md:p-6">
        {children}
      </div>
    </section>
  );
}

export default async function Home() {
  const [bootstrap, fixtures] = await Promise.all([
    getBootstrap(),
    getFixtures({ future: true }),
  ]);

  const nextEvent =
    bootstrap.events.find((e) => e.is_next) ??
    bootstrap.events.find((e) => e.is_current) ??
    bootstrap.events[0];
  const fromEvent = nextEvent?.id ?? 1;

  const ticker = buildFixtureTicker(bootstrap.teams, fixtures, fromEvent, 5);
  const scored = buildScoredPlayers(bootstrap, fixtures, fromEvent, 5);
  const { squad, starters, totalCost } = buildSuggestedSquad(scored, 100);
  const { captain, viceCaptain } = pickCaptain(starters);
  const differentials = findDifferentials(scored, 10, 8);

  const byPos = (id: number, n = 8) =>
    scored.filter((p) => p.element.element_type === id).slice(0, n);

  const isPreseason = scored[0]?.isPreseason ?? true;
  const bench = squad.filter((p) => !starters.includes(p));

  return (
    <div className="min-h-full bg-bg text-text">
      {/* Status bar */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 md:px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-text-muted">
              FPL Command Center
            </p>
            <h1 className="font-display text-3xl md:text-4xl tracking-wide">
              {nextEvent?.name ?? "Gameweek"}
            </h1>
          </div>
          {nextEvent?.deadline_time && (
            <div className="text-right">
              <p className="text-xs uppercase tracking-widest text-text-muted mb-1">
                Deadline em
              </p>
              <CountdownTimer deadlineIso={nextEvent.deadline_time} />
              <p className="text-xs text-text-muted mt-1 font-mono tabular">
                {new Date(nextEvent.deadline_time).toLocaleString("pt-PT", {
                  timeZone: "Europe/Lisbon",
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                (Lisboa)
              </p>
            </div>
          )}
        </div>
        <nav className="mx-auto max-w-6xl px-4 md:px-6 pb-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-muted">
          {[
            ["squad", "Equipa Sugerida"],
            ["fixtures", "Calendário"],
            ["picks", "Melhores Escolhas"],
            ["differentials", "Diferenciais"],
            ["playbook", "Playbook"],
            ["rules", "Regras"],
            ["roadmap", "Roadmap"],
          ].map(([href, label]) => (
            <a key={href} href={`#${href}`} className="hover:text-accent">
              {label}
            </a>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 md:px-6 py-8 flex flex-col gap-10">
        {isPreseason && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] px-4 py-3 text-sm text-warn">
            Época ainda não começou (ou está entre jornadas) — os dados de
            forma/pontos ainda não existem, por isso as pontuações abaixo
            pesam mais o preço, a posse e o calendário. Assim que a jornada
            atual tiver jogos concluídos, o motor passa a priorizar forma
            recente e pontos por jogo automaticamente.
          </div>
        )}

        <Section
          id="squad"
          eyebrow={`Sugestão automática · £${totalCost.toFixed(1)}m de £100.0m`}
          title="Equipa Sugerida para o Deadline"
        >
          <p className="text-sm text-text-muted mb-4">
            Heurística v1 (preço, posse, calendário) respeitando £100m, 2-5-5-3
            e máx. 3 por clube — não é ainda um otimizador ótimo (ver
            roadmap). Capitão sugerido:{" "}
            <strong className="text-text">{captain?.element.web_name}</strong>{" "}
            · Vice: <strong className="text-text">{viceCaptain?.element.web_name}</strong>
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2">
                Onze Inicial
              </h3>
              <PlayerTable players={starters} />
            </div>
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2">
                Banco
              </h3>
              <PlayerTable players={bench} />
            </div>
          </div>
        </Section>

        <Section id="fixtures" title="Calendário — Próximas 5 Jornadas" eyebrow="Fixture Ticker">
          <FixtureTicker teams={bootstrap.teams} ticker={ticker} />
        </Section>

        <Section id="picks" title="Melhores Escolhas por Posição" eyebrow="Top Picks">
          <div className="grid md:grid-cols-2 gap-6">
            {[
              [1, "Guarda-Redes"],
              [2, "Defesas"],
              [3, "Médios"],
              [4, "Avançados"],
            ].map(([id, label]) => (
              <div key={id}>
                <h3 className="font-display text-lg tracking-wide mb-2">
                  {label}
                </h3>
                <PlayerTable players={byPos(id as number)} showReasons />
              </div>
            ))}
          </div>
        </Section>

        <Section id="differentials" title="Diferenciais (< 10% de posse)" eyebrow="Value Finder">
          <PlayerTable players={differentials} showReasons />
        </Section>

        <Section id="playbook" title="Playbook de Estratégia" eyebrow="O que separa os melhores gestores">
          <div className="grid md:grid-cols-2 gap-5">
            {PLAYBOOK.map((p) => (
              <div key={p.title} className="rounded-lg bg-surface-2 border border-border p-4">
                <h3 className="font-display text-base tracking-wide mb-1.5">
                  {p.title}
                </h3>
                <p className="text-sm text-text-muted leading-relaxed">{p.body}</p>
                <p className="text-[11px] text-text-muted mt-2 opacity-70">
                  Fonte: {p.source}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="rules" title="Regras & Cheat Sheet 2026/27" eyebrow="Referência Rápida">
          <div className="grid md:grid-cols-3 gap-6">
            {RULES_2026_27.map((group) => (
              <div key={group.section}>
                <h3 className="font-display text-lg tracking-wide mb-2">
                  {group.section}
                </h3>
                <dl className="text-sm flex flex-col gap-2">
                  {group.facts.map((f) => (
                    <div key={f.label} className="flex justify-between gap-3 border-b border-border pb-1.5">
                      <dt className="text-text-muted">{f.label}</dt>
                      <dd className="text-right font-medium">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Section>

        <Section id="roadmap" title="Estado do Projeto" eyebrow="Roadmap">
          <div className="grid md:grid-cols-2 gap-6 text-sm">
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2 text-accent">
                Já funciona
              </h3>
              <ul className="flex flex-col gap-1.5 text-text-muted">
                <li>✓ Dados reais e ao vivo da API oficial da FPL (via backend, sem CORS)</li>
                <li>✓ Fixture ticker com dificuldade oficial, 5 jornadas à frente</li>
                <li>✓ Sugestão de equipa e capitão dentro do orçamento e regras</li>
                <li>✓ Diferenciais e melhores escolhas por posição</li>
                <li>✓ Playbook e cheat sheet de regras 2026/27</li>
              </ul>
            </div>
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2 text-gold">
                A caminho
              </h3>
              <ul className="flex flex-col gap-1.5 text-text-muted">
                <li>→ A Minha Equipa (ligar o teu Team ID real)</li>
                <li>→ As Minhas Ligas (comparação com rivais)</li>
                <li>→ Shadow Team — sandbox para testar transferências antes de aplicar</li>
                <li>→ Login FPL + execução automática de transferências (autopilot com trilhos de segurança)</li>
                <li>→ Otimizador real (programação linear) em vez da heurística gananciosa</li>
                <li>→ Preditor de mudanças de preço e monitor de notícias/lesões</li>
              </ul>
            </div>
          </div>
        </Section>
      </main>

      <footer className="mx-auto max-w-6xl px-4 md:px-6 py-8 text-xs text-text-muted">
        Dados da API pública e não-oficial da Fantasy Premier League. Não
        afiliado à Premier League ou à FPL.
      </footer>
    </div>
  );
}
