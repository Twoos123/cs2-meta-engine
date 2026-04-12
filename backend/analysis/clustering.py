"""
Lineup deduplication by throw position + aim angles.

A "lineup" is physically defined by where the player stands and where they
look — if two pros reproduce the same (standing pos, pitch, yaw) on the same
map, the grenade lands in the same place every time. So instead of running
DBSCAN over landing coordinates (which merges variants that happen to land
close together), we bucket throws by rounded (throw_x, throw_y, throw_z,
pitch, yaw) and treat each bucket as one unique lineup.

After bucketing we drop any lineup whose throwing team lost the majority of
the rounds it was used in. The goal stated by the user: "every unique throw
that helped win the round, not every throw" — so a one-off winning throw
survives, a one-off losing throw is cut, and anything with a ≥50% round
win rate is kept regardless of throw count or damage.

Usage
-----
    from backend.analysis.clustering import GrenadeClusterer
    from backend.ingestion.demo_parser import DemoParser

    df = DemoParser().parse_directory(Path("demos"), map_name="de_mirage")
    clusterer = GrenadeClusterer()
    clusters = clusterer.cluster(df, map_name="de_mirage", grenade_type="smokegrenade")
    ranked   = clusterer.rank(clusters)
"""
from __future__ import annotations

import logging
from typing import List, Optional

import numpy as np
import pandas as pd

from backend.analysis import callouts
from backend.models.schemas import LineupCluster, LineupRanking, TopThrower

# Bucket tolerances for merging "the same lineup". A CS2 character is ~32
# units wide, so 75u lets a pro adjust their stance by a couple body-widths
# without fragmenting into two rows, and 6° on the aim angles absorbs the
# usual 2–4° of human aim jitter between pros reproducing the same lineup.
# These sizes were tuned after observing ~80% singletons at 50u/3° on a
# batch of 9 Mirage demos — tight bucketing was fracturing lineups on
# rounding boundaries instead of merging them.
POS_BUCKET = 75.0  # world units
ANG_BUCKET = 6.0   # degrees

# Minimum round win rate required for a lineup to survive the post-filter.
# 0.0 means "show every unique lineup" — the frontend scatter is the right
# place to filter by win rate since it can do it interactively. Hard-cutting
# at 50% here used to drop ~40% of the raw buckets (any singleton from a
# losing round) even though those throws are still valid reference data.
MIN_WIN_RATE = 0.0

logger = logging.getLogger(__name__)

# Known map-specific "interesting area" labels for auto-naming clusters.
# Keyed by map_name → list of (centroid_x, centroid_y, label) tuples.
# These are approximate world coordinates for well-known spots.
KNOWN_SPOTS: dict[str, list[tuple[float, float, str]]] = {
    "de_mirage": [
        (-300, 300, "A Site"),
        (800, -400, "B Site"),
        (300, 700, "Mid"),
        (-900, 700, "B Apartments"),
        (-1500, -800, "Mid Window"),
        (100, 200, "Top Mid"),
    ],
    "de_dust2": [
        (-900, 500, "A Site"),
        (700, -300, "B Site"),
        (-100, -200, "Mid"),
        (-1200, -100, "Long A"),
        (900, 200, "B Tunnels"),
    ],
    "de_inferno": [
        (-800, 400, "A Site"),
        (600, -500, "B Site"),
        (-100, 200, "Mid"),
        (-900, -300, "Banana"),
        (200, 500, "Arch"),
    ],
    "de_nuke": [
        (-500, 400, "A Site"),
        (300, -200, "B Site"),
        (-100, 100, "Outside"),
    ],
    "de_ancient": [
        (-700, 500, "A Site"),
        (800, -400, "B Site"),
        (0, 0, "Mid"),
    ],
    "de_anubis": [
        (-600, 400, "A Site"),
        (700, -300, "B Site"),
    ],
    "de_vertigo": [
        (-500, 300, "A Site"),
        (600, -200, "B Site"),
    ],
}

GRENADE_LABELS = {
    "smokegrenade": "Smoke",
    "hegrenade": "HE Nade",
    "flashbang": "Flash",
    "molotov": "Molotov",
    "decoy": "Decoy",
}


def _mode_with_ratio(
    series,
    *,
    drop_values: Optional[set[str]] = None,
) -> tuple[Optional[str], float]:
    """
    Return (most_common_value, fraction_of_rows_agreeing) for a label column.

    Used to condense per-throw `throw_technique` / `click_type` labels into a
    single "primary" label per cluster plus a confidence number. Returns
    (None, 0.0) when the column is missing, empty, or fully filtered.

    `drop_values` is used by the caller to exclude e.g. `"none"` click_type
    rows (throws whose pre-release button state we failed to recover) so they
    don't dominate the mode computation for small clusters.
    """
    if series is None:
        return None, 0.0
    cleaned = series.dropna().astype(str)
    cleaned = cleaned[cleaned != ""]
    if drop_values:
        cleaned = cleaned[~cleaned.isin(drop_values)]
    if cleaned.empty:
        return None, 0.0
    vc = cleaned.value_counts()
    top_label = str(vc.index[0])
    agreement = float(vc.iloc[0]) / float(len(cleaned))
    return top_label, round(agreement, 3)


class GrenadeClusterer:
    """
    Deduplicates throws by (standing position, aim angles) and annotates
    each unique lineup with performance metrics, then drops anything whose
    win rate falls below MIN_WIN_RATE.
    """

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def cluster(
        self,
        df: pd.DataFrame,
        *,
        map_name: Optional[str] = None,
        grenade_type: Optional[str] = None,
    ) -> List[LineupCluster]:
        """
        Bucket throws by rounded (throw_x, throw_y, throw_z, pitch, yaw),
        build one LineupCluster per bucket, and drop buckets with a round
        win rate below MIN_WIN_RATE.

        If map_name / grenade_type are omitted, every row in `df` is
        bucketed together; typically you should pass both filters.
        """
        work = df.copy()

        if map_name:
            work = work[work["map_name"] == map_name]
        if grenade_type:
            work = work[work["grenade_type"] == grenade_type]

        required = [
            "throw_x", "throw_y", "throw_z",
            "pitch", "yaw",
            "land_x", "land_y", "land_z",
        ]
        missing_cols = [c for c in required if c not in work.columns]
        if missing_cols:
            logger.warning(
                "Parser did not produce required columns %s — cannot bucket lineups",
                missing_cols,
            )
            return []

        before = len(work)
        work = work.dropna(subset=required)
        dropped = before - len(work)
        if dropped:
            logger.info(
                "  dropped %d throws with missing position/angle data", dropped
            )

        if work.empty:
            logger.warning(
                "No valid grenade data for map=%s type=%s", map_name, grenade_type
            )
            return []

        effective_map = map_name or work["map_name"].iloc[0]
        effective_type = grenade_type or work["grenade_type"].iloc[0]

        logger.info(
            "Bucketing %d throws (map=%s, type=%s) pos=%.0fu ang=%.0f°",
            len(work), effective_map, effective_type, POS_BUCKET, ANG_BUCKET,
        )

        work = work.copy()
        work["_bx"] = np.round(work["throw_x"] / POS_BUCKET).astype(int)
        work["_by"] = np.round(work["throw_y"] / POS_BUCKET).astype(int)
        work["_bz"] = np.round(work["throw_z"] / POS_BUCKET).astype(int)
        work["_bp"] = np.round(work["pitch"] / ANG_BUCKET).astype(int)
        work["_byaw"] = np.round(work["yaw"] / ANG_BUCKET).astype(int)

        clusters: List[LineupCluster] = []
        total_buckets = 0
        for cid, (_, group) in enumerate(
            work.groupby(["_bx", "_by", "_bz", "_bp", "_byaw"], sort=False)
        ):
            total_buckets += 1
            cluster = self._build_cluster(
                cluster_id=cid,
                group=group,
                map_name=effective_map,
                grenade_type=effective_type,
            )
            if cluster.round_win_rate < MIN_WIN_RATE:
                continue
            clusters.append(cluster)

        logger.info(
            "  %d unique lineups → %d kept after win-rate ≥ %.0f%% filter (dropped %d)",
            total_buckets,
            len(clusters),
            MIN_WIN_RATE * 100,
            total_buckets - len(clusters),
        )
        return clusters

    def cluster_all_types(
        self,
        df: pd.DataFrame,
        *,
        map_name: str,
    ) -> List[LineupCluster]:
        """Convenience: cluster every grenade type present in the DataFrame."""
        all_clusters: List[LineupCluster] = []
        for gtype in df["grenade_type"].unique():
            all_clusters.extend(
                self.cluster(df, map_name=map_name, grenade_type=gtype)
            )
        return all_clusters

    def rank(self, clusters: List[LineupCluster]) -> List[LineupRanking]:
        """
        Rank clusters by an impact score:
            impact = round_win_rate * log1p(throw_count) * (1 + avg_utility_damage / 100)

        Returns a sorted list with rank 1 = highest impact.
        """
        if not clusters:
            return []

        scored = []
        for c in clusters:
            impact = (
                c.round_win_rate
                * np.log1p(c.throw_count)
                * (1 + c.avg_utility_damage / 100.0)
            )
            scored.append((impact, c))

        scored.sort(key=lambda x: x[0], reverse=True)

        return [
            LineupRanking(rank=i + 1, cluster=c, impact_score=round(score, 4))
            for i, (score, c) in enumerate(scored)
        ]

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_cluster(
        self,
        *,
        cluster_id: int,
        group: pd.DataFrame,
        map_name: str,
        grenade_type: str,
    ) -> LineupCluster:
        """Build a LineupCluster from a group of throws that share a cluster label."""
        land_cx = float(group["land_x"].mean())
        land_cy = float(group["land_y"].mean())
        land_cz = float(group["land_z"].mean())

        # Throw position: we can't use the mean of (x,y,z) because pros stand
        # in slightly different spots and averaging drops you inside geometry
        # (walls, boxes, stairs). Instead pick the medoid — the actual throw
        # closest to the mean — so the coordinates are guaranteed to be a
        # real standing position from a real demo tick. Angles come from that
        # same throw because averaging yaw wraps around 180° incorrectly.
        medoid_row = None
        if "throw_x" in group.columns and len(group) > 0:
            tx = group["throw_x"].to_numpy(dtype=float)
            ty = group["throw_y"].to_numpy(dtype=float)
            tz = group["throw_z"].to_numpy(dtype=float)
            mx, my, mz = tx.mean(), ty.mean(), tz.mean()
            dists = (tx - mx) ** 2 + (ty - my) ** 2 + (tz - mz) ** 2
            medoid_idx = int(np.argmin(dists))
            medoid_row = group.iloc[medoid_idx]

            throw_cx = float(medoid_row["throw_x"])
            throw_cy = float(medoid_row["throw_y"])
            throw_cz = float(medoid_row["throw_z"])
            avg_pitch = float(medoid_row["pitch"]) if "pitch" in group.columns else 0.0
            avg_yaw = float(medoid_row["yaw"]) if "yaw" in group.columns else 0.0
        else:
            throw_cx = throw_cy = throw_cz = 0.0
            avg_pitch = avg_yaw = 0.0

        # Pointer to the exact throw the medoid came from, for demo_goto.
        # These are optional because older parse runs may not have a
        # source_demo column (e.g. single-file parse_demo() calls); the
        # frontend hides the replay button when either field is missing.
        demo_file: Optional[str] = None
        demo_tick: Optional[int] = None
        demo_thrower_name: Optional[str] = None
        trajectory: Optional[list] = None
        if medoid_row is not None:
            if "source_demo" in group.columns:
                raw = medoid_row.get("source_demo")
                if raw is not None and pd.notna(raw):
                    demo_file = str(raw) or None
            if "tick" in group.columns:
                raw_tick = medoid_row.get("tick")
                if raw_tick is not None and pd.notna(raw_tick):
                    demo_tick = int(raw_tick)
            if "thrower_name" in group.columns:
                raw_name = medoid_row.get("thrower_name")
                if raw_name is not None and pd.notna(raw_name):
                    demo_thrower_name = str(raw_name) or None
            # Trajectory is a list-of-lists; pd.notna on a list returns an
            # array of bools, so we have to type-check instead of using notna.
            if "trajectory" in group.columns:
                raw_traj = medoid_row.get("trajectory")
                if isinstance(raw_traj, list) and len(raw_traj) >= 2:
                    trajectory = raw_traj

        throw_count = len(group)

        # Win rate = fraction of throws whose round was won by the thrower's team.
        # team_num: 2 = T, 3 = CT. round_winner: "T" / "CT".
        if "round_winner" in group.columns and "team_num" in group.columns:
            paired = group.dropna(subset=["round_winner", "team_num"])
            if paired.empty:
                round_win_rate = 0.0
            else:
                team_labels = paired["team_num"].map({2: "T", 3: "CT"})
                round_win_rate = float((team_labels == paired["round_winner"]).mean())
        else:
            round_win_rate = 0.0

        total_ud = float(group["utility_damage"].sum()) if "utility_damage" in group else 0.0
        avg_ud = total_ud / max(throw_count, 1)

        # Throw technique / click type summary. We report the most common
        # label plus the fraction of throws that agree with it, so the UI can
        # show either "Jump" (unanimous) or "Run (60%)" (mixed styles). For
        # clicks we ignore "none" rows — those are the throws whose pre-
        # release button state parse_ticks failed to recover, not a real
        # zero-button throw.
        primary_technique, technique_agreement = _mode_with_ratio(
            group.get("throw_technique")
        )
        primary_click, click_agreement = _mode_with_ratio(
            group.get("click_type"), drop_values={"none"}
        )

        # Team side of the throwers. team_num 2=T, 3=CT. Because throw
        # position is already in the bucket key, a single bucket is
        # overwhelmingly one side; we just pick the mode.
        side: Optional[str] = None
        if "team_num" in group.columns:
            tn = group["team_num"].dropna()
            if not tn.empty:
                top = int(tn.mode().iloc[0])
                side = {2: "T", 3: "CT"}.get(top)

        # Who actually threw this lineup? Top 3 most frequent thrower names,
        # each carrying a pointer to a real throw BY that player so the
        # replay flow can seek to the right take when the dashboard's player
        # filter is active. Per-player medoid = the row closest to that
        # player's own throw-position mean (guarantees a real tick, not an
        # averaged ghost). Single-throw players get their one row directly.
        top_throwers: List[TopThrower] = []
        if "thrower_name" in group.columns:
            vc = (
                group["thrower_name"]
                .dropna()
                .astype(str)
                .value_counts()
                .head(3)
            )
            for name, count in vc.items():
                if not name or name.lower() == "nan":
                    continue
                player_rows = group[group["thrower_name"].astype(str) == name]
                player_file: Optional[str] = None
                player_tick: Optional[int] = None
                if len(player_rows) and "throw_x" in player_rows.columns:
                    ptx = player_rows["throw_x"].to_numpy(dtype=float)
                    pty = player_rows["throw_y"].to_numpy(dtype=float)
                    ptz = player_rows["throw_z"].to_numpy(dtype=float)
                    pmx, pmy, pmz = ptx.mean(), pty.mean(), ptz.mean()
                    pdists = (ptx - pmx) ** 2 + (pty - pmy) ** 2 + (ptz - pmz) ** 2
                    pidx = int(np.argmin(pdists))
                    prow = player_rows.iloc[pidx]
                    if "source_demo" in player_rows.columns:
                        raw = prow.get("source_demo")
                        if raw is not None and pd.notna(raw):
                            player_file = str(raw) or None
                    if "tick" in player_rows.columns:
                        raw_tick = prow.get("tick")
                        if raw_tick is not None and pd.notna(raw_tick):
                            player_tick = int(raw_tick)
                top_throwers.append(
                    TopThrower(
                        name=str(name),
                        count=int(count),
                        demo_file=player_file,
                        demo_tick=player_tick,
                    )
                )

        label = self._auto_label(
            map_name=map_name,
            grenade_type=grenade_type,
            land_cx=land_cx,
            land_cy=land_cy,
        )

        return LineupCluster(
            cluster_id=cluster_id,
            map_name=map_name,
            grenade_type=grenade_type,
            land_centroid_x=round(land_cx, 2),
            land_centroid_y=round(land_cy, 2),
            land_centroid_z=round(land_cz, 2),
            throw_centroid_x=round(throw_cx, 2),
            throw_centroid_y=round(throw_cy, 2),
            throw_centroid_z=round(throw_cz, 2),
            avg_pitch=round(avg_pitch, 4),
            avg_yaw=round(avg_yaw, 4),
            throw_count=throw_count,
            round_win_rate=round(round_win_rate, 4),
            total_utility_damage=round(total_ud, 2),
            avg_utility_damage=round(avg_ud, 2),
            label=label,
            top_throwers=top_throwers,
            primary_technique=primary_technique,
            technique_agreement=technique_agreement,
            primary_click=primary_click,
            click_agreement=click_agreement,
            side=side,
            demo_file=demo_file,
            demo_tick=demo_tick,
            demo_thrower_name=demo_thrower_name,
            trajectory=trajectory,
        )

    def _auto_label(
        self,
        *,
        map_name: str,
        grenade_type: str,
        land_cx: float,
        land_cy: float,
    ) -> str:
        """
        Build a human-readable label like "Mirage B Apartments Smoke".

        Resolution order:
          1. Real polygon lookup from CS2Callouts JSON (covers all env_cs_place
             zones on the map — smallest polygon wins, so "Car" beats "ASite").
          2. Hand-guessed nearest-spot fallback from KNOWN_SPOTS for maps
             whose callout JSON hasn't been extracted yet.
          3. Raw coordinates when neither source has data.
        """
        nade_label = GRENADE_LABELS.get(grenade_type, grenade_type.title())
        map_display = map_name.replace("de_", "").title()

        poly_name = callouts.lookup(map_name, land_cx, land_cy)
        if poly_name:
            return f"{map_display} {callouts.humanize(poly_name)} {nade_label}"

        spots = KNOWN_SPOTS.get(map_name, [])
        if not spots:
            return f"{map_display} {nade_label} ({land_cx:.0f},{land_cy:.0f})"

        nearest_label = min(
            spots,
            key=lambda s: (s[0] - land_cx) ** 2 + (s[1] - land_cy) ** 2,
        )[2]
        return f"{map_display} {nearest_label} {nade_label}"
