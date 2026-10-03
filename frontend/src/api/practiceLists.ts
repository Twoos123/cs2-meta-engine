/**
 * Practice lists — saved lineups per map, exported as a CS2 .cfg that
 * cycles through them with two bound keys.
 */
import { api } from "./client";

export interface PracticeItem {
  item_id: number;
  cluster_id: number;
  position: number;
  note: string;
  label: string | null;
  grenade_type: string;
  throw_x: number;
  throw_y: number;
  throw_z: number;
  pitch: number;
  yaw: number;
  primary_technique: string | null;
  primary_click: string | null;
  side: string | null;
}

export interface PracticeList {
  id: number;
  name: string;
  map_name: string;
  created_at: string;
  slug: string;
  exec_command: string;
  items: PracticeItem[];
}

export interface InstallResult {
  path: string;
  filename: string;
  command: string;
}

export interface CycleKeys {
  next_key?: string;
  prev_key?: string;
}

const base = "/practice-lists";

export const listPracticeLists = async (mapName: string): Promise<PracticeList[]> =>
  (await api.get<PracticeList[]>(base, { params: { map_name: mapName } })).data;

export const createPracticeList = async (
  name: string,
  mapName: string,
): Promise<PracticeList> =>
  (await api.post<PracticeList>(base, { name, map_name: mapName })).data;

export const renamePracticeList = async (id: number, name: string): Promise<PracticeList> =>
  (await api.patch<PracticeList>(`${base}/${id}`, { name })).data;

export const deletePracticeList = async (id: number): Promise<void> => {
  await api.delete(`${base}/${id}`);
};

export const addPracticeItem = async (
  id: number,
  clusterId: number,
  mapName: string,
  note = "",
): Promise<PracticeList> =>
  (
    await api.post<PracticeList>(`${base}/${id}/items`, {
      cluster_id: clusterId,
      map_name: mapName,
      note,
    })
  ).data;

export const updatePracticeItemNote = async (
  id: number,
  itemId: number,
  note: string,
): Promise<PracticeList> =>
  (await api.patch<PracticeList>(`${base}/${id}/items/${itemId}`, { note })).data;

export const removePracticeItem = async (id: number, itemId: number): Promise<PracticeList> =>
  (await api.delete<PracticeList>(`${base}/${id}/items/${itemId}`)).data;

export const reorderPracticeItems = async (
  id: number,
  itemIds: number[],
): Promise<PracticeList> =>
  (await api.put<PracticeList>(`${base}/${id}/order`, { item_ids: itemIds })).data;

/** Fetch the .cfg text and hand it to the browser as a file download. */
export const downloadPracticeCfg = async (
  list: PracticeList,
  keys: CycleKeys = {},
): Promise<void> => {
  const res = await api.get<string>(`${base}/${list.id}/cfg`, {
    params: keys,
    responseType: "text",
    // Keep the body as text; error bodies are JSON and parsed below.
    transformResponse: [(d) => d],
  }).catch((err) => {
    const data = err?.response?.data;
    if (typeof data === "string") {
      try {
        err.response.data = JSON.parse(data);
      } catch {
        /* leave as-is */
      }
    }
    throw err;
  });
  const blob = new Blob([res.data], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `practice_${list.slug}.cfg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const installPracticeCfg = async (
  id: number,
  keys: CycleKeys = {},
): Promise<InstallResult> =>
  (await api.post<InstallResult>(`${base}/${id}/install`, null, { params: keys })).data;

/** True when a stored item is the given lineup. Cluster ids are reassigned
 *  when the pipeline re-runs, so the stand position must match too. */
export const itemMatchesLineup = (
  item: PracticeItem,
  cluster: { cluster_id: number; throw_centroid_x: number; throw_centroid_y: number },
): boolean =>
  item.cluster_id === cluster.cluster_id &&
  Math.abs(item.throw_x - cluster.throw_centroid_x) < 1 &&
  Math.abs(item.throw_y - cluster.throw_centroid_y) < 1;
