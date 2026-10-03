"""
Demo importer — turns a demo file the user already has into
`<prefix>_<map>.dem` files in `settings.demo_dir`.

Accepted inputs
---------------
- plain `.dem`
- `.rar` / `.zip` archives (HLTV ships one `.dem` per map, sometimes split
  into `-p1` / `-p2` parts)
- single compressed demos: `.dem.gz`, `.dem.bz2`, `.dem.zst` (FACEIT)

Naming
------
The whole app reads the map from the text after the first `_` of a demo's
filename, so every imported demo is named `<prefix>_<maptoken>.dem`. The map
comes from the demo header (filename as a fallback). The prefix is the HLTV
match id when the import came from the browser extension, otherwise the
source filename stem with `_` turned into `-` (same rule as
`_name_upload_by_map` in main.py).

Safety
------
Source files are never modified or deleted: plain demos are copied, archives
are extracted into a scratch directory under `data/` and only the extracted
copies are moved. The one exception is `consume=True`, used for files the
upload endpoint itself wrote to the inbox.

Every source is fingerprinted (size + SHA-256 of the first 1 MB) and recorded
in `imports_sources`, so the same file is never imported twice even if it
shows up under another path.
"""
from __future__ import annotations

import bz2
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Optional

import rarfile

from backend.config import settings
from backend.db import connect
from backend.ingestion import hltv_scraper as _hltv

logger = logging.getLogger(__name__)

MB = 1024 * 1024
HEAD_HASH_BYTES = MB

# Longest suffix first so `.dem.gz` wins over `.gz`.
_KINDS: tuple[tuple[str, str], ...] = (
    (".dem.gz", "gz"),
    (".dem.bz2", "bz2"),
    (".dem.zst", "zst"),
    (".dem", "dem"),
    (".rar", "rar"),
    (".zip", "zip"),
    (".gz", "gz"),
    (".bz2", "bz2"),
    (".zst", "zst"),
)
UPLOAD_EXTENSIONS = (".dem", ".rar", ".zip", ".gz", ".bz2", ".zst")

# Browsers write these while a download is still running.
PARTIAL_SUFFIXES = (".crdownload", ".part", ".tmp", ".download", ".partial", ".opdownload")

# CS2 (Source 2) and CS:GO demo magic.
DEMO_MAGICS = (b"PBDEMS2\x00", b"HL2DEMO\x00")

# Filename fallback when a header can't be read.
_MAP_TOKENS = (
    "mirage", "dust2", "inferno", "nuke", "ancient", "anubis", "vertigo",
    "overpass", "train", "cache", "cobblestone", "office", "italy",
)

_PART_RE = re.compile(r"(?<![a-z0-9])p\d{1,2}(?![a-z0-9])")

DEFAULT_SETTINGS: dict = {
    # "@cs2-replays" and "@inbox" are resolved at scan time (the CS2 path
    # can change after the setting was saved).
    "watch_folders": ["@cs2-replays", "@inbox"],
    "watch_downloads": False,
    "my_steamid": "",
    "auto_run_pipeline": False,
    "enabled": True,
}

# One import at a time: the watcher, uploads and the extension hand-off can
# all see the same file, and serialising keeps the dedupe checks honest.
_IMPORT_LOCK = threading.Lock()


class ImportFailed(Exception):
    """A user-facing import error (bad file, unreadable archive, …)."""


@dataclass
class ImportResult:
    source: str
    status: str                      # imported | duplicate | skipped | error
    demos: list[str] = field(default_factory=list)   # every demo this source maps to
    new_demos: list[str] = field(default_factory=list)  # demos written by this call
    maps: list[str] = field(default_factory=list)
    error: Optional[str] = None
    fingerprint: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS imports_sources (
        fingerprint  TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        size         BIGINT NOT NULL,
        mtime_ns     BIGINT NOT NULL,
        head_hash    TEXT NOT NULL,
        origin       TEXT NOT NULL,
        status       TEXT NOT NULL,
        demos        TEXT NOT NULL,
        error        TEXT,
        parse_state  TEXT,
        imported_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_imports_sources_path ON imports_sources (path)",
    "CREATE INDEX IF NOT EXISTS idx_imports_sources_at ON imports_sources (imported_at)",
    """
    CREATE TABLE IF NOT EXISTS imports_settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS imports_hltv_pending (
        match_id    INTEGER PRIMARY KEY,
        maps        TEXT NOT NULL,
        created_at  REAL NOT NULL
    )
    """,
)

_tables_ready_for: Optional[str] = None
_tables_lock = threading.Lock()


def ensure_tables() -> None:
    global _tables_ready_for
    key = str(settings.db_path)
    if _tables_ready_for == key:
        return
    with _tables_lock:
        if _tables_ready_for == key:
            return
        with connect() as conn:
            for stmt in _SCHEMA:
                conn.execute(stmt)
        _tables_ready_for = key


def load_settings() -> dict:
    ensure_tables()
    out = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULT_SETTINGS.items()}
    with connect() as conn:
        rows = conn.execute("SELECT key, value FROM imports_settings").fetchall()
    for row in rows:
        if row["key"] in out:
            try:
                out[row["key"]] = json.loads(row["value"])
            except ValueError:
                pass
    return out


def save_settings(updates: dict) -> dict:
    ensure_tables()
    with connect() as conn:
        for key, value in updates.items():
            if key not in DEFAULT_SETTINGS:
                continue
            conn.execute(
                "INSERT INTO imports_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )
    return load_settings()


def _get_source(fp: str):
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM imports_sources WHERE fingerprint = ?", (fp,)
        ).fetchone()


def is_known_path(path: Path, size: int, mtime_ns: int) -> bool:
    """Cheap pre-check for the watcher: same path, size and mtime as a recorded source."""
    ensure_tables()
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM imports_sources WHERE path = ? AND size = ? AND mtime_ns = ?",
            (str(path), size, mtime_ns),
        ).fetchone()
    return row is not None


def _record(
    *, fp: str, path: Path, size: int, mtime_ns: int, head_hash: str, origin: str,
    status: str, demos: list[str], error: Optional[str], parse_state: Optional[str],
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO imports_sources
                (fingerprint, path, size, mtime_ns, head_hash, origin, status,
                 demos, error, parse_state, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (fingerprint) DO UPDATE SET
                path = excluded.path, size = excluded.size,
                mtime_ns = excluded.mtime_ns, origin = excluded.origin,
                status = excluded.status, demos = excluded.demos,
                error = excluded.error, parse_state = excluded.parse_state,
                imported_at = excluded.imported_at
            """,
            (fp, str(path), size, mtime_ns, head_hash, origin, status,
             json.dumps(demos), error, parse_state, time.time()),
        )


def set_parse_state(fp: str, state: str) -> None:
    ensure_tables()
    with connect() as conn:
        conn.execute(
            "UPDATE imports_sources SET parse_state = ? WHERE fingerprint = ?", (state, fp)
        )


def recent_imports(limit: int = 25) -> list[dict]:
    ensure_tables()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM imports_sources ORDER BY imported_at DESC LIMIT ?", (limit,)
        ).fetchall()
    out = []
    for r in rows:
        try:
            demos = json.loads(r["demos"])
        except ValueError:
            demos = []
        out.append({
            "source": r["path"],
            "name": Path(r["path"]).name,
            "origin": r["origin"],
            "status": r["status"],
            "demos": demos,
            "error": r["error"],
            "parse_state": r["parse_state"],
            "size": r["size"],
            "imported_at": r["imported_at"],
        })
    return out


def add_pending_hltv(match_id: int, maps: list[str]) -> None:
    ensure_tables()
    with connect() as conn:
        conn.execute(
            "INSERT INTO imports_hltv_pending (match_id, maps, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT (match_id) DO UPDATE SET maps = excluded.maps, "
            "created_at = excluded.created_at",
            (match_id, json.dumps(maps), time.time()),
        )


def pending_hltv(max_age_s: float) -> list[dict]:
    """Hand-offs younger than `max_age_s`; older rows are dropped."""
    ensure_tables()
    cutoff = time.time() - max_age_s
    with connect() as conn:
        conn.execute("DELETE FROM imports_hltv_pending WHERE created_at < ?", (cutoff,))
        rows = conn.execute(
            "SELECT * FROM imports_hltv_pending ORDER BY created_at DESC"
        ).fetchall()
    out = []
    for r in rows:
        try:
            maps = json.loads(r["maps"])
        except ValueError:
            maps = []
        out.append({"match_id": r["match_id"], "maps": maps, "created_at": r["created_at"]})
    return out


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------

def kind_of(name: str) -> Optional[str]:
    low = name.lower()
    for suffix, kind in _KINDS:
        if low.endswith(suffix):
            return kind
    return None


def stem_of(name: str) -> str:
    low = name.lower()
    for suffix, _ in _KINDS:
        if low.endswith(suffix):
            return name[: -len(suffix)]
    return Path(name).stem


def is_partial_download(name: str) -> bool:
    return name.lower().endswith(PARTIAL_SUFFIXES)


def make_prefix(raw: str) -> str:
    """Filename-safe prefix with no `_` (the map separator)."""
    s = raw.replace("_", "-")
    s = re.sub(r"[^A-Za-z0-9.-]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-.")
    return s[:80].strip("-.") or "demo"


def _head_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read(HEAD_HASH_BYTES))
    return h.hexdigest()[:32]


def fingerprint(path: Path) -> tuple[int, int, str, str]:
    """(size, mtime_ns, head_hash, fingerprint) — fingerprint = size + hash of the first 1 MB."""
    st = path.stat()
    head = _head_hash(path)
    return st.st_size, st.st_mtime_ns, head, f"{st.st_size}:{head}"


def _has_demo_magic(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(8) in DEMO_MAGICS
    except OSError:
        return False


def _map_token(name: str, dem_path: Path) -> Optional[str]:
    """Map token from the demo header, falling back to the filename."""
    header = _hltv._probe_dem_map(dem_path)
    if header:
        token = re.sub(r"[^a-z0-9_]", "", header.strip().lower().removeprefix("de_"))
        if token:
            return token
    low = name.lower()
    for tok in _MAP_TOKENS:
        if re.search(rf"(?<![a-z0-9]){tok}(?![a-z0-9])", low):
            return tok
    return None


def _decompressed_cap() -> int:
    # Generous per-demo ceiling so a decompression bomb can't fill the disk.
    return max(settings.max_demo_size_mb, 1) * MB * 2


def _copy_capped(fin, fout, cap: int) -> None:
    total = 0
    while True:
        chunk = fin.read(MB)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            raise ImportFailed(f"Decompressed demo is larger than {cap // MB} MB")
        fout.write(chunk)


def _decompress(src: Path, kind: str, out: Path) -> None:
    cap = _decompressed_cap()
    try:
        with open(out, "wb") as fout:
            if kind == "gz":
                with gzip.open(src, "rb") as fin:
                    _copy_capped(fin, fout, cap)
            elif kind == "bz2":
                with bz2.open(src, "rb") as fin:
                    _copy_capped(fin, fout, cap)
            elif kind == "zst":
                import zstandard

                with open(src, "rb") as raw:
                    reader = zstandard.ZstdDecompressor().stream_reader(
                        raw, read_across_frames=True
                    )
                    with reader as fin:
                        _copy_capped(fin, fout, cap)
    except ImportFailed:
        raise
    except Exception as exc:
        raise ImportFailed(f"Could not decompress {src.name}: {exc}") from exc


def _extract_zip(src: Path, tmp: Path) -> list[tuple[Path, str]]:
    cap = _decompressed_cap()
    try:
        with zipfile.ZipFile(src) as zf:
            infos = [
                i for i in zf.infolist()
                if not i.is_dir() and i.filename.lower().endswith(".dem")
            ]
            if not infos:
                raise ImportFailed(f"No .dem file inside {src.name}")
            out: list[tuple[Path, str]] = []
            for idx, info in enumerate(infos):
                if info.file_size > cap:
                    raise ImportFailed(f"{info.filename} is larger than {cap // MB} MB")
                name = Path(info.filename.replace("\\", "/")).name
                d = tmp / str(idx)
                d.mkdir(parents=True, exist_ok=True)
                dest = d / name
                with zf.open(info) as fin, open(dest, "wb") as fout:
                    _copy_capped(fin, fout, cap)
                out.append((dest, name))
            return out
    except zipfile.BadZipFile as exc:
        raise ImportFailed(f"{src.name} is not a valid ZIP archive") from exc


def _extract_rar(src: Path, tmp: Path) -> list[tuple[Path, str]]:
    cap = _decompressed_cap()
    if _hltv._RAR_BACKEND:
        try:
            with rarfile.RarFile(src) as rf:
                infos = [
                    i for i in rf.infolist()
                    if not i.is_dir() and i.filename.lower().endswith(".dem")
                ]
                if not infos:
                    raise ImportFailed(f"No .dem file inside {src.name}")
                for idx, info in enumerate(infos):
                    if (info.file_size or 0) > cap:
                        raise ImportFailed(f"{info.filename} is larger than {cap // MB} MB")
                    d = tmp / str(idx)
                    d.mkdir(parents=True, exist_ok=True)
                    rf.extract(info, path=d)
            return [(p, p.name) for p in sorted(tmp.rglob("*.dem"))]
        except ImportFailed:
            raise
        except rarfile.NotRarFile as exc:
            raise ImportFailed(f"{src.name} is not a valid RAR archive") from exc
        except Exception as exc:
            logger.warning("rarfile extraction of %s failed (%s) — trying tar", src.name, exc)
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir(parents=True, exist_ok=True)

    dems = _hltv._extract_rar_via_windows_tar(src, tmp)
    if dems:
        return [(p, p.name) for p in dems]
    raise ImportFailed(
        "Could not extract the RAR archive. Install 7-Zip (Windows) or "
        "unrar / 7z (Linux, macOS) and restart the backend."
    )


def _part_base(name: str) -> str:
    """Stem with `-p1` / `_p2` part markers removed, for grouping split demos."""
    base = _PART_RE.sub("", stem_of(name).lower())
    return re.sub(r"[-_. ]+", "-", base).strip("-")


def _place(src: Path, base: str, token: str, *, move: bool) -> tuple[str, bool]:
    """Copy/move `src` to `<base>_<token>.dem`. Returns (name, written)."""
    demo_dir = settings.demo_dir
    if base.lower().endswith(f"-{token}") and len(base) > len(token) + 1:
        base = base[: -len(token) - 1]
    size = src.stat().st_size
    src_head: Optional[str] = None
    target = demo_dir / f"{base}_{token}.dem"
    n = 2
    while target.exists():
        try:
            # Same size and same first MB → it's already in the library.
            if target.stat().st_size == size:
                if src_head is None:
                    src_head = _head_hash(src)
                if _head_hash(target) == src_head:
                    return target.name, False
        except OSError:
            pass
        target = demo_dir / f"{base}-{n}_{token}.dem"
        n += 1
    staging = target.with_name(target.name + ".importing")
    try:
        if move:
            shutil.move(str(src), str(staging))
        else:
            shutil.copyfile(src, staging)
        os.replace(staging, target)
    finally:
        staging.unlink(missing_ok=True)
    logger.info("imported %s → %s", src.name, target.name)
    return target.name, True


def _new_tmp_dir() -> Path:
    d = settings.import_tmp_dir / uuid.uuid4().hex
    d.mkdir(parents=True, exist_ok=True)
    return d


def cleanup_tmp(max_age_s: float = 3600) -> None:
    """Remove scratch dirs and half-copied demos left by an interrupted import."""
    cutoff = time.time() - max_age_s
    root = settings.import_tmp_dir
    leftovers = list(root.iterdir()) if root.exists() else []
    if settings.demo_dir.exists():
        leftovers += list(settings.demo_dir.glob("*.dem.importing"))
    for p in leftovers:
        try:
            if p.stat().st_mtime < cutoff:
                shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink()
        except OSError:
            pass


def _do_import(
    path: Path, kind: str, prefix: Optional[str], *, consume: bool
) -> tuple[list[str], list[str], list[str]]:
    """Returns (all demo names, newly written names, map tokens)."""
    settings.demo_dir.mkdir(parents=True, exist_ok=True)
    tmp: Optional[Path] = None
    try:
        # 1. Get every candidate .dem on disk: (path, original name, ours?)
        if kind == "dem":
            candidates = [(path, path.name)]
            ours = consume
        else:
            tmp = _new_tmp_dir()
            ours = True
            if kind in ("gz", "bz2", "zst"):
                out = tmp / (make_prefix(stem_of(path.name)) + ".dem")
                _decompress(path, kind, out)
                candidates = [(out, stem_of(path.name) + ".dem")]
            elif kind == "zip":
                candidates = _extract_zip(path, tmp)
            else:
                candidates = _extract_rar(path, tmp)

        # 2. Identify each one's map.
        found: list[tuple[Path, str, str, int]] = []   # (path, name, token, size)
        problems: list[str] = []
        for p, name in candidates:
            if not _has_demo_magic(p):
                problems.append(f"{name} is not a CS2 demo")
                continue
            token = _map_token(name, p)
            if not token:
                problems.append(f"could not read the map from {name}")
                continue
            found.append((p, name, token, p.stat().st_size))
        if not found:
            raise ImportFailed("; ".join(problems) or f"No demo found in {path.name}")
        for msg in problems:
            logger.warning("import %s: %s", path.name, msg)

        # 3. Split demos (-p1/-p2): keep the largest part per map. A known
        #    HLTV match has one demo per map; anything else is grouped by its
        #    part-less filename too, so an archive of unrelated demos keeps
        #    all of them.
        groups: dict[tuple[str, str], list[tuple[Path, str, str, int]]] = {}
        for item in found:
            key = (item[2], "" if prefix else _part_base(item[1]))
            groups.setdefault(key, []).append(item)
        chosen: list[tuple[Path, str, str, int]] = []
        for (token, _), items in groups.items():
            if len(items) > 1:
                logger.warning(
                    "import %s: %d parts for %s — keeping the largest; "
                    "the demo will be partial", path.name, len(items), token,
                )
            chosen.append(max(items, key=lambda it: it[3]))

        # 4. Place them.
        base = make_prefix(prefix) if prefix else make_prefix(stem_of(path.name))
        all_names: list[str] = []
        new_names: list[str] = []
        maps: list[str] = []
        for p, _name, token, _size in chosen:
            name, written = _place(p, base, token, move=ours)
            all_names.append(name)
            if written:
                new_names.append(name)
            if token not in maps:
                maps.append(token)
        return all_names, new_names, maps
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


def import_file(
    path: Path,
    *,
    prefix: Optional[str] = None,
    origin: str = "watch",
    retry: bool = False,
    consume: bool = False,
) -> ImportResult:
    """
    Import one source file. Safe to call repeatedly: a fingerprint that was
    already imported returns `duplicate` with the demo names it produced.

    retry   — explicit user action (upload / extension): re-attempt sources
              that failed before, and re-import when every demo a previous
              import produced has since been deleted.
    consume — the file belongs to the app (upload inbox copy): move instead
              of copy, and delete it afterwards.
    """
    path = Path(path)
    with _IMPORT_LOCK:
        ensure_tables()
        kind = kind_of(path.name)
        if kind is None:
            return ImportResult(str(path), "error", error=f"Unsupported file type: {path.name}")
        try:
            size, mtime_ns, head, fp = fingerprint(path)
        except OSError as exc:
            return ImportResult(str(path), "error", error=f"Cannot read {path.name}: {exc}")

        row = _get_source(fp)
        if row is not None:
            try:
                prev = json.loads(row["demos"])
            except ValueError:
                prev = []
            if row["status"] == "imported":
                present = [d for d in prev if (settings.demo_dir / d).exists()]
                if present or not retry:
                    if consume:
                        path.unlink(missing_ok=True)
                    return ImportResult(
                        str(path), "duplicate", demos=present or prev,
                        maps=sorted({d.partition("_")[2][:-4] for d in prev}),
                        fingerprint=fp,
                    )
            elif not retry:
                return ImportResult(str(path), "skipped", error=row["error"], fingerprint=fp)

        try:
            demos, new, maps = _do_import(path, kind, prefix, consume=consume)
        except ImportFailed as exc:
            err = str(exc)
        except Exception as exc:   # unexpected — keep the watcher alive
            logger.exception("import of %s crashed", path)
            err = f"Import failed: {exc}"
        else:
            err = None

        if consume:
            path.unlink(missing_ok=True)

        if err is not None:
            _record(fp=fp, path=path, size=size, mtime_ns=mtime_ns, head_hash=head,
                    origin=origin, status="error", demos=[], error=err, parse_state=None)
            logger.warning("import %s failed: %s", path.name, err)
            return ImportResult(str(path), "error", error=err, fingerprint=fp)

        _record(fp=fp, path=path, size=size, mtime_ns=mtime_ns, head_hash=head,
                origin=origin, status="imported", demos=demos, error=None,
                parse_state="pending" if new else "done")
        return ImportResult(
            str(path), "imported" if new else "duplicate",
            demos=demos, new_demos=new, maps=maps, fingerprint=fp,
        )


# ---------------------------------------------------------------------------
# Folder scanning
# ---------------------------------------------------------------------------

def scan_candidates(
    folders: Iterable[Path], *, settle_s: float, now: Optional[float] = None
) -> list[Path]:
    """
    Top-level importable files in `folders`, oldest first. Skips files still
    being written (recent mtime, or a sibling `<name>.crdownload` / `.part`).
    """
    now = time.time() if now is None else now
    out: list[tuple[float, Path]] = []
    for folder in folders:
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        names = {e.name.lower() for e in entries}
        for e in entries:
            if kind_of(e.name) is None or is_partial_download(e.name):
                continue
            low = e.name.lower()
            if any(low + s in names for s in PARTIAL_SUFFIXES):
                continue
            try:
                if not e.is_file():
                    continue
                st = e.stat()
            except OSError:
                continue
            if st.st_size == 0 or now - st.st_mtime < settle_s:
                continue
            out.append((st.st_mtime, Path(e.path)))
    out.sort(key=lambda t: t[0])
    return [p for _, p in out]
