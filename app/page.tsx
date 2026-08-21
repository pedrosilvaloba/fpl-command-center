import { getBootstrap, getFixtures, getLeagueStandings } from "@/lib/fpl-client";
import {
  buildScoredPlayers,
  pickCaptain,
  findDifferentials,
} from "@/lib/recommend";
import {
  buildFixtureExpectations,
  buildModelTicker,
  teamStrengthsUsable,
} from "@/lib/matchmodel";
import { computeDynamicTeamFactors } from "@/lib/teamrating";
import { buildOptimalSquad } from "@/lib/optimizer";
import { buildPriceWatch, buildNewsWatch } from "@/lib/pricewatch";
import { getOddsStatus } from "@/lib/oddsapi";
import { findScheduleAnomalies } from "@/lib/schedule";
import {
  snapshotIfMissing,
  recordOutcomesForFinishedEvents,
  getAccuracyHistory,
} from "@/lib/accuracy";
import { loadActiveInsights, getLastResearchRun } from "@/lib/managerinsights";
import { isStorageConfigured } from "@/lib/kv";
import { computeSquadRisk } from "@/lib/correlation";
import { computeSquadRankProfile } from "@/lib/rankvalue";
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
  const [bootstrap, fixtures, oddsResult] = await Promise.all([
    getBootstrap(),
    // Full season (past + future), not just upcoming — the dynamic team-
    // rating model (lib/teamrating.ts) needs finished fixtures' actual
    // scores, and the individual-reliability model (lib/playerthreat.ts)
    // needs a count of each team's finished fixtures so far. Every
    // existing consumer of `fixtures` already filters by event range, so
    // including past ones is safe.
    getFixtures(),
    // Optional enrichment — returns null when ODDS_API_KEY isn't
    // configured, or if the request fails for any reason. Included in
    // this Promise.all because getOddsImpliedProbabilities never
    // rejects (see lib/oddsapi.ts), so it can't take the whole page
    // down; it only ever resolves to real data or null.
    getOddsStatus(),
  ]);

  // Static (hand-curated) + dynamic (weekly-research, Redis-backed)
  // qualitative adjustments — see lib/managerinsights.ts. Needs `bootstrap`
  // because the hand-curated entries identify players BY NAME and are
  // resolved against live FPL data, so a name that no longer matches a real
  // player is dropped instead of landing on somebody else.
  const activeInsights = await loadActiveInsights(bootstrap);

  const nextEvent =
    bootstrap.events.find((e) => e.is_next) ??
    bootstrap.events.find((e) => e.is_current) ??
    bootstrap.events[0];
  const fromEvent = nextEvent?.id ?? 1;
  // FPL only serves /entry/{id}/event/{gw}/picks/ for a gameweek whose
  // deadline has already passed — a squad for the UPCOMING gameweek lives
  // behind an authenticated endpoint this app deliberately does not use.
  // `fromEvent` is `is_next` (correct for recommendations), so passing it
  // to the picks fetch asked for the one gameweek FPL will not return, all
  // week, every week. These are two different questions and now use two
  // different variables.
  const oddsMatches = oddsResult.status === "ok" ? oddsResult.matches : null;
  const oddsProblem = oddsResult.status === "ok" ? null : oddsResult.message;
  // Persistent storage gates three features at once (see lib/kv.ts). When
  // it is missing they all degrade silently, which is exactly how the
  // tactical-research layer spent weeks looking functional while being
  // structurally unable to save anything.
  const storageConfigured = isStorageConfigured();
  // When the weekly research last ran, and what it did. Without this the
  // only observable state was "no notes", which is equally consistent with
  // "found nothing" and "never ran" — and the notification channel that was
  // supposed to tell us apart proved unreliable.
  const lastResearchRun = await getLastResearchRun();

  const currentEventForPicks = bootstrap.events.find((e) => e.is_current);
  const picksEvent = currentEventForPicks?.id ?? Math.max(1, fromEvent - 1);

  // The Calendário panel used to show FPL's own crude 1-5 difficulty
  // digit — recomputed here (cheaply — a season is a few hundred
  // fixtures) straight from the same real model (Poisson + this
  // season's own results + market odds) that actually drives scoring,
  // so what a manager sees when checking "who has good fixtures" matches
  // what the recommendations are actually built on. See lib/matchmodel.ts.
  const teamFactorsForDisplay = computeDynamicTeamFactors(bootstrap.teams, fixtures);
  const expectationsByTeamForDisplay = buildFixtureExpectations(
    bootstrap.teams,
    fixtures,
    oddsMatches,
    teamFactorsForDisplay
  );
  const ticker = buildModelTicker(bootstrap.teams, expectationsByTeamForDisplay, fromEvent, 5);
  // Which data source actually drove each team's upcoming fixtures — so
  // the page can show what the numbers rest on instead of presenting a
  // neutral placeholder as if it were a real forecast.
  const sourceCounts = new Map<string, number>();
  for (const rows of Object.values(ticker)) {
    for (const r of rows) sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
  }
  // FPL sometimes leaves its team strength ratings at zero (confirmed live
  // on the 2026/27 GW1 deadline day). The model falls back to neutral
  // league-average teams in that case, which is the honest thing to do —
  // but the numbers are then identical for everyone and must be labelled
  // as a placeholder rather than shown as a real per-fixture forecast.
  const strengthsUsable = teamStrengthsUsable(bootstrap.teams);
  const scored = buildScoredPlayers(bootstrap, fixtures, fromEvent, 5, oddsMatches, activeInsights);
  const oddsActive = oddsResult.status === "ok";
  const { squad, starters, totalCost, method: squadMethod } = buildOptimalSquad(scored, 100);
  const { captain, viceCaptain } = pickCaptain(starters);
  // Concentration risk: FPL points are correlated within a club (a clean
  // sheet is ONE event shared by every defender), so two squads with equal
  // expected points can carry very different variance. See lib/correlation.ts.
  const squadRisk = computeSquadRisk(starters);
  // Rank-relative view: FPL is a rank game, so points your rivals also
  // banked do not move you up. See lib/rankvalue.ts.
  const rankProfile = computeSquadRankProfile(starters, scored);
  const differentials = findDifferentials(scored, 10, 8);
  const { risers, fallers } = buildPriceWatch(bootstrap, 8);
  const newsWatch = buildNewsWatch(bootstrap, 15);

  // Model accuracy tracker (optional — requires the same Upstash Redis
  // integration as the Shadow Team sync, see lib/accuracy.ts). Snapshots
  // this visit's top picks for whichever gameweek's deadline hasn't
  // passed yet (guaranteeing no fixture in it has kicked off), and
  // records real outcomes for any gameweek that has since finished.
  // Both are no-ops without Redis configured, and never throw — a
  // tracking failure here must never take the page down.
  // This is a force-dynamic Server Component (see the `dynamic` export
  // above): reading the wall clock fresh on every request is the
  // intended behaviour, not a violation of the memoization assumptions
  // this rule protects against in client components/hooks.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const upcomingEvent = bootstrap.events.find(
    (e) => !e.finished && new Date(e.deadline_time).getTime() > nowMs
  );
  const finishedEventIds = bootstrap.events.filter((e) => e.finished).map((e) => e.id);
  await Promise.all([
    upcomingEvent ? snapshotIfMissing(scored, upcomingEvent.id) : Promise.resolve(),
    recordOutcomesForFinishedEvents(finishedEventIds),
  ]);
  const accuracyHistory = await getAccuracyHistory();

  // Chip-timing horizon: further out than the 5-week scoring window,
  // since Bench Boost/Triple Captain/Free Hit planning benefits from
  // seeing what's coming before it's actually time to act on it. Capped
  // at gameweek 38 (the season's last).
  const scheduleHorizon = Math.min(fromEvent + 14, 38);
  const scheduleAnomalies = findScheduleAnomalies(
    bootstrap.teams,
    fixtures,
    fromEvent,
    scheduleHorizon
  );
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const anomaliesByEvent = new Map<number, { doubles: string[]; blanks: string[] }>();
  for (const a of scheduleAnomalies) {
    const team = teamById.get(a.teamId);
    if (!team) continue;
    if (!anomaliesByEvent.has(a.event)) {
      anomaliesByEvent.set(a.event, { doubles: [], blanks: [] });
    }
    const bucket = anomaliesByEvent.get(a.event)!;
    (a.type === "double" ? bucket.doubles : bucket.blanks).push(team.short_name);
  }
  const scheduleEvents = Array.from(anomaliesByEvent.keys()).sort((a, b) => a - b);

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
            ["schedule-anomalies", "Duplas & Brancas"],
            ["picks", "Melhores Escolhas"],
            ["differentials", "Diferenciais"],
            ["price-watch", "Preços"],
            ["news-watch", "Notícias/Lesões"],
            ["model-accuracy", "Precisão do Modelo"],
            ["insights", "Notas Táticas"],
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
        {oddsProblem && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--danger)_45%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] px-4 py-3 text-sm text-danger">
            <strong className="block mb-1">
              As odds de mercado não estão a ser usadas.
            </strong>
            {oddsProblem}{" "}
            As odds são a fonte mais forte que esta app tem para avaliar
            dificuldade de calendário — bastante melhor do que os ratings da
            própria FPL, que são grosseiros e por vezes vêm a zero. Sem elas,
            a Equipa Sugerida apoia-se numa leitura de calendário muito mais
            fraca. Ver &quot;Deploy&quot; no README.
          </div>
        )}

        {!storageConfigured && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--danger)_45%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] px-4 py-3 text-sm text-danger">
            <strong className="block mb-1">
              O armazenamento persistente não está ligado.
            </strong>
            A integração Upstash Redis não está configurada neste projeto da
            Vercel. Sem ela três coisas não funcionam, e nenhuma delas o
            diria por si: a Shadow Team fica guardada só neste browser, o
            Painel de Precisão do Modelo não regista nada, e a{" "}
            <strong>investigação semanal não consegue gravar as notas
            táticas</strong> — faz a pesquisa toda e falha na gravação. Ver
            &quot;Deploy&quot; no README.
          </div>
        )}

        {sourceCounts.get("neutral") ? (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--danger)_45%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] px-4 py-3 text-sm text-danger">
            <strong className="block mb-1">
              O modelo de calendário está sem dados.
            </strong>
            {sourceCounts.get("neutral")} jogos das próximas jornadas não têm
            odds, nem resultados desta época, nem ratings utilizáveis da FPL —
            estão a ser tratados como jogos entre equipas médias. Os números
            de ataque/defesa desses jogos não distinguem adversários e não
            devem ser usados para decidir.
          </div>
        ) : null}

        {isPreseason && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] px-4 py-3 text-sm text-warn">
            Época ainda não começou (ou está entre jornadas) — os dados de
            forma/pontos ainda não existem, por isso as pontuações abaixo
            apoiam-se na estimativa da própria FPL e no calendário. Assim que
            houver jogos concluídos, o motor passa a usar o seu próprio modelo
            de pontos esperados automaticamente.
          </div>
        )}

        <Section id="my-team" title="A Minha Equipa" eyebrow="Ligado ao teu Team ID">
          <MyTeamPanel scored={scored} eventId={picksEvent} isPreseason={isPreseason} />
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
          <p className="text-xs text-text-muted opacity-70 mb-4">
            {oddsActive
              ? "Pontuação enriquecida com odds de mercado (ver \"ajustado com odds de mercado\" nas Melhores Escolhas)."
              : "A correr só com o modelo estatístico — liga a ODDS_API_KEY na Vercel para incluir odds de mercado (ver README)."}
          </p>
          <div className="mb-5 rounded-lg border border-border bg-surface-2 p-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mb-2">
              <span className="text-xs uppercase tracking-widest text-text-muted">
                Risco de concentração
              </span>
              <span className="text-sm">
                Pontos esperados na próxima jornada:{" "}
                <strong className="font-mono tabular">{squadRisk.expectedPoints}</strong>
              </span>
              <span className="text-sm">
                Desvio-padrão:{" "}
                <strong className="font-mono tabular">±{squadRisk.stdDev}</strong>
              </span>
              <span className="text-sm">
                Concentração defensiva:{" "}
                <strong
                  className={`font-mono tabular ${
                    squadRisk.defensiveConcentrationRatio >= 1.7
                      ? "text-danger"
                      : squadRisk.defensiveConcentrationRatio >= 1.3
                        ? "text-warn"
                        : "text-success"
                  }`}
                >
                  {squadRisk.defensiveConcentrationRatio.toFixed(2)}×
                </strong>
              </span>
              <span className="text-sm">
                Global:{" "}
                <strong
                  className={`font-mono tabular ${
                    squadRisk.concentrationRatio >= 1.35
                      ? "text-danger"
                      : squadRisk.concentrationRatio >= 1.15
                        ? "text-warn"
                        : "text-success"
                  }`}
                >
                  {squadRisk.concentrationRatio.toFixed(2)}×
                </strong>
              </span>
            </div>
            {squadRisk.warnings.length > 0 ? (
              <ul className="text-sm text-warn list-disc pl-5 space-y-1 mb-2">
                {squadRisk.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-text-muted">
              Os pontos da FPL não são independentes dentro do mesmo clube: um
              clean sheet é <strong>um único acontecimento</strong> partilhado
              por todos os teus defesas desse clube. Empilhar não muda os
              pontos esperados — multiplica a variância. Não é um erro: se
              estás atrás na tua liga, queres precisamente isso; se estás à
              frente, queres o contrário. &quot;Concentração&quot; compara
              este onze com os mesmos jogadores espalhados por clubes
              diferentes — 1.00× é totalmente diversificado.
            </p>
          </div>

          <div className="mb-5 rounded-lg border border-border bg-surface-2 p-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mb-2">
              <span className="text-xs uppercase tracking-widest text-text-muted">
                Valor de ranking
              </span>
              <span className="text-sm">
                Pontos esperados:{" "}
                <strong className="font-mono tabular">{rankProfile.totalExpectedPoints}</strong>
              </span>
              <span className="text-sm">
                Ganho esperado sobre o rival médio:{" "}
                <strong className="font-mono tabular text-accent">
                  {rankProfile.totalRankValue}
                </strong>
              </span>
              <span className="text-sm">
                Posse média do onze:{" "}
                <strong className="font-mono tabular">{rankProfile.weightedOwnership}%</strong>
              </span>
            </div>
            <p className="text-sm text-text-muted mb-2">{rankProfile.verdict}</p>
            {rankProfile.missingTemplate.length > 0 && (
              <p className="text-sm text-warn mb-2">
                <strong>Template que não tens:</strong>{" "}
                {rankProfile.missingTemplate
                  .map(
                    (m) =>
                      `${m.player.element.web_name} (${Math.round(m.player.ownershipPct)}%)`
                  )
                  .join(" · ")}
                . Se estes pontuarem, o pelotão ganha-te terreno e não tens nada
                que compense.
              </p>
            )}
            <p className="text-xs text-text-muted">
              A FPL é um jogo de <strong>ranking</strong>: pontos que os teus
              rivais também fizeram não te fazem subir. Um jogador com 65% de
              posse é quase neutro — se pontua, quase toda a gente pontua
              contigo. O &quot;ganho sobre o rival médio&quot; desconta a
              parte dos pontos que o pelotão já leva por também o ter. Não
              substitui os pontos esperados: são duas perguntas diferentes, e
              qual delas pesa mais depende de estares à frente ou atrás na tua
              liga.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2">
                Onze Inicial
              </h3>
              <PlayerTable players={starters} showReasons />
            </div>
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2">
                Banco
              </h3>
              <PlayerTable players={bench} showReasons />
            </div>
          </div>
        </Section>

        <Section
          id="fixtures"
          title="Calendário — Próximas 5 Jornadas"
          eyebrow="Modelo próprio, não o dígito 1-5 da FPL"
        >
          <FixtureTicker
            teams={bootstrap.teams}
            ticker={ticker}
            oddsActive={oddsActive}
            strengthsUsable={strengthsUsable}
          />
        </Section>

        <Section
          id="schedule-anomalies"
          title="Jornadas Duplas e Brancas"
          eyebrow={`Próximas ${scheduleHorizon - fromEvent + 1} jornadas · timing de chips`}
        >
          {scheduleEvents.length === 0 ? (
            <p className="text-sm text-text-muted">
              Nenhuma jornada dupla ou em branco confirmada ainda nas próximas
              jornadas. É normal no início da época — reagendamentos de taças
              e competições europeias só costumam ser confirmados algumas
              semanas antes; esta secção preenche-se sozinha assim que a FPL
              atualizar o calendário.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {scheduleEvents.map((event) => {
                const bucket = anomaliesByEvent.get(event)!;
                return (
                  <div
                    key={event}
                    className="rounded-lg border border-border px-3 py-2 text-sm flex flex-wrap items-center gap-x-4 gap-y-1"
                  >
                    <span className="font-display tracking-wide">GW{event}</span>
                    {bucket.doubles.length > 0 && (
                      <span className="text-success">
                        Dupla: {bucket.doubles.join(", ")}
                      </span>
                    )}
                    {bucket.blanks.length > 0 && (
                      <span className="text-danger">
                        Branca: {bucket.blanks.join(", ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-text-muted opacity-70 mt-3">
            Duplas são o momento clássico para Bench Boost/Triple Captain;
            brancas são o motivo mais comum para usar o Free Hit. Ver Playbook
            para o racional completo.
          </p>
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

        <Section
          id="model-accuracy"
          title="Precisão do Modelo"
          eyebrow="Previsto vs. real, jornada a jornada"
        >
          {!accuracyHistory.configured ? (
            <p className="text-sm text-text-muted">
              Este painel compara o que o motor de pontuação previu com o
              que realmente aconteceu, jornada a jornada — a única forma
              séria de saber se as mudanças ao modelo estão mesmo a
              ajudar, em vez de confiar apenas na intuição. Precisa da
              mesma integração Upstash Redis opcional do Shadow Team (ver
              README) para guardar as previsões antes de cada jornada.
            </p>
          ) : accuracyHistory.results.length === 0 ? (
            <p className="text-sm text-text-muted">
              Ainda sem jornadas comparadas. Isto só consegue começar a
              medir a partir de agora — não há forma fiável de reconstruir
              o que o modelo teria previsto antes de jornadas já
              passadas. Volta aqui depois da próxima jornada terminar.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[480px]">
                <thead>
                  <tr className="text-left text-text-muted uppercase text-xs tracking-wide">
                    <th className="py-2 pr-3 font-medium">Jornada</th>
                    <th className="py-2 pr-3 font-medium text-right">
                      Média — metade top do modelo
                    </th>
                    <th className="py-2 pr-3 font-medium text-right">
                      Média — resto
                    </th>
                    <th className="py-2 font-medium text-right">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  {accuracyHistory.results.map((r) => (
                    <tr key={r.event} className="border-t border-border">
                      <td className="py-2 pr-3">GW{r.event}</td>
                      <td className="py-2 pr-3 text-right font-mono tabular">
                        {r.topAvgPoints.toFixed(1)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular">
                        {r.restAvgPoints.toFixed(1)}
                      </td>
                      <td
                        className={`py-2 text-right font-mono tabular font-semibold ${
                          r.lift >= 0 ? "text-success" : "text-danger"
                        }`}
                      >
                        {r.lift >= 0 ? "+" : ""}
                        {r.lift.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-text-muted opacity-70 mt-3">
                &quot;Metade top do modelo&quot; = os jogadores com melhor
                pontuação do motor entre os candidatos guardados antes da
                jornada, por posição; &quot;resto&quot; = os restantes
                candidatos guardados nessa altura. Uma diferença positiva
                e consistente ao longo da época é o sinal de que o motor
                está mesmo a distinguir quem vai pontuar mais — não uma
                garantia jornada a jornada.
              </p>
            </div>
          )}
        </Section>

        <Section
          id="insights"
          title="Notas Táticas Ativas"
          eyebrow="Camada qualitativa — padrões de gestão e identidade de equipa"
        >
          {!storageConfigured ? (
            <p className="text-sm text-danger">
              Esta secção não pode funcionar sem a integração Upstash Redis,
              que não está ligada neste projeto. Não é que a investigação
              não tenha encontrado nada — é que não existe onde guardar o
              que ela encontrar. Liga o Redis (ver &quot;Deploy&quot; no
              README) e a investigação semanal passa a poder escrever aqui.
            </p>
          ) : activeInsights.length === 0 ? (
            <p className="text-sm text-text-muted">
              {lastResearchRun ? (
                <>
                  <strong className="text-text">
                    Nenhuma nota ativa. A investigação correu em{" "}
                    {new Date(lastResearchRun.at).toLocaleString("pt-PT", {
                      timeZone: "Europe/Lisbon",
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                    .
                  </strong>{" "}
                  {lastResearchRun.note ??
                    `${lastResearchRun.acceptedCount} aceites, ${lastResearchRun.rejectedCount} rejeitadas.`}{" "}
                  {lastResearchRun.rejectedReasons.length > 0 && (
                    <>Rejeitadas: {lastResearchRun.rejectedReasons.join(" · ")}.</>
                  )}{" "}
                </>
              ) : (
                <>
                  <strong className="text-text">
                    A investigação semanal ainda nunca registou uma execução
                    aqui.
                  </strong>{" "}
                  Se já devia ter corrido, é sinal de que falhou antes de
                  chegar a escrever — e não de que não encontrou nada.{" "}
                </>
              )}
              Nenhuma nota ativa neste momento. Esta secção mostra ajustes
              qualitativos que nenhum dado da FPL ou das odds consegue captar
              sozinho — por exemplo, um treinador que substitui sistematicamente
              um titular antes dos 60min, ou uma equipa com um estilo de jogo
              claramente identificável esta época. Alimentada por uma
              investigação semanal automática (pesquisa na web, com fontes) que
              aplica os achados diretamente aqui — com limites apertados
              (±20% no máximo por nota), validação contra os dados reais da
              FPL, e expiração automática ao fim de 2 semanas para que um
              padrão desatualizado não fique para sempre. Fica vazia até a
              primeira pesquisa produzir algo suficientemente sustentado por
              fontes.
            </p>
          ) : (
            <div className="overflow-x-auto">
              {lastResearchRun && (
                <p className="text-xs text-text-muted mb-3">
                  Última investigação:{" "}
                  {new Date(lastResearchRun.at).toLocaleString("pt-PT", {
                    timeZone: "Europe/Lisbon",
                    dateStyle: "short",
                    timeStyle: "short",
                  })}{" "}
                  · {lastResearchRun.acceptedCount} aceites ·{" "}
                  {lastResearchRun.rejectedCount} rejeitadas
                </p>
              )}
              <table className="w-full border-collapse text-sm min-w-[600px]">
                <thead>
                  <tr className="text-left text-text-muted uppercase text-xs tracking-wide">
                    <th className="py-2 pr-3 font-medium">Jogador/Equipa</th>
                    <th className="py-2 pr-3 font-medium text-right">Ajuste</th>
                    <th className="py-2 pr-3 font-medium">Razão</th>
                    <th className="py-2 pr-3 font-medium">Fonte</th>
                    <th className="py-2 font-medium">Validade</th>
                  </tr>
                </thead>
                <tbody>
                  {activeInsights.map((insight, i) => (
                    <tr key={`${insight.scope}-${insight.id}-${i}`} className="border-t border-border">
                      <td className="py-2 pr-3">{insight.label}</td>
                      <td
                        className={`py-2 pr-3 text-right font-mono tabular font-semibold ${
                          insight.factor >= 1 ? "text-success" : "text-danger"
                        }`}
                      >
                        {insight.factor >= 1 ? "+" : ""}
                        {Math.round((insight.factor - 1) * 100)}%
                      </td>
                      <td className="py-2 pr-3 text-text-muted">{insight.reason}</td>
                      <td className="py-2 pr-3 text-text-muted text-xs">{insight.source}</td>
                      <td className="py-2 text-xs text-text-muted">
                        {insight.expiresAt
                          ? `até ${new Date(insight.expiresAt).toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" })}`
                          : "permanente"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-text-muted opacity-70 mt-3">
                Notas com validade são geradas pela investigação semanal
                automática e já estão a ser aplicadas à pontuação — não
                dependem de aprovação manual. Continuam visíveis nas razões de
                cada jogador na Equipa Sugerida, como qualquer outro sinal do
                modelo. Ver lib/managerinsights.ts para os limites aplicados.
              </p>
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
                <li>✓ Modelo de golos esperados por equipa (Poisson), substituindo o dígito de calendário genérico</li>
                <li>✓ Odds de mercado como sinal de contexto (opcional — ver ODDS_API_KEY no README), para captar fatores não estatísticos e opinião especializada</li>
                <li>✓ Deteção de jornadas duplas/brancas e pontuação sensível ao calendário (uma dupla vale mais, não é diluída numa média)</li>
                <li>✓ Ameaça de golo/assistência individual (xG/xA e bolas paradas por jogador, não só a equipa) — cada jogador atacante deixou de herdar o mesmo número genérico da equipa</li>
                <li>✓ Fiabilidade de utilização (risco de rotação) a partir dos jogos como titular</li>
                <li>✓ Bónus de contribuição defensiva (regra 2025/26) finalmente usado na pontuação</li>
                <li>✓ Rating de equipa dinâmico, calibrado com os resultados reais desta época, a corrigir as classificações estáticas da FPL</li>
                <li>✓ Perfil de risco/recompensa (teto vs. chão) para diferenciar apostas seguras de apostas de variância alta</li>
                <li>✓ Painel de Precisão do Modelo — compara previsões com pontos reais, jornada a jornada (opcional, precisa de Redis)</li>
              </ul>
            </div>
            <div>
              <h3 className="font-display text-lg tracking-wide mb-2 text-gold">
                A caminho
              </h3>
              <ul className="flex flex-col gap-1.5 text-text-muted">
                <li>→ Simulação contra os rivais da Haal of Fame (Camada 2) — recomendações que visam ultrapassar/manter distância de rivais específicos, não só maximizar pontos em abstrato</li>
                <li>→ Aprendizagem entre estratégias via Shadow Team (Camada 3) — começa a fazer sentido a partir de jornadas reais jogadas</li>
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
