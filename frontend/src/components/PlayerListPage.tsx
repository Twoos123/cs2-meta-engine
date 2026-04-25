import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  MatchInfoResponse,
  PlayerProfileSummary,
  clearPlayerPhotos,
  getMatchInfo,
  getMatchReplayDemos,
  getPlayerHltvIds,
  listPlayers,
  refreshPlayerStats,
  refreshRosters,
  warmPlayerPhotos,
  warmPlayerPhotosStatus,
} from "../api/client";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import Select from "./Select";
import PlayerAvatar from "./PlayerAvatar";
import { useReveal } from "../hooks/useReveal";

type SortKey = "rating" | "kd" | "kills" | "hs" | "openwr" | "matches";

const ROLE_COLORS: Record<string, string> = {
  AWP: "#5B9BD5",
  Entry: "#f87171",
  Support: "#4ade80",
  Lurker: "#c084fc",
  Rifler: "#22d3ee",
};

interface TeamsIndex {
  /** player name (lowercased) → array of team names this player has appeared on. */
  playerToTeams: Map<string, string[]>;
  /** sorted list of team names found across all parsed demos. */
  teamNames: string[];
}

/**
 * Build a player-name → team mapping by fetching match info for every demo
 * in the library in parallel. Teams are stored by (name, steamid) tuples on
 * HLTV rosters, so for our player list (keyed by steamid) we match on the
 * displayed name — the player profile uses that same name, and collisions
 * are rare enough within a single organisation's demos that this works.
 */
async function loadTeamsIndex(): Promise<TeamsIndex> {
  const demos = await getMatchReplayDemos().catch(() => []);
  const infos = await Promise.all(
    demos.slice(0, 200).map((d) =>
      getMatchInfo(d.demo_file).catch(() => null as MatchInfoResponse | null),
    ),
  );

  const playerToTeams = new Map<string, Set<string>>();
  const teamSet = new Set<string>();

  for (const info of infos) {
    if (!info) continue;
    for (const t of [info.team1, info.team2]) {
      if (!t?.name) continue;
      teamSet.add(t.name);
      for (const rawName of t.players ?? []) {
        const key = rawName.trim().toLowerCase();
        if (!key) continue;
        const set = playerToTeams.get(key) ?? new Set<string>();
        set.add(t.name);
        playerToTeams.set(key, set);
      }
    }
  }

  const finalMap = new Map<string, string[]>();
  for (const [k, v] of playerToTeams) finalMap.set(k, Array.from(v));

  return {
    playerToTeams: finalMap,
    teamNames: Array.from(teamSet).sort((a, b) => a.localeCompare(b)),
  };
}

// localStorage cache — versioned so a schema change below can invalidate
// every stored entry in one move. Bump `CACHE_VERSION` when the shape of
// any cached value changes.
const CACHE_VERSION = 1;
const CACHE_KEYS = {
  players: `cs2meta:players:v${CACHE_VERSION}`,
  hltvIds: `cs2meta:hltv-ids:v${CACHE_VERSION}`,
  teams:   `cs2meta:teams-index:v${CACHE_VERSION}`,
};

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode — silently drop.
  }
}

// The TeamsIndex we store in React state uses `Map`s, which don't
// serialize to JSON. Round-trip via plain objects for cache reads/writes.
interface SerializableTeamsIndex {
  playerToTeams: Record<string, string[]>;
  teamNames: string[];
}
function serializeTeamsIndex(idx: TeamsIndex): SerializableTeamsIndex {
  const obj: Record<string, string[]> = {};
  idx.playerToTeams.forEach((teams, name) => { obj[name] = teams; });
  return { playerToTeams: obj, teamNames: idx.teamNames };
}
function deserializeTeamsIndex(s: SerializableTeamsIndex): TeamsIndex {
  const map = new Map<string, string[]>();
  for (const [k, v] of Object.entries(s.playerToTeams)) map.set(k, v);
  return { playerToTeams: map, teamNames: s.teamNames };
}

export default function PlayerListPage() {
  const navigate = useNavigate();
  const hero = useReveal<HTMLDivElement>();
  const podium = useReveal<HTMLDivElement>();

  // Hydrate synchronously from localStorage on first render so the page
  // paints instantly on reload even before any network request
  // completes. `load()` runs in the background below to refresh with
  // current-server data.
  const [players, setPlayers] = useState<PlayerProfileSummary[]>(
    () => readCache<PlayerProfileSummary[]>(CACHE_KEYS.players) ?? [],
  );
  const [teamsIndex, setTeamsIndex] = useState<TeamsIndex | null>(() => {
    const cached = readCache<SerializableTeamsIndex>(CACHE_KEYS.teams);
    return cached ? deserializeTeamsIndex(cached) : null;
  });
  // lowercase-name → HLTV player id, populated from `/api/player-hltv-ids`.
  // Drives the bodyshot images on podium cards + table rows.
  const [hltvIds, setHltvIds] = useState<Record<string, number>>(
    () => readCache<Record<string, number>>(CACHE_KEYS.hltvIds) ?? {},
  );
  // `loading` only true when there's nothing cached to paint — once we
  // have any cached rows, the background refresh is invisible.
  const [loading, setLoading] = useState(
    () => readCache<PlayerProfileSummary[]>(CACHE_KEYS.players) == null,
  );
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("rating");
  const [minMatches, setMinMatches] = useState(1);

  const load = async () => {
    // Only show the spinner on the very first load (when nothing is
    // cached yet). On reloads or refreshes, the cached data is already
    // painted — a background refresh shouldn't flip the screen back to
    // a "Loading…" state.
    setError(null);
    try {
      const [rows, idx, idsResp] = await Promise.all([
        listPlayers(1),
        loadTeamsIndex(),
        getPlayerHltvIds().catch(() => ({ players: {}, count: 0 })),
      ]);
      setPlayers(rows);
      setTeamsIndex(idx);
      setHltvIds(idsResp.players ?? {});
      // Persist for the next page load — massively cuts perceived
      // latency for returning users since hydration from localStorage
      // is synchronous and shows results before any request fires.
      writeCache(CACHE_KEYS.players, rows);
      writeCache(CACHE_KEYS.hltvIds, idsResp.players ?? {});
      writeCache(CACHE_KEYS.teams, serializeTeamsIndex(idx));
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to load players");
    } finally {
      setLoading(false);
    }
  };

  const hltvIdOf = (name: string): number | null =>
    hltvIds[name.trim().toLowerCase()] ?? null;

  useEffect(() => {
    load();
    // Sync the server's photo cache generation as our `?v=` token so
    // the browser HTTP cache invalidates whenever the server cache is
    // cleared. Runs in parallel with `load()` and on every mount so a
    // direct curl wipe propagates without UI interaction.
    warmPlayerPhotosStatus()
      .then((s) => setPhotoCacheVersion(s.generation || 0))
      .catch(() => {});
    // If a photo-warm kicked off during a previous visit is still
    // running on the backend, resume tracking it so the Refresh button
    // shows "Loading images N/M…" instead of falsely saying "Refresh"
    // while the task grinds on in the background.
    resumeInFlightWarm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll `/api/player-photos/warm/status` until `running: false`.
  // Extracted as a helper so both the Refresh click path and the
  // on-mount resume path can share the same tick loop.
  const pollPhotoWarm = async () => {
    const pollStart = Date.now();
    while (Date.now() - pollStart < 180_000) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const s = await warmPlayerPhotosStatus();
        setPhotoProgress({ done: s.done, total: s.total });
        if (!s.running) return;
      } catch {
        // Transient — keep polling until timeout.
      }
    }
  };

  const resumeInFlightWarm = async () => {
    try {
      const s = await warmPlayerPhotosStatus();
      if (!s.running) return;
      // Pick up wherever the task is and drive the UI through the
      // same "photos → reload" tail as a fresh refresh.
      setRefreshPhase("photos");
      setPhotoProgress({ done: s.done, total: s.total });
      await pollPhotoWarm();
      // Pull the post-clear generation from the server so the cache-bust
      // value matches whatever the backend just bumped to. Falls back to
      // a local +1 if the status endpoint hiccups.
      try {
        const s = await warmPlayerPhotosStatus();
        setPhotoCacheVersion(s.generation || 0);
      } catch {
        setPhotoCacheVersion((v) => v + 1);
      }
      setPhotoProgress(null);
      setRefreshPhase("reload");
      await load();
    } catch {
      // Status endpoint unreachable — no harm, leave the button idle.
    } finally {
      setRefreshPhase(null);
    }
  };

  // Phase label for the Refresh button: stats → rosters → images → reload.
  // Tracked as a string (not a bool) so the button can show which step
  // the user is waiting on. `photos` is the longest phase — 30–60s for
  // a full library — so it additionally carries a live count.
  const [refreshPhase, setRefreshPhase] = useState<null | "stats" | "rosters" | "photos" | "reload">(null);
  const [photoProgress, setPhotoProgress] = useState<{ done: number; total: number } | null>(null);
  // Server-driven cache-bust. Driven by the `generation` field from
  // /api/player-photos/warm/status — the backend bumps it every time
  // the cache is cleared (in-app button OR direct curl). Using the
  // server's value (not a local counter) means the cache-bust is
  // consistent across page reloads, browser tabs, and direct
  // /api/player-photos/clear calls — the user always sees fresh
  // images after a wipe without needing to click anything in the UI.
  const [photoCacheVersion, setPhotoCacheVersion] = useState<number>(0);

  const handleRefresh = async () => {
    setRefreshPhase("stats");
    try {
      await refreshPlayerStats();
      setRefreshPhase("rosters");
      // Backfill HLTV player ids on older roster sidecars so bodyshot
      // images light up for every player the scraper has ever seen.
      // Idempotent server-side — skipped for rosters that already have
      // full ids, so re-clicking is cheap.
      try {
        await refreshRosters();
      } catch (e) {
        console.warn("Roster refresh failed:", e);
      }
      // Wipe the on-disk photo cache so every avatar re-fetches with
      // the current scrape-first logic. Crucial for users who clicked
      // Refresh on an older build where the cache filled with 404
      // markers or outdated images.
      try {
        await clearPlayerPhotos();
      } catch (e) {
        console.warn("Photo-cache clear failed:", e);
      }

      // Warm every player photo on the server BEFORE we re-render the
      // UI. This turns the Refresh click into "click once, wait a bit,
      // every image is fresh" — vs. the lazy path where avatars
      // stagger in over the next minute as the browser hits each one.
      // Progress is driven by polling so the same loop also picks up
      // an in-flight warm on page reload (see `resumeInFlightWarm`).
      setRefreshPhase("photos");
      setPhotoProgress({ done: 0, total: 0 });
      try {
        const kickoff = await warmPlayerPhotos();
        setPhotoProgress({ done: kickoff.done, total: kickoff.total });
        await pollPhotoWarm();
      } catch (e) {
        console.warn("Photo warm failed:", e);
      } finally {
        // Force every PlayerAvatar to re-request its image with a new
        // cache-bust token so the browser can't reuse its HTTP-cached
        // (stale) copy from before the server cache got cleared.
        // Pull the post-clear generation from the server so the cache-bust
      // value matches whatever the backend just bumped to. Falls back to
      // a local +1 if the status endpoint hiccups.
      try {
        const s = await warmPlayerPhotosStatus();
        setPhotoCacheVersion(s.generation || 0);
      } catch {
        setPhotoCacheVersion((v) => v + 1);
      }
        setPhotoProgress(null);
      }

      setRefreshPhase("reload");
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Refresh failed");
    } finally {
      setRefreshPhase(null);
    }
  };

  // Derived from refreshPhase — kept in sync so existing button-disable
  // code that reads `refreshing` still works.
  const refreshing = refreshPhase !== null;

  // Nuclear photo reset. Wipes the localStorage hltv-id cache, the
  // server's on-disk photo cache, and every browser-cached `<img>` (via
  // the cacheBust bump), then re-warms from HLTV with the current
  // scrape logic. Used when stale photos persist despite a normal
  // Refresh — usually because the scrape heuristic changed but the
  // images cached under the old logic were still being served.
  const handleResetPhotos = async () => {
    if (!window.confirm(
      "Re-fetch every player photo from HLTV?\n\n" +
      "This deletes the local photo cache and downloads each one " +
      "again with the current scrape logic. Takes about a minute.",
    )) return;
    setRefreshPhase("photos");
    setPhotoProgress({ done: 0, total: 0 });
    try {
      // Drop the localStorage hltv-id map so a stale name→id entry
      // can't keep pointing avatars at a wrong photo even after the
      // server cache is rebuilt.
      try {
        localStorage.removeItem(CACHE_KEYS.hltvIds);
      } catch { /* private mode — fine */ }

      await clearPlayerPhotos();
      const kickoff = await warmPlayerPhotos();
      setPhotoProgress({ done: kickoff.done, total: kickoff.total });
      await pollPhotoWarm();
    } catch (e) {
      console.warn("Photo reset failed:", e);
    } finally {
      // Pull the post-clear generation from the server so the cache-bust
      // value matches whatever the backend just bumped to. Falls back to
      // a local +1 if the status endpoint hiccups.
      try {
        const s = await warmPlayerPhotosStatus();
        setPhotoCacheVersion(s.generation || 0);
      } catch {
        setPhotoCacheVersion((v) => v + 1);
      }
      setPhotoProgress(null);
      setRefreshPhase("reload");
      await load();
      setRefreshPhase(null);
    }
  };

  const teamOf = (name: string): string | undefined => {
    const teams = teamsIndex?.playerToTeams.get(name.trim().toLowerCase());
    return teams?.[0];
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = players.filter((p) => p.matches >= minMatches);
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    if (roleFilter !== "all") rows = rows.filter((p) => p.role === roleFilter);
    if (teamFilter !== "all" && teamsIndex) {
      rows = rows.filter((p) => {
        const teams = teamsIndex.playerToTeams.get(p.name.trim().toLowerCase());
        return teams?.includes(teamFilter);
      });
    }
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "kd":      return b.kd_ratio - a.kd_ratio;
        case "kills":   return b.kills - a.kills;
        case "hs":      return b.hs_pct - a.hs_pct;
        case "openwr":  return b.opening_wr - a.opening_wr;
        case "matches": return b.matches - a.matches;
        case "rating":
        default:        return b.rating - a.rating;
      }
    });
    return rows;
  }, [players, search, roleFilter, teamFilter, sortKey, minMatches, teamsIndex]);

  const topThree = filtered.slice(0, 3);

  return (
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#05070d] text-cs2-text">
      <AppBackdrop tone="violet" />
      <AppHeader
        actions={
          <>
            <button
              onClick={handleResetPhotos}
              disabled={refreshing}
              className="hud-btn"
              title="Wipe the photo cache and re-fetch every player image from HLTV"
            >
              Reset photos
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="hud-btn"
              title="Re-scan cached timelines, then back-fill HLTV player photos for older rosters"
            >
              {refreshPhase === "stats"
                ? "Rebuilding stats…"
                : refreshPhase === "rosters"
                  ? "Refreshing rosters…"
                  : refreshPhase === "photos"
                    ? photoProgress && photoProgress.total > 0
                      ? `Loading images ${photoProgress.done}/${photoProgress.total}…`
                      : "Loading images…"
                    : refreshPhase === "reload"
                      ? "Reloading…"
                      : "Refresh"}
            </button>
          </>
        }
      />

      <div className="relative flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-8 pb-12" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-7xl mx-auto w-full space-y-8">
          {/* ── Page hero ── */}
          <div ref={hero.ref} className={`reveal ${hero.shown ? "in" : ""}`}>
            <span className="section-eyebrow" style={{ color: "#d8b4fe" }}>PROFILE</span>
            <h1 className="page-title mt-3">
              Every player, <span className="accent">ranked</span>
            </h1>
            <p className="mt-3 text-sm text-cs2-muted leading-relaxed max-w-2xl">
              Cross-demo aggregated stats. Filter by role, team, or minimum
              matches — click any row to open the full profile.
            </p>
          </div>

          {/* ── Top 3 podium cards (only when rating-sorted, so the visual
              ranking actually matches the list below) ── */}
          {!loading && topThree.length === 3 && sortKey === "rating" && (
            <div ref={podium.ref} className={`reveal ${podium.shown ? "in" : ""} grid grid-cols-1 md:grid-cols-3 gap-4`}>
              {topThree.map((p, i) => {
                const roleColor = ROLE_COLORS[p.role] ?? "#94a3b8";
                const medal = ["#fde047", "#cbd5e1", "#fb923c"][i]; // gold/silver/bronze
                const team = teamOf(p.name);
                return (
                  <button
                    key={p.steamid}
                    onClick={() => navigate(`/players/${p.steamid}`)}
                    className="hud-panel text-left p-5 relative overflow-hidden group transition-all hover:-translate-y-0.5"
                  >
                    <div
                      className="absolute inset-x-0 top-0 h-px"
                      style={{
                        background: `linear-gradient(90deg, transparent 0%, ${medal} 50%, transparent 100%)`,
                      }}
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <PlayerAvatar
                          name={p.name}
                          hltvId={hltvIdOf(p.name)}
                          size={56}
                          accent={roleColor}
                          cacheBust={photoCacheVersion || undefined}
                          hideIfNoImage
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono font-bold uppercase tracking-[0.2em]" style={{ color: medal }}>
                              #{i + 1}
                            </span>
                            {team && (
                              <span className="text-[10px] font-mono text-cs2-muted truncate">{team}</span>
                            )}
                          </div>
                          <h3 className="mt-1 text-2xl font-bold tracking-tight text-white truncate">
                            {p.name}
                          </h3>
                          <span
                            className="inline-block mt-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold"
                            style={{ background: `${roleColor}20`, color: roleColor, border: `1px solid ${roleColor}30` }}
                          >
                            {p.role}
                          </span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-3xl font-bold font-mono text-white tracking-tight">
                          {p.rating.toFixed(2)}
                        </div>
                        <div className="text-[9px] font-mono text-cs2-muted uppercase tracking-[0.2em]">
                          Rating
                        </div>
                      </div>
                    </div>
                    <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                      <div>
                        <div className={`text-base font-mono font-bold ${p.kd_ratio >= 1 ? "text-cs2-green" : "text-cs2-red"}`}>
                          {p.kd_ratio.toFixed(2)}
                        </div>
                        <div className="text-[9px] font-mono text-cs2-muted uppercase tracking-[0.18em]">K/D</div>
                      </div>
                      <div>
                        <div className="text-base font-mono font-bold text-white">
                          {Math.round(p.hs_pct * 100)}%
                        </div>
                        <div className="text-[9px] font-mono text-cs2-muted uppercase tracking-[0.18em]">HS%</div>
                      </div>
                      <div>
                        <div className="text-base font-mono font-bold text-white">
                          {p.matches}
                        </div>
                        <div className="text-[9px] font-mono text-cs2-muted uppercase tracking-[0.18em]">Matches</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Filters ── */}
          <div className="hud-panel p-4 flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[220px] space-y-1.5">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">Search</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Player name…"
                className="hud-input w-full"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">Role</label>
              <Select
                value={roleFilter}
                onChange={setRoleFilter}
                minWidth={140}
                options={[
                  { value: "all", label: "All roles" },
                  { value: "AWP",     label: "AWP",     dot: "#5B9BD5" },
                  { value: "Entry",   label: "Entry",   dot: "#f87171" },
                  { value: "Support", label: "Support", dot: "#4ade80" },
                  { value: "Lurker",  label: "Lurker",  dot: "#c084fc" },
                  { value: "Rifler",  label: "Rifler",  dot: "#22d3ee" },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">Team</label>
              <Select
                value={teamFilter}
                onChange={setTeamFilter}
                minWidth={180}
                options={[
                  { value: "all", label: "All teams" },
                  ...(teamsIndex?.teamNames ?? []).map((t) => ({
                    value: t,
                    label: t,
                  })),
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">Sort</label>
              <Select
                value={sortKey}
                onChange={(v) => setSortKey(v as SortKey)}
                minWidth={130}
                options={[
                  { value: "rating",  label: "Rating" },
                  { value: "kd",      label: "K/D" },
                  { value: "kills",   label: "Kills" },
                  { value: "hs",      label: "HS%" },
                  { value: "openwr",  label: "Open WR" },
                  { value: "matches", label: "Matches" },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.18em] font-semibold">Min matches</label>
              <input
                type="number"
                min={1}
                value={minMatches}
                onChange={(e) => setMinMatches(Math.max(1, parseInt(e.target.value || "1", 10)))}
                className="hud-input w-24"
              />
            </div>
            <span className="ml-auto text-[11px] text-cs2-muted self-center font-mono">
              {filtered.length} / {players.length} players
            </span>
          </div>

          {/* Error / empty */}
          {error && (
            <div className="hud-panel p-4 text-[12px]" style={{ borderColor: "rgba(248,113,113,0.4)", color: "#fca5a5" }}>
              {error}
            </div>
          )}

          {loading ? (
            <div className="hud-panel p-10 text-center text-cs2-muted text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-cs2-accent animate-pulse-glow mr-2" />
              Loading players…
            </div>
          ) : filtered.length === 0 ? (
            <div className="hud-panel p-10 text-center text-cs2-muted text-sm">
              No players match your filters. Try widening them, or click Refresh
              to rescan cached timelines.
            </div>
          ) : (
            <div className="hud-panel overflow-hidden">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-cs2-muted uppercase tracking-[0.18em] border-b border-white/5 bg-white/[0.02]">
                    <th className="px-3 py-3 text-left font-semibold w-10">#</th>
                    <th className="px-3 py-3 text-left font-semibold">Player</th>
                    <th className="px-3 py-3 text-left font-semibold">Team</th>
                    <th className="px-3 py-3 text-center font-semibold">Role</th>
                    <th className="px-3 py-3 text-right font-semibold">Rating</th>
                    <th className="px-3 py-3 text-right font-semibold">K/D</th>
                    <th className="px-3 py-3 text-right font-semibold">K</th>
                    <th className="px-3 py-3 text-right font-semibold">D</th>
                    <th className="px-3 py-3 text-right font-semibold">HS%</th>
                    <th className="px-3 py-3 text-right font-semibold">Open WR</th>
                    <th className="px-3 py-3 text-right font-semibold pr-4">Matches</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, idx) => {
                    const roleColor = ROLE_COLORS[p.role] ?? "#94a3b8";
                    const team = teamOf(p.name);
                    return (
                      <tr
                        key={p.steamid}
                        onClick={() => navigate(`/players/${p.steamid}`)}
                        className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.03] cursor-pointer transition-colors"
                      >
                        <td className="px-3 py-2 font-mono text-cs2-muted">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2.5">
                            <PlayerAvatar
                              name={p.name}
                              hltvId={hltvIdOf(p.name)}
                              size={28}
                              accent={roleColor}
                              cacheBust={photoCacheVersion || undefined}
                              hideIfNoImage
                            />
                            <span className="font-semibold text-white truncate">{p.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-cs2-muted text-[11px] truncate max-w-[180px]">
                          {team ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className="px-2 py-0.5 rounded-md text-[10px] font-bold"
                            style={{ background: `${roleColor}20`, color: roleColor, border: `1px solid ${roleColor}30` }}
                          >
                            {p.role}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-white">
                          {p.rating.toFixed(2)}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono ${p.kd_ratio >= 1 ? "text-cs2-green" : "text-cs2-red"}`}>
                          {p.kd_ratio.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-300">{p.kills}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-400">{p.deaths}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-300">
                          {Math.round(p.hs_pct * 100)}%
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-300">
                          {Math.round(p.opening_wr * 100)}%
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-cs2-muted pr-4">{p.matches}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
