import { useNavigate } from "react-router-dom";

const sections = [
  {
    title: "Grenade Lineups",
    description: "Pro lineup database mined from HLTV demos. Impact-ranked with technique detection, radar overlays, and practice commands.",
    route: "/lineups",
    color: "#22d3ee",
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
        <line x1="12" y1="2" x2="12" y2="6" />
        <line x1="12" y1="18" x2="12" y2="22" />
        <line x1="2" y1="12" x2="6" y2="12" />
        <line x1="18" y1="12" x2="22" y2="12" />
      </svg>
    ),
  },
  {
    title: "Match Replay",
    description: "Full 2D match replay with grenade visualization, kill feed, economy tracking, heatmaps, and per-player stats.",
    route: "/replay",
    color: "#4ade80",
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    title: "Anti-Strat",
    description: "Multi-demo opponent scouting. Site hit frequency, utility tendencies, AWP positions, and per-player breakdowns.",
    route: "/anti-strat",
    color: "#f87171",
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
  },
];

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#05070d]">
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center px-6" style={{ scrollbarWidth: "thin" }}>
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">CS2 Meta Engine</h1>
        <p className="text-cs2-muted text-sm mb-10 text-center max-w-md">
          Pro-level demo analysis — grenade lineups, match replay, and opponent scouting.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl w-full">
          {sections.map((s) => (
            <button
              key={s.route}
              onClick={() => navigate(s.route)}
              className="hud-panel p-5 text-left transition-all duration-150"
              style={{ borderColor: `${s.color}15` }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = `${s.color}50`;
                e.currentTarget.style.boxShadow = `0 0 15px ${s.color}10`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = `${s.color}15`;
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <div className="flex items-center gap-2.5 mb-3" style={{ color: s.color }}>
                {s.icon}
                <span className="text-sm font-semibold text-white">{s.title}</span>
              </div>
              <p className="text-xs text-cs2-muted leading-relaxed">{s.description}</p>
              <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: s.color }}>
                Open →
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
