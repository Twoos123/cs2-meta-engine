/**
 * Player stats API — ADR / KAST / trades / clutches / Rating 2.0 on top of
 * the base profile types in client.ts. Every advanced field is optional:
 * older backends and localStorage-cached rows don't carry them, and
 * nullable ones are null when the underlying demos lack the data.
 */
import { api, apiErrorMessage } from "./client";
import type {
  PlayerDemoEntry,
  PlayerMapSplit,
  PlayerProfileSummary,
  PlayerSideSplit,
} from "./client";

export interface PlayerClutchSplit {
  x: number;          // 1..5 — enemies alive when the clutch began
  attempted: number;
  won: number;
}

export interface PlayerAdvancedStats {
  assists?: number;
  apr?: number | null;              // assists per round
  adr?: number | null;              // null → demo(s) lack damage data
  kast_pct?: number | null;         // 0-1
  trade_kills?: number;
  traded_deaths?: number;
  trade_kill_pct?: number | null;   // 0-1 share of kills that were trades
  traded_death_pct?: number | null; // 0-1 share of deaths that got traded
  clutches_attempted?: number;
  clutches_won?: number;
  clutches?: PlayerClutchSplit[];
  rating?: number;                  // 2.0 approx. when ADR + KAST exist, else 1.0
  rating_1?: number;
  rating_version?: "2.0" | "1.0";
}

export type PlayerSummaryStats = PlayerProfileSummary & PlayerAdvancedStats;
export type PlayerSideStats = PlayerSideSplit & PlayerAdvancedStats;
export type PlayerMapStats = PlayerMapSplit & PlayerAdvancedStats;
export type PlayerDemoStats = PlayerDemoEntry & PlayerAdvancedStats;

export interface PlayerProfileStats {
  steamid: string;
  name: string;
  summary: PlayerSummaryStats;
  per_side: PlayerSideStats[];
  per_map: PlayerMapStats[];
  demos: PlayerDemoStats[];
}

export interface MatchPlayerStatsResponse {
  demo_file: string;
  map_name: string;
  has_adr: boolean;
  players: PlayerSummaryStats[];
}

export const listPlayerStats = async (minMatches = 1): Promise<PlayerSummaryStats[]> => {
  const { data } = await api.get<PlayerSummaryStats[]>("/players", {
    params: { min_matches: minMatches },
  });
  return data;
};

export const getPlayerProfileStats = async (steamid: string): Promise<PlayerProfileStats> => {
  const { data } = await api.get<PlayerProfileStats>(`/players/${encodeURIComponent(steamid)}`);
  return data;
};

/** Per-player stats for one demo (both sides combined) — replay Stats tab. */
export const getMatchPlayerStats = async (demoFile: string): Promise<MatchPlayerStatsResponse> => {
  const { data } = await api.get<MatchPlayerStatsResponse>(
    `/players/match/${encodeURIComponent(demoFile)}`,
  );
  return data;
};

export { apiErrorMessage };

// ---------------------------------------------------------------------------
// Formatting helpers (null / missing → em dash)
// ---------------------------------------------------------------------------

export const DASH = "—";

export function fmtAdr(v: number | null | undefined): string {
  return v == null ? DASH : v.toFixed(1);
}

/** 0-1 fraction → "72%". */
export function fmtPct(v: number | null | undefined): string {
  return v == null ? DASH : `${Math.round(v * 100)}%`;
}

export function fmtClutches(won: number | undefined, attempted: number | undefined): string {
  if (attempted == null) return DASH;
  return `${won ?? 0}/${attempted}`;
}

/** Body text for the "Rating 2.0 (approx.)" tooltip. */
export const RATING_2_EXPLAINER =
  "The community approximation of HLTV Rating 2.0: " +
  "0.0073·KAST + 0.3591·KPR − 0.5329·DPR + 0.2372·Impact + 0.0032·ADR + 0.1587, " +
  "where Impact = 2.13·KPR + 0.42·APR − 0.41. About 1.00 is an average pro. " +
  "Demos parsed without damage data fall back to Rating 1.0 (kills, survival, multi-kills).";
