import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CatalogEventEntry,
  CatalogMatchEntry,
  CatalogStatus,
  CatalogTier,
  apiErrorMessage,
  getCatalogEvents,
  getCatalogMatches,
  getCatalogStatus,
  refreshCatalog,
} from "../api/catalog";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import { useReveal } from "../hooks/useReveal";

const DAY_RANGES = [14, 45, 90, 365] as const;
const STATUS_TABS = [
  { id: "all", label: "All" },
  { id: "completed", label: "Results" },
  { id: "upcoming", label: "Upcoming" },
] as const;
type StatusTab = (typeof STATUS_TABS)[number]["id"];

const LIQUIPEDIA_MATCHES_URL = "https://liquipedia.net/counterstrike/Liquipedia:Matches";
const CC_BY_SA_URL = "https://creativecommons.org/licenses/by-sa/3.0/";

/**
 * Tournaments & matches browser backed by the persistent catalog, which is
 * fed by Liquipedia (CC-BY-SA — attribution shown on the page). The server
 * no longer downloads demos (HLTV blocks it): each match opens on HLTV,
 * where the browser extension sends the demo back, and demos already on
 * disk open straight in the 2D replay.
 */
export default function MatchesPage() {
  const navigate = useNavigate();
  const hero = useReveal<HTMLDivElement>();
  const [events, setEvents] = useState<CatalogEventEntry[]>([]);
  const [matches, setMatches] = useState<CatalogMatchEntry[]>([]);
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [days, setDays] = useState(45);
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [teamQuery, setTeamQuery] = useState("");
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [ev, ms, st] = await Promise.all([
        getCatalogEvents(days),
        getCatalogMatches({
          days,
          event: eventFilter ?? undefined,
          team: teamQuery || undefined,
          status: statusTab === "all" ? undefined : statusTab,
          limit: 400,
        }),
        getCatalogStatus(),
      ]);
      setEvents(ev);
      setMatches(ms);
      setStatus(st);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, "Could not load the match catalog."));
    } finally {
      setLoading(false);
    }
  }, [days, eventFilter, teamQuery, statusTab]);

  useEffect(() => {
    load();
  }, [load]);

  // While a refresh runs, poll status; reload data when it finishes.
  const startPolling = useCallback(() => {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const st = await getCatalogStatus();
        setStatus(st);
        if (!st.running) {
          if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          load();
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
  }, [load]);

  useEffect(() => {
    if (status?.running) startPolling();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running]);

  const onRefresh = async () => {
    try {
      await refreshCatalog();
      setStatus((s) => (s ? { ...s, running: true, phase: "queued" } : s));
      startPolling();
    } catch (e) {
      setError(apiErrorMessage(e, "A catalog refresh is already running."));
    }
  };

  // Group matches by event, ordered by each event's most recent match.
  const grouped: { event: string; info: CatalogEventEntry | undefined; rows: CatalogMatchEntry[] }[] = [];
  {
    const byEvent = new Map<string, CatalogMatchEntry[]>();
    for (const m of matches) {
      const list = byEvent.get(m.event) ?? [];
      list.push(m);
      byEvent.set(m.event, list);
    }
    const info = new Map(events.map((e) => [e.event, e]));
    for (const [event, rows] of byEvent) {
      grouped.push({ event, info: info.get(event), rows });
    }
    grouped.sort((a, b) => (b.rows[0]?.date_unix ?? 0) - (a.rows[0]?.date_unix ?? 0));
  }

  const diskPct = status
    ? Math.min(100, (status.demo_disk_used_gb / Math.max(1e-6, status.demo_retention_gb)) * 100)
    : 0;

  return (
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#05070d] text-cs2-text">
      <AppBackdrop tone="amber" />
      <AppHeader
        actions={
          <button
            onClick={onRefresh}
            disabled={status?.running}
            className="hud-btn-primary"
            title="Pull the latest matches from Liquipedia (cached and rate-limited)"
          >
            {status?.running ? "Working…" : "Refresh"}
          </button>
        }
      />

      <div
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 md:px-6 pt-8 pb-12"
        style={{ scrollbarWidth: "thin" }}
      >
        <div className="max-w-6xl mx-auto w-full space-y-8">
          {/* ── Page hero ── */}
          <div ref={hero.ref} className={`reveal ${hero.shown ? "in" : ""}`}>
            <span className="section-eyebrow" style={{ color: "#fdba74" }}>BROWSE</span>
            <h1 className="page-title mt-3">
              Tournaments &amp; <span className="accent">matches</span>
            </h1>
            <p className="mt-3 text-sm text-cs2-muted leading-relaxed max-w-2xl">
              Recent results and upcoming matches. Open a match on HLTV and use the
              browser extension's <span className="text-white">Send to CS2 Meta Engine</span>{" "}
              button to import its demo — demos already on disk open straight in the 2D
              replay.
            </p>
            <LiquipediaCredit className="mt-3" />
          </div>

          {/* ── Filters + catalog status ── */}
          <div className="hud-panel p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-4">
              <div className="space-y-1.5">
                <label className="block text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">
                  Range
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_RANGES.map((d) => (
                    <button
                      key={d}
                      onClick={() => setDays(d)}
                      className={`hud-tab ${days === d ? "hud-tab-active" : "hud-tab-idle"} font-mono`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">
                  Show
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {STATUS_TABS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setStatusTab(t.id)}
                      className={`hud-tab ${statusTab === t.id ? "hud-tab-active" : "hud-tab-idle"}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5 w-full sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-sm">
                <label className="block text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">
                  Team
                </label>
                <input
                  type="text"
                  value={teamQuery}
                  onChange={(e) => setTeamQuery(e.target.value)}
                  placeholder="Filter team…"
                  className="hud-input w-full"
                />
              </div>

              {eventFilter && (
                <div className="space-y-1.5 min-w-0">
                  <label className="block text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">
                    Event
                  </label>
                  <button
                    onClick={() => setEventFilter(null)}
                    className="hud-tab hud-tab-active flex items-center gap-2 max-w-full"
                    title="Clear the event filter"
                  >
                    <span className="truncate">{eventFilter}</span>
                    <span aria-hidden>×</span>
                  </button>
                </div>
              )}

              <span className="sm:ml-auto text-[11px] text-cs2-muted font-mono sm:self-center">
                {matches.length} {matches.length === 1 ? "match" : "matches"} · {grouped.length}{" "}
                {grouped.length === 1 ? "event" : "events"}
              </span>
            </div>

            <div className="h-px bg-white/5" />

            {/* Status strip */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] font-mono text-cs2-muted">
              {status?.running && (
                <span className="flex items-center gap-2 text-cs2-accent min-w-0 max-w-full">
                  <span className="inline-block w-2 h-2 rounded-full bg-cs2-accent animate-pulse shrink-0" />
                  <span className="truncate">
                    {status.phase}
                    {status.detail ? ` — ${status.detail}` : ""}
                  </span>
                </span>
              )}
              {!status?.running && (
                <span>
                  {status?.last_refresh_unix
                    ? `last refresh ${new Date(status.last_refresh_unix * 1000).toLocaleString()}`
                    : "never refreshed"}
                  {status?.phase === "error" && status.detail && (
                    <span className="text-red-300"> · {status.detail}</span>
                  )}
                </span>
              )}
              {status && (
                <span className="flex items-center gap-2">
                  demos {status.demo_disk_used_gb.toFixed(1)} / {status.demo_retention_gb.toFixed(0)} GB
                  <span className="inline-block w-24 sm:w-28 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${diskPct}%`,
                        background: diskPct > 85 ? "#f87171" : "#4ade80",
                      }}
                    />
                  </span>
                </span>
              )}
            </div>
          </div>

          {error && (
            <div
              className="hud-panel p-4 text-[12px]"
              style={{ borderColor: "rgba(248,113,113,0.4)", color: "#fca5a5" }}
            >
              {error}
            </div>
          )}

          {loading && (
            <div className="hud-panel p-10 text-center text-cs2-muted text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-cs2-accent animate-pulse-glow mr-2" />
              Loading catalog…
            </div>
          )}

          {!loading && grouped.length === 0 && !error && (
            <div className="hud-panel hud-corner px-6 py-12 sm:p-14 text-center">
              <div className="mx-auto w-12 h-12 rounded-xl border border-amber-400/30 bg-amber-400/10 flex items-center justify-center text-amber-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6" aria-hidden>
                  <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" strokeLinejoin="round" />
                  <path d="M17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="mt-5 text-base font-semibold text-white">
                {teamQuery || eventFilter || statusTab !== "all"
                  ? "No matches for these filters"
                  : "The catalog is empty"}
              </p>
              <p className="mt-2 text-sm text-cs2-muted leading-relaxed max-w-md mx-auto">
                {teamQuery || eventFilter || statusTab !== "all" ? (
                  "Try a wider day range or clear the filters."
                ) : (
                  <>
                    Hit <span className="text-cs2-accent">Refresh</span> to pull recent and
                    upcoming matches from Liquipedia.
                  </>
                )}
              </p>
            </div>
          )}

          {/* ── Events with their matches ── */}
          {grouped.map(({ event, info, rows }) => (
            <section key={event} className="hud-panel overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 border-b border-white/5 bg-white/[0.02]">
                <button
                  onClick={() => setEventFilter(eventFilter === event ? null : event)}
                  className="text-left min-w-0 max-w-full group"
                  title={eventFilter === event ? "Show all events" : "Show only this event"}
                >
                  <h2 className="text-sm font-bold text-white tracking-wide group-hover:text-cs2-accent transition-colors break-words">
                    {event}
                  </h2>
                </button>
                <TierBadge tier={info?.tier ?? rows[0]?.tier ?? null} />
                {info?.big && !info.tier && (
                  <span className="text-[9px] font-mono uppercase tracking-widest text-amber-400 border border-amber-400/40 rounded px-1.5 py-0.5">
                    big event
                  </span>
                )}
                <span className="text-[11px] font-mono text-cs2-muted">
                  {rows.length} {rows.length === 1 ? "match" : "matches"}
                </span>
                {info?.liquipedia_url && (
                  <a
                    href={info.liquipedia_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[11px] font-mono text-cs2-muted hover:text-white underline decoration-dotted"
                    title="Open the tournament on Liquipedia"
                  >
                    Liquipedia ↗
                  </a>
                )}
              </div>

              <div className="divide-y divide-white/5">
                {rows.map((m) => (
                  <MatchRow
                    key={m.match_key}
                    m={m}
                    onOpen={(file) => navigate(`/replay/${encodeURIComponent(file)}`)}
                  />
                ))}
              </div>
            </section>
          ))}

          {!loading && grouped.length > 0 && (
            <div className="text-center">
              <LiquipediaCredit />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LiquipediaCredit({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] text-cs2-muted ${className}`}>
      Data from{" "}
      <a
        href={LIQUIPEDIA_MATCHES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted hover:text-white"
      >
        Liquipedia
      </a>{" "}
      (
      <a
        href={CC_BY_SA_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted hover:text-white"
      >
        CC-BY-SA
      </a>
      )
    </p>
  );
}

const TIER_STYLE: Record<string, string> = {
  S: "text-amber-300 border-amber-400/50 bg-amber-400/10",
  A: "text-cs2-accent border-cs2-accent/50 bg-cs2-accent/10",
  B: "text-sky-300 border-sky-400/40",
  C: "text-cs2-muted border-white/15",
};

function TierBadge({ tier }: { tier: CatalogTier | null }) {
  if (!tier) return null;
  const letter = tier.length === 1;
  return (
    <span
      className={`text-[9px] font-mono uppercase tracking-widest border rounded px-1.5 py-0.5 shrink-0 ${
        TIER_STYLE[tier] ?? "text-cs2-muted border-white/15"
      }`}
      title={`Liquipedia ${letter ? `${tier}-Tier` : tier} tournament`}
    >
      {letter ? `${tier}-tier` : tier}
    </span>
  );
}

function MatchRow({
  m,
  onOpen,
}: {
  m: CatalogMatchEntry;
  onOpen: (demoFile: string) => void;
}) {
  const d = m.date_unix ? new Date(m.date_unix * 1000) : null;
  const upcoming = m.status === "upcoming";
  const date = d
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "—";
  // Started but not finished on Liquipedia yet.
  const live = upcoming && d !== null && d.getTime() <= Date.now();
  const time = d && upcoming && !live
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;
  const played = m.score1 !== null && m.score2 !== null;

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4 px-4 py-3 hover:bg-white/[0.03] transition-colors">
      {/* Date / format — own line on phones, fixed columns on desktop. */}
      <div className="flex items-center gap-3 md:gap-4 shrink-0 text-[11px] font-mono text-cs2-muted whitespace-nowrap">
        <span className="md:w-14">{date}</span>
        {time && <span className="text-cs2-accent md:w-16">{time}</span>}
        {live && (
          <span className="md:w-16 text-red-400 font-bold tracking-widest" title="In progress">
            LIVE
          </span>
        )}
        {m.best_of && <span className="md:w-8">Bo{m.best_of}</span>}
        {m.stage && <span className="truncate max-w-[10rem] md:hidden">{m.stage}</span>}
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <TeamName name={m.team1} won={played && m.score1! > m.score2!} alignRight />
        <span className="text-xs font-mono text-cs2-muted shrink-0 md:w-12 text-center">
          {played ? `${m.score1} : ${m.score2}` : "vs"}
        </span>
        <TeamName name={m.team2} won={played && m.score2! > m.score1!} />
      </div>

      {m.stage && (
        <span className="hidden md:inline text-[11px] font-mono text-cs2-muted truncate max-w-[12rem]">
          {m.stage}
        </span>
      )}

      <div className="hidden md:block flex-1" />

      <div className="flex items-center gap-1.5 flex-wrap">
        {m.local_demos.map((file) => {
          const tok = file.replace(/\.dem$/, "").split("_").slice(1).join("_") || "demo";
          return (
            <button
              key={file}
              onClick={() => onOpen(file)}
              className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-cs2-green/50 text-cs2-green hover:bg-cs2-green/10 transition-colors"
              title={`${file} is on disk — open the 2D replay`}
            >
              ▶ {tok}
            </button>
          );
        })}
        {m.local_demos.length === 0 && m.maps.length > 0 && (
          <span className="text-[10px] font-mono text-cs2-muted/70 truncate max-w-full">
            {m.maps.join(" · ")}
          </span>
        )}
        {m.hltv_url && (
          <a
            href={m.hltv_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 transition-colors"
            title="Open the HLTV match page — the browser extension can send its demo here"
          >
            Open on HLTV ↗
          </a>
        )}
        {m.liquipedia_url && (
          <a
            href={m.liquipedia_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-white/15 text-cs2-muted hover:text-white hover:bg-white/5 transition-colors"
            title="Open the match's tournament page on Liquipedia"
          >
            Open on Liquipedia ↗
          </a>
        )}
      </div>
    </div>
  );
}

function TeamName({
  name,
  won,
  alignRight = false,
}: {
  name: string;
  won: boolean;
  alignRight?: boolean;
}) {
  return (
    <span
      className={`text-sm truncate min-w-0 max-w-[9rem] md:max-w-none md:w-40 ${
        alignRight ? "md:text-right" : ""
      } ${won ? "text-white font-semibold" : "text-white/80"}`}
      title={name}
    >
      {name}
    </span>
  );
}
