import { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import LogoMark from "./LogoMark";

/**
 * Shared top-of-page navigation. Every page (landing + every sub-page)
 * renders the exact same component so navigation feels invariant as
 * the user moves around the app.
 *
 * Layout is a strict 3-column flex:
 *   LEFT   — logo + wordmark (click: home)
 *   CENTER — nav links (Lineups / Replay / Anti-Strat / Players / Ingest)
 *   RIGHT  — optional page-specific `actions` slot
 *
 * The "active page" is derived from the current route, not passed in —
 * callers never need to tell the nav which tab to highlight.
 */

const NAV_ITEMS: { label: string; route: string; match: string[] }[] = [
  { label: "Lineups",    route: "/lineups",    match: ["/lineups"] },
  { label: "Replay",     route: "/replay",     match: ["/replay"] },
  { label: "Anti-Strat", route: "/anti-strat", match: ["/anti-strat"] },
  { label: "Players",    route: "/players",    match: ["/players"] },
  { label: "Ingest",     route: "/ingest",     match: ["/ingest"] },
];

export interface AppHeaderProps {
  actions?: ReactNode;
  /** Replace the centered nav-link cluster. Only used by ReplayLayout
   *  which puts a matchup pill in the center. */
  middle?: ReactNode;
}

export default function AppHeader({ actions, middle }: AppHeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname;

  const isActive = (match: string[]) =>
    match.some((m) => currentPath === m || currentPath.startsWith(m + "/"));

  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#05070d]/70 backdrop-blur-xl">
      {/* relative container — the nav-link cluster is absolutely centered
          to the container, so it stays at the exact horizontal midpoint
          regardless of how wide the logo or the actions slot grow. A
          plain flex grid with `auto 1fr auto` would shift center when
          the right column changes size between pages. */}
      <nav className="relative max-w-7xl mx-auto flex items-center px-6 py-4 h-[64px]">
        {/* LEFT — logo / wordmark */}
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2.5 group shrink-0"
          title="Home"
        >
          <LogoMark className="w-5 h-5 transition-transform group-hover:scale-110" />
          <span className="text-sm font-semibold tracking-tight text-white hidden sm:inline">
            CS2 Meta Engine
          </span>
        </button>

        {/* CENTER — nav links. Absolute-positioned at the container's
            horizontal midpoint, hidden when it would collide with the
            logo/actions on narrow screens. `pointer-events-none` on the
            wrapper so the empty flanks don't steal clicks; re-enabled on
            the children. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          {middle ?? (
            <div className="hidden md:flex items-center gap-1 text-xs pointer-events-auto">
              {NAV_ITEMS.map((item) => {
                const active = isActive(item.match);
                return (
                  <button
                    key={item.route}
                    onClick={() => navigate(item.route)}
                    className={`px-3 py-1.5 rounded-full transition ${
                      active
                        ? "text-cs2-accent bg-cs2-accent/10"
                        : "text-cs2-muted hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* RIGHT — page-specific actions. `ml-auto` pushes it to the far
            right; it never influences the visual center of the nav. */}
        <div className="ml-auto flex items-center justify-end gap-2 flex-wrap shrink-0">
          {actions}
        </div>
      </nav>
    </header>
  );
}
