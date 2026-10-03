/**
 * Demo auto-import API: folder watcher settings/status, archive uploads.
 * Backend: backend/api/imports.py (`/api/import/*`).
 */
import { api, apiErrorMessage } from "./client";

export { apiErrorMessage };

export interface WatchFolder {
  /** Stored entry: "@cs2-replays", "@inbox", "@downloads" or an absolute path. */
  id: string;
  kind: "cs2" | "inbox" | "downloads" | "custom";
  label: string;
  /** Resolved path on the backend machine (null when CS2 isn't found). */
  path: string | null;
  exists: boolean;
}

export interface ImportSettings {
  watch_folders: string[];
  watch_downloads: boolean;
  /** SteamID64 of the user's own account ("" when unset). */
  my_steamid: string;
  auto_run_pipeline: boolean;
  enabled: boolean;
  folders: WatchFolder[];
  downloads_path: string;
  default_folders: string[];
}

export type ImportSettingsUpdate = Partial<
  Pick<ImportSettings, "watch_folders" | "watch_downloads" | "my_steamid" | "auto_run_pipeline" | "enabled">
>;

export interface RecentImport {
  source: string;
  name: string;
  origin: "watch" | "upload" | "hltv" | string;
  status: "imported" | "error" | string;
  demos: string[];
  error: string | null;
  /** pending → timeline parse queued; done / failed afterwards. */
  parse_state: "pending" | "done" | "failed" | null;
  size: number;
  imported_at: number;
}

export interface ImportStatus {
  watcher_running: boolean;
  enabled: boolean;
  scanning: boolean;
  interval_s: number;
  last_scan_at: number | null;
  last_scan_found: number;
  last_scan_imported: number;
  last_error: string | null;
  parsing: string | null;
  parse_queue: number;
  folders: WatchFolder[];
  recent: RecentImport[];
  pending_hltv: { match_id: number; maps: string[]; created_at: number }[];
  rar_support: boolean;
}

export interface ImportResult {
  source: string;
  status: "imported" | "duplicate" | "skipped" | "error";
  demos: string[];
  new_demos: string[];
  maps: string[];
  error: string | null;
}

export interface UploadImportResponse {
  source: string;
  status: "imported" | "duplicate";
  demos: string[];
  new_demos: string[];
  maps: string[];
}

/** File types the upload endpoint accepts (for <input accept>). */
export const IMPORT_ACCEPT = ".dem,.rar,.zip,.gz,.bz2,.zst,application/octet-stream";
const IMPORT_SUFFIXES = [".dem", ".rar", ".zip", ".gz", ".bz2", ".zst"];

export const isImportableFile = (name: string): boolean => {
  const low = name.toLowerCase();
  return IMPORT_SUFFIXES.some((s) => low.endsWith(s));
};

export const getImportSettings = async (): Promise<ImportSettings> => {
  const { data } = await api.get<ImportSettings>("/import/settings");
  return data;
};

export const updateImportSettings = async (
  update: ImportSettingsUpdate,
): Promise<ImportSettings> => {
  const { data } = await api.put<ImportSettings>("/import/settings", update);
  return data;
};

export const getImportStatus = async (): Promise<ImportStatus> => {
  const { data } = await api.get<ImportStatus>("/import/status");
  return data;
};

export const scanImportsNow = async (): Promise<{
  handled: number;
  imported: number;
  results: ImportResult[];
}> => {
  const { data } = await api.post("/import/scan");
  return data;
};

export const uploadImport = async (
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadImportResponse> => {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<UploadImportResponse>("/import/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
    },
    timeout: 30 * 60 * 1000, // big archives: upload + extraction
  });
  return data;
};
