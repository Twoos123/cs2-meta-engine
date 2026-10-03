/**
 * Key-moment detection + shareable replay links, computed client-side from
 * the match timeline the replay already has loaded.
 */
import type { MatchTimeline, TimelineRound } from "../api/client";
import { BuyLabel, computeRoundEconomies, sampleAtTick } from "./economy";

export type MomentKind = "entry" | "multi" | "clutch" | "plant" | "defuse" | "eco";

export interface KeyMoment {
  id: string;
  kind: MomentKind;
  round: number;
  /** Tick of the event itself. */
  tick: number;
  /** Where playback should land — a short lead-in before the event. */
  seekTick: number;
  /** Side the moment belongs to (the killer / clutcher / planter / winner). */
  side: 2 | 3 | 0;
  title: string;
  detail: string;
  /** Clutches: did the clutcher win? Eco: always true. */
  won?: boolean;
}

const TICKRATE = 64;
const LEAD_IN = 3 * TICKRATE;

/** Where a round's action starts — freeze end, or round start on old caches. */
export const roundAnchorTick = (r: TimelineRound): number => r.freeze_end_tick ?? r.start_tick;

/** Round number containing `tick` (the last round started at or before it). */
export function roundAtTick(timeline: MatchTimeline, tick: number): TimelineRound | null {
  let found: TimelineRound | null = null;
  for (const r of timeline.rounds) {
    if (r.start_tick <= tick) found = r;
    else break;
  }
  return found ?? timeline.rounds[0] ?? null;
}

// ─── Shareable links: ?round=14&t=45 (seconds after that round's freeze end) ──

export function tickFromRoundTime(
  timeline: MatchTimeline,
  roundNum: number,
  seconds: number,
): number | null {
  const r = timeline.rounds.find((x) => x.num === roundNum);
  if (!r || !Number.isFinite(seconds)) return null;
  const tick = roundAnchorTick(r) + seconds * TICKRATE;
  return Math.max(r.start_tick, Math.min(timeline.tick_max, tick));
}

export function roundTimeFromTick(
  timeline: MatchTimeline,
  tick: number,
): { round: number; t: number } | null {
  const r = roundAtTick(timeline, tick);
  if (!r) return null;
  return { round: r.num, t: Math.floor((tick - roundAnchorTick(r)) / TICKRATE) };
}

/** Parse `?round=&t=` into a tick, or null when absent / invalid. */
export function tickFromSearch(timeline: MatchTimeline, params: URLSearchParams): number | null {
  const roundRaw = params.get("round");
  if (roundRaw == null) return null;
  const round = Number.parseInt(roundRaw, 10);
  const t = Number.parseFloat(params.get("t") ?? "0");
  if (!Number.isFinite(round)) return null;
  return tickFromRoundTime(timeline, round, Number.isFinite(t) ? t : 0);
}

export function replayLink(demoFile: string, round: number, t: number): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/replay/${encodeURIComponent(demoFile)}?round=${round}&t=${Math.floor(t)}`;
}

export function replayLinkForTick(timeline: MatchTimeline, demoFile: string, tick: number): string | null {
  const rt = roundTimeFromTick(timeline, tick);
  return rt ? replayLink(demoFile, rt.round, rt.t) : null;
}

/** Clipboard write with a textarea fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ─── Detection ───────────────────────────────────────────────────────────

const sideLabel = (s: number) => (s === 2 ? "T" : s === 3 ? "CT" : "?");

const BUY_RANK: Record<BuyLabel, number> = { Pistol: 0, Eco: 1, Force: 2, Half: 3, Full: 4 };

export function detectKeyMoments(timeline: MatchTimeline): KeyMoment[] {
  const out: KeyMoment[] = [];
  const name: Record<string, string> = {};
  for (const p of timeline.players) name[p.steamid] = p.name;
  const nm = (sid: string | undefined) => (sid && name[sid]) || "?";

  const teamAt = (sid: string | undefined, tick: number): number => {
    if (!sid) return 0;
    const s = sampleAtTick(timeline.positions[sid] ?? [], tick);
    if (s?.tn) return s.tn;
    return timeline.players.find((p) => p.steamid === sid)?.team_num ?? 0;
  };

  const economies = computeRoundEconomies(timeline);
  const events = timeline.events;
  let ei = 0;

  for (const r of timeline.rounds) {
    const anchor = roundAnchorTick(r);
    const seekFor = (tick: number) => Math.max(anchor, tick - LEAD_IN);

    // Events in [start_tick, end_tick] — events are tick-sorted.
    while (ei < events.length && events[ei].tick < r.start_tick) ei++;
    const roundEvents = [];
    for (let j = ei; j < events.length && events[j].tick <= r.end_tick; j++) {
      roundEvents.push(events[j]);
    }

    // Players alive at the start of the action, per side.
    const alive: Record<number, Set<string>> = { 2: new Set(), 3: new Set() };
    for (const p of timeline.players) {
      const s = sampleAtTick(timeline.positions[p.steamid] ?? [], anchor + 32);
      const team = s?.tn ?? 0;
      if ((team === 2 || team === 3) && (s?.alive ?? true)) alive[team].add(p.steamid);
    }

    let openingDone = false;
    let clutch: { sid: string; side: 2 | 3; vs: number; tick: number } | null = null;
    const killsBy: Record<string, number[]> = {};

    for (const e of roundEvents) {
      if (e.type === "death") {
        const victim = e.data.victim;
        const attacker = e.data.attacker;
        const vTeam = teamAt(victim, e.tick);
        const aTeam = teamAt(attacker, e.tick);
        const enemyKill = !!attacker && attacker !== victim && aTeam !== 0 && aTeam !== vTeam;

        if (!openingDone && enemyKill) {
          openingDone = true;
          out.push({
            id: `r${r.num}-entry`,
            kind: "entry",
            round: r.num,
            tick: e.tick,
            seekTick: seekFor(e.tick),
            side: aTeam as 2 | 3,
            title: `Opening kill · ${sideLabel(aTeam)}`,
            detail: `${nm(attacker)} → ${nm(victim)}${e.data.weapon ? ` (${e.data.weapon})` : ""}`,
          });
        }
        if (enemyKill) (killsBy[attacker] ??= []).push(e.tick);

        if (vTeam === 2 || vTeam === 3) alive[vTeam].delete(victim);

        // First time one side is down to a single player while the other
        // still has someone alive → 1vX clutch situation.
        if (!clutch) {
          for (const side of [2, 3] as const) {
            const other = side === 2 ? 3 : 2;
            if (alive[side].size === 1 && alive[other].size >= 1) {
              const [sid] = [...alive[side]];
              clutch = { sid, side, vs: alive[other].size, tick: e.tick };
              break;
            }
          }
        }
      } else if (e.type === "bomb_plant") {
        const side = 2 as const;
        out.push({
          id: `r${r.num}-plant-${e.tick}`,
          kind: "plant",
          round: r.num,
          tick: e.tick,
          seekTick: seekFor(e.tick),
          side,
          title: `Bomb planted${e.data.site ? ` · ${e.data.site}` : ""}`,
          detail: nm(e.data.planter),
        });
      } else if (e.type === "bomb_defuse") {
        out.push({
          id: `r${r.num}-defuse-${e.tick}`,
          kind: "defuse",
          round: r.num,
          tick: e.tick,
          seekTick: seekFor(e.tick - 5 * TICKRATE),
          side: 3,
          title: `Bomb defused${e.data.site ? ` · ${e.data.site}` : ""}`,
          detail: nm(e.data.defuser),
        });
      }
    }

    for (const [sid, ticks] of Object.entries(killsBy)) {
      if (ticks.length < 3) continue;
      const side = teamAt(sid, ticks[0]);
      const label = ticks.length >= 5 ? "Ace" : `${ticks.length}K`;
      out.push({
        id: `r${r.num}-multi-${sid}`,
        kind: "multi",
        round: r.num,
        tick: ticks[0],
        seekTick: seekFor(ticks[0]),
        side: (side === 2 || side === 3 ? side : 0),
        title: `${label} · ${sideLabel(side)}`,
        detail: nm(sid),
      });
    }

    if (clutch && r.winner) {
      const won = (r.winner === "T" ? 2 : 3) === clutch.side;
      out.push({
        id: `r${r.num}-clutch`,
        kind: "clutch",
        round: r.num,
        tick: clutch.tick,
        seekTick: Math.max(anchor, clutch.tick - TICKRATE),
        side: clutch.side,
        title: `1v${clutch.vs} clutch ${won ? "won" : "lost"} · ${sideLabel(clutch.side)}`,
        detail: nm(clutch.sid),
        won,
      });
    }

    const econ = economies.find((x) => x.round === r.num);
    if (econ && r.winner) {
      const winSide = r.winner === "T" ? 2 : 3;
      const buy = winSide === 2 ? econ.tBuy : econ.ctBuy;
      const oppBuy = winSide === 2 ? econ.ctBuy : econ.tBuy;
      // Only an upset counts: the winner bought less than the loser
      // (a force win against an eco isn't a key moment).
      if ((buy.label === "Eco" || buy.label === "Force") && BUY_RANK[oppBuy.label] > BUY_RANK[buy.label]) {
        out.push({
          id: `r${r.num}-eco`,
          kind: "eco",
          round: r.num,
          tick: anchor,
          seekTick: anchor,
          side: winSide,
          title: `${buy.label} round won · ${r.winner}`,
          detail: `vs ${oppBuy.label.toLowerCase()} buy`,
          won: true,
        });
      }
    }
  }

  // Stable order: round, then tick.
  out.sort((a, b) => a.round - b.round || a.tick - b.tick);
  return out;
}
