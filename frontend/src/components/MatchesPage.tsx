import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CatalogEventEntry,
  CatalogMatchEntry,
  CatalogStatus,
  apiErrorMessage,
  backfillRosters,
  fetchCatalogMatch,
  getCatalogEvents,
  getCatalogMatches,
  getCatalogStatus,
  refreshCatalog,
} from "../api/client";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import { useReveal } from "../hooks/useReveal";

const DAY_RANGES = [14, 45, 90] as const;

/**
 * Tournaments & matches browser backed by the persistent HLTV catalog.
 * Metadata is near-free; demo files are the expensive part — each map chip
 * shows whether its .dem is already local (▶ opens the replay) or fetchable.
 */
export default function MatchesPage() {
  const navigate = useNavigate();
  const hero = useReveal<HTMLDivElement>();
  const [events, setEvents] = useState<CatalogEventEntry[]>([]);
  const [matches, setMatches] = useState<CatalogMatchEntry[]>([]);
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [days, setDays] = useState(45);
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
  }, [days, eventFilter, teamQuery]);

  useEffect(() => {
    load();
  }, [load]);

  // While a background task runs, poll status; reload data when it finishes.
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
      setError(apiErrorMessage(e, "A catalog task is already running."));
    }
  };

  const onBackfill = async () => {
    try {
      await backfillRosters();
      setStatus((s) => (s ? { ...s, running: true, phase: "backfilling" } : s));
      startPolling();
    } catch (e) {
      setError(apiErrorMessage(e, "A catalog task is already running."));
    }
  };

  const onFetch = async (matchId: number, map?: string) => {
    try {
      await fetchCatalogMatch(matchId, map);
      setStatus((s) => (s ? { ...s, running: true, phase: "queued" } : s));
      startPolling();
    } catch (e) {
      setError(apiErrorMessage(e, "A catalog task is already running."));
    }
  };

  // Group matches by event, ordered by each event's most recent match.
  const grouped: { event: string; big: boolean; rows: CatalogMatchEntry[] }[] = [];
  {
    const byEvent = new Map<string, CatalogMatchEntry[]>();
    for (const m of matches) {
      const list = byEvent.get(m.event) ?? [];
      list.push(m);
      byEvent.set(m.event, list);
    }
    const bigness = new Map(events.map((e) => [e.event, e.big]));
    for (const [event, rows] of byEvent) {
      grouped.push({ event, big: bigness.get(event) ?? false, rows });
    }
    grouped.sort(
      (a, b) => (b.rows[0]?.date_unix ?? 0) - (a.rows[0]?.date_unix ?? 0),
    );
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
            title="Pull the latest HLTV results — metadata only, no demo downloads"
          >
            {status?.running ? "Working…" : "Refresh from HLTV"}
          </button>
        }
      />

      <div
        className="relative flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-8 pb-12"
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
              Recent events and results from HLTV. Metadata is free to browse —
              fetch demos per map, or open any map that's already on disk in
              the 2D replay.
            </p>
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
                <span className="flex items-center gap-2 text-cs2-accent min-w-0">
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
              {status?.autopull_enabled && (
                <span className="text-amber-300/80">auto-pull: big events</span>
              )}
              <button
                onClick={onBackfill}
                disabled={status?.running}
                className="underline decoration-dotted hover:text-white disabled:opacity-40"
                title="Write roster sidecars (team/player metadata + photos) for demos uploaded manually"
              >
                backfill rosters
              </button>
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
                {teamQuery || eventFilter ? "No matches for these filters" : "The catalog is empty"}
              </p>
              <p className="mt-2 text-sm text-cs2-muted leading-relaxed max-w-md mx-auto">
                {teamQuery || eventFilter ? (
                  "Try a wider day range or clear the team / event filter."
                ) : (
                  <>
                    Hit <span className="text-cs2-accent">Refresh from HLTV</span> to pull the
                    latest results — metadata only, no demo downloads.
                  </>
                )}
              </p>
            </div>
          )}

          {/* ── Events with their matches ── */}
          {grouped.map(({ event, big, rows }) => (
            <section key={event} className="hud-panel overflow-hidden">
              <button
                onClick={() => setEventFilter(eventFilter === event ? null : event)}
                className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b border-white/5 bg-white/[0.02] text-left group"
                title={eventFilter === event ? "Show all events" : "Show only this event"}
              >
                <h2 className="text-sm font-bold text-white tracking-wide group-hover:text-cs2-accent transition-colors min-w-0 break-words">
                  {event}
                </h2>
                {big && (
                  <span className="text-[9px] font-mono uppercase tracking-widest text-amber-400 border border-amber-400/40 rounded px-1.5 py-0.5">
                    big event
                  </span>
                )}
                <span className="text-[11px] font-mono text-cs2-muted">
                  {rows.length} {rows.length === 1 ? "match" : "matches"}
                </span>
              </button>

              <div className="divide-y divide-white/5">
                {rows.map((m) => (
                  <MatchRow
                    key={m.match_id}
                    m={m}
                    busy={!!status?.running}
                    onFetch={onFetch}
                    onOpen={(file) => navigate(`/replay/${encodeURIComponent(file)}`)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function MatchRow({
  m,
  busy,
  onFetch,
  onOpen,
}: {
  m: CatalogMatchEntry;
  busy: boolean;
  onFetch: (matchId: number, map?: string) => void;
  onOpen: (demoFile: string) => void;
}) {
  const date = m.date_unix
    ? new Date(m.date_unix * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "—";

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4 px-4 py-3 hover:bg-white/[0.03] transition-colors">
      {/* Date + stars — own line on phones, fixed columns on desktop. */}
      <div className="flex items-center gap-3 md:gap-4 shrink-0">
        <span className="md:w-14 text-[11px] font-mono text-cs2-muted">{date}</span>
        <span className="md:w-10 text-[11px] text-amber-400" title={`${m.stars} star match`}>
          {"★".repeat(m.stars)}
        </span>
      </div>

      <div className="flex items-center gap-2 min-w-0 md:min-w-[16rem]">
        <TeamBadge name={m.team1} logo={m.team1_logo} />
        <span className="text-xs font-mono text-cs2-muted shrink-0">
          {m.score1 !== null && m.score2 !== null ? `${m.score1} : ${m.score2}` : "vs"}
        </span>
        <TeamBadge name={m.team2} logo={m.team2_logo} />
      </div>

      <div className="hidden md:block flex-1" />

      <div className="flex items-center gap-1.5 flex-wrap">
        {m.demo_available === 0 && (
          <span className="text-[10px] font-mono text-cs2-muted/60">no demo on HLTV</span>
        )}
        {m.demo_available !== 0 && m.maps.length === 0 && (
          <button
            onClick={() => onFetch(m.match_id)}
            disabled={busy}
            className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Resolve maps and download demos for this match"
          >
            ↓ fetch match
          </button>
        )}
        {m.maps.map((tok) => {
          const local = m.local_maps.includes(tok);
          return local ? (
            <button
              key={tok}
              onClick={() => onOpen(`${m.match_id}_${tok}.dem`)}
              className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-cs2-green/50 text-cs2-green hover:bg-cs2-green/10 transition-colors"
              title="Demo is local — open the 2D replay"
            >
              ▶ {tok}
            </button>
          ) : (
            <button
              key={tok}
              onClick={() => onFetch(m.match_id, tok)}
              disabled={busy || m.demo_available === 0}
              className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title={`Download the ${tok} demo (~250 MB)`}
            >
              ↓ {tok}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TeamBadge({ name, logo }: { name: string; logo: string | null }) {
  const [imgOk, setImgOk] = useState(true);
  return (
    <span className="flex items-center gap-1.5 min-w-0 md:min-w-[6.5rem]">
      {logo && imgOk && (
        <img
          src={logo}
          alt=""
          className="w-4 h-4 object-contain shrink-0"
          loading="lazy"
          onError={() => setImgOk(false)}
        />
      )}
      <span className="text-sm text-white truncate max-w-[9rem]">{name}</span>
    </span>
  );
}
