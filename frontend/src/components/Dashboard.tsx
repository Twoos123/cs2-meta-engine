/**
 * Dashboard — main view. HUD-styled layout.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Callout,
  clearAllData,
  getCallouts,
  getDownloadedDemos,
  getMaps,
  getTopLineups,
  DownloadedMap,
  LineupRanking,
} from "../api/client";
import LineupCard from "./LineupCard";
import ScatterPlot from "./ScatterPlot";
import IngestPanel from "./IngestPanel";
import RadarView from "./RadarView";

const GRENADE_TYPES = [
  { id: "smokegrenade", label: "Smoke" },
  { id: "hegrenade", label: "HE" },
  { id: "flashbang", label: "Flash" },
  { id: "molotov", label: "Molotov" },
];

const ALL_MAPS = [
  "de_mirage",
  "de_dust2",
  "de_inferno",
  "de_nuke",
  "de_ancient",
  "de_anubis",
  "de_vertigo",
  "de_overpass",
  "de_train",
];

export default function Dashboard() {
  const [selectedMap, setSelectedMap] = useState("de_mirage");
  const [selectedType, setSelectedType] = useState("smokegrenade");
  const [lineups, setLineups] = useState<LineupRanking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<number | undefined>();
  const [showIngest, setShowIngest] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [groupByThrowFrom, setGroupByThrowFrom] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [ingestedMaps, setIngestedMaps] = useState<Set<string>>(new Set());
  const [downloadedMaps, setDownloadedMaps] = useState<DownloadedMap[]>([]);

  useEffect(() => {
    getMaps()
      .then((m) => setIngestedMaps(new Set(m)))
      .catch(() => {});
    getDownloadedDemos()
      .then((d) => setDownloadedMaps(d.maps))
      .catch(() => {});
  }, [lineups]);

  const fetchLineups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getTopLineups(selectedMap, selectedType, 500);
      setLineups(res.lineups);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(detail ?? "Failed to fetch lineups");
      setLineups([]);
    } finally {
      setLoading(false);
    }
  }, [selectedMap, selectedType]);

  useEffect(() => {
    getCallouts(selectedMap)
      .then(setCallouts)
      .catch(() => setCallouts([]));
    setCollapsedGroups(new Set());
  }, [selectedMap]);

  const groupedLineups = useMemo(() => {
    if (!groupByThrowFrom || callouts.length === 0) return null;
    // Group by LANDING position (nearest callout to where the grenade actually
    // lands) — that's the spot a player wants to deny, so "B Site smokes" will
    // show every lineup that covers B regardless of where it was thrown from.
    const MAX_DIST_SQ = 1200 * 1200;
    const buckets = new Map<string, LineupRanking[]>();
    for (const r of lineups) {
      const lx = r.cluster.land_centroid_x;
      const ly = r.cluster.land_centroid_y;
      let bestName = "Unlabeled";
      let bestD2 = MAX_DIST_SQ;
      for (const c of callouts) {
        const dx = c.x - lx;
        const dy = c.y - ly;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestName = c.name;
        }
      }
      const pretty = bestName.replace(
        /([a-z])([A-Z])|([A-Z])([A-Z][a-z])/g,
        "$1$3 $2$4",
      );
      const arr = buckets.get(pretty) ?? [];
      arr.push(r);
      buckets.set(pretty, arr);
    }
    return Array.from(buckets.entries())
      .map(([name, items]) => ({
        name,
        items: items.sort((a, b) => a.rank - b.rank),
        totalImpact: items.reduce((s, r) => s + r.impact_score, 0),
      }))
      .sort((a, b) => b.totalImpact - a.totalImpact);
  }, [lineups, callouts, groupByThrowFrom]);

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  useEffect(() => {
    fetchLineups();
  }, [fetchLineups]);

  const handleClearData = async () => {
    if (
      !window.confirm(
        "Delete all analysed lineups from the database? Demo files on disk will be kept — you can re-run the pipeline without re-downloading.",
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      await clearAllData();
      setLineups([]);
      setSelectedClusterId(undefined);
      setIngestedMaps(new Set());
      setError(null);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(detail ?? "Failed to clear data");
    } finally {
      setClearing(false);
    }
  };

  const topWin = lineups[0]
    ? `${(lineups[0].cluster.round_win_rate * 100).toFixed(1)}%`
    : "—";

  return (
    <div className="min-h-screen text-cs2-text p-4 md:p-8 space-y-6 max-w-[1400px] mx-auto">
      {/* ── Header ── */}
      <header className="hud-panel hud-corner px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg border border-cs2-accent/60 flex items-center justify-center bg-cs2-accent/10 shadow-[0_0_20px_rgba(34,211,238,0.2)]">
            <span className="text-cs2-accent font-mono font-bold text-sm">CS2</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white tracking-tight leading-none">
              Meta Engine
            </h1>
            <p className="text-[11px] text-cs2-muted mt-1 tracking-wide">
              Pro lineup intelligence &middot; demoparser2 + clustering
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedMap}
            onChange={(e) => setSelectedMap(e.target.value)}
            className="hud-input min-w-[180px] cursor-pointer"
          >
            {downloadedMaps.length > 0 && (
              <optgroup label="Downloaded">
                {downloadedMaps.map((d) => (
                  <option key={d.map_name} value={d.map_name}>
                    {d.map_name} ({d.count})
                    {ingestedMaps.has(d.map_name) ? " ●" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="All maps">
              {ALL_MAPS.filter(
                (m) => !downloadedMaps.some((d) => d.map_name === m),
              ).map((m) => (
                <option key={m} value={m}>
                  {m}
                  {ingestedMaps.has(m) ? " ●" : ""}
                </option>
              ))}
            </optgroup>
          </select>

          <button
            onClick={() => setShowRadar(true)}
            disabled={lineups.length === 0}
            className="hud-btn"
            title={
              lineups.length === 0
                ? "No lineups loaded — ingest demos first"
                : "Show every unique lineup on a radar"
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cs2-accent" />
              Radar
            </span>
          </button>

          <button
            onClick={() => setShowIngest((s) => !s)}
            className={showIngest ? "hud-btn-primary" : "hud-btn"}
          >
            {showIngest ? "Hide Ingest" : "Ingest"}
          </button>

          <button
            onClick={handleClearData}
            disabled={clearing}
            className="hud-btn-danger"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        </div>
      </header>

      {/* ── Grenade type tabs ── */}
      <div className="flex gap-1.5 flex-wrap px-1">
        {GRENADE_TYPES.map((g) => (
          <button
            key={g.id}
            className={`hud-tab ${
              selectedType === g.id ? "hud-tab-active" : "hud-tab-idle"
            }`}
            onClick={() => setSelectedType(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* ── Top row: scatter + ingest/stats ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          {lineups.length > 0 ? (
            <ScatterPlot
              lineups={lineups}
              selectedId={selectedClusterId}
              onSelect={setSelectedClusterId}
            />
          ) : (
            <div className="hud-panel h-64 flex items-center justify-center text-cs2-muted text-sm tracking-wide">
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cs2-accent animate-pulse-glow" />
                  Loading data…
                </span>
              ) : (
                <span>No data yet — ingest demos to begin.</span>
              )}
            </div>
          )}
        </div>

        <div>
          {showIngest ? (
            <IngestPanel onComplete={fetchLineups} />
          ) : (
            <div className="hud-panel p-5 h-full flex flex-col justify-between gap-4">
              <div>
                <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em] mb-1">
                  / session
                </p>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Click a dot in the chart to highlight a lineup, or browse the
                  ranked grid below.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Lineups" value={String(lineups.length)} color="text-cs2-accent" />
                <Stat label="Map" value={selectedMap.replace("de_", "")} color="text-cs2-blue" />
                <Stat label="Type" value={selectedType.replace("grenade", "")} color="text-cs2-smoke" />
                <Stat label="Top Win" value={topWin} color="text-cs2-green" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Error state ── */}
      {error && (
        <div className="hud-panel border-cs2-red/30 bg-cs2-red/5 px-4 py-3 text-xs text-cs2-red">
          {error}
        </div>
      )}

      {/* ── Lineup grid ── */}
      {lineups.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.2em]">
              <span className="text-cs2-accent">/</span> ranked lineups
              <span className="text-cs2-muted normal-case tracking-normal font-normal ml-3">
                {selectedMap} &middot; {selectedType.replace("grenade", "")} &middot;{" "}
                <span className="text-gray-300 font-mono">{lineups.length}</span>
              </span>
            </h2>
            <button
              onClick={() => setGroupByThrowFrom((v) => !v)}
              className={groupByThrowFrom ? "hud-btn-primary" : "hud-btn"}
              title="Group lineups by the callout where the grenade lands"
            >
              {groupByThrowFrom ? "Grouped" : "Flat"}
            </button>
          </div>

          {groupedLineups ? (
            <div className="space-y-8">
              {groupedLineups.map((g) => {
                const collapsed = collapsedGroups.has(g.name);
                return (
                  <section key={g.name}>
                    <button
                      onClick={() => toggleGroup(g.name)}
                      className="w-full flex items-center gap-3 mb-3 group"
                    >
                      <span className="text-cs2-accent font-mono text-sm group-hover:drop-shadow-[0_0_6px_rgba(34,211,238,0.6)] transition">
                        {collapsed ? "▸" : "▾"}
                      </span>
                      <span className="text-[11px] uppercase tracking-[0.18em] font-semibold text-white">
                        {g.name}
                      </span>
                      <div className="flex-1 h-px bg-gradient-to-r from-cs2-border to-transparent" />
                      <span className="text-[10px] text-cs2-muted font-mono">
                        {g.items.length} lineup{g.items.length === 1 ? "" : "s"} &middot; impact{" "}
                        <span className="text-cs2-accent">{g.totalImpact.toFixed(2)}</span>
                      </span>
                    </button>
                    {!collapsed && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {g.items.map((r) => (
                          <div
                            key={r.cluster.cluster_id}
                            onClick={() => setSelectedClusterId(r.cluster.cluster_id)}
                          >
                            <LineupCard
                              ranking={r}
                              selected={selectedClusterId === r.cluster.cluster_id}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {lineups.map((r) => (
                <div
                  key={r.cluster.cluster_id}
                  onClick={() => setSelectedClusterId(r.cluster.cluster_id)}
                >
                  <LineupCard
                    ranking={r}
                    selected={selectedClusterId === r.cluster.cluster_id}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="text-center text-[10px] text-cs2-muted/60 pt-6 pb-2 tracking-[0.15em] uppercase">
        CS2 Meta Engine
      </footer>

      {/* ── Radar modal ── */}
      {showRadar && (
        <RadarView mapName={selectedMap} onClose={() => setShowRadar(false)} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-cs2-panel/80 border border-cs2-border rounded-lg px-3 py-2">
      <p className="text-[9px] text-cs2-muted uppercase tracking-[0.15em]">{label}</p>
      <p className={`text-sm font-bold font-mono ${color} mt-0.5`}>{value}</p>
    </div>
  );
}
