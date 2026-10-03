"""
"Your throw vs the pro lineup" — pure geometry + matching helpers.

Given one grenade throw from a demo and the pro lineup clusters for the same
map, find the closest pro lineup and describe how far off the throw was.

Angle conventions (CS2 / Source 2, as exported by demoparser2)
---------------------------------------------------------------
* World axes: +x east, +y north, +z up. The radar shows +y as "up".
* **Yaw** is in degrees, measured counter-clockwise from +x when viewed from
  above: 0° faces +x, 90° faces +y, ±180° faces −x. demoparser2 reports
  (−180, 180]; we normalise anything else into that range.
* **Pitch** is in degrees with **positive = looking down** and negative =
  looking up (−89 … +89). Some sources report 270…360 for "up"; we fold
  those back to negative values.

From the pro's yaw ψ we build the pro's horizontal frame:

    forward = ( cos ψ,  sin ψ)
    right   = ( sin ψ, −cos ψ)      # forward rotated 90° clockwise

Your position offset d = you − pro is projected onto that frame, so
``forward > 0`` means you stood further forward (in the direction the pro
faces), ``right > 0`` means you stood to the pro's right, and
``vertical > 0`` means you were higher.

Angle deltas are also "yours − pro's":

* ``pitch_delta > 0`` → you looked further down → "too low";
  ``< 0`` → "too high".
* ``yaw_delta > 0`` → you aimed further counter-clockwise → "too far left";
  ``< 0`` → "too far right".

Landing offset is projected onto the pro's throw→land horizontal direction:
``land_along > 0`` = your nade flew further ("long"), ``< 0`` = "short";
``land_across > 0`` = it landed to the right of the pro's line.
"""
from __future__ import annotations

import math
from typing import Iterable, Mapping, Optional

# A pro lineup counts as "the same nade" when its landing point is within
# this many units (3D, or 2D when either z is missing) of yours.
MATCH_LAND_RADIUS = 150.0

# Below these thresholds a component is considered negligible in the summary.
_POS_EPS = 4.0      # units
_ANG_EPS = 0.5      # degrees
_LAND_EPS = 10.0    # units


# ---------------------------------------------------------------------------
# Angle helpers
# ---------------------------------------------------------------------------

def normalize_yaw(yaw: float) -> float:
    """Wrap a yaw to (−180, 180]."""
    y = math.fmod(float(yaw), 360.0)
    if y <= -180.0:
        y += 360.0
    elif y > 180.0:
        y -= 360.0
    return y


def normalize_pitch(pitch: float) -> float:
    """Fold 0…360-style pitches into −180…180 (positive = looking down)."""
    p = math.fmod(float(pitch), 360.0)
    if p > 180.0:
        p -= 360.0
    elif p < -180.0:
        p += 360.0
    return p


def angle_delta(a: float, b: float) -> float:
    """Signed shortest difference a − b in degrees, in (−180, 180]."""
    return normalize_yaw(a - b)


# ---------------------------------------------------------------------------
# Decomposition
# ---------------------------------------------------------------------------

def decompose_offset(
    dx: float, dy: float, dz: float, ref_yaw_deg: float,
) -> tuple[float, float, float]:
    """Project a world-space offset onto a player's facing frame.

    Returns ``(forward, right, vertical)`` where forward/right are relative to
    ``ref_yaw_deg`` (see module docstring for the convention).
    """
    psi = math.radians(normalize_yaw(ref_yaw_deg))
    fx, fy = math.cos(psi), math.sin(psi)
    rx, ry = math.sin(psi), -math.cos(psi)
    forward = dx * fx + dy * fy
    right = dx * rx + dy * ry
    return forward, right, dz


def _dist(ax, ay, az, bx, by, bz) -> float:
    if az is None or bz is None:
        return math.hypot(ax - bx, ay - by)
    return math.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2)


def _num(v) -> Optional[float]:
    """float(v), or None for None / NaN / garbage."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def find_best_lineup(
    throw: Mapping, lineups: Iterable[Mapping], radius: float = MATCH_LAND_RADIUS,
) -> Optional[tuple[Mapping, float, float]]:
    """Best pro lineup for ``throw`` → ``(lineup, land_dist, throw_dist)``.

    Candidates must share the grenade type and land within ``radius`` units.
    Among those, the lineup with the smallest landing + throw-position
    distance wins (both matter: the same smoke can be thrown from several
    spots, and we want the spot you were actually trying).
    """
    lx, ly, lz = _num(throw.get("land_x")), _num(throw.get("land_y")), _num(throw.get("land_z"))
    tx, ty, tz = _num(throw.get("throw_x")), _num(throw.get("throw_y")), _num(throw.get("throw_z"))
    if lx is None or ly is None or tx is None or ty is None:
        return None
    gtype = throw.get("grenade_type")
    best = None
    best_score = math.inf
    for lu in lineups:
        if lu.get("grenade_type") != gtype:
            continue
        plx, ply = _num(lu.get("land_cx")), _num(lu.get("land_cy"))
        ptx, pty = _num(lu.get("throw_cx")), _num(lu.get("throw_cy"))
        if None in (plx, ply, ptx, pty):
            continue
        land_d = _dist(lx, ly, lz, plx, ply, _num(lu.get("land_cz")))
        if land_d > radius:
            continue
        throw_d = _dist(tx, ty, tz, ptx, pty, _num(lu.get("throw_cz")))
        score = land_d + throw_d
        if score < best_score:
            best_score = score
            best = (lu, land_d, throw_d)
    return best


def classify_quality(throw_dist: float, land_dist: float, pitch_d: float, yaw_d: float) -> str:
    """'on-point' / 'close' / 'off' badge for a matched throw."""
    ang = max(abs(pitch_d), abs(yaw_d))
    if throw_dist <= 32 and land_dist <= 48 and ang <= 2.5:
        return "on-point"
    if throw_dist <= 128 and land_dist <= 100 and ang <= 8:
        return "close"
    return "off"


def _fmt_units(v: float) -> str:
    return f"{abs(v):.0f}u"


def build_summary(
    forward: float, right: float, vertical: float,
    pitch_d: float, yaw_d: float,
    land_along: Optional[float], land_dist: float,
) -> str:
    """Short human summary, e.g. "12u left, 3° too high, landed 40u short"."""
    parts: list[str] = []
    pos: list[str] = []
    if abs(right) >= _POS_EPS:
        pos.append(f"{_fmt_units(right)} {'right' if right > 0 else 'left'}")
    if abs(forward) >= _POS_EPS:
        pos.append(f"{_fmt_units(forward)} {'forward' if forward > 0 else 'back'}")
    if abs(vertical) >= 16:  # crouch vs stand ≈ 18u of eye height; feet z jitter is small
        pos.append(f"{_fmt_units(vertical)} {'higher' if vertical > 0 else 'lower'}")
    parts.extend(pos)
    if abs(pitch_d) >= _ANG_EPS:
        parts.append(f"{abs(pitch_d):.0f}° too {'low' if pitch_d > 0 else 'high'}"
                     if abs(pitch_d) >= 1 else
                     f"{abs(pitch_d):.1f}° too {'low' if pitch_d > 0 else 'high'}")
    if abs(yaw_d) >= _ANG_EPS:
        parts.append(f"{abs(yaw_d):.0f}° too far {'left' if yaw_d > 0 else 'right'}"
                     if abs(yaw_d) >= 1 else
                     f"{abs(yaw_d):.1f}° too far {'left' if yaw_d > 0 else 'right'}")
    if land_along is not None and abs(land_along) >= _LAND_EPS:
        parts.append(f"landed {_fmt_units(land_along)} {'long' if land_along > 0 else 'short'}")
    elif land_dist >= _LAND_EPS:
        parts.append(f"landed {land_dist:.0f}u off")
    if not parts:
        return "Spot on — matches the pro lineup"
    return ", ".join(parts)


def compare_throw(throw: Mapping, lineup: Mapping, land_dist: float, throw_dist: float) -> dict:
    """Deltas between one throw and its matched pro lineup."""
    tx, ty, tz = (_num(throw.get(k)) or 0.0 for k in ("throw_x", "throw_y", "throw_z"))
    ptx, pty = _num(lineup.get("throw_cx")) or 0.0, _num(lineup.get("throw_cy")) or 0.0
    ptz = _num(lineup.get("throw_cz"))
    pro_yaw = normalize_yaw(_num(lineup.get("avg_yaw")) or 0.0)
    pro_pitch = normalize_pitch(_num(lineup.get("avg_pitch")) or 0.0)
    yaw = normalize_yaw(_num(throw.get("yaw")) or 0.0)
    pitch = normalize_pitch(_num(throw.get("pitch")) or 0.0)

    forward, right, vertical = decompose_offset(
        tx - ptx, ty - pty, (tz - ptz) if ptz is not None else 0.0, pro_yaw,
    )
    pitch_d = pitch - pro_pitch
    yaw_d = angle_delta(yaw, pro_yaw)

    # Landing: project onto the pro's throw→land horizontal direction.
    lx, ly = _num(throw.get("land_x")), _num(throw.get("land_y"))
    plx, ply = _num(lineup.get("land_cx")), _num(lineup.get("land_cy"))
    land_along = land_across = None
    if None not in (lx, ly, plx, ply):
        vx, vy = plx - ptx, ply - pty
        vlen = math.hypot(vx, vy)
        if vlen > 1e-6:
            ux, uy = vx / vlen, vy / vlen
            ox, oy = lx - plx, ly - ply
            land_along = ox * ux + oy * uy
            land_across = ox * uy - oy * ux  # right-hand side of the flight line

    return {
        "lineup_id": int(lineup.get("id")) if lineup.get("id") is not None else None,
        "label": lineup.get("label") or "Pro lineup",
        "side": lineup.get("side"),
        "throw_count": int(lineup.get("throw_count") or 0),
        "round_win_rate": _num(lineup.get("round_win_rate")),
        "technique": lineup.get("primary_technique"),
        "pro_throw_x": ptx, "pro_throw_y": pty, "pro_throw_z": ptz,
        "pro_land_x": plx, "pro_land_y": ply, "pro_land_z": _num(lineup.get("land_cz")),
        "pro_pitch": round(pro_pitch, 2), "pro_yaw": round(pro_yaw, 2),
        "offset_forward": round(forward, 1),
        "offset_right": round(right, 1),
        "offset_vertical": round(vertical, 1),
        "throw_distance": round(throw_dist, 1),
        "pitch_delta": round(pitch_d, 2),
        "yaw_delta": round(yaw_d, 2),
        "land_distance": round(land_dist, 1),
        "land_along": round(land_along, 1) if land_along is not None else None,
        "land_across": round(land_across, 1) if land_across is not None else None,
        "quality": classify_quality(throw_dist, land_dist, pitch_d, yaw_d),
        "summary": build_summary(forward, right, vertical, pitch_d, yaw_d, land_along, land_dist),
    }
