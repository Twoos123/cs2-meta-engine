/**
 * "Your throw vs the pro lineup" — compare a player's grenade throws in a
 * demo against the pro lineup database.
 */
import axios from "axios";
import { api, apiErrorMessage } from "./client";

export type ThrowQuality = "on-point" | "close" | "off";

export interface CompareMatch {
  lineup_id: number | null;
  label: string;
  side: string | null;
  throw_count: number;
  round_win_rate: number | null;
  technique: string | null;
  pro_throw_x: number;
  pro_throw_y: number;
  pro_throw_z: number | null;
  pro_land_x: number | null;
  pro_land_y: number | null;
  pro_land_z: number | null;
  pro_pitch: number;
  pro_yaw: number;
  /** + = you stood further forward along the pro's facing direction. */
  offset_forward: number;
  /** + = you stood to the pro's right, − = left. */
  offset_right: number;
  /** + = you stood higher. */
  offset_vertical: number;
  throw_distance: number;
  /** yours − pro's; + = aimed lower (pitch is positive looking down). */
  pitch_delta: number;
  /** yours − pro's; + = aimed further left (yaw is CCW from +x). */
  yaw_delta: number;
  land_distance: number;
  /** + = landed long (further along the pro's flight line), − = short. */
  land_along: number | null;
  land_across: number | null;
  quality: ThrowQuality;
  summary: string;
}

export interface CompareThrow {
  tick: number;
  round_number: number;
  grenade_type: string;
  side: "T" | "CT" | null;
  technique: string | null;
  throw_x: number;
  throw_y: number;
  throw_z: number;
  land_x: number | null;
  land_y: number | null;
  land_z: number | null;
  pitch: number;
  yaw: number;
  matched: CompareMatch | null;
  no_match_reason: string | null;
}

export interface ComparePlayer {
  steamid: string;
  name: string;
  throws: number;
}

export interface CompareResponse {
  demo_file: string;
  map_name: string;
  steamid: string | null;
  player_name: string | null;
  has_lineup_data: boolean;
  lineup_count: number;
  message: string | null;
  players: ComparePlayer[];
  throws: CompareThrow[];
  matched_count: number;
}

export const getCompare = async (demoFile: string, steamid: string): Promise<CompareResponse> => {
  const { data } = await api.get<CompareResponse>(`/compare/${encodeURIComponent(demoFile)}`, {
    params: { steamid },
    // First call parses the demo (5–15s); allow plenty of headroom.
    timeout: 120_000,
  });
  return data;
};

/** The user's own SteamID64 from the import settings, or null when unset or
 *  when the settings endpoint isn't available (404 on older backends). */
export const getMySteamId = async (): Promise<string | null> => {
  try {
    const { data } = await api.get<{ my_steamid?: string | null }>("/import/settings");
    const sid = (data?.my_steamid ?? "").trim();
    return sid || null;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 404) return null;
    console.warn(apiErrorMessage(e, "Could not read import settings"));
    return null;
  }
};

export { apiErrorMessage };
