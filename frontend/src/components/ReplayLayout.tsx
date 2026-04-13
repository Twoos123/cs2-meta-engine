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
import MatchReplayViewer from "./MatchReplayViewer";
import EconomyPanel from "./EconomyPanel";
import HeatmapPanel from "./HeatmapPanel";
import StatsPanel from "./StatsPanel";

const TABS = [
  { to: "", label: "Replay", end: true },
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
    <div className="h-screen flex flex-col overflow-hidden bg-[#05070d]">
      {/* Tab bar */}
      <nav className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-cs2-border/50 bg-[#0a0e18]">
        <button
          onClick={() => navigate("/replay")}
          className="hud-btn text-xs mr-2 py-1 px-2"
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
              `px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] rounded transition-all ${
                isActive
                  ? "bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/40 shadow-[0_0_10px_rgba(34,211,238,0.15)]"
                  : "text-cs2-muted hover:text-white border border-transparent hover:bg-cs2-border/20"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-cs2-muted/60 font-mono truncate max-w-[400px]">
          {matchInfo?.team1 && matchInfo?.team2 ? (
            <>
              {matchInfo.team1.logo && (
                <img src={matchInfo.team1.logo} alt="" className="w-4 h-4 object-contain shrink-0" />
              )}
              {matchInfo.team1.name}
              <span className="text-cs2-muted/40">vs</span>
              {matchInfo.team2.logo && (
                <img src={matchInfo.team2.logo} alt="" className="w-4 h-4 object-contain shrink-0" />
              )}
              {matchInfo.team2.name}
            </>
          ) : demoFile}
        </span>
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
