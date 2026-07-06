import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CatalogEventEntry,
  CatalogMatchEntry,
  CatalogStatus,
  backfillRosters,
  fetchCatalogMatch,
  getCatalogEvents,
  getCatalogMatches,
  getCatalogStatus,
  refreshCatalog,
} from "../api/client";
import AppHeader from "./AppHeader";

/**
 * Tournaments & matches browser backed by the persistent HLTV catalog.
 * Metadata is near-free; demo files are the expensive part — each map chip
 * shows whether its .dem is already local (▶ opens the replay) or fetchable.
 */
export default function MatchesPage() {
  const navigate = useNavigate();
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
      setError("Could not load the match catalog.");
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
    } catch {
      setError("A catalog task is already running.");
    }
  };

  const onBackfill = async () => {
    try {
      await backfillRosters();
      setStatus((s) => (s ? { ...s, running: true, phase: "backfilling" } : s));
      startPolling();
    } catch {
      setError("A catalog task is already running.");
    }
  };

  const onFetch = async (matchId: number, map?: string) => {
    try {
      await fetchCatalogMatch(matchId, map);
      setStatus((s) => (s ? { ...s, running: true, phase: "queued" } : s));
      startPolling();
    } catch {
      setError("A catalog task is already running.");
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
    ? Math.min(100, (status.demo_disk_used_gb / status.demo_retention_gb) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-[#05070d] text-cs2-text">
      <AppHeader />

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* ── Control bar ──────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Matches</h1>
            <p className="text-xs text-cs2-muted mt-1">
              Recent tournaments and matches from HLTV — fetch demos per map.
            </p>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2 text-xs">
            {[14, 45, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2.5 py-1.5 rounded border text-[11px] font-mono uppercase tracking-wider transition-colors ${
                  days === d
                    ? "border-cs2-accent/60 text-cs2-accent bg-cs2-accent/10"
                    : "border-white/10 text-cs2-muted hover:text-white"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>

          <input
            value={teamQuery}
            onChange={(e) => setTeamQuery(e.target.value)}
            placeholder="Filter team…"
            className="bg-white/[0.04] border border-white/10 rounded px-3 py-1.5 text-sm w-44
                       placeholder:text-cs2-muted/60 focus:outline-none focus:border-cs2-accent/50"
          />

          <button
            onClick={onRefresh}
            disabled={status?.running}
            className="px-3 py-1.5 rounded border border-cs2-accent/50 text-cs2-accent text-xs
                       font-semibold uppercase tracking-wider hover:bg-cs2-accent/10
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {status?.running ? "Working…" : "Refresh from HLTV"}
          </button>
        </div>

        {/* ── Status strip ─────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-8 text-[11px] font-mono text-cs2-muted">
          {status?.running && (
            <span className="text-cs2-accent animate-pulse">
              {status.phase} — {status.detail}
            </span>
          )}
          {!status?.running && status?.last_refresh_unix && (
            <span>
              last refresh {new Date(status.last_refresh_unix * 1000).toLocaleString()}
            </span>
          )}
          {status && (
            <span className="flex items-center gap-2">
              demos {status.demo_disk_used_gb.toFixed(1)} / {status.demo_retention_gb.toFixed(0)} GB
              <span className="inline-block w-28 h-1.5 rounded-full bg-white/10 overflow-hidden">
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
          {status?.autopull_enabled && <span>auto-pull: big events</span>}
          <button
            onClick={onBackfill}
            disabled={status?.running}
            className="underline decoration-dotted hover:text-white disabled:opacity-40"
            title="Write roster sidecars (team/player metadata + photos) for demos uploaded manually"
          >
            backfill rosters
          </button>
        </div>

        {error && (
          <div className="mb-6 text-sm text-cs2-red border border-cs2-red/30 bg-cs2-red/5 rounded px-4 py-2">
            {error}
          </div>
        )}

        {loading && <div className="text-cs2-muted text-sm">Loading catalog…</div>}

        {!loading && grouped.length === 0 && (
          <div className="border border-white/10 rounded-lg p-10 text-center text-cs2-muted">
            <p className="text-sm">The catalog is empty.</p>
            <p className="text-xs mt-2">
              Hit <span className="text-cs2-accent">Refresh from HLTV</span> to pull the
              latest results — metadata only, no demo downloads.
            </p>
          </div>
        )}

        {/* ── Events with their matches ────────────────────────────── */}
        <div className="space-y-8">
          {grouped.map(({ event, big, rows }) => (
            <section key={event}>
              <button
                onClick={() => setEventFilter(eventFilter === event ? null : event)}
                className="flex items-baseline gap-3 mb-3 group"
              >
                <h2 className="text-sm font-bold text-white tracking-wide group-hover:text-cs2-accent transition-colors">
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

              <div className="border border-white/5 rounded-lg divide-y divide-white/5 overflow-hidden">
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 bg-white/[0.015] hover:bg-white/[0.03] transition-colors">
      <span className="w-14 text-[11px] font-mono text-cs2-muted shrink-0">{date}</span>

      <span className="w-10 text-[11px] text-amber-400 shrink-0" title={`${m.stars} star match`}>
        {"★".repeat(m.stars)}
      </span>

      <div className="flex items-center gap-2 min-w-[16rem]">
        <TeamBadge name={m.team1} logo={m.team1_logo} />
        <span className="text-xs font-mono text-cs2-muted">
          {m.score1 !== null && m.score2 !== null ? `${m.score1} : ${m.score2}` : "vs"}
        </span>
        <TeamBadge name={m.team2} logo={m.team2_logo} />
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5 flex-wrap">
        {m.demo_available === 0 && (
          <span className="text-[10px] font-mono text-cs2-muted/60">no demo on HLTV</span>
        )}
        {m.demo_available !== 0 && m.maps.length === 0 && (
          <button
            onClick={() => onFetch(m.match_id)}
            disabled={busy}
            className="text-[11px] font-mono px-2 py-1 rounded border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
              className="text-[11px] font-mono px-2 py-1 rounded border border-cs2-green/50 text-cs2-green hover:bg-cs2-green/10 transition-colors"
              title="Demo is local — open the 2D replay"
            >
              ▶ {tok}
            </button>
          ) : (
            <button
              key={tok}
              onClick={() => onFetch(m.match_id, tok)}
              disabled={busy || m.demo_available === 0}
              className="text-[11px] font-mono px-2 py-1 rounded border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
    <span className="flex items-center gap-1.5 min-w-[6.5rem]">
      {logo && imgOk && (
        <img
          src={logo}
          alt=""
          className="w-4 h-4 object-contain"
          loading="lazy"
          onError={() => setImgOk(false)}
        />
      )}
      <span className="text-sm text-white truncate max-w-[9rem]">{name}</span>
    </span>
  );
}
