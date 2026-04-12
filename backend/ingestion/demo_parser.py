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

        # Real trajectory polylines from parse_grenades() — per-tick projectile
        # positions, decimated and attached to each throw so the radar can draw
        # a curved flight path instead of a straight throw→land line. Failures
        # here are non-fatal: the radar falls back to the straight line when
        # trajectory is None.
        traj_df = self._extract_grenade_trajectories(parser)
        df = self._attach_trajectories(df, traj_df)

        traj_count = 0
        if "trajectory" in df.columns:
            traj_count = int(df["trajectory"].map(lambda v: isinstance(v, list)).sum())
        logger.info(
            "  grenade_thrown: %d throws, %d matched to landings, %d with trajectories",
            len(df),
            df[["land_x", "land_y", "land_z"]].notna().all(axis=1).sum(),
            traj_count,
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

    def _extract_grenade_trajectories(self, parser) -> pd.DataFrame:
        """
        Pull per-tick projectile positions via `parse_grenades()` and reduce
        them to one row per grenade entity with the decimated 2D flight path.

        parse_grenades() returns, per tick per projectile:
            grenade_type, grenade_entity_id, x, y, z, tick, steamid, name
        Most rows are NaN — demoparser2 emits a row for every entity on every
        tick regardless of whether that entity exists yet — so we drop those
        first, then group by entity_id and take the coordinate list. Per-entity
        paths are decimated to at most 50 points (always keeping first/last)
        to keep the final JSON payload small.

        Columns in the returned frame:
            entity_id, grenade_type, steamid, first_tick, trajectory
        where `trajectory` is a list of [x, y] float pairs in tick order.
        The frame is empty when parse_grenades() is unavailable or errored;
        callers should treat that as "no trajectories" rather than a fault.
        """
        empty_cols = ["entity_id", "grenade_type", "steamid", "first_tick", "trajectory"]
        try:
            raw = parser.parse_grenades()
        except Exception as exc:
            logger.warning("parse_grenades() failed: %s", exc)
            return pd.DataFrame(columns=empty_cols)

        if raw is None or len(raw) == 0 or not hasattr(raw, "columns"):
            return pd.DataFrame(columns=empty_cols)

        needed = {"grenade_type", "grenade_entity_id", "x", "y", "tick", "steamid"}
        if not needed.issubset(raw.columns):
            logger.warning(
                "parse_grenades() returned unexpected columns: %s", list(raw.columns)
            )
            return pd.DataFrame(columns=empty_cols)

        raw = raw.dropna(subset=["x", "y"])
        if raw.empty:
            return pd.DataFrame(columns=empty_cols)

        # Normalise the grenade_type string so it lines up with the keys used
        # by grenade_thrown. parse_grenades() has historically returned values
        # like "smoke_grenade", "smokegrenade", or "smoke" depending on the
        # CS2 build, so we squash separators and try each variant.
        raw = raw.copy()
        gtype_raw = raw["grenade_type"].astype(str).str.lower()
        gtype_squashed = gtype_raw.str.replace("_", "", regex=False)
        gtype_mapped = gtype_squashed.map(WEAPON_TO_TYPE)
        fallback = gtype_raw.str.replace("_", "", regex=False) + "grenade"
        gtype_mapped = gtype_mapped.fillna(fallback.map(WEAPON_TO_TYPE))
        raw["grenade_type"] = gtype_mapped
        raw = raw.dropna(subset=["grenade_type"])
        if raw.empty:
            return pd.DataFrame(columns=empty_cols)

        raw = raw.sort_values(["grenade_entity_id", "tick"])

        rows: list[dict] = []
        for entity_id, group in raw.groupby("grenade_entity_id", sort=False):
            if len(group) < 2:
                continue
            pts = group[["x", "y"]].to_numpy(dtype=float)
            if len(pts) > 50:
                stride = max(1, len(pts) // 50)
                idx = list(range(0, len(pts), stride))
                if idx[-1] != len(pts) - 1:
                    idx.append(len(pts) - 1)
                pts = pts[idx]
            trajectory = [[round(float(x), 1), round(float(y), 1)] for x, y in pts]
            rows.append(
                {
                    "entity_id": int(entity_id),
                    "grenade_type": str(group["grenade_type"].iloc[0]),
                    "steamid": str(group["steamid"].iloc[0]),
                    "first_tick": int(group["tick"].iloc[0]),
                    "trajectory": trajectory,
                }
            )

        if not rows:
            return pd.DataFrame(columns=empty_cols)
        return pd.DataFrame(rows)

    def _attach_trajectories(
        self,
        throws: pd.DataFrame,
        traj_df: pd.DataFrame,
    ) -> pd.DataFrame:
        """
        Attach the matching projectile flight path to each throw.

        Matching rule: for each (thrower_steamid, grenade_type, throw_tick),
        find the trajectory entity whose `first_tick >= throw_tick` and is
        within 32 ticks (~0.5 s at 64-tick) of it. The grenade_thrown event
        fires at the moment the player releases the pin; the entity's first
        visible tick is the same tick or a couple later once the projectile
        spawns in-world. Using merge_asof direction="forward" with a tight
        tolerance picks the right entity without cross-matching earlier ones.
        """
        out = throws.copy()
        out["trajectory"] = None

        if out.empty or traj_df is None or traj_df.empty:
            return out

        left = out[["tick", "thrower_steamid", "grenade_type"]].copy()
        left["_throw_idx"] = np.arange(len(left))
        left["_sid"] = left["thrower_steamid"].astype(str)
        left = left.sort_values(["_sid", "grenade_type", "tick"]).reset_index(drop=True)

        right = traj_df.rename(columns={"steamid": "_sid"}).copy()
        right["_sid"] = right["_sid"].astype(str)
        right = right[["first_tick", "_sid", "grenade_type", "trajectory"]]
        right = right.sort_values(["_sid", "grenade_type", "first_tick"]).reset_index(drop=True)

        try:
            merged = pd.merge_asof(
                left,
                right,
                left_on="tick",
                right_on="first_tick",
                by=["_sid", "grenade_type"],
                direction="forward",
                tolerance=32,
            )
        except Exception as exc:
            logger.warning("trajectory merge_asof failed: %s", exc)
            return out

        merged = merged.sort_values("_throw_idx")
        out.loc[:, "trajectory"] = merged["trajectory"].tolist()
        return out

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

        # Trajectory is a list-valued object column; if the extractor never
        # ran (empty parse_grenades, older DB) it simply stays None per row.
        if "trajectory" not in grenades.columns:
            grenades["trajectory"] = None

        desired = [
            "tick", "round_number", "thrower_steamid", "thrower_name",
            "team_num", "grenade_type", "map_name",
            "throw_x", "throw_y", "throw_z",
            "land_x", "land_y", "land_z",
            "pitch", "yaw",
            "throw_technique", "click_type",
            "trajectory",
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


# ---------------------------------------------------------------------------
# Full-match timeline extraction (Match Replay viewer)
# ---------------------------------------------------------------------------
# This sits alongside DemoParser.parse_demo — it does NOT share the grenade
# clustering pipeline. That path only needs grenade_thrown + detonate + round
# events; the replay viewer needs every player's per-tick position plus kills,
# shots, bombs, and grenade trails. Parsing all of that is an order of magnitude
# heavier, so we keep it as a separate entrypoint that the /match-replay
# endpoint calls on-demand and caches to disk.

def extract_match_timeline(demo_path: Path, decimation: int = 8) -> dict:
    """
    Parse a single .dem into a JSON-serializable timeline bundle for the
    in-browser 2D replay viewer.

    Shape returned (matches backend.models.schemas.MatchTimeline):
        {
          "map_name": "de_mirage",
          "tick_rate": 64,
          "decimation": 8,
          "tick_max": 152300,
          "players": [{steamid, name, team_num}, ...],
          "positions": {steamid: [{t, x, y, yaw, alive, hp}, ...]},
          "grenades": [{type, thrower, points: [[t, x, y], ...], detonate_tick}],
          "events": [{type, tick, data: {...}}],
          "rounds": [{num, start_tick, end_tick, winner}],
        }

    `decimation` controls how aggressively per-tick position samples are
    thinned — 8 means every 8th tick (~8 Hz at 64-tick), which yields ~4 MB of
    JSON for a full match and is fine to interpolate on the frontend.
    """
    try:
        from demoparser2 import DemoParser as _DP  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "demoparser2 is not installed. Run: pip install demoparser2"
        ) from exc

    parser = _DP(str(demo_path))

    # ---- header / map --------------------------------------------------
    try:
        header = parser.parse_header()
        map_name = str(header.get("map_name", "unknown"))
    except Exception:
        map_name = "unknown"

    # ---- per-tick positions --------------------------------------------
    try:
        ticks_df = parser.parse_ticks(
            ["X", "Y", "Z", "pitch", "yaw", "health", "is_alive", "team_num"]
        )
    except Exception as exc:
        logger.error("parse_ticks failed: %s", exc)
        ticks_df = pd.DataFrame()

    positions: dict[str, list[dict]] = {}
    players: list[dict] = []
    tick_max = 0

    if ticks_df is not None and len(ticks_df) > 0:
        df = ticks_df.copy()
        if "tick" in df.columns:
            df = df[df["tick"] % decimation == 0]
        df["steamid"] = df["steamid"].astype(str)

        if len(df) > 0:
            tick_max = int(df["tick"].max())

        # Build the player roster once using the mode of name/team per steamid.
        roster_rows: list[dict] = []
        for sid, group in df.groupby("steamid", sort=False):
            name_series = group.get("name")
            if name_series is None:
                continue
            name = str(name_series.mode().iloc[0]) if len(name_series.mode()) else ""
            team_series = group.get("team_num")
            team_num = 0
            if team_series is not None and len(team_series):
                try:
                    team_num = int(team_series.mode().iloc[0])
                except Exception:
                    team_num = 0
            roster_rows.append(
                {"steamid": sid, "name": name, "team_num": team_num}
            )
        # Drop any bot/spec rows that show no team (team_num 0/1) if we also
        # have real players — this matches the frontend's expectation that
        # `players` is a clean 10-slot list.
        real = [r for r in roster_rows if r["team_num"] in (2, 3)]
        players = real if real else roster_rows

        real_sids = {r["steamid"] for r in players}
        for sid, group in df.groupby("steamid", sort=False):
            if sid not in real_sids:
                continue
            group = group.sort_values("tick")
            samples: list[dict] = []
            for row in group.itertuples(index=False):
                samples.append(
                    {
                        "t": int(getattr(row, "tick")),
                        "x": round(float(getattr(row, "X", 0.0) or 0.0), 1),
                        "y": round(float(getattr(row, "Y", 0.0) or 0.0), 1),
                        "yaw": round(float(getattr(row, "yaw", 0.0) or 0.0), 1),
                        "alive": bool(getattr(row, "is_alive", False)),
                        "hp": int(getattr(row, "health", 0) or 0),
                    }
                )
            positions[sid] = samples

    # ---- events --------------------------------------------------------
    events: list[dict] = []

    def _push_events(raw_name: str, mapper):
        try:
            edf = parser.parse_event(raw_name)
        except Exception as exc:
            logger.debug("%s parse failed: %s", raw_name, exc)
            return
        if edf is None or len(edf) == 0:
            return
        for row in edf.to_dict(orient="records"):
            tick = row.get("tick")
            if tick is None:
                continue
            try:
                payload = mapper(row)
            except Exception as exc:
                logger.debug("%s mapper failed: %s", raw_name, exc)
                continue
            if payload is None:
                continue
            events.append({"type": payload[0], "tick": int(tick), "data": payload[1]})

    def _str(v) -> str:
        if v is None:
            return ""
        try:
            if pd.isna(v):
                return ""
        except Exception:
            pass
        return str(v)

    _push_events(
        "player_death",
        lambda r: (
            "death",
            {
                "attacker": _str(r.get("attacker_steamid")),
                "victim": _str(r.get("user_steamid")),
                "weapon": _str(r.get("weapon")),
                "headshot": _str(r.get("headshot")),
            },
        ),
    )
    _push_events(
        "weapon_fire",
        lambda r: (
            "fire",
            {
                "shooter": _str(r.get("user_steamid")),
                "weapon": _str(r.get("weapon")),
            },
        ),
    )
    _push_events(
        "bomb_planted",
        lambda r: (
            "bomb_plant",
            {
                "planter": _str(r.get("user_steamid")),
                "site": _str(r.get("site")),
            },
        ),
    )
    _push_events(
        "bomb_defused",
        lambda r: (
            "bomb_defuse",
            {
                "defuser": _str(r.get("user_steamid")),
                "site": _str(r.get("site")),
            },
        ),
    )

    # Rounds — use round_start / round_end to build a rounds list, and also
    # push the raw events so the frontend can render start/end markers.
    rounds: list[dict] = []
    try:
        starts = parser.parse_event("round_start")
    except Exception:
        starts = None
    try:
        ends = parser.parse_event("round_end")
    except Exception:
        ends = None

    start_ticks: list[int] = []
    if starts is not None and len(starts):
        # Filter out the warmup round_start at tick 0 to match the round_end
        # filter below — otherwise the round pairing is off by one.
        start_ticks = sorted(int(t) for t in starts["tick"].tolist() if int(t) > 0)
        for t in start_ticks:
            events.append({"type": "round_start", "tick": int(t), "data": {}})

    end_rows: list[dict] = []
    if ends is not None and len(ends):
        for row in ends.to_dict(orient="records"):
            t = row.get("tick")
            if t is None:
                continue
            winner = _str(row.get("winner")) or None
            # Skip warmup / pre-match dummy events: tick 0 or no winner.
            # demoparser2 emits a round_end at tick=0 with winner=nan for the
            # pre-game phase. Including it off-by-ones every round number.
            if int(t) == 0 or not winner:
                continue
            end_rows.append({"tick": int(t), "winner": winner})
            events.append(
                {"type": "round_end", "tick": int(t), "data": {"winner": winner or ""}}
            )
        end_rows.sort(key=lambda r: r["tick"])

    # Pair starts/ends into numbered rounds. If starts are missing (rare on
    # old demos), fall back to using the previous end_tick as the start.
    prev_end = 0
    for i, er in enumerate(end_rows):
        start_tick = 0
        if start_ticks:
            before = [s for s in start_ticks if s <= er["tick"]]
            if before:
                start_tick = before[-1]
        if start_tick == 0:
            start_tick = prev_end
        rounds.append(
            {
                "num": i + 1,
                "start_tick": int(start_tick),
                "end_tick": int(er["tick"]),
                "winner": er["winner"],
            }
        )
        prev_end = er["tick"]

    events.sort(key=lambda e: e["tick"])

    # ---- grenade trails ------------------------------------------------
    grenades: list[dict] = []
    try:
        raw_gren = parser.parse_grenades()
    except Exception as exc:
        logger.debug("parse_grenades failed: %s", exc)
        raw_gren = None

    if raw_gren is not None and len(raw_gren) > 0 and hasattr(raw_gren, "columns"):
        needed = {"grenade_type", "grenade_entity_id", "x", "y", "tick", "steamid"}
        if needed.issubset(raw_gren.columns):
            g = raw_gren.dropna(subset=["x", "y"]).copy()
            g["steamid"] = g["steamid"].astype(str)
            # parse_grenades() returns class names like CSmokeGrenade,
            # CMolotovProjectile, CHEGrenadeProjectile, CFlashbang, etc.
            # Normalize to the tokens WEAPON_TO_TYPE expects: smokegrenade,
            # hegrenade, flashbang, molotov, decoy.
            gtype_raw = g["grenade_type"].astype(str).str.lower()
            # Strip leading "c", trailing "projectile", and underscores.
            gtype_clean = (
                gtype_raw
                .str.replace("projectile", "", regex=False)
                .str.replace("_", "", regex=False)
                .str.replace(r"^c(?=smoke|he|flash|molotov|decoy|incendiary)", "", regex=True)
            )
            g["grenade_type"] = gtype_clean.map(WEAPON_TO_TYPE)
            # Also try adding "grenade" suffix for types like "smoke" → "smokegrenade"
            fallback = (gtype_clean + "grenade").map(WEAPON_TO_TYPE)
            g["grenade_type"] = g["grenade_type"].fillna(fallback)
            g = g.dropna(subset=["grenade_type"])
            g = g.sort_values(["grenade_entity_id", "tick"])
            # grenade_entity_id is recycled by the engine — the same ID can
            # appear for completely different grenades in later rounds. Split
            # each entity group on large tick gaps (>192 = 3 seconds) to
            # isolate individual grenade lifetimes.
            GAP_THRESHOLD = 192  # 3 seconds at 64 tick/s
            STILL_THRESHOLD_SQ = 4.0  # 2² game-units squared
            STILL_COUNT = 3

            for _entity_id, entity_group in g.groupby("grenade_entity_id", sort=False):
                entity_pts = entity_group[["tick", "x", "y"]].to_numpy(dtype=float)
                entity_meta = entity_group[["grenade_type", "steamid"]]
                if len(entity_pts) < 2:
                    continue

                # Sub-split on tick gaps to handle recycled entity IDs
                splits: list[tuple[int, int]] = []  # (start_idx, end_idx) exclusive
                seg_start = 0
                for pi in range(1, len(entity_pts)):
                    if entity_pts[pi][0] - entity_pts[pi - 1][0] > GAP_THRESHOLD:
                        splits.append((seg_start, pi))
                        seg_start = pi
                splits.append((seg_start, len(entity_pts)))

                for seg_start_idx, seg_end_idx in splits:
                    pts_raw = entity_pts[seg_start_idx:seg_end_idx]
                    if len(pts_raw) < 2:
                        continue

                    # Detect landing: first tick where position stays within
                    # 2 game-units of the previous sample for 3+ consecutive
                    # frames. This runs on raw per-tick data BEFORE decimation.
                    det_idx = len(pts_raw) - 1
                    still_run = 0
                    for pi in range(1, len(pts_raw)):
                        dx = pts_raw[pi][1] - pts_raw[pi - 1][1]
                        dy = pts_raw[pi][2] - pts_raw[pi - 1][2]
                        if (dx * dx + dy * dy) < STILL_THRESHOLD_SQ:
                            still_run += 1
                            if still_run >= STILL_COUNT:
                                det_idx = pi - STILL_COUNT
                                break
                        else:
                            still_run = 0

                    detonate_tick = int(pts_raw[det_idx][0])
                    flight_pts = pts_raw[: det_idx + 1]
                    if len(flight_pts) < 2:
                        flight_pts = pts_raw[:2]

                    # Decimate: at most 60 points per projectile
                    if len(flight_pts) > 60:
                        stride = max(1, len(flight_pts) // 60)
                        idx = list(range(0, len(flight_pts), stride))
                        if idx[-1] != len(flight_pts) - 1:
                            idx.append(len(flight_pts) - 1)
                        flight_pts = flight_pts[idx]

                    points = [
                        [int(t), round(float(x), 1), round(float(y), 1)]
                        for t, x, y in flight_pts
                    ]
                    meta_row = entity_meta.iloc[
                        min(seg_start_idx, len(entity_meta) - 1)
                    ]
                    grenades.append(
                        {
                            "type": str(meta_row["grenade_type"]),
                            "thrower": str(meta_row["steamid"]),
                            "points": points,
                            "detonate_tick": detonate_tick,
                        }
                    )

    return {
        "map_name": map_name,
        "tick_rate": 64,
        "decimation": decimation,
        "tick_max": tick_max,
        "players": players,
        "positions": positions,
        "grenades": grenades,
        "events": events,
        "rounds": rounds,
    }
