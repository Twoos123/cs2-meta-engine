/** LiveMatchBar — map, score, round, phase timer and feed freshness. */
import type { GsiState } from "../../api/gsi";
import { CT_COLOR, T_COLOR, fmtClock, phaseLabel, prettyMap } from "./liveUtils";

interface Props {
  state: GsiState;
  /** Seconds since CS2 sent this state (server age + time since we got it). */
  age: number;
  stale: boolean;
}

export default function LiveMatchBar({ state, age, stale }: Props) {
  const remaining = state.phase_ends_in != null ? state.phase_ends_in - age : null;
  const bombPhase = state.phase === "bomb" || state.phase === "defuse";
  const playing = state.mode === "playing";

  return (
    <div className="hud-panel px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-3 min-w-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
              playing
                ? "border-amber-300/40 text-amber-200 bg-amber-300/10"
                : "border-cyan-400/40 text-cyan-200 bg-cyan-400/10"
            }`}
          >
            {playing ? "Playing" : "Spectating"}
          </span>
          <span className="text-sm font-semibold text-white truncate">{prettyMap(state.map)}</span>
        </div>
        <div className="mt-1 text-[11px] text-cs2-muted font-mono truncate">
          {state.map ?? "—"}
          {state.game_mode ? ` · ${state.game_mode}` : ""}
        </div>
      </div>

      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs font-medium truncate max-w-[6.5rem] text-right" style={{ color: CT_COLOR }}>
          {state.ct?.name || "CT"}
        </span>
        <span className="font-mono text-2xl font-bold tabular-nums text-white whitespace-nowrap">
          <span style={{ color: CT_COLOR }}>{state.ct?.score ?? 0}</span>
          <span className="text-cs2-muted mx-1.5">:</span>
          <span style={{ color: T_COLOR }}>{state.t?.score ?? 0}</span>
        </span>
        <span className="text-xs font-medium truncate max-w-[6.5rem]" style={{ color: T_COLOR }}>
          {state.t?.name || "T"}
        </span>
      </div>

      <div className="flex items-center gap-4 sm:ml-auto">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-cs2-muted">
            Round {state.round ?? "—"}
          </div>
          <div className={`text-xs font-medium ${bombPhase ? "text-cs2-red" : "text-gray-300"}`}>
            {phaseLabel(state.phase)}
          </div>
        </div>
        <div
          className={`font-mono text-xl font-semibold tabular-nums ${
            bombPhase ? "text-cs2-red" : "text-white"
          }`}
          aria-label="Phase timer"
        >
          {fmtClock(remaining)}
        </div>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border whitespace-nowrap ${
            stale
              ? "border-amber-300/50 text-amber-200 bg-amber-300/10"
              : "border-emerald-400/40 text-emerald-300 bg-emerald-400/10"
          }`}
          title={`Last update ${age.toFixed(1)}s ago`}
        >
          {stale ? `Stale ${Math.floor(age)}s` : "Live"}
        </span>
      </div>
    </div>
  );
}
