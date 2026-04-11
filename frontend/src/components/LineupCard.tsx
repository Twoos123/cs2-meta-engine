/**
 * LineupCard — HUD-styled card for a single ranked lineup.
 *
 * Shows the auto-label, rank badge, technique + click badges, win rate bar,
 * metrics, top throwers, and two action buttons. Success/error feedback is
 * shown as a transient button label rather than an overlay so it never
 * obscures the other button (old behavior: a toast that covered both
 * buttons).
 */
import { useState } from "react";
import {
  LineupRanking,
  getConsoleString,
  practiceLineup,
} from "../api/client";

const GRENADE_ACCENT: Record<string, string> = {
  smokegrenade: "#cbd5e1",
  flashbang: "#fde047",
  hegrenade: "#f87171",
  molotov: "#fb923c",
  decoy: "#9ca3af",
};

const TECHNIQUE_LABEL: Record<string, string> = {
  stand: "Stand",
  walk: "Walk",
  run: "Run",
  crouch: "Crouch",
  jump: "Jump",
  running_jump: "Run + Jump",
};

const CLICK_LABEL: Record<string, string> = {
  left: "Left",
  right: "Right",
  both: "Left + Right",
};

interface Props {
  ranking: LineupRanking;
  selected?: boolean;
}

type ButtonState = "idle" | "loading" | "success" | "error";

export default function LineupCard({ ranking, selected = false }: Props) {
  const { rank, cluster, impact_score } = ranking;
  const [copyState, setCopyState] = useState<ButtonState>("idle");
  const [practiceState, setPracticeState] = useState<ButtonState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const flashState = (
    setter: (s: ButtonState) => void,
    state: ButtonState,
    ms = 1800,
  ) => {
    setter(state);
    setTimeout(() => setter("idle"), ms);
  };

  const handleCopy = async () => {
    setCopyState("loading");
    setErrorMsg(null);
    try {
      const res = await getConsoleString(cluster.cluster_id, cluster.map_name);
      await navigator.clipboard.writeText(res.console_string);
      flashState(setCopyState, "success");
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.detail ?? "Copy failed");
      flashState(setCopyState, "error");
    }
  };

  const handlePractice = async () => {
    setPracticeState("loading");
    setErrorMsg(null);
    try {
      const res = await practiceLineup(cluster.cluster_id, cluster.map_name);
      if (res.success) {
        flashState(setPracticeState, "success");
      } else {
        setErrorMsg(res.error || "RCON failed");
        flashState(setPracticeState, "error");
      }
    } catch {
      setErrorMsg("RCON connection failed — is CS2 running?");
      flashState(setPracticeState, "error");
    }
  };

  const accent = GRENADE_ACCENT[cluster.grenade_type] ?? "#94a3b8";
  const winPct = (cluster.round_win_rate * 100).toFixed(1);
  const winBarWidth = Math.round(cluster.round_win_rate * 100);

  const techniqueText = cluster.primary_technique
    ? TECHNIQUE_LABEL[cluster.primary_technique] ?? cluster.primary_technique
    : null;
  const clickText = cluster.primary_click
    ? CLICK_LABEL[cluster.primary_click] ?? cluster.primary_click
    : null;

  const copyLabel =
    copyState === "loading"
      ? "Copying…"
      : copyState === "success"
      ? "Copied ✓"
      : copyState === "error"
      ? "Failed"
      : "Copy Console";

  const practiceLabel =
    practiceState === "loading"
      ? "Sending…"
      : practiceState === "success"
      ? "Teleported ✓"
      : practiceState === "error"
      ? "RCON error"
      : "Practice";

  return (
    <div
      className={`hud-panel p-4 flex flex-col gap-3 transition-all duration-150 group ${
        selected
          ? "border-cs2-accent shadow-[0_0_28px_rgba(34,211,238,0.35)] -translate-y-0.5"
          : "hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(34,211,238,0.12)]"
      }`}
      style={{ borderTopColor: accent, borderTopWidth: 2 }}
    >
      {/* Rank badge */}
      <div
        className="absolute -top-3 -left-2 px-2 h-6 min-w-[2rem] rounded-md border border-cs2-accent/60 bg-cs2-bg flex items-center justify-center text-[11px] font-mono font-bold text-cs2-accent shadow-[0_0_12px_rgba(34,211,238,0.25)]"
      >
        #{rank}
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-2 mt-1">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-white leading-tight truncate">
            {cluster.label ?? `Cluster ${cluster.cluster_id}`}
          </p>
          <p className="text-[10px] text-cs2-muted mt-1 uppercase tracking-[0.15em]">
            {cluster.throw_count} throws · impact{" "}
            <span className="text-cs2-accent font-mono normal-case tracking-normal">
              {impact_score.toFixed(3)}
            </span>
          </p>
        </div>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded-md border capitalize shrink-0"
          style={{ borderColor: accent, color: accent }}
        >
          {cluster.grenade_type.replace("grenade", "")}
        </span>
      </div>

      {/* Technique / click badges */}
      {(techniqueText || clickText) && (
        <div className="flex flex-wrap gap-1.5 -mt-1">
          {techniqueText && (
            <span
              className="text-[10px] font-mono uppercase tracking-[0.1em] px-2 py-0.5 rounded border border-cs2-accent/40 bg-cs2-accent/10 text-cs2-accent"
              title={`${(cluster.technique_agreement * 100).toFixed(0)}% of throws agree`}
            >
              {techniqueText}
              {cluster.technique_agreement < 1 && (
                <span className="text-cs2-accent/60 ml-1">
                  {(cluster.technique_agreement * 100).toFixed(0)}%
                </span>
              )}
            </span>
          )}
          {clickText && (
            <span
              className="text-[10px] font-mono uppercase tracking-[0.1em] px-2 py-0.5 rounded border border-cs2-blue/40 bg-cs2-blue/10 text-cs2-blue"
              title={`${(cluster.click_agreement * 100).toFixed(0)}% of throws agree`}
            >
              {clickText} click
              {cluster.click_agreement < 1 && (
                <span className="text-cs2-blue/60 ml-1">
                  {(cluster.click_agreement * 100).toFixed(0)}%
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Win rate bar */}
      <div>
        <div className="flex justify-between text-[10px] text-cs2-muted uppercase tracking-[0.12em] mb-1">
          <span>Round Win Rate</span>
          <span className="text-cs2-green font-mono tracking-normal normal-case">{winPct}%</span>
        </div>
        <div className="h-1 rounded-full bg-cs2-border/70 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cs2-green to-cs2-accent transition-all duration-500"
            style={{ width: `${winBarWidth}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
        <span className="text-cs2-muted uppercase tracking-[0.1em]">Avg Dmg</span>
        <span className="font-mono text-cs2-red text-right">
          {cluster.avg_utility_damage.toFixed(1)} HP
        </span>

        <span className="text-cs2-muted uppercase tracking-[0.1em]">Stand</span>
        <span className="font-mono text-gray-300 text-right">
          {cluster.throw_centroid_x.toFixed(0)},{cluster.throw_centroid_y.toFixed(0)}
        </span>

        <span className="text-cs2-muted uppercase tracking-[0.1em]">Land</span>
        <span className="font-mono text-gray-300 text-right">
          {cluster.land_centroid_x.toFixed(0)},{cluster.land_centroid_y.toFixed(0)}
        </span>

        <span className="text-cs2-muted uppercase tracking-[0.1em]">Angle</span>
        <span className="font-mono text-gray-300 text-right">
          P{cluster.avg_pitch.toFixed(0)} Y{cluster.avg_yaw.toFixed(0)}
        </span>
      </div>

      {/* Top throwers */}
      {cluster.top_throwers && cluster.top_throwers.length > 0 && (
        <div>
          <p className="text-[9px] text-cs2-muted uppercase tracking-[0.15em] mb-1">
            Thrown by
          </p>
          <div className="flex flex-wrap gap-1">
            {cluster.top_throwers.map((t) => (
              <span
                key={t.name}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cs2-panel/80 border border-cs2-border text-gray-300"
                title={`${t.count} throw${t.count === 1 ? "" : "s"}`}
              >
                {t.name}
                <span className="text-cs2-muted"> ×{t.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Error message — shown inline so it never overlaps buttons */}
      {errorMsg && (
        <p className="text-[10px] text-cs2-red border-l-2 border-cs2-red/50 pl-2">
          {errorMsg}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 mt-auto pt-1">
        <button
          onClick={handleCopy}
          disabled={copyState === "loading"}
          className={
            copyState === "success"
              ? "hud-btn-primary flex-1"
              : copyState === "error"
              ? "hud-btn-danger flex-1"
              : "hud-btn flex-1"
          }
        >
          {copyLabel}
        </button>
        <button
          onClick={handlePractice}
          disabled={practiceState === "loading"}
          className={
            practiceState === "error"
              ? "hud-btn-danger flex-1"
              : "hud-btn-primary flex-1"
          }
        >
          {practiceLabel}
        </button>
      </div>
    </div>
  );
}
