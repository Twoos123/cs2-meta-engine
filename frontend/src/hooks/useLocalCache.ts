import { useEffect, useRef, useState } from "react";

/**
 * Tiny localStorage-backed cache with stale-while-revalidate semantics.
 *
 * On mount the hook:
 *   1. Returns any previously-cached value immediately (instant paint).
 *   2. Fires `fetcher()` in the background to refresh the cache.
 *   3. Swaps to the fresh value once it resolves (no flicker — same
 *      instance identity when `fetcher()` returns the same shape).
 *
 * Entries that are older than `ttlMs` are ignored on read but the
 * stored value is still returned — the idea is "always show something
 * instantly, catch up lazily". Use `ttlMs: 0` for no expiry (the cache
 * always returns its last known value until the background fetch
 * completes).
 *
 * Safe when used on multiple pages for the same key — each component
 * runs its own fetcher, which refreshes the shared entry. Versioned
 * on a `v:` prefix so schema changes can bump the key namespace
 * without clashing with old entries.
 */

interface Options<T> {
  /** Human cache key — any stable string. Prefixed internally. */
  key: string;
  /** Pulls fresh data from the server. Runs in the background. */
  fetcher: () => Promise<T>;
  /** How long a cached value is considered "fresh". Older entries are
   *  still returned instantly but trigger a background refresh. */
  ttlMs?: number;
  /** Bump this to invalidate every entry under this key. Handy when
   *  changing the response shape and the old cached value is no longer
   *  compatible with the current component. */
  version?: number;
}

interface StoredEntry<T> {
  v: number;
  t: number;
  data: T;
}

const STORAGE_PREFIX = "cs2meta:cache:";

function readCache<T>(key: string, version: number): StoredEntry<T> | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEntry<T>;
    if (parsed.v !== version) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, version: number, data: T): void {
  try {
    const entry: StoredEntry<T> = { v: version, t: Date.now(), data };
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota exceeded / private mode — silently drop, not worth
    // surfacing to the user. Live network still works without us.
  }
}

export function useLocalCache<T>({
  key,
  fetcher,
  ttlMs = 0,
  version = 1,
}: Options<T>) {
  // Hydrate synchronously from localStorage so the first render already
  // has data where possible — avoids a "Loading…" flash on page reload.
  const initial = (() => {
    const entry = readCache<T>(key, version);
    return entry ? entry.data : null;
  })();

  const [data, setData] = useState<T | null>(initial);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref-holder so the fetch effect doesn't retrigger on every render
  // when the parent passes a fresh `fetcher` closure each pass.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = async () => {
    setFetching(true);
    setError(null);
    try {
      const fresh = await fetcherRef.current();
      setData(fresh);
      writeCache(key, version, fresh);
    } catch (e: any) {
      setError(e?.message ?? "Refresh failed");
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    const entry = readCache<T>(key, version);
    const isStale = !entry || (ttlMs > 0 && Date.now() - entry.t > ttlMs);

    // Always refresh on mount so the cache never drifts more than one
    // session behind reality. When not stale, the refresh still runs
    // but is invisible to the user because the cached data is already
    // on-screen from the initial render.
    if (!entry || isStale || !fetching) {
      refresh();
    }
    // Deliberately only re-run when the key or version changes — the
    // fetcher itself is captured via ref above so inline closures from
    // the parent don't loop us forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  return { data, fetching, error, refresh } as const;
}
