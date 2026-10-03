"""
Player photo proxy, cache freshness, and warming.

Moved out of main.py; mounted with `app.include_router`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.api.deps import ADMIN as _ADMIN
from backend.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Player photo proxy ─────────────────────────────────────────────────
# HLTV's image CDN (`static.hltv.org`) is fronted by Cloudflare with a
# managed-challenge rule that 403s every naive hotlink — browsers loading
# <img src="https://static.hltv.org/..."> directly get blocked. The
# scraper already uses curl_cffi with a chrome124 impersonation profile
# to punch through the same protection for match pages, so we re-use that
# session to fetch bodyshots, cache them to disk, and serve them from
# our own origin. The frontend points every <PlayerAvatar> at
# /api/player-photo/{id}.png and stops worrying about CORS/CF entirely.

_PHOTO_CACHE_DIR = Path("backend/data/player_photos")


def _sniff_image_mime(head: bytes) -> str:
    """Detect the real image format from the first few bytes. HLTV's
    `static.hltv.org/images/playerprofile/bodyshot/*.png` URLs actually
    serve WebP (and sometimes JPEG) despite the `.png` suffix, so we
    can't trust the filename — sniff instead. Defaults to `image/webp`
    since that's what HLTV currently serves for most bodyshots."""
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"GIF8"):
        return "image/gif"
    return "image/webp"


# Progress state for the photo-warming background task. Shared between
# the POST kick-off endpoint and the GET status-poll endpoint, mirroring
# how `_ingest_state` works for demo scraping.
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
    """Increments every time the photo cache is cleared. Stored as a
    plain integer in a sidecar file so it survives uvicorn reloads;
    the frontend reads it via the warm-status endpoint and uses it as
    a cache-bust query token (`?v={gen}`) so the *browser* HTTP cache
    invalidates on every server-side wipe — even when the user just
    reloads the page instead of clicking the Refresh button."""
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


def _fetch_player_photo(hltv_id: int, scraper, force: bool = False) -> str:
    """Fetch (or confirm missing) the bodyshot image for `hltv_id`,
    writing it to `_PHOTO_CACHE_DIR`. Returns one of:
        "ok"       — image bytes written to cache
        "missing"  — HLTV has no bodyshot for this id; 404 marker written
        "error"    — transient failure (network, CF challenge, etc.)
                     Caller may choose to retry later.

    Called in a loop from the /api/player-photos/warm background task,
    and also from the single-image GET endpoint for lazy fetches.
    Shared helper so warm and lazy paths stay in lockstep.

    `force=True` re-fetches even when a photo is cached (staleness
    refresh); the cached file is only replaced by a successful download.
    """
    _PHOTO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _PHOTO_CACHE_DIR / f"{hltv_id}.png"
    missing_marker = _PHOTO_CACHE_DIR / f"{hltv_id}.404"
    checked_marker = _PHOTO_CACHE_DIR / f"{hltv_id}.checked"
    have_cached = cache_path.exists() and cache_path.stat().st_size > 0

    if not force:
        if have_cached:
            return "ok"
        if missing_marker.exists() and not _is_older_than(missing_marker, _PHOTO_MAX_AGE_SECS):
            return "missing"

    # Prefer the live profile-page <img src> (current photo); fall back
    # to the classic static endpoint if scraping turns up nothing.
    scraped_url = _scrape_player_image_url(hltv_id, scraper)
    urls: list[str] = []
    if scraped_url:
        urls.append(scraped_url)
    if not have_cached:
        # The static endpoint is often years out of date — fine as a
        # first image, but a refresh must never swap a current photo for it.
        urls.append(
            f"https://static.hltv.org/images/playerprofile/bodyshot/{hltv_id}.png"
        )
    elif not scraped_url:
        # Couldn't read the live profile (blocked / changed) — keep the
        # cached photo and retry after the back-off.
        checked_marker.touch()
        return "error"

    # Only a clean 404 from every source proves "no photo". A Cloudflare
    # challenge (403), rate limit or network error is transient — never
    # let it overwrite a good photo or poison the cache with a .404.
    transient = False
    for url in urls:
        try:
            resp = scraper._session.get(url, timeout=15)
        except Exception as exc:
            logger.debug("photo %d: %s fetch error — %s", hltv_id, url, exc)
            transient = True
            continue
        if resp.status_code == 404:
            # Specifically 404 — try the next URL before giving up.
            continue
        if resp.status_code != 200:
            transient = True
            continue
        ct = resp.headers.get("content-type", "").lower()
        if not ct.startswith("image/"):
            transient = True
            continue
        tmp = cache_path.with_suffix(".part")
        tmp.write_bytes(resp.content)
        tmp.replace(cache_path)  # atomic swap — readers never see half a file
        missing_marker.unlink(missing_ok=True)
        checked_marker.unlink(missing_ok=True)
        return "ok"

    # Remember the failed attempt so stale photos aren't retried on every view.
    checked_marker.touch()
    if transient:
        return "error"
    if have_cached:
        return "ok"  # every source says 404 now — keep serving the old photo
    missing_marker.write_bytes(b"")
    return "missing"


# A cached photo older than this is re-fetched in the background while the
# old one keeps being served (HLTV swaps bodyshots each season / transfer).
# Failed refreshes back off for a day.
_PHOTO_MAX_AGE_SECS = 14 * 86400
_PHOTO_RETRY_SECS = 86400
_photo_refreshing: set[int] = set()


def _is_older_than(path: Path, secs: float) -> bool:
    try:
        return time.time() - path.stat().st_mtime > secs
    except OSError:
        return True


def _photo_needs_refresh(hltv_id: int) -> bool:
    cache_path = _PHOTO_CACHE_DIR / f"{hltv_id}.png"
    checked = _PHOTO_CACHE_DIR / f"{hltv_id}.checked"
    if checked.exists() and not _is_older_than(checked, _PHOTO_RETRY_SECS):
        return False
    return _is_older_than(cache_path, _PHOTO_MAX_AGE_SECS)


def _schedule_photo_refresh(hltv_id: int) -> None:
    """Stale-while-revalidate: refresh one photo off the request path."""
    if hltv_id in _photo_refreshing:
        return
    _photo_refreshing.add(hltv_id)

    def _run() -> None:
        from backend.ingestion.hltv_scraper import HLTVScraper
        try:
            result = _fetch_player_photo(hltv_id, HLTVScraper(), force=True)
            logger.info("photo %d: background refresh → %s", hltv_id, result)
        except Exception as exc:
            logger.warning("photo %d: background refresh failed — %s", hltv_id, exc)
        finally:
            _photo_refreshing.discard(hltv_id)

    asyncio.get_running_loop().run_in_executor(None, _run)


def _scrape_player_image_url(hltv_id: int, scraper) -> Optional[str]:
    """Visit the HLTV player page and return the URL of the current
    bodyshot image embedded on it.

    HLTV's CDN structure (verified live on 2026-04-24):

        Main photo:    img-cdn.hltv.org/playerbodyshot/{token}.png?...
                       (token is a content-hash, not the player id)
                       Marked up as `<img class="bodyshot-img">` inside
                       `<div class="playerBodyshot">`.

        Stale fallback: static.hltv.org/images/playerprofile/bodyshot/{id}.png
                       (often a 5+ year old snapshot — only used if the
                       primary scrape fails entirely.)

    Player pages also contain bodyshots for OTHER players (Player of the
    Week, FPL avatars, recent transfer images) — we have to be selective
    or we'll grab someone else's photo.

    Selector strategy, in order of specificity:
        1. `.playerBodyshot .bodyshot-img` — *the* primary photo for
           this profile, scoped to the section that's about this player.
        2. `img.bodyshot-img` — same class, in case the parent wrapper
           was renamed in a layout tweak.
        3. First `img-cdn.hltv.org/playerbodyshot/{token}.png` URL whose
           parent isn't a known "other player" container (FPL, transfer,
           player-of-the-week). DOM order; first hit wins.
    """
    from urllib.parse import urljoin
    try:
        soup = scraper._get(f"https://www.hltv.org/player/{hltv_id}/-")
    except Exception as exc:
        logger.debug("player-photo %d: page fetch failed — %s", hltv_id, exc)
        return None

    def _abs(src: str) -> str:
        return urljoin("https://www.hltv.org/", src)

    # 1) Most specific — main profile photo.
    el = soup.select_one(".playerBodyshot .bodyshot-img")
    if el and el.get("src"):
        url = _abs(el["src"])
        logger.debug("player-photo %d: primary scrape — %s", hltv_id, url)
        return url

    # 2) Just the class, if the wrapper got renamed.
    el = soup.select_one("img.bodyshot-img")
    if el and el.get("src"):
        url = _abs(el["src"])
        logger.debug("player-photo %d: class-only scrape — %s", hltv_id, url)
        return url

    # 3) Last resort — first hltv-cdn playerbodyshot URL that isn't
    #    inside a "show some OTHER player" widget. Skips Player of the
    #    Week, FPL roster avatars, and transfer-news images.
    SKIP_CLASSES = {
        "playerOfTheWeekBodyshot",
        "playerOfTheWeekBodyshotContainer",
        "fpl-avatar",
        "fpl-player",
        "transfer-player-image",
        "transfer-player-image-container",
    }

    def _ancestor_classes(node) -> set[str]:
        out: set[str] = set()
        cur = node
        for _ in range(6):  # 6 levels up is plenty
            if cur is None:
                break
            for c in (cur.get("class") or []):
                out.add(c)
            cur = cur.parent
        return out

    for img in soup.select("img[src]"):
        src = img.get("src") or ""
        if "img-cdn.hltv.org/playerbodyshot/" not in src.lower():
            continue
        if _ancestor_classes(img) & SKIP_CLASSES:
            continue
        url = _abs(src)
        logger.debug("player-photo %d: cdn fallback — %s", hltv_id, url)
        return url

    return None


@router.get(
    "/api/player-photo/{hltv_id}.png",
    summary="Proxy + cache an HLTV player bodyshot image",
)
async def get_player_photo(hltv_id: int):
    """Lazy per-id fetch — if the cache is already populated (e.g. the
    user warmed it via /api/player-photos/warm), this is a straight
    FileResponse with no HLTV traffic. Otherwise calls `_fetch_player_photo`
    to pull it now. Heavy (~1-3s) on a cold cache."""
    cache_path = _PHOTO_CACHE_DIR / f"{hltv_id}.png"
    missing_marker = _PHOTO_CACHE_DIR / f"{hltv_id}.404"

    if cache_path.exists() and cache_path.stat().st_size > 0:
        stale = _photo_needs_refresh(hltv_id)
        if stale:
            _schedule_photo_refresh(hltv_id)
        return FileResponse(
            cache_path,
            media_type=_sniff_image_mime(cache_path.read_bytes()[:16]),
            # A stale photo is being replaced right now — don't let the
            # browser pin it; fresh ones can be cached for a day.
            headers={"Cache-Control": "no-cache" if stale else "public, max-age=86400"},
        )
    if missing_marker.exists() and not _is_older_than(missing_marker, _PHOTO_MAX_AGE_SECS):
        raise HTTPException(status_code=404, detail="No HLTV photo for this player")

    from backend.ingestion.hltv_scraper import HLTVScraper
    result = _fetch_player_photo(hltv_id, HLTVScraper())
    if result == "ok":
        return FileResponse(
            cache_path,
            media_type=_sniff_image_mime(cache_path.read_bytes()[:16]),
            headers={"Cache-Control": "public, max-age=86400"},
        )
    raise HTTPException(
        status_code=404 if result == "missing" else 502,
        detail="No HLTV photo for this player" if result == "missing"
               else "HLTV fetch failed",
    )


# ─── Proactive photo warming ────────────────────────────────────────────
# The frontend's Refresh flow clears the on-disk cache, then kicks off
# this endpoint to warm every known HLTV id in the background. A sibling
# GET endpoint reports progress so the button can show
# "Loading images (42 / 70)…" in real time.

def _collect_known_hltv_ids() -> list[int]:
    """Union every `hltv_id` across every roster sidecar. Same source
    `/api/player-hltv-ids` uses, but returns ints in roster order."""
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
    """Background task — iterate known HLTV ids, fetch each photo,
    update `_photo_warm_state` as we go. Single-worker (sequential) so
    we stay within HLTV's polite request pace; the scraper's shared
    delay between match-page fetches doesn't apply to images, so we
    add a small yield between fetches to avoid hammering the CDN."""
    from backend.ingestion.hltv_scraper import HLTVScraper
    scraper = HLTVScraper()

    ids = _collect_known_hltv_ids()
    _photo_warm_state.update(
        running=True, done=0, total=len(ids),
        ok=0, missing=0, errors=0, started_at=time.time(),
    )
    logger.info("photo-warm: started, %d ids", len(ids))

    try:
        for idx, hltv_id in enumerate(ids, start=1):
            try:
                # `_fetch_player_photo` is sync + networky; run in the
                # default thread pool so we don't block the event loop.
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

            # Polite gap — 400 ms keeps us under ~2.5 rps peak, well
            # inside what HLTV's CDN tolerates without CF challenging.
            await asyncio.sleep(0.4)
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
    summary="Pre-fetch every known HLTV player photo into the local cache",
)
async def warm_player_photos():
    """Kick off the warming background task. Returns immediately with
    the total. Clients should poll `/api/player-photos/warm/status` for
    progress. Safe to call concurrently — a second call while one is
    already running returns the in-flight total without restarting."""
    if _photo_warm_state["running"]:
        return {
            "started": False,
            "running": True,
            "done": _photo_warm_state["done"],
            "total": _photo_warm_state["total"],
        }
    ids = _collect_known_hltv_ids()
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
        # Cache generation — frontend uses this as the `?v=` query token
        # on every avatar URL so the browser HTTP cache invalidates in
        # lockstep with the server-side wipe, even when the user
        # reloads instead of clicking Refresh.
        "generation": _read_photo_generation(),
    }


@router.post(
    "/api/player-photos/clear",
    summary="Invalidate the entire on-disk player-photo cache",
    dependencies=_ADMIN,
)
async def clear_player_photos():
    """Mark every cached photo stale (and drop `.404` / retry markers) so
    the next render or warm run re-fetches from HLTV. Photos are NOT
    deleted: each one is only replaced once a fresh download succeeds, so
    resetting while HLTV is unreachable never blanks the avatars.
    Also bumps the cache generation counter so reloading clients see a
    new `?v=` token and the browser HTTP cache evicts in lockstep.
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
