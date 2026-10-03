"""
Demo imports — folder watcher, archive uploads, browser-extension hand-off, own matches.

HLTV blocks server-side scraping with a Cloudflare challenge, so HLTV demos
now arrive through the user's own browser: the extension sends the match page
the user is looking at to `/hltv-page`, the browser downloads the demo
normally, and the extension hands the finished file to `/hltv-download`.

Everything else lands through the folder watcher (CS2's replays folder, the
`data/inbox` drop folder, optionally ~/Downloads) or the upload endpoint.
The heavy lifting is in `backend/ingestion/importer.py`.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.api.deps import ADMIN
from backend.config import settings
from backend.ingestion import importer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/import", tags=["import"])

_TOKEN_CS2 = "@cs2-replays"
_TOKEN_INBOX = "@inbox"
_STEAMID_RE = re.compile(r"^7656119\d{10}$")
_HLTV_MATCH_PATH_RE = re.compile(r"^/matches/(\d{1,9})(?:/[^\s]*)?$")
_MAX_FOLDERS = 20

_state: dict = {
    "watcher_running": False,
    "scanning": False,
    "last_scan_at": None,
    "last_scan_found": 0,
    "last_scan_imported": 0,
    "last_error": None,
    "parsing": None,
}
_watch_task: Optional[asyncio.Task] = None
_parse_task: Optional[asyncio.Task] = None
_parse_queue: Optional[asyncio.Queue] = None
_scan_lock = asyncio.Lock()
# path → (size, mtime_ns) the watcher already handled this process lifetime.
_seen: dict[str, tuple[int, int]] = {}


def _in_daemon(fn, *args, **kwargs) -> "asyncio.Future":
    """
    Run blocking work (archive extraction, demo parsing) on a daemon thread.

    Unlike asyncio.to_thread, nothing joins these threads at shutdown, so a
    multi-minute import can never hold up a uvicorn reload: cancelling the
    awaiting task returns at once and the thread is dropped with the process.
    Leftover scratch files are cleaned up on the next start.
    """
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()

    def _settle(setter, value) -> None:
        if not fut.done():
            setter(value)

    def _run() -> None:
        try:
            result = fn(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 — relayed to the awaiting task
            setter, value = fut.set_exception, exc
        else:
            setter, value = fut.set_result, result
        try:
            loop.call_soon_threadsafe(_settle, setter, value)
        except RuntimeError:
            pass  # loop already closed (shutdown)

    threading.Thread(target=_run, name=f"import-{getattr(fn, '__name__', 'job')}", daemon=True).start()
    return fut


# ---------------------------------------------------------------------------
# Folder resolution
# ---------------------------------------------------------------------------

def _downloads_dir() -> Path:
    return Path.home() / "Downloads"


def _cs2_replays_dir() -> Optional[Path]:
    from backend.main import _resolve_cs2_dir  # lazy: main imports this module

    cs2 = _resolve_cs2_dir()
    return Path(cs2) / "replays" if cs2 else None


def _resolve_folders(cfg: dict) -> list[dict]:
    """Watched folders with labels and existence checks (blocking: may read the registry)."""
    out: list[dict] = []
    for raw in cfg.get("watch_folders") or []:
        if raw == _TOKEN_CS2:
            p = _cs2_replays_dir()
            out.append({"id": raw, "kind": "cs2", "label": "CS2 replays",
                        "path": str(p) if p else None,
                        "exists": bool(p and p.is_dir())})
        elif raw == _TOKEN_INBOX:
            p = settings.import_inbox_dir.resolve()
            out.append({"id": raw, "kind": "inbox", "label": "Inbox",
                        "path": str(p), "exists": p.is_dir()})
        else:
            p = Path(raw)
            out.append({"id": raw, "kind": "custom", "label": p.name or raw,
                        "path": str(p), "exists": p.is_dir()})
    if cfg.get("watch_downloads"):
        p = _downloads_dir()
        out.append({"id": "@downloads", "kind": "downloads", "label": "Downloads",
                    "path": str(p), "exists": p.is_dir()})
    return out


def _watched_paths(cfg: dict) -> list[Path]:
    return [Path(f["path"]) for f in _resolve_folders(cfg) if f["path"] and f["exists"]]


# ---------------------------------------------------------------------------
# Parse queue (timeline + player stats, then optional lineup pipeline)
# ---------------------------------------------------------------------------

def _enqueue_parse(result: importer.ImportResult) -> None:
    if not result.new_demos:
        return
    if _parse_queue is None:
        logger.warning("import: parse worker not running — %s not parsed", result.new_demos)
        return
    _parse_queue.put_nowait((result.fingerprint, list(result.new_demos), list(result.maps)))


def _parse_one(name: str) -> bool:
    from backend.main import _TIMELINE_CACHE_DIR, _ensure_timeline_for_demo

    path = settings.demo_dir / name
    if not path.exists():
        return False
    _ensure_timeline_for_demo(path)
    return (_TIMELINE_CACHE_DIR / f"{name}.json").exists()


async def _maybe_run_pipeline(maps: list[str]) -> None:
    """Queue a lineup-pipeline job per imported map (runs on the worker,
    one ingest job at a time — see backend/jobs.py)."""
    from backend import jobs

    for token in maps:
        try:
            job_id = await asyncio.to_thread(
                jobs.enqueue, "pipeline",
                {"map_name": f"de_{token}", "grenade_types": None, "clear_existing": True},
                exclusive=False,
            )
            logger.info("import: queued lineup pipeline for %s (job %d)", token, job_id)
        except Exception as exc:
            logger.warning("import: could not queue pipeline for %s: %s", token, exc)


async def _parse_worker() -> None:
    assert _parse_queue is not None
    while True:
        fp, names, maps = await _parse_queue.get()
        try:
            ok = True
            for name in names:
                _state["parsing"] = name
                ok = await _in_daemon(_parse_one, name) and ok
            if fp:
                await asyncio.to_thread(importer.set_parse_state, fp, "done" if ok else "failed")
            cfg = await asyncio.to_thread(importer.load_settings)
            if cfg.get("auto_run_pipeline") and maps:
                await _maybe_run_pipeline(maps)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("import: parse step failed for %s", names)
        finally:
            _state["parsing"] = None
            _parse_queue.task_done()


# ---------------------------------------------------------------------------
# Watcher
# ---------------------------------------------------------------------------

def _scan_sync() -> list[importer.ImportResult]:
    cfg = importer.load_settings()
    folders = _watched_paths(cfg)
    candidates = importer.scan_candidates(folders, settle_s=settings.import_settle_s)
    handoffs = importer.pending_hltv(settings.import_hltv_handoff_minutes * 60)
    _state["last_scan_found"] = len(candidates)
    results: list[importer.ImportResult] = []
    for p in candidates:
        try:
            st = p.stat()
        except OSError:
            continue
        key = str(p)
        sig = (st.st_size, st.st_mtime_ns)
        if _seen.get(key) == sig:
            continue
        if importer.is_known_path(p, *sig):
            _seen[key] = sig
            continue
        # An archive that appeared after the user clicked "Send" on an HLTV
        # page is the extension's to import (it knows the match id). Leave
        # it alone until the hand-off window closes.
        if importer.kind_of(p.name) in ("rar", "zip") and any(
            st.st_mtime >= h["created_at"] - 5 for h in handoffs
        ):
            continue
        result = importer.import_file(p, origin="watch")
        _seen[key] = sig
        results.append(result)
    return results


async def _scan(trigger: str) -> list[importer.ImportResult]:
    async with _scan_lock:
        _state["scanning"] = True
        try:
            results = await _in_daemon(_scan_sync)
            _state["last_error"] = None
        except Exception as exc:
            logger.exception("import: %s scan failed", trigger)
            _state["last_error"] = str(exc)
            results = []
        finally:
            _state["scanning"] = False
            _state["last_scan_at"] = time.time()
    for r in results:
        _enqueue_parse(r)
    _state["last_scan_imported"] = sum(1 for r in results if r.status == "imported")
    if results:
        logger.info(
            "import: %s scan handled %d file(s): %s", trigger, len(results),
            ", ".join(f"{Path(r.source).name}={r.status}" for r in results),
        )
    return results


async def _watch_loop() -> None:
    _state["watcher_running"] = True
    try:
        await asyncio.sleep(3)
        while True:
            try:
                cfg = await asyncio.to_thread(importer.load_settings)
                if cfg.get("enabled", True):
                    await _scan("watch")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("import: watcher iteration failed")
                _state["last_error"] = str(exc)
            await asyncio.sleep(settings.import_scan_interval_s)
    finally:
        _state["watcher_running"] = False


def _startup_prep() -> None:
    importer.ensure_tables()
    settings.import_inbox_dir.mkdir(parents=True, exist_ok=True)
    importer.cleanup_tmp()


async def on_startup() -> None:
    global _watch_task, _parse_task, _parse_queue
    try:
        await asyncio.to_thread(_startup_prep)
    except Exception:
        logger.exception("import: startup prep failed")
    _parse_queue = asyncio.Queue()
    _parse_task = asyncio.create_task(_parse_worker())
    # The test suite must never read the developer's real CS2 replay folder.
    # With several API replicas (PROCESS_ROLE=api) only the worker watches,
    # so a folder is never scanned by two processes at once.
    if (
        settings.import_watch_autostart
        and settings.process_role != "api"
        and not os.environ.get("PYTEST_CURRENT_TEST")
    ):
        _watch_task = asyncio.create_task(_watch_loop())


async def on_shutdown() -> None:
    """Cancel the watcher and parse worker and return within ~1 s.

    Blocking work runs on daemon threads (see `_in_daemon`), so cancelling
    the awaiting tasks is immediate; an import still in flight is simply
    abandoned with the process and its scratch files are swept next start.
    """
    global _watch_task, _parse_task
    tasks = [t for t in (_watch_task, _parse_task) if t is not None and not t.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=1.0)
    _watch_task = _parse_task = None
    _state["watcher_running"] = False
    _state["scanning"] = False


# ---------------------------------------------------------------------------
# Settings + status
# ---------------------------------------------------------------------------

class ImportSettingsUpdate(BaseModel):
    watch_folders: Optional[list[str]] = Field(default=None, max_length=_MAX_FOLDERS)
    watch_downloads: Optional[bool] = None
    my_steamid: Optional[str] = Field(default=None, max_length=32)
    auto_run_pipeline: Optional[bool] = None
    enabled: Optional[bool] = None


def _settings_payload(cfg: dict) -> dict:
    return {
        **cfg,
        "folders": _resolve_folders(cfg),
        "downloads_path": str(_downloads_dir()),
        "default_folders": [_TOKEN_CS2, _TOKEN_INBOX],
    }


def _validate_folders(requested: list[str], current: list[str]) -> list[str]:
    demo_dir = settings.demo_dir.resolve()
    out: list[str] = []
    for raw in requested:
        entry = (raw or "").strip()
        if not entry:
            continue
        if entry in (_TOKEN_CS2, _TOKEN_INBOX):
            if entry not in out:
                out.append(entry)
            continue
        p = Path(entry).expanduser()
        if not p.is_absolute():
            raise HTTPException(400, f"Use an absolute folder path: {entry}")
        resolved = p.resolve()
        if resolved.is_relative_to(demo_dir):
            raise HTTPException(400, "The demo library folder itself can't be watched")
        if entry in current:
            stored = entry          # keep existing entries even if the drive is offline
        elif resolved.is_dir():
            stored = str(resolved)
        else:
            raise HTTPException(400, f"Folder not found on the server: {entry}")
        if stored not in out:
            out.append(stored)
    return out


@router.get("/settings", summary="Auto-import settings and watched folders")
async def get_import_settings():
    cfg = await asyncio.to_thread(importer.load_settings)
    return await asyncio.to_thread(_settings_payload, cfg)


@router.put("/settings", dependencies=ADMIN, summary="Update auto-import settings")
async def put_import_settings(body: ImportSettingsUpdate):
    current = await asyncio.to_thread(importer.load_settings)
    updates: dict = {}
    if body.watch_folders is not None:
        updates["watch_folders"] = await asyncio.to_thread(
            _validate_folders, body.watch_folders, current["watch_folders"]
        )
    if body.my_steamid is not None:
        sid = body.my_steamid.strip()
        if sid and not _STEAMID_RE.match(sid):
            raise HTTPException(400, "SteamID must be a 17-digit SteamID64 (starts with 7656119)")
        updates["my_steamid"] = sid
    for key in ("watch_downloads", "auto_run_pipeline", "enabled"):
        val = getattr(body, key)
        if val is not None:
            updates[key] = bool(val)
    cfg = await asyncio.to_thread(importer.save_settings, updates)
    return await asyncio.to_thread(_settings_payload, cfg)


@router.get("/status", summary="Watcher state, folder checks and recent imports")
async def get_import_status():
    cfg = await asyncio.to_thread(importer.load_settings)
    folders = await asyncio.to_thread(_resolve_folders, cfg)
    recent = await asyncio.to_thread(importer.recent_imports, 25)
    pending = await asyncio.to_thread(
        importer.pending_hltv, settings.import_hltv_handoff_minutes * 60
    )
    from backend.ingestion import hltv_scraper

    return {
        "watcher_running": _state["watcher_running"],
        "enabled": bool(cfg.get("enabled", True)),
        "scanning": _state["scanning"],
        "interval_s": settings.import_scan_interval_s,
        "last_scan_at": _state["last_scan_at"],
        "last_scan_found": _state["last_scan_found"],
        "last_scan_imported": _state["last_scan_imported"],
        "last_error": _state["last_error"],
        "parsing": _state["parsing"],
        "parse_queue": _parse_queue.qsize() if _parse_queue is not None else 0,
        "folders": folders,
        "recent": recent,
        "pending_hltv": pending,
        "rar_support": bool(hltv_scraper._RAR_BACKEND)
        or Path(r"C:\Windows\System32\tar.exe").exists(),
    }


@router.post("/scan", dependencies=ADMIN, summary="Scan watched folders now")
async def scan_now():
    results = await _scan("manual")
    return {
        "handled": len(results),
        "imported": sum(1 for r in results if r.status == "imported"),
        "results": [r.to_dict() for r in results],
    }


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def _sanitize_upload_name(raw: str) -> str:
    name = raw.strip().replace("\\", "/").rsplit("/", 1)[-1]
    if not name or ".." in name:
        raise HTTPException(400, "Invalid filename")
    if importer.kind_of(name) is None:
        raise HTTPException(
            400, "Upload a .dem, .rar, .zip, .dem.gz, .dem.bz2 or .dem.zst file",
        )
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")
    return name[-150:]


@router.post("/upload", dependencies=ADMIN, summary="Upload a demo, archive or compressed demo")
async def upload_import(file: UploadFile):
    if not file.filename:
        raise HTTPException(400, "No filename provided")
    name = _sanitize_upload_name(file.filename)

    inbox = settings.import_inbox_dir.resolve()
    inbox.mkdir(parents=True, exist_ok=True)
    dest = inbox / name
    n = 2
    while dest.exists() or dest.with_name(dest.name + ".part").exists():
        dest = inbox / f"{n}-{name}"
        n += 1
    # `.part` while streaming so the watcher (which also watches the inbox)
    # never picks up a half-written file.
    part = dest.with_name(dest.name + ".part")

    max_bytes = settings.max_demo_size_mb * 1024 * 1024
    written = 0
    try:
        with open(part, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {settings.max_demo_size_mb} MB limit",
                    )
                f.write(chunk)
        os.replace(part, dest)
    except HTTPException:
        part.unlink(missing_ok=True)
        raise
    except Exception as exc:
        part.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")

    result = await _in_daemon(
        importer.import_file, dest, origin="upload", retry=True, consume=True,
    )
    if result.status == "error":
        raise HTTPException(status_code=422, detail=result.error or "Import failed")
    _enqueue_parse(result)
    return {
        "source": file.filename,
        "status": result.status,
        "demos": result.demos,
        "new_demos": result.new_demos,
        "maps": result.maps,
    }


# ---------------------------------------------------------------------------
# Browser extension hand-off (HLTV)
# ---------------------------------------------------------------------------

class HltvPageBody(BaseModel):
    url: str = Field(max_length=2048)
    html: str = Field(max_length=20_000_000)


class HltvDownloadBody(BaseModel):
    match_id: int = Field(gt=0, lt=1_000_000_000)
    file_path: str = Field(min_length=1, max_length=4096)


def _hltv_match_id(url: str) -> int:
    try:
        u = urlparse(url)
    except ValueError:
        u = None
    m = _HLTV_MATCH_PATH_RE.match(u.path) if u else None
    if not u or u.scheme != "https" or u.netloc != "www.hltv.org" or not m:
        raise HTTPException(400, "url must be an https://www.hltv.org/matches/<id>/… page")
    return int(m.group(1))


def _is_hltv_url(url: str) -> bool:
    try:
        u = urlparse(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme == "https" and (host == "hltv.org" or host.endswith(".hltv.org"))


def _parse_hltv_page(match_id: int, html: str) -> dict:
    """Read the match page HTML the user is viewing with the scraper's own parsers."""
    from bs4 import BeautifulSoup

    from backend.ingestion.hltv_scraper import HLTVScraper, _normalize_map
    from backend.models.schemas import HLTVMatch

    soup = BeautifulSoup(html, "lxml")

    class _PageScraper(HLTVScraper):
        """HLTVScraper whose only "page fetch" returns the HTML we were given."""

        def __init__(self) -> None:  # no network session
            pass

        def _get(self, url: str):
            return soup

    def _text(*selectors: str) -> str:
        for sel in selectors:
            el = soup.select_one(sel)
            if el and el.get_text(strip=True):
                return el.get_text(strip=True)
        return ""

    team1 = _text(".team1-gradient .teamName", ".team1-gradient a .teamName")
    team2 = _text(".team2-gradient .teamName", ".team2-gradient a .teamName")
    if not (team1 and team2):
        names = [el.get_text(strip=True) for el in soup.select(".teamName")]
        names = [n for n in names if n]
        team1 = team1 or (names[0] if names else "Team1")
        team2 = team2 or (names[1] if len(names) > 1 else "Team2")
    event = _text(".timeAndEvent .event a", ".timeAndEvent .event", ".event a") or "Unknown Event"
    date = ""
    date_el = soup.select_one(".timeAndEvent .date[data-unix], .date[data-unix]")
    if date_el is not None:
        try:
            date = datetime.fromtimestamp(
                int(date_el.get("data-unix")) / 1000, tz=timezone.utc
            ).strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            date = ""

    base = HLTVMatch(match_id=match_id, team1=team1, team2=team2, event=event, date=date or None)
    enriched = _PageScraper().enrich(base)
    if enriched is None:
        raise HTTPException(422, "Could not read the HLTV match page")
    match = enriched.match

    settings.demo_dir.mkdir(parents=True, exist_ok=True)
    HLTVScraper._write_roster_sidecar(match, settings.demo_dir)

    urls: list[str] = []
    for u in [match.demo_url, *match.demo_urls.values()]:
        if u and _is_hltv_url(u) and u not in urls:
            urls.append(u)

    maps: list[str] = []
    for m in enriched.maps_played:
        tok = _normalize_map(m)
        if tok and tok not in maps:
            maps.append(tok)

    importer.add_pending_hltv(match_id, maps)
    return {
        "match_id": match_id,
        "teams": [
            {"name": match.team1, "players": match.team1_players, "logo": match.team1_logo},
            {"name": match.team2, "players": match.team2_players, "logo": match.team2_logo},
        ],
        "event": match.event,
        "date": match.date,
        "maps": maps,
        "demo_urls": urls,
    }


@router.post("/hltv-page", dependencies=ADMIN, summary="Read an HLTV match page sent by the browser extension")
async def hltv_page(body: HltvPageBody):
    match_id = _hltv_match_id(body.url)
    return await _in_daemon(_parse_hltv_page, match_id, body.html)


_REMOTE_HINT = (
    "If the backend runs on a different machine than your browser, it can't "
    "see your downloads: upload the archive on the Demo picker (/replay) instead."
)


def _allowed_download_roots() -> list[Path]:
    cfg = importer.load_settings()
    roots = [_downloads_dir(), *_watched_paths(cfg)]
    out: list[Path] = []
    for r in roots:
        try:
            out.append(r.resolve())
        except OSError:
            continue
    return out


def _check_download_path(raw: str) -> Path:
    p = Path(raw)
    if importer.kind_of(p.name) is None or importer.is_partial_download(p.name):
        raise HTTPException(400, "Only .dem, .rar, .zip, .dem.gz, .dem.bz2 or .dem.zst files can be imported")
    if not p.is_absolute():
        raise HTTPException(404, f"{p.name} isn't on this machine. {_REMOTE_HINT}")
    try:
        resolved = p.resolve()
    except OSError:
        raise HTTPException(404, f"{p.name} isn't on this machine. {_REMOTE_HINT}")
    if not any(resolved.is_relative_to(root) for root in _allowed_download_roots()):
        raise HTTPException(
            403,
            "Only files in your Downloads folder or a watched folder can be imported. "
            "Add the browser's download folder under Auto-import. " + _REMOTE_HINT,
        )
    if not resolved.is_file():
        raise HTTPException(404, f"{p.name} was not found on the backend machine. {_REMOTE_HINT}")
    return resolved


@router.post("/hltv-download", dependencies=ADMIN, summary="Import a demo archive the browser just downloaded")
async def hltv_download(body: HltvDownloadBody):
    path = await asyncio.to_thread(_check_download_path, body.file_path)
    result = await _in_daemon(
        importer.import_file, path, prefix=str(body.match_id), origin="hltv", retry=True,
    )
    if result.status == "error":
        raise HTTPException(422, result.error or "Import failed")
    _enqueue_parse(result)
    return {
        "match_id": body.match_id,
        "status": result.status,
        "demos": result.demos,
        "new_demos": result.new_demos,
        "maps": result.maps,
    }
