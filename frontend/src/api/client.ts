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
  limit = 10
): Promise<TopLineupsResponse> => {
  const { data } = await api.get<TopLineupsResponse>(
    `/lineups/${mapName}/${grenadeType}`,
    { params: { limit } }
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
