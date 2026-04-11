/**
 * RadarView — plots every unique winning lineup on the official CS2 radar
 * overview.
 *
 * Radar assets come from `awpy get maps` and are served by the backend at
 *   GET /api/radars/{map}.png     (1024×1024 PNG, callouts baked in)
 *   GET /api/radars/{map}         ({pos_x, pos_y, scale, rotate})
 *
 * The standard Source radar projection is:
 *   pixel_x = (world_x - pos_x) / scale
 *   pixel_y = (pos_y - world_y) / scale
 *
 * We draw the PNG as the base of a 1024×1024 SVG and overlay throw→land
 * lines in SVG coords via that formula.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Callout,
  LineupRanking,
  RadarInfo,
  getAllTypesForMap,
  getCallouts,
  getRadarInfo,
} from "../api/client";

const RADAR_PX = 1024;

const GRENADE_COLOR: Record<string, string> = {
  smokegrenade: "#cbd5e1",
  flashbang: "#fbbf24",
  hegrenade: "#f87171",
  molotov: "#fb923c",
  decoy: "#9ca3af",
};

const GRENADE_LABEL: Record<string, string> = {
  smokegrenade: "Smoke",
  flashbang: "Flash",
  hegrenade: "HE",
  molotov: "Molotov",
  decoy: "Decoy",
};

interface Props {
  mapName: string;
  onClose: () => void;
}

interface FlatLineup {
  ranking: LineupRanking;
  type: string;
}

export default function RadarView({ mapName, onClose }: Props) {
  const [radarInfo, setRadarInfo] = useState<RadarInfo | null>(null);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [lineups, setLineups] = useState<FlatLineup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showCallouts, setShowCallouts] = useState(true);
  const [hoverId, setHoverId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getRadarInfo(mapName),
      getAllTypesForMap(mapName, 500),
      getCallouts(mapName).catch(() => [] as Callout[]),
    ])
      .then(([info, groups, co]) => {
        if (cancelled) return;
        setRadarInfo(info);
        setCallouts(co);
        const flat: FlatLineup[] = [];
        for (const g of groups) {
          for (const r of g.lineups) {
            flat.push({ ranking: r, type: g.grenade_type });
          }
        }
        setLineups(flat);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail ?? "Failed to load radar data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mapName]);

  const project = useMemo(() => {
    if (!radarInfo) {
      return (_x: number, _y: number): [number, number] => [0, 0];
    }
    const { pos_x, pos_y, scale } = radarInfo;
    return (x: number, y: number): [number, number] => [
      (x - pos_x) / scale,
      (pos_y - y) / scale,
    ];
  }, [radarInfo]);

  const visibleLineups = useMemo(
    () => lineups.filter((l) => !hidden.has(l.type)),
    [lineups, hidden],
  );

  const typesPresent = useMemo(
    () => Array.from(new Set(lineups.map((l) => l.type))),
    [lineups],
  );

  const hoverLineup = useMemo(
    () => lineups.find((l) => l.ranking.cluster.cluster_id === hoverId),
    [lineups, hoverId],
  );

  const toggleType = (t: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="hud-panel hud-corner max-w-5xl w-full max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-cs2-border">
          <div>
            <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">
              / radar
            </p>
            <h2 className="text-sm font-semibold text-white mt-0.5">
              {mapName}
            </h2>
            <p className="text-[10px] text-cs2-muted mt-0.5 font-mono">
              {loading
                ? "loading…"
                : `${visibleLineups.length} unique lineups plotted`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {typesPresent.map((t) => {
              const on = !hidden.has(t);
              const color = GRENADE_COLOR[t] ?? "#94a3b8";
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`text-xs px-2 py-1 rounded-full border transition-opacity ${
                    on ? "opacity-100" : "opacity-40"
                  }`}
                  style={{ borderColor: color, color }}
                >
                  {GRENADE_LABEL[t] ?? t}
                </button>
              );
            })}
            {callouts.length > 0 && (
              <button
                onClick={() => setShowCallouts((v) => !v)}
                className={`text-xs px-2 py-1 rounded-full border border-gray-500 text-gray-300 transition-opacity ${
                  showCallouts ? "opacity-100" : "opacity-40"
                }`}
                title="Toggle callout labels"
              >
                Callouts
              </button>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white px-2 py-1 text-lg leading-none"
              title="Close"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="relative flex-1 overflow-auto bg-black flex items-center justify-center">
          {error && (
            <div className="p-6 text-sm text-cs2-red">{error}</div>
          )}
          {!error && radarInfo && (
            <svg
              viewBox={`0 0 ${RADAR_PX} ${RADAR_PX}`}
              className="max-w-full max-h-[80vh]"
              style={{ aspectRatio: "1 / 1" }}
            >
              <image
                href={radarInfo.image_url}
                x={0}
                y={0}
                width={RADAR_PX}
                height={RADAR_PX}
              />

              {/* Callout labels (toggleable) */}
              {showCallouts &&
                callouts.map((c) => {
                  const [cx, cy] = project(c.x, c.y);
                  return (
                    <g key={`co-${c.name}`} pointerEvents="none">
                      <text
                        x={cx}
                        y={cy}
                        fontSize="11"
                        fontFamily="sans-serif"
                        fontWeight="600"
                        fill="#fde047"
                        stroke="#000"
                        strokeWidth="2.5"
                        strokeOpacity={0.85}
                        paintOrder="stroke"
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {c.name}
                      </text>
                    </g>
                  );
                })}

              {/* Lineups: throw -> land */}
              {visibleLineups.map((l) => {
                const c = l.ranking.cluster;
                const color = GRENADE_COLOR[l.type] ?? "#94a3b8";
                const [tx, ty] = project(
                  c.throw_centroid_x,
                  c.throw_centroid_y,
                );
                const [lx, ly] = project(
                  c.land_centroid_x,
                  c.land_centroid_y,
                );
                const isHover = hoverId === c.cluster_id;
                return (
                  <g
                    key={c.cluster_id}
                    onMouseEnter={() => setHoverId(c.cluster_id)}
                    onMouseLeave={() => setHoverId(null)}
                    style={{ cursor: "pointer" }}
                  >
                    <line
                      x1={tx}
                      y1={ty}
                      x2={lx}
                      y2={ly}
                      stroke={color}
                      strokeWidth={isHover ? 3 : 1.5}
                      opacity={isHover ? 0.95 : 0.55}
                      strokeDasharray="4 3"
                    />
                    {/* Throw position (small dot) */}
                    <circle
                      cx={tx}
                      cy={ty}
                      r={isHover ? 5 : 3}
                      fill={color}
                      opacity={isHover ? 1 : 0.8}
                      stroke="#000"
                      strokeWidth={0.8}
                    />
                    {/* Landing (bigger, hollow-ish) */}
                    <circle
                      cx={lx}
                      cy={ly}
                      r={isHover ? 8 : 5}
                      fill={color}
                      opacity={isHover ? 0.9 : 0.5}
                      stroke="#000"
                      strokeWidth={1}
                    />
                  </g>
                );
              })}
            </svg>
          )}

          {/* Hover card */}
          {hoverLineup && (
            <div className="absolute bottom-3 left-3 hud-panel p-3 text-xs space-y-1 shadow-xl max-w-xs">
              <p className="font-semibold text-white">
                #{hoverLineup.ranking.rank}{" "}
                {hoverLineup.ranking.cluster.label ??
                  `Cluster ${hoverLineup.ranking.cluster.cluster_id}`}
              </p>
              <p className="text-gray-400">
                Win rate:{" "}
                <span className="text-cs2-green font-mono">
                  {(
                    hoverLineup.ranking.cluster.round_win_rate * 100
                  ).toFixed(1)}
                  %
                </span>
                {"   "}
                Throws:{" "}
                <span className="text-cs2-blue font-mono">
                  {hoverLineup.ranking.cluster.throw_count}
                </span>
              </p>
              <p className="text-gray-400">
                Avg UD:{" "}
                <span className="text-cs2-red font-mono">
                  {hoverLineup.ranking.cluster.avg_utility_damage.toFixed(1)}
                </span>
                {"   "}
                Impact:{" "}
                <span className="text-cs2-accent font-mono">
                  {hoverLineup.ranking.impact_score.toFixed(3)}
                </span>
              </p>
              <p className="text-gray-500 text-[10px] capitalize">
                {hoverLineup.type.replace("grenade", "")}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-cs2-border text-[10px] text-gray-600 font-mono">
          small dot = throw position &middot; big dot = landing &middot;
          dashed line connects them &middot; radar via awpy
        </div>
      </div>
    </div>
  );
}
