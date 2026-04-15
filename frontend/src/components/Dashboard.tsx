/**
 * Dashboard — main view. HUD-styled layout.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Callout,
  clearAllData,
  ExecuteCombo,
  getCallouts,
  getDownloadedDemos,
  getExecutes,
  getMaps,
  getTopLineups,
  DownloadedMap,
  LineupRanking,
} from "../api/client";
import LineupCard from "./LineupCard";
import ScatterPlot from "./ScatterPlot";
import SettingsPanel from "./SettingsPanel";

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
  const navigate = useNavigate();
  const [selectedMap, setSelectedMap] = useState("de_mirage");
  const [selectedType, setSelectedType] = useState("smokegrenade");
  const [selectedSide, setSelectedSide] = useState<"all" | "T" | "CT">("all");
  const [selectedPlayer, setSelectedPlayer] = useState<string>("");
  const [lineups, setLineups] = useState<LineupRanking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<number | undefined>();
  const [clearing, setClearing] = useState(false);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [groupByThrowFrom, setGroupByThrowFrom] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedNades, setExpandedNades] = useState<Set<number>>(new Set());
  const [hideNoise, setHideNoise] = useState(false);
  const [executes, setExecutes] = useState<ExecuteCombo[]>([]);
  const [showExecutes, setShowExecutes] = useState(false);
  const [ingestedMaps, setIngestedMaps] = useState<Set<string>>(new Set());
  const [downloadedMaps, setDownloadedMaps] = useState<DownloadedMap[]>([]);
  const [showSettings, setShowSettings] = useState(false);

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
      const sideParam = selectedSide === "all" ? undefined : selectedSide;
      const res = await getTopLineups(selectedMap, selectedType, 500, sideParam);
      setLineups(res.lineups);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(detail ?? "Failed to fetch lineups");
      setLineups([]);
    } finally {
      setLoading(false);
    }
  }, [selectedMap, selectedType, selectedSide]);

  useEffect(() => {
    getCallouts(selectedMap)
      .then(setCallouts)
      .catch(() => setCallouts([]));
    setCollapsedGroups(new Set());
  }, [selectedMap]);

  // Distinct players from the loaded clusters' top_throwers, sorted by
  // total throws descending. Reset whenever the underlying lineups change
  // so a stale name from the previous map/side doesn't survive.
  const availablePlayers = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of lineups) {
      for (const t of r.cluster.top_throwers ?? []) {
        if (!t?.name) continue;
        totals.set(t.name, (totals.get(t.name) ?? 0) + (t.count ?? 0));
      }
    }
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }, [lineups]);

  useEffect(() => {
    if (selectedPlayer && !availablePlayers.includes(selectedPlayer)) {
      setSelectedPlayer("");
    }
  }, [availablePlayers, selectedPlayer]);

  const filteredLineups = useMemo(() => {
    let result = lineups;
    if (selectedPlayer) {
      const needle = selectedPlayer.toLowerCase();
      result = result.filter((r) =>
        (r.cluster.top_throwers ?? []).some(
          (t) => t.name?.toLowerCase() === needle,
        ),
      );
    }
    if (hideNoise) {
      result = result.filter((r) => {
        const c = r.cluster;
        // Hide singleton throws that lost
        if (c.throw_count <= 1 && c.round_win_rate === 0) return false;
        // Hide very short flight distance (accidental drops)
        const dx = c.land_centroid_x - c.throw_centroid_x;
        const dy = c.land_centroid_y - c.throw_centroid_y;
        if (dx * dx + dy * dy < 200 * 200) return false;
        return true;
      });
    }
    return result;
  }, [lineups, selectedPlayer, hideNoise]);

  // Collapse the raw bucket list into one "main nade" per landing spot, with
  // genuinely-different throw positions kept as variations underneath. The
  // bucket pipeline already merges nearby (pos+angle) throws, but two pros
  // landing the same smoke from two different sides of the map still produce
  // two clusters — we want both, but ten clusters that all land on B Default
  // from the same window should collapse into one card with a single
  // variation.
  //
  //   LANDING_GROUP_RADIUS — landings within this distance count as the same
  //     "discovered nade" (the same denial / cover spot).
  //   VARIATION_MIN_DISTANCE — within a landing group, a new throw is only
  //     accepted as a variation if its standing position is at least this far
  //     from every variation already in the group, so we never list two
  //     near-duplicate stances.
  const LANDING_GROUP_RADIUS_SQ = 250 * 250;
  const VARIATION_MIN_DISTANCE_SQ = 300 * 300;

  const mainNades = useMemo(() => {
    const sorted = [...filteredLineups].sort(
      (a, b) => b.impact_score - a.impact_score,
    );
    const groups: {
      key: number;
      primary: LineupRanking;
      // Dedup'd subset shown in the UI — no two variations within
      // VARIATION_MIN_DISTANCE of each other so the user never sees
      // near-duplicate stances for the same landing spot.
      variations: LineupRanking[];
      // Every filtered lineup that lands in this group. Used for scatter
      // click lookup so selecting a pruned variation still resolves to its
      // parent main nade (otherwise the filter silently does nothing).
      members: LineupRanking[];
    }[] = [];

    for (const r of sorted) {
      const lx = r.cluster.land_centroid_x;
      const ly = r.cluster.land_centroid_y;

      const group = groups.find((g) => {
        const dx = g.primary.cluster.land_centroid_x - lx;
        const dy = g.primary.cluster.land_centroid_y - ly;
        return dx * dx + dy * dy < LANDING_GROUP_RADIUS_SQ;
      });

      if (!group) {
        groups.push({
          key: r.cluster.cluster_id,
          primary: r,
          variations: [r],
          members: [r],
        });
        continue;
      }

      group.members.push(r);

      const tx = r.cluster.throw_centroid_x;
      const ty = r.cluster.throw_centroid_y;
      const tooClose = group.variations.some((v) => {
        const dx = v.cluster.throw_centroid_x - tx;
        const dy = v.cluster.throw_centroid_y - ty;
        return dx * dx + dy * dy < VARIATION_MIN_DISTANCE_SQ;
      });

      if (!tooClose) {
        group.variations.push(r);
      }
    }

    return groups;
  }, [filteredLineups, LANDING_GROUP_RADIUS_SQ, VARIATION_MIN_DISTANCE_SQ]);

  // When the user clicks a dot in the scatter, narrow the grid to the single
  // main nade that contains that cluster. We match against `members` (not
  // `variations`) so clicking a pruned near-duplicate still resolves — and
  // if the clicked cluster was pruned from the display set, inject it back
  // into variations so the user sees what they actually clicked.
  const focusedNade = useMemo(() => {
    if (selectedClusterId === undefined) return null;
    const parent = mainNades.find((n) =>
      n.members.some((v) => v.cluster.cluster_id === selectedClusterId),
    );
    if (!parent) return null;
    const inVariations = parent.variations.some(
      (v) => v.cluster.cluster_id === selectedClusterId,
    );
    if (inVariations) return parent;
    const clicked = parent.members.find(
      (v) => v.cluster.cluster_id === selectedClusterId,
    );
    if (!clicked) return parent;
    return { ...parent, variations: [...parent.variations, clicked] };
  }, [selectedClusterId, mainNades]);

  const groupedNades = useMemo(() => {
    if (!groupByThrowFrom || callouts.length === 0) return null;
    // Group main nades by LANDING callout — each main nade is already keyed by
    // landing spot, so this becomes a region label ("B Site", "Mid") wrapping
    // all the nades that cover that area.
    const MAX_DIST_SQ = 1200 * 1200;
    const buckets = new Map<string, typeof mainNades>();
    for (const nade of mainNades) {
      const lx = nade.primary.cluster.land_centroid_x;
      const ly = nade.primary.cluster.land_centroid_y;
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
      arr.push(nade);
      buckets.set(pretty, arr);
    }
    return Array.from(buckets.entries())
      .map(([name, items]) => ({
        name,
        items: items.sort(
          (a, b) => b.primary.impact_score - a.primary.impact_score,
        ),
        totalImpact: items.reduce((s, n) => s + n.primary.impact_score, 0),
      }))
      .sort((a, b) => b.totalImpact - a.totalImpact);
  }, [mainNades, callouts, groupByThrowFrom]);

  // Auto-expand a main nade when the user picks one of its variations from
  // the scatter, so the variation is immediately visible inside the card.
  useEffect(() => {
    if (focusedNade) {
      setExpandedNades((prev) => {
        if (prev.has(focusedNade.key)) return prev;
        const next = new Set(prev);
        next.add(focusedNade.key);
        return next;
      });
    }
  }, [focusedNade]);

  const toggleNade = (key: number) => {
    setExpandedNades((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
    getExecutes(selectedMap)
      .then(setExecutes)
      .catch(() => setExecutes([]));
  }, [fetchLineups, selectedMap]);

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

  const topWin = filteredLineups[0]
    ? `${(filteredLineups[0].cluster.round_win_rate * 100).toFixed(1)}%`
    : "—";

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#05070d] text-cs2-text">
      {/* ── Header ── */}
      <nav className="shrink-0 flex items-center gap-3 px-4 py-8 border-b border-cs2-border/50 bg-[#0a0e18]">
        <button onClick={() => navigate("/")} className="hud-btn text-sm py-1.5 px-4 min-w-[72px]" title="Home">←</button>
        <h1 className="text-sm font-semibold text-white uppercase tracking-[0.12em]">Grenade Lineups</h1>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
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
            onClick={() => setShowSettings(true)}
            className="hud-btn"
          >
            Settings
          </button>

          <button
            onClick={handleClearData}
            disabled={clearing}
            className="hud-btn-danger"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>

          <button onClick={() => navigate("/ingest")} className="hud-btn text-sm py-1.5 px-4 min-w-[72px]" title="Ingest demos">Ingest</button>
          <button onClick={() => navigate("/players")} className="hud-btn text-sm py-1.5 px-4 min-w-[72px]" title="Player profiles">Players</button>
        </div>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 p-4 md:p-6" style={{ scrollbarWidth: "thin" }}>
      {/* ── Grenade type tabs + side filter ── */}
      <>
      <div className="flex items-center gap-3 flex-wrap px-1">
        <div className="flex gap-1.5 flex-wrap">
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
        <div className="flex gap-1 ml-auto items-center flex-wrap">
          <button
            onClick={() => setHideNoise((v) => !v)}
            className={`text-[10px] px-2.5 py-1 rounded font-mono uppercase tracking-[0.15em] border transition mr-1 ${
              hideNoise
                ? "border-cs2-accent text-cs2-accent bg-cs2-accent/10"
                : "border-cs2-border text-cs2-muted hover:text-gray-300"
            }`}
            title="Hide noise: singleton losses + short flight distance throws"
          >
            {hideNoise ? "Noise Hidden" : "Hide Noise"}
          </button>
          <button
            onClick={() => setShowExecutes((v) => !v)}
            className={`text-[10px] px-2.5 py-1 rounded font-mono uppercase tracking-[0.15em] border transition mr-1 ${
              showExecutes
                ? "border-cs2-green text-cs2-green bg-cs2-green/10"
                : "border-cs2-border text-cs2-muted hover:text-gray-300"
            }`}
            title="Show detected execute combos for this map"
          >
            Executes{executes.length > 0 ? ` (${executes.length})` : ""}
          </button>
          {availablePlayers.length > 0 && (
            <select
              value={selectedPlayer}
              onChange={(e) => setSelectedPlayer(e.target.value)}
              className="hud-input text-[10px] py-1 px-2 mr-2 cursor-pointer"
              title="Filter to lineups thrown by a specific player"
            >
              <option value="">All players</option>
              {availablePlayers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {(["all", "T", "CT"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSelectedSide(s)}
              className={`text-[10px] px-2.5 py-1 rounded font-mono uppercase tracking-[0.15em] border transition ${
                selectedSide === s
                  ? "border-cs2-accent text-cs2-accent bg-cs2-accent/10"
                  : "border-cs2-border text-cs2-muted hover:text-gray-300"
              }`}
              title={
                s === "all"
                  ? "Show both sides"
                  : s === "T"
                    ? "Only T-side lineups"
                    : "Only CT-side lineups"
              }
            >
              {s === "all" ? "Both" : s}
            </button>
          ))}
        </div>
      </div>

      {/* ── Execute combos ── */}
      {showExecutes && executes.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.2em] px-1">
            <span className="text-cs2-green">/</span> detected executes
            <span className="text-cs2-muted normal-case tracking-normal font-normal ml-3">
              {selectedMap} &middot;{" "}
              <span className="text-gray-300 font-mono">{executes.length}</span> combos
            </span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {executes.map((ex) => (
              <div
                key={ex.execute_id}
                className="hud-panel p-4 flex flex-col gap-2"
                style={{ borderTopColor: "#4ade80", borderTopWidth: 2 }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-semibold text-white leading-tight">
                      {ex.name}
                    </p>
                    <p className="text-[10px] text-cs2-muted mt-0.5 font-mono">
                      {ex.grenade_summary}
                    </p>
                  </div>
                  {ex.side && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-md border border-cs2-accent/40 text-cs2-accent shrink-0">
                      {ex.side}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                  <span className="text-cs2-muted uppercase tracking-[0.1em]">Rounds</span>
                  <span className="font-mono text-gray-300 text-right">{ex.occurrence_count}</span>
                  <span className="text-cs2-muted uppercase tracking-[0.1em]">Win rate</span>
                  <span className="font-mono text-cs2-green text-right">
                    {(ex.round_win_rate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {ex.members.map((m) => {
                    const color =
                      m.grenade_type === "smokegrenade"
                        ? "#cbd5e1"
                        : m.grenade_type === "flashbang"
                          ? "#fde047"
                          : m.grenade_type === "hegrenade"
                            ? "#f87171"
                            : m.grenade_type === "molotov"
                              ? "#fb923c"
                              : "#9ca3af";
                    return (
                      <span
                        key={m.cluster_id}
                        className="text-[9px] font-mono px-1.5 py-0.5 rounded border truncate max-w-[180px]"
                        style={{ borderColor: color, color }}
                        title={m.label || `Cluster #${m.cluster_id}`}
                      >
                        {m.label || `#${m.cluster_id}`}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {showExecutes && executes.length === 0 && (
        <p className="text-[12px] text-cs2-muted px-1">
          No execute combos detected for {selectedMap}. Run the pipeline with multiple demos to detect coordinated utility patterns.
        </p>
      )}

      {/* ── Top row: scatter + ingest/stats ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          {filteredLineups.length > 0 ? (
            <ScatterPlot
              lineups={filteredLineups}
              selectedId={selectedClusterId}
              onSelect={(id) =>
                setSelectedClusterId((prev) => (prev === id ? undefined : id))
              }
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
              <Stat label="Lineups" value={String(filteredLineups.length)} color="text-cs2-accent" />
              <Stat label="Map" value={selectedMap.replace("de_", "")} color="text-cs2-blue" />
              <Stat label="Type" value={selectedType.replace("grenade", "")} color="text-cs2-smoke" />
              <Stat label="Top Win" value={topWin} color="text-cs2-green" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Error state ── */}
      {error && (
        <div className="hud-panel border-cs2-red/30 bg-cs2-red/5 px-4 py-3 text-xs text-cs2-red">
          {error}
        </div>
      )}

      {/* ── Lineup grid ── */}
      {filteredLineups.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4 px-1 flex-wrap gap-2">
            <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.2em]">
              <span className="text-cs2-accent">/</span> discovered nades
              <span className="text-cs2-muted normal-case tracking-normal font-normal ml-3">
                {selectedMap} &middot; {selectedType.replace("grenade", "")} &middot;{" "}
                <span className="text-gray-300 font-mono">{mainNades.length}</span>{" "}
                main &middot;{" "}
                <span className="text-gray-300 font-mono">
                  {filteredLineups.length}
                </span>{" "}
                variations
                {selectedPlayer && (
                  <>
                    {" "}
                    &middot;{" "}
                    <span className="text-cs2-accent">{selectedPlayer}</span>
                  </>
                )}
                {focusedNade && (
                  <>
                    {" "}
                    &middot;{" "}
                    <span className="text-cs2-accent">filtered to selection</span>
                  </>
                )}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {focusedNade && (
                <button
                  onClick={() => setSelectedClusterId(undefined)}
                  className="hud-btn"
                  title="Clear scatter selection — show every nade again"
                >
                  Clear filter
                </button>
              )}
              <button
                onClick={() => setGroupByThrowFrom((v) => !v)}
                className={groupByThrowFrom ? "hud-btn-primary" : "hud-btn"}
                title="Group nades by the callout where the grenade lands"
              >
                {groupByThrowFrom ? "Grouped" : "Flat"}
              </button>
            </div>
          </div>

          {focusedNade ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              <MainNadeCard
                nade={focusedNade}
                expanded
                onToggle={() => setSelectedClusterId(undefined)}
                selectedClusterId={selectedClusterId}
                onSelectVariation={setSelectedClusterId}
                activePlayer={selectedPlayer || null}
              />
            </div>
          ) : groupedNades ? (
            <div className="space-y-8">
              {groupedNades.map((g) => {
                const collapsed = collapsedGroups.has(g.name);
                const variationCount = g.items.reduce(
                  (s, n) => s + n.variations.length,
                  0,
                );
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
                        {g.items.length} nade{g.items.length === 1 ? "" : "s"}{" "}
                        &middot; {variationCount} variation
                        {variationCount === 1 ? "" : "s"} &middot; impact{" "}
                        <span className="text-cs2-accent">
                          {g.totalImpact.toFixed(2)}
                        </span>
                      </span>
                    </button>
                    {!collapsed && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {g.items.map((nade) => (
                          <MainNadeCard
                            key={nade.key}
                            nade={nade}
                            expanded={expandedNades.has(nade.key)}
                            onToggle={() => toggleNade(nade.key)}
                            selectedClusterId={selectedClusterId}
                            onSelectVariation={setSelectedClusterId}
                            activePlayer={selectedPlayer || null}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {mainNades.map((nade) => (
                <MainNadeCard
                  key={nade.key}
                  nade={nade}
                  expanded={expandedNades.has(nade.key)}
                  onToggle={() => toggleNade(nade.key)}
                  selectedClusterId={selectedClusterId}
                  onSelectVariation={setSelectedClusterId}
                  activePlayer={selectedPlayer || null}
                />
              ))}
            </div>
          )}
        </div>
      )}

      </>
      </div>{/* /scrollable content */}

      {/* ── Settings modal ── */}
      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />

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

interface MainNadeCardProps {
  nade: {
    key: number;
    primary: LineupRanking;
    variations: LineupRanking[];
  };
  expanded: boolean;
  onToggle: () => void;
  selectedClusterId: number | undefined;
  onSelectVariation: (id: number) => void;
  activePlayer: string | null;
}

function MainNadeCard({
  nade,
  expanded,
  onToggle,
  selectedClusterId,
  onSelectVariation,
  activePlayer,
}: MainNadeCardProps) {
  const variationCount = nade.variations.length;
  const hasVariations = variationCount > 1;
  // The "primary" is the highest-impact variation; the expand list below
  // shows the rest, so we never render the primary twice.
  const others = nade.variations.slice(1);

  return (
    <div className="flex flex-col gap-2">
      <div onClick={() => onSelectVariation(nade.primary.cluster.cluster_id)}>
        <LineupCard
          ranking={nade.primary}
          selected={selectedClusterId === nade.primary.cluster.cluster_id}
          activePlayer={activePlayer}
        />
      </div>
      {hasVariations && (
        <button
          onClick={onToggle}
          className="text-[10px] font-mono uppercase tracking-[0.15em] px-2 py-1.5 rounded border border-cs2-border bg-cs2-panel/60 text-cs2-muted hover:text-cs2-accent hover:border-cs2-accent/60 transition flex items-center justify-between"
        >
          <span>
            <span className="text-cs2-accent">{expanded ? "▾" : "▸"}</span>{" "}
            {variationCount - 1} other variation
            {variationCount - 1 === 1 ? "" : "s"}
          </span>
          <span className="text-cs2-muted/70 normal-case tracking-normal">
            from different spots
          </span>
        </button>
      )}
      {expanded && others.length > 0 && (
        <div className="flex flex-col gap-3 pl-3 border-l-2 border-cs2-accent/30">
          {others.map((v, i) => (
            <div key={v.cluster.cluster_id}>
              <p className="text-[9px] text-cs2-muted uppercase tracking-[0.15em] mb-1 pl-1">
                Variation {i + 2} / {variationCount}
              </p>
              <div onClick={() => onSelectVariation(v.cluster.cluster_id)}>
                <LineupCard
                  ranking={v}
                  selected={selectedClusterId === v.cluster.cluster_id}
                  activePlayer={activePlayer}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
