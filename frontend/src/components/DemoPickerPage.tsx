/**
 * DemoPickerPage — full-page list of demos with upload support.
 *
 * Users can:
 * - Browse existing demos grouped by map
 * - Drag-and-drop or click to upload new .dem files (with progress bar)
 * - Delete demos they no longer need
 * - Click a card to open the replay viewer
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cs2PathResponse,
  MatchDemoEntry,
  MatchInfoResponse,
  apiErrorMessage,
  deleteDemo,
  getCs2Path,
  getMatchInfo,
  getMatchReplayDemos,
  uploadDemo,
} from "../api/client";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import { useReveal } from "../hooks/useReveal";

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

export default function DemoPickerPage() {
  const navigate = useNavigate();
  const hero = useReveal<HTMLDivElement>();
  const [demos, setDemos] = useState<MatchDemoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadFile, setUploadFile] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

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
      .catch((e: unknown) => {
        setError(apiErrorMessage(e, "Failed to load demos"));
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
    } catch (e) {
      setUploadError(apiErrorMessage(e, "Upload failed"));
    } finally {
      setUploading(false);
    }
  }, [loadDemos]);

  const handleDelete = useCallback(async (demoFile: string) => {
    // Del sits right next to Open; on touch screens a stray tap would
    // otherwise remove the file with no way back.
    if (!window.confirm(`Delete ${demoFile} from disk? This cannot be undone.`)) {
      return;
    }
    setDeleting(demoFile);
    setError(null);
    try {
      await deleteDemo(demoFile);
      loadDemos();
    } catch (e) {
      setError(apiErrorMessage(e, "Delete failed"));
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
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#05070d]">
      <AppBackdrop tone="green" />
      <AppHeader />

      <div className="relative flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-8 pb-12 space-y-6" style={{ scrollbarWidth: "thin" }}>

      <div ref={hero.ref} className={`reveal ${hero.shown ? "in" : ""} max-w-7xl mx-auto w-full`}>
        <span className="section-eyebrow" style={{ color: "#86efac" }}>REWATCH</span>
        <h1 className="page-title mt-3">
          Pick a demo to <span className="accent">rewatch</span>
        </h1>
        <p className="mt-3 text-sm text-cs2-muted leading-relaxed max-w-2xl">
          Browse your library, upload a new .dem file, or link the folder to CS2
          so Replay buttons jump straight in.
        </p>
      </div>

      <div className="max-w-7xl mx-auto w-full space-y-4">

      {/* ── CS2 link status banner ── */}
      {linkInfo && (
        <div
          className={`hud-panel px-4 py-2 flex items-start sm:items-center gap-2 text-[11px] border-l-2 ${
            linkInfo.link_active
              ? "border-cs2-green text-cs2-green"
              : "border-cs2-muted text-cs2-muted"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 max-sm:mt-1 ${
              linkInfo.link_active ? "bg-cs2-green" : "bg-cs2-red"
            }`}
          />
          {linkInfo.link_active ? (
            <span>
              Demos linked to CS2 at{" "}
              <span className="font-mono text-gray-300 break-all">
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

      {/* ── Upload zone ── a real <label> for the file input so a tap opens
          the picker on iOS/Android too (programmatic .click() on a hidden
          input is unreliable on some mobile browsers). Drag & drop still
          works on desktop via the handlers below. */}
      <label
        htmlFor={fileInputId}
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading || undefined}
        aria-label="Upload a .dem file"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (uploading) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`hud-panel p-5 sm:p-6 min-h-[120px] sm:min-h-0 flex flex-col items-center justify-center gap-2 cursor-pointer select-none text-center transition-all border-2 border-dashed focus:outline-none focus-visible:border-cs2-accent ${
          dragOver
            ? "border-cs2-accent bg-cs2-accent/10 shadow-[0_0_24px_rgba(34,211,238,0.2)]"
            : "border-cs2-border/50 hover:border-cs2-accent/50"
        } ${uploading ? "pointer-events-none opacity-70" : ""}`}
      >
        {/* ".dem" has no registered MIME type, so mobile pickers can grey
            every file out unless octet-stream is accepted too. */}
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept=".dem,application/octet-stream"
          className="sr-only"
          tabIndex={-1}
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            e.target.value = "";
          }}
        />

        {uploading ? (
          <>
            <p className="text-[12px] text-cs2-accent font-mono max-w-full truncate">
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
              <span className="text-cs2-accent sm:hidden">Tap to choose a .dem file</span>
              <span className="hidden sm:inline">
                <span className="text-cs2-accent">Click to browse</span> or drag
                & drop a .dem file here
              </span>
            </p>
            <p className="text-[10px] text-cs2-muted/60">
              CS2 demo files · max 2 GB
            </p>
          </>
        )}
      </label>

      {uploadError && (
        <p className="text-[12px] text-cs2-red border-l-2 border-cs2-red/50 pl-2 break-words">
          {uploadError}
        </p>
      )}

      {error && (
        <p className="text-[12px] text-cs2-red border-l-2 border-cs2-red/50 pl-2 break-words">
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
        <section key={mapName} className="hud-panel p-3 sm:p-4 flex flex-col gap-3">
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
                <div className="flex items-start gap-2 min-w-0">
                  <p className="text-[12px] text-white font-semibold truncate flex-1 min-w-0" title={title}>
                    {title}
                  </p>
                  {d.complete === false && (
                    <span
                      className="shrink-0 text-[9px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-amber-400/50 bg-amber-400/10 text-amber-300 whitespace-nowrap cursor-help"
                      title={`The demo file ends before the match did${
                        d.score ? ` (it stops at ${d.score[0]}–${d.score[1]})` : ""
                      }, so the replay won't show the final rounds.`}
                    >
                      Partial{d.score ? ` · ${d.score[0]}–${d.score[1]}` : ""}
                    </span>
                  )}
                </div>
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
                    onClick={() => navigate(`/replay/${encodeURIComponent(d.demo_file)}`)}
                    className="flex-1 text-[10px] hud-btn-primary max-sm:min-h-[44px] max-sm:text-[11px]"
                  >
                    Open
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(d.demo_file);
                    }}
                    disabled={deleting === d.demo_file}
                    className="text-[10px] hud-btn text-cs2-red/70 hover:text-cs2-red hover:border-cs2-red/50 max-sm:min-h-[44px] max-sm:min-w-[56px] max-sm:text-[11px]"
                    title="Delete this demo"
                    aria-label={`Delete ${d.demo_file}`}
                  >
                    {deleting === d.demo_file ? "…" : "Del"}
                  </button>
                </div>
              </div>
            ); })}
          </div>
        </section>
      ))}
      </div>{/* /max-w-7xl content */}
      </div>{/* /scrollable */}
    </div>
  );
}
