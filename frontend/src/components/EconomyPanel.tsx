/**
 * EconomyPanel — round-by-round economy tracker.
 * Shows equipment value graph, buy type classification, and loss bonus tracking.
 */
import { useMemo, useState } from "react";
import { MatchInfoResponse, MatchTimeline, RadarInfo } from "../api/client";
import { RoundEconomy, computeRoundEconomies } from "../lib/economy";

interface Props {
  timeline: MatchTimeline;
  radar: RadarInfo | null;
  matchInfo: MatchInfoResponse | null;
}

export default function EconomyPanel({ timeline, matchInfo }: Props) {
  // Per-round economy data (shared with the replay's key moments).
  const roundEconomies = useMemo<RoundEconomy[]>(
    () => (timeline ? computeRoundEconomies(timeline) : []),
    [timeline],
  );

  const maxEquip = useMemo(
    () => Math.max(1, ...roundEconomies.map((r) => Math.max(r.tEquip, r.ctEquip))),
    [roundEconomies],
  );

  const teamNames = useMemo(() => {
    if (matchInfo?.team1 && matchInfo?.team2) {
      const tPlayers = new Set(
        (timeline?.players ?? []).filter((p) => p.team_num === 2).map((p) => p.name.toLowerCase()),
      );
      const team1Players = (matchInfo.team1.players ?? []).map((n) => n.toLowerCase());
      const team1IsT = team1Players.some((n) => tPlayers.has(n));
      return {
        t: team1IsT ? matchInfo.team1.name : matchInfo.team2.name,
        ct: team1IsT ? matchInfo.team2.name : matchInfo.team1.name,
      };
    }
    return { t: "Terrorists", ct: "Counter-Terrorists" };
  }, [matchInfo, timeline]);

  const [hoveredRound, setHoveredRound] = useState<RoundEconomy | null>(null);

  if (roundEconomies.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-cs2-muted">
        <p>No economy data available. Ensure demos are re-parsed with economy fields.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 lg:p-4 space-y-4" style={{ scrollbarWidth: "thin" }}>
      {/* Economy graph */}
      <div className="hud-panel p-3 lg:p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-3">
          <h3 className="text-xs text-cs2-muted uppercase tracking-[0.15em]">
            Team Equipment Value by Round
          </h3>
          {/* Hover info — replaces floating tooltip */}
          {hoveredRound ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
              <span className="text-white font-bold">R{hoveredRound.round}</span>
              <span style={{ color: "#DCBF6E" }}>T: ${hoveredRound.tEquip.toLocaleString()} ({hoveredRound.tBuy.label})</span>
              <span style={{ color: "#5B9BD5" }}>CT: ${hoveredRound.ctEquip.toLocaleString()} ({hoveredRound.ctBuy.label})</span>
              {hoveredRound.winner && (
                <span className="text-cs2-muted">Won: {hoveredRound.winner}</span>
              )}
            </div>
          ) : (
            <span className="text-[10px] text-cs2-muted/50">
              <span className="hidden lg:inline">Hover</span>
              <span className="lg:hidden">Tap</span> a round for details
            </span>
          )}
        </div>
        <div className="relative" style={{ height: 200 }}>
          {/* Bar chart */}
          <div className="flex items-end gap-[2px]" style={{ height: 180 }}>
            {roundEconomies.map((r) => {
              const barH = 170;
              const tH = Math.max(2, (r.tEquip / maxEquip) * barH);
              const ctH = Math.max(2, (r.ctEquip / maxEquip) * barH);
              const isHovered = hoveredRound?.round === r.round;
              return (
                <div
                  key={r.round}
                  className="flex-1 flex flex-col items-center min-w-0 relative justify-end cursor-pointer"
                  style={{ height: 180 }}
                  onMouseEnter={() => setHoveredRound(r)}
                  onMouseLeave={() => setHoveredRound(null)}
                  onClick={() => setHoveredRound(r) /* touch: tap pins details */}
                >
                  <div className="w-full flex items-end gap-[1px]">
                    <div className="flex-1 rounded-t-sm transition-opacity" style={{ height: tH, background: "#DCBF6E", opacity: isHovered ? 1 : 0.75 }} />
                    <div className="flex-1 rounded-t-sm transition-opacity" style={{ height: ctH, background: "#5B9BD5", opacity: isHovered ? 1 : 0.75 }} />
                  </div>
                  <span className={`text-[8px] mt-0.5 shrink-0 ${isHovered ? "text-white font-bold" : "text-cs2-muted/60"}`}>{r.round}</span>
                </div>
              );
            })}
          </div>
          {/* Half divider */}
          {roundEconomies.length > 12 && (
            <div
              className="absolute top-0 bottom-0 w-[1px] bg-cs2-accent/30"
              style={{ left: `${(12 / roundEconomies.length) * 100}%` }}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="w-3 h-2 rounded-sm" style={{ background: "#DCBF6E" }} />
            {teamNames.t} (T)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-2 rounded-sm" style={{ background: "#5B9BD5" }} />
            {teamNames.ct} (CT)
          </span>
        </div>
      </div>

      {/* Round-by-round table */}
      {/* Horizontal scroll on narrow screens; the round column stays pinned. */}
      <div className="hud-panel overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
        <table className="w-full min-w-[640px] text-[11px] whitespace-nowrap">
          <thead>
            <tr className="text-cs2-muted uppercase tracking-[0.1em] border-b border-cs2-border/50">
              <th className="px-3 py-2 text-left font-medium sticky left-0 z-10 bg-[#0b0f1a] lg:static lg:bg-transparent">Rnd</th>
              <th className="px-3 py-2 text-center font-medium">Winner</th>
              <th className="px-3 py-2 text-center font-medium" style={{ color: "#DCBF6E" }}>T Buy</th>
              <th className="px-3 py-2 text-right font-medium" style={{ color: "#DCBF6E" }}>T Equip</th>
              <th className="px-3 py-2 text-right font-medium" style={{ color: "#DCBF6E" }}>T Spent</th>
              <th className="px-3 py-2 text-center font-medium" style={{ color: "#5B9BD5" }}>CT Buy</th>
              <th className="px-3 py-2 text-right font-medium" style={{ color: "#5B9BD5" }}>CT Equip</th>
              <th className="px-3 py-2 text-right font-medium" style={{ color: "#5B9BD5" }}>CT Spent</th>
              <th className="px-3 py-2 text-right font-medium">Loss $</th>
            </tr>
          </thead>
          <tbody>
            {roundEconomies.map((r) => (
              <tr
                key={r.round}
                className={`border-b border-cs2-border/20 hover:bg-cs2-border/10 transition-colors ${
                  r.round === 13 ? "border-t-2 border-t-cs2-accent/30" : ""
                }`}
              >
                <td className="px-3 py-1.5 font-mono font-bold text-white sticky left-0 z-10 bg-[#0b0f1a] lg:static lg:bg-transparent">{r.round}</td>
                <td className="px-3 py-1.5 text-center">
                  {r.winner && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                      style={{
                        background: r.winner === "T" ? "rgba(220,191,110,0.2)" : "rgba(91,155,213,0.2)",
                        color: r.winner === "T" ? "#DCBF6E" : "#5B9BD5",
                      }}
                    >
                      {r.winner}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-center">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.tBuy.color} ${r.tBuy.bg}`}>
                    {r.tBuy.label}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-300">
                  ${r.tEquip.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-400">
                  ${r.tSpent.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-center">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.ctBuy.color} ${r.ctBuy.bg}`}>
                    {r.ctBuy.label}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-300">
                  ${r.ctEquip.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-400">
                  ${r.ctSpent.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-cs2-muted">
                  <span style={{ color: "#DCBF6E" }}>${r.tLossBonus}</span>
                  {" / "}
                  <span style={{ color: "#5B9BD5" }}>${r.ctLossBonus}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
