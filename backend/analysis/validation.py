"""
Demo completeness check.

HLTV sometimes ships a map as several demo files (`-p1.dem`, `-p2.dem`) when
the server restarted mid-match, so a .dem can end at 7:5 or 5:0. Those demos
replay fine but skew anything that assumes a full match (side splits, round
counts, anti-strat win rates). This module scores a parsed timeline and says
whether the match actually finished inside the file.

CS2 competitive is MR12: first to 13 wins regulation; at 12:12 overtime is
played in MR3 halves, first to 4 of 6 (16, 19, 22, ...).
"""
from __future__ import annotations

import bisect
from typing import Optional


def _side_at(samples: list[dict], ticks: list[int], tick: int) -> Optional[str]:
    """Side ("T"/"CT") of a player at `tick`, from the nearest sample at or before it."""
    if not samples:
        return None
    i = max(bisect.bisect_right(ticks, tick) - 1, 0)
    tn = samples[i].get("tn")
    return "T" if tn == 2 else "CT" if tn == 3 else None


def team_scores(bundle: dict) -> Optional[tuple[int, int]]:
    """
    Final (team A, team B) round wins, following one reference player so
    halftime and overtime side swaps are handled. Returns None when the
    timeline lacks per-sample team info (pre-v3 caches).
    """
    rounds = bundle.get("rounds") or []
    positions = bundle.get("positions") or {}
    if not rounds or not positions:
        return None

    # Reference player = whoever has the most samples (present all match).
    ref = max(positions.values(), key=len)
    if not ref or "tn" not in ref[0]:
        return None
    ticks = [s["t"] for s in ref]

    a = b = 0
    for r in rounds:
        winner = r.get("winner")
        if winner not in ("T", "CT"):
            continue
        anchor = r.get("freeze_end_tick") or r.get("start_tick") or 0
        side = _side_at(ref, ticks, anchor)
        if side is None:
            continue
        if side == winner:
            a += 1
        else:
            b += 1
    return a, b


def is_finished(w: int, l: int) -> bool:
    """True when a `w`–`l` scoreline is a legal MR12 (+MR3 overtime) final."""
    if w < l:
        w, l = l, w
    if l <= 11:
        return w == 13
    # Overtime: winner reached 16, 19, 22, ... and leads by at least 2.
    return w >= 16 and (w - 16) % 3 == 0 and w - l >= 2


def assess_completeness(bundle: dict) -> dict:
    """
    `{"complete": bool|None, "score": [hi, lo]|None, "rounds": int}` —
    `complete` is None when the timeline can't be scored.
    """
    rounds = len(bundle.get("rounds") or [])
    scores = team_scores(bundle)
    if scores is None:
        return {"complete": None, "score": None, "rounds": rounds}
    hi, lo = max(scores), min(scores)
    return {"complete": is_finished(hi, lo), "score": [hi, lo], "rounds": rounds}
