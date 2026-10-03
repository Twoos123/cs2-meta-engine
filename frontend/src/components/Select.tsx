import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Custom select that matches the app's glass / Apple-style look. Native
 * `<select>` elements open an OS-rendered popup that can't be styled with
 * CSS (background, border, highlight color all inherit from the browser
 * theme), so we roll our own.
 *
 * Supports option groups for the "Downloaded / All maps" split the
 * dashboard uses. Keep the API close to a native <select> so swaps are
 * mechanical: `value`, `onChange(value)`, `options[]`, optional `groups[]`.
 *
 * Accessibility: the trigger is a listbox-popup button (aria-haspopup /
 * aria-expanded), the panel is role="listbox" and each row is
 * role="option" + aria-selected. Arrow keys / Home / End move focus
 * between options, Escape closes and returns focus to the trigger.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Optional trailing hint (e.g. "(15)" for demo count). */
  hint?: string;
  /** Optional leading dot color for status indication. */
  dot?: string;
  /** Optional small leading image (e.g. map icon URL). */
  icon?: string;
  disabled?: boolean;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  placeholder?: string;
  className?: string;
  /** Forwarded to the trigger button. */
  title?: string;
  /** Override the trigger width. Defaults to auto-sizing. */
  minWidth?: number;
  /** Accessible name for the trigger. Falls back to the selected label,
   *  then the placeholder. */
  ariaLabel?: string;
}

/** Gap kept between the popover and the viewport edges. */
const EDGE = 8;
/** Preferred max popover height. */
const MAX_H = 360;

interface PopoverPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export default function Select({
  value,
  onChange,
  options,
  groups,
  placeholder = "Select…",
  className = "",
  title,
  minWidth,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  // Flatten groups into a single list when that's how the caller supplied
  // the data. Keeps the render loop below straightforward.
  const allOptions: SelectOption[] = groups
    ? groups.flatMap((g) => g.options)
    : options ?? [];

  const current = allOptions.find((o) => o.value === value);

  // Anchor the popover to the trigger in viewport coords, clamped so it
  // never runs off the right/left edge on phones, and flipped above the
  // trigger when there's more room there than below.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(Math.max(r.width, minWidth ?? 0), vw - EDGE * 2);
      const left = Math.max(EDGE, Math.min(r.left, vw - width - EDGE));
      const below = vh - r.bottom - 6 - EDGE;
      const above = r.top - 6 - EDGE;
      const flipUp = below < Math.min(MAX_H, 220) && above > below;
      const maxHeight = Math.max(120, Math.min(MAX_H, flipUp ? above : below));
      const top = flipUp ? Math.max(EDGE, r.top - 6 - maxHeight) : r.bottom + 6;
      setPos({ top, left, width, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, minWidth]);

  // Close on outside press / Escape. pointerdown covers mouse, touch and pen.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        popoverRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the list when it opens (selected option first) so
  // keyboard users land somewhere sensible.
  useEffect(() => {
    if (!open || !pos) return;
    const list = popoverRef.current;
    if (!list) return;
    const target =
      list.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)') ??
      list.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
    // Only on open — not on every reposition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos !== null]);

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      items[next].focus();
    }
  };

  const renderOption = (o: SelectOption) => {
    const isActive = o.value === value;
    return (
      <button
        key={o.value}
        type="button"
        role="option"
        aria-selected={isActive}
        aria-disabled={o.disabled || undefined}
        aria-label={o.hint ? `${o.label} ${o.hint}` : o.label}
        disabled={o.disabled}
        onClick={() => {
          onChange(o.value);
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-cs2-accent/60 ${
          isActive
            ? "bg-cs2-accent/15 text-cs2-accent"
            : "text-gray-200 hover:bg-white/[0.06] focus-visible:bg-white/[0.06]"
        } ${o.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      >
        {o.dot && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: o.dot, boxShadow: `0 0 6px ${o.dot}80` }}
            aria-hidden
          />
        )}
        {o.icon && (
          <img
            src={o.icon}
            alt=""
            aria-hidden
            className="w-4 h-4 object-contain shrink-0"
          />
        )}
        <span className="flex-1 truncate">{o.label}</span>
        {o.hint && (
          <span className="text-[10px] font-mono text-cs2-muted shrink-0">{o.hint}</span>
        )}
        {isActive && (
          <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0" aria-hidden>
            <path d="M3 7l3 3 5-6" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    );
  };

  const listId = `${id}-list`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel ?? current?.label ?? placeholder}
        title={title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`hud-input flex items-center gap-2 cursor-pointer py-1.5 px-3 text-xs font-medium max-w-full ${className}`}
        style={minWidth ? { minWidth } : undefined}
      >
        {current?.icon && (
          <img src={current.icon} alt="" className="w-4 h-4 object-contain shrink-0" aria-hidden />
        )}
        <span className="truncate flex-1 text-left">
          {current?.label ?? placeholder}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""} text-cs2-muted`}
          aria-hidden
        >
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && pos && createPortal(
        /* Rendered into document.body via a portal so ancestors with
           `backdrop-filter` (every .hud-panel) don't establish a new
           containing block for this fixed-positioned popover. Without
           the portal, the popover anchors inside the filter panel rather
           than to the viewport, drifting off-screen. */
        <div
          ref={popoverRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel ?? placeholder}
          onKeyDown={onListKeyDown}
          className="fixed z-50 rounded-xl border border-white/10 bg-[#0e1322]/95 backdrop-blur-xl shadow-[0_20px_50px_-10px_rgba(0,0,0,0.85)] p-1.5 overflow-y-auto overscroll-contain"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
        >
          {groups
            ? groups.map((g, gi) => {
                const labelId = `${id}-g${gi}`;
                return (
                  <div
                    key={g.label}
                    role="group"
                    aria-labelledby={labelId}
                    className="mb-1 last:mb-0"
                  >
                    <div
                      id={labelId}
                      className="px-3 py-1.5 text-[10px] font-semibold text-cs2-muted uppercase tracking-[0.18em]"
                    >
                      {g.label}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {g.options.map(renderOption)}
                    </div>
                  </div>
                );
              })
            : (options ?? []).map(renderOption)}
        </div>,
        document.body,
      )}
    </>
  );
}
