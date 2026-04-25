/**
 * InsightsPanel — FACEIT-style match insights view.
 *
 * Owns: round ribbon (numbered tiles + half scores + outcome glyphs +
 * turning-point flags), scoreboard with checkbox filter + Swing / DMG /
 * K/D/A, static per-round map snapshot, right-side mode-switched panel
 * (Simple: Utility/Kills vertical list; Detailed: full NadeAnalysisPanel).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MatchInfoResponse,
  MatchTimeline,
  RadarInfo,
  TimelinePosition,
  deleteMatchTimeline,
  getMatchReplayTimeline,
} from "../api/client";
import NadeAnalysisPanel from "./NadeAnalysisPanel";
import Select from "./Select";

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

const GRENADE_ICON: Record<string, string> = {
  smokegrenade: "/icons/smokegrenade.svg",
  flashbang: "/icons/flashbang.svg",
  hegrenade: "/icons/hegrenade.svg",
  molotov: "/icons/molotov.svg",
  incgrenade: "/icons/incgrenade.svg",
  decoy: "/icons/decoy.svg",
};

// Weapon display-name → icon filename. Mirrors MatchReplayViewer.
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
const WEAPON_ICON_NAMES = new Set(Object.values(WEAPON_ICON_MAP));

function weaponIconPath(displayName: string): string {
  if (!displayName || displayName === "nan") return "";
  const mapped = WEAPON_ICON_MAP[displayName];
  if (mapped) return `/icons/${mapped}.svg`;
  const lower = displayName.toLowerCase();
  if (WEAPON_ICON_NAMES.has(lower)) return `/icons/${lower}.svg`;
  if (lower.includes("knife") || lower.includes("bayonet") || lower.includes("karambit")
      || lower.includes("talon") || lower.includes("navaja") || lower.includes("stiletto")
      || lower.includes("ursus") || lower.includes("classic") || lower.includes("paracord")
      || lower.includes("survival") || lower.includes("nomad") || lower.includes("skeleton")
      || lower.includes("bowie") || lower.includes("huntsman") || lower.includes("gut")
      || lower.includes("falchion") || lower.includes("flip") || lower.includes("kukri")) {
    return "/icons/knife.svg";
  }
  return "";
}

// Killfeed modifier icons (HS, wallbang, noscope, through-smoke, blind).
const KILL_MOD_ICON: Record<string, string> = {
  HS: "/icons/killfeed/icon_headshot.svg",
  WB: "/icons/killfeed/penetrate.svg",
  NS: "/icons/killfeed/noscope.svg",
  SMK: "/icons/killfeed/smoke_kill.svg",
  BLD: "/icons/killfeed/blind_kill.svg",
};

function sampleAtTick(samples: TimelinePosition[] | undefined, tick: number): TimelinePosition | null {
  if (!samples || samples.length === 0) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < tick) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(samples[lo - 1].t - tick) < Math.abs(samples[lo].t - tick)) {
    return samples[lo - 1];
  }
  return samples[lo];
}

// Smooth interpolation between the two snapshots flanking `tick`. Patterns
// playback uses this so dots glide between 8 Hz position samples instead of
// snapping — matches the live replay viewer's animation smoothness.
function interpAtTick(
  samples: TimelinePosition[] | undefined,
  tick: number,
): { x: number; y: number; yaw: number; alive: boolean; tn?: number } | null {
  if (!samples || samples.length === 0) return null;
  if (tick <= samples[0].t) return { x: samples[0].x, y: samples[0].y, yaw: samples[0].yaw ?? 0, alive: !!samples[0].alive, tn: samples[0].tn };
  if (tick >= samples[samples.length - 1].t) {
    const last = samples[samples.length - 1];
    return { x: last.x, y: last.y, yaw: last.yaw ?? 0, alive: !!last.alive, tn: last.tn };
  }
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= tick) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const span = b.t - a.t;
  const t = span > 0 ? (tick - a.t) / span : 0;
  // Smoothstep eases position so direction changes look organic.
  const ts = t * t * (3 - 2 * t);
  // Yaw interpolation handles 360° wraparound (shortest arc).
  const yawA = a.yaw ?? 0, yawB = b.yaw ?? 0;
  let dy = yawB - yawA;
  if (dy > 180) dy -= 360;
  else if (dy < -180) dy += 360;
  // tn is categorical — pick the closer sample's value.
  const closer = t < 0.5 ? a : b;
  return {
    x: a.x + (b.x - a.x) * ts,
    y: a.y + (b.y - a.y) * ts,
    yaw: yawA + dy * ts,
    alive: !!closer.alive,
    tn: closer.tn,
  };
}

function tickToRoundTime(startTick: number, tick: number): string {
  const sec = Math.max(0, Math.round((tick - startTick) / 64));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface PlayerRoundStats {
  steamid: string;
  name: string;
  team: number;
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  dmg: number;
  utildmg: number;
  flashed: number;
  hsk: number;
  openingKills: number;
  openingDeaths: number;
  survived: number;
  swing: number;         // signed contribution (unit-less)
  swingPct: number;      // relative % vs team avg
  hasRealAggregates: boolean;
}

interface RoundSummary {
  num: number;
  startTick: number;
  endTick: number;
  winner: "T" | "CT" | null;
  bombPlanted: boolean;
  bombDefused: boolean;
  bombExploded: boolean;
  tAlive: number;
  ctAlive: number;
  // Turning-point flags
  isPistol: boolean;
  isForceBuyWin: boolean;
  isStreakBreaker: boolean;
  aliveSwing: boolean;
}

interface Props {
  timeline: MatchTimeline;
  radar: RadarInfo | null;
  matchInfo: MatchInfoResponse | null;
  demoFile: string;
  onReloadTimeline: () => void;
}

export default function InsightsPanel({ timeline, radar, matchInfo, demoFile, onReloadTimeline }: Props) {
  // ── Team + player lookups (handle halftime swap via per-tick tn) ──
  const sidToName = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const p of timeline.players) m[p.steamid] = p.name;
    return m;
  }, [timeline]);

  // Determine each player's "primary" side using the majority of their per-round tn values.
  const sidToTeam = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const p of timeline.players) {
      const samples = timeline.positions[p.steamid];
      if (!samples || !samples.length) {
        m[p.steamid] = p.team_num;
        continue;
      }
      // Just use the first-half team (first sample tn is typically first-half side)
      m[p.steamid] = samples[0]?.tn ?? p.team_num;
    }
    return m;
  }, [timeline]);

  const teamNames = useMemo<Record<number, string>>(() => {
    if (matchInfo?.team1 && matchInfo?.team2) {
      const tPlayers = new Set(
        timeline.players.filter((p) => p.team_num === 2).map((p) => p.name.toLowerCase()),
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

  // ── Selected filter set ──
  const [selectedSids, setSelectedSids] = useState<Set<string>>(
    () => new Set(timeline.players.map((p) => p.steamid)),
  );

  useEffect(() => {
    setSelectedSids(new Set(timeline.players.map((p) => p.steamid)));
  }, [timeline]);

  const toggleSid = (sid: string) => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const toggleTeam = (team: number) => {
    const teamSids = timeline.players.filter((p) => sidToTeam[p.steamid] === team).map((p) => p.steamid);
    setSelectedSids((prev) => {
      const allOn = teamSids.every((s) => prev.has(s));
      const next = new Set(prev);
      if (allOn) {
        for (const s of teamSids) next.delete(s);
      } else {
        for (const s of teamSids) next.add(s);
      }
      return next;
    });
  };

  // ── Round outcomes + turning-point flags ──
  const roundSummaries = useMemo<RoundSummary[]>(() => {
    const summaries: RoundSummary[] = [];
    let prevTAlive = 5, prevCtAlive = 5;
    let streak: { winner: "T" | "CT" | null; count: number } = { winner: null, count: 0 };

    // Score for half label derivation
    for (let i = 0; i < timeline.rounds.length; i++) {
      const r = timeline.rounds[i];

      let bombPlanted = false, bombDefused = false;
      for (const e of timeline.events) {
        if (e.tick < r.start_tick) continue;
        if (e.tick > r.end_tick) break;
        if (e.type === "bomb_plant") bombPlanted = true;
        if (e.type === "bomb_defuse") bombDefused = true;
      }

      const deathsInRound = timeline.events.filter(
        (e) => e.type === "death" && e.tick >= r.start_tick && e.tick <= r.end_tick,
      );
      let tDeaths = 0, ctDeaths = 0;
      for (const d of deathsInRound) {
        const victimTeam = sidToTeam[d.data.victim] ?? 0;
        if (victimTeam === 2) tDeaths++;
        else if (victimTeam === 3) ctDeaths++;
      }
      const tAlive = Math.max(0, 5 - tDeaths);
      const ctAlive = Math.max(0, 5 - ctDeaths);
      const winner = (r.winner as "T" | "CT" | null) ?? null;
      const bombExploded = bombPlanted && !bombDefused && winner === "T";

      // Force-buy conversion: winner's team equip < 15000, loser's ≥ 22000 at round start
      let winnerEquip = 0, loserEquip = 0;
      if (winner) {
        const sampleTick = r.start_tick + 320;
        for (const p of timeline.players) {
          const s = sampleAtTick(timeline.positions[p.steamid], sampleTick);
          if (!s) continue;
          const eq = s.eq ?? 0;
          const side = s.tn ?? sidToTeam[p.steamid];
          if ((winner === "T" && side === 2) || (winner === "CT" && side === 3)) {
            winnerEquip += eq;
          } else if ((winner === "T" && side === 3) || (winner === "CT" && side === 2)) {
            loserEquip += eq;
          }
        }
      }
      const isForceBuyWin = !!winner && winnerEquip > 0 && winnerEquip < 15000 && loserEquip >= 22000;

      // Streak-breaker: prev ≥3 rounds same winner, this round opposite
      const isStreakBreaker = !!winner && streak.winner !== null && streak.winner !== winner && streak.count >= 3;

      // Alive-count swing: change in alive differential ≥ 4
      const prevDiff = prevTAlive - prevCtAlive;
      const currDiff = tAlive - ctAlive;
      const aliveSwing = Math.abs(prevDiff - currDiff) >= 4;

      summaries.push({
        num: r.num,
        startTick: r.start_tick,
        endTick: r.end_tick,
        winner,
        bombPlanted, bombDefused, bombExploded,
        tAlive, ctAlive,
        isPistol: r.num === 1 || r.num === 13,
        isForceBuyWin,
        isStreakBreaker,
        aliveSwing,
      });

      // Update streak
      if (winner) {
        if (winner === streak.winner) streak.count++;
        else streak = { winner, count: 1 };
      }
      prevTAlive = tAlive;
      prevCtAlive = ctAlive;

      // Half reset at round 13
      if (r.num === 12) streak = { winner: null, count: 0 };
    }
    return summaries;
  }, [timeline, sidToTeam]);

  // ── Per-round per-player stats using real aggregate diffs when available ──
  const { perPlayerRoundStats, playerTotals, hasRealAggregates } = useMemo(() => {
    const totals = new Map<string, PlayerRoundStats>();
    const byRound: Record<number, Record<string, PlayerRoundStats>> = {};
    let anyReal = false;

    for (const p of timeline.players) {
      const t = sidToTeam[p.steamid];
      totals.set(p.steamid, {
        steamid: p.steamid, name: p.name, team: t,
        rounds: 0, kills: 0, deaths: 0, assists: 0,
        dmg: 0, utildmg: 0, flashed: 0, hsk: 0,
        openingKills: 0, openingDeaths: 0, survived: 0,
        swing: 0, swingPct: 0, hasRealAggregates: false,
      });
    }

    // Build previous-round snapshot for each player (start from zeros)
    const prevSnap = new Map<string, {
      dmg: number; utildmg: number; ast: number; hsk: number;
      flashed: number; ktot: number; dtot: number; atime: number;
    }>();
    for (const p of timeline.players) {
      prevSnap.set(p.steamid, {
        dmg: 0, utildmg: 0, ast: 0, hsk: 0, flashed: 0, ktot: 0, dtot: 0, atime: 0,
      });
    }

    for (const r of timeline.rounds) {
      byRound[r.num] = {};
      // Opening kill in round
      let roundFirstKill = false;

      // Kills / deaths / openings (events are authoritative even without aggregates)
      const perPlayerKills = new Map<string, number>();
      const perPlayerDeaths = new Map<string, number>();
      const perPlayerOpens = new Map<string, number>();
      const perPlayerOpenD = new Map<string, number>();
      for (const e of timeline.events) {
        if (e.type !== "death") continue;
        if (e.tick < r.start_tick || e.tick > r.end_tick) continue;
        const att = e.data.attacker;
        const vic = e.data.victim;
        if (vic) perPlayerDeaths.set(vic, (perPlayerDeaths.get(vic) ?? 0) + 1);
        if (att && vic && att !== vic) {
          perPlayerKills.set(att, (perPlayerKills.get(att) ?? 0) + 1);
          if (!roundFirstKill) {
            roundFirstKill = true;
            perPlayerOpens.set(att, (perPlayerOpens.get(att) ?? 0) + 1);
            if (vic) perPlayerOpenD.set(vic, (perPlayerOpenD.get(vic) ?? 0) + 1);
          }
        }
      }

      // Aggregate diffs
      for (const p of timeline.players) {
        const endSample = sampleAtTick(timeline.positions[p.steamid], r.end_tick);
        const prev = prevSnap.get(p.steamid)!;
        const curr = {
          dmg: endSample?.dmg ?? prev.dmg,
          utildmg: endSample?.utildmg ?? prev.utildmg,
          ast: endSample?.ast ?? prev.ast,
          hsk: endSample?.hsk ?? prev.hsk,
          flashed: endSample?.flashed ?? prev.flashed,
          ktot: endSample?.ktot ?? prev.ktot,
          dtot: endSample?.dtot ?? prev.dtot,
          atime: endSample?.atime ?? prev.atime,
        };
        const hasReal = endSample?.dmg !== undefined;
        if (hasReal) anyReal = true;

        const dmg = Math.max(0, curr.dmg - prev.dmg);
        const utildmg = Math.max(0, curr.utildmg - prev.utildmg);
        const ast = Math.max(0, curr.ast - prev.ast);
        const hsk = Math.max(0, curr.hsk - prev.hsk);
        const flashed = Math.max(0, curr.flashed - prev.flashed);

        const kills = perPlayerKills.get(p.steamid) ?? 0;
        const deaths = perPlayerDeaths.get(p.steamid) ?? 0;
        const openK = perPlayerOpens.get(p.steamid) ?? 0;
        const openD = perPlayerOpenD.get(p.steamid) ?? 0;
        const survived = endSample?.alive ? 1 : 0;

        const stat: PlayerRoundStats = {
          steamid: p.steamid, name: p.name, team: sidToTeam[p.steamid],
          rounds: 1, kills, deaths, assists: ast,
          dmg, utildmg, flashed, hsk,
          openingKills: openK, openingDeaths: openD, survived,
          swing: 0, swingPct: 0, hasRealAggregates: hasReal,
        };
        // Swing formula (uses real DMG when present, falls back to kills weight otherwise)
        stat.swing = (
          1.0 * kills
          + (hasReal ? 0.004 * dmg : 0)
          + 0.3 * openK
          + 0.2 * Math.max(0, kills - 2)
          - 0.5 * deaths
          + 0.25 * survived
          + 0.05 * ast
        );
        byRound[r.num][p.steamid] = stat;

        // Accumulate totals
        const tot = totals.get(p.steamid)!;
        tot.rounds += 1;
        tot.kills += kills;
        tot.deaths += deaths;
        tot.assists += ast;
        tot.dmg += dmg;
        tot.utildmg += utildmg;
        tot.flashed += flashed;
        tot.hsk += hsk;
        tot.openingKills += openK;
        tot.openingDeaths += openD;
        tot.survived += survived;
        tot.swing += stat.swing;
        if (hasReal) tot.hasRealAggregates = true;

        prevSnap.set(p.steamid, curr);
      }

      // Normalize per-round swing to % relative to team average
      for (const team of [2, 3]) {
        const teamPlayers = Object.values(byRound[r.num]).filter((s) => s.team === team);
        if (teamPlayers.length === 0) continue;
        const teamAvg = teamPlayers.reduce((sum, s) => sum + s.swing, 0) / teamPlayers.length;
        const teamAbs = Math.max(1, Math.abs(teamAvg) + 1);
        for (const s of teamPlayers) {
          s.swingPct = ((s.swing - teamAvg) / teamAbs) * 100;
        }
      }
    }

    // Match-level swing % — average the per-round deltas
    for (const tot of totals.values()) {
      // Average per-round swing delta across all rounds where this player participated
      let swingPctSum = 0, roundCount = 0;
      for (const rn of Object.keys(byRound)) {
        const s = byRound[Number(rn)][tot.steamid];
        if (s && s.rounds > 0) {
          swingPctSum += s.swingPct;
          roundCount++;
        }
      }
      tot.swingPct = roundCount > 0 ? swingPctSum / roundCount : 0;
    }

    return {
      perPlayerRoundStats: byRound,
      playerTotals: Array.from(totals.values()),
      hasRealAggregates: anyReal,
    };
  }, [timeline, sidToTeam]);

  // ── Selected round ──
  const [currentRound, setCurrentRound] = useState<number>(() => timeline.rounds[0]?.num ?? 1);
  const currentRoundObj = timeline.rounds.find((r) => r.num === currentRound) ?? timeline.rounds[0];

  // ── Mode toggle ──
  const [rightMode, setRightMode] = useState<"simple" | "detailed">("simple");
  const [simpleTab, setSimpleTab] = useState<"utility" | "kills">("utility");
  // Isolate a single nade on the map when its row is clicked; clicking again clears.
  const [pinnedNadeGi, setPinnedNadeGi] = useState<number | null>(null);
  // Radar zoom + pan (matches the live replay viewer's behaviour).
  const [mapScale, setMapScale] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  // Mouse-resizable side panel widths.
  const [leftPaneWidth, setLeftPaneWidth] = useState(280);
  const [rightPaneWidth, setRightPaneWidth] = useState(380);
  const resizeRef = useRef<{ side: "left" | "right"; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const dx = e.clientX - r.startX;
      const next = r.side === "left" ? r.startW + dx : r.startW - dx;
      const clamped = Math.max(180, Math.min(560, next));
      if (r.side === "left") setLeftPaneWidth(clamped);
      else setRightPaneWidth(clamped);
    };
    const onUp = () => { resizeRef.current = null; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const startResize = (side: "left" | "right") => (e: React.MouseEvent) => {
    resizeRef.current = {
      side,
      startX: e.clientX,
      startW: side === "left" ? leftPaneWidth : rightPaneWidth,
    };
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  };
  // Radar mode: round = current-round overlay (existing behaviour);
  //             heatmap = aggregated nade landings across all rounds;
  //             patterns = empty radar + per-player movement trails per round
  //                        so repeated routes/throws stand out.
  const [radarMode, setRadarMode] = useState<"round" | "heatmap" | "patterns">("round");
  // Sub-filter for the radar modes — restricts heatmap/patterns to one player
  // when set. `null` = use the scoreboard's selectedSids set instead.
  const [radarPlayerFocus, setRadarPlayerFocus] = useState<string | null>(null);
  // Heatmap nade-type filter (HE / Smoke / Flash / Molly).
  const [heatmapTypeFilter, setHeatmapTypeFilter] = useState<Set<string>>(
    () => new Set(["hegrenade", "smokegrenade", "flashbang", "molotov"]),
  );
  // Patterns playback — `playTime` is seconds since round start. Each tick
  // we sample every (round × selected-player) at roundStart + playTime so
  // you can scrub or play back and watch the same player's positions across
  // every round simultaneously, revealing their routine.
  const [patternPlaying, setPatternPlaying] = useState(false);
  const [patternPlayTime, setPatternPlayTime] = useState(15);
  const [patternSpeed, setPatternSpeed] = useState(1);
  // When set, patterns mode drills into a single round and shows ALL 10
  // players (not just the focused one). Pick "All rounds" in the dropdown
  // to exit back to the multi-round overlay.
  const [patternRoundFocus, setPatternRoundFocus] = useState<number | null>(null);
  // The round ribbon at the top of Insights also drills into patterns when
  // patterns mode is active — clicking R12 there focuses R12 here too.
  useEffect(() => {
    if (radarMode === "patterns" && patternRoundFocus !== null) {
      setPatternRoundFocus(currentRound);
    }
  }, [currentRound]); // eslint-disable-line react-hooks/exhaustive-deps
  const PATTERN_MAX_SECONDS = 115;
  const patternRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!patternPlaying) return;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      setPatternPlayTime((t) => {
        const next = t + dt * patternSpeed;
        if (next > PATTERN_MAX_SECONDS) {
          setPatternPlaying(false);
          return 0;
        }
        return next;
      });
      patternRafRef.current = requestAnimationFrame(tick);
    };
    patternRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (patternRafRef.current !== null) cancelAnimationFrame(patternRafRef.current);
    };
  }, [patternPlaying, patternSpeed]);
  // Custom hover tooltip — instant, follows the cursor. Native SVG <title>
  // has a ~500ms delay and looks like a system tooltip; this gives a
  // styled, no-delay overlay positioned relative to the radar container.
  const radarHostRef = useRef<HTMLDivElement | null>(null);
  const [hoverTip, setHoverTip] = useState<{ x: number; y: number; text: string; key: string } | null>(null);
  const showTip = (e: React.MouseEvent, text: string, key: string) => {
    const host = radarHostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    setHoverTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, text, key });
  };
  const moveTip = (e: React.MouseEvent) => {
    const host = radarHostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    setHoverTip((prev) => prev ? { ...prev, x: e.clientX - rect.left, y: e.clientY - rect.top } : prev);
  };
  const hideTipFor = (key: string) => {
    setHoverTip((prev) => (prev && prev.key === key ? null : prev));
  };

  // ── Halftime detection + half scores.
  // Halftime is detected by the first round in which the majority of players'
  // team_num flipped vs their first-round value. Supports MR12 (halftime at
  // R13) and MR15 (halftime at R16) without hard-coding.
  const { halftimeRound, halfScores } = useMemo(() => {
    const firstRound = timeline.rounds[0];
    const baseline: Record<string, number> = {};
    if (firstRound) {
      for (const p of timeline.players) {
        const s = sampleAtTick(timeline.positions[p.steamid], firstRound.start_tick + 320);
        if (s?.tn) baseline[p.steamid] = s.tn;
      }
    }
    let detected = 13;   // MR12 default
    for (const r of timeline.rounds) {
      let flipped = 0, total = 0;
      for (const p of timeline.players) {
        const base = baseline[p.steamid];
        if (!base) continue;
        const s = sampleAtTick(timeline.positions[p.steamid], r.start_tick + 320);
        if (!s?.tn) continue;
        total++;
        if (s.tn !== base) flipped++;
      }
      if (total > 0 && flipped / total > 0.5) {
        detected = r.num;
        break;
      }
    }

    let firstHalfT2 = 0, firstHalfT3 = 0;
    let secondHalfT2 = 0, secondHalfT3 = 0;
    for (const r of timeline.rounds) {
      if (!r.winner) continue;
      if (r.num < detected) {
        if (r.winner === "T") firstHalfT2++;
        else if (r.winner === "CT") firstHalfT3++;
      } else {
        if (r.winner === "T") secondHalfT3++;
        else if (r.winner === "CT") secondHalfT2++;
      }
    }
    return {
      halftimeRound: detected,
      halfScores: {
        firstA: firstHalfT2, firstB: firstHalfT3,
        secondA: secondHalfT2, secondB: secondHalfT3,
      },
    };
  }, [timeline]);

  // Hide the "Second Half" label when no rounds in the second half were played.
  const hasSecondHalf = timeline.rounds.some((r) => r.num >= halftimeRound);

  // ── Re-parse handler ──
  const [reparsing, setReparsing] = useState(false);
  const handleReparse = async () => {
    setReparsing(true);
    try {
      await deleteMatchTimeline(demoFile);
      await getMatchReplayTimeline(demoFile);
      onReloadTimeline();
    } catch (e) {
      console.error("re-parse failed", e);
    } finally {
      setReparsing(false);
    }
  };

  // ── World→pixel projection ──
  const project = (x: number, y: number): [number, number] => {
    if (!radar) return [0, 0];
    return [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale];
  };

  // ── Current-round events + nades ──
  const roundNades = useMemo(() => {
    if (!currentRoundObj) return [];
    return timeline.grenades
      .map((g, gi) => ({ g, gi }))
      .filter(({ g }) => {
        const t = g.points[0]?.[0] ?? 0;
        return t >= currentRoundObj.start_tick && t <= currentRoundObj.end_tick;
      });
  }, [timeline, currentRoundObj]);

  // Per-grenade damage from player_hurt events. Match on:
  //   - attacker == thrower
  //   - weapon name compatible with grenade type (HE vs molotov/inferno)
  //   - tick within the detonation window (HE = instant, molly burns ~7s)
  // We fall back to the per-tick `utility_damage_total` diff later if the
  // bundle is from an older cache without `hurt` events.
  const nadeDamageByGi = useMemo<Record<number, { total: number; victims: Record<string, { dmg: number; firstTick: number; lastTick: number; hits: number }> }>>(() => {
    const out: Record<number, { total: number; victims: Record<string, { dmg: number; firstTick: number; lastTick: number; hits: number }> }> = {};
    const hurtEvents = timeline.events.filter((e) => e.type === "hurt");
    if (hurtEvents.length === 0) return out;
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (g.type !== "hegrenade" && g.type !== "molotov" && g.type !== "incgrenade") continue;
      const throwTick = g.points[0]?.[0] ?? 0;
      const detTick = g.detonate_tick ?? throwTick;
      // Burn duration buffer for molly/inferno; HE is instant but allow a small buffer.
      const tailTicks = g.type === "hegrenade" ? 64 : 64 * 8;
      const lo = Math.min(throwTick, detTick - 32);
      const hi = detTick + tailTicks;
      const wantWeapons = g.type === "hegrenade"
        ? new Set(["hegrenade"])
        : new Set(["molotov", "inferno", "incgrenade"]);
      let total = 0;
      const victims: Record<string, { dmg: number; firstTick: number; lastTick: number; hits: number }> = {};
      for (const e of hurtEvents) {
        if (e.tick < lo || e.tick > hi) continue;
        if (e.data.attacker !== g.thrower) continue;
        if (!wantWeapons.has(e.data.weapon)) continue;
        const dmg = parseInt(e.data.dmg, 10);
        if (!Number.isFinite(dmg) || dmg <= 0) continue;
        total += dmg;
        const v = victims[e.data.victim];
        if (v) {
          v.dmg += dmg;
          v.firstTick = Math.min(v.firstTick, e.tick);
          v.lastTick = Math.max(v.lastTick, e.tick);
          v.hits += 1;
        } else {
          victims[e.data.victim] = { dmg, firstTick: e.tick, lastTick: e.tick, hits: 1 };
        }
      }
      if (total > 0) out[gi] = { total, victims };
    }
    return out;
  }, [timeline]);

  // Effective player filter for the radar's aggregate modes (heatmap/patterns):
  // single-focus when chosen, otherwise the scoreboard's selectedSids.
  const radarFilterSids = useMemo<Set<string>>(() => {
    if (radarPlayerFocus) return new Set([radarPlayerFocus]);
    return selectedSids;
  }, [radarPlayerFocus, selectedSids]);

  // Aggregated nade landing positions for HEATMAP mode — every grenade
  // detonate point across the whole demo, filtered by player + nade type.
  const heatmapPoints = useMemo(() => {
    if (radarMode !== "heatmap") return [] as { x: number; y: number; type: string }[];
    const out: { x: number; y: number; type: string }[] = [];
    for (const g of timeline.grenades) {
      if (!radarFilterSids.has(g.thrower)) continue;
      if (!heatmapTypeFilter.has(g.type)) continue;
      const last = g.points[g.points.length - 1];
      if (!last) continue;
      out.push({ x: last[1], y: last[2], type: g.type });
    }
    return out;
  }, [timeline, radarMode, radarFilterSids, heatmapTypeFilter]);

  // PATTERNS mode (live frame). Two sub-modes:
  //   • Aggregate: every round × focused player(s), one dot per round at the
  //     same point of round time so routines stack visually.
  //   • Single-round (patternRoundFocus !== null): just that round, but ALL
  //     10 players. Lets you click a R# dot in aggregate to drill in and
  //     watch what each side was doing in that specific round.
  // No movement trail is drawn — only the live position dot + util thrown
  // by the current playtime, matching the live-replay viewer's marker style.
  // Each nade entry now carries the *flight* state at the current playtime so
  // we can render the same animated trajectory the live-replay viewer uses
  // (smooth path tail + grenade icon at the interpolated head, fading
  // pulse zone after landing). `landed=false` ⇒ in flight; `landed=true` ⇒
  // sitting at landing position with a brief lingering pulse.
  interface PatternNade {
    gi: number;
    type: string;
    points: number[][]; // [[tick, x, y], ...]
    landed: boolean;
    progress: number; // 0..1 in-flight, >1 lingering
    landX: number;
    landY: number;
    throwX: number;
    throwY: number;
  }
  const patternFrame = useMemo(() => {
    type Frame = {
      sid: string; name: string; team: number; round: number;
      pos: [number, number] | null; yaw?: number;
      nades: PatternNade[];
      // Set when this player has died in this round and we're past their
      // death tick. `deathPos` is their location at death; `deathFade` is
      // 1.0 right at death tick → 0.0 ~3s later, used to fade out the dot
      // and X mark together. After the fade completes both disappear.
      deathPos?: [number, number];
      deathFade?: number;
      // True when a player focus is set and this entry is NOT the focused
      // player. Render dimmed instead of hidden so context is preserved.
      dimmed: boolean;
    };
    if (radarMode !== "patterns") return [] as Frame[];
    const playTicks = Math.round(patternPlayTime * 64);
    const DEATH_FADE_TICKS = 64 * 3; // 3 second fade
    // Pre-index death events by (sid, round) for O(1) lookup per player.
    const deathByKey = new Map<string, { tick: number; x: number; y: number }>();
    for (const e of timeline.events) {
      if (e.type !== "death") continue;
      const vic = e.data.victim;
      if (!vic) continue;
      const round = timeline.rounds.find(
        (r) => e.tick >= r.start_tick && e.tick <= r.end_tick,
      );
      if (!round) continue;
      const key = `${vic}_${round.num}`;
      if (deathByKey.has(key)) continue; // first death only
      // Sample victim position at death tick (last interpolated frame).
      const vs = sampleAtTick(timeline.positions[vic], e.tick);
      if (!vs) continue;
      deathByKey.set(key, { tick: e.tick, x: vs.x, y: vs.y });
    }
    const out: Frame[] = [];
    const rounds = patternRoundFocus !== null
      ? timeline.rounds.filter((r) => r.num === patternRoundFocus)
      : timeline.rounds;
    const LINGER_TICKS = 64 * 3;  // keep landed nade visible for 3s
    const PRE_FLIGHT_TICKS = 32;  // start showing throw 0.5s before
    for (const r of rounds) {
      // Anchor on freeze_end_tick (action begins) so timeouts don't desync
      // the overlay. Falls back to start_tick on pre-v3 caches.
      const anchor = r.freeze_end_tick ?? r.start_tick;
      const targetTick = Math.min(r.end_tick, anchor + playTicks);
      for (const p of timeline.players) {
        // Always render everyone (dimmed when not selected) so the context
        // around the focused player stays visible. Only the scoreboard
        // selectedSids set fully removes a player.
        if (!selectedSids.has(p.steamid)) continue;
        const dimmed = radarPlayerFocus !== null && p.steamid !== radarPlayerFocus;
        const stableTeam = sidToTeam[p.steamid] ?? 0;
        if (stableTeam !== 2 && stableTeam !== 3) continue;
        const samples = timeline.positions[p.steamid] ?? [];
        const cur = interpAtTick(samples, targetTick);
        const pos: [number, number] | null = cur && cur.alive ? [cur.x, cur.y] : null;
        // Use the side this player is on for THIS round — sample tn near the
        // round anchor (action start) so halftime swaps recolor automatically.
        const sideSample = sampleAtTick(samples, anchor + 320);
        const team = sideSample?.tn ?? stableTeam;
        const nades: PatternNade[] = [];
        for (let gi = 0; gi < timeline.grenades.length; gi++) {
          const g = timeline.grenades[gi];
          if (g.thrower !== p.steamid) continue;
          if (!g.points.length) continue;
          if (!heatmapTypeFilter.has(g.type)) continue;
          const t0 = g.points[0][0];
          const tLand = g.points[g.points.length - 1][0];
          if (t0 < r.start_tick) continue;
          // Visible from a hair before throw → 3s after landing.
          if (targetTick < t0 - PRE_FLIGHT_TICKS) continue;
          if (targetTick > tLand + LINGER_TICKS) continue;
          const flightLen = Math.max(1, tLand - t0);
          const progress = Math.max(0, (targetTick - t0) / flightLen);
          nades.push({
            gi,
            type: g.type,
            points: g.points,
            landed: targetTick >= tLand,
            progress: Math.min(progress, 1 + LINGER_TICKS / flightLen),
            throwX: g.points[0][1],
            throwY: g.points[0][2],
            landX: g.points[g.points.length - 1][1],
            landY: g.points[g.points.length - 1][2],
          });
        }
        // Death overlay: if the player has died in this round and we're
        // within DEATH_FADE_TICKS of the death, surface the X.
        let deathPos: [number, number] | undefined;
        let deathFade: number | undefined;
        const dk = deathByKey.get(`${p.steamid}_${r.num}`);
        if (dk && targetTick >= dk.tick) {
          const since = targetTick - dk.tick;
          if (since <= DEATH_FADE_TICKS) {
            deathPos = [dk.x, dk.y];
            deathFade = 1 - since / DEATH_FADE_TICKS;
          }
        }
        out.push({
          sid: p.steamid, name: sidToName[p.steamid] ?? "?", team, round: r.num,
          pos, yaw: cur?.yaw, nades, deathPos, deathFade, dimmed,
        });
      }
    }
    return out;
  }, [timeline, radarMode, radarFilterSids, patternPlayTime, patternRoundFocus, sidToTeam, sidToName, heatmapTypeFilter]);

  // Per-flashbang blind attribution. A player is considered blinded by this
  // flash if their `fd` (flash_duration) jumps above ~1.0s within ~10 ticks
  // of the flash's detonation tick. Includes both enemies and teammates so
  // team-flashes are visible too.
  const flashBlindByGi = useMemo<Record<number, { victims: Record<string, { duration: number; tick: number }> }>>(() => {
    const out: Record<number, { victims: Record<string, { duration: number; tick: number }> }> = {};
    for (let gi = 0; gi < timeline.grenades.length; gi++) {
      const g = timeline.grenades[gi];
      if (g.type !== "flashbang") continue;
      const detTick = g.detonate_tick ?? g.points[0]?.[0] ?? 0;
      const checkTick = detTick + 8;
      const victims: Record<string, { duration: number; tick: number }> = {};
      for (const p of timeline.players) {
        const s = sampleAtTick(timeline.positions[p.steamid], checkTick);
        if (!s?.alive) continue;
        if (!s.fd || s.fd <= 1.0) continue;
        victims[p.steamid] = { duration: s.fd, tick: checkTick };
      }
      if (Object.keys(victims).length > 0) out[gi] = { victims };
    }
    return out;
  }, [timeline]);

  const roundDeaths = useMemo(() => {
    if (!currentRoundObj) return [];
    return timeline.events.filter(
      (e) => e.type === "death" && e.tick >= currentRoundObj.start_tick && e.tick <= currentRoundObj.end_tick,
    );
  }, [timeline, currentRoundObj]);

  const sortedTeams = useMemo(() => {
    const byTeam: Record<number, PlayerRoundStats[]> = { 2: [], 3: [] };
    for (const p of playerTotals) {
      if (p.team === 2 || p.team === 3) byTeam[p.team].push(p);
    }
    byTeam[2].sort((a, b) => b.kills - a.kills);
    byTeam[3].sort((a, b) => b.kills - a.kills);
    return byTeam;
  }, [playerTotals]);

  const currentTeamForTeam = (team: number): number => {
    // After halftime, team 2 and 3 swap uniforms. Use positions at current round start.
    if (!currentRoundObj) return team;
    const sampleTick = currentRoundObj.start_tick + 320;
    for (const p of timeline.players) {
      if (sidToTeam[p.steamid] !== team) continue;
      const s = sampleAtTick(timeline.positions[p.steamid], sampleTick);
      if (s?.tn) return s.tn;
    }
    return team;
  };

  return (
    <div className="h-full flex flex-col gap-2 p-2 overflow-hidden">
      {/* ═══ Round ribbon ═══ */}
      <div className="hud-panel p-3 shrink-0">
        <div className="flex items-center gap-3 text-sm text-cs2-muted mb-2 uppercase tracking-[0.1em] font-semibold">
          <span>First Half</span>
          <span className="font-mono text-base text-white">
            {halfScores.firstA} : {halfScores.firstB}
          </span>
          <span className="flex-1" />
          {hasSecondHalf ? (
            <>
              <span>Final</span>
              <span className="font-mono text-base text-white">
                {halfScores.firstA + halfScores.secondA} : {halfScores.firstB + halfScores.secondB}
              </span>
            </>
          ) : (
            <span className="text-cs2-muted/60 normal-case tracking-normal">
              Second half not played
            </span>
          )}
        </div>
        <div className="flex items-stretch gap-0.5 w-full">
          {roundSummaries.map((ro) => {
            const isCurrent = ro.num === currentRound;
            const winColor = ro.winner === "T" ? TEAM_COLOR[2] : ro.winner === "CT" ? TEAM_COLOR[3] : "#555";
            const showHalfDivider = ro.num === halftimeRound;
            return (
              <div key={ro.num} className="flex items-center gap-0.5 flex-1 min-w-0">
                {showHalfDivider && (
                  <div className="w-[2px] bg-cs2-accent/40 self-stretch mx-1 rounded shrink-0" />
                )}
                <button
                  onClick={() => setCurrentRound(ro.num)}
                  className={`flex flex-col items-center justify-center py-2.5 px-1 rounded transition-all flex-1 min-w-0 ${
                    isCurrent
                      ? "bg-cs2-accent/25 ring-1 ring-cs2-accent"
                      : "hover:bg-cs2-border/20"
                  }`}
                  title={`Round ${ro.num} — ${ro.winner ?? "tied"}${ro.bombPlanted ? " · planted" : ""}${ro.bombDefused ? " · defused" : ""}`}
                >
                  <span className={`text-base font-mono font-bold leading-none ${isCurrent ? "text-white" : "text-cs2-muted"}`}>
                    {ro.num}
                  </span>
                  <div className="w-[85%] h-[4px] rounded-full mt-1.5" style={{ background: winColor }} />
                  <div className="h-[22px] flex items-center justify-center mt-1">
                    {ro.bombDefused && (
                      <img src="/icons/defuser.svg" alt="def" className="w-5 h-5"
                        style={{ filter: "brightness(0) invert(0.6) sepia(1) hue-rotate(180deg) saturate(3)" }} />
                    )}
                    {ro.bombExploded && (
                      <img src="/icons/c4.svg" alt="c4" className="w-5 h-5"
                        style={{ filter: "brightness(0) saturate(100%) invert(36%) sepia(93%) saturate(7471%) hue-rotate(355deg) brightness(101%) contrast(107%)" }} />
                    )}
                    {!ro.bombDefused && !ro.bombExploded && ro.winner && (
                      <img src="/icons/killfeed/icon_suicide.svg" alt="elim" className="w-5 h-5"
                        style={{ filter: `brightness(0) saturate(100%) ${
                          ro.winner === "T"
                            ? "invert(85%) sepia(30%) saturate(800%) hue-rotate(5deg)"
                            : "invert(60%) sepia(50%) saturate(500%) hue-rotate(190deg)"
                        }` }} />
                    )}
                  </div>
                  {/* Turning-point pills */}
                  <div className="flex gap-1 mt-1 min-h-[16px] items-center">
                    {ro.isPistol && (
                      <img src="/icons/cs/icon_star.svg" alt="pistol" title="Pistol round" className="w-4 h-4"
                        style={{ filter: "brightness(0) saturate(100%) invert(85%) sepia(60%) saturate(800%) hue-rotate(5deg)" }} />
                    )}
                    {ro.isForceBuyWin && (
                      <img src="/icons/cs/dollar_sign.svg" alt="force" title="Force-buy win" className="w-4 h-4"
                        style={{ filter: "brightness(0) saturate(100%) invert(75%) sepia(85%) saturate(700%) hue-rotate(15deg)" }} />
                    )}
                    {ro.isStreakBreaker && (
                      <img src="/icons/cs/nemesis.svg" alt="streak" title="Streak-breaker" className="w-4 h-4"
                        style={{ filter: "brightness(0) saturate(100%) invert(60%) sepia(50%) saturate(500%) hue-rotate(190deg)" }} />
                    )}
                    {ro.aliveSwing && (
                      <img src="/icons/cs/dominated.svg" alt="swing" title="Alive-count swing ≥ 4" className="w-4 h-4"
                        style={{ filter: "brightness(0) saturate(100%) invert(40%) sepia(95%) saturate(3000%) hue-rotate(355deg)" }} />
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Re-parse banner when aggregates are missing */}
      {!hasRealAggregates && (
        <div className="hud-panel p-2 flex items-center gap-3 text-[11px] shrink-0"
             style={{ borderColor: "#fbbf24" }}>
          <span className="text-yellow-400">⚠</span>
          <span className="text-gray-300 flex-1">
            This demo was parsed before aggregate stats were available — DMG, assists, and flash durations will show as "—". Swing uses a K-based proxy.
          </span>
          <button
            onClick={handleReparse}
            disabled={reparsing}
            className="hud-btn text-[11px] py-1 px-3"
          >
            {reparsing ? "Re-parsing..." : "Re-parse this demo"}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ═══ Left scoreboard — user-resizable via the splitter to its right. ═══ */}
        <div
          className="shrink-0 overflow-y-auto space-y-2 flex flex-col"
          style={{ width: leftPaneWidth, scrollbarWidth: "thin" }}
        >
          {[2, 3]
            .slice()
            .sort((a, b) => currentTeamForTeam(a) - currentTeamForTeam(b))
            .map((sideTeam) => {
            const sidePlayers = sortedTeams[sideTeam] ?? [];
            if (!sidePlayers.length) return null;
            const displayTeam = currentTeamForTeam(sideTeam);
            const teamColor = TEAM_COLOR[displayTeam] ?? "#94a3b8";
            const allSelected = sidePlayers.every((p) => selectedSids.has(p.steamid));
            // Compute total wins for this side-team (stable team identity)
            // — sum winners where the team's current-round side matches:
            const totalWins = timeline.rounds.reduce((acc, r) => {
              if (!r.winner) return acc;
              // Determine what original team won this round
              const sample = timeline.positions[sidePlayers[0].steamid];
              if (!sample) return acc;
              const s = sampleAtTick(sample, r.start_tick + 320);
              const currSide = s?.tn ?? sideTeam;
              const currSideIsWinner = (r.winner === "T" && currSide === 2) || (r.winner === "CT" && currSide === 3);
              return currSideIsWinner ? acc + 1 : acc;
            }, 0);
            return (
              <div key={sideTeam} className="hud-panel p-3 flex-1 min-h-0 flex flex-col">
                <div className="flex items-center gap-2 pb-2 border-b border-cs2-border/30 mb-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => toggleTeam(sideTeam)}
                    className="accent-cs2-accent w-4 h-4"
                  />
                  <span className="text-sm font-bold uppercase tracking-[0.1em]" style={{ color: teamColor }}>
                    {teamNames[sideTeam]}
                  </span>
                  <span className="ml-auto font-mono font-bold text-white text-xl">{totalWins}</span>
                </div>
                <div className="grid text-xs text-cs2-muted uppercase tracking-[0.08em] px-1 pb-1.5"
                     style={{ gridTemplateColumns: "20px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" }}>
                  <span />
                  <span>Player</span>
                  <span className="text-right">Swing</span>
                  <span className="text-right">DMG</span>
                  <span className="text-right">K/D/A</span>
                </div>
                {sidePlayers.map((p) => {
                  const swingColor = p.swingPct > 0 ? "#4ade80" : p.swingPct < 0 ? "#f87171" : "#94a3b8";
                  const selected = selectedSids.has(p.steamid);
                  return (
                    <div
                      key={p.steamid}
                      onClick={() => toggleSid(p.steamid)}
                      className={`grid items-center gap-2 px-1 py-2 rounded cursor-pointer text-sm transition-colors ${
                        selected ? "hover:bg-cs2-border/15" : "opacity-40 hover:opacity-60"
                      }`}
                      style={{ gridTemplateColumns: "20px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" }}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) => { e.stopPropagation(); toggleSid(p.steamid); }}
                        onClick={(e) => e.stopPropagation()}
                        className="accent-cs2-accent w-4 h-4"
                      />
                      <span className="text-white truncate font-semibold">{p.name}</span>
                      <span className="text-right font-mono font-bold" style={{ color: swingColor }}>
                        {p.swingPct >= 0 ? "+" : ""}{p.swingPct.toFixed(1)}%
                      </span>
                      <span className="text-right font-mono text-gray-300">
                        {p.hasRealAggregates ? p.dmg : "—"}
                      </span>
                      <span className="text-right font-mono text-gray-300">
                        {p.kills}/{p.deaths}/{p.assists}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Splitter — drag to resize the scoreboard. */}
        <div
          onMouseDown={startResize("left")}
          className="w-2 shrink-0 cursor-col-resize hover:bg-cs2-accent/40 transition-colors rounded"
          title="Drag to resize"
        />

        {/* ═══ Center: round map ═══
            Now flex-grows into the freed horizontal space (scoreboard is
            fixed-width). Container is wider than tall on most monitors;
            the SVG inside uses preserveAspectRatio="xMidYMid meet" so the
            radar stays square and centers within. */}
        <div className="flex-1 min-w-0 h-full hud-panel p-2 overflow-hidden flex flex-col items-center">
          <div className="flex items-center gap-2 mb-1 w-full">
            {/* Mode tabs — round / heatmap / patterns */}
            <div className="flex items-center gap-1">
              {(["round", "heatmap", "patterns"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setRadarMode(m)}
                  className={`text-[10px] uppercase tracking-[0.12em] px-2 py-0.5 rounded font-mono transition-all ${
                    radarMode === m
                      ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40"
                      : "text-cs2-muted hover:text-white border border-transparent"
                  }`}
                >
                  {m === "round" ? `Round ${currentRound}` : m}
                </button>
              ))}
            </div>
            {radarMode === "round" && currentRoundObj && (
              <span className="text-[10px] text-cs2-muted font-mono ml-auto">
                {currentRoundObj.winner ?? "tied"} · {Math.round((currentRoundObj.end_tick - currentRoundObj.start_tick) / 64)}s
              </span>
            )}
          </div>
          {/* Player dropdown + per-mode controls. */}
          {radarMode !== "round" && (
            <div className="flex items-center gap-2 flex-wrap mb-1.5 w-full">
              <label className="text-[10px] text-cs2-muted uppercase tracking-wider font-mono">Player</label>
              <Select
                value={radarPlayerFocus ?? "all"}
                onChange={(v) => setRadarPlayerFocus(v === "all" ? null : v)}
                minWidth={140}
                groups={[
                  { label: "All", options: [{ value: "all", label: "All players" }] },
                  ...[2, 3].map((team) => ({
                    label: teamNames[team] ?? (team === 2 ? "T" : "CT"),
                    options: timeline.players
                      .filter((p) => sidToTeam[p.steamid] === team)
                      .map((p) => ({ value: p.steamid, label: p.name })),
                  })),
                ]}
              />

              {/* Nade-type filter — applies to both heatmap (which dots
                  show) and patterns (which thrown nades render). */}
              <div className="flex items-center gap-1">
                {([
                  ["hegrenade", "HE"],
                  ["smokegrenade", "Smoke"],
                  ["flashbang", "Flash"],
                  ["molotov", "Molly"],
                ] as const).map(([t, label]) => {
                  const active = heatmapTypeFilter.has(t);
                  const c = GRENADE_COLOR[t] ?? "#9ca3af";
                  return (
                    <button
                      key={t}
                      onClick={() => setHeatmapTypeFilter((prev) => {
                        const next = new Set(prev);
                        if (next.has(t)) next.delete(t); else next.add(t);
                        return next;
                      })}
                      className="text-[10px] px-2 py-0.5 rounded font-mono border transition-all"
                      style={{
                        color: active ? "#0a0e18" : c,
                        background: active ? c : "transparent",
                        borderColor: c + (active ? "" : "60"),
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {radarMode === "patterns" && (
                <>
                  {/* Round picker — "All rounds" overlays every round; pick
                      a specific one to drill in (also unlocks all 10 players). */}
                  <label className="text-[10px] text-cs2-muted uppercase tracking-wider font-mono">Round</label>
                  <Select
                    value={patternRoundFocus == null ? "all" : String(patternRoundFocus)}
                    onChange={(v) => setPatternRoundFocus(v === "all" ? null : Number(v))}
                    minWidth={110}
                    options={[
                      { value: "all", label: "All rounds" },
                      ...timeline.rounds.map((r) => ({
                        value: String(r.num),
                        label: `R${r.num}${r.winner ? ` · ${r.winner}` : ""}`,
                      })),
                    ]}
                  />
                  <button
                    onClick={() => setPatternPlaying((v) => !v)}
                    className="hud-btn text-[10px] py-0.5 px-2"
                  >
                    {patternPlaying ? "❚❚" : "▶"}
                  </button>
                  {[0.5, 1, 2, 4].map((s) => (
                    <button
                      key={s}
                      onClick={() => setPatternSpeed(s)}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono border transition-all ${
                        patternSpeed === s
                          ? "bg-cs2-accent/20 text-cs2-accent border-cs2-accent/40"
                          : "text-cs2-muted border-transparent hover:text-white"
                      }`}
                    >{s}x</button>
                  ))}
                  <input
                    type="range"
                    min={0}
                    max={PATTERN_MAX_SECONDS}
                    step={0.5}
                    value={patternPlayTime}
                    onChange={(e) => { setPatternPlayTime(Number(e.target.value)); setPatternPlaying(false); }}
                    className="flex-1 min-w-[100px] accent-cs2-accent"
                  />
                  <span className="text-[10px] font-mono text-cs2-muted w-10 text-right">
                    {patternPlayTime.toFixed(1)}s
                  </span>
                </>
              )}
            </div>
          )}
          <div
            className="flex-1 min-h-0 w-full relative flex items-center justify-center"
            ref={radarHostRef}
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
            {hoverTip && (
              <div
                className="absolute z-50 pointer-events-none px-2 py-1 rounded text-[11px] font-mono whitespace-nowrap shadow-lg"
                style={{
                  left: hoverTip.x + 12,
                  top: hoverTip.y + 12,
                  background: "rgba(10, 14, 24, 0.95)",
                  border: "1px solid rgba(34, 211, 238, 0.4)",
                  color: "#fff",
                }}
              >
                {hoverTip.text}
              </div>
            )}
            {/* Zoom controls — overlaid top-right of the radar. */}
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
            {radar ? (
              <div style={{
                aspectRatio: "1 / 1",
                width: "100%", maxWidth: "100%", maxHeight: "100%",
                flexShrink: 0,
                transform: `scale(${mapScale}) translate(${mapPan.x / mapScale}px, ${mapPan.y / mapScale}px)`,
                transformOrigin: "center center",
              }}>
              <svg viewBox={`0 0 ${1024} ${1024}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
                <image href={radar.image_url} x={0} y={0} width={1024} height={1024} />

                {/* ── HEATMAP mode: aggregated landing positions ── */}
                {radarMode === "heatmap" && heatmapPoints.map((hp, i) => {
                  const [hx, hy] = project(hp.x, hp.y);
                  const color = GRENADE_COLOR[hp.type] ?? "#9ca3af";
                  return (
                    <circle key={i} cx={hx} cy={hy} r={10}
                      fill={color} fillOpacity={0.18} stroke={color} strokeOpacity={0.5} strokeWidth={0.75}
                    />
                  );
                })}

                {/* ── PATTERNS mode (live): one player marker per
                       (round, player) + animated nade flight trajectories
                       for each util thrown by that player so far. Click a
                       player dot to drill into the round. ── */}
                {radarMode === "patterns" && patternFrame.map((fr) => {
                  const teamColor = TEAM_COLOR[fr.team] ?? "#94a3b8";
                  // Always show name + round so each dot is identifiable when
                  // many players overlay; single-round mode drops the R# since
                  // it'd be redundant.
                  const tag = patternRoundFocus !== null
                    ? fr.name
                    : `${fr.name} - R${fr.round}`;
                  const groupOpacity = fr.dimmed ? 0.18 : 1;
                  return (
                    <g key={`${fr.sid}-${fr.round}`} opacity={groupOpacity}>
                      {fr.nades.map((n, ni) => {
                        const c = GRENADE_COLOR[n.type] ?? "#9ca3af";
                        const icon = GRENADE_ICON[n.type];
                        const [tx, ty] = project(n.throwX, n.throwY);
                        const [lx, ly] = project(n.landX, n.landY);

                        // ── Landed: pulsing zone + icon at landing point ──
                        if (n.landed) {
                          const fadeOut = Math.max(0, 1 - (n.progress - 1) * 0.3);
                          return (
                            <g key={ni} opacity={0.85 * fadeOut}>
                              <circle cx={lx} cy={ly} r={10}
                                fill={c} fillOpacity={0.25}
                                stroke={c} strokeWidth={2} strokeOpacity={0.7}
                              />
                              {icon && (
                                <image href={icon}
                                  x={lx - 8} y={ly - 8} width={16} height={16} opacity={0.9}
                                />
                              )}
                              <text x={lx + 12} y={ly + 3}
                                fontSize={9} fill={c} fontFamily="monospace"
                                stroke="#000" strokeWidth={2.5} paintOrder="stroke"
                              >{tag}</text>
                            </g>
                          );
                        }

                        // ── In-flight: animated dashed trail + grenade head ──
                        const flightTicks = n.points.length;
                        const visibleCount = Math.max(2, Math.ceil(flightTicks * n.progress));
                        const projected: [number, number][] = [];
                        for (let j = 0; j < visibleCount; j++) {
                          projected.push(project(n.points[j][1], n.points[j][2]));
                        }
                        // Smooth interpolated head between samples
                        const exactIdx = (flightTicks - 1) * n.progress;
                        const loIdx = Math.min(Math.floor(exactIdx), flightTicks - 1);
                        const hiIdx = Math.min(loIdx + 1, flightTicks - 1);
                        const frac = exactIdx - loIdx;
                        const tSmooth = frac * frac * (3 - 2 * frac);
                        const headX = n.points[loIdx][1] + (n.points[hiIdx][1] - n.points[loIdx][1]) * tSmooth;
                        const headY = n.points[loIdx][2] + (n.points[hiIdx][2] - n.points[loIdx][2]) * tSmooth;
                        const [hx, hy] = project(headX, headY);
                        projected.push([hx, hy]);
                        const dPath = projected.map((p, j) => `${j === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
                        return (
                          <g key={ni} opacity={0.9}>
                            {/* Throw position dot */}
                            <circle cx={tx} cy={ty} r={3} fill={teamColor} fillOpacity={0.6}
                              stroke={teamColor} strokeWidth={1}
                            />
                            {/* Animated dashed trail */}
                            <path d={dPath} fill="none" stroke={c}
                              strokeWidth={2} strokeOpacity={0.65}
                              strokeDasharray="6 3" strokeLinecap="round"
                            />
                            {/* Glow ring + icon at the moving head */}
                            <circle cx={hx} cy={hy} r={11} fill="none"
                              stroke={c} strokeWidth={1.25} strokeOpacity={0.35}
                            />
                            {icon ? (
                              <image href={icon} x={hx - 9} y={hy - 9} width={18} height={18} />
                            ) : (
                              <circle cx={hx} cy={hy} r={4.5} fill={c} stroke="#000" strokeWidth={1} />
                            )}
                            <text x={hx + 12} y={hy + 3}
                              fontSize={8} fill={c} fontFamily="monospace"
                              stroke="#000" strokeWidth={2} paintOrder="stroke"
                            >{tag}</text>
                          </g>
                        );
                      })}
                      {/* Death overlay — when a player dies, the live dot
                          fades out at their last position and an X appears
                          on top, both fading together over 3s. */}
                      {fr.deathPos && fr.deathFade !== undefined && (() => {
                        const [dx, dy] = project(fr.deathPos[0], fr.deathPos[1]);
                        const radius = patternRoundFocus !== null ? 11 : 8;
                        const fade = fr.deathFade;
                        const xLen = radius * 1.1;
                        return (
                          <g opacity={fade} pointerEvents="none">
                            {/* Faded teardrop ghost at death position */}
                            <circle cx={dx} cy={dy} r={radius * 0.9}
                              fill={teamColor} fillOpacity={0.4 * fade}
                              stroke="#000" strokeWidth={1}
                            />
                            {/* X mark on top */}
                            <line x1={dx - xLen} y1={dy - xLen} x2={dx + xLen} y2={dy + xLen}
                              stroke="#fff" strokeWidth={3}
                              strokeLinecap="round"
                            />
                            <line x1={dx - xLen} y1={dy + xLen} x2={dx + xLen} y2={dy - xLen}
                              stroke="#fff" strokeWidth={3}
                              strokeLinecap="round"
                            />
                            <line x1={dx - xLen} y1={dy - xLen} x2={dx + xLen} y2={dy + xLen}
                              stroke={teamColor} strokeWidth={1.5}
                              strokeLinecap="round"
                            />
                            <line x1={dx - xLen} y1={dy + xLen} x2={dx + xLen} y2={dy - xLen}
                              stroke={teamColor} strokeWidth={1.5}
                              strokeLinecap="round"
                            />
                            <text x={dx} y={dy - radius - 5}
                              fill="#fff" fontSize={patternRoundFocus !== null ? 12 : 10}
                              fontFamily="monospace"
                              stroke="#000" strokeWidth={2.5} paintOrder="stroke"
                              textAnchor="middle"
                            >{tag}</text>
                          </g>
                        );
                      })()}
                      {fr.pos && !fr.deathPos && (() => {
                        // Same directional teardrop as the live replay viewer:
                        // tip points along yaw, inner highlight for depth, name
                        // floats above. Smaller radius than the live viewer so
                        // 10× rounds overlaid in aggregate mode stays readable.
                        const [px, py] = project(fr.pos[0], fr.pos[1]);
                        const radius = patternRoundFocus !== null ? 11 : 8;
                        const yawDeg = -(fr.yaw ?? 0);
                        return (
                          <g
                            style={{ cursor: patternRoundFocus === null ? "pointer" : "default" }}
                            onClick={patternRoundFocus === null ? () => setPatternRoundFocus(fr.round) : undefined}
                          >
                            <g transform={`rotate(${yawDeg} ${px} ${py})`}>
                              <path
                                d={`
                                  M ${px + radius * 1.15} ${py}
                                  L ${px - radius * 0.7} ${py - radius * 0.85}
                                  Q ${px - radius * 1.0} ${py} ${px - radius * 0.7} ${py + radius * 0.85}
                                  Z
                                `}
                                fill={teamColor}
                                stroke="#000"
                                strokeWidth={1.5}
                                strokeLinejoin="round"
                              />
                              <path
                                d={`
                                  M ${px + radius * 0.75} ${py}
                                  L ${px - radius * 0.3} ${py - radius * 0.45}
                                  L ${px - radius * 0.3} ${py + radius * 0.45}
                                  Z
                                `}
                                fill="#fff"
                                fillOpacity={0.22}
                              />
                            </g>
                            <text
                              x={px} y={py - radius - 5}
                              fill="#fff" fontSize={patternRoundFocus !== null ? 12 : 10}
                              fontFamily="monospace"
                              stroke="#000" strokeWidth={2.5} paintOrder="stroke"
                              textAnchor="middle" pointerEvents="none"
                            >{tag}</text>
                          </g>
                        );
                      })()}
                    </g>
                  );
                })}

                {/* ── ROUND mode (default): per-round overlays ── */}
                {radarMode === "round" && roundNades
                  .filter(({ g, gi }) => selectedSids.has(g.thrower) && (pinnedNadeGi === null || pinnedNadeGi === gi))
                  .map(({ g, gi }) => {
                    if (!g.points.length) return null;
                    const color = GRENADE_COLOR[g.type] ?? "#9ca3af";
                    const pts = g.points.map((p) => project(p[1], p[2]));
                    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
                    const [tx, ty] = pts[pts.length - 1];
                    // Thrower's position + yaw at throw tick (for the arrow)
                    const throwTick = g.points[0][0];
                    const throwerSample = sampleAtTick(timeline.positions[g.thrower], throwTick);
                    const throwerTeam = throwerSample?.tn ?? sidToTeam[g.thrower] ?? 0;
                    const throwerColor = TEAM_COLOR[throwerTeam] ?? "#94a3b8";
                    const throwerName = sidToName[g.thrower] ?? "?";
                    let throwerArrow = null;
                    if (throwerSample) {
                      const [thx, thy] = project(throwerSample.x, throwerSample.y);
                      const yawDeg = -throwerSample.yaw;
                      const radius = 9;
                      throwerArrow = (
                        <g>
                          <g transform={`rotate(${yawDeg} ${thx} ${thy})`}>
                            <path
                              d={`
                                M ${thx + radius * 1.15} ${thy}
                                L ${thx - radius * 0.7} ${thy - radius * 0.85}
                                Q ${thx - radius * 1.0} ${thy} ${thx - radius * 0.7} ${thy + radius * 0.85}
                                Z
                              `}
                              fill={throwerColor}
                              stroke="#000"
                              strokeWidth={1.25}
                              strokeLinejoin="round"
                            />
                          </g>
                          <text
                            x={thx} y={thy - radius - 3}
                            textAnchor="middle" fill="#fff" fontSize={9}
                            fontFamily="monospace" stroke="#000" strokeWidth={2}
                            paintOrder="stroke"
                          >
                            {throwerName}
                          </text>
                        </g>
                      );
                    }
                    // Damage victim markers. For HE (single-tick), draw one
                    // circle. For molly/inferno burns, sample the victim's
                    // position at every position-sample tick between firstTick
                    // and lastTick to show the path they walked through the
                    // fire, with an aggregated total dmg label.
                    //
                    // The damage label is always projected OUTSIDE the AOE
                    // radius along the victim's heading so it can never sit
                    // on top of the grenade icon at the detonation centre.
                    const dmgInfo = nadeDamageByGi[gi];
                    const labelOffsetSvg = (g.type === "hegrenade" ? 350 : 200) / (radar?.scale ?? 5) + 16;
                    const victimEntries = dmgInfo ? Object.entries(dmgInfo.victims) : [];
                    const victimMarkers = victimEntries.map(([sid, v], vIdx) => {
                          const vTeam = sidToTeam[sid] ?? 0;
                          const vColor = TEAM_COLOR[vTeam] ?? "#fff";
                          const vName = sidToName[sid] ?? "?";
                          const samples = timeline.positions[sid] ?? [];
                          // Sample positions across the damage window.
                          const pathPts: [number, number][] = [];
                          for (const s of samples) {
                            if (s.t < v.firstTick) continue;
                            if (s.t > v.lastTick) break;
                            pathPts.push(project(s.x, s.y));
                          }
                          // Always include first/last interpolated points so
                          // single-tick HEs and short bursts still render.
                          const firstSample = sampleAtTick(samples, v.firstTick);
                          const lastSample = sampleAtTick(samples, v.lastTick);
                          if (firstSample) pathPts.unshift(project(firstSample.x, firstSample.y));
                          if (lastSample) pathPts.push(project(lastSample.x, lastSample.y));
                          if (pathPts.length === 0) return null;
                          const [sx, sy] = pathPts[0];
                          const [ex, ey] = pathPts[pathPts.length - 1];
                          const pathD = pathPts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
                          const isBurn = v.hits > 1 || pathPts.length > 2;
                          // Project the label out along the vector from the
                          // detonation through the victim's mid-path point.
                          // When multiple victims, fan their labels around the
                          // circle so they don't stack on each other.
                          const midX = (sx + ex) / 2, midY = (sy + ey) / 2;
                          let dx = midX - tx, dy = midY - ty;
                          let dist = Math.hypot(dx, dy);
                          if (dist < 0.001) {
                            // Victim collapsed onto the detonation centre —
                            // pick a deterministic angle by victim index.
                            const ang = (vIdx / Math.max(1, victimEntries.length)) * Math.PI * 2;
                            dx = Math.cos(ang); dy = Math.sin(ang); dist = 1;
                          }
                          const ux = dx / dist, uy = dy / dist;
                          const labelX = tx + ux * labelOffsetSvg;
                          const labelY = ty + uy * labelOffsetSvg;
                          return (
                            <g key={sid}>
                              {/* Dotted attribution line: detonation → first hit position */}
                              <line
                                x1={tx} y1={ty} x2={sx} y2={sy}
                                stroke={color} strokeWidth={1} strokeOpacity={0.4}
                                strokeDasharray="2 3"
                              />
                              {/* Victim path through the burn (or single point for HE) */}
                              {isBurn && (
                                <path
                                  d={pathD}
                                  stroke={vColor}
                                  strokeWidth={2.5}
                                  fill="none"
                                  opacity={0.85}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              )}
                              {/* Entry + exit markers on the burn (or just one for HE).
                                  Entry = solid team-color disc (where they first took damage).
                                  Exit  = grenade-color core ringed in team-color (where they were
                                          when the last damage tick hit — usually where they ran to
                                          escape, or where they died).
                                  Each marker has an INVISIBLE oversized hit-target so the
                                  cursor doesn't have to be pixel-perfect; the visible dot
                                  grows + glows when hovered, no cursor swap. */}
                              {(() => {
                                const entryKey = `entry-${gi}-${sid}`;
                                const isHoveredEntry = hoverTip?.key === entryKey;
                                const entryR = isHoveredEntry ? 8 : 5;
                                return (
                                  <g>
                                    <circle cx={sx} cy={sy} r={entryR}
                                      fill={vColor} stroke="#000" strokeWidth={1.5}
                                      style={isHoveredEntry ? { filter: `drop-shadow(0 0 6px ${vColor})` } : undefined}
                                      pointerEvents="none"
                                    />
                                    <circle cx={sx} cy={sy} r={14} fill="transparent"
                                      style={{ cursor: "pointer" }}
                                      onMouseEnter={(e) => showTip(e, `${vName} — start position (entered ${g.type === "hegrenade" ? "HE" : "fire"}) · click to isolate`, entryKey)}
                                      onMouseMove={moveTip}
                                      onMouseLeave={() => hideTipFor(entryKey)}
                                      onClick={() => setPinnedNadeGi(pinnedNadeGi === gi ? null : gi)}
                                    />
                                  </g>
                                );
                              })()}
                              {isBurn && (() => {
                                const exitKey = `exit-${gi}-${sid}`;
                                const isHoveredExit = hoverTip?.key === exitKey;
                                const exitR = isHoveredExit ? 8 : 5;
                                return (
                                  <g>
                                    <circle cx={ex} cy={ey} r={exitR}
                                      fill={color} stroke={vColor} strokeWidth={1.8}
                                      style={isHoveredExit ? { filter: `drop-shadow(0 0 6px ${color})` } : undefined}
                                      pointerEvents="none"
                                    />
                                    <circle cx={ex} cy={ey} r={14} fill="transparent"
                                      style={{ cursor: "pointer" }}
                                      onMouseEnter={(e) => showTip(e, `${vName} — end position (last damage tick) · total ${v.dmg} dmg · click to isolate`, exitKey)}
                                      onMouseMove={moveTip}
                                      onMouseLeave={() => hideTipFor(exitKey)}
                                      onClick={() => setPinnedNadeGi(pinnedNadeGi === gi ? null : gi)}
                                    />
                                  </g>
                                );
                              })()}
                              {/* Leader line from path midpoint to label so
                                  the attribution stays clear when the label
                                  is pushed outside the radius. */}
                              <line
                                x1={midX} y1={midY} x2={labelX} y2={labelY}
                                stroke={vColor} strokeWidth={0.75} strokeOpacity={0.5}
                              />
                              {/* Aggregated damage label, OUTSIDE the AOE */}
                              <text
                                x={labelX} y={labelY}
                                textAnchor="middle" dominantBaseline="middle"
                                fill="#fff" fontSize={10}
                                fontFamily="monospace" fontWeight="bold"
                                stroke="#000" strokeWidth={2.5}
                                paintOrder="stroke"
                              >
                                {vName} −{v.dmg}
                              </text>
                            </g>
                          );
                        });
                    // AOE radius (game units → SVG via 1/radar.scale).
                    // Only drawn for nades that did damage / blinded so the map stays clean.
                    const blindInfo = flashBlindByGi[gi];
                    const radiusUnits = g.type === "hegrenade"
                      ? 350
                      : (g.type === "molotov" || g.type === "incgrenade" ? 200 : 0);
                    const radiusSvg = radiusUnits && radar ? radiusUnits / radar.scale : 0;
                    const radiusCircle = (dmgInfo && radiusSvg > 0) ? (
                      <circle
                        cx={tx} cy={ty} r={radiusSvg}
                        fill={color} fillOpacity={0.08}
                        stroke={color} strokeWidth={1} strokeOpacity={0.5}
                        strokeDasharray="3 4"
                      />
                    ) : null;

                    // Flash blind markers: each player flashed > 1.0s, drawn at
                    // their position when the flash popped. Team-color ring +
                    // yellow flash core. Label = "name 4.2s" outside, fanned
                    // around the detonation so multiple don't stack.
                    const flashEntries = blindInfo ? Object.entries(blindInfo.victims) : [];
                    const flashLabelOffset = 60;
                    const flashMarkers = flashEntries.map(([sid, fb], fIdx) => {
                      const vTeam = sidToTeam[sid] ?? 0;
                      const vColor = TEAM_COLOR[vTeam] ?? "#fff";
                      const vName = sidToName[sid] ?? "?";
                      const isTeamFlash = vTeam === throwerTeam;
                      const samples = timeline.positions[sid] ?? [];
                      const vs = sampleAtTick(samples, fb.tick);
                      if (!vs) return null;
                      const [vx, vy] = project(vs.x, vs.y);
                      // Fan label outwards along vector from detonation.
                      let dx = vx - tx, dy = vy - ty;
                      let dist = Math.hypot(dx, dy);
                      if (dist < 0.001) {
                        const ang = (fIdx / Math.max(1, flashEntries.length)) * Math.PI * 2;
                        dx = Math.cos(ang); dy = Math.sin(ang); dist = 1;
                      }
                      const ux = dx / dist, uy = dy / dist;
                      const labelX = vx + ux * flashLabelOffset;
                      const labelY = vy + uy * flashLabelOffset;
                      return (
                        <g key={`f-${sid}`}>
                          {/* Faint sight line: detonation → blinded player */}
                          <line
                            x1={tx} y1={ty} x2={vx} y2={vy}
                            stroke="#fde047" strokeWidth={1} strokeOpacity={0.35}
                            strokeDasharray="1 4"
                          />
                          {/* Blinded player marker — yellow flash core inside team ring.
                              Invisible 16px hit-target makes the hover forgiving;
                              ring expands + glows when hovered. */}
                          {(() => {
                            const flashKey = `flash-${gi}-${sid}`;
                            const isHoveredFlash = hoverTip?.key === flashKey;
                            const ringR = isHoveredFlash ? 10 : 7;
                            const coreR = isHoveredFlash ? 4 : 3;
                            return (
                              <g>
                                <circle cx={vx} cy={vy} r={ringR}
                                  fill="none" stroke={vColor} strokeWidth={2.5}
                                  strokeDasharray={isTeamFlash ? "2 2" : undefined}
                                  style={isHoveredFlash ? { filter: "drop-shadow(0 0 6px #fde047)" } : undefined}
                                  pointerEvents="none"
                                />
                                <circle cx={vx} cy={vy} r={coreR} fill="#fde047" pointerEvents="none" />
                                <circle cx={vx} cy={vy} r={16} fill="transparent"
                                  style={{ cursor: "pointer" }}
                                  onMouseEnter={(e) => showTip(e, `${vName} blinded ${fb.duration.toFixed(1)}s${isTeamFlash ? "  ⚠ team-flash" : ""} · click to isolate`, flashKey)}
                                  onMouseMove={moveTip}
                                  onMouseLeave={() => hideTipFor(flashKey)}
                                  onClick={() => setPinnedNadeGi(pinnedNadeGi === gi ? null : gi)}
                                />
                              </g>
                            );
                          })()}
                          {/* Leader + label outside the ring */}
                          <line
                            x1={vx} y1={vy} x2={labelX} y2={labelY}
                            stroke={vColor} strokeWidth={0.75} strokeOpacity={0.5}
                          />
                          <text
                            x={labelX} y={labelY}
                            textAnchor="middle" dominantBaseline="middle"
                            fill={isTeamFlash ? "#fde047" : "#fff"} fontSize={10}
                            fontFamily="monospace" fontWeight="bold"
                            stroke="#000" strokeWidth={2.5}
                            paintOrder="stroke"
                          >
                            {vName} {fb.duration.toFixed(1)}s{isTeamFlash ? " ⚠" : ""}
                          </text>
                        </g>
                      );
                    });

                    return (
                      <g key={gi}>
                        <path d={d} stroke={color} strokeWidth={1.5} fill="none" strokeDasharray="4 3" opacity={0.7} />
                        {radiusCircle}
                        {throwerArrow}
                        {victimMarkers}
                        {flashMarkers}
                        {/* Icon last so it sits on top of overlapping victim markers */}
                        <image
                          href={GRENADE_ICON[g.type] ?? GRENADE_ICON.smokegrenade}
                          x={tx - 8} y={ty - 8} width={16} height={16} opacity={0.95}
                        />
                      </g>
                    );
                  })}
              </svg>
              </div>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-cs2-muted">Loading radar…</div>
            )}
          </div>
        </div>

        {/* ═══ Right panel — narrower, fills vertical length ═══ */}
        {/* Splitter — drag to resize the right panel. */}
        <div
          onMouseDown={startResize("right")}
          className="w-2 shrink-0 cursor-col-resize hover:bg-cs2-accent/40 transition-colors rounded"
          title="Drag to resize"
        />

        <div
          className="shrink-0 flex flex-col gap-2 overflow-hidden"
          style={{ width: rightPaneWidth }}
        >
          <div className="hud-panel p-2 flex items-center gap-2 shrink-0">
            <button
              onClick={() => setRightMode("simple")}
              className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded font-mono ${
                rightMode === "simple" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
              }`}
            >Simple</button>
            <button
              onClick={() => setRightMode("detailed")}
              className={`text-[11px] uppercase tracking-wider px-2 py-0.5 rounded font-mono ${
                rightMode === "detailed" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
              }`}
            >Detailed</button>
          </div>

          {rightMode === "simple" ? (
            <div className="flex-1 min-h-0 flex flex-col gap-2">
              <div className="hud-panel p-2 flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setSimpleTab("utility")}
                  className={`text-[11px] uppercase px-2 py-0.5 rounded font-mono ${
                    simpleTab === "utility" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
                  }`}
                >Utility</button>
                <button
                  onClick={() => setSimpleTab("kills")}
                  className={`text-[11px] uppercase px-2 py-0.5 rounded font-mono ${
                    simpleTab === "kills" ? "bg-cs2-accent/20 text-cs2-accent border border-cs2-accent/40" : "text-cs2-muted hover:text-white"
                  }`}
                >Kills</button>
              </div>
              <div className="flex-1 min-h-0 hud-panel p-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
                {simpleTab === "utility" ? (
                  roundNades.length === 0 ? (
                    <p className="text-sm text-cs2-muted p-3">No utility thrown this round.</p>
                  ) : roundNades
                    .slice()
                    .sort((a, b) => (a.g.points[0]?.[0] ?? 0) - (b.g.points[0]?.[0] ?? 0))
                    .map(({ g, gi }) => {
                      const color = GRENADE_COLOR[g.type] ?? "#9ca3af";
                      const iconSrc = GRENADE_ICON[g.type] ?? GRENADE_ICON.smokegrenade;
                      const throwTick = g.points[0]?.[0] ?? 0;
                      const detTick = g.detonate_tick ?? throwTick;
                      const timeLabel = tickToRoundTime(currentRoundObj?.start_tick ?? 0, detTick);
                      const throwerName = sidToName[g.thrower] ?? "?";
                      // Effect: HE/molly damage from player_hurt events
                      // (precise per-grenade attribution); flashes use blind
                      // count + max duration computed below.
                      let effectLabel = "—";
                      let dmgBreakdown = "";
                      if (g.type === "hegrenade" || g.type === "molotov" || g.type === "incgrenade") {
                        const hit = nadeDamageByGi[gi];
                        if (hit && hit.total > 0) {
                          dmgBreakdown = Object.entries(hit.victims)
                            .sort((a, b) => b[1].dmg - a[1].dmg)
                            .map(([sid, v]) => `${sidToName[sid] ?? "?"} ${v.dmg}`)
                            .join(", ");
                          effectLabel = `${hit.total} dmg`;
                        } else {
                          // No hurt events matched (or older cache without
                          // `hurt` events) → fall back to the per-tick aggregate diff.
                          const detSample = sampleAtTick(timeline.positions[g.thrower], detTick);
                          const prevSample = sampleAtTick(timeline.positions[g.thrower], detTick - 64 * 30);
                          if (detSample?.utildmg !== undefined && prevSample?.utildmg !== undefined) {
                            const dmg = Math.max(0, detSample.utildmg - prevSample.utildmg);
                            effectLabel = `${dmg} dmg`;
                          } else {
                            effectLabel = "0 dmg";
                          }
                        }
                      }
                      if (g.type === "flashbang") {
                        // Count enemies with fd > 0 at detonate+8 ticks
                        const checkTick = detTick + 8;
                        let flashedCount = 0;
                        let maxDuration = 0;
                        const throwerTeam = sidToTeam[g.thrower] ?? 0;
                        for (const p of timeline.players) {
                          if (sidToTeam[p.steamid] === throwerTeam) continue;
                          const s = sampleAtTick(timeline.positions[p.steamid], checkTick);
                          if (s?.fd && s.fd > 1.0 && s.alive) {
                            flashedCount++;
                            maxDuration = Math.max(maxDuration, s.fd);
                          }
                        }
                        if (flashedCount > 0) {
                          effectLabel = `${maxDuration.toFixed(1)}s blind (${flashedCount})`;
                        } else {
                          effectLabel = "0 dmg";
                        }
                      }
                      const selected = selectedSids.has(g.thrower);
                      const isPinned = pinnedNadeGi === gi;
                      return (
                        <button
                          key={gi}
                          type="button"
                          onClick={() => setPinnedNadeGi(isPinned ? null : gi)}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded w-full text-left text-sm transition-colors ${
                            isPinned ? "bg-cs2-accent/15 ring-1 ring-cs2-accent/40" : "hover:bg-cs2-border/15"
                          }`}
                          style={{ opacity: selected ? 1 : 0.3 }}
                          title={dmgBreakdown ? `Damage: ${dmgBreakdown}` : (isPinned ? "Click to un-pin" : "Click to isolate this nade on the map")}
                        >
                          <img src={iconSrc} alt="" className="w-6 h-6 shrink-0"
                               style={{ filter: `drop-shadow(0 0 2px ${color})` }} />
                          <span className="text-gray-200 truncate flex-1 font-medium">{throwerName}</span>
                          <span className="font-mono text-cs2-muted shrink-0">{timeLabel}</span>
                          <span className="font-mono shrink-0 min-w-[90px] text-right font-semibold" style={{ color }}>
                            {effectLabel}
                          </span>
                        </button>
                      );
                    })
                ) : roundDeaths.length === 0 ? (
                  <p className="text-sm text-cs2-muted p-3">No kills this round.</p>
                ) : roundDeaths.map((e, i) => {
                  const att = e.data.attacker;
                  const vic = e.data.victim;
                  const attName = sidToName[att] ?? "?";
                  const vicName = sidToName[vic] ?? "?";
                  const attTeam = sidToTeam[att] ?? 0;
                  const attColor = TEAM_COLOR[attTeam] ?? "#fff";
                  const vicColor = TEAM_COLOR[sidToTeam[vic] ?? 0] ?? "#fff";
                  const timeLabel = tickToRoundTime(currentRoundObj?.start_tick ?? 0, e.tick);
                  const weapon = e.data.weapon ?? "";
                  const weaponIcon = weaponIconPath(weapon);
                  const mods: string[] = [];
                  if (e.data.headshot === "True" || e.data.headshot === "true" || e.data.headshot === "1") mods.push("HS");
                  if (e.data.penetrated && e.data.penetrated !== "0" && e.data.penetrated !== "False") mods.push("WB");
                  if (e.data.noscope === "True" || e.data.noscope === "true" || e.data.noscope === "1") mods.push("NS");
                  if (e.data.thrusmoke === "True" || e.data.thrusmoke === "true" || e.data.thrusmoke === "1") mods.push("SMK");
                  if (e.data.attackerblind === "True" || e.data.attackerblind === "true" || e.data.attackerblind === "1") mods.push("BLD");
                  const involved = selectedSids.has(att) || selectedSids.has(vic);
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-3 px-3 py-2.5 rounded hover:bg-cs2-border/15 text-sm"
                      style={{ opacity: involved ? 1 : 0.3 }}
                    >
                      <span style={{ color: attColor }} className="truncate max-w-[90px] font-semibold">{attName}</span>
                      {weaponIcon ? (
                        <img src={weaponIcon} alt={weapon} title={weapon}
                          className="h-5 w-10 shrink-0 object-contain"
                          style={{ filter: "brightness(0) invert(0.9)" }} />
                      ) : (
                        <span className="text-cs2-muted shrink-0">→</span>
                      )}
                      <span style={{ color: vicColor }} className="truncate flex-1 min-w-0 font-semibold">{vicName}</span>
                      {/* Kill-feed modifier icons */}
                      {mods.map((m) => (
                        <img key={m} src={KILL_MOD_ICON[m]} alt={m} title={m}
                          className="w-5 h-5 shrink-0"
                          style={{ filter: "brightness(0) invert(0.85)" }} />
                      ))}
                      <span className="font-mono text-cs2-muted shrink-0">{timeLabel}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden" style={{ scrollbarWidth: "thin" }}>
              <NadeAnalysisPanel
                timeline={timeline}
                sidToTeam={sidToTeam}
                sidToName={sidToName}
                teamNames={teamNames}
                currentRoundNum={currentRound}
                onSeek={(tick) => {
                  // Seek = jump to the round containing this tick
                  const r = timeline.rounds.find((rr) => tick >= rr.start_tick && tick <= rr.end_tick);
                  if (r) setCurrentRound(r.num);
                }}
                selectedSids={selectedSids}
                pinnedNadeGi={pinnedNadeGi}
                onPinNade={setPinnedNadeGi}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
