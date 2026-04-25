import { useEffect, useState } from "react";

/**
 * Animate a number from 0 → target once `active` becomes true. Uses a
 * requestAnimationFrame loop with ease-out cubic so the count decelerates
 * into its final value (feels far snappier than linear).
 */
export function useCountUp(target: number, active: boolean, durationMs = 1400) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (!Number.isFinite(target) || target <= 0) {
      setValue(target || 0);
      return;
    }

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, durationMs]);

  return value;
}
