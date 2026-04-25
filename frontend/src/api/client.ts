/**
 * Typed API client for the CS2 Meta-Analysis Engine FastAPI backend.
 */
import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// ---------------------------------------------------------------------------
// Types (mirror backend Pydantic schemas)
// ---------------------------------------------------------------------------

export interface TopThrower {
  name: string;
  count: number;
}

export interface LineupCluster {
  cluster_id: number;
  map_name: string;
  grenade_type: string;
  land_centroid_x: number;
  land_centroid_y: number;
  land_centroid_z: number;
  throw_centroid_x: number;
  throw_centroid_y: number;
  throw_centroid_z: number;
  avg_pitch: number;
  avg_yaw: number;
  throw_count: number;
  round_win_rate: number;
  total_utility_damage: number;
  avg_utility_damage: number;
  label: string | null;
  top_throwers: TopThrower[];
  primary_technique: string | null;
  technique_agreement: number;
  primary_click: string | null;
  click_agreement: number;
  side: string | null;   // "T" | "CT" | null
  demo_file: string | null;
  demo_tick: number | null;
  demo_thrower_name: string | null;
  trajectory: number[][] | null;
}

export interface LineupRanking {
  rank: number;
  cluster: LineupCluster;
  impact_score: number;
}

export interface TopLineupsResponse {
  map_name: string;
  grenade_type: string;
  lineups: LineupRanking[];
  total_clusters: number;
}

export interface PracticeResponse {
  success: boolean;
  commands_sent: string[];
  error?: string;
}

export interface ConsoleStringResponse {
  cluster_id: number;
  map_name: string;
  label: string;
  console_string: string;
}

export interface HLTVIngestRequest {
  team_name?: string;
  event_name?: string;
  map_name?: string;
  limit?: number;
}

export interface RunPipelineRequest {
  map_name?: string;
  grenade_types?: string[];
  clear_existing?: boolean;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export const getTopLineups = async (
  mapName: string,
  grenadeType: string,
  limit = 10,
  side?: "T" | "CT"
): Promise<TopLineupsResponse> => {
  const { data } = await api.get<TopLineupsResponse>(
    `/lineups/${mapName}/${grenadeType}`,
    { params: { limit, ...(side ? { side } : {}) } }
  );
  return data;
};

export const getAllTypesForMap = async (
  mapName: string,
  limit = 10
): Promise<TopLineupsResponse[]> => {
  const { data } = await api.get<TopLineupsResponse[]>(`/lineups/${mapName}`, {
    params: { limit },
  });
  return data;
};

export const getMaps = async (): Promise<string[]> => {
  const { data } = await api.get<{ maps: string[] }>("/maps");
  return data.maps;
};

export interface Callout {
  name: string;
  x: number;
  y: number;
}

export const getCallouts = async (mapName: string): Promise<Callout[]> => {
  const { data } = await api.get<{ map_name: string; callouts: Callout[] }>(
    `/callouts/${mapName}`,
  );
  return data.callouts;
};

export interface RadarInfo {
  map_name: string;
  pos_x: number;
  pos_y: number;
  scale: number;
  rotate: number;
  image_url: string;
}

export const getRadarInfo = async (mapName: string): Promise<RadarInfo> => {
  const { data } = await api.get<RadarInfo>(`/radars/${mapName}`);
  return data;
};

export interface DownloadedMap {
  map_name: string;
  token: string;
  count: number;
}

export interface DownloadedDemosResponse {
  maps: DownloadedMap[];
  total_demos: number;
  untagged: number;
}

export const getDownloadedDemos = async (): Promise<DownloadedDemosResponse> => {
  const { data } = await api.get<DownloadedDemosResponse>("/demos");
  return data;
};

export const getStats = async (): Promise<{
  total_lineups: number;
  total_maps: number;
}> => {
  const { data } = await api.get("/stats");
  return data;
};

export const getConsoleString = async (
  clusterId: number,
  mapName: string
): Promise<ConsoleStringResponse> => {
  const { data } = await api.get<ConsoleStringResponse>(
    `/console/${clusterId}`,
    { params: { map_name: mapName } }
  );
  return data;
};

export interface ReplayStringResponse {
  cluster_id: number;
  map_name: string;
  demo_file: string;
  demo_tick: number;
  demo_thrower_name: string | null;
  load_string: string;
  seek_string: string;
  console_string: string;
}

export const getReplayString = async (
  clusterId: number,
  mapName: string,
  playerName?: string,
): Promise<ReplayStringResponse> => {
  const { data } = await api.get<ReplayStringResponse>(
    `/replay/${clusterId}`,
    {
      params: {
        map_name: mapName,
        ...(playerName ? { player: playerName } : {}),
      },
    },
  );
  return data;
};

export const practiceLineup = async (
  clusterId: number,
  mapName: string
): Promise<PracticeResponse> => {
  const { data } = await api.post<PracticeResponse>("/practice", {
    cluster_id: clusterId,
    map_name: mapName,
  });
  return data;
};

export interface QueueResponse {
  status: string;
  message: string;
  run_id: number;
}

export const ingestFromHLTV = async (
  req: HLTVIngestRequest
): Promise<QueueResponse> => {
  const { data } = await api.post<QueueResponse>("/ingest/hltv", req);
  return data;
};

export const runPipeline = async (
  req: RunPipelineRequest
): Promise<QueueResponse> => {
  const { data } = await api.post<QueueResponse>("/ingest/run", req);
  return data;
};

export interface IngestionStatusResponse {
  total_demos: number;
  total_grenades: number;
  status: string;
  run_id: number;
  last_completed_run_id: number;
  manual_url: string | null;
  demos_parsed_this_run: number;
  demos_total_this_run: number;
  player_rows_updated_this_run: number;
  total_player_rows: number;
}

export const getIngestionStatus = async (): Promise<IngestionStatusResponse> => {
  const { data } = await api.get<IngestionStatusResponse>("/ingest/status");
  return data;
};

// ---------------------------------------------------------------------------
// FACEIT ingest
// ---------------------------------------------------------------------------

export interface FaceitMatchEntry {
  match_id: string;
  map_name: string | null;
  team1_name: string;
  team2_name: string;
  team1_score: number | null;
  team2_score: number | null;
  winner: string | null;
  finished_at: number | null;
  status: string | null;
  faceit_url: string | null;
}

export interface FaceitMatchListResponse {
  player_nickname: string;
  player_id: string;
  matches: FaceitMatchEntry[];
}

export const listFaceitMatches = async (
  faceit_url: string,
  limit = 30,
): Promise<FaceitMatchListResponse> => {
  const { data } = await api.post<FaceitMatchListResponse>(
    "/ingest/faceit/matches",
    { faceit_url, limit },
  );
  return data;
};

export const downloadFaceitMatch = async (
  match_id: string,
): Promise<QueueResponse> => {
  const { data } = await api.post<QueueResponse>(
    "/ingest/faceit/download",
    { match_id },
  );
  return data;
};

export const clearAllData = async (): Promise<{
  deleted: number;
  status: string;
}> => {
  const { data } = await api.delete("/data");
  return data;
};

// ---------------------------------------------------------------------------
// Match replay (full-match 2D viewer)
// ---------------------------------------------------------------------------

export interface MatchDemoEntry {
  demo_file: string;
  map_name: string;
  match_id: number | null;
  size_bytes: number;
  mtime: number;
}

export interface TimelinePlayer {
  steamid: string;
  name: string;
  team_num: number;        // 2 = T, 3 = CT
}

export interface TimelinePosition {
  t: number;               // tick
  x: number;
  y: number;
  yaw: number;
  alive: boolean;
  hp: number;
  w?: string;              // active weapon name (e.g. "ak47", "awp")
  ar?: number;             // armor value (0-100)
  hl?: boolean;            // has helmet
  tn?: number;             // team_num at this tick (2=T, 3=CT) — swaps at halftime
  inv?: string[];          // full inventory (e.g. ["ak47", "glock", "smokegrenade"])
  eq?: number;             // equipment value ($)
  cs?: number;             // cash spent this round ($)
  // Per-round aggregate snapshots — diff between round-end samples to get
  // real per-round DMG / ADR / assists etc. Absent on older cached timelines.
  dmg?: number;            // damage_total
  utildmg?: number;        // utility_damage_total
  ast?: number;            // assists_total
  hsk?: number;            // headshot_kills_total
  flashed?: number;        // enemies_flashed_total
  ktot?: number;           // kills_total
  dtot?: number;           // deaths_total
  atime?: number;          // alive_time_total (seconds summed)
  sf?: number;             // shots_fired
  // Per-tick state — drives map-view player-model polish
  fd?: number;             // flash_duration (seconds remaining)
  sc?: boolean;            // is_scoped
  wlk?: boolean;           // is_walking
  cr?: boolean;            // in_crouch
  dfu?: boolean;           // is_defusing
}

export interface TimelineGrenade {
  type: string;
  thrower: string;         // steamid
  points: number[][];      // [[tick, x, y], ...]
  detonate_tick: number | null;
}

export interface TimelineEvent {
  type: string;            // death | fire | bomb_plant | bomb_defuse | round_start | round_end
  tick: number;
  data: Record<string, string>;
}

export interface TimelineRound {
  num: number;
  start_tick: number;
  /** Tick where freeze (buy phase) actually ended — use this as the anchor
   *  when aligning rounds, since tactical timeouts extend freeze without
   *  shifting start_tick. Null on demos parsed before cache_version 3. */
  freeze_end_tick: number | null;
  end_tick: number;
  winner: string | null;
}

export interface MatchTimeline {
  map_name: string;
  tick_rate: number;
  decimation: number;
  tick_max: number;
  players: TimelinePlayer[];
  positions: Record<string, TimelinePosition[]>;
  grenades: TimelineGrenade[];
  events: TimelineEvent[];
  rounds: TimelineRound[];
}

export interface MatchInsightsResponse {
  demo_file: string;
  summary: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Execute detection (coordinated utility combos)
// ---------------------------------------------------------------------------

export interface ExecuteComboMember {
  cluster_id: number;
  grenade_type: string;
  label: string | null;
}

export interface ExecuteCombo {
  execute_id: number;
  map_name: string;
  name: string;
  members: ExecuteComboMember[];
  occurrence_count: number;
  round_win_rate: number;
  side: string | null;
  grenade_summary: string;
}

export const getExecutes = async (mapName: string): Promise<ExecuteCombo[]> => {
  const { data } = await api.get<ExecuteCombo[]>(`/executes/${mapName}`);
  return data;
};

// ---------------------------------------------------------------------------
// AI lineup description
// ---------------------------------------------------------------------------

export interface LineupDescriptionResponse {
  cluster_id: number;
  map_name: string;
  description: string;
  model: string;
}

export const describeLineup = async (
  clusterId: number,
  mapName: string,
): Promise<LineupDescriptionResponse> => {
  const { data } = await api.post<LineupDescriptionResponse>(
    `/lineups/${clusterId}/describe`,
    null,
    { params: { map_name: mapName } },
  );
  return data;
};

// ---------------------------------------------------------------------------
// Match replay (full-match 2D viewer)
// ---------------------------------------------------------------------------

export interface MatchRosterEntry {
  name: string;
  hltv_id: number | null;
}

export interface MatchTeamInfo {
  name: string;
  players: string[];
  // Present on rosters scraped after HLTV-ID capture was added. Older
  // roster sidecars only have `players` (string names).
  players_detailed?: MatchRosterEntry[];
  logo?: string;
}

export interface MatchInfoResponse {
  demo_file: string;
  match_id: number | null;
  map_name: string;
  team1: MatchTeamInfo | null;
  team2: MatchTeamInfo | null;
  event: string | null;
  date: string | null;
}

export const getMatchInfo = async (
  demoFile: string,
): Promise<MatchInfoResponse> => {
  const { data } = await api.get<MatchInfoResponse>(
    `/match-info/${encodeURIComponent(demoFile)}`,
  );
  return data;
};

// HLTV player-id lookup, aggregated across every roster sidecar in the
// demo directory. Returns a lowercase-name → hltv_id map; frontend uses
// it to build body-shot image URLs for `PlayerAvatar`.
export interface PlayerHltvIdsResponse {
  players: Record<string, number>;
  count: number;
}

export const getPlayerHltvIds = async (): Promise<PlayerHltvIdsResponse> => {
  const { data } = await api.get<PlayerHltvIdsResponse>("/player-hltv-ids");
  return data;
};

export const getMatchReplayDemos = async (): Promise<MatchDemoEntry[]> => {
  const { data } = await api.get<MatchDemoEntry[]>("/match-replay/demos");
  return data;
};

export const uploadDemo = async (
  file: File,
  onProgress?: (pct: number) => void,
): Promise<MatchDemoEntry> => {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<MatchDemoEntry>("/match-replay/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
    },
    timeout: 600000, // 10 min for large demos
  });
  return data;
};

export const deleteDemo = async (demoFile: string): Promise<void> => {
  await api.delete(`/match-replay/${encodeURIComponent(demoFile)}`);
};

export const getMatchReplayTimeline = async (
  demoFile: string,
): Promise<MatchTimeline> => {
  const { data } = await api.get<MatchTimeline>(
    `/match-replay/${encodeURIComponent(demoFile)}/timeline`,
  );
  return data;
};

// Deletes only the cached timeline JSON (not the .dem). Used by the Insights
// tab's "Re-parse this demo" button to force a fresh parse that picks up the
// new aggregate-stat fields.
export const deleteMatchTimeline = async (
  demoFile: string,
): Promise<{ deleted_cache: boolean; demo_file: string }> => {
  const { data } = await api.delete(
    `/match-replay/${encodeURIComponent(demoFile)}/timeline`,
  );
  return data;
};

export const getMatchReplayInsights = async (
  demoFile: string,
): Promise<MatchInsightsResponse> => {
  const { data } = await api.post<MatchInsightsResponse>(
    `/match-replay/${encodeURIComponent(demoFile)}/insights`,
  );
  return data;
};

// ---------------------------------------------------------------------------
// CS2 replay integration (settings + demo junction)
// ---------------------------------------------------------------------------

export interface Cs2PathResponse {
  configured_path: string | null;
  detected_path: string | null;
  active_path: string | null;
  link_active: boolean;
  link_path: string | null;
  link_name: string;
}

export const getCs2Path = async (): Promise<Cs2PathResponse> => {
  const { data } = await api.get<Cs2PathResponse>("/settings/cs2-path");
  return data;
};

export const setCs2Path = async (
  cs2GameDir: string,
): Promise<{ status: string; cs2_game_dir: string }> => {
  const { data } = await api.post("/settings/cs2-path", {
    cs2_game_dir: cs2GameDir,
  });
  return data;
};

export const linkDemosToCs2 = async (): Promise<{
  status: string;
  link_path: string;
}> => {
  const { data } = await api.post("/demos/link-to-cs2");
  return data;
};

export const unlinkDemosFromCs2 = async (): Promise<{
  status: string;
}> => {
  const { data } = await api.delete("/demos/link-to-cs2");
  return data;
};

// ---------------------------------------------------------------------------
// Player profiles
// ---------------------------------------------------------------------------

export interface PlayerProfileSummary {
  steamid: string;
  name: string;
  matches: number;
  rounds_played: number;
  kills: number;
  deaths: number;
  hs_kills: number;
  opening_kills: number;
  opening_deaths: number;
  rounds_alive: number;
  awp_kills: number;
  smokes_thrown: number;
  flashes_thrown: number;
  hes_thrown: number;
  molos_thrown: number;
  multi_2k: number;
  multi_3k: number;
  multi_4k: number;
  multi_5k: number;
  kd_ratio: number;
  hs_pct: number;
  opening_wr: number;
  survival_rate: number;
  rating: number;
  role: string;
}

export interface PlayerSideSplit {
  side: string;
  rounds_played: number;
  kills: number;
  deaths: number;
  opening_kills: number;
  opening_deaths: number;
  rounds_alive: number;
}

export interface PlayerMapSplit {
  map_name: string;
  matches: number;
  rounds_played: number;
  kills: number;
  deaths: number;
  rounds_alive: number;
  opening_kills: number;
  opening_deaths: number;
}

export interface PlayerDemoEntry {
  demo_file: string;
  map_name: string;
  kills: number;
  deaths: number;
  rounds_played: number;
}

export interface PlayerProfileDetail {
  steamid: string;
  name: string;
  summary: PlayerProfileSummary;
  per_side: PlayerSideSplit[];
  per_map: PlayerMapSplit[];
  demos: PlayerDemoEntry[];
}

export const listPlayers = async (minMatches = 1): Promise<PlayerProfileSummary[]> => {
  const { data } = await api.get<PlayerProfileSummary[]>("/players", {
    params: { min_matches: minMatches },
  });
  return data;
};

export const getPlayerDetail = async (steamid: string): Promise<PlayerProfileDetail> => {
  const { data } = await api.get<PlayerProfileDetail>(`/players/${steamid}`);
  return data;
};

export const refreshPlayerStats = async (): Promise<{
  scanned: number;
  rows_upserted: number;
  errors: number;
}> => {
  const { data } = await api.post("/players/refresh");
  return data;
};

// Re-scrape every existing roster sidecar so older ones pick up newly
// captured fields (HLTV player ids, team logos). Long-running — the
// backend respects HLTV's rate-limit delay between match-page fetches.
export interface RefreshRostersResponse {
  checked: number;
  refreshed: number;
  skipped: number;
  failed: number;
}
export const refreshRosters = async (): Promise<RefreshRostersResponse> => {
  const { data } = await api.post<RefreshRostersResponse>(
    "/rosters/refresh",
    null,
    { timeout: 600_000 },  // 10 min — up to ~3s per roster at HLTV pace
  );
  return data;
};

// Wipe the on-disk player-photo cache. Next render re-fetches every
// image via the scrape-first strategy, so users see whatever photos
// HLTV is displaying on its site *right now*.
export const clearPlayerPhotos = async (): Promise<{ deleted: number }> => {
  const { data } = await api.post<{ deleted: number }>("/player-photos/clear");
  return data;
};

// Kick off the background photo-warming task. Returns immediately with
// the total count so the UI can render "Loading images (0/N)…". Poll
// `warmPlayerPhotosStatus()` for progress updates until `running: false`.
export interface WarmPlayerPhotosStartResponse {
  started: boolean;
  running: boolean;
  done: number;
  total: number;
}
export const warmPlayerPhotos = async (): Promise<WarmPlayerPhotosStartResponse> => {
  const { data } = await api.post<WarmPlayerPhotosStartResponse>(
    "/player-photos/warm",
  );
  return data;
};

export interface WarmPlayerPhotosStatus {
  running: boolean;
  done: number;
  total: number;
  ok: number;
  missing: number;
  errors: number;
  // Server-side cache-generation counter. Bumps every time the photo
  // cache is cleared. Frontend uses it as the `?v=N` cache-bust on
  // every avatar URL so the browser HTTP cache invalidates whenever
  // the server wipes — even when the user reloads instead of clicking
  // Refresh.
  generation: number;
}
export const warmPlayerPhotosStatus = async (): Promise<WarmPlayerPhotosStatus> => {
  const { data } = await api.get<WarmPlayerPhotosStatus>(
    "/player-photos/warm/status",
  );
  return data;
};
