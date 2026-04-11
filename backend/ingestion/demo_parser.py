"""
Demo parser — wraps demoparser2 to extract grenade and round data from CS2 .dem files.

demoparser2 is a Rust-based library that can process hundreds of demos in seconds.
Each demo is parsed for:
  - grenade_thrown  → position, angles, type
  - player_hurt     → utility damage
  - round_end       → winner (CT / T)

The output is a tidy pandas DataFrame of GrenadeThrow records ready for the
clustering pipeline.

Usage
-----
    from pathlib import Path
    from backend.ingestion.demo_parser import DemoParser

    parser = DemoParser()
    df = parser.parse_demo(Path("demos/12345.dem"), map_name="de_mirage")
    # or batch:
    df = parser.parse_directory(Path("demos"), map_name="de_mirage")
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Grenade type normalisation
# ---------------------------------------------------------------------------
# demoparser2's grenade_thrown event exposes `weapon` as lowercase strings like
# "smokegrenade", "hegrenade", "flashbang", "molotov", "incgrenade", "decoy".
# We fold incendiary into molotov since they detonate via the same engine
# event (`inferno_startburn`) and share lineup positions.
WEAPON_TO_TYPE = {
    "smokegrenade": "smokegrenade",
    "hegrenade": "hegrenade",
    "flashbang": "flashbang",
    "molotov": "molotov",
    "incgrenade": "molotov",
    "decoy": "decoy",
}

# grenade_type → detonation event name emitted by the CS2 engine
DETONATE_EVENT_FOR_TYPE = {
    "smokegrenade": "smokegrenade_detonate",
    "hegrenade": "hegrenade_detonate",
    "flashbang": "flashbang_detonate",
    "molotov": "inferno_startburn",
}

# team_num encoding from demoparser2 → string label matched against round_winner
TEAM_NUM_TO_LABEL = {2: "T", 3: "CT"}

# Source engine button bitmask — demoparser2 exposes player `buttons` as the
# raw IN_* bitfield, so we decode the ones we care about.
IN_ATTACK = 1 << 0      # left click
IN_ATTACK2 = 1 << 11    # right click (underhand / lob)

# How many ticks before grenade_thrown to sample the buttons state. At 64-tick
# the throw animation takes ~8 ticks from release, so by the time the engine
# fires grenade_thrown the attack button is already back to 0. Sampling at
# tick-8 catches it while still held.
BUTTON_LOOKBACK_TICKS = 8


class DemoParser:
    """
    Parses CS2 .dem files using demoparser2 and returns structured DataFrames.
    """

    def __init__(self) -> None:
        try:
            from demoparser2 import DemoParser as _DP  # type: ignore
            self._dp_cls = _DP
        except ImportError as exc:
            raise RuntimeError(
                "demoparser2 is not installed. Run: pip install demoparser2"
            ) from exc

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def parse_demo(
        self,
        demo_path: Path,
        *,
        map_name: Optional[str] = None,
        player_names: Optional[Iterable[str]] = None,
    ) -> pd.DataFrame:
        """
        Parse a single .dem file and return a DataFrame of grenade throws.

        Columns
        -------
        tick, round_number, thrower_steamid, thrower_name, grenade_type, map_name,
        throw_x, throw_y, throw_z, land_x, land_y, land_z,
        pitch, yaw, round_winner, utility_damage

        Parameters
        ----------
        player_names:
            Optional set of player names (case-insensitive). When supplied,
            only grenade throws by these players are kept — used by the team
            filter in /api/ingest/hltv to restrict a run to one roster.
        """
        logger.info("Parsing %s …", demo_path)
        parser = self._dp_cls(str(demo_path))

        name_filter: Optional[set[str]] = None
        if player_names:
            name_filter = {n.strip().lower() for n in player_names if n and n.strip()}

        # Read the demo's own map name first so we can reject demos that
        # don't match the requested filter. Previously we used `map_name` as
        # an override (`inferred_map = map_name or self._infer_map(...)`)
        # which silently mislabeled off-map demos — e.g. an Inferno demo
        # pulled from a BO3 archive would get tagged as de_mirage and pollute
        # the Mirage cluster with Inferno coordinates.
        actual_map = self._infer_map(parser)
        if map_name and actual_map != "unknown" and actual_map != map_name:
            logger.info(
                "Skipping %s — actual map is %s, filter requested %s",
                demo_path.name, actual_map, map_name,
            )
            return pd.DataFrame()
        resolved_map = actual_map if actual_map != "unknown" else (map_name or "unknown")

        grenades_df = self._extract_grenades(parser, player_names=name_filter)
        if grenades_df.empty:
            logger.warning("No grenade events found in %s", demo_path)
            return pd.DataFrame()

        rounds_df = self._extract_rounds(parser)
        damage_df = self._extract_utility_damage(parser)

        df = self._merge(grenades_df, rounds_df, damage_df)
        df["map_name"] = resolved_map

        logger.info(
            "  → %d grenade throws across %d rounds on %s",
            len(df),
            df["round_number"].nunique(),
            resolved_map,
        )
        return df

    def parse_directory(
        self,
        demo_dir: Path,
        *,
        map_name: Optional[str] = None,
        glob_pattern: str = "*.dem",
        player_names: Optional[Iterable[str]] = None,
    ) -> pd.DataFrame:
        """
        Batch-parse all .dem files in a directory.
        Returns a single concatenated DataFrame.
        """
        paths = sorted(demo_dir.glob(glob_pattern))
        if not paths:
            logger.warning("No .dem files found in %s", demo_dir)
            return pd.DataFrame()

        logger.info("Found %d demos to parse …", len(paths))
        frames = []
        for p in paths:
            try:
                df = self.parse_demo(p, map_name=map_name, player_names=player_names)
                if not df.empty:
                    df["source_demo"] = p.name
                    frames.append(df)
            except Exception as exc:
                logger.error("Failed to parse %s: %s", p.name, exc)

        if not frames:
            return pd.DataFrame()

        combined = pd.concat(frames, ignore_index=True)
        logger.info("Total grenade throws across all demos: %d", len(combined))
        return combined

    # ------------------------------------------------------------------
    # Internal extraction helpers
    # ------------------------------------------------------------------

    def _extract_grenades(
        self,
        parser,
        *,
        player_names: Optional[set[str]] = None,
    ) -> pd.DataFrame:
        """
        Build per-throw grenade rows from two event streams:

        - `grenade_thrown` gives throw position, pitch/yaw, thrower, team, weapon
        - `{type}_detonate` / `inferno_startburn` give landing coordinates

        The two are merged on (thrower_steamid, nearest tick) so each thrown
        grenade ends up with the coordinates of where it actually landed. We
        use merge_asof with a forward tolerance of ~16 seconds (1024 ticks at
        64 tick rate) — comfortably longer than the longest grenade flight.
        """
        throws = self._extract_grenade_throws(parser, player_names=player_names)
        if throws.empty:
            return pd.DataFrame()

        # Pull the pre-release buttons state so we can tell left-click from
        # right-click throws. grenade_thrown fires at the release tick, when
        # the mouse button is already back to 0, so we have to look backward.
        throws = self._attach_pre_release_buttons(parser, throws)

        # Classify throw technique + click type into human-readable labels.
        throws = self._classify_throw_techniques(throws)

        lands = self._extract_grenade_landings(parser)

        merged_parts: list[pd.DataFrame] = []
        for gtype, group in throws.groupby("grenade_type", sort=False):
            group = group.sort_values("tick").reset_index(drop=True)
            land_group = lands[lands["grenade_type"] == gtype].sort_values("land_tick")

            if land_group.empty:
                group["land_x"] = np.nan
                group["land_y"] = np.nan
                group["land_z"] = np.nan
                merged_parts.append(group)
                continue

            merged = pd.merge_asof(
                group,
                land_group[["land_tick", "thrower_steamid", "land_x", "land_y", "land_z"]],
                left_on="tick",
                right_on="land_tick",
                by="thrower_steamid",
                direction="forward",
                tolerance=1024,
            )
            merged = merged.drop(columns=["land_tick"], errors="ignore")
            merged_parts.append(merged)

        if not merged_parts:
            return pd.DataFrame()

        df = pd.concat(merged_parts, ignore_index=True)

        logger.info(
            "  grenade_thrown: %d throws, %d matched to landings",
            len(df),
            df[["land_x", "land_y", "land_z"]].notna().all(axis=1).sum(),
        )
        return df

    def _extract_grenade_throws(
        self,
        parser,
        *,
        player_names: Optional[set[str]] = None,
    ) -> pd.DataFrame:
        """One row per grenade_thrown event: throw pos, angles, team, weapon."""
        # We also pull movement + stance fields so downstream throw-technique
        # classification (jump / crouch / walk / run / stand) can run without
        # a second parser pass. `buttons` here captures the post-release state
        # (usually 0); the true click is recovered via a tick-lookup on
        # parse_ticks in _attach_pre_release_buttons.
        try:
            df = parser.parse_event(
                "grenade_thrown",
                player=[
                    "X", "Y", "Z", "pitch", "yaw", "team_num",
                    "velocity_X", "velocity_Y", "velocity_Z",
                    "is_walking", "ducking", "duck_amount",
                    "buttons",
                ],
            )
        except Exception as exc:
            logger.error("grenade_thrown parse failed: %s", exc)
            return pd.DataFrame()

        if df is None or len(df) == 0:
            return pd.DataFrame()

        df = df.rename(
            columns={
                "user_X": "throw_x",
                "user_Y": "throw_y",
                "user_Z": "throw_z",
                "user_pitch": "pitch",
                "user_yaw": "yaw",
                "user_team_num": "team_num",
                "user_name": "thrower_name",
                "user_steamid": "thrower_steamid",
                "user_velocity_X": "throw_vel_x",
                "user_velocity_Y": "throw_vel_y",
                "user_velocity_Z": "throw_vel_z",
                "user_is_walking": "is_walking",
                "user_ducking": "ducking",
                "user_duck_amount": "duck_amount",
                "user_buttons": "buttons_at_throw",
            }
        )

        df["grenade_type"] = (
            df["weapon"].astype(str).str.lower().map(WEAPON_TO_TYPE)
        )
        df = df.dropna(subset=["grenade_type", "thrower_steamid"])

        if player_names:
            before = len(df)
            df = df[df["thrower_name"].astype(str).str.lower().isin(player_names)]
            logger.info(
                "  player filter: %d → %d throws (keeping %d names)",
                before, len(df), len(player_names),
            )

        keep = [
            "tick", "grenade_type", "weapon",
            "thrower_name", "thrower_steamid", "team_num",
            "throw_x", "throw_y", "throw_z",
            "pitch", "yaw",
            "throw_vel_x", "throw_vel_y", "throw_vel_z",
            "is_walking", "ducking", "duck_amount",
            "buttons_at_throw",
        ]
        keep = [c for c in keep if c in df.columns]
        return df[keep].reset_index(drop=True)

    def _attach_pre_release_buttons(
        self,
        parser,
        throws: pd.DataFrame,
    ) -> pd.DataFrame:
        """
        For every row in `throws`, look up the `buttons` bitmask BUTTON_LOOKBACK_TICKS
        ticks earlier for the same player. The click that initiates a grenade
        throw is released before the engine fires grenade_thrown, so the buttons
        field at the throw tick is almost always 0. Sampling a few ticks back
        catches IN_ATTACK / IN_ATTACK2 while the button is still held.

        Returns `throws` with a new `buttons_pre_release` int column (0 when the
        lookup misses — e.g. for throws in the first few ticks of a demo).
        """
        if throws.empty:
            throws["buttons_pre_release"] = 0
            return throws

        lookup_ticks = sorted({int(t) - BUTTON_LOOKBACK_TICKS for t in throws["tick"]})
        try:
            wanted = parser.parse_ticks(
                wanted_props=["buttons"], ticks=lookup_ticks
            )
        except Exception as exc:
            logger.warning("parse_ticks(buttons) failed: %s", exc)
            throws["buttons_pre_release"] = 0
            return throws

        if wanted is None or len(wanted) == 0:
            throws["buttons_pre_release"] = 0
            return throws

        # parse_ticks returns steamid as int64; grenade_thrown returns it as
        # string — cast both sides to string for a reliable join.
        wanted = wanted.copy()
        wanted["steamid"] = wanted["steamid"].astype(str)
        wanted = wanted.rename(columns={"tick": "lookup_tick", "buttons": "buttons_pre_release"})

        out = throws.copy()
        out["lookup_tick"] = out["tick"].astype("int64") - BUTTON_LOOKBACK_TICKS
        out["thrower_steamid_str"] = out["thrower_steamid"].astype(str)

        merged = out.merge(
            wanted[["lookup_tick", "steamid", "buttons_pre_release"]],
            left_on=["lookup_tick", "thrower_steamid_str"],
            right_on=["lookup_tick", "steamid"],
            how="left",
        )
        merged["buttons_pre_release"] = (
            merged["buttons_pre_release"].fillna(0).astype("int64")
        )
        merged = merged.drop(
            columns=["lookup_tick", "thrower_steamid_str", "steamid"],
            errors="ignore",
        )
        return merged

    def _classify_throw_techniques(self, throws: pd.DataFrame) -> pd.DataFrame:
        """
        Turn the raw velocity/stance/buttons columns into two human-readable
        labels per throw:

          throw_technique ∈ {stand, walk, run, jump, running_jump, crouch}
          click_type      ∈ {left, right, both, none}

        Rules:
          - jump            → |velocity_Z| > 10  (the player is airborne)
          - running_jump    → jump AND horizontal_speed > 200
          - crouch          → ducking or duck_amount > 0.5
          - walk            → is_walking (shift held)
          - run             → horizontal_speed > 200 and on ground
          - stand           → otherwise

        Click is decoded from buttons_pre_release using IN_ATTACK (bit 0) and
        IN_ATTACK2 (bit 11). Both-bits = "both"; neither = "none".
        """
        if throws.empty:
            throws["throw_technique"] = pd.Series(dtype="object")
            throws["click_type"] = pd.Series(dtype="object")
            return throws

        df = throws.copy()

        for col, default in (
            ("throw_vel_x", 0.0),
            ("throw_vel_y", 0.0),
            ("throw_vel_z", 0.0),
            ("is_walking", False),
            ("ducking", False),
            ("duck_amount", 0.0),
            ("buttons_pre_release", 0),
            ("buttons_at_throw", 0),
        ):
            if col not in df.columns:
                df[col] = default

        vz = df["throw_vel_z"].fillna(0.0).astype(float)
        vx = df["throw_vel_x"].fillna(0.0).astype(float)
        vy = df["throw_vel_y"].fillna(0.0).astype(float)
        horiz = np.sqrt(vx * vx + vy * vy)

        is_air = vz.abs() > 10.0
        is_crouch = df["ducking"].fillna(False).astype(bool) | (
            df["duck_amount"].fillna(0.0).astype(float) > 0.5
        )
        is_walking = df["is_walking"].fillna(False).astype(bool)
        is_running = horiz > 200.0

        technique = np.where(
            is_air & is_running, "running_jump",
            np.where(
                is_air, "jump",
                np.where(
                    is_crouch, "crouch",
                    np.where(
                        is_walking, "walk",
                        np.where(is_running, "run", "stand"),
                    ),
                ),
            ),
        )
        df["throw_technique"] = technique

        # buttons_pre_release is the pre-animation state (live click).
        # buttons_at_throw very rarely still holds IN_ATTACK / IN_ATTACK2 —
        # fall back to it so we don't lose info when parse_ticks returned 0.
        btn = df["buttons_pre_release"].fillna(0).astype("int64")
        btn_fallback = df["buttons_at_throw"].fillna(0).astype("int64")
        left = ((btn & IN_ATTACK) != 0) | ((btn_fallback & IN_ATTACK) != 0)
        right = ((btn & IN_ATTACK2) != 0) | ((btn_fallback & IN_ATTACK2) != 0)

        df["click_type"] = np.where(
            left & right, "both",
            np.where(right, "right", np.where(left, "left", "none")),
        )

        logger.info(
            "  technique breakdown: %s",
            df["throw_technique"].value_counts().to_dict(),
        )
        logger.info(
            "  click breakdown: %s",
            df["click_type"].value_counts().to_dict(),
        )
        return df

    def _extract_grenade_landings(self, parser) -> pd.DataFrame:
        """
        One row per grenade detonation: (land_tick, thrower_steamid, x, y, z, grenade_type).
        Concatenates smoke/he/flash/inferno detonate events into a single frame.
        """
        frames: list[pd.DataFrame] = []
        for gtype, event_name in DETONATE_EVENT_FOR_TYPE.items():
            try:
                df = parser.parse_event(event_name)
            except Exception as exc:
                logger.debug("%s parse failed: %s", event_name, exc)
                continue
            if df is None or len(df) == 0 or not hasattr(df, "columns"):
                continue

            df = df.rename(
                columns={
                    "tick": "land_tick",
                    "user_steamid": "thrower_steamid",
                    "x": "land_x",
                    "y": "land_y",
                    "z": "land_z",
                }
            )
            df = df[["land_tick", "thrower_steamid", "land_x", "land_y", "land_z"]].copy()
            df["grenade_type"] = gtype
            frames.append(df)

        if not frames:
            return pd.DataFrame(
                columns=["land_tick", "thrower_steamid", "land_x", "land_y", "land_z", "grenade_type"]
            )

        return pd.concat(frames, ignore_index=True)

    def _extract_rounds(self, parser) -> pd.DataFrame:
        """
        Extract round_end events to know which team won each round.
        demoparser2 on CS2 emits winner as a string ("CT" / "T" / NaN) and
        includes a dummy pre-match row at tick=0 which we drop.
        """
        try:
            df = parser.parse_event("round_end")
        except Exception as exc:
            logger.error("round_end parse failed: %s", exc)
            return pd.DataFrame()

        if df is None or df.empty:
            return pd.DataFrame()

        df = df.dropna(subset=["winner"])
        df = df[df["round"] > 0]
        if df.empty:
            return pd.DataFrame()

        out = pd.DataFrame(
            {
                "tick": df["tick"].astype("int64"),
                "round_number": df["round"].astype("int64"),
                "round_winner": df["winner"].astype(str),
            }
        ).reset_index(drop=True)
        return out

    def _extract_utility_damage(self, parser) -> pd.DataFrame:
        """
        Extract player_hurt events caused by HEs and molotov/incendiary fire.
        Smokes and flashes are excluded — they don't deal meaningful damage,
        so they should never get utility damage attributed to them.

        We also drop the `inferno`→`molotov` rename here so the downstream
        merge can key on (round, thrower, grenade_type) and only match HE
        throws to HE damage and molotov throws to molotov/incendiary damage.
        """
        try:
            df = parser.parse_event("player_hurt")
        except Exception as exc:
            logger.error("player_hurt parse failed: %s", exc)
            return pd.DataFrame()

        if df is None or df.empty:
            return pd.DataFrame()

        weapon_to_type = {
            "hegrenade": "hegrenade",
            "molotov": "molotov",
            "inferno": "molotov",  # CT-side incendiary lands as 'inferno' in player_hurt
        }
        df = df.copy()
        df["grenade_type"] = df["weapon"].astype(str).str.lower().map(weapon_to_type)
        df = df.dropna(subset=["grenade_type", "attacker_steamid"])
        if df.empty:
            return pd.DataFrame()

        return df[["tick", "attacker_steamid", "grenade_type", "dmg_health"]].reset_index(
            drop=True
        )

    def _merge(
        self,
        grenades: pd.DataFrame,
        rounds: pd.DataFrame,
        damage: pd.DataFrame,
    ) -> pd.DataFrame:
        """
        Merge grenade throws with round outcomes and utility damage.
        Neither grenade_thrown nor player_hurt events carry round_number,
        so we build a tick→round index from round_end ticks and assign
        to both frames.
        """
        def assign_rounds(ticks: pd.Series) -> pd.Series:
            # Each round_end tick is the END of round N. A tick at or before
            # the first round_end belongs to round 1, and so on. searchsorted
            # with side='left' maps tick → index of the first end_tick >= tick.
            end_ticks = rounds["tick"].to_numpy()
            round_numbers = rounds["round_number"].to_numpy()
            idx = np.searchsorted(end_ticks, ticks.to_numpy(), side="left")
            idx = np.clip(idx, 0, len(round_numbers) - 1)
            return pd.Series(round_numbers[idx], index=ticks.index)

        if rounds.empty:
            grenades["round_number"] = 0
            grenades["round_winner"] = None
        else:
            rounds = rounds.sort_values("tick").reset_index(drop=True)
            grenades["round_number"] = assign_rounds(grenades["tick"])
            grenades = grenades.merge(
                rounds[["round_number", "round_winner"]],
                on="round_number",
                how="left",
            )

        if not damage.empty and not rounds.empty:
            damage = damage.copy()
            damage["round_number"] = assign_rounds(damage["tick"])
            # Credit damage to the specific thrower and weapon that caused it.
            # Smokes/flashes never appear as a `grenade_type` here, so their
            # utility_damage will stay 0 after the left-join + fillna.
            by_thrower = (
                damage.groupby(
                    ["round_number", "attacker_steamid", "grenade_type"]
                )["dmg_health"]
                .sum()
                .reset_index()
                .rename(
                    columns={
                        "attacker_steamid": "thrower_steamid",
                        "dmg_health": "utility_damage",
                    }
                )
            )
            grenades = grenades.merge(
                by_thrower,
                on=["round_number", "thrower_steamid", "grenade_type"],
                how="left",
            )
            grenades["utility_damage"] = grenades["utility_damage"].fillna(0.0)
        else:
            grenades["utility_damage"] = 0.0

        # Safety nets — _extract_grenades should already provide these, but
        # keep the fallbacks so a downstream change can't silently break the
        # clusterer's required-column contract.
        for col in ("land_x", "land_y", "land_z"):
            if col not in grenades.columns:
                grenades[col] = np.nan

        # Ensure pitch/yaw exist
        for col in ("pitch", "yaw"):
            if col not in grenades.columns:
                grenades[col] = 0.0

        # Ensure throw-technique/click columns exist even when classification
        # was skipped (e.g. an empty throws frame).
        for col in ("throw_technique", "click_type"):
            if col not in grenades.columns:
                grenades[col] = None

        desired = [
            "tick", "round_number", "thrower_steamid", "thrower_name",
            "team_num", "grenade_type", "map_name",
            "throw_x", "throw_y", "throw_z",
            "land_x", "land_y", "land_z",
            "pitch", "yaw",
            "throw_technique", "click_type",
            "round_winner", "utility_damage",
        ]
        for col in desired:
            if col not in grenades.columns:
                grenades[col] = None

        return grenades[desired].copy()

    def _infer_map(self, parser) -> str:
        """Try to infer the map name from demo header or fallback to 'unknown'."""
        try:
            header = parser.parse_header()
            return header.get("map_name", "unknown")
        except Exception:
            return "unknown"
