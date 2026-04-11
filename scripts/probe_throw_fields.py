"""
Probe demoparser2 to discover which player fields are exposed for throw-
technique and click-type detection.

Usage: python -m scripts.probe_throw_fields
"""
from __future__ import annotations

import sys
from pathlib import Path

# Force UTF-8 stdout so box-drawing chars don't crash on Windows cp1252 consoles
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

from demoparser2 import DemoParser

DEMO = Path("demos/2388944_mirage.dem")

CANDIDATE_FIELDS = [
    # Movement
    "velocity", "velocity_X", "velocity_Y", "velocity_Z",
    "velo_modifier",
    "FL_ONGROUND", "flags", "in_buy_zone",
    "is_walking", "is_crouching", "is_ducking",
    "duck_amount", "duck_speed", "ducking",
    # Buttons / input
    "buttons", "IN_ATTACK", "IN_ATTACK2",
    "in_attack", "in_attack2",
    # Extras that might be useful
    "on_ground", "is_on_ground",
    "crouch_state", "walking",
]


def probe_event(parser: DemoParser, event: str, fields: list[str]) -> None:
    print(f"\n-- trying {event} with {len(fields)} player field(s) --")
    try:
        df = parser.parse_event(event, player=fields)
    except Exception as exc:
        print(f"  FAILED: {exc}")
        return
    if df is None or len(df) == 0:
        print("  no rows")
        return
    cols = [c for c in df.columns if any(f in c for f in fields)]
    print(f"  rows={len(df)}")
    print(f"  matched columns: {cols}")
    if cols:
        print(df[cols].head(3).to_string())


def probe_one_by_one(parser: DemoParser, event: str, fields: list[str]) -> list[str]:
    """Find which individual fields each parse. Returns the ones that work."""
    good: list[str] = []
    for f in fields:
        try:
            df = parser.parse_event(event, player=[f])
            if df is not None and len(df) > 0:
                good.append(f)
        except Exception:
            pass
    return good


def main() -> None:
    if not DEMO.exists():
        print(f"Demo not found: {DEMO}")
        return

    parser = DemoParser(str(DEMO))

    # First, list what's parseable on grenade_thrown one field at a time.
    print("-- probing grenade_thrown player fields --")
    good = probe_one_by_one(parser, "grenade_thrown", CANDIDATE_FIELDS)
    print(f"Accepted fields: {good}")

    # Then try to pull them all at once.
    if good:
        probe_event(parser, "grenade_thrown", good + ["X", "Y", "Z", "pitch", "yaw"])

    # Also probe weapon_fire which fires on click
    print("\n-- probing weapon_fire player fields --")
    good2 = probe_one_by_one(parser, "weapon_fire", CANDIDATE_FIELDS)
    print(f"Accepted fields on weapon_fire: {good2}")

    # Finally, list ALL props demoparser2 thinks exist (if the method supports it)
    print("\n-- prop list via parser.prop_names --")
    try:
        names = parser.prop_names  # type: ignore[attr-defined]
        print(f"total props: {len(names)}")
        interesting = [
            n for n in names
            if any(k in n.lower() for k in ("veloc", "button", "duck", "walk", "crouch", "onground", "ground", "attack"))
        ]
        for n in sorted(interesting):
            print(f"  {n}")
    except Exception as exc:
        print(f"  prop_names unavailable: {exc}")


if __name__ == "__main__":
    main()
