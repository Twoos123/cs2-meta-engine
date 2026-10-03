/**
 * ComparePanel — "your throw vs the pro lineup".
 *
 * Pick a player from the demo; every grenade they threw is matched against
 * the pro lineup database (same map + type, landing within ~150u) and shown
 * with position / angle / landing deltas, a quality badge, and a small radar
 * overlay of your throw spot + landing vs the pro's.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { MatchTimeline, RadarInfo } from "../api/client";
import {
  CompareResponse,
  CompareThrow,
  ThrowQuality,
  apiErrorMessage,
  getCompare,
  getMySteamId,
} from "../api/compare";
import { roundAnchorTick, roundAtTick } from "../lib/keyMoments";
import Select from "./Select";

interface Props {
  timeline: MatchTimeline;
  radar: RadarInfo | null;
  demoFile: string;
}

const RADAR_PX = 1024;

const NADE_TYPES = ["smokegrenade", "flashbang", "hegrenade", "molotov"] as const;
const NADE_LABEL: Record<string, string> = {
  smokegrenade: "Smoke", flashbang: "Flash", hegrenade: "HE", molotov: "Molotov",
};
const NADE_COLOR: Record<string, string> = {
  smokegrenade: "#cbd5e1", flashbang: "#fde047", hegrenade: "#f87171", molotov: "#fb923c",
};
const NADE_ICON: Record<string, string> = {
  smokegrenade: "/icons/smokegrenade.svg", flashbang: "/icons/flashbang.svg",
  hegrenade: "/icons/hegrenade.svg", molotov: "/icons/molotov.svg",
};

const QUALITY_META: Record<ThrowQuality, { label: string; cls: string }> = {
  "on-point": { label: "On point", cls: "text-cs2-green bg-green-500/15 border-green-500/40" },
  close: { label: "Close", cls: "text-yellow-400 bg-yellow-500/15 border-yellow-500/40" },
  off: { label: "Off", cls: "text-cs2-red bg-red-500/15 border-red-500/40" },
};

const YOU_COLOR = "#22d3ee";  // cs2-accent
const PRO_COLOR = "#4ade80";  // cs2-green

const signed = (v: number, digits = 0) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;

export default function ComparePanel({ timeline, radar, demoFile }: Props) {
  const players = useMemo(
    () => [...timeline.players].sort((a, b) => a.team_num - b.team_num || a.name.localeCompare(b.name)),
    [timeline],
  );
  const [steamid, setSteamid] = useState<string>("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(() => new Set(NADE_TYPES));
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [zoomToThrow, setZoomToThrow] = useState(true);

  // Default player: the user's own SteamID from import settings if they're
  // in this demo, else the first player. A failed/404 settings call is fine.
  useEffect(() => {
    let cancelled = false;
    getMySteamId().then((mine) => {
      if (cancelled) return;
      setSteamid((cur) => {
        if (cur) return cur;
        if (mine && players.some((p) => p.steamid === mine)) return mine;
        return players[0]?.steamid ?? "";
      });
    });
    return () => { cancelled = true; };
  }, [players]);

  useEffect(() => {
    if (!steamid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedIdx(null);
    getCompare(demoFile, steamid)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: unknown) => { if (!cancelled) { setError(apiErrorMessage(e, "Comparison failed")); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [demoFile, steamid]);

  const throws = useMemo(
    () => (data?.throws ?? []).filter((t) => typeFilter.has(t.grenade_type)),
    [data, typeFilter],
  );

  // Auto-select the first matched throw whenever the list changes.
  useEffect(() => {
    if (selectedIdx != null && selectedIdx < throws.length) return;
    const first = throws.findIndex((t) => t.matched);
    setSelectedIdx(first >= 0 ? first : throws.length ? 0 : null);
  }, [throws, selectedIdx]);

  const selected = selectedIdx != null ? throws[selectedIdx] ?? null : null;

  const qualityCounts = useMemo(() => {
    const c: Record<ThrowQuality, number> = { "on-point": 0, close: 0, off: 0 };
    for (const t of throws) if (t.matched) c[t.matched.quality]++;
    return c;
  }, [throws]);

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of data?.throws ?? []) c[t.grenade_type] = (c[t.grenade_type] ?? 0) + 1;
    return c;
  }, [data]);

  const roundInfo = (t: CompareThrow) => {
    const r = roundAtTick(timeline, t.tick);
    if (!r) return { round: t.round_number, link: null as string | null, time: "" };
    const secs = Math.floor((t.tick - roundAnchorTick(r)) / 64);
    const linkT = Math.max(0, secs - 3);
    const s = Math.max(0, secs);
    return {
      round: r.num,
      link: `/replay/${encodeURIComponent(demoFile)}?round=${r.num}&t=${linkT}`,
      time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    };
  };

  return (
    <div className="flex flex-col gap-3 p-3 lg:p-4 lg:h-full lg:flex-row lg:overflow-hidden">
      {/* Radar */}
      <div className="w-full min-w-0 flex flex-col gap-2 lg:flex-1 lg:min-h-0">
        <div className="hud-panel p-2 flex flex-col gap-2 lg:flex-1 lg:min-h-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px]">
            <span className="flex items-center gap-1.5 text-cs2-muted">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: YOU_COLOR }} /> You
            </span>
            <span className="flex items-center gap-1.5 text-cs2-muted">
              <span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: PRO_COLOR }} /> Pro lineup
            </span>
            <span className="text-cs2-muted/70">● throw · ✕ landing</span>
            <button
              onClick={() => setZoomToThrow((z) => !z)}
              className={`ml-auto hud-tab ${zoomToThrow ? "hud-tab-active" : "hud-tab-idle"} min-h-[36px] lg:min-h-0`}
            >
              {zoomToThrow ? "Zoomed" : "Full map"}
            </button>
          </div>
          <div className="relative w-full aspect-square lg:aspect-auto lg:flex-1 lg:min-h-0 flex items-center justify-center">
            <div className="aspect-square w-full lg:w-auto lg:h-full lg:max-w-full">
              <CompareRadar radar={radar} throwRow={selected} allThrows={throws}
                zoom={zoomToThrow} onSelect={(i) => setSelectedIdx(i)} />
            </div>
          </div>
        </div>
      </div>

      {/* Controls + throw list */}
      <div className="w-full flex flex-col gap-3 lg:w-[440px] lg:shrink-0 lg:min-h-0">
        <div className="hud-panel p-3 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em] mr-auto">Your throw vs the pros</h3>
            <Select
              value={steamid}
              onChange={setSteamid}
              className="w-full sm:w-56"
              options={players.map((p) => ({
                value: p.steamid,
                label: p.name,
                dot: p.team_num === 2 ? "#DCBF6E" : "#5B9BD5",
              }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {NADE_TYPES.map((t) => {
              const active = typeFilter.has(t);
              return (
                <button
                  key={t}
                  onClick={() => setTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(t)) next.delete(t); else next.add(t);
                    return next.size ? next : new Set(NADE_TYPES);
                  })}
                  className="px-2 py-1.5 lg:py-0.5 rounded text-[11px] font-mono uppercase tracking-wide border transition-all"
                  style={{
                    borderColor: active ? NADE_COLOR[t] : "transparent",
                    background: active ? `${NADE_COLOR[t]}20` : "transparent",
                    color: active ? NADE_COLOR[t] : "#64748b",
                  }}
                >
                  {NADE_LABEL[t]} {typeCounts[t] ?? 0}
                </button>
              );
            })}
          </div>
          {data && !loading && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cs2-muted">
              <span>
                <span className="text-white font-mono">{throws.filter((t) => t.matched).length}</span>/{throws.length} matched
              </span>
              {(Object.keys(QUALITY_META) as ThrowQuality[]).map((q) => (
                <span key={q} className={QUALITY_META[q].cls.split(" ")[0]}>
                  {QUALITY_META[q].label} <span className="font-mono">{qualityCounts[q]}</span>
                </span>
              ))}
              <span className="ml-auto text-cs2-muted/60">{data.lineup_count} pro lineups on {data.map_name}</span>
            </div>
          )}
        </div>

        <div className="hud-panel p-2 flex flex-col gap-1 lg:flex-1 lg:min-h-0 lg:overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {loading ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <div className="w-6 h-6 border-2 border-cs2-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-cs2-muted">Reading grenade throws… the first time a demo is compared this takes 5–15s.</p>
            </div>
          ) : error ? (
            <p className="text-xs text-cs2-red border-l-2 border-cs2-red/50 pl-2 m-1 break-words">{error}</p>
          ) : !data ? (
            <p className="text-xs text-cs2-muted p-2">Pick a player to compare their throws.</p>
          ) : (
            <>
              {data.message && (
                <p className="text-xs text-amber-300 border-l-2 border-amber-400/50 pl-2 m-1 break-words">{data.message}</p>
              )}
              {throws.length === 0 && !data.message && (
                <p className="text-xs text-cs2-muted p-2">No throws of the selected types.</p>
              )}
              {throws.map((t, i) => {
                const m = t.matched;
                const ri = roundInfo(t);
                const isSel = i === selectedIdx;
                return (
                  <div
                    key={`${t.tick}-${i}`}
                    onClick={() => setSelectedIdx(i)}
                    className={`rounded-md border px-2 py-2 cursor-pointer transition-colors min-w-0 ${
                      isSel ? "border-cs2-accent/50 bg-cs2-accent/[0.07]" : "border-white/5 hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <img src={NADE_ICON[t.grenade_type]} alt="" className="w-4 h-4 shrink-0"
                        style={{ filter: "brightness(0) invert(0.9)" }} />
                      <span className="font-mono text-[10px] text-cs2-muted shrink-0 tabular-nums">
                        R{ri.round} {ri.time}
                      </span>
                      <span className="text-sm text-white font-semibold truncate min-w-0 flex-1">
                        {m ? m.label : NADE_LABEL[t.grenade_type] ?? t.grenade_type}
                      </span>
                      {m ? (
                        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${QUALITY_META[m.quality].cls}`}>
                          {QUALITY_META[m.quality].label}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-white/10 text-cs2-muted">
                          No match
                        </span>
                      )}
                    </div>
                    {m ? (
                      <>
                        <p className="text-xs text-gray-300 mt-1 break-words">{m.summary}</p>
                        {isSel && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 mt-2 text-[11px]">
                            <Delta label="Left / right" value={`${Math.abs(m.offset_right).toFixed(0)}u ${m.offset_right >= 0 ? "R" : "L"}`} />
                            <Delta label="Fwd / back" value={`${Math.abs(m.offset_forward).toFixed(0)}u ${m.offset_forward >= 0 ? "F" : "B"}`} />
                            <Delta label="Height" value={`${signed(m.offset_vertical)}u`} />
                            <Delta label="Pitch Δ" value={`${signed(m.pitch_delta, 1)}°`} hint={m.pitch_delta > 0 ? "low" : m.pitch_delta < 0 ? "high" : ""} />
                            <Delta label="Yaw Δ" value={`${signed(m.yaw_delta, 1)}°`} hint={m.yaw_delta > 0 ? "left" : m.yaw_delta < 0 ? "right" : ""} />
                            <Delta label="Landing" value={`${m.land_distance.toFixed(0)}u`}
                              hint={m.land_along == null || Math.abs(m.land_along) < 10 ? "" : m.land_along > 0 ? "long" : "short"} />
                            <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 text-cs2-muted mt-1">
                              <span>
                                Pro: {m.throw_count} throw{m.throw_count === 1 ? "" : "s"}
                                {m.round_win_rate != null && ` · ${Math.round(m.round_win_rate * 100)}% rounds won`}
                                {m.technique && ` · ${m.technique}`}
                                {t.technique && t.technique !== m.technique && ` (you: ${t.technique})`}
                              </span>
                              {ri.link && (
                                <Link to={ri.link} onClick={(e) => e.stopPropagation()}
                                  className="ml-auto text-cs2-accent hover:text-white uppercase tracking-wide text-[10px]">
                                  Watch in replay →
                                </Link>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-[11px] text-cs2-muted mt-1">{t.no_match_reason ?? "No matching pro lineup"}</p>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Delta({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-[0.12em] text-cs2-muted/70">{label}</div>
      <div className="font-mono text-white">
        {value}
        {hint && <span className="text-cs2-muted text-[10px] ml-1">{hint}</span>}
      </div>
    </div>
  );
}

// ─── Radar overlay ────────────────────────────────────────────────────────

function CompareRadar({
  radar, throwRow, allThrows, zoom, onSelect,
}: {
  radar: RadarInfo | null;
  throwRow: CompareThrow | null;
  allThrows: CompareThrow[];
  zoom: boolean;
  onSelect: (i: number) => void;
}) {
  if (!radar) {
    return (
      <div className="w-full h-full flex items-center justify-center text-xs text-cs2-muted">
        No radar for this map.
      </div>
    );
  }
  const project = (x: number, y: number): [number, number] => [
    (x - radar.pos_x) / radar.scale,
    (radar.pos_y - y) / radar.scale,
  ];
  // Aim direction in radar space: world yaw is CCW from +x with +y up, the
  // SVG y axis points down, so flip the y component.
  const dir = (yawDeg: number, len: number): [number, number] => [
    Math.cos((yawDeg * Math.PI) / 180) * len,
    -Math.sin((yawDeg * Math.PI) / 180) * len,
  ];

  const m = throwRow?.matched ?? null;
  const you = throwRow ? project(throwRow.throw_x, throwRow.throw_y) : null;
  const youLand = throwRow && throwRow.land_x != null && throwRow.land_y != null
    ? project(throwRow.land_x, throwRow.land_y) : null;
  const pro = m ? project(m.pro_throw_x, m.pro_throw_y) : null;
  const proLand = m && m.pro_land_x != null && m.pro_land_y != null ? project(m.pro_land_x, m.pro_land_y) : null;

  // Zoomed viewBox: bounding box of the four points, padded, kept square.
  let vb = `0 0 ${RADAR_PX} ${RADAR_PX}`;
  let unit = 1; // marker scale so markers stay a constant on-screen size
  const pts = [you, youLand, pro, proLand].filter((p): p is [number, number] => !!p);
  if (zoom && pts.length) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const size = Math.min(RADAR_PX, Math.max(220, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.35);
    vb = `${cx - size / 2} ${cy - size / 2} ${size} ${size}`;
    unit = size / RADAR_PX;
  }
  const r = (v: number) => v * Math.max(unit, 0.22);

  return (
    <svg viewBox={vb} className="w-full h-full rounded-lg bg-black/30" role="img"
      aria-label="Radar: your throw position and landing vs the pro lineup">
      <image href={radar.image_url} x={0} y={0} width={RADAR_PX} height={RADAR_PX} preserveAspectRatio="xMidYMid slice" />

      {/* Other throws, faint — tap to select (full-map view only) */}
      {!zoom && allThrows.map((t, i) => {
        if (t === throwRow) return null;
        const [x, y] = project(t.throw_x, t.throw_y);
        return (
          <circle key={i} cx={x} cy={y} r={r(6)} fill={NADE_COLOR[t.grenade_type] ?? "#9ca3af"}
            opacity={0.45} className="cursor-pointer" onClick={() => onSelect(i)} />
        );
      })}

      {/* Pro: throw → landing */}
      {pro && proLand && (
        <line x1={pro[0]} y1={pro[1]} x2={proLand[0]} y2={proLand[1]}
          stroke={PRO_COLOR} strokeWidth={r(2.5)} strokeDasharray={`${r(10)} ${r(8)}`} opacity={0.75} />
      )}
      {/* You: throw → landing */}
      {you && youLand && (
        <line x1={you[0]} y1={you[1]} x2={youLand[0]} y2={youLand[1]}
          stroke={YOU_COLOR} strokeWidth={r(2.5)} strokeDasharray={`${r(10)} ${r(8)}`} opacity={0.85} />
      )}
      {/* Offsets between you and the pro (throw spot + landing) */}
      {you && pro && (
        <line x1={you[0]} y1={you[1]} x2={pro[0]} y2={pro[1]} stroke="#fff" strokeWidth={r(1.5)} opacity={0.6} />
      )}
      {youLand && proLand && (
        <line x1={youLand[0]} y1={youLand[1]} x2={proLand[0]} y2={proLand[1]} stroke="#fff" strokeWidth={r(1.5)} opacity={0.6} />
      )}

      {/* Aim direction ticks */}
      {pro && m && (() => {
        const [dx, dy] = dir(m.pro_yaw, r(34));
        return <line x1={pro[0]} y1={pro[1]} x2={pro[0] + dx} y2={pro[1] + dy} stroke={PRO_COLOR} strokeWidth={r(3)} strokeLinecap="round" />;
      })()}
      {you && throwRow && (() => {
        const [dx, dy] = dir(throwRow.yaw, r(34));
        return <line x1={you[0]} y1={you[1]} x2={you[0] + dx} y2={you[1] + dy} stroke={YOU_COLOR} strokeWidth={r(3)} strokeLinecap="round" />;
      })()}

      {/* Markers */}
      {pro && <circle cx={pro[0]} cy={pro[1]} r={r(10)} fill="none" stroke={PRO_COLOR} strokeWidth={r(3)} />}
      {you && <circle cx={you[0]} cy={you[1]} r={r(6.5)} fill={YOU_COLOR} stroke="#000" strokeWidth={r(1.5)} />}
      {proLand && <Cross x={proLand[0]} y={proLand[1]} s={r(11)} color={PRO_COLOR} w={r(3.5)} />}
      {youLand && <Cross x={youLand[0]} y={youLand[1]} s={r(8)} color={YOU_COLOR} w={r(3)} />}
    </svg>
  );
}

function Cross({ x, y, s, color, w }: { x: number; y: number; s: number; color: string; w: number }) {
  return (
    <g stroke={color} strokeWidth={w} strokeLinecap="round">
      <line x1={x - s} y1={y - s} x2={x + s} y2={y + s} />
      <line x1={x - s} y1={y + s} x2={x + s} y2={y - s} />
    </g>
  );
}
