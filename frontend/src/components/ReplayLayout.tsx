/**
 * ReplayLayout — wrapper for all replay sub-views.
 *
 * Loads the timeline, radar, and match info once (shared across tabs).
 * Provides a tab bar: Replay | Insights | Economy | Heatmap | Stats | Compare
 * Renders the active sub-view via nested Routes.
 */
import { useEffect, useState } from "react";
import { NavLink, Routes, Route, useParams, useNavigate } from "react-router-dom";
import {
  DemoMeta,
  MatchInfoResponse,
  MatchTimeline,
  RadarInfo,
  apiErrorMessage,
  getDemoMeta,
  getMatchInfo,
  getMatchReplayTimeline,
  getRadarInfo,
} from "../api/client";
import MatchReplayViewer, { LiveReplayStatus } from "./MatchReplayViewer";
import EconomyPanel from "./EconomyPanel";
import HeatmapPanel from "./HeatmapPanel";
import StatsPanel from "./StatsPanel";
import InsightsPanel from "./InsightsPanel";
import ComparePanel from "./ComparePanel";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";

const TABS = [
  { to: "", label: "Replay", end: true },
  { to: "insights", label: "Insights", end: false },
  { to: "economy", label: "Economy", end: false },
  { to: "heatmap", label: "Heatmap", end: false },
  { to: "stats", label: "Stats", end: false },
  { to: "compare", label: "Compare", end: false },
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
  // Lightweight demo metadata (cache state, completeness, final score).
  // `null` = unknown (still loading, or the endpoint failed) — every
  // consumer must degrade gracefully when it's missing.
  const [meta, setMeta] = useState<DemoMeta | null>(null);
  // True while the Insights tab's "re-parse" is running, so the loading
  // screen says "Re-parsing" instead of trusting the stale cache flag.
  const [reparsing, setReparsing] = useState(false);
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
    setMeta(null);
    setReparsing(false);

    getMatchInfo(demoFile)
      .then((mi) => { if (!cancelled) setMatchInfo(mi); })
      .catch(() => {});

    // Fired in parallel with the timeline fetch — never blocks it. A failed
    // call (e.g. older backend without /meta) just leaves meta unknown.
    getDemoMeta(demoFile)
      .then((m) => { if (!cancelled) setMeta(m); })
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
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(apiErrorMessage(e, "Failed to load timeline"));
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
      <div className="flex flex-col items-center justify-center h-screen gap-4 px-4 text-center">
        <p className="text-cs2-red break-words max-w-full">{error}</p>
        <button onClick={() => navigate("/replay")} className="hud-btn">
          ← Back to picker
        </button>
      </div>
    );
  }

  if (!timeline) {
    // Pick the loading copy from the (non-blocking) meta call: a cached
    // timeline only needs downloading, an uncached one is parsed from the
    // .dem first. Unknown meta (still in flight / endpoint missing) gets a
    // neutral message rather than a possibly-wrong promise.
    const loadingMsg = reparsing
      ? "Re-parsing demo (this can take 5–15s)…"
      : meta?.timeline_cached === true
        ? "Loading replay…"
        : meta?.timeline_cached === false
          ? "Parsing demo (this can take 5–15s on first open)…"
          : "Loading demo…";
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 px-4 text-center">
        <div className="w-8 h-8 border-2 border-cs2-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-cs2-muted">{loadingMsg}</p>
        <button onClick={() => navigate("/replay")} className="hud-btn text-xs mt-2">
          ← Back
        </button>
      </div>
    );
  }

  // HLTV sometimes splits a match across several .dem files; this one stops
  // before the match did. Small, non-blocking notice next to the matchup.
  const partialBadge = meta?.complete === false ? (
    <span
      className="inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-300 cursor-help"
      title={
        "This demo file ends before the match did — HLTV split the match " +
        "across multiple demo files. Rounds after the cut-off aren't in " +
        "this replay, so scores and stats only cover the recorded part."
      }
    >
      <span aria-hidden>⚠</span>
      Partial demo
      {meta.score && (
        <span className="font-mono tracking-normal text-amber-200">
          — ends {meta.score[0]}–{meta.score[1]}
        </span>
      )}
    </span>
  ) : null;

  return (
    // < lg (phones/tablets): the page scrolls as a whole and every sub-view
    // takes its natural height. lg+: fixed viewport-height shell where the
    // sub-views manage their own scrolling (the original desktop layout).
    <div className="relative min-h-screen lg:h-screen flex flex-col lg:overflow-hidden bg-[#05070d]">
      <AppBackdrop tone="green" />
      <AppHeader />

      {/* Replay sub-bar — tabs + live matchup.
          < lg: stacked rows — a horizontally scrollable tab strip, then the
                matchup pill (+ partial-demo notice), so nothing can overlap.
          lg+: one row on a [tabs | pill | notice] grid. The side columns
               are 1fr each so the pill stays truly centered whenever it
               fits; the tabs and notice columns never shrink below their
               content and only the pill column can shrink (names truncate),
               so a long matchup is pushed/truncated instead of overlapping. */}
      <nav className="relative z-10 shrink-0 flex flex-col gap-2 px-3 py-2 border-b border-white/5 bg-white/[0.015] backdrop-blur-md lg:grid lg:grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] lg:items-center lg:gap-2 lg:px-4 lg:py-2.5">
        <div
          className="min-w-0 -mx-3 px-3 flex items-center gap-1 overflow-x-auto whitespace-nowrap lg:mx-0 lg:px-0 lg:overflow-visible lg:justify-self-start"
          style={{ scrollbarWidth: "none" }}
        >
          <button
            onClick={() => navigate("/replay")}
            className="hud-btn text-sm py-1 px-3 mr-1 shrink-0"
            title="Back to demo picker"
            aria-label="Back to demo picker"
          >
            ←
          </button>
          {TABS.map((tab) => (
            <NavLink
              key={tab.label}
              to={tab.to ? `${basePath}/${tab.to}` : basePath}
              end
              className={({ isActive }) =>
                `hud-tab shrink-0 ${isActive ? "hud-tab-active" : "hud-tab-idle"}`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>

        {/* Matchup pill + partial notice. Below lg they share one wrapping,
            centered row; on lg+ `contents` dissolves this wrapper so both
            children become cells of the parent grid (center / right). */}
        <div className="min-w-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 lg:contents">
          <div className="min-w-0 max-w-full flex flex-col items-center pointer-events-none">
            {matchInfo?.team1 && matchInfo?.team2 ? (
              <>
                <div className="flex items-center gap-2 lg:gap-3 min-w-0 max-w-full">
                  {matchInfo.team1.logo && (
                    <img src={matchInfo.team1.logo} alt="" className="hidden md:block w-7 h-7 lg:w-8 lg:h-8 object-contain shrink-0" />
                  )}
                  <span className="min-w-0 text-sm lg:text-base font-bold uppercase tracking-[0.06em] truncate"
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
                  <span className="min-w-0 text-sm lg:text-base font-bold uppercase tracking-[0.06em] truncate"
                    style={{ color: liveStatus ? (liveStatus.team1CurrentSide === 2 ? "#5B9BD5" : "#DCBF6E") : "#fff" }}>
                    {matchInfo.team2.name}
                  </span>
                  {matchInfo.team2.logo && (
                    <img src={matchInfo.team2.logo} alt="" className="hidden md:block w-7 h-7 lg:w-8 lg:h-8 object-contain shrink-0" />
                  )}
                </div>
                <div className="hidden lg:flex items-center gap-3 text-[10px] uppercase tracking-[0.15em] text-cs2-muted/80 mt-0.5 font-mono max-w-full overflow-hidden">
                  {matchInfo.event && <span className="min-w-0 truncate max-w-[200px]">{matchInfo.event}</span>}
                  {liveStatus && (
                    <>
                      <span className="text-cs2-accent shrink-0">Round {liveStatus.round}</span>
                      <span className="shrink-0">{liveStatus.mapName} · {liveStatus.currentTimeStr} / {liveStatus.totalTimeStr}</span>
                      {liveStatus.bomb && (
                        <span className="text-cs2-red animate-pulse shrink-0">
                          💣 {liveStatus.bomb.site} · {liveStatus.bomb.remaining.toFixed(0)}s
                        </span>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : (
              <span className="block text-[10px] text-cs2-muted/60 font-mono truncate max-w-full lg:max-w-[400px]">{demoFile}</span>
            )}
          </div>

          {/* Right zone — partial-demo notice (empty otherwise; on lg+ it
              still balances the tabs column so the pill stays centered). */}
          <div className="min-w-0 flex justify-center lg:justify-end lg:justify-self-end">
            {partialBadge}
          </div>
        </div>
      </nav>

      {/* Sub-views */}
      <div className="flex-1 lg:min-h-0 lg:overflow-hidden">
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
                  setReparsing(true);
                  setTimeline(null);
                  getMatchReplayTimeline(demoFile)
                    .then(setTimeline)
                    .catch((e: unknown) => setError(apiErrorMessage(e, "Failed to reload timeline")))
                    .finally(() => setReparsing(false));
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
          <Route
            path="compare"
            element={<ComparePanel timeline={timeline} radar={radar} demoFile={demoFile} />}
          />
        </Routes>
      </div>
    </div>
  );
}
