/**
 * PracticeListPanel — drawer for the dashboard's practice lists: pick /
 * create / rename / delete a list for the current map, reorder and annotate
 * its lineups, and export it as a CS2 .cfg that cycles through them.
 *
 * Right-hand drawer on sm+, full-screen on phones.
 */
import { type ReactNode, useContext, useEffect, useState } from "react";
import { apiErrorMessage } from "../api/client";
import {
  InstallResult,
  PracticeItem,
  PracticeList,
  downloadPracticeCfg,
  installPracticeCfg,
  removePracticeItem,
  reorderPracticeItems,
  updatePracticeItemNote,
} from "../api/practiceLists";
import Select from "./Select";
import { PracticeListsContext, defaultListName } from "./practiceListsContext";

const GRENADE_ACCENT: Record<string, string> = {
  smokegrenade: "#cbd5e1",
  flashbang: "#fde047",
  hegrenade: "#f87171",
  molotov: "#fb923c",
  decoy: "#9ca3af",
};

const TECHNIQUE_LABEL: Record<string, string> = {
  stand: "Stand",
  walk: "Walk",
  run: "Run",
  crouch: "Crouch",
  jump: "Jump",
  running_jump: "Run + Jump",
};

// Mirrors the backend's key allow-list: a word key or one punctuation key.
const KEY_RE = /^(?:[A-Za-z0-9_]{1,16}|[[\]\-=,./'`])$/;

interface Props {
  open: boolean;
  onClose: () => void;
}

type Mode = "idle" | "create" | "rename";

export default function PracticeListPanel({ open, onClose }: Props) {
  const state = useContext(PracticeListsContext);
  const [mode, setMode] = useState<Mode>("idle");
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallResult | null>(null);
  const [nextKey, setNextKey] = useState("]");
  const [prevKey, setPrevKey] = useState("[");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const activeId = state?.activeList?.id;
  useEffect(() => {
    setMode("idle");
    setStatus(null);
    setInstall(null);
  }, [activeId, state?.mapName]);

  if (!open || !state) return null;
  const { lists, activeList, mapName, error, setError, loading } = state;

  const keysValid = KEY_RE.test(nextKey) && KEY_RE.test(prevKey) && nextKey !== prevKey;
  const keys = { next_key: nextKey, prev_key: prevKey };

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(apiErrorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const submitName = () =>
    run(async () => {
      const name = draftName.trim();
      if (mode === "create") {
        await state.createList(name || defaultListName(mapName));
      } else if (mode === "rename" && activeList && name) {
        await state.renameList(activeList.id, name);
      }
      setMode("idle");
    }, mode === "create" ? "Couldn't create list" : "Couldn't rename list");

  const handleDelete = () => {
    if (!activeList) return;
    if (
      !window.confirm(
        `Delete "${activeList.name}" and its ${activeList.items.length} lineup(s)? Installed .cfg files are left alone.`,
      )
    )
      return;
    run(() => state.deleteList(activeList.id), "Couldn't delete list");
  };

  const move = (list: PracticeList, index: number, delta: number) => {
    const ids = list.items.map((i) => i.item_id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    // Optimistic: swap locally, then take the server's answer.
    const items = ids.map((id) => list.items.find((i) => i.item_id === id)!);
    state.replaceList({ ...list, items });
    run(async () => {
      try {
        state.replaceList(await reorderPracticeItems(list.id, ids));
      } catch (e) {
        state.replaceList(list);
        throw e;
      }
    }, "Couldn't reorder");
  };

  const remove = (list: PracticeList, item: PracticeItem) =>
    run(async () => {
      state.replaceList(await removePracticeItem(list.id, item.item_id));
    }, "Couldn't remove lineup");

  const saveNote = (list: PracticeList, item: PracticeItem, note: string) =>
    run(async () => {
      state.replaceList(await updatePracticeItemNote(list.id, item.item_id, note));
    }, "Couldn't save note");

  const handleDownload = (list: PracticeList) =>
    run(async () => {
      await downloadPracticeCfg(list, keys);
      setStatus(`Downloaded practice_${list.slug}.cfg — put it in game/csgo/cfg.`);
    }, "Download failed");

  const handleInstall = (list: PracticeList) =>
    run(async () => {
      setInstall(null);
      const res = await installPracticeCfg(list.id, keys);
      setInstall(res);
      setStatus(null);
    }, "Install failed");

  const handleCopy = (list: PracticeList) =>
    run(async () => {
      try {
        await navigator.clipboard.writeText(list.exec_command);
        setStatus(`Copied "${list.exec_command}"`);
      } catch {
        setStatus(`Clipboard blocked — type: ${list.exec_command}`);
      }
    }, "Copy failed");

  const startCreate = () => {
    setDraftName(lists.length === 0 ? defaultListName(mapName) : "");
    setMode("create");
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Practice lists"
        onClick={(e) => e.stopPropagation()}
        className="hud-panel absolute inset-0 max-sm:rounded-none sm:inset-y-3 sm:right-3 sm:left-auto sm:w-[440px] flex flex-col overflow-hidden"
        style={{ backgroundColor: "rgba(8, 11, 19, 0.94)" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-white/5">
          <div className="min-w-0">
            <span className="section-eyebrow">PRACTICE LISTS</span>
            <p className="mt-1.5 text-xs text-cs2-muted">
              {mapName} &middot;{" "}
              <span className="text-gray-300 font-mono">{lists.length}</span> list
              {lists.length === 1 ? "" : "s"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close practice lists"
            className="w-10 h-10 -mr-2 -mt-1 shrink-0 rounded-full text-cs2-muted hover:text-white hover:bg-white/5 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <div
          className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-5"
          style={{ scrollbarWidth: "thin" }}
        >
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-cs2-red/30 bg-cs2-red/5 px-3 py-2 text-xs text-cs2-red break-words"
            >
              {error}
            </div>
          )}

          {/* List picker */}
          <section className="space-y-2.5">
            {lists.length > 0 && mode !== "create" && (
              <Select
                value={activeList ? String(activeList.id) : ""}
                onChange={(v) => state.setActiveId(Number(v))}
                className="w-full"
                ariaLabel="Practice list"
                options={lists.map((l) => ({
                  value: String(l.id),
                  label: l.name,
                  hint: String(l.items.length),
                }))}
              />
            )}

            {mode !== "idle" ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitName();
                }}
              >
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  maxLength={60}
                  placeholder={mode === "create" ? defaultListName(mapName) : "List name"}
                  aria-label={mode === "create" ? "New list name" : "Rename list"}
                  className="hud-input flex-1 min-w-0 text-[13px]"
                />
                <button type="submit" disabled={busy} className="hud-btn-primary shrink-0">
                  {mode === "create" ? "Create" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("idle")}
                  className="hud-btn shrink-0 max-sm:px-3"
                >
                  Cancel
                </button>
              </form>
            ) : lists.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center space-y-3">
                <p className="text-xs text-cs2-muted leading-relaxed">
                  {loading
                    ? "Loading…"
                    : `No practice lists for ${mapName.replace("de_", "")} yet. Tap ☆ on any lineup, or create one here.`}
                </p>
                {!loading && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await state.createList();
                      }, "Couldn't create list")
                    }
                    className="hud-btn-primary"
                  >
                    Create "{defaultListName(mapName)}"
                  </button>
                )}
              </div>
            ) : (
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={startCreate} disabled={busy} className="hud-btn max-sm:py-2.5">
                  + New list
                </button>
                <button
                  onClick={() => {
                    setDraftName(activeList?.name ?? "");
                    setMode("rename");
                  }}
                  disabled={busy || !activeList}
                  className="hud-btn max-sm:py-2.5"
                >
                  Rename
                </button>
                <button
                  onClick={handleDelete}
                  disabled={busy || !activeList}
                  className="hud-btn-danger max-sm:py-2.5"
                >
                  Delete
                </button>
              </div>
            )}
          </section>

          {/* Items */}
          {activeList && (
            <section className="space-y-2.5">
              <p className="text-[10px] text-cs2-muted uppercase tracking-[0.15em]">
                Lineups &middot;{" "}
                <span className="font-mono text-gray-300">{activeList.items.length}</span>
              </p>
              {activeList.items.length === 0 ? (
                <p className="text-xs text-cs2-muted leading-relaxed rounded-xl border border-dashed border-white/10 px-4 py-4">
                  Empty. Tap <span className="text-cs2-accent">☆</span> on a lineup card to add it
                  to "{activeList.name}".
                </p>
              ) : (
                <ol className="space-y-2">
                  {activeList.items.map((item, i) => (
                    <ItemRow
                      key={item.item_id}
                      item={item}
                      index={i}
                      total={activeList.items.length}
                      busy={busy}
                      onUp={() => move(activeList, i, -1)}
                      onDown={() => move(activeList, i, 1)}
                      onRemove={() => remove(activeList, item)}
                      onNote={(note) => saveNote(activeList, item, note)}
                    />
                  ))}
                </ol>
              )}
            </section>
          )}

          {/* Export */}
          {activeList && activeList.items.length > 0 && (
            <section className="space-y-3 rounded-xl border border-white/5 bg-white/[0.02] p-3.5">
              <p className="text-[10px] text-cs2-muted uppercase tracking-[0.15em]">
                Practice in CS2
              </p>
              <div className="flex items-center gap-3 flex-wrap text-[11px] text-cs2-muted">
                <label className="flex items-center gap-1.5">
                  Next key
                  <input
                    value={nextKey}
                    onChange={(e) => setNextKey(e.target.value.trim())}
                    maxLength={16}
                    aria-label="Next lineup key"
                    className="hud-input w-16 text-center font-mono text-[12px] py-1.5 px-2"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  Prev key
                  <input
                    value={prevKey}
                    onChange={(e) => setPrevKey(e.target.value.trim())}
                    maxLength={16}
                    aria-label="Previous lineup key"
                    className="hud-input w-16 text-center font-mono text-[12px] py-1.5 px-2"
                  />
                </label>
              </div>
              {!keysValid && (
                <p className="text-[10px] text-cs2-red">
                  Use two different key names, e.g. ] and [ or f6 and f5.
                </p>
              )}
              <div className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-1.5">
                <button
                  onClick={() => handleDownload(activeList)}
                  disabled={busy || !keysValid}
                  className="hud-btn max-sm:py-2.5 px-2"
                >
                  Download .cfg
                </button>
                <button
                  onClick={() => handleInstall(activeList)}
                  disabled={busy || !keysValid}
                  className="hud-btn-primary max-sm:py-2.5 px-2"
                  title="Write the .cfg into your CS2 game/csgo/cfg folder"
                >
                  Install to CS2
                </button>
                <button
                  onClick={() => handleCopy(activeList)}
                  disabled={busy}
                  className="hud-btn max-sm:py-2.5 px-2"
                >
                  Copy exec
                </button>
              </div>
              {install && (
                <p className="text-[11px] text-cs2-green break-all leading-relaxed">
                  Installed to <span className="font-mono">{install.path}</span>
                </p>
              )}
              {status && <p className="text-[11px] text-cs2-accent break-words">{status}</p>}

              <div className="text-[11px] text-gray-300 leading-relaxed border-l-2 border-cs2-accent/40 pl-2.5 space-y-1">
                <p>
                  Start a local server (<code className="font-mono text-cs2-accent">map {mapName}</code>),
                  then run{" "}
                  <code className="font-mono text-cs2-accent break-all">{activeList.exec_command}</code>{" "}
                  in the console.
                </p>
                <p>
                  Press <Kbd>{nextKey || "]"}</Kbd> / <Kbd>{prevKey || "["}</Kbd> to cycle lineups.
                  Each one teleports you, sets your aim, and gives the grenade.
                </p>
              </div>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-white">
      {children}
    </kbd>
  );
}

interface ItemRowProps {
  item: PracticeItem;
  index: number;
  total: number;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onNote: (note: string) => void;
}

function ItemRow({ item, index, total, busy, onUp, onDown, onRemove, onNote }: ItemRowProps) {
  const [note, setNote] = useState(item.note);
  useEffect(() => setNote(item.note), [item.note]);
  const accent = GRENADE_ACCENT[item.grenade_type] ?? "#94a3b8";
  const tech = item.primary_technique
    ? TECHNIQUE_LABEL[item.primary_technique] ?? item.primary_technique
    : null;
  const label = item.label ?? `Lineup ${item.cluster_id}`;

  const commit = () => {
    const trimmed = note.trim();
    if (trimmed !== item.note) onNote(trimmed);
  };

  const iconBtn =
    "w-9 h-9 shrink-0 rounded-full border border-white/10 bg-white/[0.04] text-gray-300 text-sm hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-30 disabled:cursor-not-allowed transition";

  return (
    <li
      className="rounded-xl border border-white/5 bg-white/[0.03] p-3 flex flex-col gap-2"
      style={{ borderLeftColor: accent, borderLeftWidth: 2 }}
    >
      <div className="flex items-start gap-2.5">
        <span className="font-mono text-[11px] text-cs2-accent w-5 pt-0.5 shrink-0 text-right">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-white leading-tight truncate" title={label}>
            {label}
          </p>
          <p className="text-[10px] text-cs2-muted mt-1 uppercase tracking-[0.12em] truncate">
            <span style={{ color: accent }}>{item.grenade_type.replace("grenade", "")}</span>
            {tech && <> &middot; {tech}</>}
            {item.side && <> &middot; {item.side}</>}
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={onUp}
            disabled={busy || index === 0}
            aria-label={`Move ${label} up`}
            className={iconBtn}
          >
            ↑
          </button>
          <button
            onClick={onDown}
            disabled={busy || index === total - 1}
            aria-label={`Move ${label} down`}
            className={iconBtn}
          >
            ↓
          </button>
          <button
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${label}`}
            className={`${iconBtn} hover:!border-cs2-red/60 hover:!text-cs2-red`}
          >
            ✕
          </button>
        </div>
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        maxLength={200}
        placeholder="Add a note…"
        aria-label={`Note for ${label}`}
        className="hud-input text-[12px] py-1.5 px-3"
      />
    </li>
  );
}
