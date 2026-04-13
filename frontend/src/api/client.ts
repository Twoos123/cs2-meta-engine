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

export const getIngestionStatus = async () => {
  const { data } = await api.get("/ingest/status");
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

export interface MatchTeamInfo {
  name: string;
  players: string[];
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
