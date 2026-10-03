import { ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import LogoMark from "./LogoMark";

/**
 * Shared top-of-page navigation. Every page (landing + every sub-page)
 * renders the exact same component so navigation feels invariant as
 * the user moves around the app.
 *
 * Desktop (lg+) layout is a strict 3-column flex:
 *   LEFT   — logo + wordmark (click: home)
 *   CENTER — nav links (or the `middle` slot)
 *   RIGHT  — optional page-specific `actions` slot
 *
 * Below lg the nav links collapse into a menu button, and `middle` /
 * `actions` drop onto their own rows under the logo bar so nothing
 * overlaps on phones and tablets. Actions render exactly once either way.
 *
 * The "active page" is derived from the current route, not passed in —
 * callers never need to tell the nav which tab to highlight.
 */

// Full inline header (nav + actions on one row) from lg up. Between md and
// lg the centered nav collides with page actions, so tablets get the
// compact layout too.
const WIDE_QUERY = "(min-width: 1024px)";

function useIsWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

const NAV_ITEMS: { label: string; route: string; match: string[] }[] = [
  { label: "Lineups",    route: "/lineups",    match: ["/lineups"] },
  { label: "Replay",     route: "/replay",     match: ["/replay"] },
  { label: "Anti-Strat", route: "/anti-strat", match: ["/anti-strat"] },
  { label: "Players",    route: "/players",    match: ["/players"] },
  { label: "Matches",    route: "/matches",    match: ["/matches"] },
  { label: "Live",       route: "/live",       match: ["/live"] },
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
  const [menuOpen, setMenuOpen] = useState(false);
  const wide = useIsWide();

  // Close the mobile menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [currentPath]);

  const isActive = (match: string[]) =>
    match.some((m) => currentPath === m || currentPath.startsWith(m + "/"));

  const navButtons = (mobile: boolean) =>
    NAV_ITEMS.map((item) => {
      const active = isActive(item.match);
      return (
        <button
          key={item.route}
          onClick={() => navigate(item.route)}
          aria-current={active ? "page" : undefined}
          className={`rounded-full transition ${
            mobile ? "px-4 py-3 text-sm text-left" : "px-3 py-1.5"
          } ${
            active
              ? "text-cs2-accent bg-cs2-accent/10"
              : "text-cs2-muted hover:text-white hover:bg-white/5"
          }`}
        >
          {item.label}
        </button>
      );
    });

  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#05070d]/80 backdrop-blur-xl">
      {/* Wide layout: logo and actions sit in equal flex-1 flanks with
          `min-w-max`, so the nav links are exactly centered while both
          flanks fit, and slide sideways (never overlap) when a page's
          actions are wider than the logo. */}
      <nav
        className="relative max-w-7xl mx-auto flex items-center gap-4 px-4 sm:px-6 h-14 lg:h-[64px]"
        aria-label="Main"
      >
        {/* LEFT — logo / wordmark */}
        <div className={wide ? "flex-1 min-w-max flex" : "flex"}>
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-2.5 group shrink-0"
            title="Home"
            aria-label="Home"
          >
            <LogoMark className="w-5 h-5 transition-transform group-hover:scale-110" />
            <span className="text-sm font-semibold tracking-tight text-white">
              CS2 Meta Engine
            </span>
          </button>
        </div>

        {wide ? (
          <>
            {/* CENTER — nav links or the page's `middle` slot. */}
            <div className="shrink-0 flex items-center gap-1 text-xs">
              {middle ?? navButtons(false)}
            </div>

            {/* RIGHT — page-specific actions. */}
            <div className="flex-1 min-w-max flex items-center justify-end gap-2">
              {actions}
            </div>
          </>
        ) : (
        <button
          type="button"
          className="ml-auto -mr-2 p-2.5 rounded-lg text-cs2-muted hover:text-white hover:bg-white/5"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            {menuOpen ? (
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            ) : (
              <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            )}
          </svg>
        </button>
        )}
      </nav>

      {/* Compact: nav menu drawer */}
      {!wide && menuOpen && (
        <div id="mobile-nav" className="border-t border-white/5 px-4 py-2">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap">{navButtons(true)}</div>
        </div>
      )}

      {/* Compact: middle + actions get their own rows so they never collide
          with the logo bar. */}
      {!wide && (middle || actions) && (
        <div className="border-t border-white/5 px-4 py-2 flex flex-col gap-2">
          {middle && <div className="flex items-center justify-center min-w-0">{middle}</div>}
          {actions && (
            <div className="flex items-center gap-2 flex-wrap">{actions}</div>
          )}
        </div>
      )}
    </header>
  );
}
