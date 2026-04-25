import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getDownloadedDemos, getMaps, getStats } from "../api/client";
import { useReveal } from "../hooks/useReveal";
import { useCountUp } from "../hooks/useCountUp";
import LogoMark from "./LogoMark";
import AppHeader from "./AppHeader";

// -----------------------------------------------------------------------------
// Feature definitions — each card in the bento grid corresponds to one of the
// app's top-level workflows. `span` drives the CSS-grid layout (the first card
// is a "hero" card that spans two columns on desktop).
// -----------------------------------------------------------------------------

interface Feature {
  title: string;
  eyebrow: string;
  description: string;
  route: string;
  color: string;          // CSS color used for hero-glow tint
  colorRgb: string;       // R,G,B string for rgba() interpolation
  span: "wide" | "tall" | "default";
  visual: React.ReactNode;
}

const features: Feature[] = [
  {
    title: "Grenade Lineups",
    eyebrow: "Discover",
    description:
      "Pro lineup database mined from HLTV demos. Impact-ranked with technique detection, radar overlays, and one-click practice commands.",
    route: "/lineups",
    color: "#22d3ee",
    colorRgb: "34, 211, 238",
    span: "wide",
    visual: <LineupVisual />,
  },
  {
    title: "Match Replay",
    eyebrow: "Rewatch",
    description:
      "Full 2D match replay with grenade trails, kill feed, economy tracking, and heatmaps.",
    route: "/replay",
    color: "#4ade80",
    colorRgb: "74, 222, 128",
    span: "default",
    visual: <ReplayVisual />,
  },
  {
    title: "Anti-Strat",
    eyebrow: "Scout",
    description:
      "Multi-demo opponent scouting. Site hit frequency, utility tendencies, and AWP positions.",
    route: "/anti-strat",
    color: "#f87171",
    colorRgb: "248, 113, 113",
    span: "default",
    visual: <AntiStratVisual />,
  },
  {
    title: "Player Profiles",
    eyebrow: "Profile",
    description:
      "Cross-demo aggregated stats. Rating, role inference, per-map and per-side splits.",
    route: "/players",
    color: "#c084fc",
    colorRgb: "192, 132, 252",
    span: "default",
    visual: <PlayerVisual />,
  },
  {
    title: "Ingest Demos",
    eyebrow: "Collect",
    description:
      "Scrape HLTV or FACEIT matches. Parallel download, dedup, and the analysis pipeline feeds every other module.",
    route: "/ingest",
    color: "#facc15",
    colorRgb: "250, 204, 21",
    span: "default",
    visual: <IngestVisual />,
  },
];

// Icons served from frontend/public/icons/maps — sourced from the
// MurkyYT/cs2-map-icons repo, which mirrors Valve's official CS2 map
// icons extracted from the game files.
const MAP_POOL: { name: string; icon: string }[] = [
  { name: "Mirage",   icon: "/icons/maps/de_mirage.png" },
  { name: "Dust2",    icon: "/icons/maps/de_dust2.png" },
  { name: "Inferno",  icon: "/icons/maps/de_inferno.png" },
  { name: "Nuke",     icon: "/icons/maps/de_nuke.png" },
  { name: "Ancient",  icon: "/icons/maps/de_ancient.png" },
  { name: "Anubis",   icon: "/icons/maps/de_anubis.png" },
  { name: "Vertigo",  icon: "/icons/maps/de_vertigo.png" },
  { name: "Overpass", icon: "/icons/maps/de_overpass.png" },
  { name: "Train",    icon: "/icons/maps/de_train.png" },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<{
    lineups: number;
    maps: number;
    demos: number;
  }>({ lineups: 0, maps: 0, demos: 0 });

  // Pull live counts once on mount — these feed the animated hero stat band.
  // Silent failure is fine; the counters just stay at 0.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getStats().catch(() => null), getMaps().catch(() => []), getDownloadedDemos().catch(() => null)])
      .then(([s, m, d]) => {
        if (cancelled) return;
        setStats({
          lineups: s?.total_lineups ?? 0,
          maps: Array.isArray(m) ? m.length : 0,
          demos: d?.total_demos ?? 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#05070d] text-cs2-text">
      {/* ── Top navigation — same component used on every page ─────── */}
      <AppHeader
        actions={
          <button onClick={() => navigate("/lineups")} className="cta-btn text-xs py-2 px-4">
            Open Dashboard
            <span aria-hidden>→</span>
          </button>
        }
      />

      {/* ── Hero ───────────────────────────────────────────────────── */}
      <Hero stats={stats} onPrimary={() => navigate("/lineups")} onSecondary={() => navigate("/replay")} />

      {/* ── Bento grid of features ─────────────────────────────────── */}
      <FeaturesSection features={features} navigate={navigate} />

      {/* ── Map support marquee ────────────────────────────────────── */}
      <MapMarquee />

      {/* ── Closing CTA ────────────────────────────────────────────── */}
      <ClosingCTA onClick={() => navigate("/lineups")} />

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="relative border-t border-white/5 py-10 px-6">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-[11px] text-cs2-muted">
          <div className="flex items-center gap-2">
            <LogoMark className="w-4 h-4" />
            <span>CS2 Meta Engine · Local demo-analysis workspace</span>
          </div>
          <div className="flex items-center gap-5 font-mono uppercase tracking-[0.18em]">
            <span>demoparser2</span>
            <span>·</span>
            <span>FastAPI</span>
            <span>·</span>
            <span>React</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Hero — full-viewport section with drifting gradient orbs, shimmering
// gradient headline, live stat counters, and a scroll cue.
// -----------------------------------------------------------------------------

function Hero({
  stats,
  onPrimary,
  onSecondary,
}: {
  stats: { lineups: number; maps: number; demos: number };
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const heroRef = useRef<HTMLDivElement | null>(null);
  const [scrollY, setScrollY] = useState(0);

  // Cheap parallax — shift the orbs / headline up a bit as the user scrolls,
  // without re-rendering anything heavy. Uses a passive listener and clamps
  // so we stop computing past the hero's height.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrollY(y > 600 ? 600 : y);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const statsVisible = scrollY < 500;
  const lineups = useCountUp(stats.lineups, statsVisible);
  const maps = useCountUp(stats.maps, statsVisible);
  const demos = useCountUp(stats.demos, statsVisible);

  return (
    <section
      ref={heroRef}
      className="relative min-h-[92vh] flex flex-col items-center justify-center px-6 pt-16 pb-24 overflow-hidden"
    >
      {/* Gradient orbs — sit behind everything. Parallax is applied via
          translateY so we never trigger layout, just compositor transforms. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ transform: `translate3d(0, ${scrollY * 0.25}px, 0)` }}
        aria-hidden
      >
        <div
          className="orb orb-1"
          style={{
            top: "-10%",
            left: "-10%",
            width: "640px",
            height: "640px",
            background: "radial-gradient(circle, #22d3ee 0%, transparent 70%)",
          }}
        />
        <div
          className="orb orb-2"
          style={{
            top: "10%",
            right: "-15%",
            width: "720px",
            height: "720px",
            background: "radial-gradient(circle, #8b5cf6 0%, transparent 70%)",
            opacity: 0.4,
          }}
        />
        <div
          className="orb orb-3"
          style={{
            bottom: "-20%",
            left: "30%",
            width: "560px",
            height: "560px",
            background: "radial-gradient(circle, #4ade80 0%, transparent 70%)",
            opacity: 0.28,
          }}
        />
      </div>

      {/* Faint grid lines over the orbs, echoing CS map radars. */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.35) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
        aria-hidden
      />

      {/* Hero content — parallax-shifted opposite to the orbs so depth reads. */}
      <div
        className="relative z-10 max-w-5xl mx-auto text-center flex flex-col items-center"
        style={{ transform: `translate3d(0, ${scrollY * -0.08}px, 0)` }}
      >
        <span className="eyebrow mb-7">
          <span>CS2 META ENGINE</span>
        </span>

        <h1 className="text-[clamp(2.75rem,8vw,6.5rem)] font-bold leading-[1.02] tracking-tight">
          <span className="block text-white">Read the meta.</span>
          <span className="block gradient-text">Win the round.</span>
        </h1>

        <p className="mt-7 max-w-2xl text-base md:text-lg text-cs2-muted leading-relaxed">
          Ingest demos from HLTV or FACEIT. Surface the grenades that actually
          win rounds. Scout opponents with multi-demo aggregated stats — all
          from a local workspace with zero tracking.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <button onClick={onPrimary} className="cta-btn">
            Explore lineups
            <span aria-hidden>→</span>
          </button>
          <button onClick={onSecondary} className="cta-btn-ghost">
            Watch a replay
          </button>
        </div>

        {/* Live stat band — animated counters over a subtle divider line. */}
        <div className="mt-16 w-full max-w-3xl">
          <div className="grid grid-cols-3 gap-4 md:gap-10">
            <HeroStat value={lineups} label="Lineups indexed" accent="#22d3ee" />
            <HeroStat value={demos} label="Demos parsed" accent="#4ade80" />
            <HeroStat value={maps} label="Maps covered" accent="#c084fc" />
          </div>
        </div>

        {/* Scroll cue chevron. */}
        <div className="scroll-cue mt-16 text-cs2-muted flex flex-col items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-[0.3em]">Scroll</span>
          <svg width="12" height="16" viewBox="0 0 12 16" fill="none">
            <path d="M6 1v13m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </section>
  );
}

function HeroStat({ value, label, accent }: { value: number; label: string; accent: string }) {
  return (
    <div className="flex flex-col items-center">
      <div
        className="text-3xl md:text-5xl font-bold font-mono tracking-tight"
        style={{ color: accent }}
      >
        {value.toLocaleString()}
      </div>
      <div className="mt-1.5 text-[10px] md:text-[11px] font-semibold text-cs2-muted uppercase tracking-[0.22em]">
        {label}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Features — bento grid. Each card tilts in 3D based on mouse position and
// glows in its hero color. Cards reveal on scroll with a staggered cascade.
// -----------------------------------------------------------------------------

function FeaturesSection({
  features,
  navigate,
}: {
  features: Feature[];
  navigate: (route: string) => void;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section className="relative px-6 py-32">
      <div className="max-w-7xl mx-auto">
        <div ref={ref} className={`reveal ${shown ? "in" : ""} text-center max-w-3xl mx-auto mb-16`}>
          <span className="eyebrow mb-6">
            <span>THE WORKFLOW</span>
          </span>
          <h2 className="mt-6 text-4xl md:text-5xl font-bold tracking-tight text-white leading-[1.08]">
            Every phase of the{" "}
            <span className="gradient-text">demo workflow</span>,
            <br className="hidden md:block" />
            one surface.
          </h2>
          <p className="mt-6 text-base text-cs2-muted leading-relaxed">
            From raw .dem file to practice command — nothing to configure,
            nothing to upload. It all runs on your machine.
          </p>
        </div>

        {/* Bento grid — rows on desktop:
            [ Grenade Lineups (wide) | Ingest (tall) ]
            [ Match Replay | Anti-Strat | Player Profiles ] */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:auto-rows-[22rem]">
          {features.map((f, i) => (
            <BentoCard
              key={f.route}
              feature={f}
              delayIndex={i}
              onClick={() => navigate(f.route)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function BentoCard({
  feature,
  delayIndex,
  onClick,
}: {
  feature: Feature;
  delayIndex: number;
  onClick: () => void;
}) {
  const { ref, shown } = useReveal<HTMLButtonElement>();
  const innerRef = useRef<HTMLButtonElement | null>(null);

  // 3D tilt — set CSS vars so the transform + radial glow are both driven by
  // the same cursor position. Reset on leave.
  const onMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = innerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rotY = (px - 0.5) * 8; // ±4deg
    const rotX = (0.5 - py) * 8;
    el.style.setProperty("--tilt-x", `${rotX}deg`);
    el.style.setProperty("--tilt-y", `${rotY}deg`);
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
  };

  const onMouseLeave = () => {
    const el = innerRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", `0deg`);
    el.style.setProperty("--tilt-y", `0deg`);
    el.style.setProperty("--mx", `50%`);
    el.style.setProperty("--my", `50%`);
  };

  const spanClass =
    feature.span === "wide"
      ? "md:col-span-2 md:row-span-1"
      : feature.span === "tall"
        ? "md:row-span-2"
        : "";

  const delayClass = `reveal-delay-${Math.min(delayIndex + 1, 5)}`;

  return (
    <button
      ref={(el) => {
        // Merge two refs: our local RefObject (used by the mouse-tilt
        // handler to read the element for getBoundingClientRect) and the
        // callback ref returned by useReveal. useReveal's ref is now a
        // function, so we invoke it as a call — not ref.current = el.
        innerRef.current = el;
        ref(el);
      }}
      onClick={onClick}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={`bento-card reveal ${delayClass} ${shown ? "in" : ""} ${spanClass} p-7 md:p-8 group`}
      style={{ ["--hero-color" as any]: feature.colorRgb }}
    >
      <div className="bento-inner flex flex-col h-full">
        <div className="flex items-center justify-between">
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.22em]"
            style={{ color: feature.color }}
          >
            {feature.eyebrow}
          </span>
          <span
            className="text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: feature.color }}
          >
            Open →
          </span>
        </div>

        <h3 className="mt-3 text-2xl md:text-3xl font-bold tracking-tight text-white">
          {feature.title}
        </h3>
        <p className="mt-2 text-sm text-cs2-muted leading-relaxed max-w-md">
          {feature.description}
        </p>

        <div className="bento-visual mt-auto pt-6 flex-1 min-h-[140px] flex items-end justify-end">
          {feature.visual}
        </div>
      </div>
    </button>
  );
}

// -----------------------------------------------------------------------------
// Map support marquee — horizontally scrolling strip of the supported maps,
// dup'd twice so the CSS animation can loop seamlessly at -50%.
// -----------------------------------------------------------------------------

function MapMarquee() {
  const { ref, shown } = useReveal<HTMLDivElement>();
  // Four copies so 2-copy animation always has at least 2 copies' worth of
  // content visible — seamless loop on ultra-wide monitors too. A single
  // copy of MAP_POOL is narrower than 1080p, so 2× alone leaves a gap on
  // the right when the animation wraps.
  const quadrupled = [...MAP_POOL, ...MAP_POOL, ...MAP_POOL, ...MAP_POOL];

  return (
    <section className="relative py-20 border-y border-white/5 bg-gradient-to-b from-transparent via-white/[0.02] to-transparent">
      <div ref={ref} className={`reveal ${shown ? "in" : ""} max-w-5xl mx-auto px-6 text-center mb-8`}>
        <span className="text-[11px] font-semibold text-cs2-muted uppercase tracking-[0.22em]">
          Supports the active duty pool
        </span>
      </div>
      <div
        className="relative overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(90deg, transparent, black 10%, black 90%, transparent)",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent, black 10%, black 90%, transparent)",
        }}
      >
        {/* No horizontal padding here — px-* on the track would break the
            -50% loop math (paddings live outside the repeated content). */}
        <div className="marquee-track gap-12">
          {quadrupled.map((m, i) => (
            <div
              key={`${m.name}-${i}`}
              className="flex items-center gap-3 shrink-0 text-cs2-muted hover:text-white transition-colors"
            >
              <img
                src={m.icon}
                alt=""
                aria-hidden
                loading="lazy"
                className="w-8 h-8 object-contain opacity-70"
                style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.25))" }}
              />
              <span className="text-sm font-mono uppercase tracking-[0.2em]">
                {m.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Closing CTA — mirror of the hero, half the height. Uses the same gradient
// treatment but anchored center so it feels like a decisive close.
// -----------------------------------------------------------------------------

function ClosingCTA({ onClick }: { onClick: () => void }) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <section className="relative px-6 py-32 overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
      >
        <div
          className="orb orb-1"
          style={{
            top: "20%",
            left: "20%",
            width: "500px",
            height: "500px",
            background: "radial-gradient(circle, #22d3ee 0%, transparent 70%)",
            opacity: 0.25,
          }}
        />
        <div
          className="orb orb-2"
          style={{
            top: "30%",
            right: "20%",
            width: "520px",
            height: "520px",
            background: "radial-gradient(circle, #4ade80 0%, transparent 70%)",
            opacity: 0.2,
          }}
        />
      </div>
      <div
        ref={ref}
        className={`reveal ${shown ? "in" : ""} relative max-w-3xl mx-auto text-center`}
      >
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight text-white leading-[1.05]">
          Ready to <span className="gradient-text">read the meta</span>?
        </h2>
        <p className="mt-6 text-base md:text-lg text-cs2-muted max-w-xl mx-auto leading-relaxed">
          Drop a demo in, let the pipeline run, and the highest-impact lineups
          are one click away.
        </p>
        <div className="mt-10 flex justify-center">
          <button onClick={onClick} className="cta-btn text-sm py-3 px-6">
            Open Dashboard
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Visual vignettes — each feature card gets a bespoke SVG/HTML scene. Kept
// presentational and pointer-events-none so the entire card remains clickable.
// -----------------------------------------------------------------------------

function LineupVisual() {
  return (
    <div className="relative w-full h-[180px] pointer-events-none">
      {/* Radar-like concentric rings with a few dots indicating lineup clusters. */}
      <svg viewBox="0 0 320 180" className="w-full h-full" fill="none">
        <defs>
          <radialGradient id="radar" cx="50%" cy="50%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="160" cy="90" r="80" fill="url(#radar)" />
        {[30, 50, 70, 90].map((r) => (
          <circle
            key={r}
            cx="160"
            cy="90"
            r={r}
            stroke="rgba(34,211,238,0.25)"
            strokeWidth="1"
            strokeDasharray={r % 2 ? "2 6" : ""}
          />
        ))}
        <line x1="80" y1="90" x2="240" y2="90" stroke="rgba(34,211,238,0.18)" strokeWidth="1" />
        <line x1="160" y1="10" x2="160" y2="170" stroke="rgba(34,211,238,0.18)" strokeWidth="1" />
        {/* Cluster dots. */}
        {[
          { x: 130, y: 70, r: 4, o: 1 },
          { x: 200, y: 60, r: 3, o: 0.8 },
          { x: 180, y: 120, r: 5, o: 1 },
          { x: 100, y: 110, r: 3, o: 0.6 },
          { x: 220, y: 100, r: 3, o: 0.7 },
        ].map((d, i) => (
          <circle
            key={i}
            cx={d.x}
            cy={d.y}
            r={d.r}
            fill="#22d3ee"
            opacity={d.o}
            style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.8))" }}
          />
        ))}
        {/* Sweep line — a single arc with gradient. */}
        <path
          d="M 160 90 L 240 60"
          stroke="#22d3ee"
          strokeWidth="1.5"
          opacity="0.8"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function ReplayVisual() {
  return (
    <div className="relative w-full h-[140px] pointer-events-none">
      <svg viewBox="0 0 280 140" className="w-full h-full" fill="none">
        {/* Timeline ruler. */}
        <line x1="10" y1="110" x2="270" y2="110" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        {Array.from({ length: 14 }).map((_, i) => (
          <line
            key={i}
            x1={10 + i * 20}
            y1={105}
            x2={10 + i * 20}
            y2={110}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth="1"
          />
        ))}
        {/* Played-portion gradient. */}
        <line x1="10" y1="110" x2="180" y2="110" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />
        <circle cx="180" cy="110" r="5" fill="#4ade80" style={{ filter: "drop-shadow(0 0 6px rgba(74,222,128,0.9))" }} />

        {/* Event markers. */}
        {[40, 80, 120, 150].map((x, i) => (
          <rect key={i} x={x - 1} y={85} width="2" height="16" fill="rgba(74,222,128,0.5)" />
        ))}

        {/* Player dots clustered on a "map". */}
        <g opacity="0.9">
          {[
            { x: 60, y: 40, c: "#4ade80" },
            { x: 85, y: 30, c: "#4ade80" },
            { x: 110, y: 50, c: "#4ade80" },
            { x: 190, y: 35, c: "#f87171" },
            { x: 215, y: 55, c: "#f87171" },
          ].map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="4" fill={p.c} style={{ filter: `drop-shadow(0 0 5px ${p.c})` }} />
          ))}
        </g>
      </svg>
    </div>
  );
}

function AntiStratVisual() {
  // Stacked bar representing site hit frequency.
  const sites = [
    { label: "A site", pct: 62, color: "#f87171" },
    { label: "Mid", pct: 24, color: "#fb923c" },
    { label: "B site", pct: 14, color: "#fde047" },
  ];
  return (
    <div className="w-full h-[140px] pointer-events-none flex flex-col justify-end gap-2">
      {sites.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-cs2-muted w-16 shrink-0">
            {s.label}
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${s.pct}%`,
                background: `linear-gradient(90deg, ${s.color}40, ${s.color})`,
                boxShadow: `0 0 10px ${s.color}50`,
              }}
            />
          </div>
          <span className="text-[11px] font-mono text-white w-10 text-right">
            {s.pct}%
          </span>
        </div>
      ))}
    </div>
  );
}

function PlayerVisual() {
  // Radar/spider chart with 5 axes — rating / opening / survival / utility / KD.
  const axes = 5;
  const values = [0.9, 0.7, 0.65, 0.85, 0.55];
  const points = values
    .map((v, i) => {
      const angle = (Math.PI * 2 * i) / axes - Math.PI / 2;
      const r = 48 * v;
      return `${60 + Math.cos(angle) * r},${60 + Math.sin(angle) * r}`;
    })
    .join(" ");
  const outer = Array.from({ length: axes })
    .map((_, i) => {
      const angle = (Math.PI * 2 * i) / axes - Math.PI / 2;
      return `${60 + Math.cos(angle) * 48},${60 + Math.sin(angle) * 48}`;
    })
    .join(" ");
  return (
    <div className="w-full h-[140px] pointer-events-none flex items-center justify-center">
      <svg viewBox="0 0 120 120" className="w-32 h-32">
        <polygon points={outer} fill="rgba(192,132,252,0.06)" stroke="rgba(192,132,252,0.3)" strokeWidth="1" />
        {[0.25, 0.5, 0.75].map((s) => (
          <polygon
            key={s}
            points={Array.from({ length: axes })
              .map((_, i) => {
                const angle = (Math.PI * 2 * i) / axes - Math.PI / 2;
                return `${60 + Math.cos(angle) * 48 * s},${60 + Math.sin(angle) * 48 * s}`;
              })
              .join(" ")}
            fill="none"
            stroke="rgba(192,132,252,0.12)"
            strokeWidth="1"
          />
        ))}
        <polygon
          points={points}
          fill="rgba(192,132,252,0.25)"
          stroke="#c084fc"
          strokeWidth="1.5"
          style={{ filter: "drop-shadow(0 0 8px rgba(192,132,252,0.6))" }}
        />
        {values.map((v, i) => {
          const angle = (Math.PI * 2 * i) / axes - Math.PI / 2;
          return (
            <circle
              key={i}
              cx={60 + Math.cos(angle) * 48 * v}
              cy={60 + Math.sin(angle) * 48 * v}
              r="2"
              fill="#c084fc"
            />
          );
        })}
      </svg>
    </div>
  );
}

function IngestVisual() {
  // Small "download" visual — stacked rows representing a queue.
  const rows = [
    { name: "navi-vs-faze-m1.dem", progress: 100, color: "#facc15" },
    { name: "vita-vs-g2-m2.dem", progress: 100, color: "#facc15" },
    { name: "mous-vs-aurora-m1.dem", progress: 72, color: "#facc15" },
    { name: "spirit-vs-falcons-m3.dem", progress: 38, color: "#facc15" },
    { name: "liquid-vs-eternal.dem", progress: 12, color: "#facc15" },
  ];
  return (
    <div className="w-full pointer-events-none flex flex-col gap-2 mt-4">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-cs2-muted truncate flex-1">
            {r.name}
          </span>
          <div className="w-24 h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${r.progress}%`,
                background:
                  r.progress === 100
                    ? `linear-gradient(90deg, ${r.color}30, ${r.color})`
                    : `linear-gradient(90deg, ${r.color}20, ${r.color}aa)`,
                boxShadow:
                  r.progress === 100 ? `0 0 6px ${r.color}70` : `0 0 4px ${r.color}40`,
              }}
            />
          </div>
          <span
            className="text-[10px] font-mono w-8 text-right"
            style={{ color: r.progress === 100 ? "#4ade80" : "#facc15" }}
          >
            {r.progress === 100 ? "✓" : `${r.progress}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tiny presentational bits.
// -----------------------------------------------------------------------------

