/**
 * MatchReplayViewer — in-browser 2D replay of an entire CS2 match.
 *
 * cs2lens-style features:
 * - Player dots with directional yaw lines, names, and health bars
 * - Grenade flight trails with grenade-type SVG icons at the head
 * - Utility zones: smoke cloud (20s), molotov fire patch (7s), flash burst, HE shockwave
 * - Utility countdown timers (arc + seconds text)
 * - Shooting tracers (brief lines on weapon_fire events)
 * - Kill lines (attacker → victim) + X death markers
 * - Kill feed panel (right side, last 5 kills)
 * - Bomb plant/defuse indicators
 * - Round score ribbon, jump-to-round, playback controls, AI recap
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MatchInfoResponse,
  MatchTimeline,
  RadarInfo,
  TimelinePosition,
  getMatchInfo,
  getMatchReplayInsights,
  getMatchReplayTimeline,
  getRadarInfo,
} from "../api/client";

const RADAR_PX = 1024;

// CS2 utility durations in ticks (64 tick/s)
const SMOKE_DURATION = 20 * 64;   // 20 seconds
const MOLOTOV_DURATION = 7 * 64;  // 7 seconds
const FLASH_DURATION = 32;        // 0.5s visual burst
const HE_DURATION = 24;           // brief shockwave

const GRENADE_COLOR: Record<string, string> = {
  smokegrenade: "#cbd5e1",
  flashbang: "#fde047",
  hegrenade: "#f87171",
  molotov: "#fb923c",
  decoy: "#9ca3af",
};

const TEAM_COLOR: Record<number, string> = {
  2: "#DCBF6E", // T — gold/yellow (CS2 accurate)
  3: "#5B9BD5", // CT — blue (CS2 accurate)
};

const TEAM_BG: Record<number, string> = {
  2: "rgba(220, 191, 110, 0.15)",
  3: "rgba(91, 155, 213, 0.15)",
};

// ─── Grenade SVG icons from counter-strike-icons (Juknum) ────────────────
// Served from /icons/ in the public folder — actual CS2 game icons.

const GRENADE_ICON: Record<string, string> = {
  smokegrenade: "/icons/smokegrenade.svg",
  flashbang:    "/icons/flashbang.svg",
  hegrenade:    "/icons/hegrenade.svg",
  molotov:      "/icons/molotov.svg",
  incendiary:   "/icons/incgrenade.svg",
  decoy:        "/icons/decoy.svg",
};

// ─── Weapon display name → icon filename mapping ────────────────────────
// demoparser2 returns full display names (e.g. "AK-47"), icons use short names (e.g. "ak47").
const WEAPON_ICON_MAP: Record<string, string> = {
  "AK-47": "ak47", "AWP": "awp", "M4A4": "m4a1", "M4A1-S": "m4a1_silencer",
  "USP-S": "usp_silencer", "Glock-18": "glock", "P2000": "hkp2000",
  "Five-SeveN": "fiveseven", "Desert Eagle": "deagle", "Dual Berettas": "elite",
  "Tec-9": "tec9", "CZ75-Auto": "cz75a", "P250": "p250", "R8 Revolver": "revolver",
  "FAMAS": "famas", "Galil AR": "galilar", "MAC-10": "mac10", "MP9": "mp9",
  "MP7": "mp7", "MP5-SD": "mp5sd", "UMP-45": "ump45", "PP-Bizon": "bizon",
  "P90": "p90", "SSG 08": "ssg08", "AUG": "aug", "SG 553": "sg556",
  "SCAR-20": "scar20", "G3SG1": "g3sg1", "Nova": "nova", "MAG-7": "mag7",
  "Sawed-Off": "sawedoff", "XM1014": "xm1014", "M249": "m249", "Negev": "negev",
  "Zeus x27": "taser",
  "Smoke Grenade": "smokegrenade", "Flashbang": "flashbang",
  "High Explosive Grenade": "hegrenade", "Molotov": "molotov",
  "Incendiary Grenade": "incgrenade", "Decoy Grenade": "decoy",
  "C4 Explosive": "c4",
};
/** Map demoparser2 weapon display name to icon path, with knife fallback. */
const weaponIconPath = (displayName: string): string => {
  if (!displayName || displayName === "nan") return "";
  const mapped = WEAPON_ICON_MAP[displayName];
  if (mapped) return `/icons/${mapped}.svg`;
  // Knife variants: "Karambit", "M9 Bayonet", "Butterfly Knife", etc.
  const lower = displayName.toLowerCase();
  if (lower.includes("knife") || lower.includes("bayonet") || lower.includes("karambit")
      || lower.includes("talon") || lower.includes("navaja") || lower.includes("stiletto")
      || lower.includes("ursus") || lower.includes("classic") || lower.includes("paracord")
      || lower.includes("survival") || lower.includes("nomad") || lower.includes("skeleton")
      || lower.includes("bowie") || lower.includes("huntsman") || lower.includes("gut")
      || lower.includes("falchion") || lower.includes("flip") || lower.includes("kukri")
      || lower.includes("shadow daggers")) {
    return "/icons/knife.svg";
  }
  return "";
};

interface Props {
  demoFile: string;
  onBack: () => void;
}

// Binary-search the position array for the two samples flanking `tick`.
const flankingSamples = (
  arr: TimelinePosition[],
  tick: number,
): [TimelinePosition, TimelinePosition] | null => {
  if (!arr || arr.length === 0) return null;
  if (tick <= arr[0].t) return [arr[0], arr[0]];
  if (tick >= arr[arr.length - 1].t)
    return [arr[arr.length - 1], arr[arr.length - 1]];
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= tick) lo = mid;
    else hi = mid;
  }
  return [arr[lo], arr[hi]];
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shortest-path angle interpolation (handles 360→0 wrap). */
const lerpAngle = (a: number, b: number, t: number): number => {
  let diff = b - a;
  // Normalize diff to [-180, 180]
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return a + diff * t;
};

/** Utility zone duration by grenade type (in ticks). */
const utilityDuration = (type: string): number => {
  switch (type) {
    case "smokegrenade": return SMOKE_DURATION;
    case "molotov":      return MOLOTOV_DURATION;
    case "flashbang":    return FLASH_DURATION;
    case "hegrenade":    return HE_DURATION;
    default:             return 0;
  }
};

/** Utility zone radius on the radar (in SVG pixels). */
const utilityRadius = (type: string): number => {
  switch (type) {
    case "smokegrenade": return 30;
    case "molotov":      return 24;
    case "flashbang":    return 22;
    case "hegrenade":    return 24;
    default:             return 0;
  }
};

/** Deterministic pseudo-random for stable smoke puff offsets. */
const pseudoRand = (seed: number): number =>
  ((Math.sin(seed * 127.1 + 311.7) * 43758.5453) % 1 + 1) % 1;

/**
 * Convert an array of [x,y] points into a smooth SVG cubic-bezier path string
 * using Catmull-Rom → cubic Bezier conversion. Produces a natural curve through
 * all control points.
 */
const smoothPath = (pts: [number, number][]): string => {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;

  let d = `M${pts[0][0]},${pts[0][1]}`;
  const alpha = 0.5; // tension — 0.5 = centripetal Catmull-Rom

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    // Catmull-Rom to cubic bezier control points
    const cp1x = p1[0] + (p2[0] - p0[0]) / (6 / alpha);
    const cp1y = p1[1] + (p2[1] - p0[1]) / (6 / alpha);
    const cp2x = p2[0] - (p3[0] - p1[0]) / (6 / alpha);
    const cp2y = p2[1] - (p3[1] - p1[1]) / (6 / alpha);

    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
};

export default function MatchReplayViewer({ demoFile, onBack }: Props) {
  const [timeline, setTimeline] = useState<MatchTimeline | null>(null);
  const [radar, setRadar] = useState<RadarInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMsg] = useState("Parsing demo (this can take 5–15s on first open)…");
  const [currentTick, setCurrentTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [insights, setInsights] = useState<string | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [matchInfo, setMatchInfo] = useState<MatchInfoResponse | null>(null);
  const [showNadePanel, setShowNadePanel] = useState(false);

  // Nade analysis filter / highlight state
  const ALL_NADE_TYPES = ["smokegrenade", "flashbang", "hegrenade", "molotov"] as const;
  const [nadeTypeFilter, setNadeTypeFilter] = useState<Set<string>>(
    () => new Set(ALL_NADE_TYPES),
  );
  const [highlightedNadeIdx, setHighlightedNadeIdx] = useState<number | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [expandedTimeline, setExpandedTimeline] = useState<number | null>(null); // round num
  const [nadeAnalysisTab, setNadeAnalysisTab] = useState<"rounds" | "patterns">("rounds");

  // Utility pattern overlay mode
  const [utilPatternMode, setUtilPatternMode] = useState(false);
  const [utilPatternTime, setUtilPatternTime] = useState(15); // seconds into round
  const [utilPatternSide, setUtilPatternSide] = useState<"all" | 2 | 3>("all");
  const [utilPatternPlaying, setUtilPatternPlaying] = useState(false);
  const [utilPatternSpeed, setUtilPatternSpeed] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setTimeline(null);
    setMatchInfo(null);
    // Fetch match info in parallel with timeline
    getMatchInfo(demoFile).then((mi) => { if (!cancelled) setMatchInfo(mi); }).catch(() => {});
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

  // ── Playback loop — uses ref to avoid re-creating the rAF on each tick ──
  const tickRef = useRef(currentTick);
  tickRef.current = currentTick;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (!playing || !timeline) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      if (!playingRef.current) return;
      const dt = (now - last) / 1000;
      last = now;
      // Advance by wall-clock delta × tickrate × speed
      const next = Math.min(tickRef.current + dt * 64 * speedRef.current, timeline.tick_max);
      setCurrentTick(next);
      if (next >= timeline.tick_max) { setPlaying(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline]);

  // Speed changes don't restart the rAF loop — speedRef is read live.

  // World→pixel projection
  const project = useCallback((x: number, y: number): [number, number] => {
    if (!radar) return [0, 0];
    return [
      (x - radar.pos_x) / radar.scale,
      (radar.pos_y - y) / radar.scale,
    ];
  }, [radar]);

  // ── Helper: look up a player's team_num at any tick from position data ──
  const getTeamAtTick = useCallback((steamid: string, tick: number): number => {
    if (!timeline) return 0;
    const samples = timeline.positions[steamid];
    if (!samples) return 0;
    const flanking = flankingSamples(samples, tick);
    if (!flanking) return 0;
    return flanking[1].tn ?? flanking[0].tn ?? 0;
  }, [timeline]);

  // ── Interpolated player states with smooth yaw + hp ──
  // Uses per-tick team_num (tn) so colors swap correctly at halftime.
  const playerStates = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    return timeline.players.map((p) => {
      const samples = timeline.positions[p.steamid] ?? [];
      const flanking = flankingSamples(samples, tick);
      if (!flanking) return null;
      const [a, b] = flanking;
      const span = b.t - a.t;
      const t = span > 0 ? Math.min(1, Math.max(0, (tick - a.t) / span)) : 0;
      // Smooth cubic ease for positions (ease-in-out)
      const tSmooth = t * t * (3 - 2 * t);
      // Use per-tick team_num if available (swaps at halftime), fall back to roster
      const team = b.tn ?? a.tn ?? p.team_num;
      return {
        steamid: p.steamid,
        name: p.name,
        team,
        x: lerp(a.x, b.x, tSmooth),
        y: lerp(a.y, b.y, tSmooth),
        yaw: lerpAngle(a.yaw, b.yaw, tSmooth),
        alive: b.alive,
        hp: Math.round(lerp(a.hp, b.hp, t)),
        weapon: b.w ?? "",
        armor: b.ar ?? 0,
        helmet: b.hl ?? false,
        hasBomb: (b.w ?? "").toLowerCase().includes("c4"),
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null);
  }, [timeline, currentTick]);

  // Dynamic sidToTeam: uses current-tick team_num from playerStates (handles halftime swap)
  const sidToTeam = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of playerStates) m[p.steamid] = p.team;
    // Fill in any missing players from the static roster as fallback
    for (const p of timeline?.players ?? []) {
      if (!(p.steamid in m)) m[p.steamid] = p.team_num;
    }
    return m;
  }, [playerStates, timeline]);

  const sidToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of timeline?.players ?? []) m[p.steamid] = p.name;
    return m;
  }, [timeline]);

  // Team names: prefer roster data from HLTV, fall back to "T" / "CT".
  // team_num 2 = T-side, 3 = CT-side (always, swaps at half in the per-tick data).
  // We label by current side, not by org name, so sides are always clear.
  // The org names go in the header where we know first-half mapping.
  const teamOrgNames = useMemo<Record<number, string>>(() => {
    if (matchInfo?.team1 && matchInfo?.team2) {
      // First-half roster: check which players were team_num 2 (T) in early ticks
      const tPlayers = new Set(
        (timeline?.players ?? []).filter((p) => p.team_num === 2).map((p) => p.name.toLowerCase())
      );
      const team1Players = (matchInfo.team1.players ?? []).map((n) => n.toLowerCase());
      const team1IsT = team1Players.some((n) => tPlayers.has(n));
      return {
        2: team1IsT ? matchInfo.team1.name : matchInfo.team2.name,
        3: team1IsT ? matchInfo.team2.name : matchInfo.team1.name,
      };
    }
    return { 2: "Terrorists", 3: "Counter-Terrorists" };
  }, [matchInfo, timeline]);

  // Dynamic team names: always shows which org is on which side RIGHT NOW.
  // Since team_num 2 = T and 3 = CT, and playerStates already uses per-tick tn,
  // we need to figure out which org is currently T vs CT.
  const teamNames = useMemo<Record<number, string>>(() => {
    // team_num 2 is always the T side, 3 is always CT side.
    // The org assigned to team_num 2/3 changes at halftime in the per-tick data.
    // Use current playerStates to check: find a player whose org we know, check their current team.
    if (!matchInfo?.team1 || !matchInfo?.team2) return { 2: "T", 3: "CT" };

    const team1PlayersLower = new Set((matchInfo.team1.players ?? []).map((n) => n.toLowerCase()));
    // Find any current playerState whose name matches team1
    const team1Player = playerStates.find((p) => team1PlayersLower.has(p.name.toLowerCase()));
    if (team1Player) {
      return {
        [team1Player.team]: matchInfo.team1.name,
        [team1Player.team === 2 ? 3 : 2]: matchInfo.team2.name,
      };
    }
    // Fallback to first-half mapping
    return teamOrgNames;
  }, [matchInfo, playerStates, teamOrgNames]);

  // Per-round grenade summary for the nade analysis panel
  // Each nade carries its global index into timeline.grenades for highlight linking.
  interface RoundNadeEntry {
    globalIdx: number;
    type: string;
    thrower: string;      // steamid
    throwerName: string;
    team: number;
    throwTick: number;
  }
  interface RoundNadeInfo {
    round: (typeof timeline extends null ? never : NonNullable<typeof timeline>)["rounds"][0];
    nades: RoundNadeEntry[];
    byTeam: Record<number, Record<string, number>>;
    // Per-player within each team
    byPlayer: Record<number, { name: string; steamid: string; types: Record<string, number> }[]>;
  }
  const roundNades = useMemo((): RoundNadeInfo[] => {
    if (!timeline) return [];
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

  // Flash effectiveness: for each flashbang, count alive enemies within ~1200 game units
  // at the detonation tick. Computed once over the entire timeline.
  const flashEffectiveness = useMemo<Record<number, number>>(() => {
    if (!timeline) return {};
    const FLASH_RANGE = 1200; // CS2 flash effective range in game units
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
        if (p.team_num === throwerTeam) continue; // skip teammates
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

  // Cross-round nade pattern detection: find repeated nade combos (≥3 nades, same team, ≤10s window)
  // Returns map: round_num → { patternId, rounds: number[], label: string }
  const roundPatterns = useMemo<Record<number, { patternId: string; rounds: number[]; label: string }>>(() => {
    if (!timeline) return {};
    const BUCKET = 200; // position bucket size (game units) — coarser than lineup clustering for pattern matching
    const TIME_WINDOW = 10 * 64; // 10s in ticks
    const bucketKey = (x: number, y: number, type: string) =>
      `${Math.round(x / BUCKET)}_${Math.round(y / BUCKET)}_${type}`;

    // For each round, find nade bursts per team
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

        // Find burst: nades within TIME_WINDOW of the first
        const firstTick = teamNades[0].g.points[0]?.[0] ?? 0;
        const burst = teamNades.filter(({ g }) => {
          const t = g.points[0]?.[0] ?? 0;
          return t - firstTick <= TIME_WINDOW;
        });
        if (burst.length < 3) continue;

        // Create a signature from bucketed landing positions
        const keys = burst.map(({ g }) => {
          const lastPt = g.points[g.points.length - 1];
          return bucketKey(lastPt[1], lastPt[2], g.type);
        }).sort();
        const sig = keys.join("|");
        roundSignatures.push({ roundNum: r.num, team, sig });
      }
    }

    // Find signatures that appear in ≥2 rounds
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

  // Landing heatmap: aggregate all nade landing positions, respecting type filter
  const heatmapPoints = useMemo(() => {
    if (!timeline || !showHeatmap) return [];
    const pts: { x: number; y: number; type: string }[] = [];
    for (const g of timeline.grenades) {
      if (!nadeTypeFilter.has(g.type)) continue;
      if (!g.points.length) continue;
      const lastPt = g.points[g.points.length - 1];
      pts.push({ x: lastPt[1], y: lastPt[2], type: g.type });
    }
    return pts;
  }, [timeline, showHeatmap, nadeTypeFilter]);

  // Per-nade-type landing clusters: group all nades by bucketed landing position
  // to find repeated throws across rounds (regardless of who threw them).
  interface NadeLandingCluster {
    type: string;
    landX: number;
    landY: number;
    occurrences: { globalIdx: number; roundNum: number; throwerName: string; throwTick: number }[];
  }
  const nadeLandingClusters = useMemo<NadeLandingCluster[]>(() => {
    if (!timeline) return [];
    const BUCKET = 150; // game units — groups nades landing in similar spots
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
      // Use running average for land position
      const n = cluster.occurrences.length;
      cluster.landX = (cluster.landX * n + lx) / (n + 1);
      cluster.landY = (cluster.landY * n + ly) / (n + 1);
      cluster.occurrences.push({
        globalIdx: gi,
        roundNum,
        throwerName: sidToName[g.thrower] ?? "?",
        throwTick,
      });
    }
    // Only keep clusters that appear in 2+ rounds
    return Array.from(bucketMap.values())
      .filter((c) => {
        const uniqueRounds = new Set(c.occurrences.map((o) => o.roundNum));
        return uniqueRounds.size >= 2;
      })
      .sort((a, b) => b.occurrences.length - a.occurrences.length);
  }, [timeline, sidToName]);

  // ── Utility pattern overlay: all nades from all rounds, with full trajectory ──
  // Shows animated grenade flight paths at a given second, aggregated across all rounds.
  interface UtilPatternNade {
    globalIdx: number;
    type: string;
    throwerName: string;
    team: number;
    roundNum: number;
    throwSecond: number;    // seconds into round when thrown
    landSecond: number;     // seconds into round when landed
    throwX: number;
    throwY: number;
    landX: number;
    landY: number;
    points: number[][];     // [[tick, x, y], ...] — full flight trajectory
    roundStartTick: number;
  }
  const utilPatternNades = useMemo<UtilPatternNade[]>(() => {
    if (!timeline) return [];
    const out: UtilPatternNade[] = [];
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (!g.points.length) continue;
      if (!nadeTypeFilter.has(g.type)) continue;
      const throwTick = g.points[0][0];
      const lastPt = g.points[g.points.length - 1];
      const round = timeline.rounds.find(
        (r) => throwTick >= r.start_tick && throwTick <= r.end_tick,
      );
      if (!round) continue;
      const team = sidToTeam[g.thrower] ?? 0;
      if (utilPatternSide !== "all" && team !== utilPatternSide) continue;
      out.push({
        globalIdx: gi,
        type: g.type,
        throwerName: sidToName[g.thrower] ?? "?",
        team,
        roundNum: round.num,
        throwSecond: (throwTick - round.start_tick) / 64,
        landSecond: (lastPt[0] - round.start_tick) / 64,
        throwX: g.points[0][1],
        throwY: g.points[0][2],
        landX: lastPt[1],
        landY: lastPt[2],
        points: g.points,
        roundStartTick: round.start_tick,
      });
    }
    return out;
  }, [timeline, sidToTeam, sidToName, nadeTypeFilter, utilPatternSide]);

  // Max seconds across all rounds (for the time slider)
  const utilPatternMaxSec = useMemo(() => {
    if (!timeline) return 120;
    let maxSec = 0;
    for (const r of timeline.rounds) {
      maxSec = Math.max(maxSec, Math.round((r.end_tick - r.start_tick) / 64));
    }
    return maxSec;
  }, [timeline]);

  // ── Utility pattern playback loop ──
  const utilPatternPlayingRef = useRef(utilPatternPlaying);
  utilPatternPlayingRef.current = utilPatternPlaying;
  const utilPatternSpeedRef = useRef(utilPatternSpeed);
  utilPatternSpeedRef.current = utilPatternSpeed;
  const utilPatternTimeRef = useRef(utilPatternTime);
  utilPatternTimeRef.current = utilPatternTime;

  useEffect(() => {
    if (!utilPatternPlaying || !utilPatternMode) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      if (!utilPatternPlayingRef.current) return;
      const dt = (now - last) / 1000;
      last = now;
      const next = utilPatternTimeRef.current + dt * utilPatternSpeedRef.current;
      if (next >= utilPatternMaxSec) {
        setUtilPatternTime(0);
      } else {
        setUtilPatternTime(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [utilPatternPlaying, utilPatternMode, utilPatternMaxSec]);

  // Stop util pattern playback when exiting pattern mode
  useEffect(() => {
    if (!utilPatternMode) setUtilPatternPlaying(false);
  }, [utilPatternMode]);

  // Nades visible at the current utilPatternTime — show if in flight or recently landed
  const utilPatternVisible = useMemo(() => {
    if (!utilPatternMode) return [];
    const T = utilPatternTime;
    const LAND_LINGER = 3; // show landed nade for 3s after landing
    return utilPatternNades
      .filter((n) => T >= n.throwSecond - 0.5 && T <= n.landSecond + LAND_LINGER)
      .map((n) => {
        const flightDur = n.landSecond - n.throwSecond;
        // Progress: 0 = just thrown, 1 = just landed, >1 = lingering at landing
        const progress = flightDur > 0 ? Math.max(0, (T - n.throwSecond) / flightDur) : 1;
        return { ...n, progress: Math.min(progress, 1), landed: T >= n.landSecond };
      });
  }, [utilPatternMode, utilPatternNades, utilPatternTime]);

  // ── Active grenade trails (in-flight) ──
  // Backend trims points to flight-only and sets detonate_tick to the landing
  // moment, so we just use the points array bounds directly.
  // Includes interpolated head position for smooth animation between samples.
  const activeGrenades = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    const out: { type: string; pts: number[][]; headX: number; headY: number; thrower: string; globalIdx: number }[] = [];
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (!nadeTypeFilter.has(g.type)) continue;
      if (!g.points.length) continue;
      const first = g.points[0][0];
      const last = g.points[g.points.length - 1][0];
      if (tick < first || tick >= last) continue;
      const visible = g.points.filter((p) => p[0] <= tick);
      if (visible.length < 2) continue;
      // Interpolate head position smoothly between last visible and next sample
      const lastVisible = visible[visible.length - 1];
      const nextIdx = g.points.findIndex((p) => p[0] > tick);
      let headX = lastVisible[1], headY = lastVisible[2];
      if (nextIdx > 0) {
        const prev = g.points[nextIdx - 1];
        const next = g.points[nextIdx];
        const span = next[0] - prev[0];
        if (span > 0) {
          const t = (tick - prev[0]) / span;
          const tSmooth = t * t * (3 - 2 * t); // smooth ease
          headX = prev[1] + (next[1] - prev[1]) * tSmooth;
          headY = prev[2] + (next[2] - prev[2]) * tSmooth;
        }
      }
      out.push({ type: g.type, pts: visible, headX, headY, thrower: g.thrower, globalIdx: gi });
    }
    return out;
  }, [timeline, currentTick, nadeTypeFilter]);

  // ── Utility zones — start at the last flight point (= landing / detonation) ──
  const activeUtilityZones = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    const out: {
      type: string;
      x: number; y: number;
      progress: number;
      remaining: number;
      seed: number;
      globalIdx: number;
    }[] = [];
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (!nadeTypeFilter.has(g.type)) continue;
      const dur = utilityDuration(g.type);
      if (dur === 0 || !g.points.length) continue;
      const lastPt = g.points[g.points.length - 1];
      const det = lastPt[0];
      const elapsed = tick - det;
      if (elapsed < 0 || elapsed > dur) continue;
      out.push({
        type: g.type,
        x: lastPt[1],
        y: lastPt[2],
        progress: elapsed / dur,
        remaining: Math.max(0, (dur - elapsed) / 64),
        seed: gi,
        globalIdx: gi,
      });
    }
    return out;
  }, [timeline, currentTick, nadeTypeFilter]);

  // ── Shooting tracers (brief lines on weapon_fire events) ──
  const recentFires = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    const TRACER_WINDOW = 12; // ~0.2s
    const out: { shooter: string; alpha: number }[] = [];
    for (const e of timeline.events) {
      if (e.type !== "fire") continue;
      const dt = tick - e.tick;
      if (dt < 0) break;
      if (dt > TRACER_WINDOW) continue;
      const w = e.data.weapon ?? "";
      if (w.includes("knife") || w.includes("grenade") || w.includes("flashbang")
          || w.includes("smoke") || w.includes("molotov") || w.includes("incendiary")
          || w.includes("decoy") || w.includes("c4")) continue;
      out.push({ shooter: e.data.shooter, alpha: 1 - dt / TRACER_WINDOW });
    }
    return out;
  }, [timeline, currentTick]);

  // ── Kill events: lines + markers + feed ──
  const recentKills = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    const KILL_WINDOW = 192; // 3s
    const out: {
      tick: number;
      victim: string;
      attacker: string;
      weapon: string;
      headshot: boolean;
      penetrated: boolean;
      noscope: boolean;
      attackerblind: boolean;
      thrusmoke: boolean;
      dominated: boolean;
      revenge: boolean;
      alpha: number;
    }[] = [];
    for (const e of timeline.events) {
      if (e.type !== "death") continue;
      const dt = tick - e.tick;
      if (dt < 0 || dt > KILL_WINDOW) continue;
      const isTruthy = (v: string | undefined) => v === "True" || v === "true" || (!!v && v !== "0" && v !== "" && v !== "False" && v !== "false" && v !== "nan");
      out.push({
        tick: e.tick,
        victim: e.data.victim,
        attacker: e.data.attacker,
        weapon: e.data.weapon ?? "",
        headshot: isTruthy(e.data.headshot),
        penetrated: isTruthy(e.data.penetrated),
        noscope: isTruthy(e.data.noscope),
        attackerblind: isTruthy(e.data.attackerblind),
        thrusmoke: isTruthy(e.data.thrusmoke),
        dominated: isTruthy(e.data.dominated),
        revenge: isTruthy(e.data.revenge),
        alpha: Math.min(1, 1 - (dt - 32) / (KILL_WINDOW - 32)),
      });
    }
    return out;
  }, [timeline, currentTick]);

  // Kill feed — last 5 kills up to current tick
  const killFeed = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    const FEED_WINDOW = 5 * 64;
    const isTruthy = (v: string | undefined) => v === "True" || v === "true" || (!!v && v !== "0" && v !== "" && v !== "False" && v !== "false" && v !== "nan");
    const kills: {
      attacker: string;
      victim: string;
      weapon: string;
      headshot: boolean;
      penetrated: boolean;
      noscope: boolean;
      attackerblind: boolean;
      thrusmoke: boolean;
      dominated: boolean;
      revenge: boolean;
      attackerTeam: number;
      victimTeam: number;
    }[] = [];
    for (const e of timeline.events) {
      if (e.type !== "death") continue;
      if (e.tick > tick) break;
      if (tick - e.tick > FEED_WINDOW) continue;
      kills.push({
        attacker: sidToName[e.data.attacker] ?? "?",
        victim: sidToName[e.data.victim] ?? "?",
        weapon: (e.data.weapon ?? "").replace("weapon_", "").replace("_silencer", "(s)"),
        headshot: isTruthy(e.data.headshot),
        penetrated: isTruthy(e.data.penetrated),
        noscope: isTruthy(e.data.noscope),
        attackerblind: isTruthy(e.data.attackerblind),
        thrusmoke: isTruthy(e.data.thrusmoke),
        dominated: isTruthy(e.data.dominated),
        revenge: isTruthy(e.data.revenge),
        attackerTeam: sidToTeam[e.data.attacker] ?? 0,
        victimTeam: sidToTeam[e.data.victim] ?? 0,
      });
    }
    return kills.slice(-5);
  }, [timeline, currentTick, sidToName, sidToTeam]);

  // ── Bomb events ──
  const bombState = useMemo(() => {
    if (!timeline) return null;
    const tick = currentTick;
    let lastPlant: { tick: number; site: string; x: number; y: number; planter: string } | null = null;
    let defused = false;
    for (const e of timeline.events) {
      if (e.tick > tick) break;
      if (e.type === "bomb_plant") {
        let px = parseFloat(e.data.x) || 0;
        let py = parseFloat(e.data.y) || 0;
        // Fallback: if coordinates are 0, look up the planter's position at the plant tick
        if (px === 0 && py === 0 && e.data.planter) {
          const samples = timeline.positions[e.data.planter];
          if (samples) {
            const flanking = flankingSamples(samples, e.tick);
            if (flanking) {
              const [a, b] = flanking;
              const span = b.t - a.t;
              const t = span > 0 ? Math.min(1, Math.max(0, (e.tick - a.t) / span)) : 0;
              px = lerp(a.x, b.x, t);
              py = lerp(a.y, b.y, t);
            }
          }
        }
        lastPlant = {
          tick: e.tick,
          site: e.data.site ?? "?",
          x: px,
          y: py,
          planter: e.data.planter ?? "",
        };
        defused = false;
      } else if (e.type === "bomb_defuse") {
        defused = true;
      } else if (e.type === "round_end") {
        lastPlant = null;
        defused = false;
      }
    }
    if (!lastPlant || defused) return null;
    const elapsed = (tick - lastPlant.tick) / 64;
    const BOMB_TIMER = 40;
    if (elapsed > BOMB_TIMER) return null;
    return { site: lastPlant.site, elapsed, remaining: BOMB_TIMER - elapsed, x: lastPlant.x, y: lastPlant.y };
  }, [timeline, currentTick]);

  // Score — per-org, not per-side.
  // org1 = teamOrgNames[2] (org that started T in first half)
  // org2 = teamOrgNames[3] (org that started CT in first half)
  // For each round, check which side org1 is on via position data, then attribute wins.
  const score = useMemo(() => {
    if (!timeline) return { org1: 0, org2: 0, round: 0 };
    // Pick a reference player from org1 (first-half T side, roster team_num=2)
    const refSteamid = timeline.players.find((p) => p.team_num === 2)?.steamid;
    let org1 = 0, org2 = 0, round = 1;
    for (const r of timeline.rounds) {
      if (r.start_tick <= currentTick) round = r.num;
      if (r.end_tick > currentTick) break;
      if (!r.winner) continue;
      // Determine which side org1 is on in this round
      let org1Side = 2; // default T
      if (refSteamid) {
        org1Side = getTeamAtTick(refSteamid, r.start_tick) || 2;
      }
      const winningSide = r.winner === "T" ? 2 : 3;
      if (winningSide === org1Side) org1++;
      else org2++;
    }
    return { org1, org2, round };
  }, [timeline, currentTick, getTeamAtTick]);

  // Which side is org1 currently on? (for coloring org names)
  const org1CurrentSide = useMemo(() => {
    if (!timeline) return 2;
    const refSteamid = timeline.players.find((p) => p.team_num === 2)?.steamid;
    if (!refSteamid) return 2;
    return getTeamAtTick(refSteamid, currentTick) || 2;
  }, [timeline, currentTick, getTeamAtTick]);

  // ── Round outcomes for the vertical timeline ──
  interface RoundOutcome {
    num: number;
    winner: string | null; // "T" | "CT" | null
    startTick: number;
    endTick: number;
    bombPlanted: boolean;
    bombDefused: boolean;
    bombExploded: boolean;
    tAlive: number;    // T players alive at round end
    ctAlive: number;   // CT players alive at round end
  }
  const roundOutcomes = useMemo<RoundOutcome[]>(() => {
    if (!timeline) return [];
    return timeline.rounds.map((r) => {
      let bombPlanted = false;
      let bombDefused = false;
      for (const e of timeline.events) {
        if (e.tick < r.start_tick) continue;
        if (e.tick > r.end_tick) break;
        if (e.type === "bomb_plant") bombPlanted = true;
        if (e.type === "bomb_defuse") bombDefused = true;
      }
      // Count alive players at round end using per-tick team data (correct across halves)
      const deathsInRound = timeline.events.filter(
        (e) => e.type === "death" && e.tick >= r.start_tick && e.tick <= r.end_tick,
      );
      let tDeaths = 0;
      let ctDeaths = 0;
      for (const d of deathsInRound) {
        const victimTeam = getTeamAtTick(d.data.victim, d.tick);
        if (victimTeam === 2) tDeaths++;
        else if (victimTeam === 3) ctDeaths++;
      }
      const tAlive = Math.max(0, 5 - tDeaths);
      const ctAlive = Math.max(0, 5 - ctDeaths);

      // Bomb exploded = planted but not defused and T won
      const bombExploded = bombPlanted && !bombDefused && r.winner === "T";

      return {
        num: r.num,
        winner: r.winner,
        startTick: r.start_tick,
        endTick: r.end_tick,
        bombPlanted,
        bombDefused,
        bombExploded,
        tAlive,
        ctAlive,
      };
    });
  }, [timeline, getTeamAtTick]);

  const handleGenerateInsights = async () => {
    setInsightsError(null);
    setInsightsLoading(true);
    try {
      const res = await getMatchReplayInsights(demoFile);
      setInsights(res.summary);
    } catch (e: any) {
      setInsightsError(e?.response?.data?.detail ?? "Insights request failed");
    } finally {
      setInsightsLoading(false);
    }
  };

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="hud-btn text-xs self-start">← Back</button>
        <p className="text-[12px] text-cs2-red border-l-2 border-cs2-red/50 pl-2">{error}</p>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={onBack} className="hud-btn text-xs self-start">← Back</button>
        <p className="text-[12px] text-cs2-muted">{loadingMsg}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header — compact, stable org positions (org1=left, org2=right) */}
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <div>
          <h2 className="text-lg font-bold uppercase tracking-[0.18em]">
            <span style={{ color: TEAM_COLOR[org1CurrentSide] }}>{teamOrgNames[2]}</span>
            <span className="text-cs2-muted mx-2">vs</span>
            <span style={{ color: TEAM_COLOR[org1CurrentSide === 2 ? 3 : 2] }}>{teamOrgNames[3]}</span>
          </h2>
          {matchInfo?.event && (
            <p className="text-xs text-cs2-accent/70 mt-0.5">
              {matchInfo.event}
            </p>
          )}
          <p className="text-xs text-cs2-muted mt-0.5 font-mono">
            {timeline.map_name} · {Math.floor(currentTick / 64 / 60)}:{String(Math.floor((currentTick / 64) % 60)).padStart(2, "0")} / {Math.floor(timeline.tick_max / 64 / 60)}:{String(Math.floor((timeline.tick_max / 64) % 60)).padStart(2, "0")}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Score — per-org, stable positions */}
          <div className="flex items-center gap-3 font-mono text-2xl">
            <div className="flex items-center gap-1.5 mr-1">
              <span className="text-xs uppercase tracking-wider" style={{ color: TEAM_COLOR[org1CurrentSide] }}>
                {teamOrgNames[2]}
              </span>
              <span className="text-[9px] px-1 py-0.5 rounded font-bold"
                style={{ background: TEAM_COLOR[org1CurrentSide], color: "#000" }}>
                {org1CurrentSide === 2 ? "T" : "CT"}
              </span>
            </div>
            <span style={{ color: TEAM_COLOR[org1CurrentSide] }}>{score.org1}</span>
            <span className="text-cs2-muted text-sm">Round {score.round}</span>
            <span style={{ color: TEAM_COLOR[org1CurrentSide === 2 ? 3 : 2] }}>{score.org2}</span>
            <div className="flex items-center gap-1.5 ml-1">
              <span className="text-[9px] px-1 py-0.5 rounded font-bold"
                style={{ background: TEAM_COLOR[org1CurrentSide === 2 ? 3 : 2], color: "#000" }}>
                {org1CurrentSide === 2 ? "CT" : "T"}
              </span>
              <span className="text-xs uppercase tracking-wider" style={{ color: TEAM_COLOR[org1CurrentSide === 2 ? 3 : 2] }}>
                {teamOrgNames[3]}
              </span>
            </div>
          </div>
          {bombState && (
            <span className="text-sm font-mono text-cs2-red animate-pulse flex items-center gap-1.5">
              <img src="/icons/c4.svg" alt="bomb" className="w-5 h-5 inline"
                style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }} />
              {bombState.site} · {bombState.remaining.toFixed(0)}s
            </span>
          )}
          <button onClick={onBack} className="hud-btn text-sm">← Picker</button>
        </div>
      </div>

      {/* ═══ Horizontal round timeline ═══ */}
      <div className="shrink-0 px-2">
        <div className="hud-panel px-1.5 py-1.5 flex items-stretch gap-0">
          {roundOutcomes.map((ro) => {
            const isCurrent = ro.num === score.round;
            const winColor = ro.winner === "T" ? TEAM_COLOR[2] : ro.winner === "CT" ? TEAM_COLOR[3] : "#555";
            const elimination = !ro.bombDefused && !ro.bombExploded && ro.winner;
            // For the CURRENT round, use live playerStates. For past rounds, use precomputed end-of-round data.
            const liveTAlive = isCurrent ? playerStates.filter((p) => p.team === 2 && p.alive).length : ro.tAlive;
            const liveCTAlive = isCurrent ? playerStates.filter((p) => p.team === 3 && p.alive).length : ro.ctAlive;
            // For future rounds (not yet played), show all 5
            const isPlayed = ro.endTick <= currentTick;
            const tBars = isPlayed || isCurrent ? liveTAlive : 5;
            const ctBars = isPlayed || isCurrent ? liveCTAlive : 5;
            return (
              <React.Fragment key={ro.num}>
                {ro.num === 13 && (
                  <div className="w-[2px] bg-cs2-accent/50 shrink-0 mx-1 self-stretch rounded" />
                )}
                <button
                  onClick={() => setCurrentTick(ro.startTick)}
                  className={`flex flex-col items-center justify-center py-1 rounded transition-all flex-1 min-w-0 ${
                    isCurrent ? "bg-cs2-accent/20 ring-1 ring-cs2-accent/50" : "hover:bg-cs2-border/20"
                  }`}
                >
                  {/* Round number */}
                  <span className={`text-[11px] leading-none ${isCurrent ? "text-white font-bold" : "text-cs2-muted"}`}>{ro.num}</span>

                  {/* T-side alive bars (top) */}
                  <div className="flex justify-center gap-[2px] mt-1">
                    {Array.from({ length: 5 }, (_, j) => (
                      <div key={`t${j}`} className="rounded-sm"
                        style={{
                          width: 5, height: 12,
                          background: j < tBars ? TEAM_COLOR[2] : "#444",
                        }} />
                    ))}
                  </div>

                  {/* Winner color bar (center divider) */}
                  <div className="w-[85%] h-[3px] rounded-full my-[3px]" style={{ background: isPlayed ? winColor : "#333" }} />

                  {/* CT-side alive bars (bottom) */}
                  <div className="flex justify-center gap-[2px]">
                    {Array.from({ length: 5 }, (_, j) => (
                      <div key={`ct${j}`} className="rounded-sm"
                        style={{
                          width: 5, height: 12,
                          background: j < ctBars ? TEAM_COLOR[3] : "#444",
                        }} />
                    ))}
                  </div>

                  {/* Round outcome icon */}
                  <div className="flex items-center justify-center mt-0.5" style={{ minHeight: 16 }}>
                    {ro.bombDefused && (
                      <img src="/icons/defuser.svg" alt="defused" className="w-4 h-4"
                        style={{ filter: "brightness(0) invert(0.6) sepia(1) hue-rotate(180deg) saturate(3)" }} />
                    )}
                    {ro.bombExploded && (
                      <img src="/icons/c4.svg" alt="exploded" className="w-4 h-4"
                        style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }} />
                    )}
                    {elimination && !ro.bombPlanted && (
                      <img src="/icons/killfeed/icon_suicide.svg" alt="eliminated" className="w-4 h-4"
                        style={{ filter: `brightness(0) saturate(100%) ${
                          ro.winner === "T"
                            ? "invert(85%) sepia(30%) saturate(800%) hue-rotate(5deg)"
                            : "invert(60%) sepia(50%) saturate(500%) hue-rotate(190deg)"
                        }` }} />
                    )}
                  </div>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* ═══ Main area: map | sidebar ═══ */}
      <div className="flex-1 min-h-0 flex gap-2 px-2 overflow-hidden">
        {/* ── Map + overlays ── */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-1">
          <div className="hud-panel p-2 flex flex-col gap-1 flex-1 min-h-0 overflow-hidden">
          {/* Nade type filter toggles */}
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[11px] text-cs2-muted uppercase tracking-[0.12em] mr-1">Nades</span>
            {ALL_NADE_TYPES.map((t) => {
              const active = nadeTypeFilter.has(t);
              const color = GRENADE_COLOR[t] ?? "#9ca3af";
              const label = t.replace("grenade", "");
              return (
                <button
                  key={t}
                  onClick={() => setNadeTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(t)) next.delete(t);
                    else next.add(t);
                    return next;
                  })}
                  className="px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wide border transition-all"
                  style={{
                    borderColor: active ? color : "transparent",
                    background: active ? `${color}20` : "transparent",
                    color: active ? color : "#64748b",
                    opacity: active ? 1 : 0.5,
                  }}
                >
                  {label}
                </button>
              );
            })}
            {nadeTypeFilter.size < ALL_NADE_TYPES.length && (
              <button
                onClick={() => setNadeTypeFilter(new Set(ALL_NADE_TYPES))}
                className="text-[11px] text-cs2-accent/60 hover:text-cs2-accent ml-1"
              >
                All
              </button>
            )}
            <span className="w-px h-3 bg-cs2-border/40 mx-1" />
            <button
              onClick={() => setShowHeatmap((v) => !v)}
              className="px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wide border transition-all"
              style={{
                borderColor: showHeatmap ? "#22d3ee" : "transparent",
                background: showHeatmap ? "rgba(34,211,238,0.15)" : "transparent",
                color: showHeatmap ? "#22d3ee" : "#64748b",
                opacity: showHeatmap ? 1 : 0.5,
              }}
            >
              Heatmap
            </button>
            <button
              onClick={() => setUtilPatternMode((v) => !v)}
              className="px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wide border transition-all"
              style={{
                borderColor: utilPatternMode ? "#a78bfa" : "transparent",
                background: utilPatternMode ? "rgba(167,139,250,0.15)" : "transparent",
                color: utilPatternMode ? "#a78bfa" : "#64748b",
                opacity: utilPatternMode ? 1 : 0.5,
              }}
            >
              Util Pattern
            </button>
          </div>
          {/* Utility pattern controls — side filter + time slider */}
          {utilPatternMode && (
            <div className="flex items-center gap-2 px-1">
              {/* Play/pause */}
              <button
                onClick={() => setUtilPatternPlaying((v) => !v)}
                className="hud-btn text-xs px-2 py-0.5"
              >
                {utilPatternPlaying ? "⏸" : "▶"}
              </button>
              {/* Speed */}
              <div className="flex items-center gap-0.5">
                {[0.5, 1, 2, 4].map((s) => (
                  <button
                    key={s}
                    onClick={() => setUtilPatternSpeed(s)}
                    className="px-1 py-0.5 rounded text-[10px] font-mono transition-all"
                    style={{
                      background: utilPatternSpeed === s ? "rgba(167,139,250,0.25)" : "transparent",
                      color: utilPatternSpeed === s ? "#a78bfa" : "#64748b",
                    }}
                  >{s}×</button>
                ))}
              </div>
              {/* Side filter */}
              <div className="flex items-center gap-1">
                {(["all", 2, 3] as const).map((s) => {
                  const label = s === "all" ? "Both" : s === 2 ? "T" : "CT";
                  const active = utilPatternSide === s;
                  const color = s === 2 ? TEAM_COLOR[2] : s === 3 ? TEAM_COLOR[3] : "#9ca3af";
                  return (
                    <button
                      key={String(s)}
                      onClick={() => setUtilPatternSide(s)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono border transition-all"
                      style={{
                        borderColor: active ? color : "transparent",
                        background: active ? `${color}25` : "transparent",
                        color: active ? color : "#64748b",
                      }}
                    >{label}</button>
                  );
                })}
              </div>
              {/* Time display + scrub bar */}
              <span className="text-[11px] text-cs2-muted font-mono">
                {Math.floor(utilPatternTime / 60)}:{String(Math.floor(utilPatternTime % 60)).padStart(2, "0")}
              </span>
              <input
                type="range" min={0} max={utilPatternMaxSec} step={0.1}
                value={utilPatternTime}
                onChange={(e) => { setUtilPatternTime(Number(e.target.value)); setUtilPatternPlaying(false); }}
                className="flex-1"
              />
              <span className="text-[10px] text-cs2-muted font-mono">
                {utilPatternVisible.length} nade{utilPatternVisible.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}
          <div className="relative flex-1 min-h-0 w-full" style={{ aspectRatio: "1 / 1", maxWidth: "100%", maxHeight: "100%", margin: "0 auto" }}>
            <svg
              viewBox={`0 0 ${RADAR_PX} ${RADAR_PX}`}
              className="absolute inset-0 w-full h-full"
            >
              {/* SVG defs for utility zone effects */}
              <defs>
                {/* Smoke — layered soft cloud */}
                <radialGradient id="smoke-outer">
                  <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.35" />
                  <stop offset="60%" stopColor="#94a3b8" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="smoke-inner">
                  <stop offset="0%" stopColor="#cbd5e1" stopOpacity="0.6" />
                  <stop offset="50%" stopColor="#cbd5e1" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#cbd5e1" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="smoke-core">
                  <stop offset="0%" stopColor="#e2e8f0" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#e2e8f0" stopOpacity="0" />
                </radialGradient>

                {/* Molotov — fire gradient with hot core */}
                <radialGradient id="fire-outer">
                  <stop offset="0%" stopColor="#f97316" stopOpacity="0.5" />
                  <stop offset="60%" stopColor="#dc2626" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#dc2626" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="fire-inner">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.7" />
                  <stop offset="50%" stopColor="#f97316" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#ea580c" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="fire-core">
                  <stop offset="0%" stopColor="#fef08a" stopOpacity="0.6" />
                  <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
                </radialGradient>

                {/* Flash — white hot burst */}
                <radialGradient id="flash-burst">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                  <stop offset="30%" stopColor="#fef9c3" stopOpacity="0.7" />
                  <stop offset="100%" stopColor="#fde047" stopOpacity="0" />
                </radialGradient>

                {/* HE — shockwave ring */}
                <radialGradient id="he-burst">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.7" />
                  <stop offset="40%" stopColor="#f87171" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#f87171" stopOpacity="0" />
                </radialGradient>

                {/* Glow filter for grenades in flight */}
                <filter id="glow-sm" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="2" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* Radar base image */}
              {radar && (
                <image
                  href={radar.image_url}
                  x={0} y={0}
                  width={RADAR_PX} height={RADAR_PX}
                  preserveAspectRatio="xMidYMid slice"
                />
              )}

              {/* ── Landing heatmap overlay ── */}
              {radar && showHeatmap && heatmapPoints.map((hp, i) => {
                const [cx, cy] = project(hp.x, hp.y);
                const color = GRENADE_COLOR[hp.type] ?? "#9ca3af";
                return (
                  <circle
                    key={`hm${i}`}
                    cx={cx} cy={cy} r={18}
                    fill={color}
                    fillOpacity={0.18}
                    stroke={color}
                    strokeWidth={1}
                    strokeOpacity={0.1}
                  />
                );
              })}

              {/* ── Utility pattern overlay ── */}
              {radar && utilPatternMode && utilPatternVisible.map((n, i) => {
                const color = GRENADE_COLOR[n.type] ?? "#9ca3af";
                const teamColor = TEAM_COLOR[n.team] ?? "#888";
                const icon = GRENADE_ICON[n.type];
                const [tx, ty] = project(n.throwX, n.throwY);
                const [lx, ly] = project(n.landX, n.landY);

                if (n.landed) {
                  // Nade has landed — show at landing position with pulsing zone
                  const fadeOut = Math.max(0, 1 - (n.progress - 1) * 0.3);
                  return (
                    <g key={`up${i}`} opacity={0.85 * fadeOut}>
                      {/* Landing zone */}
                      <circle cx={lx} cy={ly} r={10}
                        fill={color} fillOpacity={0.25}
                        stroke={color} strokeWidth={2} strokeOpacity={0.7}
                      />
                      {/* Nade type icon */}
                      {icon && (
                        <image href={icon}
                          x={lx - 8} y={ly - 8} width={16} height={16} opacity={0.9}
                        />
                      )}
                      {/* Round label */}
                      <text x={lx + 12} y={ly + 3} fill={color} fontSize={10}
                        fontFamily="monospace" stroke="#000" strokeWidth={2.5} paintOrder="stroke"
                      >
                        R{n.roundNum}
                      </text>
                    </g>
                  );
                }

                // Nade in-flight — show animated trajectory
                // Get points up to current progress along the flight
                const flightTicks = n.points.length;
                const visibleCount = Math.max(2, Math.ceil(flightTicks * n.progress));
                const visiblePts = n.points.slice(0, visibleCount);
                const projected: [number, number][] = visiblePts.map((p) => project(p[1], p[2]));

                // Interpolate head position for smooth animation
                const exactIdx = (flightTicks - 1) * n.progress;
                const loIdx = Math.min(Math.floor(exactIdx), flightTicks - 1);
                const hiIdx = Math.min(loIdx + 1, flightTicks - 1);
                const frac = exactIdx - loIdx;
                const tSmooth = frac * frac * (3 - 2 * frac);
                const headX = n.points[loIdx][1] + (n.points[hiIdx][1] - n.points[loIdx][1]) * tSmooth;
                const headY = n.points[loIdx][2] + (n.points[hiIdx][2] - n.points[loIdx][2]) * tSmooth;
                const [hx, hy] = project(headX, headY);
                projected.push([hx, hy]);

                const d = smoothPath(projected);

                return (
                  <g key={`up${i}`} opacity={0.85}>
                    {/* Throw position — team-colored dot */}
                    <circle cx={tx} cy={ty} r={4}
                      fill={teamColor} fillOpacity={0.6}
                      stroke={teamColor} strokeWidth={1}
                    />
                    {/* Animated flight trail */}
                    <path d={d} fill="none" stroke={color}
                      strokeWidth={2.5} strokeOpacity={0.6}
                      strokeDasharray="6 3" strokeLinecap="round"
                    />
                    {/* Grenade icon at head */}
                    {icon ? (
                      <image href={icon}
                        x={hx - 10} y={hy - 10} width={20} height={20}
                      />
                    ) : (
                      <circle cx={hx} cy={hy} r={5} fill={color} fillOpacity={0.9}
                        stroke="#000" strokeWidth={1.5}
                      />
                    )}
                    {/* Glow ring */}
                    <circle cx={hx} cy={hy} r={12} fill="none"
                      stroke={color} strokeWidth={1.5} strokeOpacity={0.3}
                    />
                    {/* Round label */}
                    <text x={hx + 14} y={hy + 3} fill={color} fontSize={9}
                      fontFamily="monospace" stroke="#000" strokeWidth={2.5} paintOrder="stroke"
                    >
                      R{n.roundNum}
                    </text>
                  </g>
                );
              })}

              {/* ── Utility zones ── */}
              {radar && activeUtilityZones.map((uz, i) => {
                const [cx, cy] = project(uz.x, uz.y);
                const r = utilityRadius(uz.type);
                const uzDimmed = highlightedNadeIdx !== null && uz.globalIdx !== highlightedNadeIdx;

                if (uz.type === "smokegrenade") {
                  // Multi-layered smoke cloud with drifting puffs
                  const fadeIn = Math.min(1, uz.progress * 20); // quick fade-in over first 5%
                  const fadeOut = uz.progress > 0.9 ? (1 - uz.progress) * 10 : 1;
                  const opacity = fadeIn * fadeOut;
                  const breathe = 1 + 0.03 * Math.sin(uz.progress * Math.PI * 8);
                  // 6 puffs around center for cloudy look
                  const puffs = Array.from({ length: 6 }, (_, j) => {
                    const angle = (j / 6) * Math.PI * 2 + pseudoRand(uz.seed + j) * 0.5;
                    const dist = r * 0.4 * pseudoRand(uz.seed + j + 10);
                    const puffR = r * (0.5 + 0.3 * pseudoRand(uz.seed + j + 20));
                    const drift = 1 + 0.06 * Math.sin(uz.progress * Math.PI * 4 + j);
                    return {
                      cx: cx + Math.cos(angle) * dist * drift,
                      cy: cy + Math.sin(angle) * dist * drift,
                      r: puffR * breathe,
                    };
                  });
                  // Countdown arc
                  const arcFraction = 1 - uz.progress;
                  const arcR = r + 6;
                  const arcEnd = arcFraction * 2 * Math.PI - Math.PI / 2;
                  const arcStartX = cx;
                  const arcStartY = cy - arcR;
                  const arcEndX = cx + arcR * Math.cos(arcEnd);
                  const arcEndY = cy + arcR * Math.sin(arcEnd);
                  const largeArc = arcFraction > 0.5 ? 1 : 0;
                  return (
                    <g key={`uz${i}`} opacity={opacity * (uzDimmed ? 0.1 : 1)}>
                      {/* Outer cloud layer */}
                      <circle cx={cx} cy={cy} r={r * 1.15 * breathe}
                        fill="url(#smoke-outer)"
                      />
                      {/* Puff circles */}
                      {puffs.map((puff, j) => (
                        <circle key={j} cx={puff.cx} cy={puff.cy} r={puff.r}
                          fill="url(#smoke-inner)"
                        />
                      ))}
                      {/* Dense core */}
                      <circle cx={cx} cy={cy} r={r * 0.5 * breathe}
                        fill="url(#smoke-core)"
                      />
                      {/* Smoke icon at center */}
                      <image
                        href={GRENADE_ICON.smokegrenade}
                        x={cx - 8} y={cy - 14}
                        width={16} height={16} opacity={0.7}
                      />
                      {/* Countdown arc */}
                      {arcFraction > 0.01 && (
                        <path
                          d={`M ${arcStartX} ${arcStartY} A ${arcR} ${arcR} 0 ${largeArc} 1 ${arcEndX} ${arcEndY}`}
                          fill="none" stroke="#cbd5e1" strokeWidth={2.5} strokeOpacity={0.8}
                          strokeLinecap="round"
                        />
                      )}
                      {/* Timer text */}
                      <text x={cx} y={cy + 6} textAnchor="middle" fill="#fff" fontSize={13}
                        fontFamily="monospace" fontWeight="bold"
                        stroke="#000" strokeWidth={3} paintOrder="stroke"
                      >
                        {uz.remaining.toFixed(1)}s
                      </text>
                    </g>
                  );
                }

                if (uz.type === "molotov") {
                  // Animated fire patch with flickering flames
                  const fadeIn = Math.min(1, uz.progress * 15);
                  const fadeOut = uz.progress > 0.85 ? (1 - uz.progress) * 6.67 : 1;
                  const opacity = fadeIn * fadeOut;
                  // 8 flame tongues around center
                  const flames = Array.from({ length: 8 }, (_, j) => {
                    const angle = (j / 8) * Math.PI * 2;
                    const flicker = 0.7 + 0.3 * Math.sin(uz.progress * Math.PI * 20 + j * 1.7);
                    const dist = r * 0.55 * flicker;
                    const flameR = r * (0.3 + 0.15 * pseudoRand(uz.seed + j + 30)) * flicker;
                    return {
                      cx: cx + Math.cos(angle) * dist,
                      cy: cy + Math.sin(angle) * dist,
                      r: flameR,
                    };
                  });
                  // Countdown arc
                  const arcFraction = 1 - uz.progress;
                  const arcR = r + 5;
                  const arcEnd = arcFraction * 2 * Math.PI - Math.PI / 2;
                  const arcStartX = cx;
                  const arcStartY = cy - arcR;
                  const arcEndX = cx + arcR * Math.cos(arcEnd);
                  const arcEndY = cy + arcR * Math.sin(arcEnd);
                  const largeArc = arcFraction > 0.5 ? 1 : 0;
                  return (
                    <g key={`uz${i}`} opacity={opacity * (uzDimmed ? 0.1 : 1)}>
                      {/* Outer fire */}
                      <circle cx={cx} cy={cy} r={r}
                        fill="url(#fire-outer)"
                      />
                      {/* Flame tongues */}
                      {flames.map((f, j) => (
                        <circle key={j} cx={f.cx} cy={f.cy} r={f.r}
                          fill="url(#fire-inner)"
                        />
                      ))}
                      {/* Hot core */}
                      <circle cx={cx} cy={cy} r={r * 0.35}
                        fill="url(#fire-core)"
                      />
                      {/* Molotov icon */}
                      <image
                        href={GRENADE_ICON.molotov}
                        x={cx - 8} y={cy - 14}
                        width={16} height={16} opacity={0.8}
                      />
                      {/* Countdown arc */}
                      {arcFraction > 0.01 && (
                        <path
                          d={`M ${arcStartX} ${arcStartY} A ${arcR} ${arcR} 0 ${largeArc} 1 ${arcEndX} ${arcEndY}`}
                          fill="none" stroke="#fb923c" strokeWidth={2} strokeOpacity={0.9}
                          strokeLinecap="round"
                        />
                      )}
                      {/* Timer */}
                      <text x={cx} y={cy + 6} textAnchor="middle" fill="#fff" fontSize={12}
                        fontFamily="monospace" fontWeight="bold"
                        stroke="#000" strokeWidth={3} paintOrder="stroke"
                      >
                        {uz.remaining.toFixed(1)}s
                      </text>
                    </g>
                  );
                }

                if (uz.type === "flashbang") {
                  // Bright white burst that expands and fades fast
                  const fade = 1 - uz.progress;
                  const expand = 1 + uz.progress * 1.5;
                  return (
                    <g key={`uz${i}`} opacity={uzDimmed ? 0.1 : 1}>
                      {/* Outer glow ring */}
                      <circle cx={cx} cy={cy} r={r * expand * 1.3}
                        fill="none" stroke="#fde047" strokeWidth={3}
                        strokeOpacity={fade * 0.5}
                      />
                      {/* Main burst */}
                      <circle cx={cx} cy={cy} r={r * expand}
                        fill="url(#flash-burst)"
                        opacity={fade * 0.9}
                      />
                      {/* Flash icon at center */}
                      {uz.progress < 0.3 && (
                        <image
                          href={GRENADE_ICON.flashbang}
                          x={cx - 8} y={cy - 8}
                          width={16} height={16} opacity={fade}
                        />
                      )}
                    </g>
                  );
                }

                if (uz.type === "hegrenade") {
                  // Shockwave ring expanding outward + bright core
                  const fade = 1 - uz.progress;
                  const expand = 0.5 + uz.progress * 1.2;
                  const ringExpand = uz.progress * 2;
                  return (
                    <g key={`uz${i}`} opacity={uzDimmed ? 0.1 : 1}>
                      {/* Expanding shockwave ring */}
                      <circle cx={cx} cy={cy} r={r * ringExpand}
                        fill="none" stroke="#f87171" strokeWidth={4 * fade}
                        strokeOpacity={fade * 0.7}
                      />
                      {/* Outer secondary ring */}
                      <circle cx={cx} cy={cy} r={r * ringExpand * 0.7}
                        fill="none" stroke="#fbbf24" strokeWidth={2 * fade}
                        strokeOpacity={fade * 0.5}
                      />
                      {/* Fire/explosion fill */}
                      <circle cx={cx} cy={cy} r={r * expand * 0.8}
                        fill="url(#he-burst)"
                        opacity={fade * 0.8}
                      />
                      {/* Bright core */}
                      <circle cx={cx} cy={cy} r={r * 0.3 * fade}
                        fill="#fef08a" fillOpacity={fade * 0.9}
                      />
                      {/* HE icon */}
                      {uz.progress < 0.4 && (
                        <image
                          href={GRENADE_ICON.hegrenade}
                          x={cx - 8} y={cy - 8}
                          width={16} height={16} opacity={fade}
                        />
                      )}
                    </g>
                  );
                }
                return null;
              })}

              {/* ── Active grenade trails (in-flight) with grenade-type icons ── */}
              {radar && activeGrenades.map((g, i) => {
                const color = GRENADE_COLOR[g.type] ?? "#94a3b8";
                const icon = GRENADE_ICON[g.type];
                // Use interpolated head for smooth animation
                const [hx, hy] = project(g.headX, g.headY);
                const projected: [number, number][] = [...g.pts.map((p) => project(p[1], p[2])), [hx, hy]];
                const d = smoothPath(projected);
                const dimmed = highlightedNadeIdx !== null && g.globalIdx !== highlightedNadeIdx;
                return (
                  <g key={`g${i}`} filter="url(#glow-sm)" opacity={dimmed ? 0.1 : 1}>
                    {/* Smooth curved trail */}
                    <path d={d} fill="none" stroke={color}
                      strokeWidth={2.5} strokeOpacity={0.6} strokeDasharray="6 3"
                      strokeLinecap="round" strokeLinejoin="round"
                    />
                    {/* Grenade icon at interpolated head position */}
                    {icon ? (
                      <image
                        href={icon}
                        x={hx - 10} y={hy - 10}
                        width={20} height={20}
                      />
                    ) : (
                      <circle cx={hx} cy={hy} r={5} fill={color} fillOpacity={0.9}
                        stroke="#000" strokeWidth={1.5}
                      />
                    )}
                    {/* Glow ring around head */}
                    <circle cx={hx} cy={hy} r={12} fill="none"
                      stroke={color} strokeWidth={1.5} strokeOpacity={0.4}
                    />
                  </g>
                );
              })}

              {/* ── Shooting tracers ── */}
              {radar && recentFires.map((f, i) => {
                const shooter = playerStates.find((p) => p.steamid === f.shooter);
                if (!shooter || !shooter.alive) return null;
                const [sx, sy] = project(shooter.x, shooter.y);
                const yawRad = (shooter.yaw * Math.PI) / 180;
                const len = 55;
                const ex = sx + Math.cos(yawRad) * len;
                const ey = sy - Math.sin(yawRad) * len;
                return (
                  <g key={`f${i}`}>
                    {/* Muzzle flash dot */}
                    <circle cx={sx + Math.cos(yawRad) * 14} cy={sy - Math.sin(yawRad) * 14}
                      r={3} fill="#fde047" fillOpacity={f.alpha * 0.8}
                    />
                    {/* Tracer line */}
                    <line
                      x1={sx + Math.cos(yawRad) * 14} y1={sy - Math.sin(yawRad) * 14}
                      x2={ex} y2={ey}
                      stroke="#fde047" strokeWidth={1.5} strokeOpacity={f.alpha * 0.7}
                    />
                  </g>
                );
              })}

              {/* ── Kill lines (attacker → victim) ── */}
              {radar && recentKills.map((k, i) => {
                if (k.alpha <= 0) return null;
                const attacker = playerStates.find((p) => p.steamid === k.attacker);
                const victim = playerStates.find((p) => p.steamid === k.victim);
                if (!attacker || !victim) return null;
                const [ax, ay] = project(attacker.x, attacker.y);
                const [vx, vy] = project(victim.x, victim.y);
                const teamColor = TEAM_COLOR[sidToTeam[k.attacker] ?? 0] ?? "#fff";
                return (
                  <g key={`kl${i}`} opacity={Math.max(0, k.alpha)}>
                    <line x1={ax} y1={ay} x2={vx} y2={vy}
                      stroke={teamColor} strokeWidth={2} strokeDasharray="8 4"
                      strokeOpacity={0.6}
                    />
                  </g>
                );
              })}

              {/* ── Planted bomb on radar ── */}
              {radar && bombState && bombState.x !== 0 && bombState.y !== 0 && (() => {
                const [bx, by] = project(bombState.x, bombState.y);
                const pulse = 0.7 + 0.3 * Math.sin(bombState.elapsed * Math.PI * 2);
                return (
                  <g>
                    <circle cx={bx} cy={by} r={14} fill="rgba(239,68,68,0.25)" stroke="#ef4444"
                      strokeWidth={2} strokeOpacity={pulse} />
                    <image href="/icons/c4.svg" x={bx - 10} y={by - 10} width={20} height={20}
                      style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }}
                    />
                    <text x={bx} y={by + 22} textAnchor="middle"
                      className="text-[11px]" fill="#ef4444" fontFamily="monospace" fontSize="9">
                      {bombState.remaining.toFixed(0)}s
                    </text>
                  </g>
                );
              })()}

              {/* ── Bomb carrier indicator on player ── */}
              {radar && playerStates.filter((p) => p.hasBomb && p.alive).map((p) => {
                const [px, py] = project(p.x, p.y);
                return (
                  <image key={`bomb-${p.steamid}`} href="/icons/c4.svg"
                    x={px + 6} y={py - 14} width={10} height={10}
                    style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }}
                  />
                );
              })}

              {/* ── Player dots with health bars + equipment ── */}
              {radar && playerStates.map((p) => {
                const [px, py] = project(p.x, p.y);
                const color = TEAM_COLOR[p.team] ?? "#94a3b8";
                const yawRad = (p.yaw * Math.PI) / 180;
                const dirLen = 22;
                const fx = px + Math.cos(yawRad) * dirLen;
                const fy = py - Math.sin(yawRad) * dirLen;
                const hpFrac = Math.max(0, Math.min(1, p.hp / 100));
                const hpColor = hpFrac > 0.5 ? "#4ade80" : hpFrac > 0.25 ? "#fbbf24" : "#f87171";
                const wpnIcon = p.weapon && p.weapon !== "nan" && p.weapon !== "" && !p.weapon.toLowerCase().includes("c4")
                  ? weaponIconPath(p.weapon) : "";
                return (
                  <g key={p.steamid} opacity={p.alive ? 1 : 0.25}
                    style={{ transition: "opacity 0.3s ease" }}
                  >
                    {/* Yaw direction line */}
                    <line x1={px} y1={py} x2={fx} y2={fy}
                      stroke={color} strokeWidth={3}
                    />
                    {/* Player circle */}
                    <circle cx={px} cy={py} r={11}
                      fill={color} stroke="#000" strokeWidth={2}
                    />
                    {/* Player name + HP text */}
                    <text x={px + 14} y={py - 16} fill="#fff" fontSize={14}
                      fontFamily="monospace" stroke="#000" strokeWidth={3} paintOrder="stroke"
                    >
                      {p.name}
                    </text>
                    {/* HP number next to name */}
                    {p.alive && (
                      <text x={px + 14} y={py - 4} fill={hpColor} fontSize={11}
                        fontFamily="monospace" stroke="#000" strokeWidth={2.5} paintOrder="stroke"
                        fontWeight="bold"
                      >
                        {p.hp} HP
                      </text>
                    )}
                    {/* Health bar (below dot) */}
                    {p.alive && (
                      <g>
                        <rect x={px - 15} y={py + 14} width={30} height={3}
                          rx={1} fill="#000" fillOpacity={0.6}
                        />
                        <rect x={px - 15} y={py + 14} width={30 * hpFrac} height={3}
                          rx={1} fill={hpColor}
                        />
                      </g>
                    )}
                    {/* Equipment row below health bar: weapon icon + armor icon */}
                    {p.alive && (
                      <g>
                        {/* Weapon icon */}
                        {wpnIcon && (
                          <image href={wpnIcon}
                            x={px - 18} y={py + 19} width={28} height={14}
                            preserveAspectRatio="xMidYMid meet"
                            style={{ filter: "brightness(0) invert(0.9)" }}
                          />
                        )}
                        {/* Armor/helmet icon */}
                        {p.armor > 0 && (
                          <image href={p.helmet ? "/icons/helmet.svg" : "/icons/kevlar.svg"}
                            x={px + 12} y={py + 19} width={12} height={12}
                            style={{ filter: "brightness(0) invert(0.85)" }}
                          />
                        )}
                      </g>
                    )}
                  </g>
                );
              })}

              {/* ── Death X markers ── */}
              {radar && recentKills.map((k, i) => {
                if (k.alpha <= 0) return null;
                const victim = playerStates.find((p) => p.steamid === k.victim);
                if (!victim) return null;
                const [px, py] = project(victim.x, victim.y);
                const teamColor = TEAM_COLOR[sidToTeam[k.attacker] ?? 0] ?? "#fff";
                return (
                  <g key={`kx${i}`} opacity={Math.max(0, k.alpha)}>
                    <line x1={px - 8} y1={py - 8} x2={px + 8} y2={py + 8}
                      stroke={teamColor} strokeWidth={4}
                    />
                    <line x1={px - 8} y1={py + 8} x2={px + 8} y2={py - 8}
                      stroke={teamColor} strokeWidth={4}
                    />
                  </g>
                );
              })}
            </svg>

            {/* ── Kill feed overlay (top-right corner) ── */}
            {killFeed.length > 0 && (
              <div className="absolute top-2 right-2 flex flex-col gap-1 pointer-events-none">
                {killFeed.map((k, i) => {
                  const ICON_FILTER_RED = "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)";
                  const ICON_FILTER_WHITE = "brightness(0) invert(0.85)";
                  return (
                    <div key={i}
                      className="flex items-center gap-2 px-3 py-1 rounded text-sm font-mono"
                      style={{ background: "rgba(0,0,0,0.8)" }}
                    >
                      <span className="font-semibold" style={{ color: TEAM_COLOR[k.attackerTeam] ?? "#fff" }}>
                        {k.attacker}
                      </span>
                      <span className="flex items-center gap-1 text-cs2-muted">
                        {/* Special kill icons — order: blind → wallbang → noscope → smoke → weapon → headshot */}
                        {k.attackerblind && (
                          <img src="/icons/killfeed/blind_kill.svg" alt="blind" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_WHITE }} />
                        )}
                        {k.penetrated && (
                          <img src="/icons/killfeed/penetrate.svg" alt="wallbang" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_WHITE }} />
                        )}
                        {k.noscope && (
                          <img src="/icons/killfeed/noscope.svg" alt="noscope" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_WHITE }} />
                        )}
                        {k.thrusmoke && (
                          <img src="/icons/killfeed/smoke_kill.svg" alt="thrusmoke" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_WHITE }} />
                        )}
                        {/* Weapon icon */}
                        <img
                          src={`/icons/${k.weapon.replace("(s)", "_silencer")}.svg`}
                          alt={k.weapon}
                          className="w-8 h-5 object-contain"
                          style={{ filter: ICON_FILTER_WHITE }}
                          onError={(e) => {
                            const el = e.target as HTMLImageElement;
                            el.style.display = "none";
                            el.insertAdjacentText("afterend", k.weapon);
                          }}
                        />
                        {/* Headshot */}
                        {k.headshot && (
                          <img src="/icons/killfeed/icon_headshot.svg" alt="HS" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_RED }}
                          />
                        )}
                        {/* Domination / revenge */}
                        {k.dominated && (
                          <img src="/icons/killfeed/domination.svg" alt="domination" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_WHITE }} />
                        )}
                        {k.revenge && (
                          <img src="/icons/killfeed/revenge.svg" alt="revenge" className="w-4 h-4 shrink-0"
                            style={{ filter: ICON_FILTER_WHITE }} />
                        )}
                      </span>
                      <span className="font-semibold" style={{ color: TEAM_COLOR[k.victimTeam] ?? "#fff" }}>
                        {k.victim}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-1.5 px-1 pt-1 shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const prev = [...timeline.rounds].reverse()
                    .find((r) => r.start_tick < currentTick - 1);
                  if (prev) setCurrentTick(prev.start_tick);
                }}
                className="hud-btn text-sm" title="Previous round"
              >⏮</button>
              <button
                onClick={() => setPlaying((p) => !p)}
                className="hud-btn-primary text-sm"
                title={playing ? "Pause" : "Play"}
              >
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button
                onClick={() => {
                  const next = timeline.rounds.find((r) => r.start_tick > currentTick);
                  if (next) setCurrentTick(next.start_tick);
                }}
                className="hud-btn text-sm" title="Next round"
              >⏭</button>
              <div className="flex items-center gap-1 ml-2">
                {[0.5, 1, 2, 4].map((s) => (
                  <button key={s} onClick={() => setSpeed(s)}
                    className={`text-xs px-2 py-0.5 rounded font-mono ${
                      speed === s ? "bg-cs2-accent text-cs2-bg" : "hud-btn"
                    }`}
                  >{s}×</button>
                ))}
              </div>
              <span className="text-xs text-cs2-muted ml-auto font-mono">
                {Math.floor(currentTick / 64 / 60)}:{String(Math.floor((currentTick / 64) % 60)).padStart(2, "0")}
              </span>
            </div>
            <input
              type="range" min={0} max={timeline.tick_max} step={1}
              value={Math.round(currentTick)}
              onChange={(e) => setCurrentTick(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>{/* /hud-panel map */}
        </div>{/* /map area wrapper */}

        {/* ── Sidebar (right) ── */}
        <div className="w-[320px] shrink-0 flex flex-col gap-2 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {/* Scoreboard / player list — CS2-style with full loadout */}
          <div className="hud-panel p-2">
            {[2, 3].map((team) => {
              const teamPlayers = playerStates
                .filter((p) => p.team === team)
                .sort((a, b) => a.name.localeCompare(b.name));
              if (teamPlayers.length === 0) return null;
              return (
                <div key={team} className="mb-3 last:mb-0">
                  <div className="flex items-center gap-2 mb-1.5 px-1">
                    <span className="w-3 h-3 rounded-full" style={{ background: TEAM_COLOR[team] }} />
                    <span className="text-sm uppercase tracking-wider font-bold" style={{ color: TEAM_COLOR[team] }}>
                      {teamNames[team]}
                    </span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded ml-auto"
                      style={{ background: TEAM_COLOR[team], color: "#000" }}>
                      {team === 2 ? "T" : "CT"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {teamPlayers.map((p) => {
                      const hpFrac = Math.max(0, Math.min(1, p.hp / 100));
                      const hpColor = hpFrac > 0.5 ? "#4ade80" : hpFrac > 0.25 ? "#fbbf24" : "#f87171";
                      const wpnIcon = weaponIconPath(p.weapon);
                      return (
                        <div key={p.steamid}
                          className="rounded-md overflow-hidden border border-transparent"
                          style={{
                            opacity: p.alive ? 1 : 0.3,
                            background: TEAM_BG[p.team] ?? "transparent",
                            borderColor: p.alive ? `${TEAM_COLOR[p.team]}22` : "transparent",
                          }}
                        >
                          {/* Top row: HP number + Name + Armor + Bomb */}
                          <div className="flex items-center gap-2 px-2.5 py-1">
                            {/* HP number */}
                            <span className="text-sm font-bold font-mono w-7 text-right shrink-0" style={{ color: p.alive ? hpColor : "#666" }}>
                              {p.alive ? p.hp : "☠"}
                            </span>
                            {/* HP bar (thin, behind name area) */}
                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                              <span className="text-sm text-white truncate font-semibold">{p.name}</span>
                              {p.alive && (
                                <div className="w-full h-[3px] rounded-full bg-black/40 overflow-hidden">
                                  <div className="h-full rounded-full" style={{
                                    width: `${hpFrac * 100}%`,
                                    background: hpColor,
                                    transition: "width 0.15s ease",
                                  }} />
                                </div>
                              )}
                            </div>
                            {/* Armor indicator */}
                            {p.alive && p.armor > 0 && (
                              <div className="flex items-center gap-1 shrink-0 rounded px-1 py-0.5" style={{ background: "rgba(255,255,255,0.06)" }}>
                                <img
                                  src={p.helmet ? "/icons/helmet.svg" : "/icons/kevlar.svg"}
                                  alt={p.helmet ? "Helmet+Kevlar" : "Kevlar"}
                                  className="w-5 h-5"
                                  style={{ filter: "brightness(0) invert(0.85)" }}
                                />
                                <span className="text-xs text-gray-300 font-mono">{p.armor}</span>
                              </div>
                            )}
                            {/* Bomb carrier */}
                            {p.hasBomb && p.alive && (
                              <img src="/icons/c4.svg" alt="C4" className="w-5 h-5 shrink-0"
                                style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }}
                              />
                            )}
                          </div>
                          {/* Bottom row: Active weapon (icon + name) */}
                          {p.alive && p.weapon && p.weapon !== "nan" && p.weapon !== "" && (
                            <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-0"
                              style={{ marginLeft: "calc(1.75rem + 0.5rem)" /* align under name */ }}
                            >
                              {wpnIcon && !p.weapon.toLowerCase().includes("c4") && (
                                <img
                                  src={wpnIcon}
                                  alt={p.weapon}
                                  className="h-5 max-w-[80px] object-contain shrink-0"
                                  style={{ filter: "brightness(0) invert(0.9)" }}
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                />
                              )}
                              <span className="text-xs text-gray-400 font-mono truncate">{p.weapon}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* AI Recap */}
          <div className="hud-panel p-2 flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <p className="text-xs text-cs2-muted uppercase tracking-[0.15em]">AI Recap</p>
              <button onClick={handleGenerateInsights} disabled={insightsLoading}
                className="hud-btn-primary text-xs"
              >
                {insightsLoading ? "Asking Claude…" : insights ? "Regenerate" : "Generate"}
              </button>
            </div>
            {insightsError && (
              <p className="text-xs text-cs2-red border-l-2 border-cs2-red/50 pl-2">
                {insightsError}
              </p>
            )}
            {insights && (
              <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap overflow-y-auto flex-1 min-h-0">
                {insights}
              </div>
            )}
            {!insights && !insightsError && !insightsLoading && (
              <p className="text-xs text-cs2-muted">
                AI narrative recap of this match. First call takes ~5s.
              </p>
            )}
          </div>
        </div>{/* /sidebar */}
      </div>{/* /main flex area */}

      {/* ═══ Bottom section: Nade Analysis ═══ */}
      <div className="shrink-0 px-2 pb-2" style={{ maxHeight: "30vh", overflowY: "auto" }}>
        <div className="hud-panel p-2 flex flex-col gap-2">
          <button
            onClick={() => setShowNadePanel((v) => !v)}
            className="flex items-center justify-between w-full"
          >
            <p className="text-xs text-cs2-muted uppercase tracking-[0.15em]">
              Nade Analysis
            </p>
            <span className="text-xs text-cs2-accent">
              {showNadePanel ? "▲ Hide" : "▼ Show"}
            </span>
          </button>
            {showNadePanel && (
              <>
              {/* Tab switcher */}
              <div className="flex items-center gap-2 mb-1">
                <button
                  onClick={() => setNadeAnalysisTab("rounds")}
                  className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded font-mono transition-all ${
                    nadeAnalysisTab === "rounds" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
                  }`}
                >Rounds</button>
                <button
                  onClick={() => setNadeAnalysisTab("patterns")}
                  className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded font-mono transition-all ${
                    nadeAnalysisTab === "patterns" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
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

              {/* Patterns tab */}
              {nadeAnalysisTab === "patterns" && (
                <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto">
                  {nadeLandingClusters.length === 0 ? (
                    <p className="text-xs text-cs2-muted">No repeated nade positions found across rounds.</p>
                  ) : nadeLandingClusters
                    .filter((c) => nadeTypeFilter.has(c.type))
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
                        <div className="flex items-center gap-1 text-[11px] text-cs2-muted mb-1">
                          <span>Rounds:</span>
                          {uniqueRounds.map((rn) => (
                            <button
                              key={rn}
                              onClick={() => {
                                const occ = cluster.occurrences.find((o) => o.roundNum === rn);
                                if (occ) {
                                  setCurrentTick(occ.throwTick);
                                  setHighlightedNadeIdx(occ.globalIdx);
                                }
                              }}
                              className="font-mono px-1 rounded hover:bg-cs2-accent/20 hover:text-cs2-accent transition"
                            >
                              R{rn}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-cs2-muted">
                          <span>By:</span>
                          <span className="text-gray-400">{uniquePlayers.join(", ")}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Rounds tab */}
              {nadeAnalysisTab === "rounds" && (
              <div className="flex flex-col gap-1.5 max-h-[500px] overflow-y-auto">
                {roundNades.map(({ round: r, nades, byPlayer }) => {
                  const isCurrent = r.num === score.round;
                  return (
                    <div
                      key={r.num}
                      className={`text-left px-2 py-1.5 rounded text-xs transition ${
                        isCurrent
                          ? "bg-cs2-accent/15 border border-cs2-accent/40"
                          : "hover:bg-cs2-border/20"
                      }`}
                    >
                      {/* Round header — click to jump */}
                      <button
                        onClick={() => setCurrentTick(r.start_tick)}
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
                            {nades.length} nade{nades.length !== 1 ? "s" : ""}
                          </span>
                        </span>
                      </button>

                      {/* Nade timing bar — click to expand */}
                      {nades.length > 0 && (() => {
                        const isExpanded = expandedTimeline === r.num;
                        const roundLen = r.end_tick - r.start_tick;
                        if (roundLen <= 0) return null;
                        return (
                          <>
                            {/* Compact bar + expand toggle */}
                            <div className="flex items-center gap-1 mb-1">
                              <div
                                className={`relative flex-1 rounded-full bg-cs2-border/30 overflow-hidden transition-all ${isExpanded ? "h-3" : "h-2"}`}
                              >
                                {nades.map((n) => {
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
                                        setCurrentTick(n.throwTick);
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
                            {/* Expanded timeline detail */}
                            {isExpanded && (
                              <div className="bg-cs2-border/10 rounded p-2 mb-1.5 flex flex-col gap-1">
                                <div className="flex items-center justify-between text-[10px] text-cs2-muted font-mono mb-0.5">
                                  <span>0s</span>
                                  <span>Round timeline</span>
                                  <span>{(roundLen / 64).toFixed(0)}s</span>
                                </div>
                                {/* Per-nade row in the expanded view */}
                                {nades
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
                                          setCurrentTick(n.throwTick);
                                        }}
                                        className={`flex items-center gap-1.5 py-0.5 px-1 rounded text-[11px] transition-all ${
                                          isHighlighted ? "bg-cs2-accent/15" : "hover:bg-cs2-border/20"
                                        }`}
                                      >
                                        {/* Position indicator */}
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

                      {/* Per-team, per-player nade breakdown */}
                      {[2, 3].map((team) => {
                        const players = byPlayer[team];
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
                                      // Find matching nade(s) in this round for click-to-isolate
                                      const matchingNades = nades.filter(
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
                                              setCurrentTick(matchingNades[0].throwTick);
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
              </>
            )}
          </div>{/* /hud-panel nade analysis */}
        </div>{/* /bottom section */}

    </div>
  );
}
