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
  getMatchReplayInsights,
  warmPlayerPhotosStatus,
} from "../api/client";
import PlayerAvatar from "./PlayerAvatar";

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
/** Set of known icon base names for raw-name reverse lookup. */
const WEAPON_ICON_NAMES = new Set(Object.values(WEAPON_ICON_MAP));

/** Map demoparser2 weapon display name to icon path, with knife fallback. */
const weaponIconPath = (displayName: string): string => {
  if (!displayName || displayName === "nan") return "";
  const mapped = WEAPON_ICON_MAP[displayName];
  if (mapped) return `/icons/${mapped}.svg`;
  // Raw name fallback (e.g. "ak47" → "/icons/ak47.svg")
  const lower = displayName.toLowerCase();
  if (WEAPON_ICON_NAMES.has(lower)) return `/icons/${lower}.svg`;
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

export interface LiveReplayStatus {
  team1Score: number;
  team2Score: number;
  round: number;
  team1CurrentSide: 2 | 3; // 2 = T, 3 = CT — flips at halftime
  currentTimeStr: string;  // mm:ss into demo
  totalTimeStr: string;
  mapName: string;
  bomb?: { site: string; remaining: number };
}

interface Props {
  demoFile: string;
  timeline: MatchTimeline;
  radar: RadarInfo | null;
  matchInfo: MatchInfoResponse | null;
  onBack: () => void;
  /** Publishes live playback status (score, round, time, bomb) to the
   *  parent so it can render the canonical match header in the navbar. */
  onLiveStatus?: (s: LiveReplayStatus) => void;
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

export default function MatchReplayViewer({ demoFile, timeline, radar, matchInfo, onBack, onLiveStatus }: Props) {
  const [currentTick, setCurrentTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Server-side photo cache generation. Drives the `?v=N` cache-bust
  // on every PlayerAvatar in the scoreboard so reloading the replay
  // viewer after a Reset Photos doesn't keep showing browser-cached
  // stale images.
  const [photoCacheVersion, setPhotoCacheVersion] = useState<number>(0);
  useEffect(() => {
    warmPlayerPhotosStatus()
      .then((s) => setPhotoCacheVersion(s.generation || 0))
      .catch(() => {});
  }, []);
  const [speed, setSpeed] = useState(1);
  const [insights, setInsights] = useState<string | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [mapScale, setMapScale] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Mouse-resizable right sidebar.
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const sidebarResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = sidebarResizeRef.current;
      if (!r) return;
      const next = r.startW - (e.clientX - r.startX);
      setSidebarWidth(Math.max(220, Math.min(640, next)));
    };
    const onUp = () => { sidebarResizeRef.current = null; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const startSidebarResize = (e: React.MouseEvent) => {
    sidebarResizeRef.current = { startX: e.clientX, startW: sidebarWidth };
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  };

  // ── Timestamped notes (localStorage) ──
  interface NoteEntry {
    id: string;
    tick: number;
    round: number;
    text: string;
    createdAt: number;
  }
  const notesKey = `cs2-notes-${demoFile}`;
  const [notes, setNotes] = useState<NoteEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(notesKey) ?? "[]");
    } catch { return []; }
  });
  const [showNotes, setShowNotes] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const saveNotes = (next: NoteEntry[]) => {
    setNotes(next);
    localStorage.setItem(notesKey, JSON.stringify(next));
  };
  const addNote = () => {
    if (!noteInput.trim()) return;
    const round = timeline.rounds.find(
      (r) => currentTick >= r.start_tick && currentTick <= r.end_tick,
    )?.num ?? 0;
    const entry: NoteEntry = {
      id: crypto.randomUUID(),
      tick: Math.round(currentTick),
      round,
      text: noteInput.trim(),
      createdAt: Date.now(),
    };
    saveNotes([...notes, entry].sort((a, b) => a.tick - b.tick));
    setNoteInput("");
  };
  const deleteNote = (id: string) => {
    saveNotes(notes.filter((n) => n.id !== id));
  };

  // Nade analysis filter / highlight state
  const ALL_NADE_TYPES = ["smokegrenade", "flashbang", "hegrenade", "molotov"] as const;
  const [nadeTypeFilter, setNadeTypeFilter] = useState<Set<string>>(
    () => new Set(ALL_NADE_TYPES),
  );
  // Heatmap + Util-Pattern overlays moved to the Insights tab — see
  // InsightsPanel's `radarMode` selector. The live replay viewer keeps only
  // the per-tick live overlay for the currently-playing tick.

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
        inventory: b.inv ?? [],
        // Per-tick behaviour / flash state (optional — missing on old caches)
        flashDuration: b.fd ?? 0,
        scoped: b.sc ?? false,
        walking: b.wlk ?? false,
        crouched: b.cr ?? false,
        defusing: b.dfu ?? false,
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
  // Lowercased-name → HLTV player id, sourced from the roster sidecar via
  // matchInfo. Drives the bodyshot images in the scoreboard. Empty when the
  // roster predates HLTV-id capture; PlayerAvatar just falls back to
  // initials in that case.
  const hltvIdByName = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const team of [matchInfo?.team1, matchInfo?.team2]) {
      for (const entry of team?.players_detailed ?? []) {
        if (!entry?.name || typeof entry.hltv_id !== "number") continue;
        out[entry.name.trim().toLowerCase()] = entry.hltv_id;
      }
    }
    return out;
  }, [matchInfo]);

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

  // Publish live status to parent (ReplayLayout) so the navbar can show
  // the canonical match header. Throttled to once per second of playback
  // time — emitting on every frame caused the parent to re-render at 60Hz,
  // making navbar clicks during playback feel unresponsive.
  const currentSecond = Math.floor(currentTick / 64);
  const bombSecond = bombState ? Math.floor(bombState.remaining) : -1;
  useEffect(() => {
    if (!onLiveStatus || !timeline || !matchInfo?.team1 || !matchInfo?.team2) return;
    // org1 = first-half-T = matchInfo.team1 if team1IsT else team2.
    const tPlayers = new Set(
      timeline.players.filter((p) => p.team_num === 2).map((p) => p.name.toLowerCase()),
    );
    const team1Players = (matchInfo.team1.players ?? []).map((n) => n.toLowerCase());
    const team1IsT = team1Players.some((n) => tPlayers.has(n));
    const team1Score = team1IsT ? score.org1 : score.org2;
    const team2Score = team1IsT ? score.org2 : score.org1;
    const team1CurrentSide: 2 | 3 = (team1IsT
      ? org1CurrentSide
      : (org1CurrentSide === 2 ? 3 : 2)) as 2 | 3;
    const fmt = (sec: number) =>
      `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    onLiveStatus({
      team1Score,
      team2Score,
      round: score.round,
      team1CurrentSide,
      currentTimeStr: fmt(currentSecond),
      totalTimeStr: fmt(Math.floor(timeline.tick_max / 64)),
      mapName: timeline.map_name,
      bomb: bombState ? { site: bombState.site, remaining: bombState.remaining } : undefined,
    });
  }, [
    onLiveStatus, timeline, matchInfo,
    score.org1, score.org2, score.round,
    org1CurrentSide, currentSecond, bombSecond,
    bombState?.site,
  ]);

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
        // Jump-to-round seeks to freeze_end (when freeze actually ends and
        // action begins) so timeouts don't dump you in the middle of an
        // empty buy phase. Falls back to start_tick on pre-v3 caches.
        startTick: r.freeze_end_tick ?? r.start_tick,
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Match header (team names, event, score, time, bomb) lives in the
          ReplayLayout navbar — see onLiveStatus prop above. */}

      {/* ═══ Horizontal round timeline ═══ */}
      <div className="shrink-0 p-2">
        <div className="hud-panel p-3">
          {(() => {
            // Half scores tracked by stable team identity so the halftime
            // side swap doesn't double-count either team.
            //   First half: T side = team-A, CT side = team-B
            //   Second half: sides swap, so a "T" win goes to team-B
            // teamA = first-half-T team; teamB = first-half-CT team.
            let fhT = 0, fhCT = 0, shT = 0, shCT = 0;
            for (const ro of roundOutcomes) {
              if (ro.num <= 12) {
                if (ro.winner === "T") fhT++; else if (ro.winner === "CT") fhCT++;
              } else {
                if (ro.winner === "T") shT++; else if (ro.winner === "CT") shCT++;
              }
            }
            const teamAFinal = fhT + shCT;   // first-half-T team total
            const teamBFinal = fhCT + shT;   // first-half-CT team total
            const hasSecondHalf = roundOutcomes.some((r) => r.num >= 13);
            return (
              <div className="flex items-center gap-3 text-sm text-cs2-muted uppercase tracking-[0.1em] font-semibold mb-2">
                <span>First Half</span>
                <span className="text-white font-mono text-base">{fhT} : {fhCT}</span>
                {hasSecondHalf && (
                  <>
                    <span className="flex-1" />
                    <span>Final</span>
                    <span className="text-white font-mono text-base">{teamAFinal} : {teamBFinal}</span>
                  </>
                )}
              </div>
            );
          })()}
          <div className="flex items-stretch gap-0.5 w-full">
          {roundOutcomes.map((ro) => {
            const isCurrent = ro.num === score.round;
            const winColor = ro.winner === "T" ? TEAM_COLOR[2] : ro.winner === "CT" ? TEAM_COLOR[3] : "#555";
            const elimination = !ro.bombDefused && !ro.bombExploded && ro.winner;
            // Only the currently-watched round gets live feedback from playerStates.
            // All other rounds (past AND future) show their precomputed end-of-round outcome.
            const tBars = isCurrent
              ? playerStates.filter((p) => p.team === 2 && p.alive).length
              : ro.tAlive;
            const ctBars = isCurrent
              ? playerStates.filter((p) => p.team === 3 && p.alive).length
              : ro.ctAlive;
            return (
              <div key={ro.num} className="flex items-center gap-0.5 flex-1 min-w-0">
                {ro.num === 13 && (
                  <div className="w-[2px] bg-cs2-accent/40 self-stretch mx-1 rounded shrink-0" />
                )}
                <button
                  onClick={() => setCurrentTick(ro.startTick)}
                  className={`flex flex-col items-center justify-center py-2.5 px-1 rounded-lg transition-all flex-1 min-w-0 border ${
                    isCurrent
                      ? "bg-cs2-accent/15 border-cs2-accent/50 shadow-[0_0_14px_rgba(34,211,238,0.18)]"
                      : "border-transparent hover:bg-white/[0.04] hover:border-white/10"
                  }`}
                >
                  {/* Round number */}
                  <span className={`text-base font-mono font-bold leading-none ${isCurrent ? "text-white" : "text-cs2-muted"}`}>{ro.num}</span>

                  {/* T-side alive bars (top) */}
                  <div className="flex justify-center gap-[3px] mt-2">
                    {Array.from({ length: 5 }, (_, j) => (
                      <div key={`t${j}`} className="rounded-sm"
                        style={{
                          width: 7, height: 18,
                          background: j < tBars ? TEAM_COLOR[2] : "#444",
                        }} />
                    ))}
                  </div>

                  {/* Winner color bar (center divider) */}
                  <div className="w-[85%] h-[4px] rounded-full my-[5px]" style={{ background: isCurrent ? "#555" : winColor }} />

                  {/* CT-side alive bars (bottom) */}
                  <div className="flex justify-center gap-[3px]">
                    {Array.from({ length: 5 }, (_, j) => (
                      <div key={`ct${j}`} className="rounded-sm"
                        style={{
                          width: 7, height: 18,
                          background: j < ctBars ? TEAM_COLOR[3] : "#444",
                        }} />
                    ))}
                  </div>

                  {/* Round outcome icon */}
                  <div className="h-[22px] flex items-center justify-center mt-1">
                    {ro.bombDefused && (
                      <img src="/icons/defuser.svg" alt="defused" className="w-5 h-5"
                        style={{ filter: "brightness(0) invert(0.6) sepia(1) hue-rotate(180deg) saturate(3)" }} />
                    )}
                    {ro.bombExploded && (
                      <img src="/icons/c4.svg" alt="exploded" className="w-5 h-5"
                        style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }} />
                    )}
                    {elimination && !ro.bombPlanted && (
                      <img src="/icons/killfeed/icon_suicide.svg" alt="eliminated" className="w-5 h-5"
                        style={{ filter: `brightness(0) saturate(100%) ${
                          ro.winner === "T"
                            ? "invert(85%) sepia(30%) saturate(800%) hue-rotate(5deg)"
                            : "invert(60%) sepia(50%) saturate(500%) hue-rotate(190deg)"
                        }` }} />
                    )}
                  </div>
                </button>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* ═══ Main area: map | sidebar ═══ */}
      <div className="flex-1 min-h-0 flex px-2 overflow-hidden">
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
          </div>
          <div
            className="relative flex-1 min-h-0 w-full flex items-center justify-center"
            style={{ overflow: "hidden", cursor: isDragging ? "grabbing" : mapScale > 1 ? "grab" : "default" }}
            onMouseDown={(e) => {
              if (mapScale <= 1 || e.button !== 0) return;
              setIsDragging(true);
              dragStart.current = { x: e.clientX, y: e.clientY, panX: mapPan.x, panY: mapPan.y };
            }}
            onMouseMove={(e) => {
              if (!isDragging) return;
              setMapPan({
                x: dragStart.current.panX + (e.clientX - dragStart.current.x),
                y: dragStart.current.panY + (e.clientY - dragStart.current.y),
              });
            }}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            onWheel={(e) => {
              e.preventDefault();
              const delta = e.deltaY < 0 ? 0.1 : -0.1;
              setMapScale((s) => {
                const next = Math.max(0.5, Math.min(3, +(s + delta).toFixed(1)));
                if (next <= 1) setMapPan({ x: 0, y: 0 });
                return next;
              });
            }}
          >
            {/* Zoom controls — floating overlay matching the Insights radar. */}
            <div className="absolute top-2 right-2 z-40 flex items-center gap-1 hud-panel px-1.5 py-0.5">
              <button onClick={(e) => { e.stopPropagation(); setMapScale((s) => { const n = Math.max(0.5, +(s - 0.1).toFixed(1)); if (n <= 1) setMapPan({ x: 0, y: 0 }); return n; }); }}
                className="text-[11px] text-cs2-muted hover:text-white px-1">−</button>
              <span className="text-[10px] font-mono text-white w-9 text-center">{Math.round(mapScale * 100)}%</span>
              <button onClick={(e) => { e.stopPropagation(); setMapScale((s) => Math.min(3, +(s + 0.1).toFixed(1))); }}
                className="text-[11px] text-cs2-muted hover:text-white px-1">+</button>
              {(mapScale !== 1 || mapPan.x !== 0 || mapPan.y !== 0) && (
                <button onClick={(e) => { e.stopPropagation(); setMapScale(1); setMapPan({ x: 0, y: 0 }); }}
                  className="text-[10px] text-cs2-accent hover:text-white px-1">⟳</button>
              )}
            </div>
          <div style={{
            aspectRatio: "1 / 1",
            width: "100%",
            maxWidth: "100%",
            maxHeight: "100%",
            flexShrink: 0,
            transform: `scale(${mapScale}) translate(${mapPan.x / mapScale}px, ${mapPan.y / mapScale}px)`,
            transformOrigin: "center center",
          }}>
            <svg
              viewBox={`0 0 ${RADAR_PX} ${RADAR_PX}`}
              className="w-full h-full"
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

                {/* Muzzle flash — bright yellow-white radial, fades fast */}
                <radialGradient id="muzzle-flash">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
                  <stop offset="40%" stopColor="#fde047" stopOpacity="0.9" />
                  <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
                </radialGradient>

                {/* Tracer line gradient — bright at muzzle, transparent at impact */}
                <linearGradient id="tracer-yellow" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#fef9c3" stopOpacity="1" />
                  <stop offset="15%" stopColor="#fde047" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#fde047" stopOpacity="0" />
                </linearGradient>

                {/* Death spark — bright white-orange flash */}
                <radialGradient id="death-spark">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
                  <stop offset="50%" stopColor="#fbbf24" stopOpacity="0.8" />
                  <stop offset="100%" stopColor="#f87171" stopOpacity="0" />
                </radialGradient>

                {/* Rising heat shimmer — subtle orange translucent */}
                <radialGradient id="heat-shimmer">
                  <stop offset="0%" stopColor="#fdba74" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
                </radialGradient>
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


              {/* ── Utility zones ── */}
              {radar && activeUtilityZones.map((uz, i) => {
                const [cx, cy] = project(uz.x, uz.y);
                const r = utilityRadius(uz.type);
                const uzDimmed = false;

                if (uz.type === "smokegrenade") {
                  // Multi-layered smoke cloud with drifting puffs + wind drift +
                  // independent per-puff phases so it reads as a volumetric
                  // settling cloud rather than a sync'd pulse.
                  const fadeIn = Math.min(1, uz.progress * 20);
                  const fadeOut = uz.progress > 0.9 ? (1 - uz.progress) * 10 : 1;
                  const opacity = fadeIn * fadeOut;
                  // Slower breathing over ~3s cycle
                  const breathe = 1 + 0.04 * Math.sin(uz.progress * Math.PI * 5);
                  // Consistent wind drift — direction per smoke (seeded)
                  const windAngle = pseudoRand(uz.seed + 99) * Math.PI * 2;
                  const windMag = r * 0.18 * uz.progress;   // grows over lifetime
                  const driftX = Math.cos(windAngle) * windMag;
                  const driftY = Math.sin(windAngle) * windMag;
                  // 10 puffs with staggered phase — more volumetric than 6
                  const puffs = Array.from({ length: 10 }, (_, j) => {
                    const angle = (j / 10) * Math.PI * 2 + pseudoRand(uz.seed + j) * 0.6;
                    const dist = r * (0.35 + 0.25 * pseudoRand(uz.seed + j + 10));
                    const puffR = r * (0.45 + 0.35 * pseudoRand(uz.seed + j + 20));
                    // Each puff has its own phase offset so drift doesn't pulse in sync
                    const phase = pseudoRand(uz.seed + j + 50) * Math.PI * 2;
                    const indiv = 1 + 0.05 * Math.sin(uz.progress * Math.PI * 4 + phase);
                    // Per-puff fade envelope (scale in/out over its lifetime)
                    const puffProgress = Math.min(1, Math.max(0, (uz.progress - pseudoRand(uz.seed + j + 70) * 0.1) * 1.2));
                    const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, puffProgress)));
                    return {
                      cx: cx + driftX + Math.cos(angle) * dist * indiv,
                      cy: cy + driftY + Math.sin(angle) * dist * indiv,
                      r: puffR * breathe * (0.7 + 0.3 * envelope),
                    };
                  });
                  // Embers at base — 4 tiny grey dots, random twinkle
                  const embers = Array.from({ length: 4 }, (_, j) => {
                    const angle = pseudoRand(uz.seed + j + 200) * Math.PI * 2;
                    const dist = r * 0.25 * pseudoRand(uz.seed + j + 210);
                    const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(uz.progress * Math.PI * 10 + j * 1.3));
                    return {
                      cx: cx + Math.cos(angle) * dist,
                      cy: cy + Math.sin(angle) * dist + r * 0.15,
                      r: 1.2,
                      a: twinkle * 0.55,
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
                      <g style={{ mixBlendMode: "screen" }}>
                        {puffs.map((puff, j) => (
                          <circle key={j} cx={puff.cx} cy={puff.cy} r={puff.r}
                            fill="url(#smoke-inner)"
                          />
                        ))}
                      </g>
                      {/* Stacked core layers for volumetric look */}
                      <circle cx={cx + driftX * 0.4} cy={cy + driftY * 0.4}
                        r={r * 0.55 * breathe}
                        fill="url(#smoke-core)" opacity={0.85}
                      />
                      <circle cx={cx + driftX * 0.2} cy={cy + driftY * 0.2}
                        r={r * 0.38 * breathe}
                        fill="url(#smoke-core)" opacity={0.55}
                      />
                      {/* Settled ash embers */}
                      {embers.map((em, j) => (
                        <circle key={`em${j}`} cx={em.cx} cy={em.cy} r={em.r}
                          fill="#64748b" opacity={em.a}
                        />
                      ))}
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
                  // Animated fire patch with upward-biased flickering flames,
                  // rising sparks, and a subtle heat-shimmer ring above.
                  const fadeIn = Math.min(1, uz.progress * 15);
                  const fadeOut = uz.progress > 0.85 ? (1 - uz.progress) * 6.67 : 1;
                  const opacity = fadeIn * fadeOut;
                  // 10 flame tongues, upward-biased, independent phase per flame
                  const flames = Array.from({ length: 10 }, (_, j) => {
                    const angle = (j / 10) * Math.PI * 2;
                    const phase = pseudoRand(uz.seed + j + 40) * Math.PI * 2;
                    const flicker = 0.65 + 0.35 * Math.sin(uz.progress * Math.PI * 22 + phase);
                    const dist = r * 0.55 * flicker;
                    const flameR = r * (0.28 + 0.18 * pseudoRand(uz.seed + j + 30)) * flicker;
                    // Upward bias: translate each flame toward -y proportional to radius
                    const upBias = r * 0.22 * flicker;
                    return {
                      cx: cx + Math.cos(angle) * dist,
                      cy: cy + Math.sin(angle) * dist - upBias,
                      r: flameR,
                    };
                  });
                  // Rising sparks — tiny orange-yellow particles translating upward
                  const sparkCount = 5;
                  const sparks = Array.from({ length: sparkCount }, (_, j) => {
                    const phase = (uz.progress * 3 + j / sparkCount) % 1;   // 0..1
                    const ang = pseudoRand(uz.seed + j + 300) * Math.PI * 2;
                    const baseR = r * 0.35 * pseudoRand(uz.seed + j + 310);
                    const riseY = r * 1.1 * phase;
                    const alpha = Math.max(0, 1 - phase);
                    return {
                      cx: cx + Math.cos(ang) * baseR,
                      cy: cy + Math.sin(ang) * baseR * 0.6 - riseY,
                      r: 1.6 * (1 - phase * 0.5),
                      a: alpha,
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
                      <circle cx={cx} cy={cy - r * 0.1} r={r * 0.35}
                        fill="url(#fire-core)"
                      />
                      {/* Heat shimmer ring above the fire */}
                      <circle cx={cx} cy={cy - r * 0.55} rx={r * 0.55} ry={r * 0.25}
                        fill="url(#heat-shimmer)"
                        transform={`translate(0 ${(Math.sin(uz.progress * Math.PI * 10) * r * 0.03).toFixed(2)})`}
                      />
                      {/* Rising sparks */}
                      {sparks.map((sp, j) => (
                        <circle key={`sp${j}`} cx={sp.cx} cy={sp.cy} r={sp.r}
                          fill="#fde047" opacity={sp.a}
                        />
                      ))}
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
                const dimmed = false;
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

              {/* ── Player models: directional arrow + weapon silhouette ── */}
              {radar && playerStates.map((p) => {
                const [px, py] = project(p.x, p.y);
                const color = TEAM_COLOR[p.team] ?? "#94a3b8";
                const yawRad = (p.yaw * Math.PI) / 180;
                // Size cues: crouched is smaller, walking slightly smaller
                const sizeMul = p.crouched ? 0.78 : (p.walking ? 0.92 : 1);
                const radius = 11 * sizeMul;
                // Recoil kick — if firing in the last 4 ticks, push body back along -yaw
                const fireWindow = 12;
                const fireEvent = recentFires.find((f) => f.shooter === p.steamid);
                const kick = fireEvent ? (fireEvent.alpha * 3) : 0;   // up to 3 px
                const bodyCx = px - Math.cos(yawRad) * kick;
                const bodyCy = py + Math.sin(yawRad) * kick;
                // Weapon silhouette placement
                const wpnIconName = p.weapon && p.weapon !== "nan" && p.weapon !== "" && !p.weapon.toLowerCase().includes("c4")
                  ? weaponIconPath(p.weapon) : "";
                const barrelLen = p.scoped ? 30 : 22;
                const barrelTipX = bodyCx + Math.cos(yawRad) * barrelLen;
                const barrelTipY = bodyCy - Math.sin(yawRad) * barrelLen;
                const hpFrac = Math.max(0, Math.min(1, p.hp / 100));
                const hpColor = hpFrac > 0.5 ? "#4ade80" : hpFrac > 0.25 ? "#fbbf24" : "#f87171";
                // Arrow polygon: tip forward, base flared. Points defined in local space
                // then rotated to yaw. yawRad=0 means facing +x (east, standard SVG: right).
                const yawDeg = -p.yaw;   // SVG y-axis flips; rotate clockwise accordingly
                // Flashed ring scale
                const flashAlpha = p.flashDuration && p.flashDuration > 0
                  ? Math.min(1, p.flashDuration / 2)
                  : 0;
                return (
                  <g key={p.steamid} opacity={p.alive ? 1 : 0.25}
                    style={{ transition: "opacity 0.3s ease" }}
                  >
                    {/* Walking footprint pulse (subtle) */}
                    {p.alive && p.walking && (
                      <circle cx={bodyCx} cy={bodyCy} r={radius * 1.5}
                        fill="none" stroke={color} strokeWidth={1} strokeOpacity={0.25}
                      />
                    )}

                    {/* Defusing progress ring */}
                    {p.alive && p.defusing && (
                      <circle cx={bodyCx} cy={bodyCy} r={radius * 1.8}
                        fill="none" stroke="#22d3ee" strokeWidth={2} strokeOpacity={0.9}
                        strokeDasharray="4 2"
                      >
                        <animateTransform attributeName="transform" type="rotate"
                          from={`0 ${bodyCx} ${bodyCy}`} to={`360 ${bodyCx} ${bodyCy}`}
                          dur="1s" repeatCount="indefinite" />
                      </circle>
                    )}

                    {/* Weapon silhouette along yaw */}
                    {p.alive && wpnIconName && (
                      <g transform={`rotate(${yawDeg} ${bodyCx} ${bodyCy})`}>
                        <image href={wpnIconName}
                          x={bodyCx + radius * 0.4} y={bodyCy - 6}
                          width={p.scoped ? 24 : 18} height={12}
                          preserveAspectRatio="xMidYMid meet"
                          style={{ filter: `brightness(0) invert(0.9) drop-shadow(0 0 1px ${color})` }}
                        />
                      </g>
                    )}

                    {/* Scope sight line */}
                    {p.alive && p.scoped && (
                      <line x1={barrelTipX} y1={barrelTipY}
                        x2={barrelTipX + Math.cos(yawRad) * 18}
                        y2={barrelTipY - Math.sin(yawRad) * 18}
                        stroke={color} strokeWidth={0.8} strokeOpacity={0.4}
                        strokeDasharray="2 3"
                      />
                    )}

                    {/* Directional arrow body (teardrop/triangle) */}
                    <g transform={`rotate(${yawDeg} ${bodyCx} ${bodyCy})`}>
                      <path
                        d={`
                          M ${bodyCx + radius * 1.15} ${bodyCy}
                          L ${bodyCx - radius * 0.7} ${bodyCy - radius * 0.85}
                          Q ${bodyCx - radius * 1.0} ${bodyCy} ${bodyCx - radius * 0.7} ${bodyCy + radius * 0.85}
                          Z
                        `}
                        fill={color}
                        stroke="#000"
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                      />
                      {/* Inner highlight for depth */}
                      <path
                        d={`
                          M ${bodyCx + radius * 0.75} ${bodyCy}
                          L ${bodyCx - radius * 0.3} ${bodyCy - radius * 0.45}
                          L ${bodyCx - radius * 0.3} ${bodyCy + radius * 0.45}
                          Z
                        `}
                        fill="#fff"
                        fillOpacity={0.22}
                      />
                    </g>

                    {/* Muzzle flash */}
                    {p.alive && fireEvent && fireEvent.alpha > 0 && (
                      <circle cx={barrelTipX} cy={barrelTipY}
                        r={6 * (0.4 + fireEvent.alpha * 0.8)}
                        fill="url(#muzzle-flash)"
                        opacity={fireEvent.alpha}
                      />
                    )}

                    {/* Flashed white ring overlay */}
                    {p.alive && flashAlpha > 0 && (
                      <circle cx={bodyCx} cy={bodyCy} r={radius * 1.3}
                        fill="none" stroke="#ffffff" strokeWidth={2}
                        strokeOpacity={flashAlpha * 0.8}
                      />
                    )}

                    {/* Player name + HP */}
                    <text x={px} y={py - 18} fill="#fff" fontSize={13}
                      fontFamily="monospace" stroke="#000" strokeWidth={3} paintOrder="stroke"
                      textAnchor="middle"
                    >
                      {p.name}{p.alive ? ` ${p.hp}` : ""}
                    </text>

                    {/* Health bar */}
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
                    {/* Equipment row */}
                    {p.alive && (
                      <g>
                        {wpnIconName && (
                          <image href={wpnIconName}
                            x={px - 18} y={py + 19} width={28} height={14}
                            preserveAspectRatio="xMidYMid meet"
                            style={{ filter: "brightness(0) invert(0.9)" }}
                          />
                        )}
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
                      className="flex items-center gap-2 px-3 py-1 rounded-lg text-sm font-mono border border-white/10"
                      style={{
                        background: "rgba(15, 20, 32, 0.75)",
                        backdropFilter: "blur(10px) saturate(140%)",
                        WebkitBackdropFilter: "blur(10px) saturate(140%)",
                      }}
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
          </div>{/* /outer scroll wrapper */}

          {/* Controls */}
          {(() => {
            const progress = timeline.tick_max > 0 ? (Math.round(currentTick) / timeline.tick_max) * 100 : 0;
            const fmtTime = (ticks: number) => {
              const secs = Math.floor(ticks / 64);
              return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
            };
            return (
              <div className="flex flex-col gap-1.5 px-2 pt-1.5 pb-1 shrink-0">
                {/* Scrubber with round markers */}
                <div className="relative">
                  <input
                    type="range" min={0} max={timeline.tick_max} step={1}
                    value={Math.round(currentTick)}
                    onChange={(e) => setCurrentTick(Number(e.target.value))}
                    className="w-full hud-scrubber"
                    style={{
                      background: `linear-gradient(to right, #22d3ee ${progress}%, rgba(255,255,255,0.08) ${progress}%)`,
                      borderRadius: 9999,
                    }}
                  />
                  {/* Round start tick marks */}
                  <div className="absolute inset-0 pointer-events-none flex items-center" style={{ padding: "0 7px" }}>
                    {timeline.rounds.map((r) => (
                      <div key={r.num}
                        className="absolute w-[3px] h-[3px] rounded-full"
                        style={{
                          left: `${timeline.tick_max > 0 ? (r.start_tick / timeline.tick_max) * 100 : 0}%`,
                          background: "rgba(255,255,255,0.3)",
                        }}
                      />
                    ))}
                    {/* Note markers (diamonds) */}
                    {notes.map((n) => (
                      <div key={n.id}
                        className="absolute w-[6px] h-[6px] rotate-45 cursor-pointer"
                        style={{
                          left: `${timeline.tick_max > 0 ? (n.tick / timeline.tick_max) * 100 : 0}%`,
                          background: "#f59e0b",
                          marginTop: "-1px",
                          pointerEvents: "auto",
                        }}
                        title={`R${n.round}: ${n.text}`}
                        onClick={() => setCurrentTick(n.tick)}
                      />
                    ))}
                  </div>
                </div>

                {/* Transport buttons row — wraps on narrow widths so controls
                    stay accessible at any window size. */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => {
                      const prev = [...timeline.rounds].reverse()
                        .find((r) => r.start_tick < currentTick - 1);
                      if (prev) setCurrentTick(prev.start_tick);
                    }}
                    className="hud-btn p-1.5" title="Previous round"
                  >
                    <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
                      <rect x="2" y="2" width="2" height="12" rx="0.5" />
                      <path d="M14 2L6 8l8 6V2z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setPlaying((p) => !p)}
                    className="hud-btn-primary p-2" title={playing ? "Pause" : "Play"}
                  >
                    {playing ? (
                      <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
                        <rect x="3" y="2" width="3.5" height="12" rx="1" />
                        <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
                        <path d="M4 2l10 6-10 6V2z" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      const next = timeline.rounds.find((r) => r.start_tick > currentTick);
                      if (next) setCurrentTick(next.start_tick);
                    }}
                    className="hud-btn p-1.5" title="Next round"
                  >
                    <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
                      <path d="M2 2l8 6-8 6V2z" />
                      <rect x="12" y="2" width="2" height="12" rx="0.5" />
                    </svg>
                  </button>

                  <div className="w-px h-5 bg-white/10 mx-1" />

                  <div className="flex items-center gap-1">
                    {[0.5, 1, 2, 4].map((s) => (
                      <button key={s} onClick={() => setSpeed(s)}
                        className={`hud-tab ${speed === s ? "hud-tab-active" : "hud-tab-idle"} font-mono`}
                      >{s}×</button>
                    ))}
                  </div>

                  <span className="text-xs text-cs2-muted ml-auto font-mono tabular-nums">
                    {fmtTime(currentTick)}
                    <span className="text-cs2-muted/40"> / </span>
                    {fmtTime(timeline.tick_max)}
                  </span>

                  {/* Map zoom controls live as a floating overlay on the radar
                      itself — see the absolute-positioned panel inside the
                      .relative map container. */}

                  <div className="w-px h-5 bg-white/10 mx-1" />

                  <button
                    onClick={() => setShowNotes((s) => !s)}
                    className={`hud-tab ${showNotes ? "hud-tab-active" : "hud-tab-idle"}`}
                    title="Toggle notes panel"
                  >
                    Notes{notes.length > 0 ? ` · ${notes.length}` : ""}
                  </button>
                </div>

                {/* Inline note input */}
                {showNotes && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addNote(); }}
                      placeholder={`Add note at ${fmtTime(currentTick)}…`}
                      className="hud-input flex-1 text-xs py-1 px-2"
                    />
                    <button
                      onClick={addNote}
                      disabled={!noteInput.trim()}
                      className="hud-btn-primary text-[10px] px-2 py-1"
                    >
                      +
                    </button>
                  </div>
                )}

                {/* Notes list */}
                {showNotes && notes.length > 0 && (
                  <div className="max-h-24 overflow-y-auto space-y-0.5" style={{ scrollbarWidth: "thin" }}>
                    {notes.map((n) => (
                      <div
                        key={n.id}
                        className="flex items-center gap-2 text-[10px] px-1 py-0.5 rounded hover:bg-cs2-border/10 group"
                      >
                        <button
                          onClick={() => setCurrentTick(n.tick)}
                          className="text-amber-400 font-mono shrink-0 hover:underline"
                        >
                          R{n.round} {fmtTime(n.tick)}
                        </button>
                        <span className="text-gray-300 truncate flex-1">{n.text}</span>
                        <button
                          onClick={() => deleteNote(n.id)}
                          className="text-cs2-red/50 hover:text-cs2-red opacity-0 group-hover:opacity-100 shrink-0"
                          title="Delete note"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>{/* /hud-panel */}
        </div>{/* /map area wrapper */}

        {/* Splitter — drag to resize the sidebar. */}
        <div
          onMouseDown={startSidebarResize}
          className="w-2 shrink-0 cursor-col-resize hover:bg-cs2-accent/40 transition-colors rounded"
          title="Drag to resize"
        />

        {/* ── Sidebar (right) ── */}
        <div
          className="shrink-0 flex flex-col gap-2 overflow-y-auto"
          style={{ width: sidebarWidth, scrollbarWidth: "thin" }}
        >
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
                          {/* Top row: HP number + Avatar + Name + Armor + Bomb */}
                          <div className="flex items-center gap-2 px-2.5 py-1">
                            {/* HP number */}
                            <span className="text-sm font-bold font-mono w-7 text-right shrink-0" style={{ color: p.alive ? hpColor : "#666" }}>
                              {p.alive ? p.hp : "☠"}
                            </span>
                            {/* HLTV bodyshot (falls back to initials when
                                the player isn't in a scraped roster). */}
                            <PlayerAvatar
                              name={p.name}
                              hltvId={hltvIdByName[p.name.trim().toLowerCase()] ?? null}
                              size={28}
                              accent={TEAM_COLOR[p.team]}
                              cacheBust={photoCacheVersion || undefined}
                            />
                            {/* HP bar (thin, behind name area) */}
                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                              <span className="text-sm text-white truncate font-semibold">{p.name}</span>
                              <div className="w-full h-[3px] rounded-full bg-black/40 overflow-hidden" style={{ visibility: p.alive ? "visible" : "hidden" }}>
                                <div className="h-full rounded-full" style={{
                                  width: `${hpFrac * 100}%`,
                                  background: hpColor,
                                  transition: "width 0.15s ease",
                                }} />
                              </div>
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
                          {/* Bottom row: Full inventory — always rendered with min-height to prevent layout shift */}
                          <div className="flex flex-wrap items-center gap-2 px-2.5 pb-1.5 pt-0"
                            style={{ marginLeft: "calc(1.75rem + 0.5rem)", minHeight: 22, visibility: p.alive ? "visible" : "hidden" }}
                          >
                            {(p.inventory ?? []).filter((invWpn) => invWpn && invWpn !== "nan" && invWpn !== "" && !invWpn.toLowerCase().includes("knife")).map((invWpn, idx) => {
                              const invIcon = weaponIconPath(invWpn);
                              const isActive = p.weapon && invWpn.toLowerCase() === p.weapon.toLowerCase();
                              return invIcon ? (
                                <img
                                  key={idx}
                                  src={invIcon}
                                  alt={invWpn}
                                  className={`h-4 max-w-[60px] object-contain shrink-0 ${isActive ? "opacity-100" : "opacity-50"}`}
                                  style={{ filter: "brightness(0) invert(0.9)" }}
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                  title={invWpn}
                                />
                              ) : (
                                <span key={idx} className={`text-[10px] font-mono truncate ${isActive ? "text-gray-200" : "text-gray-500"}`}>{invWpn}</span>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* AI Recap */}
          <div className="hud-panel p-2 flex flex-col gap-2 shrink-0">
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
              <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap overflow-y-auto" style={{ maxHeight: 200, scrollbarWidth: "thin" }}>
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


    </div>
  );
}
