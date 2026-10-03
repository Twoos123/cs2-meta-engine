import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RATING_2_EXPLAINER } from "../api/players";

interface Props {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  /** Native tooltip on the whole tile (e.g. a definition). */
  title?: string;
}

export default function PlayerStatTile({ label, value, sub, color, title }: Props) {
  return (
    <div className="hud-panel p-3 flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] text-cs2-muted uppercase tracking-[0.12em] font-semibold">
        {label}
      </span>
      <span
        className="text-2xl font-bold font-mono"
        style={{ color: color ?? "#ffffff" }}
      >
        {value}
      </span>
      {sub && <span className="text-[10px] text-cs2-muted">{sub}</span>}
    </div>
  );
}

const POPOVER_W = 260;

/**
 * Small "i" button explaining the Rating 2.0 approximation. Opens on hover
 * (mouse), tap or keyboard focus. The popover is portalled to <body> with
 * `position: fixed` and clamped to the viewport, so scrolling table
 * containers can't clip it and it never causes horizontal page scroll.
 */
export function RatingInfo({ version }: { version?: string }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const width = Math.min(POPOVER_W, vw - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, vw - width - 8));
    setPos({ left, top: r.bottom + 6, width });
  }, []);
  const close = useCallback(() => setPos(null), []);
  const isOpen = pos != null;

  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: Event) => {
      if (btnRef.current && e.target instanceof Node && btnRef.current.contains(e.target)) return;
      close();
    };
    // Follow the button while scrolling rather than closing, so the
    // automatic scroll-into-view on tap doesn't dismiss it instantly.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onDoc);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onDoc);
    };
  }, [isOpen, place, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="About the rating"
        aria-expanded={isOpen}
        // Open-only on click (taps also fire focus/enter); it closes on
        // outside tap, blur or mouse leave.
        onClick={(e) => {
          e.stopPropagation();
          place();
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && place()}
        onPointerLeave={(e) => e.pointerType === "mouse" && close()}
        onFocus={place}
        onBlur={close}
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-cs2-muted/50 text-[8px] font-bold leading-none text-cs2-muted hover:text-cs2-accent hover:border-cs2-accent/60 align-middle normal-case tracking-normal"
      >
        i
      </button>
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="fixed z-[100] rounded-md border border-cs2-border p-2.5 text-[11px] leading-snug text-gray-300 normal-case tracking-normal font-normal text-left whitespace-normal shadow-lg"
            style={{ left: pos.left, top: pos.top, width: pos.width, background: "#0b0f19" }}
          >
            <p className="font-semibold text-white mb-1">Rating 2.0 (approx.)</p>
            <p>{RATING_2_EXPLAINER}</p>
            {version === "1.0" && (
              <p className="mt-1.5 text-yellow-400/90">
                This value is Rating 1.0: there is no damage data for these demos.
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
