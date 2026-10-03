/**
 * Round economy + buy-type classification, shared by the Economy tab and the
 * replay's key-moments list (eco / force-buy round wins).
 */
import type { MatchTimeline, TimelinePosition } from "../api/client";

export type BuyLabel = "Pistol" | "Eco" | "Force" | "Half" | "Full";

export interface BuyType {
  label: BuyLabel;
  color: string;
  bg: string;
}

/** First round of each regulation half (MR12). Overtime rounds (25+) are
 *  not pistol rounds — teams start OT with a full $10k-style economy. */
export const isPistolRound = (roundNum: number): boolean => roundNum === 1 || roundNum === 13;

// Buy type thresholds (team total equipment value). Pistol rounds get their
// own category: everyone starts on $800 so the equip value would otherwise
// always read as "Eco".
export const classifyBuy = (teamEquipValue: number, roundNum: number): BuyType => {
  if (isPistolRound(roundNum)) return { label: "Pistol", color: "text-cs2-accent", bg: "bg-cyan-500/15" };
  if (teamEquipValue < 5000) return { label: "Eco", color: "text-cs2-red", bg: "bg-red-500/20" };
  if (teamEquipValue < 15000) return { label: "Force", color: "text-yellow-400", bg: "bg-yellow-500/20" };
  if (teamEquipValue < 22000) return { label: "Half", color: "text-orange-400", bg: "bg-orange-500/20" };
  return { label: "Full", color: "text-cs2-green", bg: "bg-green-500/20" };
};

export interface RoundEconomy {
  round: number;
  winner: string | null;
  tEquip: number;
  ctEquip: number;
  tSpent: number;
  ctSpent: number;
  tBuy: BuyType;
  ctBuy: BuyType;
  tLossBonus: number;
  ctLossBonus: number;
}

/** Nearest position sample to `tick` (binary search). */
export const sampleAtTick = (
  samples: TimelinePosition[],
  tick: number,
): TimelinePosition | null => {
  if (!samples || samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < tick) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(samples[lo - 1].t - tick) < Math.abs(samples[lo].t - tick)) {
    return samples[lo - 1];
  }
  return samples[lo];
};

/** Per-round team equipment, spend, buy type and loss bonus. */
export function computeRoundEconomies(timeline: MatchTimeline): RoundEconomy[] {
  let tConsecutiveLosses = 0;
  let ctConsecutiveLosses = 0;

  return timeline.rounds.map((r) => {
    // Sample each player's economy near the round start (after freeze time ~5s = 320 ticks)
    const sampleTick = r.start_tick + 320;
    let tEquip = 0;
    let ctEquip = 0;
    let tSpent = 0;
    let ctSpent = 0;

    for (const p of timeline.players) {
      const s = sampleAtTick(timeline.positions[p.steamid] ?? [], sampleTick);
      if (!s) continue;
      const team = s.tn ?? 0;
      const eq = s.eq ?? 0;
      const cs = s.cs ?? 0;
      if (team === 2) {
        tEquip += eq;
        tSpent += cs;
      } else if (team === 3) {
        ctEquip += eq;
        ctSpent += cs;
      }
    }

    // Loss-bonus counters reset at halftime, i.e. BEFORE the second-half
    // pistol round is evaluated.
    if (r.num === 13) {
      tConsecutiveLosses = 0;
      ctConsecutiveLosses = 0;
    }

    // Loss bonus calculation (CS2: $1400 base + $500 per consecutive loss, max $3400)
    const tLossBonus = Math.min(1400 + tConsecutiveLosses * 500, 3400);
    const ctLossBonus = Math.min(1400 + ctConsecutiveLosses * 500, 3400);

    if (r.winner === "T") {
      ctConsecutiveLosses++;
      tConsecutiveLosses = 0;
    } else if (r.winner === "CT") {
      tConsecutiveLosses++;
      ctConsecutiveLosses = 0;
    }

    return {
      round: r.num,
      winner: r.winner,
      tEquip,
      ctEquip,
      tSpent,
      ctSpent,
      tBuy: classifyBuy(tEquip, r.num),
      ctBuy: classifyBuy(ctEquip, r.num),
      tLossBonus,
      ctLossBonus,
    };
  });
}
