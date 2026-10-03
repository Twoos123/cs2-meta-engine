"""
Player photo proxy, cache freshness, and warming.

Photos now come from Liquipedia (the player page's main image, fetched via
the MediaWiki API — see backend/ingestion/liquipedia.py). A photo is only
used when its license allows reuse (CC BY / CC BY-SA / CC0 / public
domain); anything else — notably `permission` images that tournament
organisers licensed to Liquipedia alone — is skipped and the avatar falls
back to initials. The attribution is saved next to the cached image as
`{key}.json` and served by the `/attribution` endpoints.

HLTV stays available as a secondary source behind `PHOTO_HLTV_FALLBACK`
(default off — HLTV answers server-side requests with a Cloudflare 403).

Freshness rules (covered by tests/test_photos.py):
- 14-day stale-while-revalidate: old photos keep serving while a refresh
  runs in the background; a failed refresh backs off for a day.
- A failed or blocked fetch never replaces a good photo.
- Transient errors never write a `.404` marker.
- Reset marks photos stale instead of deleting them.

Cache keys: `{hltv_id}` for players with an HLTV id, `n_{slug}_{hash}`
for name-only lookups (FACEIT / own matches).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import Future
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.api.deps import ADMIN as _ADMIN
from backend.config import settings
from backend.ingestion import liquipedia as lp

logger = logging.getLogger(__name__)
router = APIRouter()

_PHOTO_CACHE_DIR = Path("backend/data/player_photos")

# A cached photo older than this is re-fetched in the background while the
# old one keeps being served. Failed refreshes back off for a day.
_PHOTO_MAX_AGE_SECS = 14 * 86400
_PHOTO_RETRY_SECS = 86400
# How long a cold-cache request waits for the (throttled) lookup before
# answering 503; the fetch keeps going and the next request gets the photo.
_LAZY_WAIT_SECS = 12.0

# ("image", bytes, attribution) | ("missing", reason) | ("error", reason)
SourceResult = Tuple
Source = Callable[[bool], SourceResult]


def _sniff_image_mime(head: bytes) -> str:
    """Detect the real image format from the first few bytes — cache files
    are all named `.png` but hold JPEG (Liquipedia) or WebP (HLTV)."""
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"GIF8"):
        return "image/gif"
    return "image/webp"


# Progress state for the photo-warming background task.
_photo_warm_state: dict = {
    "running": False,
    "done": 0,
    "total": 0,
    "ok": 0,
    "missing": 0,
    "errors": 0,
    "started_at": 0.0,
}


def _read_photo_generation() -> int:
    """Increments every time the photo cache is reset. The frontend uses it
    as a `?v={gen}` cache-bust token so the browser cache follows."""
    f = _PHOTO_CACHE_DIR / ".generation"
    if not f.exists():
        return 0
    try:
        return int(f.read_text().strip() or "0")
    except Exception:
        return 0


def _bump_photo_generation() -> int:
    _PHOTO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    f = _PHOTO_CACHE_DIR / ".generation"
    cur = _read_photo_generation() + 1
    try:
        f.write_text(str(cur))
    except Exception as exc:
        logger.warning("photo-cache: could not write generation — %s", exc)
    return cur


# ─── Keys + names ───────────────────────────────────────────────────────


def clean_player_name(name: Optional[str]) -> Optional[str]:
    """A usable player name, or None. Names go into Liquipedia titles, so
    path separators, control and wiki-markup characters are refused."""
    n = (name or "").strip()
    if not n or len(n) > 64:
        return None
    if re.search(r"[\x00-\x1f\x7f/\\#<>\[\]{}|]", n):
        return None
    return n


def name_key(name: str) -> str:
    """Filesystem-safe cache key for a player name (case-insensitive)."""
    low = name.strip().lower()
    slug = re.sub(r"[^a-z0-9_-]+", "_", low).strip("_")[:40] or "player"
    return f"n_{slug}_{hashlib.sha1(low.encode('utf-8')).hexdigest()[:8]}"


def _photo_key(hltv_id: Optional[int], name: Optional[str] = None) -> str:
    if hltv_id is not None:
        return str(int(hltv_id))
    if not name:
        raise ValueError("need an HLTV id or a name")
    return name_key(name)


_names_cache: dict = {"sig": None, "map": {}}


def _hltv_names() -> Dict[int, str]:
    """HLTV id → player name from the roster sidecars (newest roster wins)."""
    demo_dir = settings.demo_dir
    if not demo_dir.exists():
        return {}
    paths = list(demo_dir.glob("*.roster.json"))
    sig = (len(paths), max((p.stat().st_mtime for p in paths), default=0))
    if _names_cache["sig"] == sig:
        return _names_cache["map"]
    out: Dict[int, str] = {}
    for path in sorted(paths, key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for team_key in ("team1", "team2"):
            for entry in (data.get(team_key) or {}).get("players_detailed") or []:
                pid, nm = entry.get("hltv_id"), clean_player_name(entry.get("name"))
                if isinstance(pid, int) and nm:
                    out.setdefault(pid, nm)
    _names_cache.update(sig=sig, map=out)
    return out


def _hltv_scraper():
    """The HLTV session, only when the (blocked) HLTV fallback is enabled."""
    if not settings.photo_hltv_fallback:
        return None
    from backend.ingestion.hltv_scraper import HLTVScraper
    return HLTVScraper()


# ─── Sources ────────────────────────────────────────────────────────────


def _liquipedia_source(name: str) -> SourceResult:
    try:
        res = lp.lookup_player_photos([name]).get(name)
    except lp.LiquipediaError as exc:
        return ("error", f"liquipedia: {exc}")
    if res is None:
        return ("error", "liquipedia: no lookup result")
    if res.status != "ok":
        logger.info("photo %s: Liquipedia %s — %s", name, res.status, res.reason)
        return ("missing", f"liquipedia: {res.reason}")
    try:
        status, ctype, body = lp.fetch_file(res.image_url)
    except (lp.LiquipediaError, ValueError) as exc:
        return ("error", f"liquipedia image: {exc}")
    if status == 404:
        return ("missing", "liquipedia: image file 404")
    if status != 200 or not ctype.lower().startswith("image/") or not body:
        return ("error", f"liquipedia image: HTTP {status} {ctype}")
    return ("image", body, res.attribution())


def _hltv_source(hltv_id: int, scraper, have_cached: bool) -> SourceResult:
    """HLTV bodyshot (secondary source). Prefers the live profile-page image;
    the years-old static endpoint is only acceptable as a first photo."""
    scraped_url = _scrape_player_image_url(hltv_id, scraper)
    urls: List[str] = []
    if scraped_url:
        urls.append(scraped_url)
    if not have_cached:
        urls.append(
            f"https://static.hltv.org/images/playerprofile/bodyshot/{hltv_id}.png"
        )
    elif not scraped_url:
        # Couldn't read the live profile (blocked / changed) — keep the
        # cached photo and retry after the back-off.
        return ("error", "hltv: profile page unavailable")

    # Only a clean 404 from every URL proves "no photo". A Cloudflare
    # challenge (403), rate limit or network error is transient.
    transient = False
    for url in urls:
        try:
            resp = scraper._session.get(url, timeout=15)
        except Exception as exc:
            logger.debug("photo %d: %s fetch error — %s", hltv_id, url, exc)
            transient = True
            continue
        if resp.status_code == 404:
            continue
        if resp.status_code != 200:
            transient = True
            continue
        ct = resp.headers.get("content-type", "").lower()
        if not ct.startswith("image/"):
            transient = True
            continue
        return ("image", resp.content, {
            "source": "hltv", "image_url": url, "license": None,
            "credit": "Photo: HLTV.org",
        })
    if transient:
        return ("error", "hltv: blocked or unavailable")
    return ("missing", "hltv: no bodyshot")


# ─── Fetch + cache ──────────────────────────────────────────────────────


def _fetch_photo(key: str, sources: List[Source], force: bool = False) -> str:
    """Run `sources` in order and cache the first image. Returns
        "ok"      — a photo is cached (new, or the old one kept)
        "missing" — every source says there is no usable photo; .404 written
        "error"   — transient failure; nothing poisoned, retry later
    `force=True` re-fetches even when a photo is cached (staleness refresh);
    the cached file is only replaced by a successful download."""
    _PHOTO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _PHOTO_CACHE_DIR / f"{key}.png"
    missing_marker = _PHOTO_CACHE_DIR / f"{key}.404"
    checked_marker = _PHOTO_CACHE_DIR / f"{key}.checked"
    attribution = _PHOTO_CACHE_DIR / f"{key}.json"
    have_cached = cache_path.exists() and cache_path.stat().st_size > 0

    if not force:
        if have_cached:
            return "ok"
        if missing_marker.exists() and not _is_older_than(missing_marker, _PHOTO_MAX_AGE_SECS):
            return "missing"

    transient = False
    reasons: List[str] = []
    for source in sources:
        try:
            res = source(have_cached)
        except Exception as exc:
            res = ("error", str(exc))
        if res[0] == "image":
            tmp = cache_path.with_suffix(".part")
            tmp.write_bytes(res[1])
            tmp.replace(cache_path)  # atomic swap — readers never see half a file
            attr = {**(res[2] or {}), "fetched_at": int(time.time())}
            attribution.write_text(json.dumps(attr), encoding="utf-8")
            missing_marker.unlink(missing_ok=True)
            checked_marker.unlink(missing_ok=True)
            return "ok"
        if res[0] == "error":
            transient = True
        reasons.append(res[1])

    # Remember the attempt so stale photos aren't retried on every view.
    checked_marker.touch()
    if transient:
        return "error"
    if have_cached:
        return "ok"  # every source says "none" now — keep serving the old photo
    missing_marker.write_text(
        json.dumps({"reasons": reasons or ["no lookup source (name unknown)"]}),
        encoding="utf-8",
    )
    return "missing"


def _fetch_player_photo(
    hltv_id: Optional[int], scraper=None, force: bool = False,
    *, name: Optional[str] = None,
) -> str:
    """Fetch (or confirm missing) the photo for an HLTV id and/or a name:
    Liquipedia first (needs a name — looked up from the roster sidecars for
    an id), then HLTV when a scraper is passed (fallback setting on)."""
    key = _photo_key(hltv_id, name)
    if name is None and hltv_id is not None:
        name = _hltv_names().get(int(hltv_id))
    sources: List[Source] = []
    if name:
        sources.append(lambda _hc, n=name: _liquipedia_source(n))
    if hltv_id is not None and scraper is not None:
        sources.append(lambda hc, i=int(hltv_id): _hltv_source(i, scraper, hc))
    return _fetch_photo(key, sources, force=force)


def _is_older_than(path: Path, secs: float) -> bool:
    try:
        return time.time() - path.stat().st_mtime > secs
    except OSError:
        return True


def _photo_needs_refresh(key) -> bool:
    cache_path = _PHOTO_CACHE_DIR / f"{key}.png"
    checked = _PHOTO_CACHE_DIR / f"{key}.checked"
    if checked.exists() and not _is_older_than(checked, _PHOTO_RETRY_SECS):
        return False
    return _is_older_than(cache_path, _PHOTO_MAX_AGE_SECS)


_photo_refreshing: set = set()


def _schedule_photo_refresh(hltv_id: Optional[int], name: Optional[str] = None) -> None:
    """Stale-while-revalidate: refresh one photo off the request path."""
    key = _photo_key(hltv_id, name)
    if key in _photo_refreshing:
        return
    _photo_refreshing.add(key)

    def _run() -> None:
        try:
            result = _fetch_player_photo(hltv_id, _hltv_scraper(), force=True, name=name)
            logger.info("photo %s: background refresh → %s", key, result)
        except Exception as exc:
            logger.warning("photo %s: background refresh failed — %s", key, exc)
        finally:
            _photo_refreshing.discard(key)

    asyncio.get_running_loop().run_in_executor(None, _run)


# Cold-cache requests are funnelled through one worker so a page full of
# avatars becomes a few batched Liquipedia queries instead of a request
# stampede against the 1-request-per-2-seconds limit.
_lazy_lock = threading.Lock()
_lazy_pending: Dict[str, Tuple[Optional[int], Optional[str], Future]] = {}
_lazy_state = {"running": False}


def _lazy_submit(hltv_id: Optional[int], name: Optional[str]) -> Future:
    key = _photo_key(hltv_id, name)
    with _lazy_lock:
        if key in _lazy_pending:
            return _lazy_pending[key][2]
        fut: Future = Future()
        _lazy_pending[key] = (hltv_id, name, fut)
        if not _lazy_state["running"]:
            _lazy_state["running"] = True
            threading.Thread(target=_lazy_worker, daemon=True).start()
    return fut


def _lazy_worker() -> None:
    while True:
        time.sleep(0.3)  # let a page's worth of requests pile up
        with _lazy_lock:
            if not _lazy_pending:
                _lazy_state["running"] = False
                return
            batch = list(_lazy_pending.items())[: lp.BATCH]
        names = _hltv_names()
        lookup = [n or names.get(h) for _k, (h, n, _f) in batch]
        try:
            lp.lookup_player_photos([n for n in lookup if n])  # one batched query
        except Exception as exc:
            logger.debug("photo batch lookup failed: %s", exc)
        scraper = _hltv_scraper()
        for key, (h, n, fut) in batch:
            try:
                res = _fetch_player_photo(h, scraper, name=n)
            except Exception as exc:
                logger.warning("photo %s: %s", key, exc)
                res = "error"
            with _lazy_lock:
                _lazy_pending.pop(key, None)
            if not fut.done():
                fut.set_result(res)


def _scrape_player_image_url(hltv_id: int, scraper) -> Optional[str]:
    """HLTV fallback only: the current bodyshot URL from the player page.
    `.playerBodyshot .bodyshot-img`, then `img.bodyshot-img`, then the first
    `img-cdn.hltv.org/playerbodyshot/` image outside "other player" widgets."""
    from urllib.parse import urljoin
    try:
        soup = scraper._get(f"https://www.hltv.org/player/{hltv_id}/-")
    except Exception as exc:
        logger.debug("player-photo %d: page fetch failed — %s", hltv_id, exc)
        return None

    def _abs(src: str) -> str:
        return urljoin("https://www.hltv.org/", src)

    el = soup.select_one(".playerBodyshot .bodyshot-img") or soup.select_one("img.bodyshot-img")
    if el and el.get("src"):
        return _abs(el["src"])

    skip = {
        "playerOfTheWeekBodyshot", "playerOfTheWeekBodyshotContainer",
        "fpl-avatar", "fpl-player", "transfer-player-image",
        "transfer-player-image-container",
    }

    def _ancestor_classes(node) -> set:
        out: set = set()
        cur = node
        for _ in range(6):
            if cur is None:
                break
            out.update(cur.get("class") or [])
            cur = cur.parent
        return out

    for img in soup.select("img[src]"):
        src = img.get("src") or ""
        if "img-cdn.hltv.org/playerbodyshot/" not in src.lower():
            continue
        if _ancestor_classes(img) & skip:
            continue
        return _abs(src)
    return None


# ─── Endpoints ──────────────────────────────────────────────────────────


def _file_response(cache_path: Path, stale: bool) -> FileResponse:
    return FileResponse(
        cache_path,
        media_type=_sniff_image_mime(cache_path.read_bytes()[:16]),
        # A stale photo is being replaced right now — don't let the browser
        # pin it; fresh ones can be cached for a day.
        headers={"Cache-Control": "no-cache" if stale else "public, max-age=86400"},
    )


async def _serve_photo(hltv_id: Optional[int], name: Optional[str]):
    key = _photo_key(hltv_id, name)
    cache_path = _PHOTO_CACHE_DIR / f"{key}.png"
    missing_marker = _PHOTO_CACHE_DIR / f"{key}.404"

    if cache_path.exists() and cache_path.stat().st_size > 0:
        stale = _photo_needs_refresh(key)
        if stale:
            _schedule_photo_refresh(hltv_id, name)
        return _file_response(cache_path, stale)
    if missing_marker.exists() and not _is_older_than(missing_marker, _PHOTO_MAX_AGE_SECS):
        raise HTTPException(status_code=404, detail="No reusable photo for this player")

    fut = _lazy_submit(hltv_id, name)
    try:
        result = await asyncio.wait_for(
            asyncio.shield(asyncio.wrap_future(fut)), timeout=_LAZY_WAIT_SECS,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=503, detail="Photo lookup queued (Liquipedia rate limit)",
            headers={"Retry-After": "30", "Cache-Control": "no-store"},
        )
    if result == "ok" and cache_path.exists():
        return _file_response(cache_path, False)
    raise HTTPException(
        status_code=404 if result == "missing" else 502,
        detail="No reusable photo for this player" if result == "missing"
        else "Photo fetch failed",
    )


def _attribution(hltv_id: Optional[int], name: Optional[str]) -> dict:
    key = _photo_key(hltv_id, name)
    cache_path = _PHOTO_CACHE_DIR / f"{key}.png"
    sidecar = _PHOTO_CACHE_DIR / f"{key}.json"
    marker = _PHOTO_CACHE_DIR / f"{key}.404"
    base = {"key": key, "hltv_id": hltv_id, "name": name}
    if cache_path.exists() and cache_path.stat().st_size > 0:
        try:
            attr = json.loads(sidecar.read_text(encoding="utf-8"))
        except Exception:
            # Cached before attributions were recorded (HLTV era).
            attr = {"source": "hltv", "license": None, "credit": "Photo: HLTV.org"}
        return {**base, "available": True, **attr}
    if marker.exists():
        try:
            reasons = json.loads(marker.read_text(encoding="utf-8")).get("reasons", [])
        except Exception:
            reasons = []
        return {**base, "available": False, "reasons": reasons}
    raise HTTPException(status_code=404, detail="Photo not looked up yet")


def _name_or_400(name: str) -> str:
    clean = clean_player_name(name)
    if clean is None:
        raise HTTPException(status_code=400, detail="Invalid player name")
    return clean


@router.get(
    "/api/player-photo/by-name/{name}.png",
    summary="Player photo by name (players without an HLTV id)",
)
async def get_player_photo_by_name(name: str):
    return await _serve_photo(None, _name_or_400(name))


@router.get(
    "/api/player-photo/by-name/{name}/attribution",
    summary="License + author of a by-name player photo",
)
async def get_player_photo_attribution_by_name(name: str):
    return _attribution(None, _name_or_400(name))


@router.get(
    "/api/player-photo/{hltv_id:int}.png",
    summary="Player photo (Liquipedia, reusable licenses only) for an HLTV id",
)
async def get_player_photo(hltv_id: int):
    """Cache hit → straight FileResponse. Cold cache → the lookup is queued
    behind Liquipedia's rate limit; answers within ~12 s or 503s and keeps
    working in the background."""
    return await _serve_photo(hltv_id, None)


@router.get(
    "/api/player-photo/{hltv_id:int}/attribution",
    summary="License + author of a player photo",
)
async def get_player_photo_attribution(hltv_id: int):
    return _attribution(hltv_id, None)


# ─── Proactive photo warming ────────────────────────────────────────────


def _collect_known_hltv_ids() -> list[int]:
    """Union every `hltv_id` across every roster sidecar, in roster order."""
    demo_dir = settings.demo_dir
    if not demo_dir.exists():
        return []
    seen: set[int] = set()
    out: list[int] = []
    for path in sorted(demo_dir.glob("*.roster.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for team_key in ("team1", "team2"):
            team = data.get(team_key) or {}
            for entry in team.get("players_detailed") or []:
                pid = entry.get("hltv_id")
                if isinstance(pid, int) and pid not in seen:
                    seen.add(pid)
                    out.append(pid)
    return out


async def _warm_player_photos_task():
    """Fetch every known player's photo. Liquipedia lookups are prefetched
    50 names per query; image downloads then go one at a time through the
    Liquipedia throttle (1 request / 2 s)."""
    scraper = _hltv_scraper()
    ids = _collect_known_hltv_ids()
    names = _hltv_names()
    _photo_warm_state.update(
        running=True, done=0, total=len(ids),
        ok=0, missing=0, errors=0, started_at=time.time(),
    )
    logger.info("photo-warm: started, %d ids", len(ids))

    try:
        lookup = [names[i] for i in ids if i in names]
        for i in range(0, len(lookup), lp.BATCH):
            try:
                await asyncio.to_thread(lp.lookup_player_photos, lookup[i:i + lp.BATCH])
            except Exception as exc:
                logger.warning("photo-warm: Liquipedia lookup failed — %s", exc)

        for idx, hltv_id in enumerate(ids, start=1):
            try:
                # Stale photos are force-refreshed; a failed refresh keeps
                # the old file, so warming never blanks an avatar.
                result = await asyncio.to_thread(
                    _fetch_player_photo, hltv_id, scraper,
                    _photo_needs_refresh(hltv_id),
                )
            except Exception as exc:
                logger.warning("photo-warm %d: %s", hltv_id, exc)
                result = "error"

            if result == "ok":
                _photo_warm_state["ok"] += 1
            elif result == "missing":
                _photo_warm_state["missing"] += 1
            else:
                _photo_warm_state["errors"] += 1
            _photo_warm_state["done"] = idx
            await asyncio.sleep(0)
    finally:
        elapsed = time.time() - _photo_warm_state["started_at"]
        _photo_warm_state["running"] = False
        logger.info(
            "photo-warm: done in %.1fs — ok=%d missing=%d errors=%d",
            elapsed,
            _photo_warm_state["ok"],
            _photo_warm_state["missing"],
            _photo_warm_state["errors"],
        )


@router.post(
    "/api/player-photos/warm",
    summary="Pre-fetch every known player photo into the local cache",
)
async def warm_player_photos():
    """Kick off the warming background task. Poll
    `/api/player-photos/warm/status` for progress. A second call while one
    is running returns the in-flight total without restarting."""
    if _photo_warm_state["running"]:
        return {
            "started": False,
            "running": True,
            "done": _photo_warm_state["done"],
            "total": _photo_warm_state["total"],
        }
    ids = _collect_known_hltv_ids()
    _photo_warm_state.update(running=True, done=0, total=len(ids))
    asyncio.create_task(_warm_player_photos_task())
    return {"started": True, "running": True, "done": 0, "total": len(ids)}


@router.get(
    "/api/player-photos/warm/status",
    summary="Progress snapshot of the current photo-warm task",
)
async def warm_player_photos_status():
    return {
        "running":    _photo_warm_state["running"],
        "done":       _photo_warm_state["done"],
        "total":      _photo_warm_state["total"],
        "ok":         _photo_warm_state["ok"],
        "missing":    _photo_warm_state["missing"],
        "errors":     _photo_warm_state["errors"],
        # Cache generation — the frontend's `?v=` token on avatar URLs.
        "generation": _read_photo_generation(),
        "source":     "liquipedia",
        "attribution": "Player photos via Liquipedia (reusable licenses only)",
    }


@router.post(
    "/api/player-photos/clear",
    summary="Invalidate the entire on-disk player-photo cache",
    dependencies=_ADMIN,
)
async def clear_player_photos():
    """Mark every cached photo stale (and drop `.404` / retry markers) so
    the next render or warm run re-fetches. Photos are NOT deleted: each one
    is only replaced once a fresh download succeeds, so resetting while the
    source is unreachable never blanks the avatars. Attribution sidecars stay
    with their photos. Bumps the cache generation for the browser cache.
    `deleted` counts the photos marked for refresh (kept for API compat)."""
    if not _PHOTO_CACHE_DIR.exists():
        gen = _bump_photo_generation()
        return {"deleted": 0, "generation": gen}
    marked = 0
    for p in _PHOTO_CACHE_DIR.iterdir():
        if not p.is_file():
            continue
        try:
            if p.suffix == ".png":
                os.utime(p, (0, 0))  # epoch mtime ⇒ stale on next request
                marked += 1
            elif p.suffix in (".404", ".checked", ".part"):
                p.unlink()
        except OSError as exc:
            logger.warning("photo-cache: failed to reset %s — %s", p.name, exc)
    gen = _bump_photo_generation()
    logger.info("photo-cache reset: %d photos marked stale (gen → %d)", marked, gen)
    return {"deleted": marked, "generation": gen}
