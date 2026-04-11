"""
Probe whether demoparser2 parse_ticks can read player `buttons` state at
arbitrary ticks — so we can look a few ticks BEFORE grenade_thrown to catch
the attack button before it's released.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

from demoparser2 import DemoParser

DEMO = Path("demos/2388944_mirage.dem")


def main() -> None:
    parser = DemoParser(str(DEMO))

    # Get throw ticks
    throws = parser.parse_event("grenade_thrown", player=["buttons"])
    print(f"grenade_thrown rows: {len(throws)}")
    print(f"throw-tick buttons distribution: {throws['user_buttons'].value_counts().to_dict()}")

    # Pick the first 10 throws
    sample = throws.head(10)[["tick", "user_steamid", "user_buttons"]]
    print("\nFirst 10 throws at thrown tick:")
    print(sample.to_string())

    # Try parse_ticks for wanted_props=["buttons"] at tick-4 for each of these
    test_ticks = []
    for _, row in sample.iterrows():
        for offset in (-1, -2, -4, -8, -16, -32, -64):
            test_ticks.append(int(row["tick"] + offset))
    test_ticks = sorted(set(test_ticks))

    try:
        ticks_df = parser.parse_ticks(wanted_props=["buttons"], ticks=test_ticks)
        print(f"\nparse_ticks returned {len(ticks_df)} rows with cols {list(ticks_df.columns)}")
        print(ticks_df.head(20).to_string())
    except Exception as exc:
        print(f"parse_ticks failed: {exc}")
        return

    # For each sample throw, look back through the offsets and show the buttons state
    print("\nButton state at thrower offsets before throw:")
    for _, row in sample.iterrows():
        steamid = row["user_steamid"]
        throw_tick = int(row["tick"])
        print(f"\nthrow tick={throw_tick} steamid={steamid}")
        for offset in (-1, -2, -4, -8, -16, -32, -64):
            target_tick = throw_tick + offset
            match = ticks_df[(ticks_df["tick"] == target_tick) & (ticks_df["steamid"] == steamid)]
            if len(match):
                btn = int(match["buttons"].iloc[0])
                flags = []
                if btn & 1:
                    flags.append("ATTACK")
                if btn & 2:
                    flags.append("ATTACK2")
                print(f"  t{offset:+d}: buttons={btn:5d} {flags}")

    # Also — check what other player-state fields parse_ticks can pull
    print("\n-- parse_ticks with more props --")
    try:
        big = parser.parse_ticks(
            wanted_props=["buttons", "FL_ONGROUND", "flags", "velocity_Z", "is_walking", "ducking"],
            ticks=[int(sample.iloc[0]["tick"]) - 2],
        )
        print(f"cols: {list(big.columns)}")
        print(big.head(3).to_string())
    except Exception as exc:
        print(f"bigger parse_ticks failed: {exc}")


if __name__ == "__main__":
    main()
