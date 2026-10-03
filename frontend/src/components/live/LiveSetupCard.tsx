/** LiveSetupCard — install / copy the GSI cfg and the steps to get data flowing. */
import { useEffect, useState, type ReactNode } from "react";
import {
  GsiStatus,
  apiErrorMessage,
  getGsiConfig,
  installGsiConfig,
} from "../../api/gsi";

const URI_KEY = "cs2.gsi.uri";
const CFG_FILENAME = "gamestate_integration_cs2metaengine.cfg";

function readUri(): string | null {
  try {
    return localStorage.getItem(URI_KEY);
  } catch {
    return null;
  }
}

function writeUri(uri: string): void {
  try {
    localStorage.setItem(URI_KEY, uri);
  } catch {
    // storage blocked — keep it for this visit only
  }
}

interface Props {
  status: GsiStatus | null;
  onInstalled?: () => void;
  compact?: boolean;
}

export default function LiveSetupCard({ status, onInstalled, compact = false }: Props) {
  const defaultUri = status?.default_uri ?? "http://127.0.0.1:8000/api/gsi";
  const [uri, setUri] = useState<string>(() => readUri() ?? "");
  const [busy, setBusy] = useState<"install" | "copy" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [cfgText, setCfgText] = useState<string | null>(null);
  const [showCfg, setShowCfg] = useState(false);

  const effectiveUri = uri.trim() || defaultUri;

  useEffect(() => {
    if (!showCfg) return;
    let cancelled = false;
    getGsiConfig(effectiveUri)
      .then((t) => !cancelled && setCfgText(t))
      .catch((e) => !cancelled && setMessage({ kind: "err", text: apiErrorMessage(e, "Could not build config") }));
    return () => {
      cancelled = true;
    };
  }, [showCfg, effectiveUri]);

  const rememberUri = () => {
    if (uri.trim()) writeUri(uri.trim());
  };

  const install = async () => {
    setBusy("install");
    setMessage(null);
    rememberUri();
    try {
      const res = await installGsiConfig(uri.trim() || undefined);
      setMessage({ kind: "ok", text: `Installed to ${res.path}. ${res.message}` });
      onInstalled?.();
    } catch (e) {
      setMessage({ kind: "err", text: apiErrorMessage(e, "Install failed") });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    setBusy("copy");
    setMessage(null);
    rememberUri();
    try {
      const text = await getGsiConfig(effectiveUri);
      setCfgText(text);
      try {
        await navigator.clipboard.writeText(text);
        setMessage({ kind: "ok", text: `Copied. Save it as game/csgo/cfg/${CFG_FILENAME}.` });
      } catch {
        setShowCfg(true);
        setMessage({ kind: "err", text: "Clipboard blocked. Copy the config from the box below." });
      }
    } catch (e) {
      setMessage({ kind: "err", text: apiErrorMessage(e, "Could not build config") });
    } finally {
      setBusy(null);
    }
  };

  const uriMismatch =
    status?.cfg_installed && status.cfg_uri && status.cfg_uri !== effectiveUri;

  return (
    <section className={`hud-panel ${compact ? "p-4" : "p-5 sm:p-6"} min-w-0`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-white">Connect CS2</h2>
        <span className="text-xs text-cs2-muted">Game State Integration</span>
      </div>

      <ol className="mt-4 space-y-3 text-sm text-gray-300">
        <Step n={1} title="Install the config">
          Writes <code className="font-mono text-[12px] text-cyan-200 break-all">{CFG_FILENAME}</code> into
          your CS2 <code className="font-mono text-[12px]">game/csgo/cfg</code> folder, or copy it there yourself.
        </Step>
        <Step n={2} title="Restart CS2">CS2 only reads GSI configs on launch.</Step>
        <Step n={3} title="Spectate or watch a demo">
          GOTV, observing or a demo (<code className="font-mono text-[12px]">playdemo</code>) sends all 10 players.
          While playing you only get your own data. Linking your demos to CS2 on the Replay page lets you
          stream any pro demo here.
        </Step>
      </ol>

      <label className="mt-5 block">
        <span className="text-[11px] uppercase tracking-wider text-cs2-muted">Backend URI (as seen from CS2)</span>
        <input
          className="hud-input mt-1.5 w-full font-mono text-[13px]"
          value={uri}
          placeholder={defaultUri}
          spellCheck={false}
          onChange={(e) => setUri(e.target.value)}
          onBlur={rememberUri}
        />
        <span className="mt-1 block text-[11px] text-cs2-muted">
          Leave blank when CS2 runs on this machine. For a remote server use its LAN address,
          e.g. http://192.168.1.20:8000/api/gsi.
        </span>
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="hud-btn-primary"
          onClick={install}
          disabled={busy !== null || status?.cs2_dir_found === false}
          title={status?.cs2_dir_found === false ? "CS2 folder not found — set it in Settings" : undefined}
        >
          {busy === "install" ? "Installing…" : status?.cfg_installed ? "Reinstall config" : "Install config"}
        </button>
        <button className="hud-btn" onClick={copy} disabled={busy !== null}>
          {busy === "copy" ? "Copying…" : "Copy config"}
        </button>
        <button className="hud-btn" onClick={() => setShowCfg((v) => !v)}>
          {showCfg ? "Hide config" : "Show config"}
        </button>
      </div>

      {status && (
        <div className="mt-4 space-y-1 text-xs">
          {status.cs2_dir_found === false && (
            <p className="text-amber-300">CS2 folder not detected. Set it in Settings, or copy the config manually.</p>
          )}
          {status.cfg_installed && (
            <p className="text-cs2-green break-all">
              Config installed{status.cfg_path ? ` at ${status.cfg_path}` : ""}.
            </p>
          )}
          {status.cfg_installed && status.cfg_token_matches === false && (
            <p className="text-amber-300">The installed config has an old token. Reinstall it, then restart CS2.</p>
          )}
          {uriMismatch && (
            <p className="text-amber-300 break-all">
              Installed config posts to {status.cfg_uri}. Reinstall to use {effectiveUri}.
            </p>
          )}
          {status.payloads_rejected > 0 && !status.connected && (
            <p className="text-amber-300">
              CS2 is sending data with the wrong token ({status.payloads_rejected} rejected). Reinstall the config.
            </p>
          )}
        </div>
      )}

      {message && (
        <p
          className={`mt-3 text-xs break-words ${message.kind === "ok" ? "text-cs2-green" : "text-cs2-red"}`}
          role="status"
        >
          {message.text}
        </p>
      )}

      {showCfg && (
        <pre className="mt-4 max-h-72 overflow-auto rounded-lg bg-black/40 border border-white/5 p-3 text-[11px] leading-relaxed font-mono text-gray-300">
          {cfgText ?? "Loading…"}
        </pre>
      )}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 text-[11px] font-mono text-cyan-200">
        {n}
      </span>
      <div className="min-w-0">
        <div className="font-medium text-white">{title}</div>
        <div className="mt-0.5 text-[13px] text-gray-400">{children}</div>
      </div>
    </li>
  );
}
