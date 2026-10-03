/**
 * DefaultSetupsPanel — one report section showing where the scouted team
 * stands 20s after freeze end: CT "default setups" or the T "default spread".
 * Data comes from `computeDefaultSetups` (./defaultSetups.ts).
 */
import { useEffect, useMemo, useState } from "react";
import type { RadarInfo } from "../../api/client";
import SectionHeader from "./SectionHeader";
import { SETUP_SNAPSHOT_S, ZONES, type RoundSetup, type SideSetupReport, type Zone } from "./defaultSetups";

const RADAR_PX = 1024;
const T_COLOR = "#DCBF6E";
const CT_COLOR = "#5B9BD5";

export const ZONE_COLORS: Record<Zone, string> = {
  A: "#fb923c",
  Mid: "#c084fc",
  B: "#2dd4bf",
  Spawn: "#94a3b8",
};

const SETUP_ROWS = 6;
const SPLIT_ROWS = 5;
const PRESENCE_ROWS = 12;

const snapshotLabel = `0:${String(SETUP_SNAPSHOT_S).padStart(2, "0")}`;

/** Percentage with its sample size, e.g. "45%  9/20 rnds". */
function Pct({ n, d, className, color }: { n: number; d: number; className?: string; color?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1 whitespace-nowrap ${className ?? ""}`}>
      <span className="font-mono font-bold" style={color ? { color } : undefined}>
        {d > 0 ? `${Math.round((n / d) * 100)}%` : "—"}
      </span>
      <span className="text-[9px] font-mono text-cs2-muted">{n}/{d} rnds</span>
    </span>
  );
}

type Selection = { kind: "setup" | "split"; key: string } | null;

export default function DefaultSetupsPanel({
  report,
  radar,
  num,
  hasCallouts,
}: {
  report: SideSetupReport;
  radar: RadarInfo | null;
  num: string;
  hasCallouts: boolean;
}) {
  const isCT = report.side === 3;
  const sideColor = isCT ? CT_COLOR : T_COLOR;
  const sideLabel = isCT ? "CT" : "T";
  const n = report.rounds.length;

  const [sel, setSel] = useState<Selection>(null);
  useEffect(() => setSel(null), [report]);

  // Default selection = the most common exact setup.
  const active: Selection = sel ?? (report.setups[0] ? { kind: "setup", key: report.setups[0].key } : null);
  const selectedRounds = useMemo(() => {
    if (!active) return [] as RoundSetup[];
    return report.rounds.filter((r) => (active.kind === "setup" ? r.key : r.zoneKey) === active.key);
  }, [active?.kind, active?.key, report]);

  const toggle = (kind: "setup" | "split", key: string) =>
    setSel((cur) => (cur?.kind === kind && cur.key === key ? null : { kind, key }));

  const otherSetups = report.setups.slice(SETUP_ROWS);
  const otherSetupRounds = otherSetups.reduce((s, x) => s + x.count, 0);

  const title = isCT ? "CT Default Setups" : "T Default Spread";
  const sub = `${n} ${sideLabel} round${n === 1 ? "" : "s"} · alive players at ${snapshotLabel} after freeze end`;

  return (
    <div className="hud-panel antistrat-section p-4 sm:p-5">
      <SectionHeader num={num} title={title} sub={sub} />

      {!hasCallouts ? (
        <p className="text-xs text-cs2-muted">No callout data for this map — can't name positions.</p>
      ) : n === 0 ? (
        <p className="text-xs text-cs2-muted">No usable {sideLabel} rounds.</p>
      ) : (
        <div className="space-y-5">
          {/* ── Zone summary ── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {ZONES.map((z) => (
              <div key={z} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: ZONE_COLORS[z] }}>
                    {z}
                  </span>
                  <span className="text-sm font-mono font-bold text-white">
                    {report.zoneAvg[z].toFixed(1)}
                    <span className="text-[9px] text-cs2-muted font-normal ml-0.5">avg</span>
                  </span>
                </div>
                <p className="text-[10px] text-cs2-muted mt-0.5 truncate">
                  {isCT ? "held in " : "players in "}
                  <Pct n={report.zonePresence[z]} d={n} className="text-[10px] text-gray-300" />
                </p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-5 antistrat-print-split">
            {/* ── Radar ── */}
            <div className="min-w-0">
              {radar ? (
                <SetupRadar
                  radar={radar}
                  rounds={report.rounds}
                  selected={selectedRounds}
                  color={sideColor}
                  showLabels={active?.kind === "setup"}
                />
              ) : (
                <div className="aspect-square rounded-lg bg-white/[0.02] flex items-center justify-center text-xs text-cs2-muted">
                  Radar unavailable
                </div>
              )}
              <p className="mt-2 text-[10px] text-cs2-muted leading-snug">
                <span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: sideColor }} />
                {active?.kind === "split" ? "Rounds with the selected zone split" : "Selected setup"}
                {" "}({selectedRounds.length} rnd{selectedRounds.length === 1 ? "" : "s"})
                <span className="inline-block w-2 h-2 rounded-full align-middle ml-3 mr-1 bg-white/30" />
                Every other {sideLabel} round
              </p>
            </div>

            {/* ── Setups + zone splits ── */}
            <div className="min-w-0 space-y-5">
              <div>
                <p className="text-[9px] text-cs2-muted uppercase tracking-[0.15em] font-semibold mb-1.5">
                  {isCT ? "Most common setups" : "Most common spreads"}
                  <span className="normal-case tracking-normal font-normal"> · share · {sideLabel} win rate</span>
                </p>
                <div className="space-y-1">
                  {report.setups.slice(0, SETUP_ROWS).map((s, i) => {
                    const on = active?.kind === "setup" && active.key === s.key;
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => toggle("setup", s.key)}
                        aria-pressed={on}
                        className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-lg border transition-colors ${
                          on ? "border-cs2-accent/40 bg-cs2-accent/[0.07]" : "border-transparent hover:bg-white/[0.03]"
                        }`}
                      >
                        <span className="text-[10px] text-cs2-muted font-mono w-5 shrink-0 pt-0.5">#{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] text-white leading-snug break-words">{s.label}</span>
                          <ZoneSplitChips counts={s.zoneCounts} />
                        </span>
                        <span className="shrink-0 flex flex-col items-end gap-0.5 text-[11px]">
                          <Pct n={s.count} d={n} color="#22d3ee" />
                          <span className="inline-flex items-baseline gap-1">
                            <span className="text-[9px] text-cs2-muted">W</span>
                            <Pct n={s.wins} d={s.count} color={s.wins / s.count >= 0.5 ? "#4ade80" : "#f87171"} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {otherSetups.length > 0 && (
                  <p className="mt-1.5 px-2 text-[10px] text-cs2-muted">
                    +{otherSetups.length} other setup{otherSetups.length === 1 ? "" : "s"} ({otherSetupRounds} rnds)
                  </p>
                )}
              </div>

              <div>
                <p className="text-[9px] text-cs2-muted uppercase tracking-[0.15em] font-semibold mb-1.5">
                  Zone split
                  <span className="normal-case tracking-normal font-normal"> · players per area · share · win rate</span>
                </p>
                <div className="space-y-1">
                  {report.zoneSplits.slice(0, SPLIT_ROWS).map((z) => {
                    const on = active?.kind === "split" && active.key === z.key;
                    return (
                      <button
                        key={z.key}
                        type="button"
                        onClick={() => toggle("split", z.key)}
                        aria-pressed={on}
                        className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors ${
                          on ? "border-cs2-accent/40 bg-cs2-accent/[0.07]" : "border-transparent hover:bg-white/[0.03]"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <ZoneSplitChips counts={z.zoneCounts} large />
                        </span>
                        <span className="shrink-0 flex flex-col items-end gap-0.5 text-[11px]">
                          <Pct n={z.count} d={n} color="#22d3ee" />
                          <span className="inline-flex items-baseline gap-1">
                            <span className="text-[9px] text-cs2-muted">W</span>
                            <Pct n={z.wins} d={z.count} color={z.wins / z.count >= 0.5 ? "#4ade80" : "#f87171"} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ── Per-callout presence ── */}
          <div>
            <p className="text-[9px] text-cs2-muted uppercase tracking-[0.15em] font-semibold mb-2">
              {isCT ? "Spot presence — how often someone holds it" : `Area presence — rounds with a player there at ${snapshotLabel}`}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 antistrat-print-cols2">
              {report.presence.slice(0, PRESENCE_ROWS).map((p) => {
                const pctVal = Math.round((p.rounds / n) * 100);
                return (
                  <div key={p.name} className="flex items-center gap-2 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ZONE_COLORS[p.zone] }} title={p.zone} />
                    <span className="text-[11px] text-white w-28 sm:w-32 shrink-0 truncate">{p.name}</span>
                    <div className="flex-1 min-w-[2rem] h-1.5 rounded-full bg-cs2-border/30 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pctVal}%`, background: sideColor, opacity: 0.75 }} />
                    </div>
                    <Pct n={p.rounds} d={n} className="text-[11px] text-white w-[5.5rem] justify-end shrink-0" />
                  </div>
                );
              })}
            </div>
            {report.presence.length > PRESENCE_ROWS && (
              <p className="mt-1.5 text-[10px] text-cs2-muted">
                +{report.presence.length - PRESENCE_ROWS} rarer spot{report.presence.length - PRESENCE_ROWS === 1 ? "" : "s"}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Sample notes ── */}
      {(report.partialRounds > 0 || report.excludedMissing > 0 || report.excludedEnded > 0) && (
        <p className="mt-4 text-[10px] text-cs2-muted leading-snug">
          {report.partialRounds > 0 && (
            <span className="text-amber-300/80">
              {report.partialRounds} of {n} rounds from partial demos.{" "}
            </span>
          )}
          {report.excludedMissing > 0 && (
            <span>
              {report.excludedMissing} round{report.excludedMissing === 1 ? "" : "s"} excluded — missing position data.{" "}
            </span>
          )}
          {report.excludedEnded > 0 && (
            <span>
              {report.excludedEnded} round{report.excludedEnded === 1 ? "" : "s"} ended before {snapshotLabel}.
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function ZoneSplitChips({ counts, large }: { counts: Record<Zone, number>; large?: boolean }) {
  return (
    <span className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono ${large ? "text-[12px]" : "text-[10px] mt-0.5"}`}>
      {ZONES.filter((z) => z !== "Spawn" || counts.Spawn > 0).map((z, i) => (
        <span key={z} className="inline-flex items-baseline gap-1">
          {i > 0 && <span className="text-cs2-muted/50">·</span>}
          <span style={{ color: ZONE_COLORS[z] }}>{z}</span>
          <span className={large ? "text-white font-bold" : "text-gray-300"}>{counts[z]}</span>
        </span>
      ))}
    </span>
  );
}

// ─── Radar with position dots ──────────────────────────────────────────
function SetupRadar({
  radar,
  rounds,
  selected,
  color,
  showLabels,
}: {
  radar: RadarInfo;
  rounds: RoundSetup[];
  selected: RoundSetup[];
  color: string;
  showLabels: boolean;
}) {
  const toRadar = (wx: number, wy: number) => ({
    x: (wx - radar.pos_x) / radar.scale,
    y: (radar.pos_y - wy) / radar.scale,
  });
  const selectedSet = new Set(selected);
  const background = rounds.filter((r) => !selectedSet.has(r));

  // One label per callout of the selected setup, at the mean dot position.
  const labels = useMemo(() => {
    if (!showLabels) return [];
    const m = new Map<string, { sx: number; sy: number; n: number }>();
    for (const r of selected) {
      for (const p of r.positions) {
        const rp = toRadar(p.x, p.y);
        const e = m.get(p.callout) ?? { sx: 0, sy: 0, n: 0 };
        e.sx += rp.x; e.sy += rp.y; e.n++;
        m.set(p.callout, e);
      }
    }
    return Array.from(m.entries()).map(([name, e]) => ({ name, x: e.sx / e.n, y: e.sy / e.n }));
  }, [selected, showLabels, radar]);

  return (
    <div className="relative rounded-lg overflow-hidden" style={{ width: "100%", aspectRatio: "1" }}>
      <img src={radar.image_url} alt="Radar" className="absolute inset-0 w-full h-full object-contain" />
      <svg viewBox={`0 0 ${RADAR_PX} ${RADAR_PX}`} className="absolute inset-0 w-full h-full">
        {background.flatMap((r) =>
          r.positions.map((p, k) => {
            const rp = toRadar(p.x, p.y);
            return <circle key={`b${r.demoIdx}-${r.roundNum}-${k}`} cx={rp.x} cy={rp.y} r={7} fill="rgba(255,255,255,0.28)" />;
          }),
        )}
        {selected.flatMap((r) =>
          r.positions.map((p, k) => {
            const rp = toRadar(p.x, p.y);
            return (
              <circle key={`s${r.demoIdx}-${r.roundNum}-${k}`} cx={rp.x} cy={rp.y} r={12}
                fill={color} fillOpacity={0.85} stroke="#05070d" strokeWidth={3}>
                <title>{`${p.player} · ${p.callout} · round ${r.roundNum}`}</title>
              </circle>
            );
          }),
        )}
        {labels.map((l) => (
          <text key={l.name} x={l.x} y={l.y - 22} textAnchor="middle" fontSize={30} fontWeight={700}
            fontFamily="Inter, system-ui, sans-serif" fill="#fff" stroke="#05070d" strokeWidth={7}
            paintOrder="stroke" style={{ pointerEvents: "none" }}>
            {l.name}
          </text>
        ))}
      </svg>
      <div className="absolute top-2 left-2 text-[10px] text-white bg-black/60 px-2 py-0.5 rounded">
        Positions at {snapshotLabel}
      </div>
    </div>
  );
}
