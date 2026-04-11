"""
Callout lookup — maps a (map_name, x, y) world coordinate to a
human-readable callout like "BApartments".

Data source: scripts/extract_callouts.py dumps per-map JSON into
`backend/data/callouts/{map}.json` from the upstream CS2Callouts project.
Each entry has `name`, `origin` (3D world coords), and `polygon_2d`.

Strategy
--------
The `env_cs_place` entities in current CS2 maps reference tiny marker
models (~10 world units wide), not the zone volumes themselves, so the
`polygon_2d` field is effectively degenerate — running
point-in-polygon on a real grenade landing position almost always misses.

However the `origin` field IS Valve-authored and accurate: it's the
hand-placed centroid of each callout zone. So the useful lookup is
nearest-origin-within-threshold, not containment.

For each map we:
  1. Load all (name, x, y) pairs at import time.
  2. On `lookup(map_name, x, y)` compute 2D euclidean distance to every
     origin, return the name of the nearest one within `max_dist`.
  3. If nothing qualifies (or the map has no data) return None so the
     caller falls back to whatever default labeling it wants.

`max_dist` is generous — Mirage's adjacent zones can be 500-1000 units
apart (Apts → Top Mid ≈ 900 u), and we'd rather label a fringe throw
"Apartments" than leave it unlabeled. Points genuinely outside the
playable map (parser noise, map edges) still get rejected.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "callouts"

# Max distance (world units) between a throw landing and a callout origin
# to still count as a match. Calibrated on Mirage where the widest gap
# between adjacent zone centroids is ~1100 u — beyond that the nearest
# match is misleading.
_MAX_LOOKUP_DIST = 1200.0


class _Origin:
    __slots__ = ("name", "x", "y")

    def __init__(self, name: str, x: float, y: float) -> None:
        self.name = name
        self.x = x
        self.y = y


def _load_map(path: Path) -> list[_Origin]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to load callouts from %s: %s", path, exc)
        return []

    entries = raw.get("callouts", raw) if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return []

    out: list[_Origin] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        name = e.get("name") or e.get("placename")
        origin = e.get("origin")
        if not name or not origin or len(origin) < 2:
            continue
        out.append(_Origin(name=str(name), x=float(origin[0]), y=float(origin[1])))
    return out


def _load_all() -> dict[str, list[_Origin]]:
    if not _DATA_DIR.exists():
        logger.info("Callout data dir %s does not exist — lookup disabled", _DATA_DIR)
        return {}

    maps: dict[str, list[_Origin]] = {}
    for path in sorted(_DATA_DIR.glob("*.json")):
        map_name = path.stem
        origins = _load_map(path)
        if origins:
            maps[map_name] = origins
            logger.info("Loaded %d callout origins for %s", len(origins), map_name)

    if not maps:
        logger.info(
            "No callout JSON found in %s — run scripts/extract_callouts.py "
            "to generate (lookup() will return None until then)",
            _DATA_DIR,
        )
    return maps


_CALLOUTS: dict[str, list[_Origin]] = _load_all()


def lookup(map_name: str, x: float, y: float) -> Optional[str]:
    """
    Return the name of the nearest callout origin to (x, y) on `map_name`,
    or None if no callout is within `_MAX_LOOKUP_DIST` (or the map has
    no data loaded).
    """
    entries = _CALLOUTS.get(map_name)
    if not entries:
        return None

    best_name: Optional[str] = None
    best_dist2 = _MAX_LOOKUP_DIST * _MAX_LOOKUP_DIST
    for o in entries:
        dx = o.x - x
        dy = o.y - y
        d2 = dx * dx + dy * dy
        if d2 < best_dist2:
            best_dist2 = d2
            best_name = o.name
    return best_name


def has_data(map_name: str) -> bool:
    return bool(_CALLOUTS.get(map_name))


def humanize(raw_name: str) -> str:
    """
    Convert a CS2 place name like "BApartments" or "TopMid" into
    "B Apartments" / "Top Mid" for display. Splits on both
    lowercase→uppercase and uppercase→uppercase-followed-by-lowercase
    so leading single-letter prefixes (A, B, CT) break correctly.
    """
    if not raw_name:
        return raw_name
    n = len(raw_name)
    out: list[str] = []
    for i, ch in enumerate(raw_name):
        if i > 0 and ch.isupper():
            prev = raw_name[i - 1]
            nxt = raw_name[i + 1] if i + 1 < n else ""
            if not prev.isupper() or (nxt and nxt.islower()):
                out.append(" ")
        out.append(ch)
    return "".join(out)
