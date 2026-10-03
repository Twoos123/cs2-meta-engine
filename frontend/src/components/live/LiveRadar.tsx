/**
 * LiveRadar — 1024×1024 SVG radar fed by GSI state.
 *
 * Positions are projected with the awpy calibration from /api/radars/{map}:
 *   px = (x - pos_x) / scale,  py = (pos_y - y) / scale
 * Two-level maps (Nuke, Vertigo) render an Upper and a Lower radar, splitting
 * players / bomb / grenades by z at the map's lower_level_max_units.
 * Movement between updates is smoothed with CSS transitions on each player
 * group (GSI sends ~10 updates/s), and facing angles are unwrapped so the
 * arrow never spins the long way round across ±180°.
 */
import { useRef, useState } from "react";
import type { RadarInfo } from "../../api/client";
import type { GsiGrenade, GsiPlayer, GsiState } from "../../api/gsi";
import { UTILITY_COLORS, hpColor, prettyMap, teamColor } from "./liveUtils";

const SIZE = 1024;
const SMOKE_RADIUS_U = 144;
const FLAME_RADIUS_U = 48;
const MOVE_MS = 140;

interface Props {
  state: GsiState;
  radar: RadarInfo | null;
  radarMissing: boolean;
  stale: boolean;
}

export default function LiveRadar({ state, radar, radarMissing, stale }: Props) {
  const yawRef = useRef(new Map<string, number>());

  /** Unwrapped screen rotation for a player's facing arrow. */
  const facing = (p: GsiPlayer): number | null => {
    if (p.yaw == null) return null;
    const target = -p.yaw; // world CCW → screen (y down) CW
    const prev = yawRef.current.get(p.steamid);
    let out = target;
    if (prev != null) {
      const delta = ((((target - prev) % 360) + 540) % 360) - 180;
      out = prev + delta;
    }
    yawRef.current.set(p.steamid, out);
    return out;
  };

  // Two-level maps (Nuke, Vertigo): the backend supplies a second overview
  // and the z below which things belong on it. Each level gets its own
  // radar so a player in Nuke's ramp isn't drawn on top of outside.
  const lowerZ = radar?.lower_level_max_units ?? null;
  const twoLevel = radar != null && lowerZ != null && !!radar.lower_image_url;
  const isLower = (z: number | null | undefined) => twoLevel && z != null && z <= (lowerZ as number);

  if (!twoLevel) {
    return (
      <RadarLayer state={state} radar={radar} imageUrl={radar?.image_url ?? null}
        include={() => true} facing={facing} radarMissing={radarMissing} stale={stale} />
    );
  }
  const lowerCount = state.players.filter((p) => p.alive && isLower(p.z)).length;
  const upperCount = state.players.filter((p) => p.alive && !isLower(p.z)).length;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <RadarLayer state={state} radar={radar} imageUrl={radar.image_url}
        include={(z) => !isLower(z)} facing={facing} radarMissing={radarMissing} stale={stale}
        label={`Upper · ${upperCount}`} />
      <RadarLayer state={state} radar={radar} imageUrl={radar.lower_image_url ?? null}
        include={(z) => isLower(z)} facing={facing} radarMissing={radarMissing} stale={stale}
        label={`Lower · ${lowerCount}`} hideNotes />
    </div>
  );
}

interface LayerProps {
  state: GsiState;
  radar: RadarInfo | null;
  imageUrl: string | null;
  /** Which z-heights belong on this layer. */
  include: (z: number | null | undefined) => boolean;
  facing: (p: GsiPlayer) => number | null;
  radarMissing: boolean;
  stale: boolean;
  label?: string;
  /** Only one layer shows the "playing mode" / missing-radar notes. */
  hideNotes?: boolean;
}

function RadarLayer({ state, radar, imageUrl, include, facing, radarMissing, stale, label, hideNotes }: LayerProps) {
  const [imgFailed, setImgFailed] = useState(false);

  const project = (x: number | null, y: number | null): [number, number] | null => {
    if (!radar || x == null || y == null) return null;
    return [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale];
  };

  const scale = radar?.scale ?? 5;
  const playing = state.mode === "playing";
  const self = playing ? state.players[0] : undefined;
  const bomb = state.bomb;
  const bombPos = bomb && bomb.state !== "carried" && include(bomb.z) ? project(bomb.x, bomb.y) : null;
  const onLayer = state.players.filter((p) => include(p.z));
  const dead = onLayer.filter((p) => !p.alive);
  const alive = onLayer.filter((p) => p.alive);
  // Observed player last so it draws on top.
  alive.sort((a, b) => Number(a.observed) - Number(b.observed));
  const grenades = state.grenades.filter((g) =>
    include(g.z ?? (g.flames.length ? g.flames[0][2] : null)),
  );

  return (
    <div className="relative w-full aspect-square overflow-hidden rounded-xl bg-[#070a12] border border-white/5">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={`absolute inset-0 w-full h-full transition-opacity duration-500 ${stale ? "opacity-60" : ""}`}
        role="img"
        aria-label={`Live radar of ${prettyMap(state.map)}${label ? ` (${label})` : ""}`}
      >
        <defs>
          <pattern id="live-grid" width="64" height="64" patternUnits="userSpaceOnUse">
            <path d="M 64 0 L 0 0 0 64" fill="none" stroke="rgba(34,211,238,0.06)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={SIZE} height={SIZE} fill="url(#live-grid)" />
        {imageUrl && !imgFailed && (
          <image
            href={imageUrl}
            x={0}
            y={0}
            width={SIZE}
            height={SIZE}
            onError={() => setImgFailed(true)}
            opacity={0.92}
          />
        )}

        {/* Grenades */}
        {grenades.map((g) => (
          <Grenade key={g.id} g={g} project={project} scale={scale} />
        ))}

        {/* Dropped / planted bomb */}
        {bombPos && (
          <g transform={`translate(${bombPos[0]} ${bombPos[1]})`}>
            {(bomb?.state === "planted" || bomb?.state === "defusing") && (
              <circle r={26} fill="none" stroke="#f87171" strokeWidth={3} className="animate-pulse" />
            )}
            <rect x={-11} y={-8} width={22} height={16} rx={3}
              fill={bomb?.state === "defused" ? "#5B9BD5" : "#ef4444"} stroke="#0b0f19" strokeWidth={2} />
            <text y={4.5} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff"
              fontFamily="JetBrains Mono, monospace">C4</text>
          </g>
        )}

        {/* Dead players: faded X where they fell */}
        {dead.map((p) => {
          const pos = project(p.x, p.y);
          if (!pos) return null;
          const c = teamColor(p.team);
          return (
            <g key={p.steamid} transform={`translate(${pos[0]} ${pos[1]})`} opacity={0.55}>
              <path d="M -8 -8 L 8 8 M 8 -8 L -8 8" stroke={c} strokeWidth={4} strokeLinecap="round" />
            </g>
          );
        })}

        {/* Alive players */}
        {alive.map((p) => {
          const pos = project(p.x, p.y);
          if (!pos) return null;
          return <PlayerDot key={p.steamid} p={p} pos={pos} rot={facing(p)} />;
        })}
      </svg>

      {label && (
        <div className="pointer-events-none absolute top-3 left-3 text-[10px] font-semibold tracking-[0.18em] uppercase text-gray-200 bg-black/55 rounded-md px-2 py-1">
          {label}
        </div>
      )}

      {!hideNotes && (radarMissing || imgFailed) && (
        <div className="absolute top-3 left-3 right-3 text-[11px] text-cs2-muted bg-black/50 rounded-lg px-3 py-2">
          No radar image for <span className="font-mono text-gray-300">{state.map ?? "this map"}</span>
          {radarMissing ? " — positions can't be projected." : "."}
        </div>
      )}

      {!hideNotes && playing && (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 text-[11px] leading-snug text-gray-300 bg-black/60 backdrop-blur rounded-lg px-3 py-2">
          {self && self.x == null
            ? "Playing: CS2 isn't sending your position. "
            : "Playing: CS2 only sends your own data. "}
          Spectate, use GOTV or watch a demo to see all 10 players.
        </div>
      )}
    </div>
  );
}

function PlayerDot({ p, pos, rot }: { p: GsiPlayer; pos: [number, number]; rot: number | null }) {
  const c = teamColor(p.team);
  const frac = Math.max(0, Math.min(1, p.hp / 100));
  const ringR = 16;
  const circ = 2 * Math.PI * ringR;
  const flash = Math.min(1, p.flashed / 255);
  return (
    <g
      style={{
        transform: `translate(${pos[0]}px, ${pos[1]}px)`,
        transition: `transform ${MOVE_MS}ms linear`,
      }}
    >
      {p.observed && (
        <circle r={27} fill="rgba(34,211,238,0.12)" stroke="#22d3ee" strokeWidth={2.5} className="animate-pulse" />
      )}
      {rot != null && (
        <g style={{ transform: `rotate(${rot}deg)`, transition: `transform ${MOVE_MS}ms linear` }}>
          <path d="M 17 -7 L 30 0 L 17 7 Z" fill={c} stroke="#0b0f19" strokeWidth={1.5} />
        </g>
      )}
      {/* HP ring — neutral so the team colour stays dominant, red when low */}
      <circle r={ringR} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3.5} />
      <circle
        r={ringR}
        fill="none"
        stroke={p.hp > 25 ? "#f1f5f9" : hpColor(p.hp)}
        strokeWidth={3.5}
        strokeDasharray={`${frac * circ} ${circ}`}
        transform="rotate(-90)"
        style={{ transition: "stroke-dasharray 300ms ease" }}
      />
      <circle r={11.5} fill={c} stroke="#0b0f19" strokeWidth={2} />
      {flash > 0 && <circle r={11.5} fill="#ffffff" opacity={flash * 0.85} />}
      {p.observer_slot != null && (
        <text y={4.5} textAnchor="middle" fontSize={13} fontWeight={700} fill="#0b0f19"
          fontFamily="JetBrains Mono, monospace">
          {p.observer_slot}
        </text>
      )}
      {p.has_bomb && (
        <g transform="translate(13 -17)">
          <rect x={-7} y={-5} width={14} height={10} rx={2} fill="#ef4444" stroke="#0b0f19" strokeWidth={1.5} />
        </g>
      )}
      <text
        y={-25}
        textAnchor="middle"
        fontSize={p.observed ? 17 : 15}
        fontWeight={p.observed ? 700 : 600}
        fill={p.observed ? "#ecfeff" : "#e5e7eb"}
        stroke="#05070d"
        strokeWidth={4}
        paintOrder="stroke"
        style={{ pointerEvents: "none" }}
      >
        {p.name}
      </text>
    </g>
  );
}

function Grenade({
  g,
  project,
  scale,
}: {
  g: GsiGrenade;
  project: (x: number | null, y: number | null) => [number, number] | null;
  scale: number;
}) {
  const color = UTILITY_COLORS[g.type] ?? "#e5e7eb";
  if (g.type === "inferno") {
    return (
      <g>
        {g.flames.map((f, i) => {
          const pos = project(f[0], f[1]);
          return pos ? (
            <circle key={i} cx={pos[0]} cy={pos[1]} r={FLAME_RADIUS_U / scale}
              fill={color} opacity={0.35} />
          ) : null;
        })}
      </g>
    );
  }
  const pos = project(g.x, g.y);
  if (!pos) return null;
  if (g.type === "smoke" && (g.effecttime ?? 0) > 0) {
    return (
      <circle cx={pos[0]} cy={pos[1]} r={SMOKE_RADIUS_U / scale}
        fill={color} fillOpacity={0.4} stroke={color} strokeOpacity={0.7} strokeWidth={2} />
    );
  }
  return (
    <circle cx={pos[0]} cy={pos[1]} r={5} fill={color} stroke="#0b0f19" strokeWidth={1.5}
      style={{ transition: `cx ${MOVE_MS}ms linear, cy ${MOVE_MS}ms linear` }} />
  );
}
