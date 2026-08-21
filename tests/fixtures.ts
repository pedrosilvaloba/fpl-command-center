import type {
  FplBootstrap,
  FplElement,
  FplEvent,
  FplFixture,
  FplTeam,
} from "../lib/types";

/**
 * Shared synthetic FPL data for the test suite.
 *
 * Deliberately hand-built rather than a captured live payload: these tests
 * must keep passing every week of the season, so they cannot depend on
 * whatever the real API happens to be returning today, and the sandbox
 * that runs them has no route to fantasy.premierleague.com anyway.
 */

export function makeTeam(id: number, short = `T${id}`): FplTeam {
  return {
    id,
    name: `Team ${id}`,
    short_name: short,
    strength: 3,
    strength_overall_home: 1100,
    strength_overall_away: 1100,
    strength_attack_home: 1100,
    strength_attack_away: 1100,
    strength_defence_home: 1100,
    strength_defence_away: 1100,
  };
}

export function makeElement(over: Partial<FplElement> = {}): FplElement {
  return {
    id: 1,
    web_name: "Test",
    first_name: "Test",
    second_name: "Player",
    team: 1,
    element_type: 3,
    now_cost: 60,
    total_points: 0,
    event_points: 0,
    points_per_game: "0",
    form: "0",
    selected_by_percent: "5",
    status: "a",
    chance_of_playing_next_round: null,
    news: "",
    ict_index: "0",
    influence: "0",
    creativity: "0",
    threat: "0",
    minutes: 0,
    goals_scored: 0,
    assists: 0,
    clean_sheets: 0,
    bonus: 0,
    bps: 0,
    transfers_in_event: 0,
    transfers_out_event: 0,
    cost_change_event: 0,
    cost_change_start: 0,
    news_added: null,
    ...over,
  };
}

export function makeEvent(id: number, over: Partial<FplEvent> = {}): FplEvent {
  return {
    id,
    name: `Gameweek ${id}`,
    deadline_time: "2026-08-21T17:30:00Z",
    finished: false,
    is_previous: false,
    is_current: false,
    is_next: false,
    average_entry_score: 0,
    highest_score: null,
    ...over,
  };
}

export function makeFixture(over: Partial<FplFixture> = {}): FplFixture {
  return {
    id: 1,
    event: 1,
    kickoff_time: null,
    team_h: 1,
    team_a: 2,
    team_h_difficulty: 3,
    team_a_difficulty: 3,
    finished: false,
    team_h_score: null,
    team_a_score: null,
    ...over,
  };
}

/** A minimal but complete league: `teamCount` teams, one round of
 * fixtures per gameweek across `gameweeks`, plus a full player pool. */
export function makeBootstrap(opts: {
  teamCount?: number;
  gameweeks?: number;
  currentEvent?: number | null;
  elements?: FplElement[];
} = {}): { bootstrap: FplBootstrap; fixtures: FplFixture[] } {
  const teamCount = opts.teamCount ?? 6;
  const gameweeks = opts.gameweeks ?? 10;
  const teams = Array.from({ length: teamCount }, (_, i) => makeTeam(i + 1));

  const events = Array.from({ length: 38 }, (_, i) =>
    makeEvent(i + 1, {
      is_current: opts.currentEvent === i + 1,
      finished: opts.currentEvent != null && i + 1 < opts.currentEvent,
    })
  );

  const fixtures: FplFixture[] = [];
  let fid = 1;
  for (let gw = 1; gw <= gameweeks; gw++) {
    for (let t = 0; t < teamCount; t += 2) {
      fixtures.push(
        makeFixture({
          id: fid++,
          event: gw,
          team_h: teams[t].id,
          team_a: teams[t + 1].id,
          finished: opts.currentEvent != null && gw < opts.currentEvent,
          team_h_score: opts.currentEvent != null && gw < opts.currentEvent ? 1 : null,
          team_a_score: opts.currentEvent != null && gw < opts.currentEvent ? 1 : null,
        })
      );
    }
  }

  const elements =
    opts.elements ??
    teams.flatMap((team) =>
      [1, 2, 2, 3, 3, 4].map((type, i) =>
        makeElement({
          id: team.id * 100 + i,
          web_name: `P${team.id}-${i}`,
          team: team.id,
          element_type: type,
          now_cost: 40 + i * 10,
        })
      )
    );

  return {
    bootstrap: {
      events,
      teams,
      element_types: [],
      elements,
      total_players: elements.length,
    },
    fixtures,
  };
}

// ---- tiny assertion harness (no test-runner dependency) ----------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

export function near(label: string, actual: number, expected: number, tol = 1e-6): void {
  check(
    label,
    Math.abs(actual - expected) <= tol,
    `esperado ~${expected}, obtido ${actual}`
  );
}

export function report(suite: string): void {
  if (failed === 0) {
    console.log(`  ${suite}: ${passed} verificações OK`);
  } else {
    console.log(`  ${suite}: ${passed} OK, ${failed} FALHARAM`);
    for (const f of failures) console.log(`      ✗ ${f}`);
  }
}

export function exitCode(): number {
  return failed > 0 ? 1 : 0;
}

export function counts(): { passed: number; failed: number } {
  return { passed, failed };
}
