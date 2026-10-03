/**
 * Default setups / default spread — pure computation for the Anti-Strat page.
 *
 * For every round the scouted team plays, we snapshot each alive team
 * player's position 20 seconds after freeze end and snap it to the nearest
 * callout origin. A round's "setup" is the sorted multiset of those callouts;
 * we then aggregate across rounds per side (CT setups, T default spread).
 */
import type { Callout, MatchTimeline, TimelinePosition } from "../../api/client";

export type Zone = "A" | "Mid" | "B" | "Spawn";
export const ZONES: Zone[] = ["A", "Mid", "B", "Spawn"];
export type Side = 2 | 3; // 2 = T, 3 = CT

/** Seconds after freeze end at which the setup is sampled. */
export const SETUP_SNAPSHOT_S = 20;
/** Used only when a cached timeline predates `freeze_end_tick`. */
const FALLBACK_FREEZE_S = 20;

export interface SetupPosition {
  x: number;
  y: number;
  callout: string; // pretty callout name
  zone: Zone;
  player: string;
}

export interface RoundSetup {
  demoIdx: number;
  roundNum: number;
  won: boolean;
  partial: boolean;
  positions: SetupPosition[];
  key: string;
  zoneCounts: Record<Zone, number>;
  zoneKey: string;
}

export interface SetupAgg {
  key: string;
  label: string;
  callouts: { name: string; zone: Zone; count: number }[];
  zoneCounts: Record<Zone, number>;
  count: number;
  wins: number;
  rounds: RoundSetup[];
}

export interface ZoneSplitAgg {
  key: string;
  label: string;
  zoneCounts: Record<Zone, number>;
  count: number;
  wins: number;
}

export interface SideSetupReport {
  side: Side;
  rounds: RoundSetup[];
  /** Included rounds that came from partial demos. */
  partialRounds: number;
  excludedMissing: number;
  excludedEnded: number;
  setups: SetupAgg[];
  /** Per callout: rounds with at least one player there. */
  presence: { name: string; zone: Zone; rounds: number }[];
  /** Per zone: rounds with at least one player there. */
  zonePresence: Record<Zone, number>;
  /** Average players per zone. */
  zoneAvg: Record<Zone, number>;
  zoneSplits: ZoneSplitAgg[];
}

// ─── Callout naming ────────────────────────────────────────────────────

/** Split awpy place names ("BombsiteA", "TopofMid", "CTSpawn") into words. */
const tokenize = (raw: string): string[] =>
  raw
    .replace(/([a-z])of([A-Z])/g, "$1Of$2") // "TopofMid" → "TopOfMid"
    .split(/[\s_-]+/)
    .flatMap((w) => w.match(/[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|\d+/g) ?? []);

/** "BombsiteA" → "A Site", "TopofMid" → "Top of Mid", "SnipersNest" → "Snipers Nest". */
export const prettyCallout = (raw: string): string => {
  const t = tokenize(raw);
  if (t.length === 2 && /^bombsite$/i.test(t[0])) return `${t[1]} Site`;
  if (t.length === 0) return raw;
  return t.map((w, i) => (i > 0 && /^(of|the)$/i.test(w) ? w.toLowerCase() : w)).join(" ");
};

// ─── Zone heuristic ────────────────────────────────────────────────────
//
// Coarse A / Mid / B / Spawn grouping from callout *names*, in this order:
//   1. Any "Spawn" word                       → Spawn (T Spawn, CT Spawn)
//   2. A standalone "A" / "B" word            → that site (A Site, Long A,
//      B Doors, A Ramp — tokenised from camelCase awpy names)
//   3. A standalone "Mid" / "Middle" word     → Mid (Top of Mid, Mid Doors)
//   4. Per-map exact-name overrides for lane names whose meaning differs
//      between maps (Catwalk is mid on Mirage but short-A on Dust2).
//   5. Generic lane keywords that mean the same thing on most maps
//      (Palace/Jungle/Long → A, Apartments/Tunnel/Banana → B,
//      Connector/Window/Underpass → Mid).
//   6. Anything still unclassified takes the zone of the nearest callout
//      that *was* classified by rules 2–3 (a geometric tie-breaker).
// It's deliberately simple: good enough to turn "B Site ×2 · Shop ·
// Connector · Jungle" into "A 1 · Mid 1 · B 3", not a ground-truth map model.

const MAP_OVERRIDES: Record<string, Record<string, Zone>> = {
  de_mirage: {
    TRamp: "A", Stairs: "A", Scaffolding: "A",
    House: "B", SideAlley: "B", BackAlley: "B", Truck: "B", Shop: "B",
    SnipersNest: "Mid", Ladder: "Mid", Catwalk: "Mid",
  },
  de_dust2: {
    Catwalk: "A", ShortStairs: "A", OutsideLong: "A", LongDoors: "A", Pit: "A", Side: "A",
    TRamp: "B", Hole: "B", LowerTunnel: "Mid",
  },
};

const KEYWORDS: [RegExp, Zone][] = [
  [/palace|scaffold|tetris|jungle|firebox|ticket|long|short|pit|elevator|heaven/i, "A"],
  [/apartment|apps|market|kitchen|bench|van|tunnel|banana|hole|construction/i, "B"],
  [/catwalk|connector|underpass|ladder|window|snipers|chair|courtyard/i, "Mid"],
];

const nameZone = (raw: string): Zone | null => {
  const t = tokenize(raw);
  if (t.some((w) => /^spawn$/i.test(w))) return "Spawn";
  if (t.includes("A")) return "A";
  if (t.includes("B")) return "B";
  if (t.some((w) => /^(mid|middle)$/i.test(w))) return "Mid";
  return null;
};

export interface CalloutIndex {
  points: { x: number; y: number; name: string; zone: Zone }[];
}

/** Precompute pretty name + zone for every callout origin of a map. */
export const buildCalloutIndex = (callouts: Callout[], mapName: string): CalloutIndex => {
  const overrides = MAP_OVERRIDES[mapName] ?? {};
  const anchors = callouts
    .map((c) => ({ c, z: nameZone(c.name) }))
    .filter((a): a is { c: Callout; z: Zone } => a.z !== null && a.z !== "Spawn");

  const points = callouts.map((c) => {
    let zone: Zone | null = nameZone(c.name) ?? overrides[c.name] ?? null;
    if (!zone) zone = KEYWORDS.find(([re]) => re.test(c.name))?.[1] ?? null;
    if (!zone) {
      let best = Infinity;
      for (const a of anchors) {
        const d = Math.hypot(a.c.x - c.x, a.c.y - c.y);
        if (d < best) { best = d; zone = a.z; }
      }
    }
    return { x: c.x, y: c.y, name: prettyCallout(c.name), zone: zone ?? "Mid" };
  });
  return { points };
};

const nearest = (x: number, y: number, idx: CalloutIndex) => {
  let best = idx.points[0];
  let bestD = Infinity;
  for (const p of idx.points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
};

// ─── Labels ────────────────────────────────────────────────────────────

const zoneOrder = (z: Zone) => ZONES.indexOf(z);

export const emptyZones = (): Record<Zone, number> => ({ A: 0, Mid: 0, B: 0, Spawn: 0 });

/** "A 2 · Mid 1 · B 2" (+ "· Spawn 1" only when someone is still in spawn). */
export const zoneSplitLabel = (z: Record<Zone, number>): string =>
  ZONES.filter((k) => k !== "Spawn" || z.Spawn > 0)
    .map((k) => `${k} ${z[k]}`)
    .join(" · ");

const groupCallouts = (positions: SetupPosition[]) => {
  const m = new Map<string, { name: string; zone: Zone; count: number }>();
  for (const p of positions) {
    const e = m.get(p.callout);
    if (e) e.count++;
    else m.set(p.callout, { name: p.callout, zone: p.zone, count: 1 });
  }
  return Array.from(m.values()).sort(
    (a, b) => b.count - a.count || zoneOrder(a.zone) - zoneOrder(b.zone) || a.name.localeCompare(b.name),
  );
};

/** "B Site ×2 · Connector · A Site · Jungle". */
export const setupLabel = (callouts: { name: string; count: number }[]): string =>
  callouts.length === 0
    ? "Nobody alive"
    : callouts.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(" · ");

// ─── Sampling ──────────────────────────────────────────────────────────

/** Last sample at or before `tick` (binary search over tick-sorted samples). */
const sampleAtOrBefore = (samples: TimelinePosition[] | undefined, tick: number): TimelinePosition | null => {
  if (!samples || samples.length === 0 || samples[0].t > tick) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= tick) lo = mid;
    else hi = mid - 1;
  }
  return samples[lo];
};

// ─── Main entry ────────────────────────────────────────────────────────

const emptyReport = (side: Side): SideSetupReport => ({
  side, rounds: [], partialRounds: 0, excludedMissing: 0, excludedEnded: 0,
  setups: [], presence: [], zonePresence: emptyZones(), zoneAvg: emptyZones(), zoneSplits: [],
});

export function computeDefaultSetups(
  timelines: MatchTimeline[],
  sidSets: Set<string>[],
  partialFlags: boolean[],
  callouts: Callout[],
  mapName: string,
): { ct: SideSetupReport; t: SideSetupReport } {
  const reports = { 3: emptyReport(3), 2: emptyReport(2) } as Record<Side, SideSetupReport>;
  if (callouts.length === 0) return { ct: reports[3], t: reports[2] };
  const idx = buildCalloutIndex(callouts, mapName);

  for (let i = 0; i < timelines.length; i++) {
    const tl = timelines[i];
    const sids = [...(sidSets[i] ?? [])];
    if (sids.length === 0) continue;
    const tickRate = tl.tick_rate || 64;
    // A sample further than ~1s before the snapshot means the player's data
    // stops there (disconnect, demo cut) — treat it as missing.
    const maxGap = Math.max(tickRate, (tl.decimation || 8) * 2);
    const partial = partialFlags[i] ?? false;

    for (const r of tl.rounds) {
      const freezeEnd = r.freeze_end_tick ?? r.start_tick + FALLBACK_FREEZE_S * tickRate;
      const target = freezeEnd + SETUP_SNAPSHOT_S * tickRate;
      const probe = Math.min(target, r.end_tick);

      // Team side this round = majority team_num among the team's samples.
      const samples = sids.map((sid) => sampleAtOrBefore(tl.positions[sid], probe));
      let ct = 0, t = 0;
      for (const s of samples) {
        if (!s || s.t < r.start_tick) continue;
        if (s.tn === 3) ct++;
        else if (s.tn === 2) t++;
      }
      if (ct === 0 && t === 0) continue; // no data at all for this round — can't even pick a side
      const side: Side = ct > t ? 3 : 2;
      const rep = reports[side];

      if (target > r.end_tick) { rep.excludedEnded++; continue; }
      if (samples.some((s) => !s || target - s.t > maxGap)) { rep.excludedMissing++; continue; }

      const positions: SetupPosition[] = [];
      sids.forEach((sid, k) => {
        const s = samples[k]!;
        if (!s.alive || (s.tn !== undefined && s.tn !== side)) return;
        const c = nearest(s.x, s.y, idx);
        const player = tl.players.find((p) => p.steamid === sid)?.name ?? sid;
        positions.push({ x: s.x, y: s.y, callout: c.name, zone: c.zone, player });
      });

      const zoneCounts = emptyZones();
      for (const p of positions) zoneCounts[p.zone]++;
      rep.rounds.push({
        demoIdx: i,
        roundNum: r.num,
        won: r.winner === (side === 3 ? "CT" : "T"),
        partial,
        positions,
        key: positions.map((p) => p.callout).sort().join("|"),
        zoneCounts,
        zoneKey: ZONES.map((z) => zoneCounts[z]).join("-"),
      });
      if (partial) rep.partialRounds++;
    }
  }

  for (const rep of Object.values(reports)) aggregate(rep);
  return { ct: reports[3], t: reports[2] };
}

function aggregate(rep: SideSetupReport) {
  const setups = new Map<string, SetupAgg>();
  const splits = new Map<string, ZoneSplitAgg>();
  const presence = new Map<string, { name: string; zone: Zone; rounds: number }>();
  const zoneTotals = emptyZones();

  for (const r of rep.rounds) {
    let s = setups.get(r.key);
    if (!s) {
      const callouts = groupCallouts(r.positions);
      s = { key: r.key, label: setupLabel(callouts), callouts, zoneCounts: r.zoneCounts, count: 0, wins: 0, rounds: [] };
      setups.set(r.key, s);
    }
    s.count++;
    if (r.won) s.wins++;
    s.rounds.push(r);

    let z = splits.get(r.zoneKey);
    if (!z) {
      z = { key: r.zoneKey, label: zoneSplitLabel(r.zoneCounts), zoneCounts: r.zoneCounts, count: 0, wins: 0 };
      splits.set(r.zoneKey, z);
    }
    z.count++;
    if (r.won) z.wins++;

    const seen = new Set<string>();
    for (const p of r.positions) {
      if (seen.has(p.callout)) continue;
      seen.add(p.callout);
      const e = presence.get(p.callout);
      if (e) e.rounds++;
      else presence.set(p.callout, { name: p.callout, zone: p.zone, rounds: 1 });
    }
    for (const zn of ZONES) {
      if (r.zoneCounts[zn] > 0) rep.zonePresence[zn]++;
      zoneTotals[zn] += r.zoneCounts[zn];
    }
  }

  const n = rep.rounds.length;
  for (const zn of ZONES) rep.zoneAvg[zn] = n > 0 ? zoneTotals[zn] / n : 0;
  const byCount = <T extends { count: number; wins: number }>(a: T, b: T) => b.count - a.count || b.wins - a.wins;
  // Exact setups are often unique (5 players × ~20 callouts), so ties on
  // count are common. Break them by "typicality" — the summed presence of
  // the setup's callouts — so #1 is the round that best represents the
  // team's usual spots rather than an arbitrary one.
  const typicality = (s: SetupAgg) =>
    s.callouts.reduce((sum, c) => sum + (presence.get(c.name)?.rounds ?? 0) * c.count, 0);
  rep.setups = Array.from(setups.values()).sort(
    (a, b) => b.count - a.count || typicality(b) - typicality(a) || b.wins - a.wins,
  );
  rep.zoneSplits = Array.from(splits.values()).sort(byCount);
  rep.presence = Array.from(presence.values()).sort((a, b) => b.rounds - a.rounds || a.name.localeCompare(b.name));
}
