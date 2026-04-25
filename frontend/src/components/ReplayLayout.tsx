/**
 * ReplayLayout — wrapper for all replay sub-views.
 *
 * Loads the timeline, radar, and match info once (shared across tabs).
 * Provides a tab bar: Replay | Economy | Heatmap | Stats
 * Renders the active sub-view via nested Routes.
 */
import { useEffect, useState } from "react";
import { NavLink, Routes, Route, useParams, useNavigate } from "react-router-dom";
import {
  MatchInfoResponse,
  MatchTimeline,
  RadarInfo,
  getMatchInfo,
  getMatchReplayTimeline,
  getRadarInfo,
} from "../api/client";
import MatchReplayViewer, { LiveReplayStatus } from "./MatchReplayViewer";
import EconomyPanel from "./EconomyPanel";
import HeatmapPanel from "./HeatmapPanel";
import StatsPanel from "./StatsPanel";
import InsightsPanel from "./InsightsPanel";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";

const TABS = [
  { to: "", label: "Replay", end: true },
  { to: "insights", label: "Insights", end: false },
  { to: "economy", label: "Economy", end: false },
  { to: "heatmap", label: "Heatmap", end: false },
  { to: "stats", label: "Stats", end: false },
] as const;

export default function ReplayLayout() {
  const { demoFile: rawDemoFile } = useParams();
  const demoFile = decodeURIComponent(rawDemoFile ?? "");
  const navigate = useNavigate();
  const basePath = `/replay/${encodeURIComponent(demoFile)}`;

  const [timeline, setTimeline] = useState<MatchTimeline | null>(null);
  const [radar, setRadar] = useState<RadarInfo | null>(null);
  const [matchInfo, setMatchInfo] = useState<MatchInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Live playback status published by MatchReplayViewer — score / round /
  // time / bomb update as the user scrubs or plays.
  const [liveStatus, setLiveStatus] = useState<LiveReplayStatus | null>(null);

  useEffect(() => {
    if (!demoFile) return;
    let cancelled = false;
    setError(null);
    setTimeline(null);
    setRadar(null);
    setMatchInfo(null);

    getMatchInfo(demoFile)
      .then((mi) => { if (!cancelled) setMatchInfo(mi); })
      .catch(() => {});

    getMatchReplayTimeline(demoFile)
      .then((t) => {
        if (cancelled) return;
        setTimeline(t);
        return getRadarInfo(t.map_name);
      })
      .then((r) => {
        if (cancelled || !r) return;
        setRadar(r);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail ?? "Failed to load timeline");
      });

    return () => { cancelled = true; };
  }, [demoFile]);

  if (!demoFile) {
    return (
      <div className="flex items-center justify-center h-screen text-cs2-muted">
        No demo file specified.
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <p className="text-cs2-red">{error}</p>
        <button onClick={() => navigate("/replay")} className="hud-btn">
          ← Back to picker
        </button>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3">
        <div className="w-8 h-8 border-2 border-cs2-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-cs2-muted">
          Parsing demo (this can take 5–15s on first open)…
        </p>
        <button onClick={() => navigate("/replay")} className="hud-btn text-xs mt-2">
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#05070d]">
      <AppBackdrop tone="green" />
      <AppHeader />

      {/* Replay sub-bar — tabs on the left, live matchup in the center.
          Sits BELOW the global AppHeader so primary navigation stays
          identical to every other page. */}
      <nav className="relative shrink-0 grid grid-cols-3 items-center gap-2 px-4 py-2.5 border-b border-white/5 bg-white/[0.015] backdrop-blur-md">
        <div className="shrink-0 flex items-center gap-1 justify-self-start">
          <button
            onClick={() => navigate("/replay")}
            className="hud-btn text-sm py-1 px-3 mr-1"
            title="Back to demo picker"
          >
            ←
          </button>
          {TABS.map((tab) => (
            <NavLink
              key={tab.label}
              to={tab.to ? `${basePath}/${tab.to}` : basePath}
              end
              className={({ isActive }) =>
                `hud-tab ${isActive ? "hud-tab-active" : "hud-tab-idle"}`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>

        {/* Center column — truly centered via 3-col grid (left/right zones
            are siblings, not floats, so the center column never offsets). */}
        <div className="min-w-0 flex flex-col items-center pointer-events-none">
          {matchInfo?.team1 && matchInfo?.team2 ? (
            <>
              <div className="flex items-center gap-2 lg:gap-3 min-w-0 max-w-full">
                {matchInfo.team1.logo && (
                  <img src={matchInfo.team1.logo} alt="" className="hidden md:block w-7 h-7 lg:w-8 lg:h-8 object-contain shrink-0" />
                )}
                <span className="text-sm lg:text-base font-bold uppercase tracking-[0.06em] truncate"
                  style={{ color: liveStatus ? (liveStatus.team1CurrentSide === 2 ? "#DCBF6E" : "#5B9BD5") : "#fff" }}>
                  {matchInfo.team1.name}
                </span>
                {liveStatus ? (
                  <span className="font-mono text-base lg:text-lg font-bold text-white tabular-nums shrink-0">
                    {liveStatus.team1Score} : {liveStatus.team2Score}
                  </span>
                ) : (
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-cs2-muted/60 shrink-0">vs</span>
                )}
                <span className="text-sm lg:text-base font-bold uppercase tracking-[0.06em] truncate"
                  style={{ color: liveStatus ? (liveStatus.team1CurrentSide === 2 ? "#5B9BD5" : "#DCBF6E") : "#fff" }}>
                  {matchInfo.team2.name}
                </span>
                {matchInfo.team2.logo && (
                  <img src={matchInfo.team2.logo} alt="" className="hidden md:block w-7 h-7 lg:w-8 lg:h-8 object-contain shrink-0" />
                )}
              </div>
              <div className="hidden lg:flex items-center gap-3 text-[10px] uppercase tracking-[0.15em] text-cs2-muted/80 mt-0.5 font-mono">
                {matchInfo.event && <span className="truncate max-w-[200px]">{matchInfo.event}</span>}
                {liveStatus && (
                  <>
                    <span className="text-cs2-accent">Round {liveStatus.round}</span>
                    <span>{liveStatus.mapName} · {liveStatus.currentTimeStr} / {liveStatus.totalTimeStr}</span>
                    {liveStatus.bomb && (
                      <span className="text-cs2-red animate-pulse">
                        💣 {liveStatus.bomb.site} · {liveStatus.bomb.remaining.toFixed(0)}s
                      </span>
                    )}
                  </>
                )}
              </div>
            </>
          ) : (
            <span className="text-[10px] text-cs2-muted/60 font-mono truncate max-w-[400px]">{demoFile}</span>
          )}
        </div>

        <div /> {/* right zone reserved — keeps the center truly centered */}
      </nav>

      {/* Sub-views */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Routes>
          <Route
            index
            element={
              <MatchReplayViewer
                demoFile={demoFile}
                timeline={timeline}
                radar={radar}
                matchInfo={matchInfo}
                onBack={() => navigate("/replay")}
                onLiveStatus={setLiveStatus}
              />
            }
          />
          <Route
            path="insights"
            element={
              <InsightsPanel
                timeline={timeline}
                radar={radar}
                matchInfo={matchInfo}
                demoFile={demoFile}
                onReloadTimeline={() => {
                  // Force the parent useEffect to refetch by resetting timeline.
                  // A more explicit approach would bump a counter dep, but the
                  // user clicked "re-parse" knowing the tab will reload.
                  setTimeline(null);
                  getMatchReplayTimeline(demoFile).then(setTimeline).catch(() => {});
                }}
              />
            }
          />
          <Route
            path="economy"
            element={<EconomyPanel timeline={timeline} radar={radar} matchInfo={matchInfo} />}
          />
          <Route
            path="heatmap"
            element={<HeatmapPanel timeline={timeline} radar={radar} />}
          />
          <Route
            path="stats"
            element={<StatsPanel timeline={timeline} matchInfo={matchInfo} />}
          />
        </Routes>
      </div>
    </div>
  );
}
