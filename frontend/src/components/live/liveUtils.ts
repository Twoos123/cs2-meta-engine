import type { GsiTeamSide } from "../../api/gsi";

export const T_COLOR = "#DCBF6E";
export const CT_COLOR = "#5B9BD5";
export const NEUTRAL_COLOR = "#94a3b8";

export const teamColor = (team: GsiTeamSide | null | undefined): string =>
  team === "CT" ? CT_COLOR : team === "T" ? T_COLOR : NEUTRAL_COLOR;

export const hpColor = (hp: number): string =>
  hp > 50 ? "#4ade80" : hp > 25 ? "#fbbf24" : "#f87171";

/** No update for longer than this → the UI flags the feed as stale. */
export const STALE_AFTER_S = 3;
/** Older than this the radar is hidden and the page goes back to "waiting". */
export const GONE_AFTER_S = 60;

const WEAPON_LABELS: Record<string, string> = {
  ak47: "AK-47", m4a1: "M4A4", m4a1_silencer: "M4A1-S", awp: "AWP", ssg08: "Scout",
  famas: "FAMAS", galilar: "Galil", aug: "AUG", sg556: "SG 553", g3sg1: "G3SG1",
  scar20: "SCAR-20", mac10: "MAC-10", mp9: "MP9", mp7: "MP7", mp5sd: "MP5-SD",
  ump45: "UMP-45", p90: "P90", bizon: "PP-Bizon", nova: "Nova", xm1014: "XM1014",
  mag7: "MAG-7", sawedoff: "Sawed-Off", m249: "M249", negev: "Negev",
  glock: "Glock-18", usp_silencer: "USP-S", hkp2000: "P2000", p250: "P250",
  fiveseven: "Five-SeveN", tec9: "Tec-9", cz75a: "CZ75", deagle: "Deagle",
  revolver: "R8", elite: "Dualies", taser: "Zeus", c4: "C4",
  smokegrenade: "Smoke", flashbang: "Flash", hegrenade: "HE", molotov: "Molotov",
  incgrenade: "Incendiary", decoy: "Decoy",
};

export const weaponLabel = (w: string | null | undefined): string => {
  if (!w) return "—";
  if (w.startsWith("knife") || w === "bayonet") return "Knife";
  return WEAPON_LABELS[w] ?? w.replace(/_/g, " ").toUpperCase();
};

export const UTILITY_COLORS: Record<string, string> = {
  smokegrenade: "#cbd5e1",
  smoke: "#cbd5e1",
  flashbang: "#fde047",
  hegrenade: "#f87171",
  frag: "#f87171",
  molotov: "#fb923c",
  incgrenade: "#fb923c",
  firebomb: "#fb923c",
  inferno: "#fb923c",
  decoy: "#86efac",
};

export const PHASE_LABELS: Record<string, string> = {
  freezetime: "Freeze time",
  live: "Round live",
  bomb: "Bomb planted",
  defuse: "Defusing",
  over: "Round over",
  warmup: "Warmup",
  warmup_round: "Warmup",
  intermission: "Half time",
  gameover: "Match over",
  paused: "Paused",
  timeout_ct: "CT timeout",
  timeout_t: "T timeout",
};

export const phaseLabel = (p: string | null | undefined): string =>
  (p && PHASE_LABELS[p]) || (p ? p.replace(/_/g, " ") : "—");

export const fmtClock = (secs: number | null | undefined): string => {
  if (secs == null || !Number.isFinite(secs)) return "--:--";
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const fmtMoney = (m: number | null | undefined): string =>
  m == null ? "—" : `$${m.toLocaleString("en-US")}`;

export const prettyMap = (m: string | null | undefined): string =>
  m ? m.replace(/^(de|cs|ar)_/, "").replace(/^\w/, (c) => c.toUpperCase()) : "Unknown map";
