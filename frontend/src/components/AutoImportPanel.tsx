/**
 * AutoImportPanel — folder watcher settings + recent imports.
 *
 * The backend polls the watched folders (CS2's replays folder, data/inbox,
 * optionally ~/Downloads, plus any folder the user adds) and imports new
 * .dem / .rar / .zip / .dem.gz|bz2|zst files as `<prefix>_<map>.dem`.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ImportSettings,
  ImportSettingsUpdate,
  ImportStatus,
  RecentImport,
  WatchFolder,
  apiErrorMessage,
  getImportSettings,
  getImportStatus,
  scanImportsNow,
  updateImportSettings,
} from "../api/imports";

const STEAMID_RE = /^7656119\d{10}$/;

function timeAgo(unix: number | null): string {
  if (!unix) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 py-1 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-400"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-white">{label}</span>
        {hint && <span className="block text-[10px] text-cs2-muted break-words">{hint}</span>}
      </span>
    </label>
  );
}

function StatusBadge({ r }: { r: RecentImport }) {
  const style =
    r.status === "error"
      ? "border-cs2-red/50 text-cs2-red bg-cs2-red/10"
      : r.parse_state === "pending"
        ? "border-amber-400/50 text-amber-300 bg-amber-400/10"
        : r.parse_state === "failed"
          ? "border-amber-400/50 text-amber-300 bg-amber-400/10"
          : "border-cs2-green/50 text-cs2-green bg-cs2-green/10";
  const text =
    r.status === "error"
      ? "Error"
      : r.parse_state === "pending"
        ? "Parsing"
        : r.parse_state === "failed"
          ? "Parse failed"
          : "Imported";
  return (
    <span className={`shrink-0 text-[9px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border ${style}`}>
      {text}
    </span>
  );
}

function FolderRow({
  f,
  onRemove,
  busy,
}: {
  f: WatchFolder;
  onRemove?: () => void;
  busy: boolean;
}) {
  return (
    <li className="flex items-start gap-2 py-2">
      <span
        className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${f.exists ? "bg-cs2-green" : "bg-cs2-red"}`}
        title={f.exists ? "Folder found" : "Folder not found"}
      />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-white">
          {f.label}
          {!f.exists && (
            <span className="ml-2 text-[10px] text-cs2-red">
              {f.kind === "cs2" && !f.path ? "CS2 not found — set its path in Settings" : "missing"}
            </span>
          )}
        </p>
        {f.path && (
          <p className="text-[10px] text-cs2-muted font-mono break-all">{f.path}</p>
        )}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          disabled={busy}
          className="hud-btn text-[10px] py-1 px-2 shrink-0 text-cs2-red/80 hover:text-cs2-red max-sm:min-h-[36px]"
          aria-label={`Stop watching ${f.label}`}
          title="Stop watching this folder"
        >
          Remove
        </button>
      )}
    </li>
  );
}

export default function AutoImportPanel() {
  const [cfg, setCfg] = useState<ImportSettings | null>(null);
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [steamId, setSteamId] = useState("");
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const refreshStatus = useCallback(() => {
    getImportStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    getImportSettings()
      .then((s) => {
        setCfg(s);
        setSteamId(s.my_steamid);
      })
      .catch((e) => setError(apiErrorMessage(e, "Failed to load auto-import settings")));
    refreshStatus();
    const t = window.setInterval(refreshStatus, 5000);
    return () => window.clearInterval(t);
  }, [refreshStatus]);

  const save = async (update: ImportSettingsUpdate): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateImportSettings(update);
      setCfg(next);
      setSteamId(next.my_steamid);
      refreshStatus();
      return true;
    } catch (e) {
      setError(apiErrorMessage(e, "Could not save settings"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addFolder = async (entry: string) => {
    if (!cfg || !entry.trim()) return;
    if (await save({ watch_folders: [...cfg.watch_folders, entry.trim()] })) setNewFolder("");
  };

  const removeFolder = (id: string) => {
    if (!cfg) return;
    save({ watch_folders: cfg.watch_folders.filter((f) => f !== id) });
  };

  const scan = async () => {
    setBusy(true);
    setScanning(true);
    setScanMsg(null);
    setError(null);
    try {
      const r = await scanImportsNow();
      const errors = r.results.filter((x) => x.status === "error").length;
      setScanMsg(
        r.handled === 0
          ? "Nothing new in the watched folders."
          : `${r.imported} imported${errors ? `, ${errors} failed` : ""} of ${r.handled} new file${r.handled === 1 ? "" : "s"}.`,
      );
      refreshStatus();
    } catch (e) {
      setError(apiErrorMessage(e, "Scan failed"));
    } finally {
      setScanning(false);
      setBusy(false);
    }
  };

  const steamIdValid = steamId === "" || STEAMID_RE.test(steamId.trim());
  const folders = status?.folders ?? cfg?.folders ?? [];
  const missingDefaults = cfg
    ? cfg.default_folders.filter((d) => !cfg.watch_folders.includes(d))
    : [];

  return (
    <div className="space-y-4">
      {/* ── Watcher ── */}
      <div className="hud-panel p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">/ auto-import</p>
            <h2 className="text-sm font-semibold text-white mt-0.5">Watch folders for new demos</h2>
          </div>
          <span
            className={`shrink-0 text-[9px] font-mono uppercase tracking-[0.1em] px-2 py-1 rounded border ${
              status?.watcher_running && status.enabled
                ? "border-cs2-green/50 text-cs2-green"
                : "border-cs2-border text-cs2-muted"
            }`}
          >
            {status?.scanning
              ? "Scanning…"
              : status?.watcher_running && status.enabled
                ? "Watching"
                : status?.watcher_running
                  ? "Paused"
                  : "Off"}
          </span>
        </div>

        <p className="text-[11px] text-cs2-muted leading-relaxed">
          New <span className="font-mono">.dem</span>, <span className="font-mono">.rar</span>,{" "}
          <span className="font-mono">.zip</span> and <span className="font-mono">.dem.gz/.bz2/.zst</span>{" "}
          files in these folders are copied into the demo library, named by map, and parsed. Your own
          matchmaking demos land in CS2's replays folder after you click Download in CS2's Watch tab.
          Source files are never changed or deleted.
        </p>

        {cfg && (
          <Toggle
            checked={cfg.enabled}
            disabled={busy}
            onChange={(v) => save({ enabled: v })}
            label="Auto-import enabled"
            hint={`Checks every ${status?.interval_s ?? 15}s · last scan ${timeAgo(status?.last_scan_at ?? null)}`}
          />
        )}

        <ul className="divide-y divide-cs2-border/40 border-y border-cs2-border/40">
          {folders.map((f) => (
            <FolderRow
              key={f.id}
              f={f}
              busy={busy}
              onRemove={f.kind === "downloads" ? undefined : () => removeFolder(f.id)}
            />
          ))}
          {folders.length === 0 && (
            <li className="py-2 text-[11px] text-cs2-muted">No folders watched.</li>
          )}
        </ul>

        {missingDefaults.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {missingDefaults.map((d) => (
              <button
                key={d}
                onClick={() => addFolder(d)}
                disabled={busy}
                className="hud-btn text-[10px] py-1 px-2"
              >
                + {d === "@cs2-replays" ? "CS2 replays folder" : "Inbox folder"}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="hud-input flex-1 min-w-0"
            placeholder="Add a folder (absolute path on the server)"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) addFolder(newFolder);
            }}
          />
          <button
            onClick={() => addFolder(newFolder)}
            disabled={busy || !newFolder.trim()}
            className="hud-btn"
          >
            Add folder
          </button>
        </div>

        {cfg && (
          <Toggle
            checked={cfg.watch_downloads}
            disabled={busy}
            onChange={(v) => save({ watch_downloads: v })}
            label="Also watch my Downloads folder"
            hint={<span className="font-mono break-all">{cfg.downloads_path}</span>}
          />
        )}

        {cfg && (
          <Toggle
            checked={cfg.auto_run_pipeline}
            disabled={busy}
            onChange={(v) => save({ auto_run_pipeline: v })}
            label="Re-run lineup analysis after each import"
            hint="Rebuilds that map's lineups. Skipped while another ingest is running."
          />
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <button onClick={scan} disabled={busy} className="hud-btn-primary">
            {scanning ? "Scanning…" : "Scan now"}
          </button>
          {scanMsg && <span className="text-[11px] text-cs2-accent">{scanMsg}</span>}
        </div>

        {status && !status.rar_support && (
          <p className="text-[11px] text-amber-300 border-l-2 border-amber-400/60 pl-2">
            No RAR extractor found on the server — install 7-Zip or unrar to import HLTV archives.
          </p>
        )}
        {status?.last_error && (
          <p className="text-[11px] text-cs2-red border-l-2 border-cs2-red/60 pl-2 break-words">
            Last scan failed: {status.last_error}
          </p>
        )}
      </div>

      {/* ── My SteamID ── */}
      <div className="hud-panel p-4 sm:p-5 space-y-3">
        <div>
          <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">/ my matches</p>
          <h2 className="text-sm font-semibold text-white mt-0.5">Your SteamID64</h2>
        </div>
        <p className="text-[11px] text-cs2-muted leading-relaxed">
          Turns on the <span className="text-white">My matches</span> filter on the demo picker. It's
          the 17-digit number in your Steam profile URL (starts with 7656119).
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="hud-input flex-1 min-w-0 font-mono"
            inputMode="numeric"
            placeholder="76561198…"
            value={steamId}
            onChange={(e) => setSteamId(e.target.value.replace(/\s/g, ""))}
          />
          <button
            onClick={() => save({ my_steamid: steamId.trim() })}
            disabled={busy || !steamIdValid || steamId === (cfg?.my_steamid ?? "")}
            className="hud-btn"
          >
            Save
          </button>
        </div>
        {!steamIdValid && (
          <p className="text-[11px] text-cs2-red">Must be 17 digits starting with 7656119.</p>
        )}
      </div>

      {error && (
        <p className="text-[11px] text-cs2-red border-l-2 border-cs2-red/60 bg-cs2-red/5 pl-2 py-1 break-words">
          {error}
        </p>
      )}

      {/* ── Recent imports ── */}
      <div className="hud-panel p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">/ recent imports</p>
          {status && (status.parsing || status.parse_queue > 0) && (
            <span className="text-[10px] text-amber-300 font-mono truncate min-w-0">
              parsing {status.parse_queue + (status.parsing ? 1 : 0)}…
            </span>
          )}
        </div>
        {(status?.recent.length ?? 0) === 0 ? (
          <p className="text-[11px] text-cs2-muted">Nothing imported yet.</p>
        ) : (
          <ul className="divide-y divide-cs2-border/40">
            {status!.recent.map((r) => (
              <li key={`${r.source}-${r.imported_at}`} className="py-2 space-y-0.5">
                <div className="flex items-start gap-2 min-w-0">
                  <p className="flex-1 min-w-0 text-[11px] text-white font-mono break-all" title={r.source}>
                    {r.name}
                  </p>
                  <StatusBadge r={r} />
                </div>
                <p className="text-[10px] text-cs2-muted">
                  {r.origin === "watch" ? "folder watcher" : r.origin === "hltv" ? "HLTV extension" : r.origin}
                  {" · "}
                  {timeAgo(r.imported_at)}
                </p>
                {r.demos.length > 0 && (
                  <p className="text-[10px] text-cs2-accent/80 font-mono break-all">
                    → {r.demos.join(", ")}
                  </p>
                )}
                {r.error && <p className="text-[10px] text-cs2-red break-words">{r.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
