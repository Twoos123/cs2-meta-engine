import { useEffect, useId, useRef, useState } from "react";
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
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  // Flatten groups into a single list when that's how the caller supplied
  // the data. Keeps the render loop below straightforward.
  const allOptions: SelectOption[] = groups
    ? groups.flatMap((g) => g.options)
    : options ?? [];

  const current = allOptions.find((o) => o.value === value);

  // Position the popover under the trigger using a fixed-position portal-
  // like approach (no actual portal needed — the popover is rendered
  // inside the component but absolutely anchored to viewport coords).
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, minWidth ?? 0) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, minWidth]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
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
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const renderOption = (o: SelectOption) => {
    const isActive = o.value === value;
    return (
      <button
        key={o.value}
        type="button"
        role="option"
        aria-selected={isActive}
        disabled={o.disabled}
        onClick={() => {
          onChange(o.value);
          setOpen(false);
        }}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg transition-colors ${
          isActive
            ? "bg-cs2-accent/15 text-cs2-accent"
            : "text-gray-200 hover:bg-white/[0.06]"
        } ${o.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      >
        {o.dot && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: o.dot, boxShadow: `0 0 6px ${o.dot}80` }}
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={`hud-input flex items-center gap-2 cursor-pointer py-1.5 px-3 text-xs font-medium ${className}`}
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
          id={`${id}-list`}
          role="listbox"
          className="fixed z-50 rounded-xl border border-white/10 bg-[#0e1322]/95 backdrop-blur-xl shadow-[0_20px_50px_-10px_rgba(0,0,0,0.85)] p-1.5 max-h-[min(360px,60vh)] overflow-y-auto"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {groups
            ? groups.map((g) => (
                <div key={g.label} className="mb-1 last:mb-0">
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-cs2-muted uppercase tracking-[0.18em]">
                    {g.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {g.options.map(renderOption)}
                  </div>
                </div>
              ))
            : (options ?? []).map(renderOption)}
        </div>,
        document.body,
      )}
    </>
  );
}
