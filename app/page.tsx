import { getBootstrap, getFixtures, getLeagueStandings } from "@/lib/fpl-client";
import { buildFixtureTicker } from "@/lib/fdr";
import {
  buildScoredPlayers,
  pickCaptain,
  findDifferentials,
} from "@/lib/recommend";
import { buildOptimalSquad } from "@/lib/optimizer";
import { buildPriceWatch, buildNewsWatch } from "@/lib/pricewatch";
import { PLAYBOOK, RULES_2026_27 } from "@/lib/strategy";
import { DEFAULT_TEAM_ID, DEFAULT_LEAGUE_ID } from "@/lib/constants";
import CountdownTimer from "@/components/CountdownTimer";
import FixtureTicker from "@/components/FixtureTicker";
import PlayerTable from "@/components/PlayerTable";
import MyTeamPanel from "@/components/MyTeamPanel";
import ShadowTeamPanel from "@/components/ShadowTeamPanel";

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
  const { squad, starters, totalCost, method: squadMethod } = buildOptimalSquad(scored, 100);
  const { captain, viceCaptain } = pickCaptain(starters);
  const differentials = findDifferentials(scored, 10, 8);
  const { risers, fallers } = buildPriceWatch(bootstrap, 8);
  const newsWatch = buildNewsWatch(bootstrap, 15);

  const byPos = (id: number, n = 8) =>
    scored.filter((p) => p.element.element_type === id).slice(0, n);

  const isPreseason = scored[0]?.isPreseason ?? true;
  const bench = squad.filter((p) => !starters.includes(p));

  // League standings are optional — the endpoint can fail (a league that
  // genuinely does need an authenticated session) or simply have no
  // results yet before the season's first gameweek is scored, so this is
  // fetched separately and degrades to a friendly message rather than
  // taking the whole page down.
  let leagueName: string | null = null;
  let leagueResults: {
    id: number;
    entry: number;
    entry_name: string;
    player_name: string;
    rank: number;
    total: number;
  }[] = [];
  let leagueError: string | null = null;
  try {
    const league = await getLeagueStandings(DEFAULT_LEAGUE_ID);
    leagueName = league.league.name;
    leagueResults = league.standings.results;
  } catch {
    leagueError =
      "Não foi possível carregar esta liga — se for uma liga privada pode precisar de sessão autenticada.";
  }
  const myTeamIdNum = Number(DEFAULT_TEAM_ID);

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
            ["my-team", "A Minha Equipa"],
            ["my-league", "A Minha Liga"],
            ["shadow-team", "Shadow Team"],
            ["squad", "Equipa Sugerida"],
            ["fixtures", "Calendário"],
            ["picks", "Melhores Escolhas"],
            ["differentials", "Diferenciais"],
            ["price-watch", "Preços"],
            ["news-watch", "Notícias/Lesões"],
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

        <Section id="my-team" title="A Minha Equipa" eyebrow="Ligado ao teu Team ID">
          <MyTeamPanel scored={scored} eventId={fromEvent} />
        </Section>

        <Section
          id="my-league"
          title={leagueName ?? "A Minha Liga"}
          eyebrow={`Liga privada #${DEFAULT_LEAGUE_ID}`}
        >
          {leagueError && <p className="text-sm text-danger">{leagueError}</p>}
          {!leagueError && leagueResults.length === 0 && (
            <p className="text-sm text-text-muted">
              Ainda sem classificação nesta liga — a FPL só calcula rankings
              depois da primeira jornada fechar. Fica aqui como referência
              até lá.
            </p>
          )}
          {leagueResults.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[480px]">
                <thead>
                  <tr className="text-left text-text-muted uppercase text-xs tracking-wide">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Gestor</th>
                    <th className="py-2 pr-3 font-medium">Equipa</th>
                    <th className="py-2 font-medium text-right">Pontos</th>
                  </tr>
                </thead>
                <tbody>
                  {leagueResults.slice(0, 20).map((r) => (
                    <tr
                      key={r.id}
                      className={`border-t border-border ${
                        r.entry === myTeamIdNum
                          ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]"
                          : ""
                      }`}
                    >
                      <td className="py-2 pr-3 font-mono tabular">{r.rank}</td>
                      <td className="py-2 pr-3">{r.player_name}</td>
                      <td className="py-2 pr-3 text-text-muted">
                        {r.entry_name}
                        {r.entry === myTeamIdNum && (
                          <span className="ml-2 rounded bg-accent text-accent-contrast px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                            tu
                          </span>
                        )}
                      </td>
                      <td className="py-2 font-mono tabular text-right font-semibold">
                        {r.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section
          id="shadow-team"
          title="Shadow Team"
          eyebrow="Sandbox — testa antes de aplicar a sério"
        >
          <ShadowTeamPanel scored={scored} suggestedElementIds={squad.map((p) => p.element.id)} />
        </Section>

        <Section
          id="squad"
          eyebrow={`Sugestão automática (${squadMethod}) · £${totalCost.toFixed(1)}m de £100.0m`}
          title="Equipa Sugerida para o Deadline"
        >
          <p className="text-sm text-text-muted mb-4">
            {squadMethod === "otimizador"
              ? "Equipa matematicamente ótima (programação linear) para a pontuação heurística v1 abaixo — respeita £100m, 2-5-5-3 e máx. 3 por clube. A qualidade da escolha ainda depende da pontuação de cada jogador (ver Playbook/roadmap para os próximos refinamentos dessa pontuação)."
              : "O otimizador não conseguiu resolver desta vez, por isso esta é a heurística de recurso (preço, posse, calendário) respeitando £100m, 2-5-5-3 e máx. 3 por clube."}{" "}
            Capitão sugerido:{" "}
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

        <Section
          id="price-watch"
          title="Preditor de Mudanças de Preço"
          eyebrow="Estimativa — não é oficial nem garantida"
        >
          <p className="text-sm text-text-muted mb-4">
            A FPL não publica o algoritmo real de mudança de preços. Isto é
            uma estimativa a partir das transferências líquidas de hoje
            relativas à posse atual de cada jogador (a mesma lógica que
            trackers da comunidade usam) — útil para decidires se vale a
            pena antecipar uma transferência hoje, não uma garantia.
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2 text-success">
                Prováveis subidas
              </h3>
              {risers.length === 0 ? (
                <p className="text-sm text-text-muted">Sem sinal forte de subida agora.</p>
              ) : (
                <div className="rounded-lg border border-border divide-y divide-border">
                  {risers.map((r) => (
                    <div key={r.element.id} className="flex items-center justify-between gap-2 py-1.5 px-2 text-sm">
                      <span>
                        {r.element.web_name}{" "}
                        <span className="text-text-muted text-xs">({r.team.short_name})</span>
                      </span>
                      <span className="flex items-center gap-3 font-mono tabular text-xs text-text-muted">
                        <span>£{r.priceM.toFixed(1)}m</span>
                        <span className="text-success font-semibold">
                          +{r.netTransfers.toLocaleString("pt-PT")}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2 text-danger">
                Prováveis descidas
              </h3>
              {fallers.length === 0 ? (
                <p className="text-sm text-text-muted">Sem sinal forte de descida agora.</p>
              ) : (
                <div className="rounded-lg border border-border divide-y divide-border">
                  {fallers.map((r) => (
                    <div key={r.element.id} className="flex items-center justify-between gap-2 py-1.5 px-2 text-sm">
                      <span>
                        {r.element.web_name}{" "}
                        <span className="text-text-muted text-xs">({r.team.short_name})</span>
                      </span>
                      <span className="flex items-center gap-3 font-mono tabular text-xs text-text-muted">
                        <span>£{r.priceM.toFixed(1)}m</span>
                        <span className="text-danger font-semibold">
                          {r.netTransfers.toLocaleString("pt-PT")}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Section>

        <Section
          id="news-watch"
          title="Monitor de Notícias e Lesões"
          eyebrow="Direto da FPL"
        >
          {newsWatch.length === 0 ? (
            <p className="text-sm text-text-muted">
              Sem notas de lesão/dúvida/suspensão ativas neste momento.
            </p>
          ) : (
            <div className="rounded-lg border border-border divide-y divide-border">
              {newsWatch.map((n) => (
                <div key={n.element.id} className="flex items-center justify-between gap-3 py-2 px-3 text-sm">
                  <div>
                    <span className="font-medium">{n.element.web_name}</span>{" "}
                    <span className="text-text-muted text-xs">
                      ({n.team.short_name} · {n.ownershipPct.toFixed(1)}% posse)
                    </span>
                    {n.isRecent && (
                      <span className="ml-2 rounded bg-[color-mix(in_srgb,var(--warn)_20%,var(--surface))] text-warn border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                        recente
                      </span>
                    )}
                    <p className="text-text-muted text-xs mt-0.5">{n.news}</p>
                  </div>
                  <span className="font-mono tabular text-xs text-text-muted whitespace-nowrap">
                    {n.chanceOfPlaying === null ? "—" : `${n.chanceOfPlaying}% jogo`}
                  </span>
                </div>
              ))}
            </div>
          )}
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
                <li>✓ A Minha Equipa (Team ID real ligado)</li>
                <li>✓ A Minha Liga (classificação, quando a FPL a publicar)</li>
                <li>✓ Shadow Team — sandbox para testar transferências antes de aplicar, sincronizada entre dispositivos quando o Upstash Redis estiver ligado</li>
                <li>✓ Otimizador real (programação linear) — equipa sugerida matematicamente ótima, não só uma heurística gananciosa</li>
                <li>✓ Preditor de mudanças de preço e monitor de notícias/lesões</li>
              </ul>
            </div>
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2 text-gold">
                A caminho
              </h3>
              <ul className="flex flex-col gap-1.5 text-text-muted">
                <li>→ Login FPL + execução automática de transferências (autopilot com trilhos de segurança) — o desenho de segurança fica combinado antes de mexer em credenciais reais</li>
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
