/**
 * Lightweight SVG radar chart for a player's role profile.
 * Five axes, normalized 0-1. No charting library.
 */

interface Axis {
  label: string;
  value: number;   // 0-1
}

interface Props {
  axes: Axis[];
  size?: number;
  color?: string;
}

const RINGS = 4;

export default function PlayerRoleRadar({ axes, size = 220, color = "#22d3ee" }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  // Extra padding so long axis labels (e.g. "SURVIVAL") aren't clipped at
  // the SVG edges. Previously 28 px wasn't enough to fit a 48 px wide word.
  const r = size / 2 - 44;

  const pointAt = (i: number, t: number) => {
    const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    return [cx + Math.cos(angle) * r * t, cy + Math.sin(angle) * r * t] as const;
  };

  const polygon = axes
    .map((a, i) => {
      const [x, y] = pointAt(i, Math.max(0, Math.min(1, a.value)));
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} overflow="visible">
      {/* Concentric rings */}
      {Array.from({ length: RINGS }, (_, i) => {
        const t = (i + 1) / RINGS;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r * t}
            fill="none"
            stroke="rgba(100,116,139,0.2)"
            strokeWidth={1}
          />
        );
      })}

      {/* Axis spokes */}
      {axes.map((_, i) => {
        const [x, y] = pointAt(i, 1);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="rgba(100,116,139,0.25)"
            strokeWidth={1}
          />
        );
      })}

      {/* Data polygon */}
      <polygon
        points={polygon}
        fill={`${color}33`}
        stroke={color}
        strokeWidth={1.5}
      />

      {/* Vertex dots */}
      {axes.map((a, i) => {
        const [x, y] = pointAt(i, Math.max(0, Math.min(1, a.value)));
        return <circle key={i} cx={x} cy={y} r={3} fill={color} />;
      })}

      {/* Axis labels — placed well outside the outer ring so the filled
          polygon never blends into them even when a stat reaches 100%. */}
      {axes.map((a, i) => {
        const [x, y] = pointAt(i, 1.38);
        return (
          <text
            key={i}
            x={x}
            y={y}
            fontSize={10}
            fill="#94a3b8"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}
