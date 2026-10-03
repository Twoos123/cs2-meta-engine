/**
 * LivePage — live 2D radar fed by CS2 Game State Integration.
 *
 * CS2 POSTs game state to /api/gsi; this page subscribes over SSE (with a
 * polling fallback) and renders the radar + scoreboard. While spectating or
 * watching a demo CS2 sends all 10 players; while playing only your own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getRadarInfo, type RadarInfo } from "../api/client";
import {
  getGsiStatus,
  subscribeGsi,
  type GsiState,
  type GsiStatus,
  type GsiTransport,
} from "../api/gsi";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import LiveMatchBar from "./live/LiveMatchBar";
import LiveRadar from "./live/LiveRadar";
import LiveScoreboard from "./live/LiveScoreboard";
import LiveSetupCard from "./live/LiveSetupCard";
import { GONE_AFTER_S, STALE_AFTER_S } from "./live/liveUtils";

const STATUS_POLL_MS = 4000;

export default function LivePage() {
  const [state, setState] = useState<GsiState | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [transport, setTransport] = useState<GsiTransport>("connecting");
  const [status, setStatus] = useState<GsiStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [radar, setRadar] = useState<RadarInfo | null>(null);
  const [radarMissing, setRadarMissing] = useState(false);
  const seqRef = useRef<number | null>(null);

  // Live state stream.
  useEffect(
    () =>
      subscribeGsi((s) => {
        // Polling returns the same frame repeatedly — only take new ones.
        if (seqRef.current === s.seq && s.seq !== 0) return;
        seqRef.current = s.seq;
        setState(s);
        setReceivedAt(Date.now());
      }, setTransport),
    [],
  );

  // Clock for the phase timer + staleness.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const refreshStatus = useCallback(() => {
    getGsiStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = window.setInterval(refreshStatus, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  // Radar calibration for the current map.
  const mapName = state?.map ?? null;
  useEffect(() => {
    if (!mapName) return;
    let cancelled = false;
    setRadarMissing(false);
    getRadarInfo(mapName)
      .then((r) => !cancelled && setRadar(r))
      .catch(() => {
        if (cancelled) return;
        setRadar(null);
        setRadarMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mapName]);

  const age =
    state && state.age_seconds != null
      ? state.age_seconds + Math.max(0, now - receivedAt) / 1000
      : null;
  const inGame = !!state && (state.mode === "spectator" || state.mode === "playing") && !!state.map;
  const live = inGame && age != null && age < GONE_AFTER_S;
  const stale = age != null && age > STALE_AFTER_S;
  const inMenu = !!state && state.mode === "menu" && age != null && age < GONE_AFTER_S;
  const radarForMap = radar && radar.map_name === mapName ? radar : null;

  return (
    <div className="relative min-h-screen bg-cs2-bg overflow-x-hidden">
      <AppBackdrop />
      <AppHeader />
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <span className="section-eyebrow">LIVE</span>
            <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-white">Live radar</h1>
          </div>
          <StatusPill live={live} stale={stale} inMenu={inMenu} age={age} transport={transport} />
        </div>

        {live && state ? (
          <>
            <div className="mt-5">
              <LiveMatchBar state={state} age={age ?? 0} stale={stale} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] items-start">
              <div className="hud-panel p-2 sm:p-3 min-w-0">
                <div className="mx-auto w-full lg:max-w-[calc(100vh-12rem)]">
                  <LiveRadar state={state} radar={radarForMap} radarMissing={radarMissing} stale={stale} />
                </div>
              </div>
              <LiveScoreboard state={state} />
            </div>
            <details className="mt-6 group">
              <summary className="cursor-pointer select-none text-xs text-cs2-muted hover:text-cs2-accent w-fit">
                Setup &amp; config
              </summary>
              <div className="mt-3 max-w-2xl">
                <LiveSetupCard status={status} onInstalled={refreshStatus} compact />
              </div>
            </details>
          </>
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start">
            <WaitingPanel inMenu={inMenu} status={status} age={age} />
            <LiveSetupCard status={status} onInstalled={refreshStatus} />
          </div>
        )}
      </main>
    </div>
  );
}

function StatusPill({
  live,
  stale,
  inMenu,
  age,
  transport,
}: {
  live: boolean;
  stale: boolean;
  inMenu: boolean;
  age: number | null;
  transport: GsiTransport;
}) {
  let label = "Waiting for CS2";
  let tone = "border-white/10 text-gray-300 bg-white/5";
  let dot = "bg-gray-400 animate-pulse";
  if (live && !stale) {
    label = "Receiving";
    tone = "border-emerald-400/40 text-emerald-300 bg-emerald-400/10";
    dot = "bg-emerald-400 animate-pulse";
  } else if (live && stale) {
    label = `No update for ${Math.floor(age ?? 0)}s`;
    tone = "border-amber-300/50 text-amber-200 bg-amber-300/10";
    dot = "bg-amber-300";
  } else if (inMenu) {
    label = "Connected · in menu";
    tone = "border-cyan-400/40 text-cyan-200 bg-cyan-400/10";
    dot = "bg-cyan-300";
  }
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}>
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {label}
      </span>
      <span className="hidden sm:inline text-[10px] uppercase tracking-wider text-cs2-muted" title="Update transport">
        {transport === "sse" ? "SSE" : transport === "poll" ? "Polling" : "…"}
      </span>
    </div>
  );
}

function WaitingPanel({
  inMenu,
  status,
  age,
}: {
  inMenu: boolean;
  status: GsiStatus | null;
  age: number | null;
}) {
  return (
    <section className="hud-panel p-5 sm:p-6 min-w-0">
      <div className="flex items-center gap-3">
        <span className="relative flex h-3 w-3 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-400" />
        </span>
        <h2 className="text-lg font-semibold text-white">
          {inMenu ? "CS2 connected" : "Waiting for CS2"}
        </h2>
      </div>
      <p className="mt-3 text-sm text-gray-400">
        {inMenu
          ? "CS2 is sending data but isn't in a match. Spectate a game, join GOTV or play a demo to see the radar."
          : "The radar appears as soon as CS2 posts game state to this server. Spectating, GOTV or a demo shows all 10 players; playing shows only you."}
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
        <Stat label="Config" value={status ? (status.cfg_installed ? "Installed" : "Not installed") : "…"}
          tone={status?.cfg_installed ? "text-cs2-green" : "text-gray-300"} />
        <Stat label="CS2 folder" value={status ? (status.cs2_dir_found ? "Found" : "Not found") : "…"}
          tone={status?.cs2_dir_found ? "text-cs2-green" : "text-amber-300"} />
        <Stat label="Last update"
          value={age != null ? `${age < 120 ? age.toFixed(0) + "s" : Math.round(age / 60) + "m"} ago` : "Never"} />
        <Stat label="Payloads" value={status ? String(status.payloads_received) : "…"} />
      </dl>
    </section>
  );
}

function Stat({ label, value, tone = "text-gray-200" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-cs2-muted">{label}</dt>
      <dd className={`mt-0.5 font-medium truncate ${tone}`}>{value}</dd>
    </div>
  );
}
