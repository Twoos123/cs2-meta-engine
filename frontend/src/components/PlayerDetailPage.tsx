import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  PlayerProfileDetail,
  getMatchInfo,
  getPlayerDetail,
  getPlayerHltvIds,
  warmPlayerPhotosStatus,
} from "../api/client";
import PlayerStatTile from "./PlayerStatTile";
import PlayerRoleRadar from "./PlayerRoleRadar";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import PlayerAvatar from "./PlayerAvatar";

const ROLE_COLORS: Record<string, string> = {
  AWP: "#5B9BD5",
  Entry: "#f87171",
  Support: "#4ade80",
  Lurker: "#c084fc",
  Rifler: "#22d3ee",
};

const SIDE_COLORS: Record<string, string> = {
  T: "#DCBF6E",
  CT: "#5B9BD5",
};

export default function PlayerDetailPage() {
  const navigate = useNavigate();
  const { steamid } = useParams<{ steamid: string }>();
  const [detail, setDetail] = useState<PlayerProfileDetail | null>(null);
  const [hltvId, setHltvId] = useState<number | null>(null);
  // Team logo + name for this player, inferred from roster sidecars of
  // the demos they appear in. Used as a faded background on the header
  // card so the detail page reads as "belongs to this team".
  const [teamLogo, setTeamLogo] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  // Server-driven cache-bust token. Read from the warm-status endpoint
  // so reloading or curl-clearing the photo cache invalidates the
  // browser HTTP cache for this avatar too — same mechanism the player
  // list uses.
  const [photoCacheVersion, setPhotoCacheVersion] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pull the photo cache generation independently of the profile
    // fetch so the avatar URL gets its `?v=N` token early — no need to
    // wait on the slower demo→roster walk below.
    warmPlayerPhotosStatus()
      .then((s) => setPhotoCacheVersion(s.generation || 0))
      .catch(() => {});

    if (!steamid) return;
    setLoading(true);
    getPlayerDetail(steamid)
      .then(async (d) => {
        setDetail(d);
        // Look up the HLTV id for this player's displayed name. Done
        // after the profile loads so we have the canonical name to match
        // against the aggregated roster map.
        try {
          const ids = await getPlayerHltvIds();
          setHltvId(ids.players?.[d.name.trim().toLowerCase()] ?? null);
        } catch {
          setHltvId(null);
        }
        // Resolve the player's team + logo. Walk their most-recent demos
        // (already ordered newest-first by the backend) and for each,
        // pull the match-info and see which team this player is listed
        // on. First hit wins — a pro who switched orgs gets their
        // current team because we start with the newest demo.
        try {
          const lcName = d.name.trim().toLowerCase();
          for (const demo of (d.demos ?? []).slice(0, 5)) {
            const info = await getMatchInfo(demo.demo_file).catch(() => null);
            if (!info) continue;
            for (const team of [info.team1, info.team2]) {
              if (!team) continue;
              const onTeam = (team.players ?? []).some(
                (n) => n.trim().toLowerCase() === lcName,
              );
              if (onTeam) {
                setTeamLogo(team.logo || null);
                setTeamName(team.name || null);
                return;
              }
            }
          }
        } catch {
          // No roster info — just leave the background empty.
        }
      })
      .catch((e) => setError(e?.response?.data?.detail ?? e?.message ?? "Failed to load profile"))
      .finally(() => setLoading(false));
  }, [steamid]);

  // Radar axes: normalize each to 0-1 using reasonable per-axis caps so an
  // elite player can hit the outer ring without a small-sample outlier
  // exploding the scale.
  const radarAxes = useMemo(() => {
    if (!detail) return [];
    const s = detail.summary;
    const kpr = s.rounds_played ? s.kills / s.rounds_played : 0;
    const utilPr = s.rounds_played
      ? (s.smokes_thrown + s.flashes_thrown + s.hes_thrown + s.molos_thrown) / s.rounds_played
      : 0;
    return [
      { label: "Frag", value: Math.min(1, kpr / 1.2) },
      { label: "Open", value: Math.min(1, s.opening_wr / 0.7) },
      { label: "HS%", value: Math.min(1, s.hs_pct / 0.7) },
      { label: "Util", value: Math.min(1, utilPr / 2.5) },
      { label: "Survival", value: Math.min(1, s.survival_rate / 0.6) },
    ];
  }, [detail]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#05070d]">
        <span className="text-cs2-muted text-sm">Loading profile...</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#05070d] gap-3">
        <span className="text-cs2-red text-sm">{error ?? "Profile not found"}</span>
        <button onClick={() => navigate("/players")} className="hud-btn text-xs">← Players</button>
      </div>
    );
  }

  const s = detail.summary;
  const roleColor = ROLE_COLORS[s.role] ?? "#94a3b8";

  return (
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#05070d] text-cs2-text">
      <AppBackdrop tone="violet" />
      <AppHeader
        actions={
          <button
            onClick={() => navigate("/players")}
            className="hud-btn"
            title="Back to player list"
          >
            ← All players
          </button>
        }
      />

      <div className="relative flex-1 min-h-0 overflow-y-auto px-4 py-4" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-6xl mx-auto space-y-4">
          {/* Header — team logo sits as an oversized, faded watermark
              in the background so the card reads as "this player on this
              org" without stealing attention from the name and stats. */}
          <div className="hud-panel p-6 flex flex-wrap items-center gap-6 relative overflow-hidden">
            {teamLogo && (
              <div
                className="absolute inset-0 pointer-events-none"
                aria-hidden
                style={{
                  // Right-anchored and oversized so the logo reads
                  // clearly as a watermark without sliding off-card.
                  backgroundImage: `url(${teamLogo})`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 2rem center",
                  backgroundSize: "auto 200%",
                  opacity: 0.35,
                  filter: "saturate(130%) drop-shadow(0 0 24px rgba(0,0,0,0.6))",
                  // Fade the left 45% so the avatar + name + stats
                  // sitting there stay fully legible — the logo only
                  // bleeds in from the right side of the card.
                  maskImage:
                    "linear-gradient(90deg, transparent 0%, transparent 30%, black 60%, black 100%)",
                  WebkitMaskImage:
                    "linear-gradient(90deg, transparent 0%, transparent 30%, black 60%, black 100%)",
                }}
              />
            )}
            <PlayerAvatar
              name={detail.name}
              hltvId={hltvId}
              size={128}
              shape="rounded"
              accent={roleColor}
              className="relative z-10"
              cacheBust={photoCacheVersion || undefined}
            />
            <div className="flex-1 min-w-0 relative z-10">
              <div className="flex items-center gap-3">
                <h2 className="text-4xl font-bold tracking-tight text-white truncate">{detail.name}</h2>
                <span
                  className="px-2 py-0.5 rounded-md text-[11px] font-bold border"
                  style={{ background: `${roleColor}20`, color: roleColor, borderColor: `${roleColor}40` }}
                >
                  {s.role}
                </span>
                {/* Team name label intentionally omitted — the oversized
                    team logo watermarked in the header background already
                    conveys which org this player belongs to. */}
              </div>
              <p className="text-[11px] text-cs2-muted mt-1.5 font-mono">
                {s.matches} matches · {s.rounds_played} rounds · steamid {detail.steamid}
              </p>
            </div>
            <div className="flex items-center gap-3 relative z-10">
              <div className="text-right">
                <p className="text-[10px] text-cs2-muted uppercase tracking-[0.18em]">Rating</p>
                <p className="text-3xl font-bold font-mono text-cs2-accent">{s.rating.toFixed(2)}</p>
              </div>
            </div>
          </div>

          {/* Stat tiles + radar + side split */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="grid grid-cols-2 gap-3">
              <PlayerStatTile
                label="K/D"
                value={s.kd_ratio.toFixed(2)}
                color={s.kd_ratio >= 1 ? "#4ade80" : "#f87171"}
              />
              <PlayerStatTile label="Kills" value={s.kills} sub={`${s.deaths} deaths`} />
              <PlayerStatTile label="HS%" value={`${Math.round(s.hs_pct * 100)}%`} sub={`${s.hs_kills} HS kills`} />
              <PlayerStatTile
                label="Opening WR"
                value={`${Math.round(s.opening_wr * 100)}%`}
                sub={`${s.opening_kills}-${s.opening_deaths}`}
              />
              <PlayerStatTile
                label="Survival"
                value={`${Math.round(s.survival_rate * 100)}%`}
                sub={`${s.rounds_alive}/${s.rounds_played}`}
              />
              <PlayerStatTile label="AWP Kills" value={s.awp_kills} color="#5B9BD5" />
            </div>

            <div className="hud-panel p-3 flex items-center justify-center">
              <PlayerRoleRadar axes={radarAxes} color={roleColor} />
            </div>

            <div className="hud-panel p-3 space-y-2">
              <h3 className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">Side split</h3>
              {detail.per_side.length === 0 && (
                <p className="text-[11px] text-cs2-muted">No side data.</p>
              )}
              {detail.per_side.map((ss) => {
                const kd = ss.deaths ? ss.kills / ss.deaths : ss.kills;
                const openWr = ss.opening_kills + ss.opening_deaths > 0
                  ? ss.opening_kills / (ss.opening_kills + ss.opening_deaths)
                  : 0;
                const surv = ss.rounds_played ? ss.rounds_alive / ss.rounds_played : 0;
                const color = SIDE_COLORS[ss.side] ?? "#94a3b8";
                return (
                  <div key={ss.side} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                        style={{ background: `${color}20`, color }}
                      >
                        {ss.side}
                      </span>
                      <span className="text-[11px] text-cs2-muted">{ss.rounds_played} rounds</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <p className="text-cs2-muted text-[9px] uppercase">K/D</p>
                        <p className="font-mono text-white">{kd.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-cs2-muted text-[9px] uppercase">Open WR</p>
                        <p className="font-mono text-white">{Math.round(openWr * 100)}%</p>
                      </div>
                      <div>
                        <p className="text-cs2-muted text-[9px] uppercase">Survival</p>
                        <p className="font-mono text-white">{Math.round(surv * 100)}%</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-map */}
          <div className="hud-panel overflow-hidden">
            <div className="px-4 py-2 border-b border-cs2-border/50">
              <h3 className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">
                Per-map performance
              </h3>
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-cs2-muted uppercase tracking-[0.08em] border-b border-cs2-border/30">
                  <th className="px-3 py-2 text-left font-medium">Map</th>
                  <th className="px-3 py-2 text-right font-medium">Matches</th>
                  <th className="px-3 py-2 text-right font-medium">Rounds</th>
                  <th className="px-3 py-2 text-right font-medium">K/D</th>
                  <th className="px-3 py-2 text-right font-medium">K</th>
                  <th className="px-3 py-2 text-right font-medium">D</th>
                  <th className="px-3 py-2 text-right font-medium">Open WR</th>
                  <th className="px-3 py-2 text-right font-medium">Survival</th>
                </tr>
              </thead>
              <tbody>
                {detail.per_map.map((m) => {
                  const kd = m.deaths ? m.kills / m.deaths : m.kills;
                  const openWr = m.opening_kills + m.opening_deaths > 0
                    ? m.opening_kills / (m.opening_kills + m.opening_deaths)
                    : 0;
                  const surv = m.rounds_played ? m.rounds_alive / m.rounds_played : 0;
                  return (
                    <tr key={m.map_name} className="border-b border-cs2-border/20">
                      <td className="px-3 py-1.5 font-semibold text-white">{m.map_name}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-cs2-muted">{m.matches}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-cs2-muted">{m.rounds_played}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${kd >= 1 ? "text-cs2-green" : "text-cs2-red"}`}>
                        {kd.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-300">{m.kills}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-400">{m.deaths}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-300">{Math.round(openWr * 100)}%</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-300">{Math.round(surv * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Recent matches */}
          <div className="hud-panel overflow-hidden">
            <div className="px-4 py-2 border-b border-cs2-border/50">
              <h3 className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">
                Recent matches
              </h3>
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-cs2-muted uppercase tracking-[0.08em] border-b border-cs2-border/30">
                  <th className="px-3 py-2 text-left font-medium">Demo</th>
                  <th className="px-3 py-2 text-left font-medium">Map</th>
                  <th className="px-3 py-2 text-right font-medium">Rounds</th>
                  <th className="px-3 py-2 text-right font-medium">K</th>
                  <th className="px-3 py-2 text-right font-medium">D</th>
                  <th className="px-3 py-2 text-right font-medium w-16">Replay</th>
                </tr>
              </thead>
              <tbody>
                {detail.demos.map((d) => (
                  <tr
                    key={d.demo_file}
                    className="border-b border-cs2-border/20 hover:bg-cs2-border/10 cursor-pointer"
                    onClick={() => navigate(`/replay/${encodeURIComponent(d.demo_file)}`)}
                  >
                    <td className="px-3 py-1.5 font-mono text-gray-300 truncate max-w-0">{d.demo_file}</td>
                    <td className="px-3 py-1.5 text-gray-400">{d.map_name}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-cs2-muted">{d.rounds_played}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-300">{d.kills}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-400">{d.deaths}</td>
                    <td className="px-3 py-1.5 text-right">
                      <span className="text-cs2-accent text-[11px]">▶</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
