import { useState } from "react";
import {
  FaceitMatchEntry,
  FaceitMatchListResponse,
  downloadFaceitMatch,
  getIngestionStatus,
  listFaceitMatches,
} from "../api/client";

interface Props {
  onComplete?: () => void;
}

// Same polling pattern as IngestPanel — wait for the queued run_id to clear.
async function pollUntilDone(
  queuedRunId: number,
  onStatus: (msg: string, manualUrl: string | null) => void,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const s = await getIngestionStatus();
      onStatus(s?.status ?? "", s?.manual_url ?? null);
      if ((s?.last_completed_run_id ?? 0) >= queuedRunId) return;
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for pipeline to finish");
}

function formatDate(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreString(m: FaceitMatchEntry): string {
  if (m.team1_score === null || m.team2_score === null) return "—";
  return `${m.team1_score} – ${m.team2_score}`;
}

export default function FaceitIngestPanel({ onComplete }: Props) {
  const [url, setUrl] = useState("");
  const [data, setData] = useState<FaceitMatchListResponse | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [pullingMatchId, setPullingMatchId] = useState<string | null>(null);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);

  const handleFetchList = async () => {
    setListLoading(true);
    setListError(null);
    setData(null);
    try {
      const resp = await listFaceitMatches(url, 30);
      setData(resp);
    } catch (e: any) {
      setListError(
        e?.response?.data?.detail ?? e?.message ?? "Failed to fetch matches",
      );
    } finally {
      setListLoading(false);
    }
  };

  const handlePull = async (match: FaceitMatchEntry) => {
    setPullingMatchId(match.match_id);
    setPullStatus("Queueing download…");
    setManualUrl(null);
    // Local ref so the post-poll branch doesn't read a stale React closure —
    // setManualUrl is async and the closure captures the initial null.
    let seenManualUrl: string | null = null;
    try {
      const queued = await downloadFaceitMatch(match.match_id);
      await pollUntilDone(queued.run_id, (status, manual) => {
        setPullStatus(status);
        if (manual) {
          seenManualUrl = manual;
          setManualUrl(manual);
        }
      });
      if (seenManualUrl) {
        setPullStatus("Direct download blocked — use the manual link below.");
      } else {
        setPullStatus("Done — refreshing lineups");
        onComplete?.();
      }
    } catch (e: any) {
      setPullStatus(
        e?.response?.data?.detail ?? e?.message ?? "Download failed",
      );
    } finally {
      setPullingMatchId(null);
    }
  };

  return (
    <div className="hud-panel p-5 space-y-4">
      <div>
        <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">
          / faceit
        </p>
        <h2 className="text-sm font-semibold text-white mt-0.5">
          Pull a demo from your FACEIT history
        </h2>
      </div>

      <div className="flex gap-2">
        <input
          className="hud-input flex-1"
          placeholder="https://www.faceit.com/en/players/<nickname>"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url && !listLoading) handleFetchList();
          }}
        />
        <button
          onClick={handleFetchList}
          disabled={!url || listLoading}
          className="hud-btn-primary"
        >
          {listLoading ? "Fetching…" : "List matches"}
        </button>
      </div>

      {listError && (
        <p className="text-[11px] text-cs2-red border-l-2 border-cs2-red/60 bg-cs2-red/5 pl-2 py-1">
          {listError}
        </p>
      )}

      {data && (
        <div className="space-y-2">
          <p className="text-[10px] text-cs2-muted uppercase tracking-[0.15em]">
            {data.player_nickname} · {data.matches.length} recent CS2 matches
          </p>
          <div className="max-h-[400px] overflow-y-auto divide-y divide-cs2-border/40 border border-cs2-border/40 rounded" style={{ scrollbarWidth: "thin" }}>
            {data.matches.length === 0 && (
              <p className="text-[11px] text-cs2-muted p-3">
                No CS2 matches returned for this player.
              </p>
            )}
            {data.matches.map((m) => {
              const busy = pullingMatchId === m.match_id;
              const isWinner =
                (m.winner === "faction1" && (m.team1_score ?? 0) >= (m.team2_score ?? 0)) ||
                (m.winner === "faction2" && (m.team2_score ?? 0) >= (m.team1_score ?? 0));
              return (
                <div
                  key={m.match_id}
                  className="flex items-center gap-3 px-3 py-2 text-[11px] hover:bg-cs2-accent/5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-white truncate">
                      <span className={m.winner === "faction1" ? "text-cs2-green" : ""}>
                        {m.team1_name}
                      </span>
                      <span className="text-cs2-muted"> vs </span>
                      <span className={m.winner === "faction2" ? "text-cs2-green" : ""}>
                        {m.team2_name}
                      </span>
                    </div>
                    <div className="text-[10px] text-cs2-muted font-mono">
                      {(m.map_name ?? "unknown").replace("de_", "")} · {scoreString(m)} · {formatDate(m.finished_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => handlePull(m)}
                    disabled={!!pullingMatchId}
                    className="hud-btn text-[10px] py-1 px-2 shrink-0"
                    title={busy ? "Working…" : "Download demo + run pipeline"}
                  >
                    {busy ? "…" : "Pull"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pullStatus && (
        <p className="text-[11px] text-cs2-accent border-l-2 border-cs2-accent/60 bg-cs2-accent/5 pl-2 py-1 font-mono">
          {pullStatus}
        </p>
      )}

      {manualUrl && (
        <div className="hud-panel border-cs2-accent/40 bg-cs2-accent/5 p-3 space-y-2">
          <p className="text-[11px] text-cs2-accent font-semibold uppercase tracking-[0.15em]">
            Manual download
          </p>
          <p className="text-[11px] text-gray-300 leading-relaxed">
            FACEIT blocked the direct download (Downloads API approval pending).
            Open the demo in a new tab using your logged-in FACEIT session — your
            browser will download a compressed demo (usually{" "}
            <span className="font-mono">.dem.zst</span>, sometimes{" "}
            <span className="font-mono">.dem.gz</span>). Decompress it
            (macOS: <span className="font-mono">zstd -d file.dem.zst</span> or{" "}
            <span className="font-mono">gunzip file.dem.gz</span>), then drop the{" "}
            <span className="font-mono">.dem</span> onto{" "}
            <a href="/replay" className="text-cs2-accent underline">/replay</a> to upload.
          </p>
          <a
            href={manualUrl}
            target="_blank"
            rel="noreferrer"
            className="hud-btn-primary inline-block text-[11px] py-1 px-3"
          >
            Open demo URL ↗
          </a>
        </div>
      )}

      <p className="text-[10px] text-cs2-muted leading-relaxed">
        Uses the FACEIT Data API. Demo download may fall back to a manual step
        until the separate Downloads API scope is approved.
      </p>
    </div>
  );
}
