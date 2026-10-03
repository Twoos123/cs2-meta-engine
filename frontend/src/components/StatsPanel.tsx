/**
 * StatsPanel — per-player stats dashboard.
 * Computes K/D, HS%, opening duels, multi-kills, utility usage client-side
 * from the timeline data. ADR, KAST, trades, clutches and Rating come from
 * the server (`/api/players/match/{demo}`), which shares its definitions
 * with the player profiles; those columns show "—" while unavailable or
 * when an older demo lacks the data.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { MatchInfoResponse, MatchTimeline } from "../api/client";
import {
  DASH,
  MatchPlayerStatsResponse,
  PlayerSummaryStats,
  apiErrorMessage,
  fmtAdr,
  fmtClutches,
  fmtPct,
  getMatchPlayerStats,
} from "../api/players";
import { RatingInfo } from "./PlayerStatTile";

interface Props {
  timeline: MatchTimeline;
  matchInfo: MatchInfoResponse | null;
  /** Defaults to the `:demoFile` route param of the replay layout. */
  demoFile?: string;
}

interface PlayerStats {
  steamid: string;
  name: string;
  team: number; // 2=T, 3=CT (first half)
  kills: number;
  deaths: number;
  hsKills: number;
  wallbangKills: number;
  noscopeKills: number;
  smokeKills: number;
  blindKills: number;
  openingKills: number;
  openingDeaths: number;
  multiKills: { "2k": number; "3k": number; "4k": number; "5k": number };
  smokesThrown: number;
  flashesThrown: number;
  hesThrown: number;
  molovsThrown: number;
  roundsAlive: number; // rounds survived
  totalRounds: number;
}

/** Pinned first column while the stats grid scrolls horizontally (< lg).
 *  Needs an opaque background so scrolled numbers don't show through. */
const STICKY_COL = "sticky left-0 z-10 bg-[#0b0f1a] lg:static lg:bg-transparent";

const GRID_COLS = "2fr repeat(15, 1fr)";

export default function StatsPanel({ timeline, matchInfo, demoFile: demoFileProp }: Props) {
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const params = useParams();
  const demoFile = demoFileProp ?? (params.demoFile ? decodeURIComponent(params.demoFile) : "");

  // Server-side match stats: undefined = loading, null = unavailable.
  const [server, setServer] = useState<MatchPlayerStatsResponse | null | undefined>(undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    if (!demoFile) {
      setServer(null);
      return;
    }
    let cancelled = false;
    setServer(undefined);
    setServerError(null);
    getMatchPlayerStats(demoFile)
      .then((d) => { if (!cancelled) setServer(d); })
      .catch((e) => {
        if (cancelled) return;
        setServer(null);
        setServerError(apiErrorMessage(e, "Advanced stats unavailable"));
      });
    return () => { cancelled = true; };
  }, [demoFile]);

  const serverBySid = useMemo(() => {
    const m = new Map<string, PlayerSummaryStats>();
    for (const p of server?.players ?? []) m.set(p.steamid, p);
    return m;
  }, [server]);
  const loadingServer = server === undefined;
  /** Placeholder for server-backed cells: an ellipsis while loading, a dash if missing. */
  const pending = loadingServer ? "…" : DASH;
  const ratingVersion = server?.players.some((p) => p.rating_version === "2.0")
    ? "2.0"
    : server
      ? "1.0"
      : undefined;

  const teamNames = useMemo(() => {
    if (matchInfo?.team1 && matchInfo?.team2) {
      const tPlayers = new Set(
        timeline.players.filter((p) => p.team_num === 2).map((p) => p.name.toLowerCase()),
      );
      const team1Players = (matchInfo.team1.players ?? []).map((n) => n.toLowerCase());
      const team1IsT = team1Players.some((n) => tPlayers.has(n));
      return {
        2: team1IsT ? matchInfo.team1.name : matchInfo.team2.name,
        3: team1IsT ? matchInfo.team2.name : matchInfo.team1.name,
      };
    }
    return { 2: "Terrorists", 3: "Counter-Terrorists" };
  }, [matchInfo, timeline]);

  const stats = useMemo<PlayerStats[]>(() => {
    const map = new Map<string, PlayerStats>();
    for (const p of timeline.players) {
      map.set(p.steamid, {
        steamid: p.steamid,
        name: p.name,
        team: p.team_num,
        kills: 0, deaths: 0, hsKills: 0,
        wallbangKills: 0, noscopeKills: 0, smokeKills: 0, blindKills: 0,
        openingKills: 0, openingDeaths: 0,
        multiKills: { "2k": 0, "3k": 0, "4k": 0, "5k": 0 },
        smokesThrown: 0, flashesThrown: 0, hesThrown: 0, molovsThrown: 0,
        roundsAlive: 0, totalRounds: timeline.rounds.length,
      });
    }

    // Process death events per round
    const roundKills = new Map<number, Map<string, number>>(); // round -> attacker -> kill count
    const roundFirstKill = new Map<number, boolean>(); // track if first kill of round seen

    for (const r of timeline.rounds) {
      roundKills.set(r.num, new Map());
      roundFirstKill.set(r.num, false);
    }

    // Find which round a tick belongs to
    const tickToRound = (tick: number): number => {
      for (const r of timeline.rounds) {
        if (tick >= r.start_tick && tick <= r.end_tick) return r.num;
      }
      return 0;
    };

    // Process kills
    for (const evt of timeline.events) {
      if (evt.type !== "death") continue;
      const rnd = tickToRound(evt.tick);
      const attacker = evt.data.attacker;
      const victim = evt.data.victim;

      // Deaths
      const victimStats = map.get(victim);
      if (victimStats) victimStats.deaths++;

      // Kills (ignore suicides/team kills for stats)
      if (attacker && attacker !== victim) {
        const attackerStats = map.get(attacker);
        if (attackerStats) {
          attackerStats.kills++;
          if (evt.data.headshot === "True" || evt.data.headshot === "true" || evt.data.headshot === "1") {
            attackerStats.hsKills++;
          }
          if (evt.data.penetrated && evt.data.penetrated !== "0" && evt.data.penetrated !== "False") {
            attackerStats.wallbangKills++;
          }
          if (evt.data.noscope === "True" || evt.data.noscope === "true" || evt.data.noscope === "1") {
            attackerStats.noscopeKills++;
          }
          if (evt.data.thrusmoke === "True" || evt.data.thrusmoke === "true" || evt.data.thrusmoke === "1") {
            attackerStats.smokeKills++;
          }
          if (evt.data.attackerblind === "True" || evt.data.attackerblind === "true" || evt.data.attackerblind === "1") {
            attackerStats.blindKills++;
          }

          // Opening kill tracking
          if (!roundFirstKill.get(rnd)) {
            roundFirstKill.set(rnd, true);
            attackerStats.openingKills++;
            if (victimStats) victimStats.openingDeaths++;
          }

          // Multi-kill tracking
          const rk = roundKills.get(rnd);
          if (rk) {
            rk.set(attacker, (rk.get(attacker) ?? 0) + 1);
          }
        }
      }
    }

    // Count multi-kills per round
    for (const [, rk] of roundKills) {
      for (const [sid, count] of rk) {
        const s = map.get(sid);
        if (!s) continue;
        if (count >= 5) s.multiKills["5k"]++;
        else if (count >= 4) s.multiKills["4k"]++;
        else if (count >= 3) s.multiKills["3k"]++;
        else if (count >= 2) s.multiKills["2k"]++;
      }
    }

    // Grenade usage
    for (const g of timeline.grenades) {
      const s = map.get(g.thrower);
      if (!s) continue;
      if (g.type === "smokegrenade") s.smokesThrown++;
      else if (g.type === "flashbang") s.flashesThrown++;
      else if (g.type === "hegrenade") s.hesThrown++;
      else if (g.type === "molotov" || g.type === "incgrenade") s.molovsThrown++;
    }

    // Rounds survived: check if player is alive at round end tick
    for (const r of timeline.rounds) {
      for (const p of timeline.players) {
        const samples = timeline.positions[p.steamid];
        if (!samples || samples.length === 0) continue;
        // Find sample nearest to round end
        let nearest = samples[0];
        for (const s of samples) {
          if (Math.abs(s.t - r.end_tick) < Math.abs(nearest.t - r.end_tick)) nearest = s;
          if (s.t > r.end_tick) break;
        }
        if (nearest.alive) {
          const ps = map.get(p.steamid);
          if (ps) ps.roundsAlive++;
        }
      }
    }

    return Array.from(map.values());
  }, [timeline]);

  // Sort by kills desc within each team
  const teamPlayers = (team: number) =>
    stats.filter((s) => s.team === team).sort((a, b) => b.kills - a.kills);

  const renderTeamTable = (team: number) => {
    const players = teamPlayers(team);
    const teamColor = team === 2 ? "#DCBF6E" : "#5B9BD5";
    const teamLabel = team === 2 ? "T" : "CT";

    return (
      <div className="hud-panel overflow-hidden">
        <div className="px-4 py-2 border-b border-cs2-border/50 flex items-center gap-2">
          <span
            className="px-2 py-0.5 rounded text-[10px] font-bold"
            style={{ background: `${teamColor}20`, color: teamColor }}
          >
            {teamLabel}
          </span>
          <span className="text-sm font-semibold text-white">
            {teamNames[team as 2 | 3]}
          </span>
        </div>
        {/* Horizontal scroll on narrow screens (the grid keeps a min width so
            numbers never squash); the player column stays pinned left. The
            scroll box is an inline-size container so the expanded detail can
            be sized to the visible width (100cqw) instead of the table's. */}
        <div className="overflow-x-auto [container-type:inline-size]" style={{ scrollbarWidth: "thin" }}>
        <div className="text-[11px] min-w-[820px]">
          {/* Header row */}
          <div
            className="grid text-cs2-muted uppercase tracking-[0.08em] border-b border-cs2-border/30"
            style={{ gridTemplateColumns: GRID_COLS }}
          >
            <div className={`px-3 py-2 font-medium text-left ${STICKY_COL}`}>Player</div>
            <div className="px-2 py-2 font-medium text-center">K</div>
            <div className="px-2 py-2 font-medium text-center">D</div>
            <div className="px-2 py-2 font-medium text-center">+/-</div>
            <div className="px-2 py-2 font-medium text-center" title="Average damage per round">ADR</div>
            <div className="px-2 py-2 font-medium text-center" title="% of rounds with a Kill, Assist, Survival or Trade">KAST</div>
            <div className="px-2 py-2 font-medium text-center">HS%</div>
            <div className="px-2 py-2 font-medium text-center">FK</div>
            <div className="px-2 py-2 font-medium text-center">FD</div>
            <div className="px-2 py-2 font-medium text-center">2K</div>
            <div className="px-2 py-2 font-medium text-center">3K</div>
            <div className="px-2 py-2 font-medium text-center">4K</div>
            <div className="px-2 py-2 font-medium text-center">5K</div>
            <div className="px-2 py-2 font-medium text-center" title="Clutches (1vX) won / attempted">1vX</div>
            <div className="px-2 py-2 font-medium text-center" title="Survival rate">SRV%</div>
            <div className="px-2 py-2 font-medium text-center">
              <span className="inline-flex items-center gap-1">Rtg <RatingInfo version={ratingVersion} /></span>
            </div>
          </div>
          {/* Player rows */}
          {players.map((p) => {
            const diff = p.kills - p.deaths;
            const hsPct = p.kills > 0 ? Math.round((p.hsKills / p.kills) * 100) : 0;
            const survPct = p.totalRounds > 0 ? Math.round((p.roundsAlive / p.totalRounds) * 100) : 0;
            const isExpanded = expandedPlayer === p.steamid;
            const sv = serverBySid.get(p.steamid);

            return (
              <div key={p.steamid}>
                <div
                  className={`border-b border-cs2-border/20 cursor-pointer transition-colors ${
                    isExpanded ? "bg-cs2-accent/5" : "hover:bg-cs2-border/10"
                  }`}
                  onClick={() => setExpandedPlayer(isExpanded ? null : p.steamid)}
                >
                  {/* Main row */}
                  <div className="grid" style={{ gridTemplateColumns: GRID_COLS }}>
                    <div className={`px-3 py-2 font-semibold text-white truncate ${STICKY_COL}`}>{p.name}</div>
                    <div className="px-2 py-2 text-center font-mono font-bold text-white">{p.kills}</div>
                    <div className="px-2 py-2 text-center font-mono text-gray-400">{p.deaths}</div>
                    <div className={`px-2 py-2 text-center font-mono font-bold ${diff > 0 ? "text-cs2-green" : diff < 0 ? "text-cs2-red" : "text-gray-400"}`}>
                      {diff > 0 ? `+${diff}` : diff}
                    </div>
                    <div
                      className="px-2 py-2 text-center font-mono text-gray-300"
                      title={sv && sv.adr == null ? "No damage data in this demo's cached timeline" : undefined}
                    >
                      {sv ? fmtAdr(sv.adr) : pending}
                    </div>
                    <div className="px-2 py-2 text-center font-mono text-gray-300">{sv ? fmtPct(sv.kast_pct) : pending}</div>
                    <div className="px-2 py-2 text-center font-mono text-gray-300">{hsPct}%</div>
                    <div className="px-2 py-2 text-center font-mono text-cs2-green">{p.openingKills}</div>
                    <div className="px-2 py-2 text-center font-mono text-cs2-red">{p.openingDeaths}</div>
                    <div className="px-2 py-2 text-center font-mono text-gray-300">{p.multiKills["2k"] || "-"}</div>
                    <div className="px-2 py-2 text-center font-mono text-gray-300">{p.multiKills["3k"] || "-"}</div>
                    <div className="px-2 py-2 text-center font-mono text-yellow-400">{p.multiKills["4k"] || "-"}</div>
                    <div className="px-2 py-2 text-center font-mono text-cs2-accent">{p.multiKills["5k"] || "-"}</div>
                    <div className="px-2 py-2 text-center font-mono text-gray-300">
                      {sv ? (sv.clutches_attempted ? fmtClutches(sv.clutches_won, sv.clutches_attempted) : "-") : pending}
                    </div>
                    <div className="px-2 py-2 text-center font-mono text-gray-300">{survPct}%</div>
                    <div
                      className={`px-2 py-2 text-center font-mono font-bold ${
                        sv ? (sv.rating >= 1 ? "text-cs2-green" : "text-cs2-red") : "text-gray-400"
                      }`}
                      title={sv ? `Rating ${sv.rating_version ?? "1.0"}` : undefined}
                    >
                      {sv ? sv.rating.toFixed(2) : pending}
                    </div>
                  </div>

                  {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-4 pb-3 pt-1 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sticky left-0 w-[100cqw] lg:static lg:w-auto">
                          <div className="hud-panel p-2 space-y-1">
                            <p className="text-[9px] text-cs2-muted uppercase tracking-wide">Kill Breakdown</p>
                            <div className="space-y-0.5 text-[11px]">
                              <div className="flex justify-between">
                                <span className="text-gray-400">Headshots</span>
                                <span className="text-white font-mono">{p.hsKills}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Wallbangs</span>
                                <span className="text-white font-mono">{p.wallbangKills}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">No-scopes</span>
                                <span className="text-white font-mono">{p.noscopeKills}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Through smoke</span>
                                <span className="text-white font-mono">{p.smokeKills}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">While blind</span>
                                <span className="text-white font-mono">{p.blindKills}</span>
                              </div>
                            </div>
                          </div>
                          <div className="hud-panel p-2 space-y-1">
                            <p className="text-[9px] text-cs2-muted uppercase tracking-wide">Opening Duels</p>
                            <div className="text-lg font-bold font-mono text-white">
                              <span className="text-cs2-green">{p.openingKills}</span>
                              {" - "}
                              <span className="text-cs2-red">{p.openingDeaths}</span>
                            </div>
                            <p className="text-[10px] text-cs2-muted">
                              {p.openingKills + p.openingDeaths > 0
                                ? `${Math.round((p.openingKills / (p.openingKills + p.openingDeaths)) * 100)}% win rate`
                                : "No opening duels"}
                            </p>
                          </div>
                          <div className="hud-panel p-2 space-y-1">
                            <p className="text-[9px] text-cs2-muted uppercase tracking-wide">Utility Usage</p>
                            <div className="space-y-0.5 text-[11px]">
                              <div className="flex justify-between">
                                <span className="text-gray-400">Smokes</span>
                                <span className="text-white font-mono">{p.smokesThrown}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Flashes</span>
                                <span className="text-white font-mono">{p.flashesThrown}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">HE Grenades</span>
                                <span className="text-white font-mono">{p.hesThrown}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Molotovs</span>
                                <span className="text-white font-mono">{p.molovsThrown}</span>
                              </div>
                            </div>
                          </div>
                          <div className="hud-panel p-2 space-y-1">
                            <p className="text-[9px] text-cs2-muted uppercase tracking-wide">Multi-Kills</p>
                            <div className="space-y-0.5 text-[11px]">
                              <div className="flex justify-between">
                                <span className="text-gray-400">Double kills</span>
                                <span className="text-white font-mono">{p.multiKills["2k"]}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Triple kills</span>
                                <span className="text-white font-mono">{p.multiKills["3k"]}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-yellow-400">Quad kills</span>
                                <span className="text-yellow-400 font-mono">{p.multiKills["4k"]}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-cs2-accent">Aces</span>
                                <span className="text-cs2-accent font-mono">{p.multiKills["5k"]}</span>
                              </div>
                            </div>
                          </div>
                          <div className="hud-panel p-2 space-y-1">
                            <p className="text-[9px] text-cs2-muted uppercase tracking-wide">Trades &amp; Clutches</p>
                            {sv ? (
                              <div className="space-y-0.5 text-[11px]">
                                <div className="flex justify-between">
                                  <span className="text-gray-400" title="Kills avenging a teammate within 5s">Trade kills</span>
                                  <span className="text-white font-mono">{sv.trade_kills ?? DASH}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-gray-400" title="Deaths a teammate avenged within 5s">Deaths traded</span>
                                  <span className="text-white font-mono">{sv.traded_deaths ?? DASH}</span>
                                </div>
                                {(sv.clutches ?? []).map((c) => (
                                  <div key={c.x} className="flex justify-between">
                                    <span className="text-gray-400">1v{c.x}</span>
                                    <span className={`font-mono ${c.won ? "text-cs2-green" : "text-white"}`}>
                                      {c.attempted ? `${c.won}/${c.attempted}` : "-"}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[10px] text-cs2-muted">
                                {loadingServer ? "Loading…" : serverError ?? "Unavailable for this demo"}
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
              );
          })}
          </div>
        </div>
        </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto p-3 lg:p-4 space-y-4" style={{ scrollbarWidth: "thin" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">
          Player Statistics · {timeline.rounds.length} rounds
        </h2>
        {server && !server.has_adr && (
          <span className="text-[10px] text-cs2-muted">
            No damage data in this demo's cache, so ADR is unavailable and the rating uses 1.0.
          </span>
        )}
        {server === null && serverError && (
          <span className="text-[10px] text-cs2-muted">ADR / KAST / rating unavailable: {serverError}</span>
        )}
      </div>
      {renderTeamTable(2)}
      {renderTeamTable(3)}
    </div>
  );
}
