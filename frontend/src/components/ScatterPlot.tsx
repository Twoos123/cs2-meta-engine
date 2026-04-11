/**
 * ScatterPlot — "Usage vs Win Rate" chart.
 *
 * X-axis: throw_count (usage frequency)
 * Y-axis: round_win_rate (0–100%)
 * Dot size: avg_utility_damage
 * Dot colour: grenade type
 *
 * Clicking a dot highlights that lineup in the parent.
 */
import React from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import { LineupRanking } from "../api/client";

const GRENADE_DOT_COLOR: Record<string, string> = {
  smokegrenade: "#94a3b8",
  flashbang: "#fbbf24",
  hegrenade: "#f87171",
  molotov: "#fb923c",
  decoy: "#6b7280",
};

interface Props {
  lineups: LineupRanking[];
  selectedId?: number;
  onSelect?: (clusterId: number) => void;
}

interface TooltipPayload {
  payload: {
    name: string;
    throw_count: number;
    win_rate: number;
    avg_ud: number;
    grenade_type: string;
    cluster_id: number;
  };
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  return (
    <div className="bg-cs2-card border border-cs2-border rounded-lg p-3 text-xs space-y-1 shadow-xl">
      <p className="font-semibold text-white">{d.name}</p>
      <p className="text-gray-400">
        Throws:{" "}
        <span className="text-cs2-blue font-mono">{d.throw_count}</span>
      </p>
      <p className="text-gray-400">
        Win Rate:{" "}
        <span className="text-cs2-green font-mono">
          {(d.win_rate * 100).toFixed(1)}%
        </span>
      </p>
      <p className="text-gray-400">
        Avg UD:{" "}
        <span className="text-cs2-red font-mono">{d.avg_ud.toFixed(1)} HP</span>
      </p>
    </div>
  );
};

export default function ScatterPlot({ lineups, selectedId, onSelect }: Props) {
  const data = lineups.map((r) => ({
    cluster_id: r.cluster.cluster_id,
    name: r.cluster.label ?? `Cluster ${r.cluster.cluster_id}`,
    throw_count: r.cluster.throw_count,
    win_rate: r.cluster.round_win_rate,
    avg_ud: r.cluster.avg_utility_damage,
    grenade_type: r.cluster.grenade_type,
  }));

  const maxCount = Math.max(...data.map((d) => d.throw_count), 1);

  return (
    <div className="hud-panel p-4">
      <div className="flex items-baseline gap-3 mb-4">
        <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">
          / chart
        </p>
        <h3 className="text-sm font-semibold text-white">Usage vs Win Rate</h3>
        <span className="text-[10px] text-cs2-muted ml-auto font-mono">
          dot size = utility damage
        </span>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
          <XAxis
            type="number"
            dataKey="throw_count"
            name="Throw Count"
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            label={{
              value: "Usage (Throws)",
              position: "insideBottom",
              offset: -10,
              fill: "#6b7280",
              fontSize: 11,
            }}
          />
          <YAxis
            type="number"
            dataKey="win_rate"
            name="Win Rate"
            domain={[0, 1]}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            label={{
              value: "Round Win Rate",
              angle: -90,
              position: "insideLeft",
              fill: "#6b7280",
              fontSize: 11,
            }}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "#2a2d3a44" }} />
          <ReferenceLine
            y={0.5}
            stroke="#4ade80"
            strokeDasharray="4 4"
            strokeOpacity={0.4}
          />
          <Scatter
            data={data}
            onClick={(d) => onSelect?.(d.cluster_id)}
            style={{ cursor: "pointer" }}
          >
            {data.map((entry) => {
              const isSelected = entry.cluster_id === selectedId;
              const baseColor =
                GRENADE_DOT_COLOR[entry.grenade_type] ?? "#94a3b8";
              const r = 4 + Math.min(entry.avg_ud / 10, 12);
              return (
                <Cell
                  key={entry.cluster_id}
                  fill={baseColor}
                  opacity={isSelected ? 1 : 0.65}
                  stroke={isSelected ? "#f0a500" : "transparent"}
                  strokeWidth={isSelected ? 2 : 0}
                  r={r}
                />
              );
            })}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
