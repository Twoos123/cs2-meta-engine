/** LiveScoreboard — per-team player rows (HP, armor, money, weapon, K/D). */
import type { GsiPlayer, GsiState, GsiTeamSide } from "../../api/gsi";
import { UTILITY_COLORS, fmtMoney, hpColor, teamColor, weaponLabel } from "./liveUtils";

export default function LiveScoreboard({ state }: { state: GsiState }) {
  const sides: GsiTeamSide[] = ["CT", "T"];
  const unassigned = state.players.filter((p) => p.team !== "CT" && p.team !== "T");
  const playing = state.mode === "playing";

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {sides.map((side) => {
        const players = state.players.filter((p) => p.team === side);
        if (playing && players.length === 0) return null;
        const team = side === "CT" ? state.ct : state.t;
        const alive = players.filter((p) => p.alive).length;
        return (
          <section key={side} className="hud-panel p-3 min-w-0">
            <header className="flex items-center gap-2 px-1 pb-2 mb-1 border-b border-white/5">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: teamColor(side) }} />
              <span className="text-xs font-semibold tracking-wide truncate" style={{ color: teamColor(side) }}>
                {team?.name || (side === "CT" ? "Counter-Terrorists" : "Terrorists")}
              </span>
              {!playing && (
                <span className="ml-auto text-[11px] font-mono text-cs2-muted shrink-0">
                  {alive}/{players.length} alive
                </span>
              )}
            </header>
            {players.length === 0 ? (
              <p className="px-1 py-2 text-xs text-cs2-muted">No players</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {players.map((p) => (
                  <PlayerRow key={p.steamid} p={p} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {unassigned.length > 0 && (
        <section className="hud-panel p-3">
          <ul className="flex flex-col gap-1">
            {unassigned.map((p) => (
              <PlayerRow key={p.steamid} p={p} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PlayerRow({ p }: { p: GsiPlayer }) {
  const frac = Math.max(0, Math.min(1, p.hp / 100));
  return (
    <li
      className={`grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-1.5 py-1.5 ${
        p.observed ? "bg-cyan-400/10 ring-1 ring-cyan-400/40" : ""
      } ${p.alive ? "" : "opacity-45"}`}
    >
      <span className="text-sm font-bold font-mono text-right" style={{ color: p.alive ? hpColor(p.hp) : "#64748b" }}>
        {p.alive ? p.hp : "✕"}
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {p.observer_slot != null && (
            <span className="text-[10px] font-mono text-cs2-muted shrink-0">{p.observer_slot}</span>
          )}
          <span className={`text-[13px] truncate ${p.observed ? "text-cyan-100 font-semibold" : "text-gray-200"}`}>
            {p.name}
          </span>
          {p.is_self && <span className="text-[9px] uppercase tracking-wider text-cs2-accent shrink-0">you</span>}
          {p.has_bomb && (
            <span className="text-[9px] font-bold px-1 rounded bg-red-500/80 text-white shrink-0" title="Bomb">C4</span>
          )}
          {p.defuser && (
            <span className="text-[9px] font-bold px-1 rounded bg-sky-500/70 text-white shrink-0" title="Defuse kit">KIT</span>
          )}
        </div>
        <div className="mt-1 h-1 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${frac * 100}%`, background: hpColor(p.hp) }}
          />
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-cs2-muted min-w-0">
          <span className="truncate text-gray-300">{p.alive ? weaponLabel(p.active_weapon) : "Dead"}</span>
          {p.alive && p.ammo_clip != null && (
            <span className="font-mono shrink-0">
              {p.ammo_clip}/{p.ammo_reserve ?? 0}
            </span>
          )}
          {p.alive && p.utility.length > 0 && (
            <span className="flex items-center gap-0.5 shrink-0" title={p.utility.map(weaponLabel).join(", ")}>
              {p.utility.slice(0, 4).map((u, i) => (
                <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: UTILITY_COLORS[u] ?? "#e5e7eb" }} />
              ))}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col items-end gap-0.5 text-[11px] font-mono shrink-0">
        <span className="text-cs2-green">{fmtMoney(p.money)}</span>
        <span className="text-gray-400" title="Kills / deaths">
          {p.kills ?? "–"}/{p.deaths ?? "–"}
        </span>
        <span className="text-cs2-muted" title={p.helmet ? "Kevlar + helmet" : "Kevlar"}>
          {p.armor > 0 ? `${p.helmet ? "H" : "K"}${p.armor}` : "—"}
        </span>
      </div>
    </li>
  );
}
