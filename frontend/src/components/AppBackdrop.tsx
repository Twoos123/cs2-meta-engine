/**
 * Subtle gradient-orb backdrop for interior app pages. Sits behind the
 * page content at low opacity so information-dense UIs (Dashboard,
 * Anti-Strat, etc.) don't get drowned by hero-strength color.
 *
 * Orbs are fixed-positioned and pointer-events: none, so they never
 * affect scroll or interaction. They inherit the same `orb-*` drift
 * animations defined in index.css.
 */
export default function AppBackdrop({ tone = "cyan" }: { tone?: "cyan" | "green" | "violet" | "amber" }) {
  const palettes: Record<string, [string, string]> = {
    cyan:   ["#22d3ee", "#8b5cf6"],
    green:  ["#4ade80", "#22d3ee"],
    violet: ["#c084fc", "#22d3ee"],
    amber:  ["#facc15", "#22d3ee"],
  };
  const [c1, c2] = palettes[tone] ?? palettes.cyan;

  return (
    <div className="fixed inset-0 pointer-events-none z-0" aria-hidden>
      <div
        className="orb orb-1"
        style={{
          top: "-20%",
          left: "-10%",
          width: "560px",
          height: "560px",
          background: `radial-gradient(circle, ${c1} 0%, transparent 70%)`,
          opacity: 0.18,
        }}
      />
      <div
        className="orb orb-2"
        style={{
          top: "30%",
          right: "-15%",
          width: "620px",
          height: "620px",
          background: `radial-gradient(circle, ${c2} 0%, transparent 70%)`,
          opacity: 0.14,
        }}
      />
    </div>
  );
}
