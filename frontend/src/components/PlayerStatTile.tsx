interface Props {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}

export default function PlayerStatTile({ label, value, sub, color }: Props) {
  return (
    <div className="hud-panel p-3 flex flex-col gap-0.5">
      <span className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">
        {label}
      </span>
      <span
        className="text-2xl font-bold font-mono"
        style={{ color: color ?? "#ffffff" }}
      >
        {value}
      </span>
      {sub && <span className="text-[10px] text-cs2-muted">{sub}</span>}
    </div>
  );
}
