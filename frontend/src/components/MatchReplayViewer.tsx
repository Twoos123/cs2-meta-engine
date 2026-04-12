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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MatchTimeline,
  RadarInfo,
  TimelinePosition,
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
  2: "#fb923c", // T — orange
  3: "#38bdf8", // CT — blue
};

const TEAM_BG: Record<number, string> = {
  2: "rgba(251, 146, 60, 0.15)",
  3: "rgba(56, 189, 248, 0.15)",
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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setTimeline(null);
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

  // ── Interpolated player states with smooth yaw + hp ──
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
      return {
        steamid: p.steamid,
        name: p.name,
        team: p.team_num,
        x: lerp(a.x, b.x, tSmooth),
        y: lerp(a.y, b.y, tSmooth),
        yaw: lerpAngle(a.yaw, b.yaw, tSmooth),
        alive: b.alive,
        hp: Math.round(lerp(a.hp, b.hp, t)),
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null);
  }, [timeline, currentTick]);

  const sidToTeam = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of timeline?.players ?? []) m[p.steamid] = p.team_num;
    return m;
  }, [timeline]);

  const sidToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of timeline?.players ?? []) m[p.steamid] = p.name;
    return m;
  }, [timeline]);

  // ── Active grenade trails (in-flight) ──
  // Backend trims points to flight-only and sets detonate_tick to the landing
  // moment, so we just use the points array bounds directly.
  const activeGrenades = useMemo(() => {
    if (!timeline) return [];
    const tick = currentTick;
    const out: { type: string; pts: number[][]; thrower: string }[] = [];
    for (const g of timeline.grenades) {
      if (!g.points.length) continue;
      const first = g.points[0][0];
      const last = g.points[g.points.length - 1][0];
      if (tick < first || tick >= last) continue;
      const visible = g.points.filter((p) => p[0] <= tick);
      if (visible.length < 2) continue;
      out.push({ type: g.type, pts: visible, thrower: g.thrower });
    }
    return out;
  }, [timeline, currentTick]);

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
    }[] = [];
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
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
      });
    }
    return out;
  }, [timeline, currentTick]);

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
      alpha: number;
    }[] = [];
    for (const e of timeline.events) {
      if (e.type !== "death") continue;
      const dt = tick - e.tick;
      if (dt < 0 || dt > KILL_WINDOW) continue;
      out.push({
        tick: e.tick,
        victim: e.data.victim,
        attacker: e.data.attacker,
        weapon: e.data.weapon ?? "",
        headshot: e.data.headshot === "True",
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
    const kills: {
      attacker: string;
      victim: string;
      weapon: string;
      headshot: boolean;
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
        headshot: e.data.headshot === "True",
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
    let lastPlant: { tick: number; site: string } | null = null;
    let defused = false;
    for (const e of timeline.events) {
      if (e.tick > tick) break;
      if (e.type === "bomb_plant") {
        lastPlant = { tick: e.tick, site: e.data.site ?? "?" };
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
    return { site: lastPlant.site, elapsed, remaining: BOMB_TIMER - elapsed };
  }, [timeline, currentTick]);

  // Score
  const score = useMemo(() => {
    if (!timeline) return { t: 0, ct: 0, round: 0 };
    let t = 0, ct = 0, round = 1;
    for (const r of timeline.rounds) {
      if (r.start_tick <= currentTick) round = r.num;
      if (r.end_tick > currentTick) break;
      if (r.winner === "T") t += 1;
      else if (r.winner === "CT") ct += 1;
    }
    return { t, ct, round };
  }, [timeline, currentTick]);

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
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-bold text-cs2-accent uppercase tracking-[0.18em]">
            {demoFile}
          </h2>
          <p className="text-[10px] text-cs2-muted mt-0.5 font-mono">
            {timeline.map_name} · tick {Math.round(currentTick)} / {timeline.tick_max}
          </p>
        </div>
        <button onClick={onBack} className="hud-btn text-xs">← Picker</button>
      </div>

      {/* Score ribbon */}
      <div className="hud-panel px-4 py-2 flex items-center justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.15em] text-cs2-muted">
          Round {score.round}
        </span>
        <div className="flex items-center gap-3 font-mono text-[18px]">
          <span style={{ color: TEAM_COLOR[2] }}>{score.t}</span>
          <span className="text-cs2-muted">·</span>
          <span style={{ color: TEAM_COLOR[3] }}>{score.ct}</span>
        </div>
        <div className="flex items-center gap-2">
          {bombState && (
            <span className="text-[11px] font-mono text-cs2-red animate-pulse">
              BOMB {bombState.site} · {bombState.remaining.toFixed(0)}s
            </span>
          )}
          <span className="text-[11px] font-mono uppercase tracking-[0.15em] text-cs2-muted">
            {timeline.players.length} players
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3">
        {/* Map + all overlays */}
        <div className="hud-panel p-2 flex flex-col gap-2">
          <div className="relative w-full" style={{ aspectRatio: "1 / 1" }}>
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

              {/* ── Utility zones ── */}
              {radar && activeUtilityZones.map((uz, i) => {
                const [cx, cy] = project(uz.x, uz.y);
                const r = utilityRadius(uz.type);

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
                    <g key={`uz${i}`} opacity={opacity}>
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
                    <g key={`uz${i}`} opacity={opacity}>
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
                    <g key={`uz${i}`}>
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
                    <g key={`uz${i}`}>
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
                const projected: [number, number][] = g.pts.map((p) => project(p[1], p[2]));
                const last = g.pts[g.pts.length - 1];
                const [hx, hy] = project(last[1], last[2]);
                const d = smoothPath(projected);
                return (
                  <g key={`g${i}`} filter="url(#glow-sm)">
                    {/* Smooth curved trail */}
                    <path d={d} fill="none" stroke={color}
                      strokeWidth={2.5} strokeOpacity={0.6} strokeDasharray="6 3"
                      strokeLinecap="round" strokeLinejoin="round"
                    />
                    {/* Grenade icon at head position */}
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

              {/* ── Player dots with health bars ── */}
              {radar && playerStates.map((p) => {
                const [px, py] = project(p.x, p.y);
                const color = TEAM_COLOR[p.team] ?? "#94a3b8";
                const yawRad = (p.yaw * Math.PI) / 180;
                const dirLen = 22;
                const fx = px + Math.cos(yawRad) * dirLen;
                const fy = py - Math.sin(yawRad) * dirLen;
                const hpFrac = Math.max(0, Math.min(1, p.hp / 100));
                const hpColor = hpFrac > 0.5 ? "#4ade80" : hpFrac > 0.25 ? "#fbbf24" : "#f87171";
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
                    {/* Player name */}
                    <text x={px + 14} y={py - 14} fill="#fff" fontSize={14}
                      fontFamily="monospace" stroke="#000" strokeWidth={3} paintOrder="stroke"
                    >
                      {p.name}
                    </text>
                    {/* Health bar (only for alive players) */}
                    {p.alive && (
                      <g>
                        <rect x={px - 13} y={py + 14} width={26} height={3}
                          rx={1} fill="#000" fillOpacity={0.6}
                        />
                        <rect x={px - 13} y={py + 14} width={26 * hpFrac} height={3}
                          rx={1} fill={hpColor}
                        />
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
              <div className="absolute top-2 right-2 flex flex-col gap-0.5 pointer-events-none">
                {killFeed.map((k, i) => (
                  <div key={i}
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono"
                    style={{ background: "rgba(0,0,0,0.7)" }}
                  >
                    <span style={{ color: TEAM_COLOR[k.attackerTeam] ?? "#fff" }}>
                      {k.attacker}
                    </span>
                    <span className="text-cs2-muted">
                      {k.headshot ? "HS" : ""} [{k.weapon}]
                    </span>
                    <span style={{ color: TEAM_COLOR[k.victimTeam] ?? "#fff" }}>
                      {k.victim}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-2 px-1 pt-1">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const prev = [...timeline.rounds].reverse()
                    .find((r) => r.start_tick < currentTick - 1);
                  if (prev) setCurrentTick(prev.start_tick);
                }}
                className="hud-btn text-xs" title="Previous round"
              >⏮</button>
              <button
                onClick={() => setPlaying((p) => !p)}
                className="hud-btn-primary text-xs"
                title={playing ? "Pause" : "Play"}
              >
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button
                onClick={() => {
                  const next = timeline.rounds.find((r) => r.start_tick > currentTick);
                  if (next) setCurrentTick(next.start_tick);
                }}
                className="hud-btn text-xs" title="Next round"
              >⏭</button>
              <div className="flex items-center gap-1 ml-2">
                {[0.5, 1, 2, 4].map((s) => (
                  <button key={s} onClick={() => setSpeed(s)}
                    className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                      speed === s ? "bg-cs2-accent text-cs2-bg" : "hud-btn"
                    }`}
                  >{s}×</button>
                ))}
              </div>
              <span className="text-[10px] text-cs2-muted ml-auto font-mono">
                {Math.floor(currentTick / 64)}s
              </span>
            </div>
            <input
              type="range" min={0} max={timeline.tick_max} step={1}
              value={Math.round(currentTick)}
              onChange={(e) => setCurrentTick(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        {/* Side panel */}
        <div className="flex flex-col gap-3">
          {/* Round jump buttons */}
          <div className="hud-panel p-3">
            <p className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-2">
              Jump to round
            </p>
            <div className="grid grid-cols-5 gap-1">
              {timeline.rounds.map((r) => {
                const isCurrent = r.num === score.round;
                return (
                  <button key={r.num}
                    onClick={() => setCurrentTick(r.start_tick)}
                    className={`text-[10px] font-mono py-1 rounded ${
                      isCurrent ? "bg-cs2-accent text-cs2-bg" : "hud-btn"
                    }`}
                    title={r.winner ? `Won by ${r.winner}` : ""}
                    style={
                      r.winner && !isCurrent
                        ? { borderLeft: `3px solid ${TEAM_COLOR[r.winner === "T" ? 2 : 3]}` }
                        : undefined
                    }
                  >R{r.num}</button>
                );
              })}
            </div>
          </div>

          {/* Scoreboard / player list */}
          <div className="hud-panel p-3">
            <p className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-2">
              Players
            </p>
            <div className="flex flex-col gap-0.5">
              {playerStates
                .sort((a, b) => a.team - b.team || a.name.localeCompare(b.name))
                .map((p) => {
                  const hpFrac = Math.max(0, Math.min(1, p.hp / 100));
                  return (
                    <div key={p.steamid}
                      className="flex items-center gap-2 px-2 py-1 rounded text-[10px] font-mono"
                      style={{ background: TEAM_BG[p.team] ?? "transparent", opacity: p.alive ? 1 : 0.4 }}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ background: TEAM_COLOR[p.team] }} />
                      <span className="flex-1 text-white truncate">{p.name}</span>
                      {p.alive ? (
                        <span style={{ color: hpFrac > 0.5 ? "#4ade80" : hpFrac > 0.25 ? "#fbbf24" : "#f87171" }}>
                          {p.hp}
                        </span>
                      ) : (
                        <span className="text-cs2-red">DEAD</span>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>

          {/* AI Recap */}
          <div className="hud-panel p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-cs2-muted uppercase tracking-[0.15em]">AI Recap</p>
              <button onClick={handleGenerateInsights} disabled={insightsLoading}
                className="hud-btn-primary text-[10px]"
              >
                {insightsLoading ? "Asking Claude…" : insights ? "Regenerate" : "Generate"}
              </button>
            </div>
            {insightsError && (
              <p className="text-[10px] text-cs2-red border-l-2 border-cs2-red/50 pl-2">
                {insightsError}
              </p>
            )}
            {insights && (
              <div className="text-[11px] text-gray-200 leading-relaxed whitespace-pre-wrap max-h-[420px] overflow-y-auto">
                {insights}
              </div>
            )}
            {!insights && !insightsError && !insightsLoading && (
              <p className="text-[10px] text-cs2-muted">
                Generates a 3–5 paragraph narrative recap of this match using Claude. First call takes ~5s.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
