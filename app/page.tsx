import {
  getBootstrap,
  getFixtures,
  getFullLeagueStandings,
  getFplDataHealth,
} from "@/lib/fpl-client";
import {
  buildScoredPlayers,
  pickCaptain,
  findDifferentials,
  orderBench,
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
import {
  fetchRivalSquads,
  simulateLeague,
  applyLearningTilt,
  NEUTRAL_POSTURE,
} from "@/lib/rivals";
import type { LeagueOutlook } from "@/lib/rivals";
import {
  snapshotStrategies,
  settleStrategies,
  getLearningState,
  applyCalibration,
} from "@/lib/strategylearning";
import { loadSquadState, EMPTY_SQUAD_STATE } from "@/lib/squadstate";
import { planTransfers } from "@/lib/transferplan";
import { readCalendar, planChips } from "@/lib/chipplan";
import ChipPlanPanel from "@/components/ChipPlanPanel";
import AutomationPanel from "@/components/AutomationPanel";
import { getJobHealth, mergeResearchHealth } from "@/lib/joblog";
import { snapshotPredictions, reviewGameweek } from "@/lib/gwreview";
import { PLAYBOOK, RULES_2026_27 } from "@/lib/strategy";
import { DEFAULT_TEAM_ID, DEFAULT_LEAGUE_ID } from "@/lib/constants";
import CountdownTimer from "@/components/CountdownTimer";
import FixtureTicker from "@/components/FixtureTicker";
import PlayerTable from "@/components/PlayerTable";
import PitchView from "@/components/PitchView";
import MyTeamPanel from "@/components/MyTeamPanel";
import ShadowTeamPanel from "@/components/ShadowTeamPanel";
import LeagueSimPanel from "@/components/LeagueSimPanel";
import StrategyPanel from "@/components/StrategyPanel";
import TransferPlanPanel from "@/components/TransferPlanPanel";
import GameweekReviewPanel from "@/components/GameweekReviewPanel";

// Rendered per-request (not at build time): this sandbox's build
// environment has no route to the FPL API to prerender against, and in
// production we want every visit checking the Vercel Data Cache rather
// than serving a build-time snapshot. The underlying fetch() calls still
// cache for a few minutes each via their own `next: { revalidate }` option.
export const dynamic = "force-dynamic";

// This page now does noticeably more work per request than it did before
// Camada 2: up to two dozen rival-squad fetches, a Monte Carlo over the
// gameweek, and the integer-programming solve. All of it is cached by
// Next's Data Cache between requests, but the FIRST request after a cache
// expiry pays for all of it at once, and Vercel's default function timeout
// is short enough to cut that off midway. Asking for more headroom costs
// nothing on a request that finishes early.
export const maxDuration = 60;

/**
 * A PÁGINA TINHA ONZE SECÇÕES DE TOPO E NENHUMA HIERARQUIA.
 *
 * Estavam todas ao mesmo nível, numa lista plana, misturando três coisas
 * diferentes: o que fazer antes do deadline, como correu a semana passada, e
 * dados de consulta. A barra de navegação listava-as por uma ordem
 * DIFERENTE da página — "A Liga" antes de "Plantel Ideal" na barra, ao
 * contrário na página — o que é uma forma discreta de mentir sobre onde as
 * coisas estão.
 *
 * Agora há quatro camadas, e a barra é a página:
 *
 *   DECIDIR      o que fazer agora. É a razão de a app existir.
 *   PERCEBER     como correu e o que o modelo aprendeu.
 *   CONSULTAR    dados de apoio, para quando quiseres investigar.
 *   FERRAMENTAS  ligações e diagnóstico. Só interessa quando algo falha.
 *
 * A ordem desta lista é a ordem da página, por construção: um teste verifica
 * que as duas não podem divergir.
 */
const NAV: { tier: string; items: [string, string][] }[] = [
  { tier: "Decidir", items: [["fazer", "O Que Fazer"], ["shadow", "Shadow Team"]] },
  {
    tier: "Perceber",
    items: [["revisao", "Revisão"], ["aprendizagem", "Aprendizagem"], ["liga", "A Liga"]],
  },
  {
    tier: "Consultar",
    items: [
      ["ideal", "Plantel Ideal"],
      ["escolhas", "Escolhas"],
      ["calendario", "Calendário"],
      ["mercado", "Mercado"],
      ["referencia", "Referência"],
    ],
  },
  { tier: "Sistema", items: [["minha-equipa", "A Minha Equipa"], ["sistema", "Sistema"]] },
];

/** Achatada, na ordem em que as secções aparecem na página. */
export const NAV_ORDER: string[] = NAV.flatMap((g) => g.items.map(([id]) => id));

/** O separador entre camadas. Não é decoração: sem ele, onze secções ao mesmo
 * nível obrigam a ler tudo para descobrir o que é decisão e o que é consulta. */
function TierHeading({ label, note }: { label: string; note: string }) {
  return (
    <div className="mt-2 flex items-baseline gap-3 border-b border-border pb-1.5">
      <h2 className="eyebrow text-accent">{label}</h2>
      <p className="text-[13px] text-text-muted">{note}</p>
    </div>
  );
}

/**
 * AVISO DE DADOS ANTIGOS.
 *
 * A app passou a sobreviver a uma falha da API do FPL servindo a última
 * cópia boa em vez de morrer com um 500. Isso é uma melhoria — e seria uma
 * armadilha se fosse silenciosa. Preços, lesões e disponibilidade mudam de
 * hora a hora perto de um deadline, e uma transferência decidida sobre um
 * retrato de ontem pode ser pior do que não decidir nada.
 *
 * Por isso este aviso não é discreto, diz a hora exata do retrato, e diz o
 * que NÃO se deve fazer enquanto estiver lá.
 */
function StaleDataBanner({
  health,
}: {
  health: { degraded: boolean; oldestSnapshotAt: number | null };
}) {
  if (!health.degraded || health.oldestSnapshotAt === null) return null;
  const when = new Date(health.oldestSnapshotAt).toLocaleString("pt-PT", {
    timeZone: "Europe/Lisbon",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hours = Math.round((Date.now() - health.oldestSnapshotAt) / 3_600_000);
  return (
    <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-3">
      <p className="eyebrow text-warn">Dados desatualizados</p>
      <p className="mt-1 text-[14px] leading-relaxed text-text">
        A API do Fantasy não está a responder. Estás a ver a última cópia boa,
        de <strong>{when}</strong>
        {hours >= 1 ? ` (há ~${hours}h)` : ""}. Preços, lesões e notícias de
        equipa podem ter mudado desde então —{" "}
        <strong>não confirmes transferências com base neste ecrã</strong>.
        Recarrega daqui a uns minutos.
      </p>
    </div>
  );
}

function Section({
  id,
  title,
  eyebrow,
  intro,
  primary = false,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  intro?: React.ReactNode;
  /** The one section carrying the decision. Everything else is reference. */
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-2.5">
        {eyebrow && <p className="eyebrow mb-1 text-accent">{eyebrow}</p>}
        <h2 className="text-balance font-display text-xl font-bold tracking-tight text-text md:text-2xl">
          {title}
        </h2>
        {intro && (
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-text-muted">
            {intro}
          </p>
        )}
      </div>
      <div className={`${primary ? "card-primary" : "card"} p-4 md:p-5`}>{children}</div>
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 font-display text-base font-bold tracking-tight md:text-lg">
      {children}
    </h3>
  );
}

/** One inline label/value pair. Deliberately NOT a box: four bordered tiles
 * of internal model state were eating 150px at the top of every page load to
 * report things like a variance coefficient of 0.00. */
function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "accent" | "warn" | "danger";
}) {
  const color =
    tone === "accent"
      ? "var(--accent)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--text)";
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow text-text-muted">{label}</span>
      <strong className="font-display text-[15px] font-bold tracking-tight" style={{ color }}>
        {value}
      </strong>
    </span>
  );
}

/** A single-line alert with a coloured spine.
 *
 * The previous version was a full-width tinted paragraph, which gave "two
 * fixtures have no odds yet" the same visual weight as the squad itself.
 * That is how you train someone to stop reading warnings. */
function AlertStrip({
  tone,
  title,
  children,
}: {
  tone: "danger" | "warn" | "info";
  title: string;
  children: React.ReactNode;
}) {
  const color =
    tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--cyan)";
  return (
    <div
      className="alert-strip"
      style={{ ["--tone" as string]: color } as React.CSSProperties}
    >
      <span aria-hidden className="mt-[3px] shrink-0 font-bold" style={{ color }}>
        {tone === "info" ? "i" : "!"}
      </span>
      <span className="text-text-muted">
        <strong style={{ color }}>{title}</strong> {children}
      </span>
    </div>
  );
}

export default async function Home() {
  const [bootstrap, fixtures, oddsResult] = await Promise.all([
    getBootstrap(),
    // Full season (past + future), not just upcoming — the dynamic team-
    // rating model (lib/teamrating.ts) needs finished fixtures' actual
    // scores, and the individual-reliability model (lib/playerthreat.ts)
    // needs a count of each team's finished fixtures so far.
    getFixtures(),
    // Optional enrichment — never rejects (see lib/oddsapi.ts).
    getOddsStatus(),
  ]);

  const activeInsights = await loadActiveInsights(bootstrap);

  const nextEvent =
    bootstrap.events.find((e) => e.is_next) ??
    bootstrap.events.find((e) => e.is_current) ??
    bootstrap.events[0];
  const fromEvent = nextEvent?.id ?? 1;
  const oddsMatches = oddsResult.status === "ok" ? oddsResult.matches : null;
  const oddsProblem = oddsResult.status === "ok" ? null : oddsResult.message;
  const storageConfigured = isStorageConfigured();
  const lastResearchRun = await getLastResearchRun();
  // The research layer runs weekly. Anything past nine days means a run was
  // missed, not that the schedule is merely between passes.
  const researchAgeDays = lastResearchRun
    // eslint-disable-next-line react-hooks/purity
    ? Math.floor((Date.now() - new Date(lastResearchRun.at).getTime()) / 86_400_000)
    : null;
  const researchStale =
    storageConfigured && (researchAgeDays === null || researchAgeDays > 9);

  // Health of every unattended job, not just the research one. The backtest
  // and the calibration sweep now run on Vercel's own scheduler inside this
  // deployment (see app/api/cron/refresh), and both write to the run log
  // before they start — so a run killed by the function wall still leaves a
  // record saying it began and never finished, which is precisely the failure
  // that went unnoticed for six weeks.
  const jobHealth = mergeResearchHealth(
    await getJobHealth(),
    lastResearchRun
      ? {
          at: lastResearchRun.at,
          acceptedCount: lastResearchRun.acceptedCount,
          rejectedCount: lastResearchRun.rejectedCount,
        }
      : null
  );
  const brokenJobs = storageConfigured ? jobHealth.filter((j) => j.status === "parada") : [];
  // "Ran cleanly and produced nothing" gets its own alarm. It is the state
  // that hides: the research pass reported OK with zero notes accepted AND
  // zero rejected — nothing was ever submitted to be judged — and the card
  // was green. Not a failure, not health either.
  const emptyJobs = storageConfigured ? jobHealth.filter((j) => j.status === "vazia") : [];

  const currentEventForPicks = bootstrap.events.find((e) => e.is_current);
  const picksEvent = currentEventForPicks?.id ?? Math.max(1, fromEvent - 1);
  // (see lastPublishedEvent below — MyTeamPanel keeps its own client-side
  // fetch and its own gameweek choice, unchanged.)

  const teamFactorsForDisplay = computeDynamicTeamFactors(bootstrap.teams, fixtures);
  const expectationsByTeamForDisplay = buildFixtureExpectations(
    bootstrap.teams,
    fixtures,
    oddsMatches,
    teamFactorsForDisplay
  );
  const ticker = buildModelTicker(
    bootstrap.teams,
    expectationsByTeamForDisplay,
    fromEvent,
    5
  );
  const sourceCounts = new Map<string, number>();
  // Separated on purpose. A fixture with no usable data in the NEXT gameweek
  // is a real problem — it is a match you are about to pick a team for. A
  // fixture four gameweeks out with no data is normal and self-correcting:
  // bookmakers only price matches a week or two ahead, and the results-based
  // team ratings need results that have not happened yet. Counting both into
  // one red alert made a routine early-season state look like a broken app,
  // which is exactly the kind of false alarm that teaches you to ignore the
  // real ones.
  let neutralNextEvent = 0;
  let neutralLater = 0;
  for (const rows of Object.values(ticker)) {
    for (const r of rows) {
      sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
      if (r.source === "neutral") {
        if (r.event === fromEvent) neutralNextEvent++;
        else neutralLater++;
      }
    }
  }
  const strengthsUsable = teamStrengthsUsable(bootstrap.teams);
  const oddsActive = oddsResult.status === "ok";

  // ---- the model -------------------------------------------------------
  // `rawScored` is the model's own, uncorrected output. Everything the
  // learning layer MEASURES is stored from this, deliberately: if the
  // calibration were measured against already-calibrated predictions it
  // would be measuring its own correction, converge on "no bias", and
  // quietly undo itself. `scored` is what the recommendations act on.
  const rawScored = buildScoredPlayers(
    bootstrap,
    fixtures,
    fromEvent,
    5,
    oddsMatches,
    activeInsights
  );
  const learning = await getLearningState();
  const scored = applyCalibration(rawScored, learning.calibration);

  // ---- league standings (optional) --------------------------------------
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
  let leagueComplete = true;
  let leagueStandingsRaw: Awaited<ReturnType<typeof getFullLeagueStandings>> | null = null;
  try {
    // Every page, not just the first fifty — see getFullLeagueStandings.
    leagueStandingsRaw = await getFullLeagueStandings(DEFAULT_LEAGUE_ID);
    leagueName = leagueStandingsRaw.league.name;
    leagueResults = leagueStandingsRaw.results;
    leagueComplete = leagueStandingsRaw.complete;
  } catch {
    leagueError =
      "Não foi possível carregar esta liga — se for uma liga privada pode precisar de sessão autenticada.";
  }
  const myTeamIdNum = Number(DEFAULT_TEAM_ID);
  const myLeagueRank =
    leagueResults.find((r) => r.entry === myTeamIdNum)?.rank ?? null;

  // ---- Camada 2: simulation against the real rivals ---------------------
  // `finished` (bonus confirmed, stats final) is the right gate for the
  // learning layers, which must never settle a gameweek on provisional
  // points. It is the WRONG gate for reading squads — see lastPublishedEvent.
  const finishedEventIds = bootstrap.events.filter((e) => e.finished).map((e) => e.id);

  // The gameweek whose squads FPL is actually serving.
  //
  // This used to be `lastFinishedEvent`, which is a different and later
  // thing: `finished` is only set once FPL has confirmed bonus points and
  // final stats, days after the last whistle. Picks become public the moment
  // a DEADLINE passes. Gating on `finished` therefore blacked out the whole
  // transfer planner from every Friday evening until the following Tuesday —
  // which is precisely the window in which a manager plans transfers.
  //
  // Using the deadline is also strictly better information: during a live
  // gameweek it returns the squad including any transfers already made this
  // week, which is the one thing the planner would otherwise be blind to.
  // eslint-disable-next-line react-hooks/purity
  const nowForPicks = Date.now();
  const publishedEvents = bootstrap.events.filter(
    (e) => new Date(e.deadline_time).getTime() <= nowForPicks
  );
  const lastPublishedEvent =
    publishedEvents.length > 0
      ? Math.max(...publishedEvents.map((e) => e.id))
      : 0;

  let outlook: LeagueOutlook = {
    available: false,
    reason:
      "A simulação contra os rivais só arranca quando houver uma jornada fechada — antes disso a FPL não publica o onze de ninguém.",
    squadsFromEvent: null,
    gameweeksRemaining: Math.max(0, 38 - fromEvent),
    runs: 0,
    me: null,
    rivals: [],
    posture: NEUTRAL_POSTURE,
  };
  if (lastPublishedEvent >= 1 && leagueStandingsRaw) {
    const squads = await fetchRivalSquads(
      leagueStandingsRaw.results,
      lastPublishedEvent,
      myTeamIdNum
    );
    outlook = simulateLeague(squads, scored, {
      currentEvent: fromEvent,
      squadsFromEvent: lastPublishedEvent,
    });
  }

  // Camada 2 sets the posture; Camada 3 nudges it with what the season has
  // actually been rewarding. The result is one number, and it goes straight
  // into the optimizer's objective rather than being printed for someone to
  // act on by hand.
  const posture = applyLearningTilt(
    outlook.posture,
    learning.postureTilt,
    learning.postureTiltReason
  );
  const effectiveOutlook: LeagueOutlook = { ...outlook, posture };

  // ---- the real team, not a hypothetical one ---------------------------
  // Every recommendation before v1.26 was built for a £100.0m blank slate.
  // In a running season the budget is the squad's own value plus the bank,
  // and the freedom to change it is one transfer a week.
  const squadState =
    lastPublishedEvent >= 1
      ? await loadSquadState(myTeamIdNum, bootstrap, lastPublishedEvent)
      : EMPTY_SQUAD_STATE;
  const budgetM = squadState.available ? squadState.totalBudgetM : 100;

  const { squad, starters, totalCost, method: squadMethod } = buildOptimalSquad(
    scored,
    budgetM,
    posture.beta
  );
  const { captain, viceCaptain } = pickCaptain(starters, posture.beta);
  const squadRisk = computeSquadRisk(starters);
  const rankProfile = computeSquadRankProfile(starters, scored);
  const differentials = findDifferentials(scored, 10, 8);
  const { risers, fallers } = buildPriceWatch(bootstrap, 8);
  const newsWatch = buildNewsWatch(bootstrap, 15);

  // ---- season calendar: international breaks, doubles, blanks ----------
  const calendar = readCalendar(bootstrap.events, bootstrap.teams, fixtures, fromEvent);

  // ---- what to actually do before the deadline -------------------------
  const transferAdvice = planTransfers(scored, squadState, {
    beta: posture.beta,
    currentEvent: fromEvent,
    likelyRisers: risers.map((r) => r.element.id),
    likelyFallers: fallers.map((r) => r.element.id),
    calendar,
  });

  // ---- how the last/current gameweek actually went ---------------------
  const reviewEvent = lastPublishedEvent;
  const gwReview =
    reviewEvent >= 1
      ? await reviewGameweek(myTeamIdNum, reviewEvent, bootstrap)
      : {
          available: false,
          reason:
            "A época ainda não começou — não há jornada para rever. Esta secção preenche-se sozinha depois da primeira bola rolar.",
          event: null,
          finished: false,
          hadStoredPredictions: false,
          predictedTotal: 0,
          actualTotal: 0,
          delta: 0,
          averageScore: null,
          players: [],
          benchPoints: 0,
          transfersMade: 0,
          transferCost: 0,
          captain: null,
          verdict: "",
        };

  // ---- tracking (all optional, all no-ops without Redis) ----------------
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const upcomingEvent = bootstrap.events.find(
    (e) => !e.finished && new Date(e.deadline_time).getTime() > nowMs
  );
  await Promise.all([
    upcomingEvent ? snapshotIfMissing(rawScored, upcomingEvent.id) : Promise.resolve(),
    upcomingEvent ? snapshotStrategies(rawScored, upcomingEvent.id) : Promise.resolve(),
    // Per-player predictions for the gameweek review. Written BEFORE the
    // deadline because reconstructing them afterwards is not a test the
    // model could ever fail.
    upcomingEvent ? snapshotPredictions(rawScored, upcomingEvent.id) : Promise.resolve(),
    recordOutcomesForFinishedEvents(finishedEventIds),
    settleStrategies(finishedEventIds),
  ]);
  const accuracyHistory = await getAccuracyHistory();

  // ---- schedule anomalies ----------------------------------------------
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

  // The one sentence the whole page exists to produce. Kept short enough to
  // read at a glance; the full reasoning lives in the panel below it.
  const decisionCaptain =
    transferAdvice.recommended?.captain ?? captain;
  // O VICE PASSA A ESTAR NO CABEÇALHO, AO LADO DO CAPITÃO.
  //
  // É uma decisão que se toma na mesma altura, no mesmo ecrã da FPL, e que
  // estava enterrada no meio dos planos. Ganha o seu lugar agora por dois
  // motivos: até à v1.41 era escolhido ao acaso (o termo do seguro valia
  // zero para um capitão indiscutível, e ficava o primeiro do array), e um
  // número que ninguém vê é um número que ninguém verifica.
  const decisionVice =
    transferAdvice.recommended?.viceCaptain ?? viceCaptain;
  const decisionHeadline = (() => {
    const plan = transferAdvice.recommended;
    if (!plan) {
      return "Ainda sem plantel teu publicado — este é o onze que o modelo escolheria hoje.";
    }
    if (plan.transfers === 0) return "Não faças nenhuma transferência esta jornada.";
    // Listing every swap works for one or two. Beyond that it stops being an
    // instruction and becomes a paragraph — which is exactly what happened on
    // a wildcard plan, where five names and five arrows ran off the line.
    if (plan.transfers > 2) {
      return plan.key === "wildcard"
        ? `Joga o Wildcard — ${plan.transfers} transferências, detalhadas em baixo.`
        : `${plan.transfers} transferências, detalhadas em baixo.`;
    }
    return plan.moves
      .map((m) => `${m.out.element.web_name} → ${m.in.element.web_name}`)
      .join("  ·  ");
  })();

  const isPreseason = scored[0]?.isPreseason ?? true;
  const bench = orderBench(squad.filter((p) => !starters.includes(p)));

  // ---- chips: Bench Boost, Triple Captain, Free Hit ---------------------
  // Uses the RECOMMENDED squad when there is one — a Bench Boost is worth
  // what the bench you will actually field scores, not what today's bench
  // would have scored before the transfer.
  const chipAdvice = planChips({
    currentEvent: fromEvent,
    chips: squadState.chips,
    xi: transferAdvice.recommended?.xi ?? starters,
    bench: transferAdvice.recommended?.bench ?? bench,
    captain: transferAdvice.recommended?.captain ?? captain,
    calendar,
  });
  const xiExpected = starters.reduce((s, p) => s + p.expectedPointsNext, 0);

  return (
    <div className="min-h-full bg-bg text-text">
      {/* ================= top bar =================
          One compact row plus the navigation. The previous header was 370px
          tall — a third of a laptop viewport — of which 150px was four
          bordered tiles reporting internal model state. Nothing above the
          fold answered a question anyone had. */}
      <header className="sticky top-0 z-30 topbar">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="eyebrow hidden text-white/40 sm:inline">
                FPL Command Center
              </span>
              <h1 className="truncate font-display text-lg font-bold tracking-tight md:text-xl">
                {nextEvent?.name ?? "Gameweek"}
              </h1>
            </div>
            {nextEvent?.deadline_time && (
              <div className="flex shrink-0 items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="eyebrow text-white/40">Deadline</p>
                  <p className="font-mono text-[11px] leading-tight text-white/55">
                    {new Date(nextEvent.deadline_time).toLocaleString("pt-PT", {
                      timeZone: "Europe/Lisbon",
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <CountdownTimer deadlineIso={nextEvent.deadline_time} />
              </div>
            )}
          </div>

          <nav className="pill-scroller -mx-1 px-1 pb-2">
            {NAV.map((group) => (
              <span key={group.tier} className="flex items-center gap-1.5">
                <span className="eyebrow shrink-0 text-text-muted opacity-70">
                  {group.tier}
                </span>
                {group.items.map(([href, label]) => (
                  <a key={href} href={`#${href}`} className="pill">
                    {label}
                  </a>
                ))}
              </span>
            ))}
          </nav>
        </div>
        <div className="brand-rule" />
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 md:px-6">
        {/* Antes de tudo o resto: se os dados não são de agora, isso é a
            primeira coisa a saber, não uma nota de rodapé no fim. */}
        <StaleDataBanner health={getFplDataHealth()} />
        <TierHeading label="Decidir" note="o que fazer antes do deadline" />
        {/* ================= 1. o que fazer ================= */}
        <Section
          id="fazer"
          eyebrow="A decisão"
          title="O Que Fazer Antes do Deadline"
          primary
        >
          {/* The headline answer, then the handful of facts that qualify it —
              as inline pairs, not as bordered tiles. */}
          <div className="mb-4 border-b border-border pb-4">
            <p className="font-display text-lg font-bold leading-snug tracking-tight sm:text-xl md:text-2xl">
              {decisionHeadline}
            </p>
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-2">
              <Fact
                label="Capitão"
                value={decisionCaptain?.element.web_name ?? "—"}
                tone="accent"
              />
              <Fact label="Vice" value={decisionVice?.element.web_name ?? "—"} />
              {squadState.available ? (
                <>
                  <Fact
                    label="Livres"
                    value={String(squadState.freeTransfers)}
                  />
                  <Fact
                    label="Orçamento"
                    value={`£${squadState.totalBudgetM.toFixed(1)}m`}
                  />
                  {transferAdvice.recommended &&
                    transferAdvice.recommended.netGainVsHold !== 0 && (
                      <Fact
                        label="Ganho"
                        value={`${transferAdvice.recommended.netGainVsHold >= 0 ? "+" : ""}${transferAdvice.recommended.netGainVsHold.toFixed(1)} pts`}
                        tone={
                          transferAdvice.recommended.netGainVsHold >= 0
                            ? "accent"
                            : "danger"
                        }
                      />
                    )}
                </>
              ) : (
                <Fact label="Onze ideal" value={`${xiExpected.toFixed(1)} pts`} />
              )}
              {posture.beta !== 0 && (
                <Fact
                  label="Postura"
                  value={posture.label}
                  tone={posture.label === "atacar" ? "danger" : "warn"}
                />
              )}
              {effectiveOutlook.me && (
                <Fact label="Liga" value={`${effectiveOutlook.me.rank}º`} />
              )}
            </div>
          </div>

          <ChipPlanPanel advice={chipAdvice} calendar={calendar} event={fromEvent} />

          <TransferPlanPanel
            advice={transferAdvice}
            state={squadState}
            fallback={
              <PitchView
                starters={starters}
                bench={bench}
                captainId={captain?.element.id}
                viceCaptainId={viceCaptain?.element.id}
              />
            }
          />
        </Section>

        {/* ================= alerts =================
            Below the decision, not above it. A missing odds feed is worth
            knowing; it is not worth putting between a manager and the reason
            he opened the page. */}
        {(oddsProblem ||
          !storageConfigured ||
          neutralNextEvent > 0 ||
          neutralLater > 0 ||
          isPreseason) && (
          <div className="-mt-4 flex flex-col gap-1.5">
            {oddsProblem && (
              <AlertStrip tone="danger" title="Sem odds de mercado.">
                {oddsProblem} É a fonte mais forte para avaliar calendário — sem
                ela o modelo apoia-se numa leitura bastante mais fraca.
              </AlertStrip>
            )}
            {/* THE RESEARCH LAYER, LOUDLY.
                A tactical layer that stops running is invisible: the notes it
                left behind stay on screen, still look current, and keep moving
                the model until they expire two weeks later. That silence is
                exactly what made the owner distrust the layer. It now says so
                itself, at the top, in the same place as a missing data source
                — because that is what it is. */}
            {researchStale && (
              <AlertStrip
                tone="danger"
                title={
                  lastResearchRun
                    ? `Investigação tática parada há ${researchAgeDays} dias.`
                    : "Investigação tática nunca correu."
                }
              >
                {activeInsights.length > 0
                  ? `Há ${activeInsights.length} nota${activeInsights.length === 1 ? "" : "s"} ativa${activeInsights.length === 1 ? "" : "s"} a mexer no modelo, mas nenhuma é recente. As tarefas semanais correm à quinta e à sexta — se isto persistir, falharam.`
                  : "Nenhuma nota ativa e nenhuma execução recente. A camada qualitativa do modelo está inerte."}
              </AlertStrip>
            )}
            {/* The computational jobs, separately — the research strip above
                covers only the layer that needs a human-ish session. These two
                run inside the deployment on Vercel's own scheduler, so if THEY
                are stale something is wrong with the app, not with a session
                elsewhere. */}
            {brokenJobs.some((j) => j.job !== "research") && (
              <AlertStrip
                tone="danger"
                title={`Tarefa automática parada: ${brokenJobs
                  .filter((j) => j.job !== "research")
                  .map((j) => j.label)
                  .join(", ")}.`}
              >
                Estas correm sozinhas todos os dias dentro da aplicação. Se estão
                paradas, o modelo continua a decidir com a última medição que
                conseguiu fazer — e essa pode ser antiga.
              </AlertStrip>
            )}
            {emptyJobs.length > 0 && (
              <AlertStrip
                tone="warn"
                title={`Correu sem produzir nada: ${emptyJobs.map((j) => j.label).join(", ")}.`}
              >
                Terminou sem erro e não trouxe resultado nenhum. Não é uma avaria,
                mas também não é trabalho feito — e a diferença entre as duas coisas
                é exatamente o que estava escondido atrás de um visto verde.
              </AlertStrip>
            )}
            {!storageConfigured && (
              <AlertStrip tone="danger" title="Armazenamento não ligado.">
                Sem Upstash Redis nada é guardado: a Shadow Team, o painel de
                precisão, a investigação semanal e a Camada 3 ficam todos inertes.
              </AlertStrip>
            )}
            {neutralNextEvent > 0 ? (
              <AlertStrip tone="danger" title={`Jornada ${fromEvent} sem dados de calendário.`}>
                {neutralNextEvent} jogo{neutralNextEvent === 1 ? "" : "s"} sem
                odds nem resultados — tratados como equipas médias. É a jornada
                para a qual estás a escolher equipa.
              </AlertStrip>
            ) : null}
            {neutralLater > 0 && neutralNextEvent === 0 ? (
              <AlertStrip tone="info" title="Jornadas distantes ainda sem odds.">
                Normal: as casas de apostas só abrem mercados uma a duas semanas
                antes. A próxima jornada está coberta.
              </AlertStrip>
            ) : null}
            {isPreseason && (
              <AlertStrip tone="warn" title="Sem dados de forma ainda.">
                As pontuações apoiam-se na estimativa da FPL e no calendário até
                haver jogos concluídos.
              </AlertStrip>
            )}
          </div>
        )}

        {/* ================= 6. shadow team ================= */}
        <Section
          id="shadow"
          title="Shadow Team"
          eyebrow="Sandbox — testa antes de aplicar a sério"
        >
          <ShadowTeamPanel
            scored={scored}
            suggestedElementIds={squad.map((p) => p.element.id)}
          />
        </Section>

        <TierHeading label="Perceber" note="como correu, e o que o modelo aprendeu com isso" />
        {/* ================= 2. revisão da jornada ================= */}
        <Section
          id="revisao"
          eyebrow={
            gwReview.event
              ? `Jornada ${gwReview.event}${gwReview.finished ? "" : " · ainda a decorrer"}`
              : "Ainda sem jornadas"
          }
          title="Como Correu a Minha Equipa"
          intro="Previsto contra real, jogador a jogador. Ordenado por desvio face à previsão, não por pontos: um jogador que fez o que era esperado não é notícia; um que ficou muito abaixo, é."
        >
          <GameweekReviewPanel review={gwReview} />
        </Section>

        {/* ================= 10. aprendizagem ================= */}
        <Section
          id="aprendizagem"
          title="O Que o Modelo Já Aprendeu"
          eyebrow="Camada 3 · previsto vs. real"
          intro="Todo o número desta app é uma suposição até uma jornada real o confirmar. Esta secção é onde o modelo se confronta com o que aconteceu — e se corrige."
        >
          <StrategyPanel learning={learning} storageConfigured={storageConfigured} />

          <div className="mt-6 border-t border-border pt-5">
            <SubHeading>Precisão do modelo, jornada a jornada</SubHeading>
            {!accuracyHistory.configured ? (
              <p className="text-sm text-text-muted">
                Precisa da integração Upstash Redis para guardar as previsões
                antes de cada jornada.
              </p>
            ) : accuracyHistory.results.length === 0 ? (
              <p className="text-sm text-text-muted">
                Ainda sem jornadas comparadas. Volta aqui depois da próxima
                jornada terminar.
              </p>
            ) : (
              <div className="scroll-x">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
                      <th className="py-2 pr-3 font-semibold">Jornada</th>
                      <th className="py-2 pr-3 text-right font-semibold">
                        Metade top
                      </th>
                      <th className="py-2 pr-3 text-right font-semibold">Resto</th>
                      <th className="py-2 text-right font-semibold">Diferença</th>
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
                <p className="mt-3 text-xs leading-relaxed text-text-muted">
                  Comparação feita <strong>dentro de cada posição</strong>: os
                  jogadores que o motor classificou melhor contra os que
                  classificou pior, nunca médios contra defesas. Uma diferença
                  positiva e consistente ao longo da época é o sinal de que o
                  motor está mesmo a distinguir quem vai pontuar.
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <SubHeading>Notas táticas ativas</SubHeading>
            {!storageConfigured ? (
              <p className="text-sm text-danger">
                Sem Upstash Redis não existe onde guardar o que a investigação
                semanal encontrar.
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
                      `${lastResearchRun.acceptedCount} aceites, ${lastResearchRun.rejectedCount} rejeitadas.`}
                  </>
                ) : (
                  <>
                    <strong className="text-text">
                      A investigação semanal ainda nunca registou uma execução
                      aqui.
                    </strong>{" "}
                    Se já devia ter corrido, é sinal de que falhou antes de
                    chegar a escrever — e não de que não encontrou nada.
                  </>
                )}{" "}
                Esta secção mostra ajustes qualitativos que nenhum dado da FPL
                ou das odds capta sozinho, com limites apertados (±20% no
                máximo por nota) e expiração automática ao fim de 2 semanas.
              </p>
            ) : (
              <div className="scroll-x">
                {lastResearchRun && (
                  <p className="mb-3 text-xs text-text-muted">
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
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
                      <th className="py-2 pr-3 font-semibold">Jogador/Equipa</th>
                      <th className="py-2 pr-3 text-right font-semibold">Ajuste</th>
                      <th className="py-2 pr-3 font-semibold">Razão</th>
                      <th className="py-2 pr-3 font-semibold">Fonte</th>
                      <th className="py-2 font-semibold">Validade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeInsights.map((insight, i) => (
                      <tr
                        key={`${insight.scope}-${insight.id}-${i}`}
                        className="border-t border-border"
                      >
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
                        <td className="py-2 pr-3 text-xs text-text-muted">
                          {insight.source}
                        </td>
                        <td className="py-2 text-xs text-text-muted">
                          {insight.expiresAt
                            ? `até ${new Date(insight.expiresAt).toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" })}`
                            : "permanente"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Section>

        {/* ================= 4. a liga ================= */}
        <Section
          id="liga"
          eyebrow={`Camada 2 · Liga privada #${DEFAULT_LEAGUE_ID}`}
          title={leagueName ?? "A Minha Liga"}
          intro="Em vez de perguntar 'que equipa faz mais pontos?', esta camada pergunta 'que equipa maximiza a probabilidade de eu acabar à frente destas pessoas em concreto?'. São perguntas diferentes, e a resposta muda conforme estejas à frente ou atrás."
        >
          {leagueError && <p className="mb-4 text-sm text-danger">{leagueError}</p>}
          {!leagueError && leagueResults.length === 0 && (
            <p className="mb-4 text-sm text-text-muted">
              Ainda sem classificação nesta liga — a FPL só calcula rankings
              depois da primeira jornada fechar.
            </p>
          )}

          <LeagueSimPanel outlook={effectiveOutlook} />

          {/* ALWAYS shown, not only when the simulation is unavailable.
              This table used to be a fallback for a broken simulation, which
              meant fixing the simulation would have made the league table
              disappear — the opposite of what it is for. */}
          {leagueResults.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-text-muted">
                <span>
                  Liga completa — <strong className="text-text">{leagueResults.length}</strong>{" "}
                  {leagueResults.length === 1 ? "equipa" : "equipas"}
                  {myLeagueRank !== null && (
                    <>
                      {" · estás em "}
                      <strong className="text-text">{myLeagueRank}º</strong>
                    </>
                  )}
                </span>
                {!leagueComplete && (
                  <span className="text-warn">
                    Liga demasiado grande para carregar por inteiro — mostradas as
                    primeiras {leagueResults.length}.
                  </span>
                )}
              </p>
              <div className="max-h-[26rem] overflow-y-auto scroll-x rounded-lg border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="py-2 pl-3 pr-3 font-semibold">#</th>
                    <th className="py-2 pr-3 font-semibold">Gestor</th>
                    <th className="py-2 pr-3 font-semibold">Equipa</th>
                    <th className="py-2 text-right font-semibold">Pontos</th>
                  </tr>
                </thead>
                <tbody>
                  {leagueResults.map((r) => (
                    <tr
                      key={r.id}
                      className={`border-t border-border ${
                        r.entry === myTeamIdNum
                          ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]"
                          : ""
                      }`}
                    >
                      <td className="py-2 pl-3 pr-3 font-mono tabular">{r.rank}</td>
                      <td className="py-2 pr-3">{r.player_name}</td>
                      <td className="py-2 pr-3 text-text-muted">
                        {r.entry_name}
                        {r.entry === myTeamIdNum && (
                          <span className="ml-2 rounded bg-accent-vivid px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-contrast">
                            tu
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right font-mono tabular font-semibold">
                        {r.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </Section>

        <TierHeading label="Consultar" note="dados de apoio, para quando quiseres investigar" />
        {/* ================= 3. plantel ideal ================= */}
        <Section
          id="ideal"
          eyebrow={`Referência (${squadMethod}) · £${totalCost.toFixed(1)}m de £${budgetM.toFixed(1)}m`}
          title="O Plantel Ideal"
          intro={
            <>
              O melhor plantel que{" "}
              {squadState.available ? "o teu dinheiro" : "£100m"} compra hoje,
              ignorando o custo de lá chegar. Não é um plano —{" "}
              <strong className="text-text">
                é o alvo contra o qual o plano acima mede a distância
              </strong>
              . Capitão:{" "}
              <strong className="text-text">{captain?.element.web_name}</strong> ·
              Vice: <strong className="text-text">{viceCaptain?.element.web_name}</strong>.{" "}
              {oddsActive
                ? "Pontuação enriquecida com odds de mercado."
                : "A correr só com o modelo estatístico — liga a ODDS_API_KEY na Vercel para incluir odds de mercado."}
            </>
          }
        >
          <PitchView
            starters={starters}
            bench={bench}
            captainId={captain?.element.id}
            viceCaptainId={viceCaptain?.element.id}
          />

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface-2 p-4">
              <SubHeading>Risco de concentração</SubHeading>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                <span>
                  Pontos esperados:{" "}
                  <strong className="font-mono tabular">{squadRisk.expectedPoints}</strong>
                </span>
                <span>
                  Desvio-padrão:{" "}
                  <strong className="font-mono tabular">±{squadRisk.stdDev}</strong>
                </span>
                <span>
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
              </div>
              {squadRisk.warnings.length > 0 && (
                <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-warn">
                  {squadRisk.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs leading-relaxed text-text-muted">
                Um clean sheet é <strong>um único acontecimento</strong>{" "}
                partilhado por todos os teus defesas do mesmo clube. Empilhar
                não muda os pontos esperados — multiplica a variância. 1.00× é
                totalmente diversificado.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-2 p-4">
              <SubHeading>Valor de ranking</SubHeading>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                <span>
                  Pontos esperados:{" "}
                  <strong className="font-mono tabular">
                    {rankProfile.totalExpectedPoints}
                  </strong>
                </span>
                <span>
                  Ganho sobre o rival médio:{" "}
                  <strong className="font-mono tabular text-accent">
                    {rankProfile.totalRankValue}
                  </strong>
                </span>
                <span>
                  Posse média:{" "}
                  <strong className="font-mono tabular">
                    {rankProfile.weightedOwnership}%
                  </strong>
                </span>
              </div>
              <p className="mb-2 text-sm text-text-muted">{rankProfile.verdict}</p>
              {rankProfile.missingTemplate.length > 0 && (
                <p className="text-sm text-warn">
                  <strong>Template que não tens:</strong>{" "}
                  {rankProfile.missingTemplate
                    .map(
                      (m) =>
                        `${m.player.element.web_name} (${Math.round(m.player.ownershipPct)}%)`
                    )
                    .join(" · ")}
                  .
                </p>
              )}
            </div>
          </div>

          <div className="mt-6">
            <SubHeading>Porquê cada jogador</SubHeading>
            <PlayerTable players={starters} showReasons />
          </div>
        </Section>

        {/* ================= 8. escolhas ================= */}
        <Section
          id="escolhas"
          title="Melhores Escolhas"
          eyebrow="Por posição, e diferenciais"
        >
          <div className="grid gap-6 lg:grid-cols-2">
            {(
              [
                [1, "Guarda-Redes"],
                [2, "Defesas"],
                [3, "Médios"],
                [4, "Avançados"],
              ] as [number, string][]
            ).map(([id, label]) => (
              <div key={id}>
                <SubHeading>{label}</SubHeading>
                <PlayerTable players={byPos(id)} showReasons />
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-border pt-5">
            <SubHeading>Diferenciais (menos de 10% de posse)</SubHeading>
            <PlayerTable players={differentials} showReasons />
          </div>
        </Section>

        {/* ================= 7. calendário ================= */}
        <Section
          id="calendario"
          title="Calendário"
          eyebrow="Modelo próprio, não o dígito 1-5 da FPL"
          intro="Ataque = golos esperados da equipa por jogo. Defesa = probabilidade de clean sheet. Uma equipa pode ser boa aposta para os teus atacantes e má para os teus defesas, por isso os dois números aparecem separados."
        >
          <FixtureTicker
            teams={bootstrap.teams}
            ticker={ticker}
            oddsActive={oddsActive}
            strengthsUsable={strengthsUsable}
          />

          <div className="mt-6 border-t border-border pt-5">
            <SubHeading>
              Jornadas duplas e brancas — próximas {scheduleHorizon - fromEvent + 1}
            </SubHeading>
            {scheduleEvents.length === 0 ? (
              <p className="text-sm text-text-muted">
                Nenhuma jornada dupla ou em branco confirmada ainda. É normal no
                início da época — reagendamentos só costumam ser confirmados
                algumas semanas antes; esta secção preenche-se sozinha.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {scheduleEvents.map((event) => {
                  const bucket = anomaliesByEvent.get(event)!;
                  return (
                    <div
                      key={event}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <span className="font-display font-bold tracking-tight">
                        GW{event}
                      </span>
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
          </div>
        </Section>

        {/* ================= 9. mercado ================= */}
        <Section
          id="mercado"
          title="Mercado"
          eyebrow="Preços e disponibilidade"
          intro="A FPL não publica o algoritmo real de mudança de preços. As previsões abaixo são estimativas a partir das transferências líquidas de hoje — úteis para decidires se vale a pena antecipar uma transferência, não garantias."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <SubHeading>
                <span className="text-success">Prováveis subidas</span>
              </SubHeading>
              {risers.length === 0 ? (
                <p className="text-sm text-text-muted">Sem sinal forte de subida agora.</p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {risers.map((r) => (
                    <div
                      key={r.element.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span>
                        {r.element.web_name}{" "}
                        <span className="text-xs text-text-muted">
                          ({r.team.short_name})
                        </span>
                      </span>
                      <span className="flex items-center gap-3 font-mono text-xs tabular text-text-muted">
                        <span>£{r.priceM.toFixed(1)}m</span>
                        <span className="font-semibold text-success">
                          +{r.netTransfers.toLocaleString("pt-PT")}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <SubHeading>
                <span className="text-danger">Prováveis descidas</span>
              </SubHeading>
              {fallers.length === 0 ? (
                <p className="text-sm text-text-muted">Sem sinal forte de descida agora.</p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {fallers.map((r) => (
                    <div
                      key={r.element.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span>
                        {r.element.web_name}{" "}
                        <span className="text-xs text-text-muted">
                          ({r.team.short_name})
                        </span>
                      </span>
                      <span className="flex items-center gap-3 font-mono text-xs tabular text-text-muted">
                        <span>£{r.priceM.toFixed(1)}m</span>
                        <span className="font-semibold text-danger">
                          {r.netTransfers.toLocaleString("pt-PT")}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <SubHeading>Notícias e lesões</SubHeading>
            {newsWatch.length === 0 ? (
              <p className="text-sm text-text-muted">
                Sem notas de lesão/dúvida/suspensão ativas neste momento.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {newsWatch.map((n) => (
                  <div
                    key={n.element.id}
                    className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium">{n.element.web_name}</span>{" "}
                      <span className="text-xs text-text-muted">
                        ({n.team.short_name} · {n.ownershipPct.toFixed(1)}% posse)
                      </span>
                      {n.isRecent && (
                        <span className="ml-2 rounded border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_18%,var(--surface))] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">
                          recente
                        </span>
                      )}
                      <p className="mt-0.5 text-xs text-text-muted">{n.news}</p>
                    </div>
                    <span className="whitespace-nowrap font-mono text-xs tabular text-text-muted">
                      {n.chanceOfPlaying === null ? "—" : `${n.chanceOfPlaying}% jogo`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/* ================= 11. referência ================= */}
        <Section
          id="referencia"
          title="Referência"
          eyebrow="Playbook, regras e estado do projeto"
        >
          <SubHeading>Playbook de estratégia</SubHeading>
          <div className="grid gap-4 md:grid-cols-2">
            {PLAYBOOK.map((p) => (
              <div
                key={p.title}
                className="rounded-lg border border-border bg-surface-2 p-4"
              >
                <h4 className="mb-1.5 font-display text-base font-bold tracking-tight">
                  {p.title}
                </h4>
                <p className="text-sm leading-relaxed text-text-muted">{p.body}</p>
                <p className="mt-2 text-[11px] text-text-muted opacity-70">
                  Fonte: {p.source}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <SubHeading>Regras &amp; cheat sheet 2026/27</SubHeading>
            <div className="grid gap-6 md:grid-cols-3">
              {RULES_2026_27.map((group) => (
                <div key={group.section}>
                  <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-accent">
                    {group.section}
                  </p>
                  <dl className="flex flex-col gap-2 text-sm">
                    {group.facts.map((f) => (
                      <div
                        key={f.label}
                        className="flex justify-between gap-3 border-b border-border pb-1.5"
                      >
                        <dt className="text-text-muted">{f.label}</dt>
                        <dd className="text-right font-medium">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 grid gap-6 border-t border-border pt-5 text-sm md:grid-cols-2">
            <div>
              <SubHeading>
                <span className="text-accent">Já funciona</span>
              </SubHeading>
              <ul className="flex flex-col gap-1.5 text-text-muted">
                <li>✓ Dados reais e ao vivo da API oficial da FPL</li>
                <li>✓ Motor de pontos esperados modelado sobre as regras do jogo</li>
                <li>✓ Odds de mercado como fonte primária de dificuldade de calendário</li>
                <li>✓ Otimizador de programação linear inteira (plantel + onze em simultâneo)</li>
                <li>✓ Ameaça individual de golo/assistência e bolas paradas por jogador</li>
                <li>✓ Bónus previsto por BPS e pontos de defesa dos guarda-redes</li>
                <li>✓ Risco de concentração (clean sheet como acontecimento único)</li>
                <li>✓ Valor de ranking — pontos que os rivais não fizeram</li>
                <li>✓ <strong>Camada 2</strong> — simulação Monte Carlo contra os rivais reais da liga, a definir a postura de variância</li>
                <li>✓ <strong>Camada 3</strong> — calibração aprendida por posição e torneio de cinco estratégias</li>
                <li>✓ <strong>Planeamento de transferências</strong> a partir do plantel real, com o orçamento real e o -4 avaliado ao longo de 5 jornadas</li>
                <li>✓ Sinal de Wildcard — distância entre o plantel atual e o ideal, em transferências e em pontos</li>
                <li>✓ Revisão da jornada: previsto vs. real jogador a jogador, avaliação do capitão e do banco</li>
                <li>✓ Investigação tática automática duas vezes por semana, com âmbito por jornada e nível de confiança</li>
                <li>✓ Shadow Team, preditor de preços, monitor de lesões, duplas/brancas</li>
              </ul>
            </div>
            <div>
              <SubHeading>
                <span className="text-gold">A caminho</span>
              </SubHeading>
              <ul className="flex flex-col gap-1.5 text-text-muted">
                <li>
                  → Planeamento de transferências a mais de uma jornada de
                  distância: hoje o plano é ótimo para esta semana, mas não
                  antecipa que guardar duas transferências permitiria uma jogada
                  melhor daqui a duas jornadas
                </li>
                <li>→ Valor esperado de cada chip (Bench Boost, Triple Captain, Free Hit), usando o calendário de duplas/brancas e a simulação da Camada 2</li>
                <li>
                  → Login FPL + execução automática de transferências (autopilot
                  com trilhos de segurança) — o desenho de segurança fica
                  combinado antes de mexer em credenciais reais
                </li>
              </ul>
            </div>
          </div>
        </Section>

        {/* MANUTENÇÃO, NO FIM — E A RAZÃO É UMA QUEIXA DIRETA DO DONO.
            Este painel estava em QUINTO lugar na página, acima do plantel do
            próprio gestor. É diagnóstico da máquina, não uma decisão de FPL:
            só interessa quando alguma coisa pára, e nessa altura há um alarme
            vermelho lá em cima a mandar olhar para aqui. Pôr a canalização à
            frente do jogo foi exatamente a crítica que ele fez, e tinha
            razão. */}
        <TierHeading label="Ferramentas e sistema" note="ligações e diagnóstico — só interessa quando algo falha" />
        {/* ================= 5. a minha equipa ================= */}
        <Section
          id="minha-equipa"
          title="A Minha Equipa na FPL"
          eyebrow="Ligado ao teu Team ID"
        >
          <MyTeamPanel scored={scored} eventId={picksEvent} isPreseason={isPreseason} />
        </Section>

        <Section id="sistema" title="Saúde do sistema">
          <AutomationPanel
            jobs={jobHealth}
            cronSecretConfigured={(process.env.CRON_SECRET ?? "").trim().length > 0}
          />
        </Section>
      </main>

      <footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-text-muted md:px-6">
        Dados da API pública e não-oficial da Fantasy Premier League. Não
        afiliado à Premier League ou à FPL.
      </footer>
    </div>
  );
}
