/**
 * HeatmapPanel — position density, death location, and grenade landing heatmaps.
 * Uses a canvas overlay on the radar image with gaussian-blur additive blending.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MatchTimeline, RadarInfo } from "../api/client";
import Select from "./Select";

interface Props {
  timeline: MatchTimeline;
  radar: RadarInfo | null;
}

const RADAR_PX = 1024;
type HeatmapMode = "positions" | "deaths" | "grenades";

/** Convert world coordinates to radar pixel coordinates. */
const toRadar = (
  wx: number,
  wy: number,
  radar: RadarInfo,
): { x: number; y: number } => ({
  x: (wx - radar.pos_x) / radar.scale,
  y: (radar.pos_y - wy) / radar.scale,
});

/** Jet-like colormap: intensity 0–255 → RGBA. */
const intensityToColor = (v: number): [number, number, number, number] => {
  if (v === 0) return [0, 0, 0, 0];
  const t = v / 255;
  // Blue → Cyan → Green → Yellow → Red
  let r = 0, g = 0, b = 0;
  if (t < 0.25) {
    b = 255;
    g = Math.round(t * 4 * 255);
  } else if (t < 0.5) {
    g = 255;
    b = Math.round((1 - (t - 0.25) * 4) * 255);
  } else if (t < 0.75) {
    g = 255;
    r = Math.round((t - 0.5) * 4 * 255);
  } else {
    r = 255;
    g = Math.round((1 - (t - 0.75) * 4) * 255);
  }
  const a = Math.min(255, Math.round(t * 400)); // fade in alpha
  return [r, g, b, a];
};

type RoundTimeFilter = "full" | "first15" | "first30" | "last15";

export default function HeatmapPanel({ timeline, radar }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<HeatmapMode>("positions");
  const [teamFilter, setTeamFilter] = useState<"all" | 2 | 3>("all");
  const [halfFilter, setHalfFilter] = useState<"all" | "first" | "second">("all");
  const [selectedPlayer, setSelectedPlayer] = useState<string>("all");
  const [roundTime, setRoundTime] = useState<RoundTimeFilter>("first30");

  // Determine round range based on half filter
  const roundRange = useMemo(() => {
    const total = timeline.rounds.length;
    const half = Math.ceil(total / 2);
    if (halfFilter === "first") return { start: 1, end: half };
    if (halfFilter === "second") return { start: half + 1, end: total };
    return { start: 1, end: total };
  }, [timeline, halfFilter]);

  // Get ticks for the selected round range
  const tickRange = useMemo(() => {
    const startRound = timeline.rounds.find((r) => r.num === roundRange.start);
    const endRound = timeline.rounds.find((r) => r.num === roundRange.end);
    return {
      start: startRound?.start_tick ?? 0,
      end: endRound?.end_tick ?? timeline.tick_max,
    };
  }, [timeline, roundRange]);

  // Compute data points based on mode
  const points = useMemo(() => {
    if (!radar) return [];
    const pts: { x: number; y: number }[] = [];

    if (mode === "positions") {
      // Build per-round tick windows based on roundTime filter
      const roundWindows: { start: number; end: number }[] = [];
      for (const r of timeline.rounds) {
        if (r.num < roundRange.start || r.num > roundRange.end) continue;
        let winStart = r.start_tick;
        let winEnd = r.end_tick;
        if (roundTime === "first15") winEnd = Math.min(r.end_tick, r.start_tick + 15 * 64);
        else if (roundTime === "first30") winEnd = Math.min(r.end_tick, r.start_tick + 30 * 64);
        else if (roundTime === "last15") winStart = Math.max(r.start_tick, r.end_tick - 15 * 64);
        roundWindows.push({ start: winStart, end: winEnd });
      }

      // Sample every 4th position (~0.5s intervals) — enough for density variation
      const SKIP = 4;

      for (const p of timeline.players) {
        if (selectedPlayer !== "all" && p.steamid !== selectedPlayer) continue;
        const samples = timeline.positions[p.steamid] ?? [];
        let skipCount = 0;
        for (const s of samples) {
          if (!s.alive) continue;
          const inWindow = roundWindows.some((w) => s.t >= w.start && s.t <= w.end);
          if (!inWindow) continue;
          const team = s.tn ?? p.team_num;
          if (teamFilter !== "all" && team !== teamFilter) continue;
          skipCount++;
          if (skipCount % SKIP !== 0) continue;
          const rp = toRadar(s.x, s.y, radar);
          if (rp.x >= 0 && rp.x <= RADAR_PX && rp.y >= 0 && rp.y <= RADAR_PX) {
            pts.push(rp);
          }
        }
      }
      // Decimate if over limit
      const MAX_POINTS = 15000;
      if (pts.length > MAX_POINTS) {
        const step = Math.ceil(pts.length / MAX_POINTS);
        return pts.filter((_, i) => i % step === 0);
      }
    } else if (mode === "deaths") {
      // Get death positions from events
      for (const evt of timeline.events) {
        if (evt.type !== "death") continue;
        if (evt.tick < tickRange.start || evt.tick > tickRange.end) continue;
        const victimSid = evt.data.victim;
        if (selectedPlayer !== "all" && victimSid !== selectedPlayer) continue;
        // Get victim position from their position samples at the death tick
        const samples = timeline.positions[victimSid];
        if (!samples) continue;
        // Find nearest sample
        let nearest = samples[0];
        let bestDist = Math.abs(samples[0].t - evt.tick);
        for (const s of samples) {
          const d = Math.abs(s.t - evt.tick);
          if (d < bestDist) { bestDist = d; nearest = s; }
          if (s.t > evt.tick) break;
        }
        if (!nearest) continue;
        const team = nearest.tn ?? 0;
        if (teamFilter !== "all" && team !== teamFilter) continue;
        const rp = toRadar(nearest.x, nearest.y, radar);
        if (rp.x >= 0 && rp.x <= RADAR_PX && rp.y >= 0 && rp.y <= RADAR_PX) {
          pts.push(rp);
        }
      }
    } else if (mode === "grenades") {
      for (const g of timeline.grenades) {
        if (selectedPlayer !== "all" && g.thrower !== selectedPlayer) continue;
        // Use last point of trajectory as landing/detonate position
        const lastPt = g.points[g.points.length - 1];
        if (!lastPt) continue;
        const tick = lastPt[0];
        if (tick < tickRange.start || tick > tickRange.end) continue;
        // Filter by thrower's side (T/CT) if team filter is set
        if (teamFilter !== "all") {
          const throwerSamples = timeline.positions[g.thrower];
          if (throwerSamples) {
            // Find thrower's team_num near the throw tick
            let nearest = throwerSamples[0];
            for (const s of throwerSamples) {
              if (Math.abs(s.t - tick) < Math.abs(nearest.t - tick)) nearest = s;
              if (s.t > tick) break;
            }
            const throwerTeam = nearest?.tn ?? 0;
            if (throwerTeam !== teamFilter) continue;
          }
        }
        const rp = toRadar(lastPt[1], lastPt[2], radar);
        if (rp.x >= 0 && rp.x <= RADAR_PX && rp.y >= 0 && rp.y <= RADAR_PX) {
          pts.push(rp);
        }
      }
    }

    return pts;
  }, [timeline, radar, mode, teamFilter, halfFilter, selectedPlayer, tickRange, roundTime]);

  // Draw heatmap on canvas
  const drawHeatmap = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Step 1: Draw intensity map (grayscale, additive)
    ctx.clearRect(0, 0, RADAR_PX, RADAR_PX);

    if (points.length === 0) return;

    // Create offscreen canvas for intensity accumulation
    const off = document.createElement("canvas");
    off.width = RADAR_PX;
    off.height = RADAR_PX;
    const offCtx = off.getContext("2d")!;
    offCtx.clearRect(0, 0, RADAR_PX, RADAR_PX);
    offCtx.globalCompositeOperation = "lighter";

    // Scale radius + alpha based on point count for readable heatmaps
    const n = points.length;
    const radius = n < 200 ? 16 : n < 2000 ? 12 : 8;
    const alpha = Math.max(0.005, Math.min(0.08, 2 / Math.sqrt(n)));

    for (const p of points) {
      const gradient = offCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      gradient.addColorStop(0.5, `rgba(255, 255, 255, ${alpha * 0.3})`);
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      offCtx.fillStyle = gradient;
      offCtx.beginPath();
      offCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      offCtx.fill();
    }

    // Step 2: Read intensity and apply colormap with percentile normalization
    const imageData = offCtx.getImageData(0, 0, RADAR_PX, RADAR_PX);
    const data = imageData.data;
    const output = ctx.createImageData(RADAR_PX, RADAR_PX);

    // Use 98th percentile as max so outliers don't flatten everything
    const intensities: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 0) intensities.push(data[i]);
    }
    if (intensities.length === 0) return;
    intensities.sort((a, b) => a - b);
    const maxIntensity = intensities[Math.min(intensities.length - 1, Math.floor(intensities.length * 0.98))] || 1;

    for (let i = 0; i < data.length; i += 4) {
      const normalized = Math.min(255, Math.round((data[i] / maxIntensity) * 255));
      const [r, g, b, a] = intensityToColor(normalized);
      output.data[i] = r;
      output.data[i + 1] = g;
      output.data[i + 2] = b;
      output.data[i + 3] = a;
    }

    ctx.putImageData(output, 0, 0);
  }, [points]);

  useEffect(() => {
    drawHeatmap();
  }, [drawHeatmap]);

  return (
    <div className="h-full flex gap-4 p-4 overflow-hidden">
      {/* Radar + canvas overlay */}
      <div className="flex-1 min-w-0 flex items-center justify-center">
        <div className="relative" style={{ width: "min(100%, 80vh)", aspectRatio: "1" }}>
          {radar && (
            <img
              src={radar.image_url}
              alt="Radar"
              className="absolute inset-0 w-full h-full object-contain rounded-lg"
              style={{ imageRendering: "auto" }}
            />
          )}
          <canvas
            ref={canvasRef}
            width={RADAR_PX}
            height={RADAR_PX}
            className="absolute inset-0 w-full h-full rounded-lg"
            style={{ mixBlendMode: "screen" }}
          />
          {points.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-cs2-muted text-sm bg-black/60 px-3 py-1.5 rounded">
                No data for current filters
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Controls panel */}
      <div className="w-64 shrink-0 flex flex-col gap-3 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
        <div className="hud-panel p-3 space-y-3">
          <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">Mode</h3>
          <div className="flex flex-col gap-1">
            {([
              { id: "positions" as const, label: "Position Density" },
              { id: "deaths" as const, label: "Death Locations" },
              { id: "grenades" as const, label: "Grenade Landings" },
            ]).map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`text-xs text-left px-2 py-1.5 rounded transition-all ${
                  mode === m.id
                    ? "bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/40"
                    : "text-cs2-muted hover:text-white border border-transparent hover:bg-cs2-border/20"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {mode !== "grenades" && (
          <div className="hud-panel p-3 space-y-3">
            <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">Half</h3>
            <div className="flex gap-1">
              {(["all", "first", "second"] as const).map((h) => (
                <button
                  key={h}
                  onClick={() => setHalfFilter(h)}
                  className={`flex-1 text-[10px] px-2 py-1 rounded font-semibold ${
                    halfFilter === h
                      ? "bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/40"
                      : "hud-btn"
                  }`}
                >
                  {h === "all" ? "All" : h === "first" ? "1st" : "2nd"}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "positions" && (
          <div className="hud-panel p-3 space-y-3">
            <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">Round Time</h3>
            <div className="grid grid-cols-2 gap-1">
              {([
                { id: "first15" as const, label: "First 15s" },
                { id: "first30" as const, label: "First 30s" },
                { id: "last15" as const, label: "Last 15s" },
                { id: "full" as const, label: "Full Round" },
              ]).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setRoundTime(t.id)}
                  className={`text-[10px] px-2 py-1 rounded font-semibold ${
                    roundTime === t.id
                      ? "bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/40"
                      : "hud-btn"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-cs2-muted/60">
              {roundTime === "first15" ? "Shows default setups" :
               roundTime === "first30" ? "Shows early-round positions" :
               roundTime === "last15" ? "Shows late-round/retake positions" :
               "All positions (less distinct patterns)"}
            </p>
          </div>
        )}

        <div className="hud-panel p-3 space-y-3">
          <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">Team</h3>
          <div className="flex gap-1">
            {([
              { id: "all" as const, label: "Both" },
              { id: 2 as const, label: "T" },
              { id: 3 as const, label: "CT" },
            ]).map((t) => (
              <button
                key={String(t.id)}
                onClick={() => setTeamFilter(t.id)}
                className={`flex-1 text-[10px] px-2 py-1 rounded font-semibold ${
                  teamFilter === t.id
                    ? "bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/40"
                    : "hud-btn"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="hud-panel p-3 space-y-3">
          <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">Player</h3>
          <Select
            value={selectedPlayer}
            onChange={setSelectedPlayer}
            className="w-full"
            options={[
              { value: "all", label: "All Players" },
              ...timeline.players.map((p) => ({ value: p.steamid, label: p.name })),
            ]}
          />
        </div>

        <div className="hud-panel p-3">
          <p className="text-[10px] text-cs2-muted">
            {points.length.toLocaleString()} data points
          </p>
        </div>
      </div>
    </div>
  );
}
