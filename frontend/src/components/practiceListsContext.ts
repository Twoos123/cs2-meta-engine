/**
 * Practice-list state for the dashboard, shared with every LineupCard via
 * context so the ☆/★ toggle doesn't need props threaded through the grid.
 */
import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "../api/client";
import {
  PracticeList,
  addPracticeItem,
  createPracticeList,
  deletePracticeList,
  itemMatchesLineup,
  listPracticeLists,
  removePracticeItem,
  renamePracticeList,
} from "../api/practiceLists";

export interface LineupRef {
  cluster_id: number;
  map_name: string;
  throw_centroid_x: number;
  throw_centroid_y: number;
}

export interface PracticeListsState {
  mapName: string;
  lists: PracticeList[];
  activeList: PracticeList | null;
  loading: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  setActiveId: (id: number | null) => void;
  /** Swap in a list returned by the API after an edit. */
  replaceList: (list: PracticeList) => void;
  createList: (name?: string) => Promise<PracticeList>;
  renameList: (id: number, name: string) => Promise<void>;
  deleteList: (id: number) => Promise<void>;
  isSaved: (lineup: LineupRef) => boolean;
  /** Add to / remove from the active list; creates a list when the map has none. */
  toggleLineup: (lineup: LineupRef) => Promise<"added" | "removed">;
}

export const PracticeListsContext = createContext<PracticeListsState | null>(null);

const ACTIVE_KEY = (map: string) => `cs2.practiceList.${map}`;

function readActive(map: string): number | null {
  try {
    const v = localStorage.getItem(ACTIVE_KEY(map));
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function writeActive(map: string, id: number | null) {
  try {
    if (id == null) localStorage.removeItem(ACTIVE_KEY(map));
    else localStorage.setItem(ACTIVE_KEY(map), String(id));
  } catch {
    /* storage blocked */
  }
}

export function defaultListName(mapName: string): string {
  const short = mapName.replace(/^de_/, "");
  return `${short.charAt(0).toUpperCase()}${short.slice(1)} practice`;
}

export function usePracticeListsState(mapName: string): PracticeListsState {
  const [lists, setLists] = useState<PracticeList[]>([]);
  const [activeId, setActiveIdRaw] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setActiveId = useCallback(
    (id: number | null) => {
      setActiveIdRaw(id);
      writeActive(mapName, id);
    },
    [mapName],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLists([]);
    listPracticeLists(mapName)
      .then((ls) => {
        if (cancelled) return;
        setLists(ls);
        const saved = readActive(mapName);
        setActiveIdRaw(ls.some((l) => l.id === saved) ? saved : ls[0]?.id ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(apiErrorMessage(e, "Failed to load practice lists"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mapName]);

  const activeList = useMemo(
    () => lists.find((l) => l.id === activeId) ?? null,
    [lists, activeId],
  );

  const replaceList = useCallback((list: PracticeList) => {
    setLists((prev) => prev.map((l) => (l.id === list.id ? list : l)));
  }, []);

  const createList = useCallback(
    async (name?: string) => {
      const list = await createPracticeList(name?.trim() || defaultListName(mapName), mapName);
      setLists((prev) => [...prev, list]);
      setActiveId(list.id);
      return list;
    },
    [mapName, setActiveId],
  );

  const renameList = useCallback(
    async (id: number, name: string) => {
      replaceList(await renamePracticeList(id, name));
    },
    [replaceList],
  );

  const deleteList = useCallback(
    async (id: number) => {
      await deletePracticeList(id);
      const next = lists.filter((l) => l.id !== id);
      setLists((prev) => prev.filter((l) => l.id !== id));
      if (activeId === id) setActiveId(next[0]?.id ?? null);
    },
    [lists, activeId, setActiveId],
  );

  const isSaved = useCallback(
    (lineup: LineupRef) =>
      !!activeList?.items.some((i) => itemMatchesLineup(i, lineup)),
    [activeList],
  );

  const toggleLineup = useCallback(
    async (lineup: LineupRef): Promise<"added" | "removed"> => {
      let list = activeList;
      const existing = list?.items.find((i) => itemMatchesLineup(i, lineup));
      if (list && existing) {
        replaceList(await removePracticeItem(list.id, existing.item_id));
        return "removed";
      }
      if (!list) list = await createList();
      replaceList(await addPracticeItem(list.id, lineup.cluster_id, lineup.map_name));
      return "added";
    },
    [activeList, createList, replaceList],
  );

  return {
    mapName,
    lists,
    activeList,
    loading,
    error,
    setError,
    setActiveId,
    replaceList,
    createList,
    renameList,
    deleteList,
    isSaved,
    toggleLineup,
  };
}
