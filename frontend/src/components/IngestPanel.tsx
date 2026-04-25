/**
 * IngestPanel — lets the user pull demos from HLTV and trigger the pipeline.
 */
import React, { useState } from "react";
import {
  getIngestionStatus,
  ingestFromHLTV,
  runPipeline,
  IngestionStatusResponse,
} from "../api/client";
import Select from "./Select";

interface Props {
  onComplete?: () => void;
}

// Poll the ingest status endpoint until the background task identified by
// `queuedRunId` finishes. The POST endpoints return a `run_id` synchronously
// — we wait until `last_completed_run_id >= queuedRunId`, which works even
// when the pipeline is so fast (empty demos, no-op filter) that the first
// 1.5-second poll misses the "running" phase entirely. Without this, fast
// runs would spin forever because the old loop waited to observe "running"
// before accepting "ready" as terminal.
async function pollUntilDone(
  queuedRunId: number,
  onStatus: (s: IngestionStatusResponse) => void,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const s = await getIngestionStatus();
      onStatus(s);
      if ((s.last_completed_run_id ?? 0) >= queuedRunId) return;
    } catch {
      // transient error — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for pipeline to finish");
}

export default function IngestPanel({ onComplete }: Props) {
  const [teamName, setTeamName] = useState("");
  const [eventName, setEventName] = useState("");
  const [mapName, setMapName] = useState("de_mirage");
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<IngestionStatusResponse | null>(null);

  const onTick = (s: IngestionStatusResponse) => {
    setMsg(s.status ?? "");
    setProgress(s);
  };

  const handleHLTV = async () => {
    setLoading(true);
    setMsg("Queueing HLTV ingest…");
    setProgress(null);
    try {
      const queued = await ingestFromHLTV({
        team_name: teamName || undefined,
        event_name: eventName || undefined,
        map_name: mapName || undefined,
        limit,
      });
      await pollUntilDone(queued.run_id, onTick);
      setMsg("Done — refreshing lineups");
      onComplete?.();
    } catch (e: any) {
      setMsg(e?.response?.data?.detail ?? e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRunPipeline = async () => {
    setLoading(true);
    setMsg("Starting pipeline…");
    setProgress(null);
    try {
      const queued = await runPipeline({
        map_name: mapName || undefined,
        clear_existing: true,
      });
      await pollUntilDone(queued.run_id, onTick);
      setMsg("Done — refreshing lineups");
      onComplete?.();
    } catch (e: any) {
      setMsg(e?.response?.data?.detail ?? e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="hud-panel p-5 space-y-4">
      <div>
        <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">
          / ingest
        </p>
        <h2 className="text-sm font-semibold text-white mt-0.5">
          Pull pro demos from HLTV
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-1 block">
            Team
          </label>
          <input
            className="hud-input w-full"
            placeholder="e.g. Navi"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-1 block">
            Event
          </label>
          <input
            className="hud-input w-full"
            placeholder="e.g. Major"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-1 block">
            Map
          </label>
          <Select
            value={mapName}
            onChange={setMapName}
            className="w-full"
            options={[
              "de_mirage",
              "de_dust2",
              "de_inferno",
              "de_nuke",
              "de_ancient",
              "de_anubis",
              "de_vertigo",
              "de_overpass",
              "de_train",
            ].map((m) => ({
              value: m,
              label: m,
              icon: `/icons/maps/${m}.png`,
            }))}
          />
        </div>
        <div>
          <label className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-1 block">
            # Matches
          </label>
          <input
            type="number"
            min={1}
            max={50}
            className="hud-input w-full"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleHLTV}
          disabled={loading}
          className="hud-btn-primary flex-1"
        >
          {loading ? "Working…" : "Fetch + Analyse"}
        </button>
        <button
          onClick={handleRunPipeline}
          disabled={loading}
          className="hud-btn flex-1"
        >
          Re-run
        </button>
      </div>

      {msg && (
        <p className="text-[11px] text-cs2-accent border-l-2 border-cs2-accent/60 bg-cs2-accent/5 pl-2 py-1 font-mono">
          {msg}
        </p>
      )}

      {progress && (
        <div className="hud-panel p-3 space-y-1.5 text-[11px] font-mono bg-[#0b1220]">
          <div className="text-[10px] text-cs2-muted uppercase tracking-[0.15em] mb-1">
            Ingest progress
          </div>
          <div className="flex justify-between">
            <span className="text-cs2-muted">Demos parsed (this run)</span>
            <span className="text-white">
              {progress.demos_parsed_this_run}
              {progress.demos_total_this_run > 0 && ` / ${progress.demos_total_this_run}`}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-cs2-muted">Player rows updated (this run)</span>
            <span className="text-white">{progress.player_rows_updated_this_run}</span>
          </div>
          <div className="h-px bg-cs2-border/30 my-1" />
          <div className="flex justify-between">
            <span className="text-cs2-muted">Demos on disk</span>
            <span className="text-white">{progress.total_demos}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-cs2-muted">Grenade lineups in DB</span>
            <span className="text-white">{progress.total_grenades}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-cs2-muted">Player rows total</span>
            <span className="text-white">{progress.total_player_rows}</span>
          </div>
        </div>
      )}

      <p className="text-[10px] text-cs2-muted leading-relaxed">
        Downloads demos from HLTV, parses full timelines (positions, kills,
        utility damage, player aggregates) and buckets identical throws — all
        in the background. Lineups DB is grenade-only; everything else lives
        in per-demo timeline caches and the player_stats table.
      </p>
    </div>
  );
}
