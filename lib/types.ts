// Minimal typed subset of the official FPL API responses.
// The official API is unauthenticated, undocumented, and unofficial —
// these types cover only the fields this app actually reads. Treat
// unknown/extra fields defensively; FPL adds/renames fields between seasons.

export interface FplTeam {
  id: number;
  name: string;
  short_name: string;
  strength: number;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
}

export interface FplEvent {
  id: number;
  name: string;
  deadline_time: string;
  finished: boolean;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
  average_entry_score: number;
  highest_score: number | null;
  chip_plays?: { chip_name: string; num_played: number }[];
}

export interface FplElementType {
  id: number; // 1 GK, 2 DEF, 3 MID, 4 FWD
  singular_name_short: string; // GKP, DEF, MID, FWD
  squad_select: number;
  squad_min_play: number;
  squad_max_play: number;
}

export interface FplElement {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: number;
  now_cost: number; // tenths of £m
  total_points: number;
  event_points: number;
  points_per_game: string;
  form: string;
  selected_by_percent: string;
  status: "a" | "d" | "i" | "s" | "u" | "n";
  chance_of_playing_next_round: number | null;
  news: string;
  ict_index: string;
  influence: string;
  creativity: string;
  threat: string;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  bonus: number;
  bps: number;
  defensive_contribution?: number;
  transfers_in_event: number;
  transfers_out_event: number;
  cost_change_event: number;
  cost_change_start: number;
  news_added: string | null;
  // Individual underlying-performance and role signals — all already
  // present in the real FPL bootstrap payload, previously fetched but
  // never used by the scoring engine (see lib/playerthreat.ts for why
  // that mattered). Field names/shapes follow the FPL API as documented
  // by the wider open-source FPL community; this sandbox can't reach the
  // live API to verify them directly, so every read of these fields is
  // done defensively (missing/renamed -> 0/null, never a crash).
  starts?: number;
  expected_goals?: string;
  expected_assists?: string;
  expected_goal_involvements?: string;
  expected_goals_per_90?: string;
  expected_assists_per_90?: string;
  expected_goal_involvements_per_90?: string;
  penalties_order?: number | null;
  corners_and_indirect_freekicks_order?: number | null;
  direct_freekicks_order?: number | null;
}

export interface FplBootstrap {
  events: FplEvent[];
  teams: FplTeam[];
  element_types: FplElementType[];
  elements: FplElement[];
  total_players: number;
}

export interface FplFixture {
  id: number;
  event: number | null;
  kickoff_time: string | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
  finished: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
}

export interface FplEntryHistoryEntry {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  overall_rank: number;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}

export interface FplEntry {
  id: number;
  player_first_name: string;
  player_last_name: string;
  name: string; // team name
  summary_overall_points: number;
  summary_overall_rank: number;
  current_event: number;
  last_deadline_value: number;
  last_deadline_bank: number;
}

export interface FplLeagueStandingsEntry {
  id: number;
  entry: number;
  entry_name: string;
  player_name: string;
  rank: number;
  last_rank: number;
  total: number;
  event_total: number;
}

export interface FplLeagueStandings {
  league: { id: number; name: string };
  standings: {
    has_next: boolean;
    page: number;
    results: FplLeagueStandingsEntry[];
  };
}
