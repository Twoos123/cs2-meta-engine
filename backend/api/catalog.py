"""
/api/catalog — tournaments & matches browser, fed by Liquipedia.

HLTV now answers every server-side request with a Cloudflare 403, so the
catalog reads Liquipedia's MediaWiki API instead (backend/ingestion/
liquipedia.py — throttled, cached, CC-BY-SA attributed) and the server no
longer downloads demos. Each match links out to its HLTV page, where the
browser extension's "Send to CS2 Meta Engine" button hands the demo back;
demos already on disk are matched to their catalog row and open in the
2D replay.

The router is built with dependencies injected from main.py so this module
never imports main. `ingest_lock`, `ensure_timeline` and `start_photo_warm`
are still accepted for compatibility; the Liquipedia refresh needs none of
them (it never touches demos) and runs under its own lock.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, List, Optional

from fastapi import APIRouter, HTTPException, Query

from backend.config import settings
from backend.ingestion import liquipedia as lp
from backend.ingestion.match_catalog import (
    MatchCatalog,
    demo_dir_bytes,
    is_big_event,
)
from backend.models.schemas import (
    CatalogEventEntry,
    CatalogMatchEntry,
    CatalogStatusResponse,
)

logger = logging.getLogger(__name__)

REPARSE_AFTER_S = 6 * 3600

GONE_DETAIL = (
    "Server-side demo downloads were removed: HLTV blocks them (Cloudflare 403). "
    "Use 'Open on HLTV' and the browser extension's 'Send to CS2 Meta Engine' button."
)


# ─── Local demo matching ────────────────────────────────────────────────

_TEAM_NOISE = re.compile(r"\b(team|gaming|esports?|e-sports|clan|club|gg)\b")


def norm_team(name: str) -> str:
    n = _TEAM_NOISE.sub(" ", (name or "").lower())
    return re.sub(r"[^a-z0-9]", "", n)


def _same_team(a: str, b: str) -> bool:
    x, y = norm_team(a), norm_team(b)
    if not x or not y:
        return False
    return x == y or (min(len(x), len(y)) >= 3 and (x in y or y in x))


def _same_event(a: str, b: str) -> bool:
    ta = set(re.findall(r"[a-z0-9]+", (a or "").lower()))
    tb = set(re.findall(r"[a-z0-9]+", (b or "").lower()))
    if not ta or not tb:
        return False
    return len(ta & tb) / len(ta | tb) >= 0.6


def _demo_files(demo_dir: Path, match_id: int) -> List[str]:
    files = sorted(p.name for p in demo_dir.glob(f"{match_id}_*.dem"))
    if (demo_dir / f"{match_id}.dem").exists():
        files.append(f"{match_id}.dem")
    return files


def _map_token(file_name: str) -> str:
    stem = file_name[:-4] if file_name.endswith(".dem") else file_name
    return stem.split("_", 1)[1] if "_" in stem else "unknown"


def local_roster_index(demo_dir: Path) -> List[dict]:
    """Roster sidecars that have at least one .dem on disk."""
    out: List[dict] = []
    if not demo_dir.exists():
        return out
    for path in demo_dir.glob("*.roster.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            mid = int(data.get("match_id") or path.name.split(".")[0])
        except Exception:
            continue
        files = _demo_files(demo_dir, mid)
        if not files:
            continue
        out.append({
            "match_id": mid,
            "team1": (data.get("team1") or {}).get("name") or "",
            "team2": (data.get("team2") or {}).get("name") or "",
            "event": data.get("event") or "",
            "date": data.get("date") or "",
            "files": files,
        })
    return out


def local_demos_for(row: dict, demo_dir: Path, index: List[dict]) -> List[str]:
    """Demo files on disk for a catalog row: by HLTV id when known,
    otherwise by team names + date (or event name when the sidecar has no
    date)."""
    if row.get("hltv_id"):
        # Sidecars are keyed by HLTV id too, so a known id is decisive — a
        # name match would only find a different meeting of the same teams.
        return _demo_files(demo_dir, int(row["hltv_id"]))
    t1, t2 = row.get("team1") or "", row.get("team2") or ""
    for r in index:
        teams_ok = (
            (_same_team(t1, r["team1"]) and _same_team(t2, r["team2"]))
            or (_same_team(t1, r["team2"]) and _same_team(t2, r["team1"]))
        )
        if not teams_ok:
            continue
        if r["date"] and row.get("date_unix"):
            try:
                d = datetime.strptime(r["date"][:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if abs(d.timestamp() - row["date_unix"]) <= 2 * 86400:
                return r["files"]
        elif _same_event(row.get("event") or "", r["event"]):
            return r["files"]
    return []


# ─── Router ─────────────────────────────────────────────────────────────


def build_catalog_router(
    *,
    catalog: MatchCatalog,
    ingest_lock: Optional[asyncio.Lock] = None,
    ensure_timeline: Optional[Callable[[Path], bool]] = None,
    start_photo_warm: Optional[Callable[[], Awaitable]] = None,
    timeline_dir: Optional[Path] = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

    state: dict = {"running": False, "phase": "idle", "detail": ""}

    def _set(phase: str, detail: str = "") -> None:
        state["phase"] = phase
        state["detail"] = detail
        logger.info("[catalog] %s %s", phase, detail)

    # ── refresh (blocking; runs in a worker thread) ─────────────────────

    def _refresh_sync(force: bool) -> None:
        _set("refreshing", "Liquipedia:Matches")
        ticker = lp.fetch_recent_matches(force=force)

        pages = sorted({m.page for m in ticker})
        _set("refreshing", f"tiers for {len(pages)} tournaments")
        tiers = lp.fetch_tournament_tiers(pages)
        new, updated = catalog.upsert_matches(ticker, tiers)
        _set("refreshing", f"{new} new, {updated} updated matches")

        # Maps + HLTV links from big tournaments that just finished matches.
        # Each is an action=parse (≥30 s apart per Liquipedia's terms), so
        # cap them per run; the rest are picked up by the next refresh.
        wanted = {
            t.strip() for t in settings.liquipedia_enrich_tiers.split(",") if t.strip()
        }
        # A page is re-parsed only when a match finished after its last parse,
        # or (for results Liquipedia editors hadn't filled in yet) 6 h later.
        now = time.time()
        todo = []
        for page, event, completed_at in catalog.tournaments_to_enrich(wanted, 50):
            parsed = float(catalog.get_meta(f"lp_parsed:{page}") or 0)
            if completed_at > parsed or now - parsed > REPARSE_AFTER_S:
                todo.append((page, event, completed_at))
        todo = todo[: settings.liquipedia_max_tournament_parses]
        for i, (page, event, completed_at) in enumerate(todo, 1):
            _set(
                "enriching",
                f"{i}/{len(todo)} {event} (Liquipedia allows one page parse per 30 s)",
            )
            try:
                rows = lp.fetch_tournament_matches(page, event, not_before=completed_at)
            except lp.LiquipediaError as exc:
                logger.warning("[catalog] tournament %s: %s", page, exc)
                continue
            catalog.upsert_matches(rows, {page: tiers.get(page)}, enriched=True)
            catalog.set_meta(f"lp_parsed:{page}", str(int(time.time())))

        if settings.catalog_autopull:
            logger.warning(
                "[catalog] CATALOG_AUTOPULL is set but server-side demo "
                "downloads are gone (HLTV blocks them) — ignoring"
            )
        catalog.set_meta("last_refresh_unix", str(int(time.time())))

    _lock = asyncio.Lock()

    async def _refresh_task(force: bool) -> None:
        async with _lock:
            state["running"] = True
            try:
                await asyncio.to_thread(_refresh_sync, force)
                _set("idle", "refresh complete")
            except Exception as exc:
                logger.exception("[catalog] refresh failed: %s", exc)
                _set("error", str(exc))
            finally:
                state["running"] = False

    # ── row → response ──────────────────────────────────────────────────

    def _entry(row: dict, index: List[dict]) -> CatalogMatchEntry:
        files = local_demos_for(row, settings.demo_dir, index)
        hltv_id = row.get("hltv_id")
        page = row.get("event_page")
        return CatalogMatchEntry(
            match_key=row["match_key"],
            match_id=hltv_id,
            source=row["source"],
            team1=row["team1"],
            team2=row["team2"],
            event=row["event"],
            stage=row.get("stage"),
            date_unix=row.get("date_unix"),
            status=row.get("status") or "completed",
            best_of=row.get("best_of"),
            tier=row.get("tier"),
            stars=row.get("stars") or 0,
            score1=row.get("score1"),
            score2=row.get("score2"),
            maps=json.loads(row.get("maps_json") or "[]"),
            demo_available=row.get("demo_available", -1),
            team1_logo=row.get("team1_logo"),
            team2_logo=row.get("team2_logo"),
            hltv_url=f"https://www.hltv.org/matches/{hltv_id}/-" if hltv_id else None,
            liquipedia_url=lp.page_url(page) if page else None,
            local_maps=sorted({_map_token(f) for f in files}),
            local_demos=files,
        )

    # ── endpoints ───────────────────────────────────────────────────────

    @router.post("/refresh", summary="Incrementally refresh the catalog from Liquipedia")
    async def refresh(
        pages: Optional[int] = Query(default=None, ge=1, le=10,
                                     description="Ignored (HLTV-era parameter)"),
        force: bool = Query(default=False,
                            description="Bypass the 20-minute Liquipedia:Matches cache"),
    ):
        if state["running"] or _lock.locked():
            raise HTTPException(status_code=409, detail="A catalog refresh is already running")
        state["running"] = True
        _set("queued")
        asyncio.create_task(_refresh_task(force))
        return {"status": "queued", "source": "liquipedia"}

    @router.get("/status", response_model=CatalogStatusResponse)
    async def status():
        last = catalog.get_meta("last_refresh_unix")
        return CatalogStatusResponse(
            running=state["running"],
            phase=state["phase"],
            detail=state["detail"],
            last_refresh_unix=int(last) if last else None,
            demo_disk_used_gb=round(demo_dir_bytes(settings.demo_dir) / 1024**3, 2),
            demo_retention_gb=settings.demo_retention_gb,
            autopull_enabled=False,
            attribution=lp.ATTRIBUTION,
            attribution_url=lp.page_url("Liquipedia:Matches"),
        )

    @router.get("/events", response_model=List[CatalogEventEntry])
    async def events(days: int = Query(default=45, ge=1, le=365)):
        return [
            CatalogEventEntry(
                event=e["event"],
                match_count=e["match_count"],
                first_date_unix=e["first_date_unix"],
                last_date_unix=e["last_date_unix"],
                max_stars=e["max_stars"],
                big=is_big_event(e["event"], e["max_stars"] or 0, e["tier"]),
                tier=e["tier"],
                source=e["source"],
                liquipedia_url=lp.page_url(e["event_page"]) if e["event_page"] else None,
            )
            for e in catalog.events(days=days)
        ]

    @router.get("/matches", response_model=List[CatalogMatchEntry])
    async def matches(
        event: Optional[str] = None,
        team: Optional[str] = None,
        days: Optional[int] = Query(default=45, ge=1, le=365),
        status: Optional[str] = Query(default=None, pattern="^(upcoming|completed)$"),
        limit: int = Query(default=300, ge=1, le=1000),
    ):
        index = local_roster_index(settings.demo_dir)
        rows = catalog.matches(
            event=event, team=team, days=days, status=status, limit=limit,
        )
        return [_entry(r, index) for r in rows]

    @router.post(
        "/matches/{match_id}/fetch",
        summary="Removed — HLTV blocks server-side demo downloads",
        status_code=410,
    )
    async def fetch_match(match_id: str, map: Optional[str] = None):
        raise HTTPException(status_code=410, detail=GONE_DETAIL)

    @router.post(
        "/backfill-rosters",
        summary="Removed — roster backfill scraped HLTV, which now blocks it",
        status_code=410,
    )
    async def backfill_rosters():
        raise HTTPException(
            status_code=410,
            detail="Roster backfill scraped HLTV match pages, which are blocked (Cloudflare 403).",
        )

    return router
