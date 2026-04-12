/**
 * SettingsPanel — HUD-styled modal for CS2 path configuration and demo linking.
 */
import { useEffect, useState } from "react";
import {
  Cs2PathResponse,
  getCs2Path,
  setCs2Path,
  linkDemosToCs2,
  unlinkDemosFromCs2,
} from "../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ open, onClose }: Props) {
  const [info, setInfo] = useState<Cs2PathResponse | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await getCs2Path();
      setInfo(res);
      setPathInput(res.configured_path || res.detected_path || "");
    } catch {
      setMessage("Failed to load CS2 path info");
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await setCs2Path(pathInput.trim());
      await refresh();
      setMessage("Path saved");
    } catch (e: any) {
      setMessage(e?.response?.data?.detail ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleLink = async () => {
    setLinking(true);
    setMessage(null);
    try {
      const res = await linkDemosToCs2();
      setMessage(
        res.status === "already_linked"
          ? "Already linked"
          : "Demos linked to CS2"
      );
      await refresh();
    } catch (e: any) {
      setMessage(e?.response?.data?.detail ?? "Link failed");
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    setLinking(true);
    setMessage(null);
    try {
      await unlinkDemosFromCs2();
      setMessage("Junction removed");
      await refresh();
    } catch (e: any) {
      setMessage(e?.response?.data?.detail ?? "Unlink failed");
    } finally {
      setLinking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="hud-panel w-full max-w-lg p-6 flex flex-col gap-5 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-cs2-muted hover:text-white text-lg leading-none"
        >
          x
        </button>

        <h2 className="text-sm font-semibold text-cs2-accent uppercase tracking-[0.15em]">
          Settings
        </h2>

        {/* CS2 Path */}
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-cs2-muted uppercase tracking-[0.12em]">
            CS2 Game Directory (game/csgo)
          </label>

          {info?.detected_path && (
            <p className="text-[10px] text-cs2-green">
              Auto-detected: {info.detected_path}
            </p>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="C:/Program Files (x86)/Steam/.../game/csgo"
              className="flex-1 min-w-0 bg-cs2-bg border border-cs2-border rounded px-3 py-1.5 text-[11px] text-gray-200 font-mono placeholder:text-cs2-muted/50 focus:border-cs2-accent/60 focus:outline-none"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="hud-btn text-[10px] px-3"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {/* Demo Link Status */}
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-cs2-muted uppercase tracking-[0.12em]">
            Demo Link to CS2
          </label>

          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                info?.link_active ? "bg-cs2-green" : "bg-cs2-red"
              }`}
            />
            <span className="text-[11px] text-gray-300">
              {info?.link_active
                ? `Linked at ${info.link_path}`
                : "Not linked"}
            </span>
          </div>

          <p className="text-[10px] text-cs2-muted leading-relaxed">
            Creates a directory junction so CS2 can find demo files at{" "}
            <span className="font-mono text-gray-400">
              game/csgo/{info?.link_name ?? "cs2tool_demos"}/
            </span>
            . No admin privileges required. The Replay button will automatically
            use the correct path when linked.
          </p>

          <div className="flex gap-2">
            {info?.link_active ? (
              <button
                onClick={handleUnlink}
                disabled={linking}
                className="hud-btn-danger text-[10px] px-4 py-1.5"
              >
                {linking ? "Removing..." : "Unlink"}
              </button>
            ) : (
              <button
                onClick={handleLink}
                disabled={linking || !info?.active_path}
                className="hud-btn-primary text-[10px] px-4 py-1.5"
                title={
                  info?.active_path
                    ? "Create junction from demos/ to CS2"
                    : "Set or detect CS2 path first"
                }
              >
                {linking ? "Linking..." : "Link Demos to CS2"}
              </button>
            )}
          </div>
        </div>

        {/* Feedback message */}
        {message && (
          <p className="text-[10px] text-cs2-accent border-l-2 border-cs2-accent/40 pl-2">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
