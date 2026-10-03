"""
Player profile read endpoints (cross-demo aggregation + rating).

Moved out of main.py; mounted with `app.include_router`.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException, Query

from backend.api.deps import player_stats as _player_stats
from backend.models.schemas import PlayerProfileDetail, PlayerProfileSummary

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

    rating = _hltv_rating(row)

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
        "per_side": detail["per_side"],
        "per_map": detail["per_map"],
        "demos": detail["demos"],
    }
