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
POST /api/match-replay/upload                          Upload a .dem file
DELETE /api/match-replay/{demo_file}                   Delete a demo + cache
GET  /api/health                                       Health check
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

import httpx

from fastapi import FastAPI, HTTPException, Query, UploadFile
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
    DemoListEntry,
    MatchTimeline,
    MatchInsightsResponse,
    ExecuteCombo,
    LineupDescriptionResponse,
    PlayerProfileSummary,
    PlayerProfileDetail,
    PlayerStatsRefreshResponse,
)
from backend.analysis.metrics import MetricsPipeline
from backend.analysis.player_stats import PlayerStatsStore
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
_player_stats = PlayerStatsStore()
_rcon = RCONBridge()


# ---------------------------------------------------------------------------
# LLM helper — uses Anthropic if configured, otherwise OpenRouter free models
# ---------------------------------------------------------------------------

async def _llm_complete(prompt: str, max_tokens: int = 1500) -> str:
    """Send a prompt to the configured LLM and return the text response."""

    # Try Anthropic first (if key is set)
    if settings.anthropic_api_key:
        try:
            from anthropic import Anthropic
        except ImportError:
            raise HTTPException(
                status_code=503,
                detail="anthropic SDK not installed. Run: pip install anthropic",
            )
        client = Anthropic(api_key=settings.anthropic_api_key)
        message = await asyncio.to_thread(
            client.messages.create,
            model=settings.anthropic_model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        parts: list[str] = []
        for block in getattr(message, "content", []) or []:
            text = getattr(block, "text", None)
            if text:
                parts.append(text)
        return "\n\n".join(parts).strip() or "(empty response)"

    # Fall back to OpenRouter (free models)
    if settings.openrouter_api_key:
        headers = {
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "CS2 Meta Engine",
        }
        body = {
            "model": settings.openrouter_model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        for attempt in range(5):
            async with httpx.AsyncClient(timeout=90) as client:
                resp = await client.post(
                    f"{settings.openrouter_base_url}/chat/completions",
                    headers=headers,
                    json=body,
                )
                if resp.status_code == 429:
                    delay = 5 * (attempt + 1)  # 5s, 10s, 15s, 20s, 25s
                    logger.info("OpenRouter 429, retrying in %ds (attempt %d/5)", delay, attempt + 1)
                    await asyncio.sleep(delay)
                    continue
                resp.raise_for_status()
                data = resp.json()
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "").strip() or "(empty response)"
                return "(empty response)"
        raise HTTPException(
            status_code=429,
            detail="OpenRouter free-tier rate limit — wait ~30s and try again.",
        )

    raise HTTPException(
        status_code=503,
        detail="No AI API key configured. Set OPENROUTER_API_KEY (free) or ANTHROPIC_API_KEY in your .env file.",
    )


def _get_ai_model_name() -> str:
    """Return the model name currently in use."""
    if settings.anthropic_api_key:
        return settings.anthropic_model
    if settings.openrouter_api_key:
        return settings.openrouter_model
    return "none"

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
    # Populated when a FACEIT download falls back to manual — frontend reads
    # this from /api/ingest/status and opens the URL in a new tab.
    "manual_url": None,
    # Per-run progress counters surfaced in /api/ingest/status so the UI
    # doesn't look grenade-only — every HLTV/FACEIT ingest also parses
    # full timelines and updates per-player aggregate rows.
    "demos_parsed_this_run": 0,
    "demos_total_this_run": 0,
    "player_rows_updated_this_run": 0,
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


# Re-export FACEIT schemas for the endpoints below
from backend.models.schemas import (  # noqa: E402
    FaceitIngestRequest,
    FaceitMatchListRequest,
    FaceitMatchListResponse,
)


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
    side: Optional[str] = Query(None, pattern="^(T|CT)$"),
):
    """
    Returns the top `limit` ranked grenade lineups for the given map and type.

    - **map_name**: e.g. `de_mirage`, `de_dust2`
    - **grenade_type**: `smokegrenade`, `hegrenade`, `flashbang`, `molotov`
    - **limit**: number of results (1–2000, default 10)
    - **side**: optional T or CT filter
    """
    lineups = _pipeline.get_top_lineups(
        map_name=map_name,
        grenade_type=grenade_type,
        limit=limit,
        side=side,
    )

    return TopLineupsResponse(
        map_name=map_name,
        grenade_type=grenade_type,
        lineups=lineups or [],
        total_clusters=len(lineups) if lineups else 0,
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
        return []

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
# Demo replay endpoint
# ---------------------------------------------------------------------------

@app.get(
    "/api/replay/{cluster_id}",
    summary="Get playdemo + demo_goto console strings for a lineup",
)
async def get_replay_string(
    cluster_id: int,
    map_name: str = Query(..., description="e.g. de_mirage"),
    player: Optional[str] = Query(
        None,
        description="When set, override demo pointer + spec_player to this player if present in top_throwers",
    ),
):
    """
    Return the two console strings needed to watch a lineup in-game.

    We return them SPLIT instead of chained because `playdemo X; demo_goto N`
    in a single console paste races CS2's async demo loader: the seek fires
    before the demo finishes loading and gets silently dropped, so playback
    starts at tick 0. Handing the user two separate strings (load first,
    then seek once the viewer is up) eliminates the race entirely.

    When `player` is set (the dashboard's player filter), we look that
    player up in the cluster's top_throwers list. If found AND that player
    has a per-thrower demo pointer stored, we switch to their demo/tick —
    so filtering to "zywoo" seeks to a real zywoo throw, not some medoid
    teammate's. If the player is in top_throwers but without a pointer
    (pre-migration rows) we keep the cluster medoid tick but still
    override spec_player to their name so the camera at least locks to
    them. If the player isn't in top_throwers at all we do the same —
    spec-only override.

    Returns 404 when the cluster doesn't exist or when the medoid pointer
    wasn't persisted (pre-migration rows — re-run the pipeline to refresh).
    """
    cluster = _pipeline.get_cluster_by_id(cluster_id, map_name)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    if not cluster.demo_file or cluster.demo_tick is None:
        raise HTTPException(
            status_code=404,
            detail="No demo pointer stored for this cluster — re-run the pipeline.",
        )

    demo_file = cluster.demo_file
    demo_tick = cluster.demo_tick
    thrower_name = cluster.demo_thrower_name

    if player:
        needle = player.strip().lower()
        match = next(
            (
                t
                for t in (cluster.top_throwers or [])
                if t.name and t.name.lower() == needle
            ),
            None,
        )
        if match:
            if match.demo_file and match.demo_tick is not None:
                demo_file = match.demo_file
                demo_tick = match.demo_tick
            thrower_name = match.name
        else:
            thrower_name = player.strip() or thrower_name

    lead_in_tick = max(0, demo_tick - 320)
    # When the demos→CS2 junction is active, prefix the path so CS2 finds
    # the file at game/csgo/<link_name>/<demo>.dem
    link_active, _ = _is_demo_link_active()
    if link_active:
        load_string = f"playdemo {settings.cs2_demo_link_name}/{demo_file}"
    else:
        load_string = f"playdemo {demo_file}"
    # CS2 demo playback ignores spec_player "name" but reliably accepts
    # numeric 1-based slot indices (spec_player 1 through spec_player 10).
    # We resolve the thrower's name to their slot via entity_id ordering
    # from parse_ticks — same approach as CS2DemoVoices.
    seek_parts = [f"demo_goto {lead_in_tick} 0 1"]
    if thrower_name and demo_file:
        slots = _get_player_slots(demo_file)
        slot = slots.get(thrower_name.strip().lower())
        if slot is not None:
            seek_parts.append(f"spec_player {slot}")
    seek_string = "; ".join(seek_parts)
    return {
        "cluster_id": cluster_id,
        "map_name": map_name,
        "demo_file": demo_file,
        "demo_tick": demo_tick,
        "demo_thrower_name": thrower_name,
        "load_string": load_string,
        "seek_string": seek_string,
        "console_string": f"{load_string}; {seek_string}",
    }


# ---------------------------------------------------------------------------
# Player slot lookup (spec_player needs numeric index, not name)
# ---------------------------------------------------------------------------
# CS2 demo playback ignores `spec_player "name"` but reliably accepts numeric
# 1-based slot indices (`spec_player 1` through `spec_player 10`). The slot
# order is determined by sorting unique entity_ids in parse_ticks — the same
# order the CS2DemoVoices tool relies on.

_SLOT_CACHE: dict[str, dict[str, int]] = {}  # demo_file → {name_lower: slot}


def _get_player_slots(demo_file: str) -> dict[str, int]:
    """
    Return a {lowercase_name: 1-based_slot} dict for the given demo file.
    Cached so repeated calls (e.g. multiple clusters from the same demo)
    don't re-parse. Returns an empty dict if the demo can't be read.
    """
    if demo_file in _SLOT_CACHE:
        return _SLOT_CACHE[demo_file]

    demo_path = settings.demo_dir / demo_file
    if not demo_path.exists():
        _SLOT_CACHE[demo_file] = {}
        return {}

    try:
        from demoparser2 import DemoParser as _DP  # type: ignore
        parser = _DP(str(demo_path))
        df = parser.parse_ticks(["entity_id", "team_num"], ticks=[5000])
    except Exception as exc:
        logger.warning("slot lookup failed for %s: %s", demo_file, exc)
        _SLOT_CACHE[demo_file] = {}
        return {}

    if df is None or len(df) == 0:
        _SLOT_CACHE[demo_file] = {}
        return {}

    # Unique players sorted by entity_id → slot 1, 2, … 10.
    unique = (
        df.drop_duplicates("steamid")[["entity_id", "name", "team_num"]]
        .sort_values("entity_id")
        .reset_index(drop=True)
    )
    # Only keep real players (team_num 2=T or 3=CT).
    unique = unique[unique["team_num"].isin([2, 3])]
    mapping: dict[str, int] = {}
    for slot_1based, (_, row) in enumerate(unique.iterrows(), start=1):
        name = str(row.get("name", "")).strip().lower()
        if name:
            mapping[name] = slot_1based

    _SLOT_CACHE[demo_file] = mapping
    return mapping


# ---------------------------------------------------------------------------
# Match replay endpoints (full-match 2D viewer)
# ---------------------------------------------------------------------------
# Listing, timeline extraction, and Claude-generated narrative recap. Lives
# alongside the cluster-replay endpoint above but is logically separate — it
# parses every demo on demand (heavy) and caches the result to disk so the
# second open is a fast disk read.

_TIMELINE_CACHE_DIR = Path("data/timelines")
_INSIGHTS_CACHE: dict[str, MatchInsightsResponse] = {}


def _safe_demo_name(demo_file: str) -> str:
    """
    Validate that `demo_file` is a plain filename with no path components,
    so an attacker can't escape settings.demo_dir via /api/match-replay/..%2Fetc..
    Returns the bare name on success or raises HTTPException(400).
    """
    name = demo_file.strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid demo filename")
    if not name.lower().endswith(".dem"):
        raise HTTPException(status_code=400, detail="Not a .dem file")
    return name


def _parse_match_id(stem: str) -> Optional[int]:
    """HLTV scraper writes filenames like '2391769_mirage' — pull the int."""
    if "_" in stem:
        head, _, _ = stem.partition("_")
    else:
        head = stem
    try:
        return int(head)
    except ValueError:
        return None


def _load_roster(match_id: Optional[int]) -> Optional[dict]:
    """Load roster sidecar file for a match, if it exists."""
    if match_id is None:
        return None
    roster_path = settings.demo_dir / f"{match_id}.roster.json"
    if not roster_path.exists():
        return None
    try:
        return json.loads(roster_path.read_text(encoding="utf-8"))
    except Exception:
        return None


@app.get("/api/match-info/{demo_file}", summary="Match metadata from roster sidecar")
async def get_match_info(demo_file: str):
    """Return team names and rosters for a demo file, parsed from the HLTV
    roster sidecar written during scraping."""
    name = _safe_demo_name(demo_file)
    stem = Path(name).stem
    match_id = _parse_match_id(stem)
    roster = _load_roster(match_id)
    map_token = ""
    if "_" in stem:
        _, _, map_token = stem.partition("_")
        map_token = map_token.strip().lower()
    return {
        "demo_file": name,
        "match_id": match_id,
        "map_name": f"de_{map_token}" if map_token else "unknown",
        "team1": roster.get("team1") if roster else None,
        "team2": roster.get("team2") if roster else None,
        "event": roster.get("event", "") if roster else None,
        "date": roster.get("date", "") if roster else None,
    }


@app.get(
    "/api/match-replay/demos",
    response_model=List[DemoListEntry],
    summary="Flat list of every scraped .dem for the match-replay picker",
)
async def list_match_replay_demos():
    demo_dir = settings.demo_dir
    if not demo_dir.exists():
        return []

    out: list[DemoListEntry] = []
    for p in sorted(demo_dir.glob("*.dem")):
        stem = p.stem
        map_token = ""
        if "_" in stem:
            _, _, map_token = stem.partition("_")
            map_token = map_token.strip().lower()
        map_name = f"de_{map_token}" if map_token else "unknown"
        try:
            stat = p.stat()
        except OSError:
            continue
        out.append(
            DemoListEntry(
                demo_file=p.name,
                map_name=map_name,
                match_id=_parse_match_id(stem),
                size_bytes=int(stat.st_size),
                mtime=float(stat.st_mtime),
            )
        )
    out.sort(key=lambda d: d.mtime, reverse=True)
    return out


@app.post(
    "/api/match-replay/upload",
    summary="Upload a .dem file to the demo directory",
)
async def upload_demo(file: UploadFile):
    """
    Accepts a multipart .dem upload, streams it to settings.demo_dir.
    Returns the saved filename so the frontend can open it in the viewer.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    # Sanitise: only allow plain .dem filenames
    name = file.filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    if not name.lower().endswith(".dem"):
        raise HTTPException(status_code=400, detail="Only .dem files are accepted")
    if ".." in name or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid filename")

    demo_dir = settings.demo_dir
    demo_dir.mkdir(parents=True, exist_ok=True)
    dest = demo_dir / name

    # Stream to disk in 1 MiB chunks to avoid loading 500 MB into RAM
    max_bytes = settings.max_demo_size_mb * 1024 * 1024
    written = 0
    try:
        with open(dest, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    f.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {settings.max_demo_size_mb} MB limit",
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")

    # Stat the saved file for the response
    stat = dest.stat()
    stem = dest.stem
    map_token = ""
    if "_" in stem:
        _, _, map_token = stem.partition("_")
        map_token = map_token.strip().lower()
    map_name = f"de_{map_token}" if map_token else "unknown"

    return DemoListEntry(
        demo_file=dest.name,
        map_name=map_name,
        match_id=_parse_match_id(stem),
        size_bytes=int(stat.st_size),
        mtime=float(stat.st_mtime),
    )


@app.delete(
    "/api/match-replay/{demo_file}",
    summary="Delete a demo file and its cached timeline",
)
async def delete_demo(demo_file: str):
    name = _safe_demo_name(demo_file)
    path = settings.demo_dir / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Demo not found")
    path.unlink()
    # Also remove cached timeline if any
    cache_file = _TIMELINE_CACHE_DIR / f"{name}.json"
    cache_file.unlink(missing_ok=True)
    return {"deleted": name}


@app.delete(
    "/api/match-replay/{demo_file}/timeline",
    summary="Delete cached timeline only (forces re-parse on next GET)",
)
async def delete_match_replay_timeline(demo_file: str):
    name = _safe_demo_name(demo_file)
    cache_file = _TIMELINE_CACHE_DIR / f"{name}.json"
    existed = cache_file.exists()
    cache_file.unlink(missing_ok=True)
    return {"deleted_cache": existed, "demo_file": name}


@app.get(
    "/api/match-replay/{demo_file}/timeline",
    response_model=MatchTimeline,
    summary="Parse a demo into a 2D playback timeline (cached to disk)",
)
async def get_match_replay_timeline(demo_file: str):
    name = _safe_demo_name(demo_file)
    demo_path = settings.demo_dir / name
    if not demo_path.exists():
        raise HTTPException(status_code=404, detail=f"Demo not found: {name}")

    from backend.ingestion.demo_parser import (
        extract_match_timeline,
        TIMELINE_CACHE_VERSION,
    )

    _TIMELINE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _TIMELINE_CACHE_DIR / f"{name}.json"
    if cache_path.exists():
        try:
            with cache_path.open("r", encoding="utf-8") as f:
                bundle = json.load(f)
            if int(bundle.get("cache_version", 0)) >= TIMELINE_CACHE_VERSION:
                # Opportunistic upsert — cheap, keeps player_stats fresh without
                # requiring an explicit refresh after the first view.
                try:
                    _player_stats.ingest_timeline(bundle, name)
                except Exception as exc:
                    logger.warning("player_stats upsert failed for %s: %s", name, exc)
                return MatchTimeline.model_validate(bundle)
            logger.info(
                "Cached timeline %s is stale (v%s < v%s) — re-parsing",
                cache_path.name, bundle.get("cache_version", 0), TIMELINE_CACHE_VERSION,
            )
        except Exception as exc:
            logger.warning("Cached timeline %s unreadable, re-parsing: %s", cache_path, exc)

    # Heavy: ~5–15 s per demo. Run in a worker thread so the event loop
    # stays responsive for other requests in the meantime.

    try:
        bundle = await asyncio.to_thread(extract_match_timeline, demo_path)
    except Exception as exc:
        logger.exception("extract_match_timeline failed for %s", name)
        raise HTTPException(status_code=500, detail=f"Timeline parse failed: {exc}")

    try:
        with cache_path.open("w", encoding="utf-8") as f:
            json.dump(bundle, f, separators=(",", ":"))
    except Exception as exc:
        logger.warning("Could not cache timeline to %s: %s", cache_path, exc)

    try:
        _player_stats.ingest_timeline(bundle, name)
    except Exception as exc:
        logger.warning("player_stats upsert failed for %s: %s", name, exc)

    return MatchTimeline.model_validate(bundle)


def _build_match_digest(name: str, bundle: dict) -> str:
    """
    Collapse a full timeline into a compact text summary for the Claude
    prompt. Sending the raw JSON would cost ~800 KB of numbers Claude can't
    reason about — a few KB of round-by-round prose is plenty.
    """
    map_name = bundle.get("map_name", "unknown")
    rounds = bundle.get("rounds", []) or []
    events = bundle.get("events", []) or []
    players = bundle.get("players", []) or []
    grenades = bundle.get("grenades", []) or []

    sid_to_name = {p["steamid"]: p.get("name", p["steamid"]) for p in players}
    sid_to_team = {p["steamid"]: p.get("team_num", 0) for p in players}

    # Per-player kill / death tallies and per-round narrative.
    kills: dict[str, int] = {}
    deaths: dict[str, int] = {}
    by_tick = sorted(events, key=lambda e: e.get("tick", 0))

    round_lines: list[str] = []
    t_score = 0
    ct_score = 0
    for r in rounds:
        start, end = r.get("start_tick", 0), r.get("end_tick", 0)
        winner = r.get("winner") or "?"
        if winner == "T":
            t_score += 1
        elif winner == "CT":
            ct_score += 1

        round_kills: dict[str, int] = {}
        nades_in_round = 0
        bomb = ""
        for e in by_tick:
            tick = e.get("tick", 0)
            if tick < start or tick > end:
                continue
            if e["type"] == "death":
                a = e["data"].get("attacker", "")
                v = e["data"].get("victim", "")
                if a and a != v:
                    kills[a] = kills.get(a, 0) + 1
                    round_kills[a] = round_kills.get(a, 0) + 1
                if v:
                    deaths[v] = deaths.get(v, 0) + 1
            elif e["type"] == "bomb_plant":
                bomb = "planted"
            elif e["type"] == "bomb_defuse":
                bomb = "defused"
        for g in grenades:
            pts = g.get("points") or []
            if pts and start <= pts[0][0] <= end:
                nades_in_round += 1

        top_in_round = sorted(round_kills.items(), key=lambda kv: -kv[1])[:2]
        top_str = ", ".join(
            f"{sid_to_name.get(sid, sid)}({n})" for sid, n in top_in_round
        ) or "—"
        round_lines.append(
            f"Round {r['num']}: {winner} win"
            + (f" ({bomb})" if bomb else "")
            + f". Top: {top_str}. Nades: {nades_in_round}."
        )

    # Top fraggers across the whole match.
    top_fraggers = sorted(kills.items(), key=lambda kv: -kv[1])[:5]
    fragger_lines = [
        f"  {sid_to_name.get(sid, sid)} ({'CT' if sid_to_team.get(sid)==3 else 'T'}): "
        f"{n}K / {deaths.get(sid, 0)}D"
        for sid, n in top_fraggers
    ]

    # Roster split by team.
    t_side = [p["name"] for p in players if p.get("team_num") == 2]
    ct_side = [p["name"] for p in players if p.get("team_num") == 3]

    digest = [
        f"Match: {name}",
        f"Map: {map_name}",
        f"Final score: T {t_score} – {ct_score} CT",
        f"T side roster: {', '.join(t_side) or '—'}",
        f"CT side roster: {', '.join(ct_side) or '—'}",
        "",
        "Top fraggers:",
        *fragger_lines,
        "",
        "Round by round:",
        *round_lines,
    ]
    return "\n".join(digest)


@app.post(
    "/api/match-replay/{demo_file}/insights",
    response_model=MatchInsightsResponse,
    summary="Claude-generated narrative recap for a match",
)
async def get_match_replay_insights(demo_file: str):
    name = _safe_demo_name(demo_file)
    if name in _INSIGHTS_CACHE:
        return _INSIGHTS_CACHE[name]

    cache_path = _TIMELINE_CACHE_DIR / f"{name}.json"
    if not cache_path.exists():
        # Force a parse first so the digest builder has data.
        await get_match_replay_timeline(name)
    if not cache_path.exists():
        raise HTTPException(status_code=500, detail="Timeline cache missing after parse")

    with cache_path.open("r", encoding="utf-8") as f:
        bundle = json.load(f)

    digest = _build_match_digest(name, bundle)

    prompt = (
        "You are a CS2 post-game analyst. Below is a structured digest of a "
        "professional Counter-Strike 2 match. Write a 3–5 paragraph narrative "
        "recap aimed at a fan who didn't watch live: call out the turning "
        "points, standout players, and any interesting utility or bomb-site "
        "trends. Plain prose, no markdown headers, no bullet lists.\n\n"
        f"---\n{digest}\n---"
    )

    try:
        summary = await _llm_complete(prompt, max_tokens=1500)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("LLM call failed for %s", name)
        raise HTTPException(status_code=502, detail=f"AI error: {exc}")

    resp = MatchInsightsResponse(
        demo_file=name,
        summary=summary,
        model=_get_ai_model_name(),
    )
    _INSIGHTS_CACHE[name] = resp
    return resp


# ---------------------------------------------------------------------------
# CS2 replay integration — directory junction + path settings
# ---------------------------------------------------------------------------

_USER_SETTINGS_PATH = Path("data/user_settings.json")


def _resolve_cs2_dir() -> Optional[str]:
    """Return the active CS2 game/csgo path from user settings, env, or auto-detect."""
    # 1. User settings file (set via POST /api/settings/cs2-path)
    if _USER_SETTINGS_PATH.exists():
        try:
            data = json.loads(_USER_SETTINGS_PATH.read_text(encoding="utf-8"))
            saved = data.get("cs2_game_dir", "").strip()
            if saved and Path(saved).is_dir():
                return saved
        except Exception:
            pass

    # 2. Environment variable
    if settings.cs2_game_dir and Path(settings.cs2_game_dir).is_dir():
        return settings.cs2_game_dir

    # 3. Auto-detect from Steam registry (Windows only)
    try:
        from backend.utils.cs2_detect import detect_cs2_game_dir
        detected = detect_cs2_game_dir()
        if detected:
            return str(detected)
    except Exception:
        pass

    return None


def _is_demo_link_active() -> tuple[bool, Optional[str]]:
    """Check if the demos→CS2 junction is active. Returns (active, link_path)."""
    cs2_dir = _resolve_cs2_dir()
    if not cs2_dir:
        return False, None
    link_path = Path(cs2_dir) / settings.cs2_demo_link_name
    return link_path.exists(), str(link_path)


@app.get("/api/settings/cs2-path", summary="Get CS2 path and demo link status")
async def get_cs2_path():
    configured = settings.cs2_game_dir or None
    if _USER_SETTINGS_PATH.exists():
        try:
            data = json.loads(_USER_SETTINGS_PATH.read_text(encoding="utf-8"))
            configured = data.get("cs2_game_dir") or configured
        except Exception:
            pass

    detected = None
    try:
        from backend.utils.cs2_detect import detect_cs2_game_dir
        det = detect_cs2_game_dir()
        if det:
            detected = str(det)
    except Exception:
        pass

    active_path = _resolve_cs2_dir()
    link_active, link_path = _is_demo_link_active()

    return {
        "configured_path": configured,
        "detected_path": detected,
        "active_path": active_path,
        "link_active": link_active,
        "link_path": link_path,
        "link_name": settings.cs2_demo_link_name,
    }


@app.post("/api/settings/cs2-path", summary="Save CS2 game directory path")
async def set_cs2_path(body: dict):
    path = body.get("cs2_game_dir", "").strip()
    if path and not Path(path).is_dir():
        raise HTTPException(status_code=400, detail="Directory does not exist")

    _USER_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    current: dict = {}
    if _USER_SETTINGS_PATH.exists():
        try:
            current = json.loads(_USER_SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    current["cs2_game_dir"] = path
    _USER_SETTINGS_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return {"status": "saved", "cs2_game_dir": path}


@app.post("/api/demos/link-to-cs2", summary="Create directory junction from demos to CS2 game/csgo")
async def link_demos_to_cs2():
    cs2_dir = _resolve_cs2_dir()
    if not cs2_dir:
        raise HTTPException(
            status_code=400,
            detail="CS2 game directory not configured or detected. Set it in Settings first.",
        )

    demo_dir = settings.demo_dir.resolve()
    if not demo_dir.exists():
        demo_dir.mkdir(parents=True, exist_ok=True)

    link_path = Path(cs2_dir) / settings.cs2_demo_link_name
    if link_path.exists():
        return {"status": "already_linked", "link_path": str(link_path)}

    if sys.platform == "win32":
        # mklink /J creates a junction — no admin privileges needed on NTFS
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link_path), str(demo_dir)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Junction creation failed: {result.stderr.strip()}",
            )
    else:
        try:
            os.symlink(str(demo_dir), str(link_path))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Symlink creation failed: {exc}")

    logger.info("Created demo junction: %s → %s", link_path, demo_dir)
    return {"status": "linked", "link_path": str(link_path)}


@app.delete("/api/demos/link-to-cs2", summary="Remove the demos→CS2 directory junction")
async def unlink_demos_from_cs2():
    cs2_dir = _resolve_cs2_dir()
    if not cs2_dir:
        raise HTTPException(status_code=400, detail="CS2 directory not configured")

    link_path = Path(cs2_dir) / settings.cs2_demo_link_name
    if not link_path.exists():
        return {"status": "not_linked"}

    try:
        # os.rmdir removes junctions/symlinks without deleting the target contents
        os.rmdir(str(link_path))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unlink failed: {exc}")

    logger.info("Removed demo junction: %s", link_path)
    return {"status": "unlinked"}


# ---------------------------------------------------------------------------
# Execute detection endpoint
# ---------------------------------------------------------------------------

@app.get(
    "/api/executes/{map_name}",
    response_model=List[ExecuteCombo],
    summary="Detected coordinated utility combos for a map",
)
async def get_executes(map_name: str):
    """
    Returns recurring coordinated utility patterns detected across rounds.
    Each combo represents a set of lineup clusters that pros frequently
    throw together in the same round (e.g. a B site execute with 2 smokes
    + 1 flash + 1 molotov).
    """
    return _pipeline.get_executes(map_name=map_name)


# ---------------------------------------------------------------------------
# AI lineup description endpoint
# ---------------------------------------------------------------------------

_DESCRIPTION_CACHE: dict[str, str] = {}  # "cluster_id:map_name" → description


@app.post(
    "/api/lineups/{cluster_id}/describe",
    response_model=LineupDescriptionResponse,
    summary="Generate an AI description for a lineup cluster",
)
async def describe_lineup(
    cluster_id: int,
    map_name: str = Query(..., description="e.g. de_mirage"),
):
    """
    Uses Claude to generate a concise natural-language description of what
    a lineup does and why it's effective. Cached per cluster so repeated
    clicks are free.
    """
    cache_key = f"{cluster_id}:{map_name}"
    if cache_key in _DESCRIPTION_CACHE:
        return LineupDescriptionResponse(
            cluster_id=cluster_id,
            map_name=map_name,
            description=_DESCRIPTION_CACHE[cache_key],
            model=_get_ai_model_name(),
        )

    cluster = _pipeline.get_cluster_by_id(cluster_id, map_name)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    throwers = ", ".join(t.name for t in (cluster.top_throwers or []) if t.name) or "unknown"
    prompt = (
        "You are a CS2 utility analyst writing for a player guide. "
        "Describe this grenade lineup in 1–2 sentences: what it blocks or "
        "clears, why it's effective, and when a team would use it. "
        "Be specific about CS2 map geometry.\n\n"
        f"Map: {cluster.map_name}\n"
        f"Type: {cluster.grenade_type}\n"
        f"Label: {cluster.label}\n"
        f"Thrown from: ({cluster.throw_centroid_x:.0f}, {cluster.throw_centroid_y:.0f})\n"
        f"Lands at: ({cluster.land_centroid_x:.0f}, {cluster.land_centroid_y:.0f})\n"
        f"Technique: {cluster.primary_technique or 'unknown'}\n"
        f"Click: {cluster.primary_click or 'unknown'}\n"
        f"Side: {cluster.side or 'unknown'}\n"
        f"Win rate: {cluster.round_win_rate * 100:.1f}%\n"
        f"Throw count: {cluster.throw_count}\n"
        f"Avg utility damage: {cluster.avg_utility_damage:.1f}\n"
        f"Top throwers: {throwers}"
    )

    try:
        description = await _llm_complete(prompt, max_tokens=300)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("LLM call failed for cluster %d", cluster_id)
        raise HTTPException(status_code=502, detail=f"AI error: {exc}")
    _DESCRIPTION_CACHE[cache_key] = description

    return LineupDescriptionResponse(
        cluster_id=cluster_id,
        map_name=map_name,
        description=description,
        model=_get_ai_model_name(),
    )


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
    try:
        total_player_rows = len(_player_stats.list_summaries())
    except Exception:
        total_player_rows = 0
    return IngestionStatusResponse(
        total_demos=total_demos,
        total_grenades=stats.get("total_lineups", 0),
        status=status,
        run_id=_ingest_state["run_id"],
        last_completed_run_id=_ingest_state["last_completed_run_id"],
        manual_url=_ingest_state.get("manual_url"),
        demos_parsed_this_run=_ingest_state.get("demos_parsed_this_run", 0),
        demos_total_this_run=_ingest_state.get("demos_total_this_run", 0),
        player_rows_updated_this_run=_ingest_state.get("player_rows_updated_this_run", 0),
        total_player_rows=total_player_rows,
    )


# ---------------------------------------------------------------------------
# FACEIT endpoints
# ---------------------------------------------------------------------------

@app.post(
    "/api/ingest/faceit/matches",
    response_model=FaceitMatchListResponse,
    summary="List a FACEIT player's recent CS2 matches",
)
async def faceit_list_matches(req: FaceitMatchListRequest):
    """Given a FACEIT profile URL, returns up to `limit` recent matches (CS2)."""
    from backend.ingestion.faceit_scraper import FaceitScraper, FaceitScraperError

    try:
        scraper = FaceitScraper()
    except FaceitScraperError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    loop = asyncio.get_event_loop()
    try:
        player, matches = await loop.run_in_executor(
            None, lambda: scraper.list_matches(req.faceit_url, limit=req.limit),
        )
    except FaceitScraperError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("FACEIT match list failed")
        raise HTTPException(status_code=502, detail=f"FACEIT API error: {exc}")

    return FaceitMatchListResponse(
        player_nickname=str(player.get("nickname") or ""),
        player_id=str(player.get("player_id") or ""),
        matches=matches,
    )


@app.post(
    "/api/ingest/faceit/download",
    summary="Download a FACEIT match demo and run the pipeline",
)
async def faceit_download(req: FaceitIngestRequest):
    if _ingest_state["running"]:
        raise HTTPException(
            status_code=409,
            detail=f"An ingest is already in progress: {_ingest_state['phase']} — {_ingest_state['message']}",
        )

    _ingest_state["run_id"] += 1
    _ingest_state["manual_url"] = None
    run_id = _ingest_state["run_id"]
    asyncio.create_task(
        _run_faceit_ingest(match_id=req.match_id, run_id=run_id)
    )
    return {
        "status": "queued",
        "run_id": run_id,
        "message": f"Fetching FACEIT match {req.match_id}.",
    }


# ---------------------------------------------------------------------------
# Background task implementations
# ---------------------------------------------------------------------------

def _set_phase(phase: str, message: str = "") -> None:
    _ingest_state["phase"] = phase
    _ingest_state["message"] = message
    logger.info("[ingest] %s — %s", phase, message)


def _reset_ingest_progress(total: int = 0) -> None:
    """Zero per-run counters at the start of a new ingest task."""
    _ingest_state["demos_parsed_this_run"] = 0
    _ingest_state["demos_total_this_run"] = total
    _ingest_state["player_rows_updated_this_run"] = 0


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
        _reset_ingest_progress(total=limit)
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
            _ingest_state["demos_total_this_run"] = len(matches)

            for i, match in enumerate(matches, 1):
                _set_phase(
                    "downloading",
                    f"{i}/{len(matches)} — {match.team1} vs {match.team2}",
                )
                try:
                    saved_path = await loop.run_in_executor(
                        None,
                        lambda m=match: scraper.download_demo(
                            m, demo_dir, prefer_map=map_name
                        ),
                    )
                except Exception as exc:
                    logger.error("Download failed for %d: %s", match.match_id, exc)
                    continue

                # Parse the timeline + populate player_stats immediately so the
                # Players page is fresh without requiring a manual refresh or
                # opening each demo in the replay viewer.
                if isinstance(saved_path, Path) and saved_path.exists():
                    _set_phase(
                        "parsing-timeline",
                        f"{i}/{len(matches)} — {saved_path.name}",
                    )
                    await loop.run_in_executor(
                        None, lambda p=saved_path: _ensure_timeline_for_demo(p),
                    )

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


async def _run_faceit_ingest(*, match_id: str, run_id: int) -> None:
    """
    Resolve a FACEIT match → attempt direct demo download → pipeline.

    If the direct download fails (pending Downloads API approval), the raw
    signed URL is stashed in _ingest_state["manual_url"] so the frontend can
    prompt the user to download it via their logged-in browser session.
    """
    async with _ingest_lock:
        _ingest_state["running"] = True
        _ingest_state["manual_url"] = None
        _reset_ingest_progress(total=1)
        try:
            from backend.ingestion.faceit_scraper import (
                FaceitScraper,
                FaceitScraperError,
            )

            scraper = FaceitScraper()
            demo_dir = settings.demo_dir
            demo_dir.mkdir(parents=True, exist_ok=True)

            _set_phase("resolving", f"fetching match {match_id}")
            loop = asyncio.get_event_loop()
            demo_url, map_token = await loop.run_in_executor(
                None, lambda: scraper.resolve_demo(match_id)
            )

            map_suffix = (map_token or "unknown").replace("de_", "")
            dest = demo_dir / f"faceit_{match_id}_{map_suffix}.dem"

            if dest.exists():
                _set_phase("analysing", f"{dest.name} already present")
            else:
                _set_phase("downloading", f"{match_id} ({map_suffix})")
                ok = await loop.run_in_executor(
                    None, lambda: scraper.try_download_demo(demo_url, dest)
                )
                if not ok:
                    _ingest_state["manual_url"] = demo_url
                    _set_phase(
                        "manual",
                        "Direct download blocked — open the URL in a new tab, "
                        "then drag the .dem.gz into /replay to upload.",
                    )
                    return

            _set_phase("analysing", f"running pipeline on {dest.name}")
            await loop.run_in_executor(
                None,
                lambda: _pipeline.run(
                    demo_dir=demo_dir,
                    map_name=map_token,
                    clear_existing=False,
                ),
            )

            # Parse timeline + populate player_stats so the Players page is
            # immediately fresh.
            _set_phase("parsing-timeline", dest.name)
            await loop.run_in_executor(
                None, lambda: _ensure_timeline_for_demo(dest),
            )

            _set_phase("done", "FACEIT ingest + analysis complete")
        except FaceitScraperError as exc:
            logger.warning("FACEIT ingest failed: %s", exc)
            _set_phase("error", str(exc))
        except Exception as exc:
            logger.exception("FACEIT ingest crashed")
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
        _reset_ingest_progress()
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


# ---------------------------------------------------------------------------
# Player profiles — cross-demo aggregation
# ---------------------------------------------------------------------------

def _safe_div(num: float, den: float) -> float:
    return float(num) / float(den) if den else 0.0


def _infer_role(row: dict) -> str:
    kills = row.get("kills") or 0
    rounds = row.get("rounds_played") or 0
    awp = row.get("awp_kills") or 0
    open_k = row.get("opening_kills") or 0
    util = (row.get("smokes_thrown") or 0) + (row.get("flashes_thrown") or 0)
    alive = row.get("rounds_alive") or 0

    if kills and awp / kills > 0.35:
        return "AWP"
    if rounds and open_k / rounds > 0.15:
        return "Entry"
    if rounds and util / rounds > 0.8:
        return "Support"
    if rounds and alive / rounds > 0.55:
        return "Lurker"
    return "Rifler"


def _to_summary(row: dict) -> dict:
    kills = row.get("kills") or 0
    deaths = row.get("deaths") or 0
    rounds = row.get("rounds_played") or 0
    hs = row.get("hs_kills") or 0
    open_k = row.get("opening_kills") or 0
    open_d = row.get("opening_deaths") or 0
    alive = row.get("rounds_alive") or 0

    kd = _safe_div(kills, max(deaths, 1))
    hs_pct = _safe_div(hs, kills)
    open_wr = _safe_div(open_k, open_k + open_d)
    surv = _safe_div(alive, rounds)

    rating = (
        0.5 * _safe_div(kills, rounds)
        + 0.3 * surv
        + 0.15 * hs_pct
        + 0.15 * open_wr
    )

    return {
        "steamid": row["steamid"],
        "name": row.get("name") or row["steamid"],
        "matches": row.get("matches") or 0,
        "rounds_played": rounds,
        "kills": kills,
        "deaths": deaths,
        "hs_kills": hs,
        "opening_kills": open_k,
        "opening_deaths": open_d,
        "rounds_alive": alive,
        "awp_kills": row.get("awp_kills") or 0,
        "smokes_thrown": row.get("smokes_thrown") or 0,
        "flashes_thrown": row.get("flashes_thrown") or 0,
        "hes_thrown": row.get("hes_thrown") or 0,
        "molos_thrown": row.get("molos_thrown") or 0,
        "multi_2k": row.get("multi_2k") or 0,
        "multi_3k": row.get("multi_3k") or 0,
        "multi_4k": row.get("multi_4k") or 0,
        "multi_5k": row.get("multi_5k") or 0,
        "kd_ratio": round(kd, 3),
        "hs_pct": round(hs_pct, 3),
        "opening_wr": round(open_wr, 3),
        "survival_rate": round(surv, 3),
        "rating": round(rating, 3),
        "role": _infer_role(row),
    }


@app.get(
    "/api/players",
    response_model=List[PlayerProfileSummary],
    summary="List all players with cross-demo aggregated stats",
)
async def list_players(min_matches: int = Query(1, ge=1)):
    rows = _player_stats.list_summaries()
    summaries = [_to_summary(r) for r in rows]
    summaries = [s for s in summaries if s["matches"] >= min_matches]
    summaries.sort(key=lambda s: s["rating"], reverse=True)
    return summaries


@app.get(
    "/api/players/{steamid}",
    response_model=PlayerProfileDetail,
    summary="Full profile for a single player",
)
async def get_player_detail(steamid: str):
    detail = _player_stats.get_detail(steamid)
    if not detail:
        raise HTTPException(status_code=404, detail=f"Player not found: {steamid}")

    totals = detail["totals"] or {}
    totals["matches"] = totals.get("matches") or 0
    totals["name"] = detail["name"]
    totals["steamid"] = detail["steamid"]
    summary = _to_summary(totals)

    return {
        "steamid": detail["steamid"],
        "name": detail["name"],
        "summary": summary,
        "per_side": detail["per_side"],
        "per_map": detail["per_map"],
        "demos": detail["demos"],
    }


def _ensure_timeline_for_demo(demo_path: Path) -> bool:
    """
    Parse a single demo's timeline, cache it, and upsert player_stats rows.
    Returns True if parsing happened, False if cache was reused or on failure.
    Heavy: 5-15s per demo.

    Cache invalidation: a stale cache (missing `cache_version` or older than
    `TIMELINE_CACHE_VERSION`) is treated as absent and silently re-parsed.
    Without this, parser upgrades that add new fields (damage_total, hurt
    events, etc.) would never reach demos parsed before the upgrade.
    """
    from backend.ingestion.demo_parser import (
        extract_match_timeline,
        TIMELINE_CACHE_VERSION,
    )

    _TIMELINE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _TIMELINE_CACHE_DIR / f"{demo_path.name}.json"
    if cache_path.exists():
        try:
            with cache_path.open("r", encoding="utf-8") as f:
                cached = json.load(f)
            if int(cached.get("cache_version", 0)) >= TIMELINE_CACHE_VERSION:
                return False
            logger.info(
                "[player_stats] stale cache (v%s < v%s) — re-parsing %s",
                cached.get("cache_version", 0), TIMELINE_CACHE_VERSION,
                demo_path.name,
            )
        except Exception as exc:
            logger.warning(
                "[player_stats] cache unreadable, re-parsing %s: %s",
                demo_path.name, exc,
            )
    try:
        logger.info("[player_stats] parsing %s", demo_path.name)
        bundle = extract_match_timeline(demo_path)
        with cache_path.open("w", encoding="utf-8") as f:
            json.dump(bundle, f, separators=(",", ":"))
        _ingest_state["demos_parsed_this_run"] += 1
        try:
            _player_stats.ingest_timeline(bundle, demo_path.name)
            # Each timeline updates one row per player on the roster (~10).
            roster_size = len(bundle.get("players", []) or [])
            _ingest_state["player_rows_updated_this_run"] += roster_size
        except Exception as exc:
            logger.warning("[player_stats] upsert failed for %s: %s", demo_path.name, exc)
        return True
    except Exception as exc:
        logger.exception("[player_stats] parse failed for %s: %s", demo_path.name, exc)
        return False


def _parse_missing_timelines(demos_dir: Path) -> int:
    """
    Parse any .dem in `demos_dir` whose timeline isn't yet cached. Returns
    the number of newly-parsed demos. Called from /api/players/refresh so a
    single click backfills everything.
    """
    all_demos = sorted(demos_dir.glob("*.dem"))
    missing = [
        d for d in all_demos
        if not (_TIMELINE_CACHE_DIR / f"{d.name}.json").exists()
    ]
    total = len(missing)
    already = len(all_demos) - total
    logger.info(
        "[player_stats] %d demos, %d cached, %d to parse",
        len(all_demos), already, total,
    )

    parsed = 0
    for i, dem in enumerate(missing, 1):
        logger.info("[player_stats] parsing %d/%d — %s", i, total, dem.name)
        _set_phase("parsing-timeline", f"{i}/{total} — {dem.name}")
        if _ensure_timeline_for_demo(dem):
            parsed += 1
    return parsed


@app.post(
    "/api/players/refresh",
    response_model=PlayerStatsRefreshResponse,
    summary="Parse any missing demos, then rescan cached timelines and rebuild player_stats rows",
)
async def refresh_player_stats():
    # 1) Parse any uncached .dem files in the demos dir so the user doesn't
    #    have to open each demo manually in the replay viewer first.
    parsed = await asyncio.to_thread(
        _parse_missing_timelines, settings.demo_dir,
    )
    if parsed:
        logger.info("[player_stats] parsed %d missing timelines", parsed)

    # 2) Aggregate every cached timeline into player_stats rows.
    result = await asyncio.to_thread(
        _player_stats.refresh_from_cache, _TIMELINE_CACHE_DIR,
    )
    return result
