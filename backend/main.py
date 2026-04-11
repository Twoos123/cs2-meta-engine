"""
FastAPI application — CS2 Utility Meta-Analysis Engine API.

Endpoints
---------
GET  /api/lineups/{map_name}/{grenade_type}?limit=10   Top N lineups
GET  /api/lineups/{map_name}                           All types for a map
GET  /api/maps                                         Available maps
GET  /api/stats                                        DB summary stats
GET  /api/console/{cluster_id}?map_name=de_mirage     Console string
POST /api/practice                                     RCON teleport
POST /api/ingest/hltv                                  Scrape + download demos
POST /api/ingest/run                                   Run analysis pipeline
GET  /api/health                                       Health check
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.config import settings
from backend.models.schemas import (
    HLTVMatch,
    TopLineupsResponse,
    LineupRanking,
    PracticeRequest,
    PracticeResponse,
    IngestionStatusResponse,
)
from backend.analysis.metrics import MetricsPipeline
from backend.rcon.bridge import RCONBridge, generate_console_string

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="CS2 Utility Meta-Analysis Engine",
    description="Discover and practice pro-level grenade lineups powered by demoparser2, DBSCAN, and RCON.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Singleton pipeline (shared across requests)
_pipeline = MetricsPipeline()
_rcon = RCONBridge()

# Concurrency guard — only one ingest job may run at a time
_ingest_lock = asyncio.Lock()
_ingest_state: dict = {
    "running": False,
    "phase": "idle",
    "message": "",
    # run_id is incremented in each POST handler before the background task
    # is scheduled, so the frontend can capture it from the POST response and
    # poll until last_completed_run_id reaches it. This closes a race where
    # fast pipelines (empty demo dir, all demos skipped) finish before the
    # first 1.5-second status poll fires, leaving the poll loop waiting for
    # a "running" state it never observed.
    "run_id": 0,
    "last_completed_run_id": 0,
}


# ---------------------------------------------------------------------------
# Request / response models specific to this API layer
# ---------------------------------------------------------------------------

class HLTVIngestRequest(BaseModel):
    team_name: Optional[str] = None
    event_name: Optional[str] = None
    map_name: Optional[str] = None
    limit: int = 10

class RunPipelineRequest(BaseModel):
    map_name: Optional[str] = None
    grenade_types: Optional[List[str]] = None
    clear_existing: bool = False


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


# ---------------------------------------------------------------------------
# Lineup endpoints
# ---------------------------------------------------------------------------

@app.get(
    "/api/lineups/{map_name}/{grenade_type}",
    response_model=TopLineupsResponse,
    summary="Top N lineups for a map + grenade type",
)
async def get_top_lineups(
    map_name: str,
    grenade_type: str,
    limit: int = Query(10, ge=1, le=2000),
):
    """
    Returns the top `limit` ranked grenade lineups for the given map and type.

    - **map_name**: e.g. `de_mirage`, `de_dust2`
    - **grenade_type**: `smokegrenade`, `hegrenade`, `flashbang`, `molotov`
    - **limit**: number of results (1–100, default 10)
    """
    lineups = _pipeline.get_top_lineups(
        map_name=map_name,
        grenade_type=grenade_type,
        limit=limit,
    )

    if not lineups:
        raise HTTPException(
            status_code=404,
            detail=f"No lineups found for map={map_name}, type={grenade_type}. "
                   "Run the ingestion pipeline first.",
        )

    return TopLineupsResponse(
        map_name=map_name,
        grenade_type=grenade_type,
        lineups=lineups,
        total_clusters=len(lineups),
    )


@app.get(
    "/api/lineups/{map_name}",
    response_model=List[TopLineupsResponse],
    summary="All grenade types for a map",
)
async def get_all_types_for_map(
    map_name: str,
    limit: int = Query(10, ge=1, le=2000),
):
    """Returns ranked lineups for every grenade type available on this map."""
    types = _pipeline.list_available_types(map_name)
    if not types:
        raise HTTPException(status_code=404, detail=f"No data found for map={map_name}")

    results = []
    for gtype in types:
        lineups = _pipeline.get_top_lineups(map_name=map_name, grenade_type=gtype, limit=limit)
        results.append(
            TopLineupsResponse(
                map_name=map_name,
                grenade_type=gtype,
                lineups=lineups,
                total_clusters=len(lineups),
            )
        )
    return results


@app.get("/api/maps", summary="List maps with analysed data")
async def list_maps():
    return {"maps": _pipeline.list_available_maps()}


@app.get("/api/callouts/{map_name}", summary="Callout origins for radar overlay")
async def get_callouts(map_name: str):
    """
    Returns the list of callout labels and their 2D world origins for the
    requested map. Used by the radar visualization to annotate throw/land
    positions with nearby location names.
    """
    from backend.analysis import callouts as callouts_mod

    origins = callouts_mod._CALLOUTS.get(map_name, [])
    return {
        "map_name": map_name,
        "callouts": [
            {"name": o.name, "x": o.x, "y": o.y} for o in origins
        ],
    }


# Radar assets come from `awpy get maps` — PNG overviews + per-map calibration
# (pos_x/pos_y = world coord of the image's top-left corner, scale = world
# units per pixel). Copy-in location: backend/data/radars/.
_RADAR_DIR = Path(__file__).resolve().parent / "data" / "radars"
_RADAR_MAP_DATA: dict = {}
try:
    _RADAR_MAP_DATA = json.loads(
        (_RADAR_DIR / "map-data.json").read_text(encoding="utf-8")
    )
except Exception as exc:
    logger.warning("No radar map-data.json found: %s", exc)


@app.get("/api/radars/{map_name}.png", summary="Radar overview PNG for a map")
async def get_radar_image(map_name: str):
    """Serves the awpy-sourced radar PNG for the requested map."""
    path = _RADAR_DIR / f"{map_name}.png"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No radar for {map_name}")
    return FileResponse(path, media_type="image/png")


@app.get("/api/radars/{map_name}", summary="Radar calibration data for a map")
async def get_radar_info(map_name: str):
    """
    Returns `{pos_x, pos_y, scale, rotate}` so the frontend can project
    world coordinates onto the radar PNG via:

        pixel_x = (world_x - pos_x) / scale
        pixel_y = (pos_y - world_y) / scale

    plus an `image_url` pointing at the PNG endpoint above.
    """
    info = _RADAR_MAP_DATA.get(map_name)
    if not info:
        raise HTTPException(
            status_code=404, detail=f"No radar calibration for {map_name}"
        )
    return {
        "map_name": map_name,
        "pos_x": info.get("pos_x"),
        "pos_y": info.get("pos_y"),
        "scale": info.get("scale"),
        "rotate": info.get("rotate", 0),
        "image_url": f"/api/radars/{map_name}.png",
    }


@app.get("/api/demos", summary="List downloaded demos grouped by map")
async def list_downloaded_demos():
    """
    Walks the demo directory, groups .dem files by their map token (parsed
    from the filename suffix written by the HLTV scraper) and reports the
    count per map. Used by the dashboard to populate a dynamic map picker
    showing only the maps the user actually has demos for.
    """
    demo_dir = settings.demo_dir
    if not demo_dir.exists():
        return {"maps": [], "total_demos": 0}

    counts: dict[str, int] = {}
    untagged = 0
    for p in demo_dir.glob("*.dem"):
        stem = p.stem
        if "_" in stem:
            _, _, token = stem.partition("_")
            token = token.strip().lower()
            if token:
                counts[token] = counts.get(token, 0) + 1
                continue
        untagged += 1

    maps = [
        {"map_name": f"de_{tok}", "token": tok, "count": n}
        for tok, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return {
        "maps": maps,
        "total_demos": sum(counts.values()) + untagged,
        "untagged": untagged,
    }


@app.get("/api/stats", summary="DB summary statistics")
async def get_stats():
    return _pipeline.get_stats()


@app.delete("/api/data", summary="Clear all analysed lineup data")
async def clear_data():
    """
    Wipes every row from the `lineup_clusters` table. Demo files on disk
    are left alone — re-run the pipeline or ingest HLTV to repopulate.
    """
    if _ingest_state["running"]:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot clear while ingest is running: {_ingest_state['phase']}",
        )
    deleted = _pipeline.clear_all()
    return {"deleted": deleted, "status": "cleared"}


# ---------------------------------------------------------------------------
# Console string endpoint
# ---------------------------------------------------------------------------

@app.get(
    "/api/console/{cluster_id}",
    summary="Get copy-paste CS2 console string for a lineup",
)
async def get_console_string(
    cluster_id: int,
    map_name: str = Query(..., description="e.g. de_mirage"),
):
    """
    Returns the semicolon-separated CS2 console command string you can paste
    directly into the game console (requires sv_cheats 1 on the server).
    """
    cluster = _pipeline.get_cluster_by_id(cluster_id, map_name)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    console_string = generate_console_string(cluster)
    return {
        "cluster_id": cluster_id,
        "map_name": map_name,
        "label": cluster.label,
        "console_string": console_string,
    }


# ---------------------------------------------------------------------------
# RCON practice endpoint
# ---------------------------------------------------------------------------

@app.post(
    "/api/practice",
    response_model=PracticeResponse,
    summary="Teleport in-game to a lineup position via RCON",
)
async def practice_lineup(req: PracticeRequest):
    """
    Sends setpos / setang / give commands to your local CS2 server via RCON.
    CS2 must be running with `-netconport` and `rcon_password` set.
    """
    cluster = _pipeline.get_cluster_by_id(req.cluster_id, req.map_name)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    result = await _rcon.teleport_to_lineup(cluster)
    return result


# ---------------------------------------------------------------------------
# Ingestion endpoints
# ---------------------------------------------------------------------------

@app.post(
    "/api/ingest/hltv",
    summary="Scrape HLTV and download demos",
)
async def ingest_from_hltv(req: HLTVIngestRequest):
    """
    Scrapes HLTV for recent matches matching the filters, downloads the demo
    files into the configured demo directory, then triggers the analysis pipeline.

    Runs as a detached asyncio task so it survives across HTTP responses but
    cannot be started twice concurrently.
    """
    if _ingest_state["running"]:
        raise HTTPException(
            status_code=409,
            detail=f"An ingest is already in progress: {_ingest_state['phase']} — {_ingest_state['message']}",
        )

    _ingest_state["run_id"] += 1
    run_id = _ingest_state["run_id"]
    asyncio.create_task(
        _run_hltv_ingest(
            team_name=req.team_name,
            event_name=req.event_name,
            map_name=req.map_name,
            limit=req.limit,
            run_id=run_id,
        )
    )
    return {
        "status": "queued",
        "run_id": run_id,
        "message": f"Fetching up to {req.limit} matches from HLTV. Check logs for progress.",
    }


@app.post(
    "/api/ingest/run",
    summary="Re-run the analysis pipeline on existing demos",
)
async def run_pipeline(req: RunPipelineRequest):
    """
    Triggers the parse → cluster → rank pipeline on all .dem files already
    in the demo directory. Useful after adding demos manually.
    """
    if _ingest_state["running"]:
        raise HTTPException(
            status_code=409,
            detail=f"An ingest is already in progress: {_ingest_state['phase']} — {_ingest_state['message']}",
        )

    _ingest_state["run_id"] += 1
    run_id = _ingest_state["run_id"]
    asyncio.create_task(
        _run_pipeline_task(
            map_name=req.map_name,
            grenade_types=req.grenade_types,
            clear_existing=req.clear_existing,
            run_id=run_id,
        )
    )
    return {
        "status": "queued",
        "run_id": run_id,
        "message": "Pipeline started in background.",
    }


@app.get("/api/ingest/status", response_model=IngestionStatusResponse)
async def ingest_status():
    """Returns the number of demos on disk and total grenades in the DB."""
    demo_dir = settings.demo_dir
    total_demos = len(list(demo_dir.glob("*.dem"))) if demo_dir.exists() else 0
    stats = _pipeline.get_stats()
    status = (
        f"{_ingest_state['phase']}: {_ingest_state['message']}"
        if _ingest_state["running"]
        else "ready"
    )
    return IngestionStatusResponse(
        total_demos=total_demos,
        total_grenades=stats.get("total_lineups", 0),
        status=status,
        run_id=_ingest_state["run_id"],
        last_completed_run_id=_ingest_state["last_completed_run_id"],
    )


# ---------------------------------------------------------------------------
# Background task implementations
# ---------------------------------------------------------------------------

def _set_phase(phase: str, message: str = "") -> None:
    _ingest_state["phase"] = phase
    _ingest_state["message"] = message
    logger.info("[ingest] %s — %s", phase, message)


async def _run_hltv_ingest(
    *,
    team_name: Optional[str],
    event_name: Optional[str],
    map_name: Optional[str],
    limit: int,
    run_id: int,
) -> None:
    async with _ingest_lock:
        _ingest_state["running"] = True
        try:
            from backend.ingestion.hltv_scraper import HLTVScraper

            scraper = HLTVScraper()
            demo_dir = settings.demo_dir
            demo_dir.mkdir(parents=True, exist_ok=True)

            _set_phase(
                "scraping",
                f"team={team_name} event={event_name} map={map_name} limit={limit}",
            )

            # Build a set of match IDs already cached on disk for the
            # requested map so the scraper scrolls past them and returns
            # `limit` brand-new matches per click. Without this, every
            # ingest just re-surfaces the same couple of cached demos and
            # looks like nothing happened.
            #
            # We don't trust filenames alone — older buggy downloads saved
            # the wrong map under a `*_mirage.dem` suffix. Probe each
            # candidate's header; if it lies, delete it and let the
            # scraper re-download that match ID fresh.
            cached_ids: set[int] = set()
            if map_name:
                from backend.ingestion.hltv_scraper import (
                    _normalize_map,
                    _probe_dem_map,
                )
                token = _normalize_map(map_name)
                stale: list[Path] = []
                for p in demo_dir.glob(f"*_{token}.dem"):
                    actual = _probe_dem_map(p)
                    actual_token = _normalize_map(actual) if actual else None
                    if actual_token and actual_token != token:
                        logger.warning(
                            "[ingest] stale cache: %s is actually %s — deleting",
                            p.name, actual,
                        )
                        stale.append(p)
                        continue
                    try:
                        cached_ids.add(int(p.stem.split("_")[0]))
                    except ValueError:
                        pass
                for p in stale:
                    try:
                        p.unlink()
                    except Exception as exc:
                        logger.warning(
                            "[ingest] could not delete stale %s: %s", p.name, exc
                        )
            if cached_ids:
                logger.info(
                    "[ingest] skipping %d already-cached matches for %s: %s",
                    len(cached_ids), map_name, sorted(cached_ids),
                )

            loop = asyncio.get_event_loop()
            matches = await loop.run_in_executor(
                None,
                lambda: scraper.get_matches(
                    team_name=team_name,
                    event_name=event_name,
                    map_name=map_name,
                    limit=limit,
                    skip_match_ids=cached_ids,
                ),
            )
            _set_phase("downloading", f"{len(matches)} new matches found")

            for i, match in enumerate(matches, 1):
                _set_phase(
                    "downloading",
                    f"{i}/{len(matches)} — {match.team1} vs {match.team2}",
                )
                try:
                    await loop.run_in_executor(
                        None,
                        lambda m=match: scraper.download_demo(
                            m, demo_dir, prefer_map=map_name
                        ),
                    )
                except Exception as exc:
                    logger.error("Download failed for %d: %s", match.match_id, exc)

            # If the user requested a team filter, read the roster sidecars
            # written during download and build the set of player names to
            # keep. We match any roster whose team name contains team_name
            # (case-insensitive) — covers abbreviations like "NAVI" vs
            # "Natus Vincere" reasonably well.
            player_names: Optional[set[str]] = None
            if team_name:
                collected: set[str] = set()
                needle = team_name.lower()
                for roster_path in sorted(demo_dir.glob("*.roster.json")):
                    try:
                        data = json.loads(roster_path.read_text(encoding="utf-8"))
                    except Exception as exc:
                        logger.warning("Could not read roster %s: %s", roster_path, exc)
                        continue
                    for side in ("team1", "team2"):
                        team = data.get(side) or {}
                        name = str(team.get("name", ""))
                        if needle in name.lower():
                            for p in team.get("players", []) or []:
                                if p:
                                    collected.add(str(p))
                if collected:
                    player_names = collected
                    logger.info(
                        "[ingest] team filter — %d players matched '%s': %s",
                        len(collected), team_name, sorted(collected),
                    )
                else:
                    logger.warning(
                        "[ingest] team filter '%s' matched no roster sidecar — "
                        "keeping all throws", team_name,
                    )

            _set_phase("analysing", "running pipeline on downloaded demos")
            await loop.run_in_executor(
                None,
                lambda: _pipeline.run(
                    demo_dir=demo_dir,
                    map_name=map_name,
                    clear_existing=True,
                    player_names=player_names,
                ),
            )

            _set_phase("done", "HLTV ingest + analysis complete")
        except Exception as exc:
            logger.exception("Ingest failed: %s", exc)
            _set_phase("error", str(exc))
        finally:
            _ingest_state["running"] = False
            _ingest_state["last_completed_run_id"] = run_id


async def _run_pipeline_task(
    *,
    map_name: Optional[str],
    grenade_types: Optional[List[str]],
    clear_existing: bool,
    run_id: int,
) -> None:
    async with _ingest_lock:
        _ingest_state["running"] = True
        try:
            _set_phase("analysing", f"map={map_name} types={grenade_types}")
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: _pipeline.run(
                    demo_dir=settings.demo_dir,
                    map_name=map_name,
                    grenade_types=grenade_types,
                    clear_existing=clear_existing,
                ),
            )
            _set_phase("done", "pipeline complete")
        except Exception as exc:
            logger.exception("Pipeline failed: %s", exc)
            _set_phase("error", str(exc))
        finally:
            _ingest_state["running"] = False
            _ingest_state["last_completed_run_id"] = run_id
