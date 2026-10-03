/**
 * Match catalog (Liquipedia-backed) + player-photo attribution API.
 *
 * Catalog data comes from Liquipedia under CC-BY-SA 3.0 — every view that
 * shows it must credit Liquipedia (see `CatalogStatus.attribution`).
 */
import { api, apiErrorMessage } from "./client";

export { apiErrorMessage };

export type CatalogTier = "S" | "A" | "B" | "C" | "Qualifier" | "Showmatch" | "Weekly" | "Monthly" | "Misc";

export interface CatalogEventEntry {
  event: string;
  match_count: number;
  first_date_unix: number | null;
  last_date_unix: number | null;
  max_stars: number;
  big: boolean;
  tier: CatalogTier | null;
  source: "liquipedia" | "hltv";
  liquipedia_url: string | null;
}

export interface CatalogMatchEntry {
  match_key: string;           // stable: "lp:<hash>" or "hltv:<id>"
  match_id: number | null;     // HLTV match id when known
  source: "liquipedia" | "hltv";
  team1: string;
  team2: string;
  event: string;
  stage: string | null;
  date_unix: number | null;
  status: "upcoming" | "completed";
  best_of: number | null;
  tier: CatalogTier | null;
  stars: number;
  score1: number | null;
  score2: number | null;
  maps: string[];              // normalized tokens ("mirage", ...)
  demo_available: number;
  team1_logo: string | null;
  team2_logo: string | null;
  hltv_url: string | null;
  liquipedia_url: string | null;
  local_maps: string[];        // map tokens of the demos on disk
  local_demos: string[];       // .dem file names on disk
}

export interface CatalogStatus {
  running: boolean;
  phase: string;
  detail: string;
  last_refresh_unix: number | null;
  demo_disk_used_gb: number;
  demo_retention_gb: number;
  autopull_enabled: boolean;
  source: string;
  attribution: string;
  attribution_url: string;
}

export const getCatalogEvents = async (days = 45): Promise<CatalogEventEntry[]> => {
  const { data } = await api.get<CatalogEventEntry[]>("/catalog/events", {
    params: { days },
  });
  return data;
};

export const getCatalogMatches = async (
  params: {
    event?: string;
    team?: string;
    days?: number;
    status?: "upcoming" | "completed";
    limit?: number;
  } = {},
): Promise<CatalogMatchEntry[]> => {
  const { data } = await api.get<CatalogMatchEntry[]>("/catalog/matches", { params });
  return data;
};

export const getCatalogStatus = async (): Promise<CatalogStatus> => {
  const { data } = await api.get<CatalogStatus>("/catalog/status");
  return data;
};

export const refreshCatalog = async (): Promise<{ status: string }> => {
  const { data } = await api.post<{ status: string }>("/catalog/refresh");
  return data;
};

// ---------------------------------------------------------------------------
// Player photo attribution
// ---------------------------------------------------------------------------

export interface PhotoAttribution {
  key: string;
  available: boolean;
  source?: "liquipedia" | "hltv";
  license?: string | null;
  license_url?: string | null;
  author?: string | null;
  page_url?: string | null;
  file_page_url?: string | null;
  credit?: string | null;
  reasons?: string[];
}

export const playerPhotoUrl = (hltvId: number | null | undefined, name: string): string =>
  typeof hltvId === "number" && Number.isFinite(hltvId)
    ? `/api/player-photo/${hltvId}.png`
    : `/api/player-photo/by-name/${encodeURIComponent(name.trim())}.png`;

const attributionMemo = new Map<string, Promise<PhotoAttribution | null>>();

/** Attribution for a cached photo (memoized per session). */
export const getPhotoAttribution = (
  hltvId: number | null | undefined,
  name: string,
): Promise<PhotoAttribution | null> => {
  const path = playerPhotoUrl(hltvId, name).replace(/\.png$/, "/attribution");
  let p = attributionMemo.get(path);
  if (!p) {
    p = api
      .get<PhotoAttribution>(path.replace(/^\/api/, ""))
      .then((r) => r.data)
      .catch(() => {
        attributionMemo.delete(path);
        return null;
      });
    attributionMemo.set(path, p);
  }
  return p;
};
