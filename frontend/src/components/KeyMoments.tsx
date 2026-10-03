/**
 * KeyMoments — compact, filterable list of a match's key moments (entries,
 * multi-kills, clutches, bomb plays, eco/force wins). Clicking an entry seeks
 * playback; each entry can also be copied as a shareable replay link.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MatchTimeline } from "../api/client";
import { KeyMoment, MomentKind, copyText, replayLinkForTick, roundAnchorTick } from "../lib/keyMoments";

interface Props {
  timeline: MatchTimeline;
  demoFile: string;
  moments: KeyMoment[];
  currentRound: number;
  onJump: (tick: number) => void;
  /** Height cap for the scrolling list. */
  listClassName?: string;
}

const KIND_META: Record<MomentKind, { label: string; color: string }> = {
  entry: { label: "Entry", color: "#22d3ee" },
  multi: { label: "Multi", color: "#f472b6" },
  clutch: { label: "Clutch", color: "#a78bfa" },
  plant: { label: "Plant", color: "#f87171" },
  defuse: { label: "Defuse", color: "#5B9BD5" },
  eco: { label: "Eco win", color: "#4ade80" },
};

const SIDE_COLOR: Record<number, string> = { 2: "#DCBF6E", 3: "#5B9BD5", 0: "#94a3b8" };

const KINDS = Object.keys(KIND_META) as MomentKind[];

export default function KeyMoments({
  timeline, demoFile, moments, currentRound, onJump, listClassName = "max-h-56",
}: Props) {
  const [scope, setScope] = useState<"all" | "round">("all");
  const [kinds, setKinds] = useState<Set<MomentKind>>(() => new Set(KINDS));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const counts = useMemo(() => {
    const c: Partial<Record<MomentKind, number>> = {};
    for (const m of moments) c[m.kind] = (c[m.kind] ?? 0) + 1;
    return c;
  }, [moments]);

  const visible = useMemo(
    () => moments.filter((m) => kinds.has(m.kind) && (scope === "all" || m.round === currentRound)),
    [moments, kinds, scope, currentRound],
  );

  // Keep the current round's first moment in view while "All" is shown.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scope !== "all") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-round="${currentRound}"]`);
    // The list is `relative`, so offsetTop is measured from its top edge.
    if (el && listRef.current) listRef.current.scrollTo({ top: el.offsetTop, behavior: "smooth" });
  }, [currentRound, scope]);

  const roundByNum = useMemo(() => {
    const m = new Map<number, (typeof timeline.rounds)[number]>();
    for (const r of timeline.rounds) m.set(r.num, r);
    return m;
  }, [timeline]);

  const fmtRoundTime = (m: KeyMoment) => {
    const r = roundByNum.get(m.round);
    const secs = r ? Math.max(0, Math.floor((m.tick - roundAnchorTick(r)) / 64)) : 0;
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  };

  const copyLink = async (m: KeyMoment) => {
    const url = replayLinkForTick(timeline, demoFile, m.seekTick);
    if (!url) return;
    if (await copyText(url)) {
      setCopiedId(m.id);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
    }
  };

  const toggleKind = (k: MomentKind) =>
    setKinds((prev) => {
      // First click on a chip while everything is on → solo that kind.
      if (prev.size === KINDS.length) return new Set([k]);
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next.size === 0 ? new Set(KINDS) : next;
    });

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-1">
        <div className="flex rounded border border-white/10 overflow-hidden shrink-0">
          {(["all", "round"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-2.5 py-1.5 lg:py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                scope === s ? "bg-cs2-accent/15 text-cs2-accent" : "text-cs2-muted hover:text-white"
              }`}
            >
              {s === "all" ? "All" : `R${currentRound}`}
            </button>
          ))}
        </div>
        {KINDS.filter((k) => counts[k]).map((k) => {
          const active = kinds.has(k) && kinds.size !== KINDS.length;
          const meta = KIND_META[k];
          return (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              className="px-2 py-1.5 lg:py-0.5 rounded text-[11px] font-mono uppercase tracking-wide border transition-all"
              style={{
                borderColor: active ? meta.color : "rgba(255,255,255,0.08)",
                background: active ? `${meta.color}20` : "transparent",
                color: active || kinds.size === KINDS.length ? meta.color : "#64748b",
              }}
              title={`Show only ${meta.label.toLowerCase()} moments`}
            >
              {meta.label} {counts[k]}
            </button>
          );
        })}
        {kinds.size !== KINDS.length && (
          <button onClick={() => setKinds(new Set(KINDS))} className="text-[11px] text-cs2-accent/70 hover:text-cs2-accent px-1">
            Reset
          </button>
        )}
      </div>

      {/* List */}
      <div ref={listRef} className={`${listClassName} overflow-y-auto relative`} style={{ scrollbarWidth: "thin" }}>
        {visible.length === 0 ? (
          <p className="text-[11px] text-cs2-muted px-1 py-2">
            {scope === "round" ? `No key moments in round ${currentRound}.` : "No key moments match these filters."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((m) => {
              const meta = KIND_META[m.kind];
              const isCurrent = m.round === currentRound;
              return (
                <li
                  key={m.id}
                  data-round={m.round}
                  className={`flex items-center gap-1 rounded border ${
                    isCurrent ? "border-cs2-accent/25 bg-cs2-accent/[0.06]" : "border-transparent hover:bg-white/[0.04]"
                  }`}
                >
                  <button
                    onClick={() => onJump(m.seekTick)}
                    className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1.5 lg:py-1 text-left"
                    title="Jump to this moment"
                  >
                    <span className="font-mono text-[10px] text-cs2-muted w-14 shrink-0 tabular-nums">
                      R{m.round} {fmtRoundTime(m)}
                    </span>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
                    <span className="min-w-0 flex-1 truncate text-[11px]">
                      <span className="font-semibold" style={{ color: m.kind === "clutch" ? (m.won ? "#4ade80" : "#f87171") : meta.color }}>
                        {m.title}
                      </span>
                      <span className="text-gray-300"> · </span>
                      <span style={{ color: SIDE_COLOR[m.side] }}>{m.detail}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => copyLink(m)}
                    className="shrink-0 px-2 py-1.5 lg:py-1 text-[10px] uppercase tracking-wide text-cs2-muted hover:text-cs2-accent"
                    title="Copy a link to this moment"
                    aria-label={`Copy link to ${m.title}`}
                  >
                    {copiedId === m.id ? "Copied" : "Link"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
