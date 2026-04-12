/**
 * DemoPickerPage — full-page list of demos with upload support.
 *
 * Users can:
 * - Browse existing demos grouped by map
 * - Drag-and-drop or click to upload new .dem files (with progress bar)
 * - Delete demos they no longer need
 * - Click a card to open the replay viewer
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cs2PathResponse,
  MatchDemoEntry,
  MatchInfoResponse,
  deleteDemo,
  getCs2Path,
  getMatchInfo,
  getMatchReplayDemos,
  uploadDemo,
} from "../api/client";

interface Props {
  onSelect: (demoFile: string) => void;
  onBack: () => void;
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatDate = (mtime: number): string => {
  const d = new Date(mtime * 1000);
  return d.toLocaleString();
};

export default function DemoPickerPage({ onSelect, onBack }: Props) {
  const [demos, setDemos] = useState<MatchDemoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadFile, setUploadFile] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete state
  const [deleting, setDeleting] = useState<string | null>(null);

  // CS2 link status
  const [linkInfo, setLinkInfo] = useState<Cs2PathResponse | null>(null);

  // Match info cache: demo_file → match info (team names etc.)
  const [matchInfoMap, setMatchInfoMap] = useState<Record<string, MatchInfoResponse>>({});

  const loadDemos = useCallback(() => {
    setError(null);
    getMatchReplayDemos()
      .then((list) => setDemos(list))
      .catch((e: any) => {
        setError(e?.response?.data?.detail ?? "Failed to load demos");
      });
  }, []);

  useEffect(() => { loadDemos(); }, [loadDemos]);
  useEffect(() => { getCs2Path().then(setLinkInfo).catch(() => {}); }, []);

  // Fetch match info for all demos (team names from roster files)
  useEffect(() => {
    if (!demos || demos.length === 0) return;
    const toFetch = demos.filter((d) => d.match_id !== null && !matchInfoMap[d.demo_file]);
    // Deduplicate by match_id (multiple demos can share a match)
    const seen = new Set<number>();
    const unique = toFetch.filter((d) => {
      if (seen.has(d.match_id!)) return false;
      seen.add(d.match_id!);
      return true;
    });
    if (unique.length === 0) return;
    // Fetch in parallel, max ~10 at a time
    Promise.allSettled(unique.map((d) => getMatchInfo(d.demo_file))).then((results) => {
      const next: Record<string, MatchInfoResponse> = { ...matchInfoMap };
      for (const r of results) {
        if (r.status === "fulfilled") next[r.value.demo_file] = r.value;
      }
      // Also map other demos with the same match_id to the same info
      for (const d of demos) {
        if (!next[d.demo_file] && d.match_id !== null) {
          const match = Object.values(next).find((mi) => mi.match_id === d.match_id);
          if (match) next[d.demo_file] = match;
        }
      }
      setMatchInfoMap(next);
    });
  }, [demos]);

  const handleUpload = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".dem")) {
      setUploadError("Only .dem files are accepted");
      return;
    }
    setUploading(true);
    setUploadPct(0);
    setUploadFile(file.name);
    setUploadError(null);
    try {
      await uploadDemo(file, (pct) => setUploadPct(pct));
      setUploadPct(100);
      loadDemos(); // refresh list
    } catch (e: any) {
      setUploadError(
        e?.response?.data?.detail ?? `Upload failed: ${e?.message ?? "unknown error"}`
      );
    } finally {
      setUploading(false);
    }
  }, [loadDemos]);

  const handleDelete = useCallback(async (demoFile: string) => {
    setDeleting(demoFile);
    try {
      await deleteDemo(demoFile);
      loadDemos();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Delete failed");
    } finally {
      setDeleting(null);
    }
  }, [loadDemos]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const dem = files.find((f) => f.name.toLowerCase().endsWith(".dem"));
    if (dem) handleUpload(dem);
    else setUploadError("No .dem file found in drop");
  }, [handleUpload]);

  const grouped = useMemo(() => {
    const m = new Map<string, MatchDemoEntry[]>();
    for (const d of demos ?? []) {
      const key = d.map_name || "unknown";
      const arr = m.get(key) ?? [];
      arr.push(d);
      m.set(key, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [demos]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-cs2-accent uppercase tracking-[0.2em]">
            Match Replay · Pick a Demo
          </h2>
          <p className="text-[11px] text-cs2-muted mt-1">
            Upload your own .dem files or pick from existing demos to watch in the 2D viewer.
          </p>
        </div>
        <button onClick={onBack} className="hud-btn text-xs">
          ← Back
        </button>
      </div>

      {/* ── CS2 link status banner ── */}
      {linkInfo && (
        <div
          className={`hud-panel px-4 py-2 flex items-center gap-2 text-[11px] border-l-2 ${
            linkInfo.link_active
              ? "border-cs2-green text-cs2-green"
              : "border-cs2-muted text-cs2-muted"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              linkInfo.link_active ? "bg-cs2-green" : "bg-cs2-red"
            }`}
          />
          {linkInfo.link_active ? (
            <span>
              Demos linked to CS2 at{" "}
              <span className="font-mono text-gray-300">
                game/csgo/{linkInfo.link_name}/
              </span>{" "}
              — Replay buttons use the correct path automatically.
            </span>
          ) : (
            <span>
              Demos not linked to CS2. Go to{" "}
              <span className="text-cs2-accent">Settings</span> to enable
              one-click replay.
            </span>
          )}
        </div>
      )}

      {/* ── Upload zone ── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={`hud-panel p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all border-2 border-dashed ${
          dragOver
            ? "border-cs2-accent bg-cs2-accent/10 shadow-[0_0_24px_rgba(34,211,238,0.2)]"
            : "border-cs2-border/50 hover:border-cs2-accent/50"
        } ${uploading ? "pointer-events-none opacity-70" : ""}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".dem"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            e.target.value = "";
          }}
        />

        {uploading ? (
          <>
            <p className="text-[12px] text-cs2-accent font-mono">
              Uploading {uploadFile}…
            </p>
            <div className="w-full max-w-md h-2 rounded-full bg-cs2-border/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cs2-accent to-cs2-green transition-all duration-300"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
            <p className="text-[10px] text-cs2-muted font-mono">{uploadPct}%</p>
          </>
        ) : (
          <>
            <div className="text-[24px] text-cs2-accent/60">+</div>
            <p className="text-[12px] text-cs2-muted">
              <span className="text-cs2-accent">Click to browse</span> or drag
              & drop a .dem file here
            </p>
            <p className="text-[10px] text-cs2-muted/60">
              CS2 demo files · max 2 GB
            </p>
          </>
        )}
      </div>

      {uploadError && (
        <p className="text-[12px] text-cs2-red border-l-2 border-cs2-red/50 pl-2">
          {uploadError}
        </p>
      )}

      {error && (
        <p className="text-[12px] text-cs2-red border-l-2 border-cs2-red/50 pl-2">
          {error}
        </p>
      )}

      {!demos && !error && (
        <p className="text-[12px] text-cs2-muted">Loading demos…</p>
      )}

      {demos && demos.length === 0 && !error && (
        <p className="text-[12px] text-cs2-muted">
          No demos yet. Upload a .dem file above or run an HLTV ingest.
        </p>
      )}

      {grouped.map(([mapName, list]) => (
        <section key={mapName} className="hud-panel p-4 flex flex-col gap-3">
          <header className="flex items-center justify-between">
            <h3 className="text-[12px] font-mono uppercase tracking-[0.18em] text-cs2-accent">
              {mapName}
            </h3>
            <span className="text-[10px] text-cs2-muted font-mono">
              {list.length} demo{list.length === 1 ? "" : "s"}
            </span>
          </header>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {list.map((d) => {
              const mi = matchInfoMap[d.demo_file];
              const title = mi?.team1 && mi?.team2
                ? `${mi.team1.name} vs ${mi.team2.name}`
                : d.demo_file;
              return (
              <div
                key={d.demo_file}
                className="text-left hud-panel p-3 hover:border-cs2-accent hover:shadow-[0_0_18px_rgba(34,211,238,0.18)] hover:-translate-y-0.5 transition-all flex flex-col"
              >
                <p className="text-[12px] text-white font-semibold truncate">
                  {title}
                </p>
                {mi?.event && (
                  <p className="text-[10px] text-cs2-accent/70 mt-0.5 truncate">
                    {mi.event}
                  </p>
                )}
                {mi?.team1 && mi?.team2 && (
                  <p className="text-[9px] text-cs2-muted font-mono mt-0.5 truncate">
                    {d.demo_file}
                  </p>
                )}
                <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-cs2-muted uppercase tracking-[0.08em]">
                  {d.match_id !== null && (
                    <>
                      <span>Match</span>
                      <span className="text-right text-gray-300 font-mono normal-case tracking-normal">
                        #{d.match_id}
                      </span>
                    </>
                  )}
                  <span>Size</span>
                  <span className="text-right text-gray-300 font-mono normal-case tracking-normal">
                    {formatBytes(d.size_bytes)}
                  </span>
                  <span>Date</span>
                  <span className="text-right text-gray-300 font-mono normal-case tracking-normal">
                    {mi?.date || formatDate(d.mtime)}
                  </span>
                </div>
                <div className="flex gap-1.5 mt-2 pt-1">
                  <button
                    onClick={() => onSelect(d.demo_file)}
                    className="flex-1 text-[10px] hud-btn-primary"
                  >
                    Open
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(d.demo_file);
                    }}
                    disabled={deleting === d.demo_file}
                    className="text-[10px] hud-btn text-cs2-red/70 hover:text-cs2-red hover:border-cs2-red/50"
                    title="Delete this demo"
                  >
                    {deleting === d.demo_file ? "…" : "Del"}
                  </button>
                </div>
              </div>
            ); })}
          </div>
        </section>
      ))}
    </div>
  );
}
