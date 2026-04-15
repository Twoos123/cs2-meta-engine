/**
 * NadeAnalysisPanel — per-round and cross-round grenade breakdown.
 *
 * Extracted from MatchReplayViewer so it can be reused inside the
 * Insights tab's "Detailed" mode without duplicating logic. All the
 * per-round + cross-round derivations are computed internally from the
 * timeline — callers just pass the timeline + seek callback.
 *
 * Filtering: pass `selectedSids` (Set<string>) to dim rows whose thrower
 * is not selected. Absent = everyone visible.
 */
import { useMemo, useState } from "react";
import { MatchTimeline } from "../api/client";

const GRENADE_COLOR: Record<string, string> = {
  smokegrenade: "#cbd5e1",
  flashbang: "#fde047",
  hegrenade: "#f87171",
  molotov: "#fb923c",
  decoy: "#9ca3af",
};

const TEAM_COLOR: Record<number, string> = {
  2: "#DCBF6E",
  3: "#5B9BD5",
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function flankingSamples<T extends { t: number }>(samples: T[], tick: number): [T, T] | null {
  if (!samples || samples.length === 0) return null;
  if (samples.length === 1) return [samples[0], samples[0]];
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < tick) lo = mid + 1;
    else hi = mid;
  }
  const upper = samples[lo];
  const lower = lo > 0 ? samples[lo - 1] : samples[lo];
  return [lower, upper];
}

interface Props {
  timeline: MatchTimeline;
  sidToTeam: Record<string, number>;
  sidToName: Record<string, string>;
  teamNames: Record<number, string>;
  currentRoundNum: number;
  onSeek: (tick: number) => void;
  selectedSids?: Set<string>;
  nadeTypeFilter?: Set<string>;
  /** Controlled pin: if provided, the panel reflects/updates the parent's
   *  pinned grenade so the radar can isolate it. Falls back to local state
   *  when omitted. */
  pinnedNadeGi?: number | null;
  onPinNade?: (gi: number | null) => void;
}

interface RoundNadeEntry {
  globalIdx: number;
  type: string;
  thrower: string;
  throwerName: string;
  team: number;
  throwTick: number;
}

interface RoundNadeInfo {
  round: MatchTimeline["rounds"][0];
  nades: RoundNadeEntry[];
  byTeam: Record<number, Record<string, number>>;
  byPlayer: Record<number, { name: string; steamid: string; types: Record<string, number> }[]>;
}

interface NadeLandingCluster {
  type: string;
  landX: number;
  landY: number;
  occurrences: { globalIdx: number; roundNum: number; throwerName: string; throwerSid: string; throwTick: number }[];
}

export default function NadeAnalysisPanel({
  timeline,
  sidToTeam,
  sidToName,
  teamNames,
  currentRoundNum,
  onSeek,
  selectedSids,
  nadeTypeFilter,
  pinnedNadeGi,
  onPinNade,
}: Props) {
  const [localHighlight, setLocalHighlight] = useState<number | null>(null);
  // Controlled if parent passes pinnedNadeGi; otherwise fall back to local.
  const isControlled = pinnedNadeGi !== undefined;
  const highlightedNadeIdx = isControlled ? (pinnedNadeGi ?? null) : localHighlight;
  const setHighlightedNadeIdx = (v: number | null) => {
    if (isControlled) onPinNade?.(v);
    else setLocalHighlight(v);
  };
  const [expandedTimeline, setExpandedTimeline] = useState<number | null>(null);
  const [tab, setTab] = useState<"rounds" | "patterns">("rounds");

  const isSelected = (sid: string) => !selectedSids || selectedSids.has(sid);
  const isTypeVisible = (t: string) => !nadeTypeFilter || nadeTypeFilter.has(t);

  const roundNades = useMemo<RoundNadeInfo[]>(() => {
    return timeline.rounds.map((r) => {
      const nades: RoundNadeEntry[] = [];
      timeline.grenades.forEach((g, gi) => {
        const firstTick = g.points[0]?.[0] ?? 0;
        if (firstTick < r.start_tick || firstTick > r.end_tick) return;
        const team = sidToTeam[g.thrower] ?? 0;
        nades.push({
          globalIdx: gi,
          type: g.type,
          thrower: g.thrower,
          throwerName: sidToName[g.thrower] ?? "?",
          team,
          throwTick: firstTick,
        });
      });
      const byTeam: Record<number, Record<string, number>> = { 2: {}, 3: {} };
      const playerMap: Record<number, Map<string, { name: string; steamid: string; types: Record<string, number> }>> = { 2: new Map(), 3: new Map() };
      for (const n of nades) {
        if (n.team !== 2 && n.team !== 3) continue;
        byTeam[n.team][n.type] = (byTeam[n.team][n.type] ?? 0) + 1;
        let entry = playerMap[n.team].get(n.thrower);
        if (!entry) {
          entry = { name: n.throwerName, steamid: n.thrower, types: {} };
          playerMap[n.team].set(n.thrower, entry);
        }
        entry.types[n.type] = (entry.types[n.type] ?? 0) + 1;
      }
      const byPlayer: Record<number, { name: string; steamid: string; types: Record<string, number> }[]> = {
        2: Array.from(playerMap[2].values()),
        3: Array.from(playerMap[3].values()),
      };
      return { round: r, nades, byTeam, byPlayer };
    });
  }, [timeline, sidToTeam, sidToName]);

  const flashEffectiveness = useMemo<Record<number, number>>(() => {
    const FLASH_RANGE = 1200;
    const result: Record<number, number> = {};
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (g.type !== "flashbang" || !g.points.length) continue;
      const lastPt = g.points[g.points.length - 1];
      const detTick = lastPt[0];
      const fx = lastPt[1];
      const fy = lastPt[2];
      const throwerTeam = sidToTeam[g.thrower] ?? 0;
      let nearbyEnemies = 0;
      for (const p of timeline.players) {
        if (p.team_num === throwerTeam) continue;
        const samples = timeline.positions[p.steamid];
        if (!samples || samples.length === 0) continue;
        const flanking = flankingSamples(samples, detTick);
        if (!flanking) continue;
        const [a, b] = flanking;
        if (!b.alive) continue;
        const span = b.t - a.t;
        const t = span > 0 ? Math.min(1, Math.max(0, (detTick - a.t) / span)) : 0;
        const px = lerp(a.x, b.x, t);
        const py = lerp(a.y, b.y, t);
        const dist = Math.sqrt((px - fx) ** 2 + (py - fy) ** 2);
        if (dist <= FLASH_RANGE) nearbyEnemies++;
      }
      result[gi] = nearbyEnemies;
    }
    return result;
  }, [timeline, sidToTeam]);

  const roundPatterns = useMemo<Record<number, { patternId: string; rounds: number[]; label: string }>>(() => {
    const BUCKET = 200;
    const TIME_WINDOW = 10 * 64;
    const bucketKey = (x: number, y: number, type: string) =>
      `${Math.round(x / BUCKET)}_${Math.round(y / BUCKET)}_${type}`;

    const roundSignatures: { roundNum: number; team: number; sig: string }[] = [];
    for (const r of timeline.rounds) {
      const roundNadesHere = timeline.grenades
        .map((g, gi) => ({ g, gi }))
        .filter(({ g }) => {
          const t = g.points[0]?.[0] ?? 0;
          return t >= r.start_tick && t <= r.end_tick && g.points.length > 0;
        });
      for (const team of [2, 3]) {
        const teamNades = roundNadesHere
          .filter(({ g }) => (sidToTeam[g.thrower] ?? 0) === team)
          .sort((a, b) => (a.g.points[0]?.[0] ?? 0) - (b.g.points[0]?.[0] ?? 0));
        if (teamNades.length < 3) continue;
        const firstTick = teamNades[0].g.points[0]?.[0] ?? 0;
        const burst = teamNades.filter(({ g }) => {
          const t = g.points[0]?.[0] ?? 0;
          return t - firstTick <= TIME_WINDOW;
        });
        if (burst.length < 3) continue;
        const keys = burst.map(({ g }) => {
          const lastPt = g.points[g.points.length - 1];
          return bucketKey(lastPt[1], lastPt[2], g.type);
        }).sort();
        const sig = keys.join("|");
        roundSignatures.push({ roundNum: r.num, team, sig });
      }
    }

    const sigToRounds = new Map<string, number[]>();
    for (const { roundNum, sig } of roundSignatures) {
      const arr = sigToRounds.get(sig) ?? [];
      arr.push(roundNum);
      sigToRounds.set(sig, arr);
    }

    const result: Record<number, { patternId: string; rounds: number[]; label: string }> = {};
    let patIdx = 0;
    for (const [sig, rounds] of sigToRounds) {
      if (rounds.length < 2) continue;
      patIdx++;
      const label = `Pattern ${patIdx} (${rounds.length}×)`;
      for (const rn of rounds) {
        result[rn] = { patternId: sig, rounds, label };
      }
    }
    return result;
  }, [timeline, sidToTeam]);

  const nadeLandingClusters = useMemo<NadeLandingCluster[]>(() => {
    const BUCKET = 150;
    const bucketMap = new Map<string, NadeLandingCluster>();
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (!g.points.length) continue;
      const lastPt = g.points[g.points.length - 1];
      const lx = lastPt[1], ly = lastPt[2];
      const key = `${g.type}_${Math.round(lx / BUCKET)}_${Math.round(ly / BUCKET)}`;
      const throwTick = g.points[0]?.[0] ?? 0;
      const roundNum = timeline.rounds.find(
        (r) => throwTick >= r.start_tick && throwTick <= r.end_tick,
      )?.num ?? 0;
      let cluster = bucketMap.get(key);
      if (!cluster) {
        cluster = { type: g.type, landX: lx, landY: ly, occurrences: [] };
        bucketMap.set(key, cluster);
      }
      const n = cluster.occurrences.length;
      cluster.landX = (cluster.landX * n + lx) / (n + 1);
      cluster.landY = (cluster.landY * n + ly) / (n + 1);
      cluster.occurrences.push({
        globalIdx: gi,
        roundNum,
        throwerName: sidToName[g.thrower] ?? "?",
        throwerSid: g.thrower,
        throwTick,
      });
    }
    return Array.from(bucketMap.values())
      .filter((c) => {
        const uniqueRounds = new Set(c.occurrences.map((o) => o.roundNum));
        return uniqueRounds.size >= 2;
      })
      .sort((a, b) => b.occurrences.length - a.occurrences.length);
  }, [timeline, sidToName]);

  return (
    <div className="hud-panel p-2 flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center gap-2 mb-1">
        <button
          onClick={() => setTab("rounds")}
          className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded font-mono transition-all ${
            tab === "rounds" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
          }`}
        >Rounds</button>
        <button
          onClick={() => setTab("patterns")}
          className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded font-mono transition-all ${
            tab === "patterns" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
          }`}
        >
          Patterns {nadeLandingClusters.length > 0 && (
            <span className="ml-1 text-[10px] opacity-70">({nadeLandingClusters.length})</span>
          )}
        </button>
        {highlightedNadeIdx !== null && (
          <button
            onClick={() => setHighlightedNadeIdx(null)}
            className="text-[11px] text-cs2-accent hover:text-white transition ml-auto"
          >
            Clear highlight
          </button>
        )}
      </div>

      {tab === "patterns" && (
        <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {nadeLandingClusters.length === 0 ? (
            <p className="text-xs text-cs2-muted">No repeated nade positions found across rounds.</p>
          ) : nadeLandingClusters
            .filter((c) => isTypeVisible(c.type))
            .filter((c) => c.occurrences.some((o) => isSelected(o.throwerSid)))
            .map((cluster, ci) => {
              const color = GRENADE_COLOR[cluster.type] ?? "#9ca3af";
              const uniqueRounds = [...new Set(cluster.occurrences.map((o) => o.roundNum))].sort((a, b) => a - b);
              const uniquePlayers = [...new Set(cluster.occurrences.map((o) => o.throwerName))];
              return (
                <div key={ci} className="px-2 py-1.5 rounded bg-cs2-border/10 hover:bg-cs2-border/20 transition">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs px-1.5 rounded" style={{ color, background: `${color}20` }}>
                      {cluster.type.replace("grenade", "")}
                    </span>
                    <span className="text-xs text-white font-mono">
                      {cluster.occurrences.length}× across {uniqueRounds.length} rounds
                    </span>
                  </div>
                  <div className="flex items-start gap-1 flex-wrap text-[11px] text-cs2-muted mb-1">
                    <span className="shrink-0">Rounds:</span>
                    {uniqueRounds.map((rn) => (
                      <button
                        key={rn}
                        onClick={() => {
                          const occ = cluster.occurrences.find((o) => o.roundNum === rn);
                          if (occ) {
                            onSeek(occ.throwTick);
                            setHighlightedNadeIdx(occ.globalIdx);
                          }
                        }}
                        className="font-mono px-1 rounded hover:bg-cs2-accent/20 hover:text-cs2-accent transition"
                      >
                        R{rn}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-start gap-1 text-[11px] text-cs2-muted">
                    <span className="shrink-0">By:</span>
                    <span className="text-gray-400 break-words min-w-0 flex-1">{uniquePlayers.join(", ")}</span>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {tab === "rounds" && (
        <div className="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {roundNades.map(({ round: r, nades, byPlayer }) => {
            const isCurrent = r.num === currentRoundNum;
            const filteredNades = nades.filter((n) => isSelected(n.thrower) && isTypeVisible(n.type));
            return (
              <div
                key={r.num}
                className={`text-left px-2 py-1.5 rounded text-xs transition ${
                  isCurrent
                    ? "bg-cs2-accent/15 border border-cs2-accent/40"
                    : "hover:bg-cs2-border/20"
                }`}
              >
                <button
                  onClick={() => onSeek(r.start_tick)}
                  className="flex items-center justify-between w-full mb-1"
                >
                  <span className="font-mono text-white">
                    R{r.num}
                    {r.winner && (
                      <span
                        className="ml-1"
                        style={{ color: TEAM_COLOR[r.winner === "T" ? 2 : 3] }}
                      >
                        {r.winner} win
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {roundPatterns[r.num] && (
                      <span
                        className="text-[10px] font-mono px-1 py-px rounded bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/30"
                        title={`Repeated in rounds: ${roundPatterns[r.num].rounds.join(", ")}`}
                      >
                        {roundPatterns[r.num].label}
                      </span>
                    )}
                    <span className="text-cs2-muted">
                      {filteredNades.length} nade{filteredNades.length !== 1 ? "s" : ""}
                    </span>
                  </span>
                </button>

                {filteredNades.length > 0 && (() => {
                  const isExpanded = expandedTimeline === r.num;
                  const roundLen = r.end_tick - r.start_tick;
                  if (roundLen <= 0) return null;
                  return (
                    <>
                      <div className="flex items-center gap-1 mb-1">
                        <div
                          className={`relative flex-1 rounded-full bg-cs2-border/30 overflow-hidden transition-all ${isExpanded ? "h-3" : "h-2"}`}
                        >
                          {filteredNades.map((n) => {
                            const pct = ((n.throwTick - r.start_tick) / roundLen) * 100;
                            const color = GRENADE_COLOR[n.type] ?? "#9ca3af";
                            const isHighlighted = highlightedNadeIdx === n.globalIdx;
                            return (
                              <button
                                key={n.globalIdx}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setHighlightedNadeIdx(
                                    highlightedNadeIdx === n.globalIdx ? null : n.globalIdx,
                                  );
                                  onSeek(n.throwTick);
                                }}
                                className="absolute top-0 h-full transition-all"
                                style={{
                                  left: `${Math.min(pct, 98)}%`,
                                  width: isExpanded ? "5px" : "4px",
                                  background: color,
                                  opacity: isHighlighted ? 1 : 0.7,
                                  boxShadow: isHighlighted ? `0 0 6px ${color}` : "none",
                                  borderRadius: "2px",
                                }}
                                title={`${n.throwerName} · ${n.type.replace("grenade", "")} · ${((n.throwTick - r.start_tick) / 64).toFixed(1)}s`}
                              />
                            );
                          })}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedTimeline(isExpanded ? null : r.num);
                          }}
                          className="text-[10px] text-cs2-accent/50 hover:text-cs2-accent shrink-0"
                          title={isExpanded ? "Collapse timeline" : "Expand timeline"}
                        >
                          {isExpanded ? "−" : "+"}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="bg-cs2-border/10 rounded p-2 mb-1.5 flex flex-col gap-1">
                          <div className="flex items-center justify-between text-[10px] text-cs2-muted font-mono mb-0.5">
                            <span>0s</span>
                            <span>Round timeline</span>
                            <span>{(roundLen / 64).toFixed(0)}s</span>
                          </div>
                          {filteredNades
                            .slice()
                            .sort((a, b) => a.throwTick - b.throwTick)
                            .map((n) => {
                              const pct = ((n.throwTick - r.start_tick) / roundLen) * 100;
                              const color = GRENADE_COLOR[n.type] ?? "#9ca3af";
                              const isHighlighted = highlightedNadeIdx === n.globalIdx;
                              const timeSec = ((n.throwTick - r.start_tick) / 64).toFixed(1);
                              return (
                                <button
                                  key={n.globalIdx}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setHighlightedNadeIdx(
                                      highlightedNadeIdx === n.globalIdx ? null : n.globalIdx,
                                    );
                                    onSeek(n.throwTick);
                                  }}
                                  className={`flex items-center gap-1.5 py-0.5 px-1 rounded text-[11px] transition-all ${
                                    isHighlighted ? "bg-cs2-accent/15" : "hover:bg-cs2-border/20"
                                  }`}
                                >
                                  <div className="relative flex-1 h-1.5 rounded-full bg-cs2-border/20">
                                    <div
                                      className="absolute top-0 h-full rounded-full transition-all"
                                      style={{
                                        left: `${Math.min(pct, 97)}%`,
                                        width: "6px",
                                        background: color,
                                        boxShadow: isHighlighted ? `0 0 8px ${color}` : `0 0 3px ${color}60`,
                                      }}
                                    />
                                  </div>
                                  <span className="font-mono shrink-0 w-[30px] text-right" style={{ color }}>
                                    {timeSec}s
                                  </span>
                                  <span className="shrink-0 w-2 h-2 rounded-full" style={{ background: TEAM_COLOR[n.team] ?? "#666" }} />
                                  <span className="text-gray-400 truncate w-[55px] shrink-0 text-left">
                                    {n.throwerName}
                                  </span>
                                  <span className="font-mono shrink-0" style={{ color }}>
                                    {n.type.replace("grenade", "")}
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      )}
                    </>
                  );
                })()}

                {[2, 3].map((team) => {
                  const players = byPlayer[team]?.filter((pl) => isSelected(pl.steamid));
                  if (!players || players.length === 0) return null;
                  return (
                    <div key={team} className="mt-0.5">
                      <div className="flex items-center gap-1 mb-0.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: TEAM_COLOR[team] }}
                        />
                        <span className="text-[11px] uppercase tracking-wider" style={{ color: TEAM_COLOR[team] }}>
                          {teamNames[team]}
                        </span>
                      </div>
                      {players.map((pl) => {
                        const types = Object.entries(pl.types).filter(([, n]) => n > 0);
                        return (
                          <div key={pl.steamid} className="flex items-center gap-1 ml-3 mt-0.5">
                            <span className="text-gray-400 text-[11px] w-[70px] truncate shrink-0">
                              {pl.name}
                            </span>
                            <div className="flex gap-0.5 flex-wrap">
                              {types.map(([type, count]) => {
                                const matchingNades = filteredNades.filter(
                                  (n) => n.thrower === pl.steamid && n.type === type,
                                );
                                const isAnyHighlighted = matchingNades.some(
                                  (n) => n.globalIdx === highlightedNadeIdx,
                                );
                                return (
                                  <button
                                    key={type}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isAnyHighlighted) {
                                        setHighlightedNadeIdx(null);
                                      } else if (matchingNades.length > 0) {
                                        setHighlightedNadeIdx(matchingNades[0].globalIdx);
                                        onSeek(matchingNades[0].throwTick);
                                      }
                                    }}
                                    className="font-mono px-1 rounded cursor-pointer transition-all"
                                    style={{
                                      color: GRENADE_COLOR[type] ?? "#9ca3af",
                                      background: isAnyHighlighted
                                        ? `${GRENADE_COLOR[type] ?? "#9ca3af"}40`
                                        : `${GRENADE_COLOR[type] ?? "#9ca3af"}15`,
                                      boxShadow: isAnyHighlighted
                                        ? `0 0 8px ${GRENADE_COLOR[type] ?? "#9ca3af"}60`
                                        : "none",
                                    }}
                                  >
                                    {count}× {type.replace("grenade", "")}
                                    {type === "flashbang" && matchingNades.length > 0 && (() => {
                                      const totalFlashed = matchingNades.reduce(
                                        (sum, n) => sum + (flashEffectiveness[n.globalIdx] ?? 0), 0,
                                      );
                                      if (totalFlashed === 0) return null;
                                      return (
                                        <span className="ml-0.5 text-[10px] opacity-80" title={`~${totalFlashed} enemies near flash(es)`}>
                                          ({totalFlashed} hit)
                                        </span>
                                      );
                                    })()}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
