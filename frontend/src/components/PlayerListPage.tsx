import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PlayerProfileSummary,
  listPlayers,
  refreshPlayerStats,
} from "../api/client";

type SortKey = "rating" | "kd" | "kills" | "adr" | "matches";

const ROLE_COLORS: Record<string, string> = {
  AWP: "#5B9BD5",
  Entry: "#f87171",
  Support: "#4ade80",
  Lurker: "#c084fc",
  Rifler: "#22d3ee",
};

export default function PlayerListPage() {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<PlayerProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("rating");
  const [minMatches, setMinMatches] = useState(1);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listPlayers(1);
      setPlayers(rows);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to load players");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshPlayerStats();
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = players.filter((p) => p.matches >= minMatches);
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    if (roleFilter !== "all") rows = rows.filter((p) => p.role === roleFilter);
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "kd": return b.kd_ratio - a.kd_ratio;
        case "kills": return b.kills - a.kills;
        case "adr": return b.rating - a.rating;
        case "matches": return b.matches - a.matches;
        case "rating":
        default: return b.rating - a.rating;
      }
    });
    return rows;
  }, [players, search, roleFilter, sortKey, minMatches]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#05070d] text-cs2-text">
      <nav className="shrink-0 flex items-center gap-3 px-4 py-8 border-b border-cs2-border/50 bg-[#0a0e18]">
        <button onClick={() => navigate("/")} className="hud-btn text-sm py-1.5 px-4 min-w-[72px]" title="Home">←</button>
        <h1 className="text-sm font-semibold text-white uppercase tracking-[0.12em]">Players</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="hud-btn text-sm py-1.5 px-4 min-w-[72px]"
            title="Re-scan cached timelines"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button onClick={() => navigate("/ingest")} className="hud-btn text-sm py-1.5 px-4 min-w-[72px]" title="Ingest demos">Ingest</button>
        </div>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-6xl mx-auto space-y-4">
          {/* Filters */}
          <div className="hud-panel p-3 flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px] space-y-1">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">Search</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Player name..."
                className="hud-input w-full"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">Role</label>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="hud-input"
              >
                <option value="all">All roles</option>
                <option value="AWP">AWP</option>
                <option value="Entry">Entry</option>
                <option value="Support">Support</option>
                <option value="Lurker">Lurker</option>
                <option value="Rifler">Rifler</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">Sort</label>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="hud-input"
              >
                <option value="rating">Rating</option>
                <option value="kd">K/D</option>
                <option value="kills">Kills</option>
                <option value="matches">Matches</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">Min matches</label>
              <input
                type="number"
                min={1}
                value={minMatches}
                onChange={(e) => setMinMatches(Math.max(1, parseInt(e.target.value || "1", 10)))}
                className="hud-input w-20"
              />
            </div>
            <span className="ml-auto text-[11px] text-cs2-muted self-center">
              {filtered.length} of {players.length} players
            </span>
          </div>

          {/* Error / empty */}
          {error && (
            <div className="hud-panel p-4 text-[12px]" style={{ borderColor: "#f87171", color: "#fca5a5" }}>
              {error}
            </div>
          )}
          {loading ? (
            <div className="hud-panel p-8 text-center text-cs2-muted text-sm">Loading players...</div>
          ) : filtered.length === 0 ? (
            <div className="hud-panel p-8 text-center text-cs2-muted text-sm">
              No players yet. Open any demo in the replay viewer to populate stats,
              or click Refresh to rescan cached timelines.
            </div>
          ) : (
            <div className="hud-panel overflow-hidden">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-cs2-muted uppercase tracking-[0.08em] border-b border-cs2-border/50">
                    <th className="px-3 py-2 text-left font-medium w-10">#</th>
                    <th className="px-3 py-2 text-left font-medium">Player</th>
                    <th className="px-3 py-2 text-center font-medium">Role</th>
                    <th className="px-3 py-2 text-right font-medium">Rating</th>
                    <th className="px-3 py-2 text-right font-medium">K/D</th>
                    <th className="px-3 py-2 text-right font-medium">K</th>
                    <th className="px-3 py-2 text-right font-medium">D</th>
                    <th className="px-3 py-2 text-right font-medium">HS%</th>
                    <th className="px-3 py-2 text-right font-medium">Open WR</th>
                    <th className="px-3 py-2 text-right font-medium">Matches</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, idx) => {
                    const roleColor = ROLE_COLORS[p.role] ?? "#94a3b8";
                    return (
                      <tr
                        key={p.steamid}
                        onClick={() => navigate(`/players/${p.steamid}`)}
                        className="border-b border-cs2-border/20 hover:bg-cs2-border/10 cursor-pointer transition-colors"
                      >
                        <td className="px-3 py-1.5 font-mono text-cs2-muted">{idx + 1}</td>
                        <td className="px-3 py-1.5 font-semibold text-white">{p.name}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                            style={{ background: `${roleColor}20`, color: roleColor }}
                          >
                            {p.role}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono font-bold text-white">
                          {p.rating.toFixed(2)}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-mono ${p.kd_ratio >= 1 ? "text-cs2-green" : "text-cs2-red"}`}>
                          {p.kd_ratio.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-300">{p.kills}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-400">{p.deaths}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-300">
                          {Math.round(p.hs_pct * 100)}%
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-300">
                          {Math.round(p.opening_wr * 100)}%
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-cs2-muted">{p.matches}</td>
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
