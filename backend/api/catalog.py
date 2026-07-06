"""
/api/catalog — HLTV tournaments & matches browser + targeted demo fetch.

The router is built with its heavyweight dependencies injected from main.py
(shared ingest lock, timeline parser, photo-warm starter) so this module
never imports main — main includes the router at the bottom of the module,
after everything it needs exists.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, List, Optional

from fastapi import APIRouter, HTTPException, Query

from backend.config import settings
from backend.ingestion.match_catalog import (
    MatchCatalog,
    demo_dir_bytes,
    enforce_demo_retention,
    is_big_event,
)
from backend.models.schemas import (
    CatalogEventEntry,
    CatalogMatchEntry,
    CatalogStatusResponse,
)

logger = logging.getLogger(__name__)


def build_catalog_router(
    *,
    catalog: MatchCatalog,
    ingest_lock: asyncio.Lock,
    ensure_timeline: Callable[[Path], bool],
    start_photo_warm: Callable[[], Awaitable],
    timeline_dir: Path,
) -> APIRouter:
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

    state: dict = {"running": False, "phase": "idle", "detail": ""}

    # ── helpers ─────────────────────────────────────────────────────────

    def _local_maps(match_id: int) -> List[str]:
        toks = [
            p.stem.split("_", 1)[1]
            for p in settings.demo_dir.glob(f"{match_id}_*.dem")
        ]
        if (settings.demo_dir / f"{match_id}.dem").exists():
            toks.append("unknown")
        return sorted(toks)

    def _set(phase: str, detail: str = "") -> None:
        state["phase"] = phase
        state["detail"] = detail
        logger.info("[catalog] %s %s", phase, detail)

    async def _enrich_row(scraper, match_id: int) -> Optional[dict]:
        """Enrich one catalog row via its HLTV match page; persist results."""
        row = catalog.get(match_id)
        if row is None:
            return None
        loop = asyncio.get_event_loop()
        m = catalog.row_to_match(row)
        enriched = await loop.run_in_executor(None, lambda: scraper.enrich(m))
        if enriched is None:
            return row
        from backend.ingestion.hltv_scraper import _normalize_map
        catalog.mark_enriched(
            match_id,
            maps=[_normalize_map(x) for x in enriched.maps_played],
            demo_available=bool(
                enriched.match.demo_url or enriched.match.demo_urls
            ),
            demo_url=enriched.match.demo_url,
            demo_urls=enriched.match.demo_urls,
            team1_logo=enriched.match.team1_logo,
            team2_logo=enriched.match.team2_logo,
        )
        return catalog.get(match_id)

    async def _download_maps(scraper, row: dict, maps: List[str]) -> int:
        """Download + parse the given map demos for a catalog row."""
        loop = asyncio.get_event_loop()
        match = catalog.row_to_match(row)
        got = 0
        for tok in maps:
            _set(
                "downloading",
                f"{row['team1']} vs {row['team2']} — {tok}",
            )
            try:
                saved = await loop.run_in_executor(
                    None,
                    lambda t=tok: scraper.download_demo(
                        match, settings.demo_dir, prefer_map=t
                    ),
                )
            except Exception as exc:
                logger.error(
                    "[catalog] download failed for %d/%s: %s",
                    row["match_id"], tok, exc,
                )
                continue
            if isinstance(saved, Path) and saved.exists():
                got += 1
                _set("parsing", saved.name)
                await loop.run_in_executor(
                    None, lambda p=saved: ensure_timeline(p)
                )
        return got

    async def _finish_fetch_batch() -> None:
        """Post-download housekeeping: retention cap, then photo warm."""
        deleted = enforce_demo_retention(
            settings.demo_dir, timeline_dir, settings.demo_retention_gb
        )
        if deleted:
            _set("retention", f"deleted {len(deleted)} old demos")
        try:
            await start_photo_warm()
        except Exception as exc:            # photo warm is best-effort
            logger.warning("[catalog] photo warm failed to start: %s", exc)

    # ── background tasks ────────────────────────────────────────────────

    async def _refresh_task(pages: int) -> None:
        from backend.ingestion.hltv_scraper import HLTVScraper

        async with ingest_lock:
            state["running"] = True
            try:
                scraper = HLTVScraper()
                loop = asyncio.get_event_loop()

                _set("refreshing", f"scanning {pages} result pages")
                known = catalog.known_ids()
                rows = await loop.run_in_executor(
                    None,
                    lambda: scraper.list_results(
                        max_pages=pages, skip_match_ids=known
                    ),
                )
                new_ids = catalog.upsert_shallow(rows)
                _set("refreshing", f"{len(new_ids)} new matches")

                for i, mid in enumerate(new_ids, 1):
                    _set("enriching", f"{i}/{len(new_ids)} (match {mid})")
                    await _enrich_row(scraper, mid)

                if settings.catalog_autopull:
                    for mid in new_ids:
                        row = catalog.get(mid)
                        if not row or row["demo_available"] != 1:
                            continue
                        if not is_big_event(row["event"], row["stars"] or 0):
                            continue
                        maps = json.loads(row["maps_json"] or "[]")
                        todo = [t for t in maps if t not in _local_maps(mid)]
                        if todo:
                            await _download_maps(scraper, row, todo)

                await _finish_fetch_batch()
                catalog.set_meta("last_refresh_unix", str(int(time.time())))
                _set("idle", "refresh complete")
            except Exception as exc:
                logger.exception("[catalog] refresh failed: %s", exc)
                _set("error", str(exc))
            finally:
                state["running"] = False

    async def _fetch_task(match_id: int, map_token: Optional[str]) -> None:
        from backend.ingestion.hltv_scraper import HLTVScraper

        async with ingest_lock:
            state["running"] = True
            try:
                scraper = HLTVScraper()
                row = catalog.get(match_id)
                if row is None:
                    _set("error", f"match {match_id} not in catalog")
                    return
                if not row["enriched_at"]:
                    _set("enriching", f"match {match_id}")
                    row = await _enrich_row(scraper, match_id) or row
                if row["demo_available"] == 0:
                    _set("error", f"HLTV has no demo for match {match_id}")
                    return
                maps = json.loads(row["maps_json"] or "[]")
                todo = [map_token] if map_token else maps
                todo = [t for t in todo if t not in _local_maps(match_id)]
                if not todo:
                    _set("idle", "requested demos already local")
                    return
                got = await _download_maps(scraper, row, todo)
                await _finish_fetch_batch()
                _set("idle", f"fetched {got}/{len(todo)} demos")
            except Exception as exc:
                logger.exception("[catalog] fetch failed: %s", exc)
                _set("error", str(exc))
            finally:
                state["running"] = False

    # ── endpoints ───────────────────────────────────────────────────────

    @router.post("/refresh", summary="Incrementally scrape HLTV results into the catalog")
    async def refresh(pages: Optional[int] = Query(default=None, ge=1, le=10)):
        if state["running"] or ingest_lock.locked():
            raise HTTPException(status_code=409, detail="An ingest task is already running")
        asyncio.create_task(
            _refresh_task(pages or settings.catalog_refresh_pages)
        )
        return {"status": "queued"}

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
            autopull_enabled=settings.catalog_autopull,
        )

    @router.get("/events", response_model=List[CatalogEventEntry])
    async def events(days: int = Query(default=45, ge=1, le=365)):
        return [
            CatalogEventEntry(
                **e, big=is_big_event(e["event"], e["max_stars"] or 0)
            )
            for e in catalog.events(days=days)
        ]

    @router.get("/matches", response_model=List[CatalogMatchEntry])
    async def matches(
        event: Optional[str] = None,
        team: Optional[str] = None,
        days: Optional[int] = Query(default=45, ge=1, le=365),
        limit: int = Query(default=300, ge=1, le=1000),
    ):
        out = []
        for row in catalog.matches(event=event, team=team, days=days, limit=limit):
            out.append(
                CatalogMatchEntry(
                    match_id=row["match_id"],
                    team1=row["team1"],
                    team2=row["team2"],
                    event=row["event"],
                    date_unix=row["date_unix"],
                    stars=row["stars"] or 0,
                    score1=row["score1"],
                    score2=row["score2"],
                    maps=json.loads(row["maps_json"] or "[]"),
                    demo_available=row["demo_available"],
                    team1_logo=row["team1_logo"],
                    team2_logo=row["team2_logo"],
                    local_maps=_local_maps(row["match_id"]),
                )
            )
        return out

    @router.post(
        "/matches/{match_id}/fetch",
        summary="Download this match's demo(s), parse timelines, warm photos",
    )
    async def fetch_match(match_id: int, map: Optional[str] = None):
        if state["running"] or ingest_lock.locked():
            raise HTTPException(status_code=409, detail="An ingest task is already running")
        if catalog.get(match_id) is None:
            raise HTTPException(status_code=404, detail="Match not in catalog")
        from backend.ingestion.hltv_scraper import _normalize_map
        token = _normalize_map(map) if map else None
        asyncio.create_task(_fetch_task(match_id, token))
        return {"status": "queued", "match_id": match_id, "map": token}

    @router.post(
        "/backfill-rosters",
        summary="Write roster sidecars for uploaded demos named {match_id}_{map}.dem",
    )
    async def backfill_rosters():
        from backend.ingestion.hltv_scraper import HLTVScraper

        if state["running"] or ingest_lock.locked():
            raise HTTPException(status_code=409, detail="An ingest task is already running")

        async def _task():
            async with ingest_lock:
                state["running"] = True
                done = 0
                try:
                    scraper = HLTVScraper()
                    loop = asyncio.get_event_loop()
                    for dem in sorted(settings.demo_dir.glob("*.dem")):
                        try:
                            mid = int(dem.stem.split("_")[0])
                        except ValueError:
                            continue
                        if (settings.demo_dir / f"{mid}.roster.json").exists():
                            continue
                        _set("backfilling", dem.name)
                        seed: dict = {}
                        row = catalog.get(mid)
                        if row:
                            seed = {
                                "event": row["event"],
                                "date": catalog.row_to_match(row).date,
                                "team1": {"name": row["team1"]},
                                "team2": {"name": row["team2"]},
                            }
                        res = await loop.run_in_executor(
                            None,
                            lambda m=mid, s=seed: scraper.refresh_roster_sidecar(
                                m, s, settings.demo_dir
                            ),
                        )
                        if res:
                            done += 1
                    await _finish_fetch_batch()
                    _set("idle", f"backfilled {done} sidecars")
                except Exception as exc:
                    logger.exception("[catalog] backfill failed: %s", exc)
                    _set("error", str(exc))
                finally:
                    state["running"] = False

        asyncio.create_task(_task())
        return {"status": "queued"}

    return router
