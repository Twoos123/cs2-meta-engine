/**
 * CS2 Game State Integration (live radar) API.
 *
 * Live state arrives over Server-Sent Events (`/api/gsi/stream`); if the
 * stream can't be kept open the subscriber falls back to polling `/state`.
 */
import { api, apiErrorMessage } from "./client";

export { apiErrorMessage };

export type GsiMode = "spectator" | "playing" | "menu" | "none";
export type GsiTeamSide = "CT" | "T";

export interface GsiPlayer {
  steamid: string;
  name: string;
  team: GsiTeamSide | null;
  observer_slot: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  /** degrees, 0 = +X, 90 = +Y (world space) */
  yaw: number | null;
  hp: number;
  armor: number;
  helmet: boolean;
  defuser: boolean;
  money: number | null;
  equip_value: number | null;
  flashed: number;
  burning: number;
  round_kills: number;
  active_weapon: string | null;
  weapon_type: string | null;
  ammo_clip: number | null;
  ammo_reserve: number | null;
  primary: string | null;
  secondary: string | null;
  utility: string[];
  has_bomb: boolean;
  kills: number | null;
  assists: number | null;
  deaths: number | null;
  mvps: number | null;
  score: number | null;
  alive: boolean;
  observed: boolean;
  is_self: boolean;
}

export interface GsiTeam {
  score: number;
  name: string | null;
  timeouts_remaining: number | null;
  consecutive_round_losses: number | null;
}

export interface GsiBomb {
  state: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  carrier: string | null;
  countdown: number | null;
}

export interface GsiGrenade {
  id: string;
  type: string;
  owner: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  lifetime: number | null;
  effecttime: number | null;
  flames: number[][];
}

export interface GsiState {
  mode: GsiMode;
  map?: string | null;
  game_mode?: string | null;
  map_phase?: string | null;
  round?: number | null;
  round_phase?: string | null;
  round_winner?: GsiTeamSide | null;
  phase?: string | null;
  phase_ends_in?: number | null;
  ct?: GsiTeam;
  t?: GsiTeam;
  round_wins?: Record<string, string>;
  players: GsiPlayer[];
  observed_steamid?: string | null;
  self_steamid?: string | null;
  bomb?: GsiBomb | null;
  grenades: GsiGrenade[];
  provider?: Record<string, unknown> | null;
  received_at?: number | null;
  seq: number;
  age_seconds: number | null;
}

export interface GsiStatus {
  connected: boolean;
  last_payload_age: number | null;
  payloads_received: number;
  payloads_rejected: number;
  mode: GsiMode | null;
  map: string | null;
  provider: Record<string, unknown> | null;
  cs2_dir_found: boolean;
  cfg_installed: boolean;
  cfg_path: string | null;
  cfg_token_matches: boolean | null;
  cfg_uri: string | null;
  default_uri: string;
}

export interface GsiInstallResult {
  status: string;
  path: string;
  uri: string;
  restart_required: boolean;
  message: string;
}

export const getGsiState = async (): Promise<GsiState> => {
  const { data } = await api.get<GsiState>("/gsi/state");
  return data;
};

export const getGsiStatus = async (): Promise<GsiStatus> => {
  const { data } = await api.get<GsiStatus>("/gsi/status");
  return data;
};

export const getGsiConfig = async (uri?: string): Promise<string> => {
  const { data } = await api.get<string>("/gsi/config", {
    params: uri ? { uri } : undefined,
    responseType: "text",
    transformResponse: (d) => d,
  });
  return data;
};

export const installGsiConfig = async (uri?: string): Promise<GsiInstallResult> => {
  const { data } = await api.post<GsiInstallResult>("/gsi/install", { uri: uri || null });
  return data;
};

export type GsiTransport = "sse" | "poll" | "connecting";

/** The server sends a `ping` event every 10s; silence beyond this means
 *  the stream is dead even if the browser hasn't noticed. */
const SSE_SILENCE_MS = 15000;

/**
 * Subscribe to live state. Uses SSE and drops to 250ms polling only if the
 * stream never manages to open. Returns an unsubscribe function.
 *
 * EventSource gives up for good (readyState CLOSED) when a reconnect gets a
 * non-200 — which is what the dev proxy returns while the backend reloads —
 * so reconnection is handled here rather than left to the browser.
 */
export function subscribeGsi(
  onState: (s: GsiState) => void,
  onTransport?: (t: GsiTransport) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let pollTimer: number | null = null;
  let retryTimer: number | null = null;
  let watchdog: number | null = null;
  let everOpened = false;
  let failures = 0;
  let lastMessage = Date.now();

  const clearTimers = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (watchdog !== null) window.clearInterval(watchdog);
    retryTimer = watchdog = null;
  };

  const startPolling = () => {
    if (closed || pollTimer !== null) return;
    es?.close();
    es = null;
    clearTimers();
    onTransport?.("poll");
    const tick = async () => {
      if (closed) return;
      try {
        onState(await getGsiState());
      } catch {
        // backend reloading — keep trying
      }
      if (!closed) pollTimer = window.setTimeout(tick, 250);
    };
    pollTimer = window.setTimeout(tick, 0);
  };

  const reconnect = () => {
    es?.close();
    es = null;
    if (closed || retryTimer !== null) return;
    failures += 1;
    // Never opened after a few tries → SSE is blocked on this path; poll.
    if (!everOpened && failures >= 4) return startPolling();
    onTransport?.("connecting");
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      startSse();
    }, Math.min(1000 * failures, 5000));
  };

  const startSse = () => {
    if (closed) return;
    if (typeof EventSource === "undefined") return startPolling();
    const src = new EventSource("/api/gsi/stream");
    es = src;
    lastMessage = Date.now();
    src.onopen = () => {
      everOpened = true;
      failures = 0;
      lastMessage = Date.now();
      onTransport?.("sse");
    };
    src.addEventListener("state", (ev) => {
      lastMessage = Date.now();
      try {
        onState(JSON.parse((ev as MessageEvent<string>).data) as GsiState);
      } catch {
        // ignore a malformed frame
      }
    });
    src.addEventListener("ping", () => {
      lastMessage = Date.now();
    });
    src.onerror = () => {
      // CONNECTING = the browser is retrying by itself (normal when the
      // server recycles the stream). CLOSED = it gave up; we take over.
      if (src.readyState === EventSource.CLOSED) reconnect();
    };
  };

  watchdog = window.setInterval(() => {
    if (es && Date.now() - lastMessage > SSE_SILENCE_MS) reconnect();
  }, 2000);

  // Prime with the current state so the page renders immediately.
  getGsiState().then((s) => !closed && onState(s)).catch(() => {});
  onTransport?.("connecting");
  startSse();

  return () => {
    closed = true;
    es?.close();
    clearTimers();
    if (pollTimer !== null) window.clearTimeout(pollTimer);
  };
}
