"""
Compare a player's own grenade throws against the pro lineup database.

GET /api/compare/{demo_file}?steamid=<id>

The demo's throws are parsed with the same `DemoParser.parse_demo` the
lineup pipeline uses (~5–15s), in a worker thread, and cached as JSON under
`<data>/compare/{demo}.json` keyed on the file's size + mtime. Matching
against `lineup_clusters` runs on every request so newly ingested pro
lineups show up without re-parsing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.analysis.compare import compare_throw, find_best_lineup
from backend.config import settings
from backend.db import connect

logger = logging.getLogger(__name__)

router = APIRouter()

# Bump when the cached throw-row shape changes.
_CACHE_VERSION = 1

_THROW_FIELDS = (
    "tick", "round_number", "thrower_steamid", "thrower_name", "team_num",
    "grenade_type", "throw_x", "throw_y", "throw_z",
    "land_x", "land_y", "land_z", "pitch", "yaw",
    "throw_technique", "click_type",
)

# One parse at a time per demo — concurrent requests wait for the first.
_parse_locks: Dict[str, asyncio.Lock] = {}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CompareMatch(BaseModel):
    lineup_id: Optional[int] = None
    label: str
    side: Optional[str] = None
    throw_count: int = 0
    round_win_rate: Optional[float] = None
    technique: Optional[str] = None
    pro_throw_x: float
    pro_throw_y: float
    pro_throw_z: Optional[float] = None
    pro_land_x: Optional[float] = None
    pro_land_y: Optional[float] = None
    pro_land_z: Optional[float] = None
    pro_pitch: float
    pro_yaw: float
    offset_forward: float
    offset_right: float
    offset_vertical: float
    throw_distance: float
    pitch_delta: float
    yaw_delta: float
    land_distance: float
    land_along: Optional[float] = None
    land_across: Optional[float] = None
    quality: str
    summary: str


class CompareThrow(BaseModel):
    tick: int
    round_number: int
    grenade_type: str
    side: Optional[str] = None
    technique: Optional[str] = None
    throw_x: float
    throw_y: float
    throw_z: float
    land_x: Optional[float] = None
    land_y: Optional[float] = None
    land_z: Optional[float] = None
    pitch: float
    yaw: float
    matched: Optional[CompareMatch] = None
    no_match_reason: Optional[str] = None


class ComparePlayer(BaseModel):
    steamid: str
    name: str
    throws: int


class CompareResponse(BaseModel):
    demo_file: str
    map_name: str
    steamid: Optional[str] = None
    player_name: Optional[str] = None
    has_lineup_data: bool
    lineup_count: int
    message: Optional[str] = None
    players: List[ComparePlayer]
    throws: List[CompareThrow]
    matched_count: int = 0


# ---------------------------------------------------------------------------
# Parse + cache
# ---------------------------------------------------------------------------

def _cache_dir() -> Path:
    return settings.db_path.parent / "compare"


def _cache_path(name: str) -> Path:
    return _cache_dir() / f"{name}.json"


def _clean(v):
    """JSON-safe scalar: numpy → python, NaN → None."""
    if v is None:
        return None
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _parse_throws(demo_path: Path) -> dict:
    """Run the lineup pipeline's parser over one demo (blocking)."""
    from backend.ingestion.demo_parser import DemoParser

    df = DemoParser().parse_demo(demo_path)
    map_name = "unknown"
    rows: list[dict] = []
    if not df.empty:
        map_name = str(df["map_name"].iloc[0])
        cols = [c for c in _THROW_FIELDS if c in df.columns]
        for rec in df[cols].to_dict("records"):
            row = {k: _clean(rec.get(k)) for k in cols}
            sid = row.get("thrower_steamid")
            if sid is None:
                continue
            row["thrower_steamid"] = str(sid)
            rows.append(row)
    return {"map_name": map_name, "throws": rows}


def _read_cache(path: Path, key: dict) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("key") != key:
        return None
    return data


def _write_cache(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)


async def _load_throws(name: str, demo_path: Path) -> dict:
    st = demo_path.stat()
    key = {"v": _CACHE_VERSION, "size": st.st_size, "mtime": int(st.st_mtime)}
    path = _cache_path(name)
    cached = await asyncio.to_thread(_read_cache, path, key)
    if cached:
        return cached
    lock = _parse_locks.setdefault(name, asyncio.Lock())
    async with lock:
        cached = await asyncio.to_thread(_read_cache, path, key)
        if cached:
            return cached
        try:
            parsed = await asyncio.to_thread(_parse_throws, demo_path)
        except Exception as exc:  # demoparser2 raises plain Exceptions on bad files
            logger.exception("compare parse failed for %s", name)
            raise HTTPException(status_code=500, detail=f"Failed to parse demo: {exc}") from exc
        payload = {"key": key, **parsed}
        try:
            await asyncio.to_thread(_write_cache, path, payload)
        except OSError as exc:
            logger.warning("compare cache write failed for %s: %s", name, exc)
        return payload


# ---------------------------------------------------------------------------
# Lineups
# ---------------------------------------------------------------------------

_LINEUP_COLS = (
    "id, map_name, grenade_type, label, side, throw_count, round_win_rate, "
    "land_cx, land_cy, land_cz, throw_cx, throw_cy, throw_cz, avg_pitch, avg_yaw, "
    "primary_technique"
)


def _load_lineups(map_name: str) -> List[dict]:
    try:
        with connect() as conn:
            rows = conn.execute(
                f"SELECT {_LINEUP_COLS} FROM lineup_clusters WHERE map_name = ?",
                (map_name,),
            ).fetchall()
    except sqlite3.OperationalError:  # table not created yet (fresh install)
        return []
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

def _side(team_num) -> Optional[str]:
    return {2: "T", 3: "CT"}.get(int(team_num)) if team_num is not None else None


@router.get(
    "/api/compare/{demo_file}",
    response_model=CompareResponse,
    summary="Compare a player's grenade throws in a demo against pro lineups",
)
async def compare_demo(demo_file: str, steamid: Optional[str] = Query(None, max_length=32)):
    from backend.main import _safe_demo_name

    name = _safe_demo_name(demo_file)
    demo_path = settings.demo_dir / name
    if not demo_path.exists():
        raise HTTPException(status_code=404, detail=f"Demo not found: {name}")

    data = await _load_throws(name, demo_path)
    map_name: str = data.get("map_name") or "unknown"
    all_throws: List[dict] = data.get("throws") or []

    players: Dict[str, dict] = {}
    for t in all_throws:
        p = players.setdefault(
            t["thrower_steamid"],
            {"steamid": t["thrower_steamid"], "name": t.get("thrower_name") or t["thrower_steamid"], "throws": 0},
        )
        p["throws"] += 1
    player_list = sorted(players.values(), key=lambda p: p["name"].lower())

    lineups = await asyncio.to_thread(_load_lineups, map_name)
    has_data = bool(lineups)

    sid = (steamid or "").strip() or None
    mine = [t for t in all_throws if sid and t["thrower_steamid"] == sid]
    mine.sort(key=lambda t: t.get("tick") or 0)

    message: Optional[str] = None
    if not has_data:
        message = (
            f"No pro lineup data for {map_name} yet — ingest some pro demos for "
            "this map on the Lineups page, then come back."
        )
    elif sid and sid not in players:
        message = "This player didn't throw any grenades in this demo."
    elif not sid:
        message = "Pick a player to compare their throws."

    out_throws: List[dict] = []
    matched_count = 0
    for t in mine:
        if t.get("grenade_type") not in ("smokegrenade", "flashbang", "hegrenade", "molotov"):
            continue
        matched = None
        reason = None
        if not has_data:
            reason = "No lineup data for this map"
        elif t.get("land_x") is None or t.get("land_y") is None:
            reason = "No landing point recorded"
        else:
            best = find_best_lineup(t, lineups)
            if best is None:
                reason = "No pro lineup lands within 150u"
            else:
                lu, land_d, throw_d = best
                matched = compare_throw(t, lu, land_d, throw_d)
                matched_count += 1
        out_throws.append({
            "tick": int(t.get("tick") or 0),
            "round_number": int(t.get("round_number") or 0),
            "grenade_type": t["grenade_type"],
            "side": _side(t.get("team_num")),
            "technique": t.get("throw_technique"),
            "throw_x": t.get("throw_x") or 0.0,
            "throw_y": t.get("throw_y") or 0.0,
            "throw_z": t.get("throw_z") or 0.0,
            "land_x": t.get("land_x"),
            "land_y": t.get("land_y"),
            "land_z": t.get("land_z"),
            "pitch": t.get("pitch") or 0.0,
            "yaw": t.get("yaw") or 0.0,
            "matched": matched,
            "no_match_reason": reason,
        })

    return {
        "demo_file": name,
        "map_name": map_name,
        "steamid": sid,
        "player_name": players.get(sid, {}).get("name") if sid else None,
        "has_lineup_data": has_data,
        "lineup_count": len(lineups),
        "message": message,
        "players": player_list,
        "throws": out_throws,
        "matched_count": matched_count,
    }
