import { useIngestStatus } from "../hooks/useIngestStatus";

/**
 * Persistent banner showing the state of the ingestion pipeline. Lives
 * at the top of the Ingest page so navigating away and coming back does
 * not lose visibility into a pipeline the user already kicked off.
 *
 * Renders nothing when idle — the tabs and forms below already convey
 * "nothing is happening" on their own. Surfaces a compact progress card
 * whenever a run is queued or actively parsing.
 */
export default function IngestStatusBanner() {
  const { status, isRunning } = useIngestStatus();

  if (!status || !isRunning) return null;

  const parsed = status.demos_parsed_this_run;
  const total = status.demos_total_this_run;
  const pct = total > 0 ? Math.min(100, Math.round((parsed / total) * 100)) : null;

  return (
    <div
      className="hud-panel p-5 relative overflow-hidden"
      style={{ borderColor: "rgba(34, 211, 238, 0.35)" }}
    >
      {/* Cyan top edge to read as "active" at a glance. */}
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.7) 50%, transparent 100%)",
        }}
      />
      <div className="flex items-start gap-4">
        <div className="shrink-0 w-9 h-9 rounded-full border border-cs2-accent/40 flex items-center justify-center">
          <div className="w-4 h-4 border-2 border-cs2-accent border-t-transparent rounded-full animate-spin" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-cs2-accent font-semibold">
              Pipeline running
            </span>
            <span className="text-[10px] font-mono text-cs2-muted">
              · run #{status.run_id}
            </span>
          </div>
          <p className="mt-1 text-sm text-white font-mono truncate">
            {status.status || "working…"}
          </p>

          {/* Progress row — only when the backend reports a known total. */}
          {pct !== null && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-[10px] font-mono text-cs2-muted mb-1.5">
                <span className="uppercase tracking-[0.18em]">Demos parsed</span>
                <span className="text-white">
                  {parsed} / {total}
                  <span className="text-cs2-muted"> · {pct}%</span>
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${pct}%`,
                    background: "linear-gradient(90deg, #22d3ee, #4ade80)",
                    boxShadow: "0 0 10px rgba(34,211,238,0.4)",
                  }}
                />
              </div>
            </div>
          )}

          {/* Aggregate totals — these tick up as parsing progresses. */}
          <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 text-[10px] font-mono">
            <Stat label="Player rows (run)" value={status.player_rows_updated_this_run} />
            <Stat label="Demos on disk" value={status.total_demos} />
            <Stat label="Grenade lineups" value={status.total_grenades} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-cs2-muted uppercase tracking-[0.14em] truncate">{label}</div>
      <div className="text-white mt-0.5">{value.toLocaleString()}</div>
    </div>
  );
}
