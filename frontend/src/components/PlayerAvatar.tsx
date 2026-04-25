import { useState } from "react";

/**
 * PlayerAvatar — HLTV body-shot if we have an id, otherwise a
 * deterministic initials-on-color tile generated from the player's name.
 *
 * Caller passes `hltvId` when known (populated via
 * `/api/player-hltv-ids` or `match-info.team1.players_detailed`). When
 * the image fails to load (CORS, missing photo, wrong id) we fall back
 * to the initials version, so the avatar slot always renders something.
 */

export interface PlayerAvatarProps {
  name: string;
  /** HLTV player id — drives the bodyshot image. Optional. */
  hltvId?: number | null;
  size?: number;
  shape?: "circle" | "rounded";
  /** Ring colour — typically a role or team accent. Defaults to the
   *  hashed hue derived from the player's name. */
  accent?: string;
  /** When true (current player being watched), shows a subtle outer
   *  glow. Used by MatchReplayViewer scoreboard. */
  active?: boolean;
  className?: string;
  /** Opaque token appended as `?v=…` to the image URL so the browser
   *  evicts its cached copy. Bumped by the Refresh button on the
   *  Players page after we clear the server-side photo cache, since
   *  otherwise the browser would keep serving the old image for up to
   *  a week (we set max-age=604800 on the proxy response). */
  cacheBust?: string | number;
  /** When true, render nothing at all if we don't have a photo for this
   *  player (missing `hltvId`, or the image 404s). Used by the player
   *  list to avoid showing a row of initials-boxes for non-pro players
   *  who don't have an HLTV profile. */
  hideIfNoImage?: boolean;
}

// Curated palette — every hue is comfortable on the dark background.
const PALETTE: { bg: string; fg: string }[] = [
  { bg: "#0b3a4a", fg: "#67e8f9" }, // teal
  { bg: "#0e3a2b", fg: "#86efac" }, // green
  { bg: "#3c1d54", fg: "#d8b4fe" }, // violet
  { bg: "#4a1d1d", fg: "#fca5a5" }, // red
  { bg: "#4a3a0e", fg: "#fde68a" }, // amber
  { bg: "#1e2f4a", fg: "#93c5fd" }, // blue
  { bg: "#3a1e4a", fg: "#f0abfc" }, // fuchsia
  { bg: "#1a4238", fg: "#5eead4" }, // emerald
  { bg: "#4a2e0e", fg: "#fdba74" }, // orange
  { bg: "#2d3a4a", fg: "#cbd5e1" }, // slate
];

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "??";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function shadeHex(hex: string, percent: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const adjust = (c: number) => {
    const next = Math.round(c + (percent / 100) * 255);
    return Math.max(0, Math.min(255, next));
  };
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(adjust(r))}${toHex(adjust(g))}${toHex(adjust(b))}`;
}

/** Player bodyshot URL — routed through our backend, not HLTV's CDN
 *  directly.
 *
 *  HLTV's `static.hltv.org` bodyshot host is fronted by Cloudflare with a
 *  managed-challenge rule that 403s every hotlink from a third-party
 *  origin. Loading `<img src="https://static.hltv.org/...">` from the
 *  app therefore shows broken images for every player.
 *
 *  The backend's `/api/player-photo/{id}.png` endpoint fetches the image
 *  using the same curl_cffi Chrome-impersonation session the scraper
 *  uses for match pages (which already bypasses the CF check), caches
 *  it to disk, and serves it from our own origin — no CORS, no CF,
 *  fast warm-cache loads. */
export function hltvImageUrl(hltvId: number): string {
  return `/api/player-photo/${hltvId}.png`;
}

export default function PlayerAvatar({
  name,
  hltvId,
  size = 32,
  shape = "circle",
  accent,
  active = false,
  className = "",
  cacheBust,
  hideIfNoImage = false,
}: PlayerAvatarProps) {
  const hash = hashString(name.toLowerCase());
  const { bg, fg } = PALETTE[hash % PALETTE.length];
  const initials = initialsOf(name);
  const radius = shape === "circle" ? "9999px" : "0.5rem";
  const ringColor = accent ?? fg;
  const fontSize = Math.max(10, Math.round(size * 0.42));

  // When the HLTV image fails to load (404, CORS, wrong id) we collapse
  // to the initials-only look. Kept in local state so the swap survives
  // re-renders — useful because the parent often re-renders mid-match.
  const [imgFailed, setImgFailed] = useState(false);
  const showImage =
    typeof hltvId === "number" && Number.isFinite(hltvId) && !imgFailed;

  // `hideIfNoImage`: caller wants the avatar slot gone entirely when we
  // have nothing to render — not a colored initials tile. Returns null
  // which is typically fine even inside flex layouts (no width, no
  // margin). Used by the player list; detail/scoreboard paths keep the
  // initials fallback because they rely on the fixed slot width.
  if (hideIfNoImage && !showImage) {
    return null;
  }

  return (
    <div
      className={`shrink-0 flex items-center justify-center font-bold font-mono uppercase select-none relative overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(135deg, ${bg} 0%, ${shadeHex(bg, -10)} 100%)`,
        color: fg,
        fontSize,
        letterSpacing: "-0.02em",
        border: `1px solid ${ringColor}40`,
        boxShadow: active
          ? `0 0 0 2px ${ringColor}30, 0 0 10px ${ringColor}40`
          : "0 1px 0 rgba(255,255,255,0.05) inset",
      }}
      aria-label={name}
      title={name}
    >
      {/* Initials ONLY render when no image is shown. Rendering them
          behind the img caused bleed-through on HLTV bodyshots — HLTV
          serves transparent-background PNGs (just the player cut-out),
          so any letter behind the image shows right through the empty
          negative space. Rendering conditionally instead keeps the
          fallback clean while making image-backed avatars a pure photo. */}
      {!showImage && <span>{initials}</span>}
      {showImage && (
        <img
          src={
            hltvImageUrl(hltvId!) +
            (cacheBust != null ? `?v=${encodeURIComponent(String(cacheBust))}` : "")
          }
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ borderRadius: radius }}
          onError={() => setImgFailed(true)}
        />
      )}
    </div>
  );
}
