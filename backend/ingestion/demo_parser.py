"""
Demo parser — wraps demoparser2 to extract grenade and round data from CS2 .dem files.

NOTE — TIMELINE_CACHE_VERSION
-----------------------------
Bump this whenever `extract_match_timeline()` adds new fields, new event types,
or otherwise changes the JSON shape so existing on-disk caches no longer
contain the data the frontend / analysis code expects. `_ensure_timeline_for_demo`
in main.py reads this and silently re-parses any stale cache. Without this,
old caches stay frozen at e.g. zero damage forever after a parser upgrade.


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

# Bump when the timeline JSON shape or field set changes — see module docstring.
# v4 drops restarted/replayed rounds (pre-live FACEIT rounds, backup restores)
# and adds final_score / team_names from the game's own scoreboard.
# v3 adds round.freeze_end_tick + round_freeze_end events for timeout-aware
# cross-round alignment in the patterns view.
# v2 added player_hurt events ("hurt"); v1 was the pre-hurt schema.
TIMELINE_CACHE_VERSION = 4

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

# Current CS2 builds stop networking the pawn's button mask (`buttons` comes
# back as no column). The held grenade's throw strength survives and encodes
# the same thing: 1.0 = left click, 0.0 = right click, 0.5 = both. Sampled
# at release-1 on the old demos it agrees with the buttons-derived click on
# 4,604 of 4,612 throws where buttons gave an answer (and also resolves the
# ~8% where buttons read "none").
THROW_STRENGTH_PROP = "Grenade.m_flThrowStrength"

# parse_grenades() reuses projectile entity ids: once a grenade's entity is
# freed, a later grenade can get the same id. A tick gap longer than this
# (3 s at 64-tick) inside one entity id marks a new projectile lifetime.
PROJECTILE_GAP_TICKS = 192

# Player props sampled for throws synthesised from projectiles. Identical to
# the `player=[...]` list of the grenade_thrown path so both produce the same
# columns.
_THROW_PLAYER_PROPS = [
    "X", "Y", "Z", "pitch", "yaw", "team_num",
    "velocity_X", "velocity_Y", "velocity_Z",
    "is_walking", "ducking", "duck_amount",
    "buttons",
]

# Ticks after a round_end at which round counters / team scores are sampled.
# One second gives the engine time to bump total_rounds_played.
ROUND_COUNTER_DELAY_TICKS = 64

# Projectile class-name tokens (after normalisation) → grenade_type.
_PROJECTILE_TYPE_ALIASES = {
    **WEAPON_TO_TYPE,
    "incendiary": "molotov",
    "incendiarygrenade": "molotov",
    "smoke": "smokegrenade",
    "he": "hegrenade",
    "flash": "flashbang",
}


def _normalise_projectile_types(series: pd.Series) -> pd.Series:
    """
    Map parse_grenades() class names (CSmokeGrenadeProjectile,
    CHEGrenadeProjectile, CFlashbangProjectile, CMolotovProjectile,
    CDecoyProjectile, …) to grenade_type tokens. Unknown names map to NaN.
    Works on the unique values only — the raw frame has millions of rows.
    """
    import re

    def _one(raw: str) -> Optional[str]:
        s = str(raw).lower().replace("projectile", "").replace("_", "")
        s = re.sub(r"^c(?=smoke|he|flash|molotov|decoy|incendiary)", "", s)
        return _PROJECTILE_TYPE_ALIASES.get(s) or _PROJECTILE_TYPE_ALIASES.get(s + "grenade")

    lookup = {u: _one(u) for u in pd.unique(series.astype(str))}
    return series.astype(str).map(lookup)


def _projectile_segments(raw) -> pd.DataFrame:
    """
    Clean parse_grenades() output into per-tick projectile samples with a
    `seg` id per projectile lifetime.

    Rows without a position are dropped (demoparser2 emits rows for entities
    that don't exist yet), grenade_type is normalised, and a new segment
    starts whenever the entity id, thrower or type changes or the entity's
    tick stream has a gap > PROJECTILE_GAP_TICKS (entity id recycling).

    Columns: grenade_type, grenade_entity_id, x, y, z, tick, steamid (raw),
    name, seg. Sorted by (seg, tick). Empty frame when unusable.
    """
    cols = ["grenade_type", "grenade_entity_id", "x", "y", "z", "tick", "steamid", "name"]
    if raw is None or not hasattr(raw, "columns") or len(raw) == 0:
        return pd.DataFrame(columns=cols + ["seg"])
    needed = {"grenade_type", "grenade_entity_id", "x", "y", "tick", "steamid"}
    if not needed.issubset(raw.columns):
        logger.warning("parse_grenades() returned unexpected columns: %s", list(raw.columns))
        return pd.DataFrame(columns=cols + ["seg"])

    g = raw.dropna(subset=["x", "y"])
    g = g[[c for c in cols if c in g.columns]].copy()
    for c in ("z", "name"):
        if c not in g.columns:
            g[c] = np.nan
    g["grenade_type"] = _normalise_projectile_types(g["grenade_type"])
    g = g.dropna(subset=["grenade_type"])
    if g.empty:
        return pd.DataFrame(columns=cols + ["seg"])

    g = g.sort_values(["grenade_entity_id", "tick"], kind="stable").reset_index(drop=True)
    ent = g["grenade_entity_id"].to_numpy()
    tick = g["tick"].to_numpy(dtype="int64")
    sid = g["steamid"].to_numpy()
    gtype = g["grenade_type"].to_numpy()
    new = np.ones(len(g), dtype=bool)
    new[1:] = (
        (ent[1:] != ent[:-1])
        | ((tick[1:] - tick[:-1]) > PROJECTILE_GAP_TICKS)
        | (sid[1:] != sid[:-1])
        | (gtype[1:] != gtype[:-1])
    )
    g["seg"] = np.cumsum(new) - 1
    return g


def _landing_index(xy: np.ndarray, still_sq: float = 4.0, still_count: int = 3) -> int:
    """
    Index of the landing sample in a per-tick [x, y] path: the first point
    after which the projectile moves < 2 units/tick for `still_count`
    consecutive ticks. Returns the last index when it never settles.
    """
    if len(xy) < 2:
        return len(xy) - 1
    d = np.diff(xy, axis=0)
    still = (d[:, 0] * d[:, 0] + d[:, 1] * d[:, 1]) < still_sq
    run = 0
    for i, s in enumerate(still, start=1):
        if s:
            run += 1
            if run >= still_count:
                return i - still_count
        else:
            run = 0
    return len(xy) - 1


def _steamid_str(v) -> Optional[str]:
    """Steamid as a string; None for missing / zero ids."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v)
    if s.endswith(".0"):
        s = s[:-2]
    return None if s in ("", "0", "nan", "None") else s


def _round_end_rows(parser) -> list[dict]:
    """Real round_end events (tick > 0 with a winner), sorted by tick."""
    try:
        ends = parser.parse_event("round_end")
    except Exception as exc:
        logger.error("round_end parse failed: %s", exc)
        return []
    if ends is None or len(ends) == 0:
        return []
    rows: list[dict] = []
    for row in ends.to_dict(orient="records"):
        t = row.get("tick")
        w = row.get("winner")
        if t is None or w is None:
            continue
        try:
            if pd.isna(w):
                continue
        except (TypeError, ValueError):
            pass
        w = str(w)
        # demoparser2 emits a pre-match dummy round_end at tick 0/1 with no
        # winner; the winner check drops it, the tick check is belt-and-braces.
        if int(t) <= 0 or not w:
            continue
        rows.append({"tick": int(t), "winner": w, "round": row.get("round")})
    rows.sort(key=lambda r: r["tick"])
    return rows


def _sample_round_state(parser, end_ticks: list[int]) -> dict:
    """
    One parse_ticks call sampling, for every round_end tick E, the game's
    `total_rounds_played` counter and per-team `team_rounds_total` at
    E + ROUND_COUNTER_DELAY_TICKS (falling back to E when the demo ends
    sooner).

    Returns:
        {"counters": [int|None per end tick],
         "final_score": {"T": x, "CT": y} | None,
         "team_names": {"T": name, "CT": name} | None}
    """
    out: dict = {"counters": [None] * len(end_ticks), "final_score": None, "team_names": None}
    if not end_ticks:
        return out
    ticks = sorted({int(t) for t in end_ticks} | {int(t) + ROUND_COUNTER_DELAY_TICKS for t in end_ticks})
    df = None
    for props in (
        ["total_rounds_played", "team_rounds_total", "team_num", "team_clan_name"],
        ["total_rounds_played", "team_rounds_total", "team_num"],
    ):
        try:
            df = parser.parse_ticks(props, ticks=ticks)
            break
        except Exception as exc:
            logger.debug("round-state parse_ticks(%s) failed: %s", props, exc)
    if df is None or len(df) == 0 or "tick" not in df.columns:
        return out

    by_tick = {int(t): grp for t, grp in df.groupby("tick", sort=False)}

    def _sample(end_tick: int):
        return by_tick.get(end_tick + ROUND_COUNTER_DELAY_TICKS, by_tick.get(end_tick))

    if "total_rounds_played" in df.columns:
        for i, e in enumerate(end_ticks):
            grp = _sample(int(e))
            if grp is None:
                continue
            vals = grp["total_rounds_played"].dropna()
            if len(vals):
                out["counters"][i] = int(vals.max())

    last = _sample(int(end_ticks[-1]))
    if last is not None and {"team_num", "team_rounds_total"}.issubset(last.columns):
        score: dict[str, int] = {}
        names: dict[str, str] = {}
        for tn, grp in last.groupby("team_num"):
            label = TEAM_NUM_TO_LABEL.get(int(tn)) if pd.notna(tn) else None
            if label is None:
                continue
            vals = grp["team_rounds_total"].dropna()
            if len(vals):
                score[label] = int(vals.max())
            if "team_clan_name" in grp.columns:
                nm = grp["team_clan_name"].dropna().astype(str).str.strip()
                nm = nm[nm != ""]
                if len(nm):
                    names[label] = str(nm.mode().iloc[0])
        if set(score) == {"T", "CT"}:
            out["final_score"] = score
        if names:
            out["team_names"] = names
    return out


def live_round_mask(counters: list[Optional[int]]) -> list[bool]:
    """
    Which rounds survive restarts / backup restores.

    `counters[i]` is total_rounds_played shortly after round i ended. A round
    is dropped when a later round shows the same or a lower counter — i.e.
    the game was restarted (mp_restartgame after a pre-live round) or a
    backup was restored and that round number replayed. For the common
    cases this keeps the LAST round for each counter value. Rounds with an
    unknown counter (None) are always kept and never cause drops.
    """
    keep = [True] * len(counters)
    later_min: Optional[int] = None
    for i in range(len(counters) - 1, -1, -1):
        c = counters[i]
        if c is None:
            continue
        if later_min is not None and c >= later_min:
            keep[i] = False
        later_min = c if later_min is None else min(later_min, c)
    return keep


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
        # (parser, cleaned projectile segments) for the demo being parsed, so
        # throw synthesis and trajectory extraction share one parse_grenades().
        self._raw_grenades_cache: Optional[tuple] = None

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

        try:
            grenades_df = self._extract_grenades(parser, player_names=name_filter)
        finally:
            # parse_grenades() output is millions of rows — drop the cache.
            self._raw_grenades_cache = None
        if grenades_df.empty:
            logger.warning("No grenade events found in %s", demo_path)
            return pd.DataFrame()

        rounds_df = self._extract_rounds(parser)
        damage_df = self._extract_utility_damage(parser)

        df = self._merge(grenades_df, rounds_df, damage_df)
        if df.empty:
            logger.warning("No grenade throws inside live rounds in %s", demo_path)
            return pd.DataFrame()
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
        source = throws.attrs.get("source", "grenade_thrown")

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
            group["tick"] = group["tick"].astype("int64")
            land_group = lands[lands["grenade_type"] == gtype].sort_values("land_tick").copy()
            land_group["land_tick"] = land_group["land_tick"].astype("int64")

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
            "  %s: %d throws, %d matched to landings, %d with trajectories",
            source,
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
        """
        One row per thrown grenade: throw pos, angles, team, weapon.

        Uses the `grenade_thrown` game event when the demo has it. Current
        CS2 builds (≈ patch 14188+) no longer emit that event, so for those
        demos the rows are synthesised from projectile trajectories instead
        (see _synthesise_throws_from_projectiles). The returned frame's
        `attrs["source"]` names the path that produced it.
        """
        try:
            game_events = set(parser.list_game_events())
        except Exception as exc:
            logger.debug("list_game_events failed: %s", exc)
            game_events = None

        df = None
        if game_events is None or "grenade_thrown" in game_events:
            df = self._parse_grenade_thrown_events(parser)
        if df is None or len(df) == 0:
            df = self._synthesise_throws_from_projectiles(parser)
            if df is None or len(df) == 0:
                return pd.DataFrame()
            source = "projectiles"
        else:
            source = "grenade_thrown"

        df = self._finish_throw_rows(df, player_names=player_names)
        df.attrs["source"] = source
        return df

    def _parse_grenade_thrown_events(self, parser) -> Optional[pd.DataFrame]:
        """Raw grenade_thrown rows with the user_* player props, or None."""
        # We also pull movement + stance fields so downstream throw-technique
        # classification (jump / crouch / walk / run / stand) can run without
        # a second parser pass. `buttons` here captures the post-release state
        # (usually 0); the true click is recovered via a tick-lookup on
        # parse_ticks in _attach_pre_release_buttons.
        try:
            df = parser.parse_event("grenade_thrown", player=_THROW_PLAYER_PROPS)
        except Exception as exc:
            logger.error("grenade_thrown parse failed: %s", exc)
            return None
        if df is None or len(df) == 0:
            return None
        return df

    def _raw_projectile_segments(self, parser) -> pd.DataFrame:
        """parse_grenades() → _projectile_segments(), cached per parser."""
        cached = self._raw_grenades_cache
        if cached is not None and cached[0] is parser:
            return cached[1]
        try:
            raw = parser.parse_grenades()
        except Exception as exc:
            logger.warning("parse_grenades() failed: %s", exc)
            raw = None
        segs = _projectile_segments(raw)
        self._raw_grenades_cache = (parser, segs)
        return segs

    def _synthesise_throws_from_projectiles(self, parser) -> Optional[pd.DataFrame]:
        """
        Rebuild grenade_thrown-equivalent rows from projectile trajectories,
        for demos whose CS2 build no longer emits the grenade_thrown event.

        Each projectile lifetime's first sample is the release tick T — on
        demos that still carry grenade_thrown the event fires on exactly that
        tick for the same thrower. The event's player props equal the
        thrower's state one tick earlier (T-1: feet origin — not the eye —
        view angles, stance), so we sample parse_ticks at T-2..T in a single
        batched call: T-1 for the props, T-2 for velocity, and T to check the
        thrower is still alive (grenades dropped on death spawn a projectile
        but are not throws, and fire no grenade_thrown).

        Validated against every grenade_thrown demo in demos/ (5,003 throws):
        identical tick, thrower, type, team, position, pitch/yaw, velocity,
        stance and buttons. Sampling at T instead of T-1 would put the
        position off by a median ~2.5 u. Projectiles the engine fired no
        grenade_thrown for (≈1 per 2,000) come through as extra throws.

        Returns a frame with the same raw columns as parse_event("grenade_thrown",
        player=_THROW_PLAYER_PROPS) — `tick`, `weapon`, `user_*` — so the
        shared post-processing applies unchanged.
        """
        segs = self._raw_projectile_segments(parser)
        if segs.empty:
            return None

        first = segs.groupby("seg", sort=False).first().reset_index()
        first["tick"] = first["tick"].astype("int64")
        first["sid"] = first["steamid"].map(_steamid_str)
        first = first.dropna(subset=["sid"])
        if first.empty:
            return None

        # demoparser2 derives velocity_* from the position delta to the
        # previous *sampled* tick, so with a sparse tick list it is garbage.
        # Sample T-2 as well and difference the positions ourselves — that
        # reproduces grenade_thrown's velocity exactly (64-tick).
        release = first["tick"].astype("int64")
        sample_ticks = sorted(
            set((release - 2).tolist()) | set((release - 1).tolist()) | set(release.tolist())
        )
        sample_ticks = [int(t) for t in sample_ticks if t >= 0]
        props = [p for p in _THROW_PLAYER_PROPS if not p.startswith("velocity_")]
        try:
            states = parser.parse_ticks(
                props + ["is_alive", "active_weapon_name", THROW_STRENGTH_PROP],
                ticks=sample_ticks,
            )
        except Exception as exc:
            logger.error("parse_ticks for synthesised throws failed: %s", exc)
            return None
        if states is None or len(states) == 0:
            return None
        states = states.copy()
        states["sid"] = states["steamid"].map(_steamid_str)
        states["tick"] = states["tick"].astype("int64")

        pre = states.rename(columns={c: f"user_{c}" for c in props})
        pre = pre.rename(columns={
            "name": "user_name",
            "active_weapon_name": "_held_weapon",
            THROW_STRENGTH_PROP: "user_throw_strength",
        })
        pre["state_tick"] = pre["tick"]
        pre = pre.drop(columns=["tick", "steamid", "is_alive"], errors="ignore")

        prev = states[["tick", "sid", "X", "Y", "Z"]].rename(
            columns={"tick": "prev_tick", "X": "_px", "Y": "_py", "Z": "_pz"}
        )

        out = first[["tick", "sid", "grenade_type", "name"]].copy()
        out["state_tick"] = out["tick"] - 1
        out["prev_tick"] = out["tick"] - 2
        out = out.merge(pre, on=["state_tick", "sid"], how="left")
        out = out.merge(prev, on=["prev_tick", "sid"], how="left")
        tick_rate = 64.0
        out["user_velocity_X"] = (out["user_X"] - out["_px"]) * tick_rate
        out["user_velocity_Y"] = (out["user_Y"] - out["_py"]) * tick_rate
        out["user_velocity_Z"] = (out["user_Z"] - out["_pz"]) * tick_rate

        # Grenades dropped by a dying player spawn a projectile on the death
        # tick; the thrower is no longer alive at T. Keep rows with no sample.
        alive = states[["tick", "sid", "is_alive"]].rename(columns={"is_alive": "_alive_at_release"})
        out = out.merge(alive, on=["tick", "sid"], how="left")
        dead = out["_alive_at_release"].eq(False)
        dropped_on_death = int(dead.sum())
        out = out[~dead]

        out = out.dropna(subset=["user_X", "user_Y", "user_Z"])
        if out.empty:
            return None
        out["user_team_num"] = out["user_team_num"].fillna(0).astype("int64")

        out["user_steamid"] = out["sid"]
        out["user_name"] = out["user_name"].where(
            out["user_name"].notna() & (out["user_name"].astype(str) != ""), out["name"]
        )
        # The projectile class can't tell molotov from incendiary (both fold
        # to grenade_type "molotov"); the weapon still in hand at T-1 can.
        # Fall back to the side's default when that's missing.
        weapon = out["grenade_type"].astype(object).copy()
        is_molly = out["grenade_type"] == "molotov"
        held = out.get("_held_weapon")
        held = (
            held.astype(str).str.lower() if held is not None
            else pd.Series("", index=out.index)
        )
        is_inc = held.str.contains("incendiary") | (
            ~held.str.contains("molotov") & (out["user_team_num"] == 3)
        )
        weapon[is_molly & is_inc] = "incgrenade"
        out["weapon"] = weapon

        out = out.drop(
            columns=[
                "sid", "state_tick", "prev_tick", "_px", "_py", "_pz", "_held_weapon",
                "name", "_alive_at_release", "grenade_type",
            ],
            errors="ignore",
        )
        out = out.sort_values("tick").reset_index(drop=True)
        logger.info(
            "  no grenade_thrown event — synthesised %d throws from projectiles "
            "(%d death drops skipped)",
            len(out), dropped_on_death,
        )
        return out

    def _finish_throw_rows(
        self,
        df: pd.DataFrame,
        *,
        player_names: Optional[set[str]] = None,
    ) -> pd.DataFrame:
        """Rename raw grenade_thrown-style columns, map weapon → grenade_type, filter."""
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
                "user_throw_strength": "throw_strength",
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
            "buttons_at_throw", "throw_strength",
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

        if wanted is None or len(wanted) == 0 or "buttons" not in wanted.columns:
            # Newer demos don't network the button mask at all.
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

        # Demos without a button mask: decode the grenade's throw strength
        # (only present on synthesised rows) wherever buttons said nothing.
        if "throw_strength" in df.columns:
            s = pd.to_numeric(df["throw_strength"], errors="coerce")
            from_strength = np.where(
                s >= 0.75, "left", np.where(s <= 0.25, "right", "both")
            )
            use = (df["click_type"] == "none") & s.notna()
            df.loc[use, "click_type"] = from_strength[use.to_numpy()]

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
        _projectile_segments() drops the empty rows, normalises the class
        names (CSmokeGrenadeProjectile → smokegrenade, …) and splits recycled
        entity ids into separate lifetimes. Each lifetime's path is cut at the
        landing (a smoke's projectile sits still for ~18 s afterwards) and
        decimated to at most 50 points (always keeping first/last) to keep
        the final JSON payload small.

        Columns in the returned frame:
            entity_id, grenade_type, steamid, first_tick, trajectory
        where `trajectory` is a list of [x, y] float pairs in tick order.
        The frame is empty when parse_grenades() is unavailable or errored;
        callers should treat that as "no trajectories" rather than a fault.
        """
        empty_cols = ["entity_id", "grenade_type", "steamid", "first_tick", "trajectory"]
        segs = self._raw_projectile_segments(parser)
        if segs.empty:
            return pd.DataFrame(columns=empty_cols)

        rows: list[dict] = []
        for _seg, group in segs.groupby("seg", sort=False):
            if len(group) < 2:
                continue
            sid = _steamid_str(group["steamid"].iloc[0])
            if sid is None:
                continue
            pts = group[["x", "y"]].to_numpy(dtype=float)
            pts = pts[: max(_landing_index(pts), 1) + 1]
            if len(pts) > 50:
                stride = max(1, len(pts) // 50)
                idx = list(range(0, len(pts), stride))
                if idx[-1] != len(pts) - 1:
                    idx.append(len(pts) - 1)
                pts = pts[idx]
            trajectory = [[round(float(x), 1), round(float(y), 1)] for x, y in pts]
            rows.append(
                {
                    "entity_id": int(group["grenade_entity_id"].iloc[0]),
                    "grenade_type": str(group["grenade_type"].iloc[0]),
                    "steamid": sid,
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
        left["tick"] = left["tick"].astype("int64")
        left["_throw_idx"] = np.arange(len(left))
        left["_sid"] = left["thrower_steamid"].astype(str)
        left["grenade_type"] = left["grenade_type"].astype(str)
        # merge_asof needs both sides sorted on the `on` key globally.
        left = left.sort_values("tick", kind="stable").reset_index(drop=True)

        right = traj_df.rename(columns={"steamid": "_sid"}).copy()
        right["_sid"] = right["_sid"].astype(str)
        right = right[["first_tick", "_sid", "grenade_type", "trajectory"]].copy()
        right["first_tick"] = right["first_tick"].astype("int64")
        right["grenade_type"] = right["grenade_type"].astype(str)
        right = right.sort_values("first_tick", kind="stable").reset_index(drop=True)

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
        trajs = [v if isinstance(v, list) else None for v in merged["trajectory"].tolist()]
        out["trajectory"] = pd.Series(trajs, index=out.index, dtype=object)
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

        Rounds wiped by a restart or backup restore (see live_round_mask)
        stay in the frame with live=False so _merge can drop the throws made
        in them; live rounds are numbered 1..N in tick order, matching the
        replay timeline's round numbers.
        """
        end_rows = _round_end_rows(parser)
        if not end_rows:
            return pd.DataFrame()

        state = _sample_round_state(parser, [r["tick"] for r in end_rows])
        live = live_round_mask(state["counters"])
        numbers: list[int] = []
        n = 0
        for is_live in live:
            if is_live:
                n += 1
            numbers.append(n if is_live else 0)
        if not all(live):
            logger.info(
                "  dropping %d restarted/replayed round(s) of %d",
                len(live) - sum(live), len(live),
            )

        return pd.DataFrame(
            {
                "tick": [r["tick"] for r in end_rows],
                "round_number": numbers,
                "round_winner": [r["winner"] for r in end_rows],
                "live": live,
            }
        ).astype({"tick": "int64", "round_number": "int64", "live": bool})

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
        def round_index(ticks: pd.Series) -> np.ndarray:
            # Each round_end tick is the END of round N. A tick at or before
            # the first round_end belongs to round 1, and so on. searchsorted
            # with side='left' maps tick → index of the first end_tick >= tick.
            end_ticks = rounds["tick"].to_numpy()
            idx = np.searchsorted(end_ticks, ticks.to_numpy(), side="left")
            return np.clip(idx, 0, len(end_ticks) - 1)

        def assign_rounds(frame: pd.DataFrame) -> pd.DataFrame:
            """Attach round_number and drop rows inside restarted/replayed rounds."""
            idx = round_index(frame["tick"])
            frame = frame.copy()
            frame["round_number"] = rounds["round_number"].to_numpy()[idx]
            if "live" in rounds.columns:
                frame = frame[rounds["live"].to_numpy()[idx]]
            return frame

        if rounds.empty:
            grenades["round_number"] = 0
            grenades["round_winner"] = None
        else:
            rounds = rounds.sort_values("tick").reset_index(drop=True)
            grenades = assign_rounds(grenades)
            live_rounds = rounds
            if "live" in rounds.columns:
                live_rounds = rounds[rounds["live"]]
            grenades = grenades.merge(
                live_rounds[["round_number", "round_winner"]],
                on="round_number",
                how="left",
            )

        if not damage.empty and not rounds.empty:
            damage = assign_rounds(damage)
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
    # Aggregate fields (e.g. damage_total, utility_damage_total) update once
    # per round — we keep them per-tick so the frontend can diff between
    # round boundaries to derive real per-round values without a separate
    # event pass. Behaviour bools (is_scoped, is_walking, in_crouch,
    # is_defusing) power the replay viewer's player-model polish.
    _PARSE_TICK_FIELDS = [
        "X", "Y", "Z", "pitch", "yaw", "health", "is_alive", "team_num",
        "active_weapon_name", "armor_value", "has_helmet", "inventory",
        "current_equip_value", "cash_spent_this_round",
        # Per-round aggregate stats (updated once per round)
        "damage_total", "utility_damage_total", "assists_total",
        "headshot_kills_total", "enemies_flashed_total",
        "kills_total", "deaths_total", "alive_time_total",
        # Per-tick behaviour + flash state
        "flash_duration", "is_scoped", "is_walking", "in_crouch",
        "is_defusing", "shots_fired",
    ]
    try:
        ticks_df = parser.parse_ticks(_PARSE_TICK_FIELDS)
    except Exception as exc:
        # Some fields may not be supported on older demos; retry with the
        # minimal set so we still get basic playback.
        logger.warning(
            "parse_ticks with extended fields failed (%s); retrying minimal set",
            exc,
        )
        try:
            ticks_df = parser.parse_ticks([
                "X", "Y", "Z", "pitch", "yaw", "health", "is_alive", "team_num",
                "active_weapon_name", "armor_value", "has_helmet", "inventory",
                "current_equip_value", "cash_spent_this_round",
            ])
        except Exception as exc2:
            logger.error("parse_ticks failed: %s", exc2)
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

        # Persistent steamid→name table from the demo header — survives ticks
        # where the per-tick `name` field is empty/NaN (coaches re-slotted, late
        # joiners, brief team_num flips on spectators, etc.).
        info_name_by_sid: dict[str, str] = {}
        try:
            for info in parser.parse_player_info() or []:
                sid = str(info.get("steamid", ""))
                nm = str(info.get("name", "") or "").strip()
                if sid and nm:
                    info_name_by_sid[sid] = nm
        except Exception as exc:
            logger.debug("parse_player_info failed: %s", exc)

        # Build the player roster once using the mode of name/team per steamid.
        roster_rows: list[dict] = []
        for sid, group in df.groupby("steamid", sort=False):
            name_series = group.get("name")
            name = ""
            if name_series is not None:
                # Drop NaN/empty before taking the mode so a sparsely-named
                # slot still recovers its real name from the few good ticks.
                cleaned = name_series.dropna().astype(str).str.strip()
                cleaned = cleaned[(cleaned != "") & (cleaned.str.lower() != "nan")]
                if len(cleaned):
                    mode_vals = cleaned.mode()
                    if len(mode_vals):
                        name = str(mode_vals.iloc[0])
            if not name:
                # Fall back to demo header roster
                name = info_name_by_sid.get(str(sid), "")
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

        def _safe_int(v, default=0) -> int:
            """Convert to int, treating NaN/None/inf as default."""
            if v is None:
                return default
            try:
                import math
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    return default
            except (TypeError, ValueError):
                pass
            try:
                return int(v)
            except (TypeError, ValueError):
                return default

        real_sids = {r["steamid"] for r in players}
        for sid, group in df.groupby("steamid", sort=False):
            if sid not in real_sids:
                continue
            group = group.sort_values("tick")
            samples: list[dict] = []
            for row in group.itertuples(index=False):
                wpn = str(getattr(row, "active_weapon_name", "") or "")
                # Strip "weapon_" prefix if present
                if wpn.startswith("weapon_"):
                    wpn = wpn[7:]
                armor = _safe_int(getattr(row, "armor_value", 0))
                helmet = bool(getattr(row, "has_helmet", False))
                tn = _safe_int(getattr(row, "team_num", 0))

                # Extract inventory if present. Demoparser2 often returns a list or a string.
                inv_raw = getattr(row, "inventory", None)
                inv_list = []
                if isinstance(inv_raw, str):
                    try:
                        import json
                        # Try to use json for performance, replacing single quotes with double
                        # just in case it is a python repr of list of strings.
                        if inv_raw.startswith('[') and inv_raw.endswith(']'):
                            inv_raw = json.loads(inv_raw.replace("'", '"'))
                    except Exception:
                        pass
                if isinstance(inv_raw, list):
                    for w in inv_raw:
                        w_str = str(w)
                        if w_str.startswith("weapon_"):
                            w_str = w_str[7:]
                        inv_list.append(w_str)

                # Optional new fields — guarded so old demos still parse.
                def _opt_int(name: str):
                    v = getattr(row, name, None)
                    if v is None:
                        return None
                    try:
                        import math
                        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                            return None
                    except Exception:
                        pass
                    try:
                        return int(v)
                    except (TypeError, ValueError):
                        return None

                def _opt_float(name: str):
                    v = getattr(row, name, None)
                    if v is None:
                        return None
                    try:
                        import math
                        f = float(v)
                        if math.isnan(f) or math.isinf(f):
                            return None
                        return round(f, 2)
                    except (TypeError, ValueError):
                        return None

                def _opt_bool(name: str):
                    v = getattr(row, name, None)
                    if v is None:
                        return None
                    return bool(v)

                sample = {
                    "t": int(getattr(row, "tick")),
                    "x": round(float(getattr(row, "X", 0.0) or 0.0), 1),
                    "y": round(float(getattr(row, "Y", 0.0) or 0.0), 1),
                    "yaw": round(float(getattr(row, "yaw", 0.0) or 0.0), 1),
                    "alive": bool(getattr(row, "is_alive", False)),
                    "hp": _safe_int(getattr(row, "health", 0)),
                    "w": wpn if wpn else "",
                    "ar": armor,
                    "hl": helmet,
                    "tn": tn,
                    "inv": inv_list,
                    "eq": _safe_int(getattr(row, "current_equip_value", 0)),
                    "cs": _safe_int(getattr(row, "cash_spent_this_round", 0)),
                }
                # Per-round aggregates (Optional — omit when None to keep payload small)
                for src, dst in (
                    ("damage_total", "dmg"),
                    ("utility_damage_total", "utildmg"),
                    ("assists_total", "ast"),
                    ("headshot_kills_total", "hsk"),
                    ("enemies_flashed_total", "flashed"),
                    ("kills_total", "ktot"),
                    ("deaths_total", "dtot"),
                    ("alive_time_total", "atime"),
                    ("shots_fired", "sf"),
                ):
                    iv = _opt_int(src)
                    if iv is not None:
                        sample[dst] = iv
                # Flash duration (float seconds)
                fv = _opt_float("flash_duration")
                if fv is not None and fv > 0.0:
                    sample["fd"] = fv
                # Behaviour bools — only emit when True (keeps cache small)
                for src, dst in (
                    ("is_scoped", "sc"),
                    ("is_walking", "wlk"),
                    ("in_crouch", "cr"),
                    ("is_defusing", "dfu"),
                ):
                    bv = _opt_bool(src)
                    if bv:
                        sample[dst] = True
                samples.append(sample)
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
                "penetrated": _str(r.get("penetrated")),
                "noscope": _str(r.get("noscope")),
                "attackerblind": _str(r.get("attackerblind")),
                "thrusmoke": _str(r.get("thrusmoke")),
                "dominated": _str(r.get("dominated")),
                "revenge": _str(r.get("revenge")),
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
    # Utility damage — only push hurt events caused by HE/molly/inferno so we
    # can attach damage labels to the corresponding grenade on the map.
    _UTIL_HURT_WEAPONS = {"hegrenade", "molotov", "inferno", "incgrenade"}
    _push_events(
        "player_hurt",
        lambda r: (
            ("hurt", {
                "attacker": _str(r.get("attacker_steamid")),
                "victim": _str(r.get("user_steamid")),
                "weapon": _str(r.get("weapon")),
                "dmg": _str(r.get("dmg_health")),
                "x": _str(r.get("user_X", "")),
                "y": _str(r.get("user_Y", "")),
            }) if _str(r.get("weapon")) in _UTIL_HURT_WEAPONS else None
        ),
    )
    # demoparser2 returns bomb site as an entity index (e.g. 504, 505).
    # Track the first two unique indices seen and map them to A / B.
    _bomb_site_ids: dict[str, str] = {}

    def _site_label(raw: str) -> str:
        """Convert a demoparser2 site entity index to 'A' or 'B'."""
        if raw in ("A", "B", "a", "b"):
            return raw.upper()
        if raw not in _bomb_site_ids:
            if len(_bomb_site_ids) == 0:
                _bomb_site_ids[raw] = "A"
            elif len(_bomb_site_ids) == 1:
                # Lower entity ID → A, higher → B
                existing_raw = next(iter(_bomb_site_ids))
                try:
                    if int(raw) < int(existing_raw):
                        _bomb_site_ids[existing_raw] = "B"
                        _bomb_site_ids[raw] = "A"
                    else:
                        _bomb_site_ids[raw] = "B"
                except ValueError:
                    _bomb_site_ids[raw] = "B"
            else:
                _bomb_site_ids[raw] = "?"
        return _bomb_site_ids.get(raw, "?")

    _push_events(
        "bomb_planted",
        lambda r: (
            "bomb_plant",
            {
                "planter": _str(r.get("user_steamid")),
                "site": _site_label(_str(r.get("site"))),
                "x": _str(r.get("user_X", "")),
                "y": _str(r.get("user_Y", "")),
            },
        ),
    )
    _push_events(
        "bomb_defused",
        lambda r: (
            "bomb_defuse",
            {
                "defuser": _str(r.get("user_steamid")),
                "site": _site_label(_str(r.get("site"))),
            },
        ),
    )

    # Rounds — use round_start / round_freeze_end / round_end to build a
    # rounds list, and also push the raw events so the frontend can render
    # start/end markers.
    #
    # round_freeze_end is the tick where freeze ends and players can move.
    # It's the right anchor for cross-round alignment in the patterns view
    # because freeze duration varies (tactical timeouts extend freeze by
    # ~30s but round_start still fires at the start of the freeze block).
    rounds: list[dict] = []
    try:
        starts = parser.parse_event("round_start")
    except Exception:
        starts = None
    try:
        freeze_ends = parser.parse_event("round_freeze_end")
    except Exception:
        freeze_ends = None
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

    freeze_end_ticks: list[int] = []
    if freeze_ends is not None and len(freeze_ends):
        freeze_end_ticks = sorted(int(t) for t in freeze_ends["tick"].tolist() if int(t) > 0)
        for t in freeze_end_ticks:
            events.append({"type": "round_freeze_end", "tick": int(t), "data": {}})

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
    # freeze_end_tick is the latest round_freeze_end at-or-before round_end.
    prev_end = 0
    for i, er in enumerate(end_rows):
        start_tick = 0
        if start_ticks:
            before = [s for s in start_ticks if s <= er["tick"]]
            if before:
                start_tick = before[-1]
        if start_tick == 0:
            start_tick = prev_end
        freeze_end_tick = 0
        if freeze_end_ticks:
            fbefore = [t for t in freeze_end_ticks if start_tick <= t <= er["tick"]]
            if fbefore:
                freeze_end_tick = fbefore[-1]
        rounds.append(
            {
                "num": i + 1,
                "start_tick": int(start_tick),
                "freeze_end_tick": int(freeze_end_tick) if freeze_end_tick else None,
                "end_tick": int(er["tick"]),
                "winner": er["winner"],
            }
        )
        prev_end = er["tick"]

    # Drop rounds that a restart or backup restore wiped out. FACEIT demos
    # often record a ~20 s pre-live round before mp_restartgame; HLTV demos
    # can repeat round numbers after a technical-pause backup restore. The
    # game's own total_rounds_played counter (sampled 1 s after each
    # round_end) says which rounds stood — see live_round_mask. The raw
    # round_end events above stay in `events`: they did happen, and the
    # replay viewer's bomb-timer reset keys off them.
    round_state = _sample_round_state(parser, [r["end_tick"] for r in rounds])
    live = live_round_mask(round_state["counters"])
    if not all(live):
        logger.info(
            "%s: dropping %d restarted/replayed round(s) of %d",
            demo_path.name, len(live) - sum(live), len(live),
        )
        rounds = [r for r, keep in zip(rounds, live) if keep]
        for i, r in enumerate(rounds, start=1):
            r["num"] = i

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
        "cache_version": TIMELINE_CACHE_VERSION,
        "map_name": map_name,
        "tick_rate": 64,
        "decimation": decimation,
        "tick_max": tick_max,
        "players": players,
        "positions": positions,
        "grenades": grenades,
        "events": events,
        "rounds": rounds,
        # Authoritative scoreboard (team_rounds_total) at the last round_end,
        # keyed by the side each team finished on; None when unavailable.
        "final_score": round_state["final_score"],
        "team_names": round_state["team_names"],
    }
