import { useCallback, useEffect, useState } from "react";

/**
 * Scroll-reveal hook. Returns a callback ref + a boolean that flips
 * `true` the first time the element enters the viewport. Pairs with the
 * `.reveal` / `.reveal.in` CSS classes in index.css.
 *
 * Implementation:
 *   - The callback ref just stores the element in state. It does no work
 *     beyond that — no observer lifecycle, no closures over stale values.
 *     Storing the element in React state means that late-mounting
 *     children (content that appears only after a network request
 *     resolves) are handled naturally: when `setEl(node)` fires, the
 *     observer effect re-runs with the new element as a dependency.
 *
 *   - A single useEffect owns the IntersectionObserver. React's effect
 *     cleanup contract handles StrictMode's mount → unmount → mount
 *     double-invoke cleanly: cleanup runs between each pair, so we
 *     never leak a disconnected observer that silently swallows
 *     intersection events.
 *
 *   - Fast-path: if the element is already on screen at the moment the
 *     effect runs (page-top heroes on initial paint), we reveal without
 *     waiting for the observer's async initial callback. Prevents a
 *     first-paint flash of hidden content.
 *
 * One-shot — once shown is true we never un-set it; scrolling back past
 * an already-revealed element shouldn't restart the animation.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  options: IntersectionObserverInit = {
    threshold: 0.12,
    rootMargin: "0px 0px -60px 0px",
  },
) {
  const [el, setEl] = useState<T | null>(null);
  const [shown, setShown] = useState(false);

  const ref = useCallback((node: T | null) => {
    // setEl is idempotent — passing the same node twice (StrictMode
    // re-attach) is a no-op, so no wasted re-renders.
    setEl(node);
  }, []);

  useEffect(() => {
    if (!el || shown) return;

    // Fast-path — element is already in view at effect-run time. Skip
    // the async IntersectionObserver round-trip.
    const rect = el.getBoundingClientRect();
    const inView =
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0;
    if (inView) {
      setShown(true);
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
          break;
        }
      }
    }, options);

    io.observe(el);
    return () => io.disconnect();
    // `options` is passed inline by most callers — we intentionally
    // re-init the observer only when the element changes, not on every
    // render that creates a fresh options literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, shown]);

  return { ref, shown } as const;
}
