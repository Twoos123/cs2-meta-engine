import { useEffect, useRef, useState } from "react";
import { IngestionStatusResponse, getIngestionStatus } from "../api/client";

/**
 * Subscribe to the backend's ingestion status endpoint.
 *
 * Returns the latest status snapshot and `isRunning` — true whenever the
 * server says a run is queued or actively in progress. Polls on a timer
 * while a run is active, and backs off to the mount-fetch only when idle.
 *
 * Lifted out of IngestPanel because navigating away from /ingest
 * previously unmounted the polling loop, leaving the user with no
 * visibility into an already-running pipeline when they came back. This
 * hook is safe to use from multiple components concurrently — each runs
 * its own interval, but they hit the same cheap status endpoint.
 */
export function useIngestStatus(intervalMs = 1500) {
  const [status, setStatus] = useState<IngestionStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: number | null = null;

    const isActive = (s: IngestionStatusResponse | null) =>
      !!s && s.run_id > s.last_completed_run_id;

    const tick = async () => {
      try {
        const s = await getIngestionStatus();
        if (cancelledRef.current) return;
        setStatus(s);
        setError(null);
        if (isActive(s)) {
          timer = window.setTimeout(tick, intervalMs);
        }
      } catch (e: any) {
        if (cancelledRef.current) return;
        setError(e?.response?.data?.detail ?? e?.message ?? "Status unavailable");
        // Keep polling on transient errors — the backend may be briefly
        // unreachable during a restart.
        timer = window.setTimeout(tick, intervalMs * 2);
      }
    };

    tick();

    return () => {
      cancelledRef.current = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [intervalMs]);

  const isRunning =
    !!status && status.run_id > status.last_completed_run_id;

  return { status, isRunning, error } as const;
}
