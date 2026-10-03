"""
Player profile read endpoints (cross-demo aggregation + rating).

Moved out of main.py; mounted with `app.include_router`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from backend.analysis.player_stats import CLUTCH_SIZES
from backend.api.deps import player_stats as _player_stats
from backend.models.schemas import (
    PlayerMatchStatsResponse,
    PlayerProfileDetail,
    PlayerProfileSummary,
)

logger = logging.getLogger(__name__)

router = APIRouter()


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


# HLTV Rating 1.0 baselines — average pro per-round values, so ~1.00 is
# an average player and 1.20+ a star. Uses only what demos give us
# (kills, deaths, multi-kill rounds); no ADR/KAST needed.
_AVG_KPR = 0.679
_AVG_SPR = 0.317
_AVG_RMK = 1.277


def _hltv_rating(row: dict) -> float:
    rounds = row.get("rounds_played") or 0
    if not rounds:
        return 0.0
    kills = row.get("kills") or 0
    deaths = row.get("deaths") or 0
    m2, m3, m4, m5 = (row.get(f"multi_{n}k") or 0 for n in (2, 3, 4, 5))
    # Rounds with exactly one kill = kills not accounted for by multi-kill rounds.
    m1 = max(kills - (2 * m2 + 3 * m3 + 4 * m4 + 5 * m5), 0)

    kill_rating = (kills / rounds) / _AVG_KPR
    survival_rating = (max(rounds - deaths, 0) / rounds) / _AVG_SPR
    rmk_rating = ((m1 + 4 * m2 + 9 * m3 + 16 * m4 + 25 * m5) / rounds) / _AVG_RMK
    return (kill_rating + 0.7 * survival_rating + rmk_rating) / 2.7


def _hltv_rating_2(kpr: float, dpr: float, apr: float, kast_pct: float, adr: float) -> float:
    """
    HLTV Rating 2.0 — the widely used community approximation (HLTV never
    published the real formula):

        Impact = 2.13*KPR + 0.42*APR - 0.41
        Rating = 0.0073*KAST + 0.3591*KPR - 0.5329*DPR
                 + 0.2372*Impact + 0.0032*ADR + 0.1587

    `kast_pct` is a percentage (72.0, not 0.72). An average pro line
    (~0.68 KPR, ~0.65 DPR, ~0.13 APR, ~72% KAST, ~76 ADR) lands near 1.0.
    """
    impact = 2.13 * kpr + 0.42 * apr - 0.41
    return (
        0.0073 * kast_pct
        + 0.3591 * kpr
        - 0.5329 * dpr
        + 0.2372 * impact
        + 0.0032 * adr
        + 0.1587
    )


def _advanced(row: dict) -> dict:
    """
    ADR / KAST / APR / trades / clutches + rating for any aggregated row
    (player totals, a side, a map, a demo). Rates use only the rounds that
    actually carry each kind of data (`adr_rounds`, `kast_total_rounds`,
    `assist_rounds`), so a few legacy demos don't drag a player's ADR or
    KAST toward zero. Rating 2.0 is used when both ADR and KAST exist;
    otherwise `rating` falls back to the 1.0 formula.
    """
    rounds = row.get("rounds_played") or 0
    kills = row.get("kills") or 0
    deaths = row.get("deaths") or 0
    adr_rounds = row.get("adr_rounds") or 0
    kast_rounds_total = row.get("kast_total_rounds") or 0
    assist_rounds = row.get("assist_rounds") or 0
    assists = row.get("assists") or 0
    trade_kills = row.get("trade_kills") or 0
    traded_deaths = row.get("traded_deaths") or 0
    kast_kills = row.get("kast_kills") or 0
    kast_deaths = row.get("kast_deaths") or 0

    adr: Optional[float] = _safe_div(row.get("damage") or 0, adr_rounds) if adr_rounds else None
    kast: Optional[float] = (
        _safe_div(row.get("kast_rounds") or 0, kast_rounds_total) if kast_rounds_total else None
    )
    apr: Optional[float] = _safe_div(assists, assist_rounds) if assist_rounds else None

    clutches = []
    att_total = won_total = 0
    for n in CLUTCH_SIZES:
        att = row.get(f"clutch_att_{n}") or 0
        won = row.get(f"clutch_won_{n}") or 0
        att_total += att
        won_total += won
        clutches.append({"x": n, "attempted": att, "won": won})

    rating_1 = _hltv_rating(row)
    if rounds and adr is not None and kast is not None:
        rating = _hltv_rating_2(
            kpr=kills / rounds,
            dpr=deaths / rounds,
            apr=apr or 0.0,
            kast_pct=kast * 100.0,
            adr=adr,
        )
        version = "2.0"
    else:
        rating, version = rating_1, "1.0"

    def _r(v: Optional[float], nd: int) -> Optional[float]:
        return round(v, nd) if v is not None else None

    return {
        "assists": assists,
        "apr": _r(apr, 3),
        "adr": _r(adr, 1),
        "kast_pct": _r(kast, 3),
        "trade_kills": trade_kills,
        "traded_deaths": traded_deaths,
        "trade_kill_pct": _r(_safe_div(trade_kills, kast_kills), 3) if kast_rounds_total else None,
        "traded_death_pct": _r(_safe_div(traded_deaths, kast_deaths), 3) if kast_rounds_total else None,
        "clutches_attempted": att_total,
        "clutches_won": won_total,
        "clutches": clutches,
        "rating": round(rating, 3),
        "rating_1": round(rating_1, 3),
        "rating_version": version,
    }


def _with_advanced(row: dict) -> dict:
    """Row plus its derived advanced block (for side/map/demo splits)."""
    return {**row, **_advanced(row)}


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
        "role": _infer_role(row),
        **_advanced(row),
    }


@router.get(
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


def _reingest_from_cache(name: str) -> bool:
    """Re-aggregate one demo from its cached timeline. False if no cache."""
    from backend.main import _TIMELINE_CACHE_DIR

    path = _TIMELINE_CACHE_DIR / f"{name}.json"
    if not path.exists():
        return False
    with path.open("r", encoding="utf-8") as f:
        bundle = json.load(f)
    _player_stats.ingest_timeline(bundle, name)
    return True


@router.get(
    "/api/players/match/{demo_file}",
    response_model=PlayerMatchStatsResponse,
    summary="Per-player stats for one demo (both sides combined)",
)
async def get_match_player_stats(demo_file: str):
    from backend.main import _safe_demo_name

    name = _safe_demo_name(demo_file)
    rows = _player_stats.get_match(name)
    # No rows yet, or rows written before the ADR/KAST columns existed:
    # rebuild them from the cached timeline (one-off, ~1s per demo).
    if not rows or any(r.get("legacy") for r in rows):
        try:
            if await asyncio.to_thread(_reingest_from_cache, name):
                rows = _player_stats.get_match(name)
        except Exception as exc:
            logger.warning("player_stats re-ingest failed for %s: %s", name, exc)
    if not rows:
        raise HTTPException(status_code=404, detail=f"No player stats for {name}")

    players = []
    for r in rows:
        r["matches"] = 1
        players.append(_to_summary(r))
    players.sort(key=lambda s: s["rating"], reverse=True)
    return {
        "demo_file": name,
        "map_name": rows[0].get("map_name") or "unknown",
        "has_adr": any(p["adr"] is not None for p in players),
        "players": players,
    }


@router.get(
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
        "per_side": [_with_advanced(r) for r in detail["per_side"]],
        "per_map": [_with_advanced(r) for r in detail["per_map"]],
        "demos": [_with_advanced(r) for r in detail["demos"]],
    }
