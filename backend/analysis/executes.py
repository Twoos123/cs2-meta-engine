"""
Execute detection — identifies coordinated utility patterns (site takes/holds).

An "execute" in CS2 is when multiple players on a team throw utility in
coordinated fashion: smokes to block sight lines, flashes to blind defenders,
and molotovs to clear positions.  This module detects recurring patterns by:

  1. Grouping raw throws by (demo, round, team)
  2. Finding bursts of ≥3 throws within a 10-second window
  3. Mapping each throw to its parent lineup cluster via bucket key
  4. Tracking which cluster combinations recur across rounds
  5. Surfacing combos that appear ≥2 times as "detected executes"

Usage
-----
    from backend.analysis.executes import detect_executes

    executes = detect_executes(raw_throws_df, persisted_clusters, "de_mirage")
"""
from __future__ import annotations

import logging
from collections import Counter
from typing import List

import numpy as np
import pandas as pd

from backend.analysis.clustering import POS_BUCKET, ANG_BUCKET
from backend.models.schemas import ExecuteCombo, ExecuteComboMember, LineupCluster

logger = logging.getLogger(__name__)

# Throws within this many ticks of the first throw in a round-team group
# count as part of the same execute burst.
EXECUTE_TIME_WINDOW = 640  # 10 seconds at 64 tick/s

# Minimum distinct lineup clusters needed to call something an "execute".
MIN_NADES = 3

# Minimum round occurrences for a combo to be reported.
MIN_OCCURRENCES = 2


def detect_executes(
    df: pd.DataFrame,
    clusters: List[LineupCluster],
    map_name: str,
) -> List[ExecuteCombo]:
    """
    Detect recurring coordinated utility patterns from raw throw data.

    Parameters
    ----------
    df : DataFrame
        Raw throws from parse_directory (all maps/types combined).
    clusters : list[LineupCluster]
        Already-persisted clusters with DB ids (cluster_id = SQLite row id).
    map_name : str
        Which map to analyze.

    Returns
    -------
    List of ExecuteCombo objects sorted by occurrence count descending.
    """
    work = df[df["map_name"] == map_name].copy()
    required = [
        "source_demo", "round_number", "team_num", "tick",
        "throw_x", "throw_y", "throw_z", "pitch", "yaw", "grenade_type",
    ]
    missing = [c for c in required if c not in work.columns]
    if missing:
        logger.warning("Cannot detect executes — missing columns: %s", missing)
        return []

    work = work.dropna(subset=required)
    if len(work) < MIN_NADES:
        return []

    # ------------------------------------------------------------------
    # Build bucket_key → cluster_id lookup from persisted clusters.
    # The bucket key is the same (bx, by, bz, bp, byaw) used by
    # GrenadeClusterer — since each cluster's centroid is the medoid
    # (a real throw), re-bucketing it produces the same key as every
    # throw in that bucket.
    # ------------------------------------------------------------------
    cluster_str_lookup: dict[str, int] = {}
    cluster_by_id: dict[int, LineupCluster] = {}
    for c in clusters:
        bx = int(np.round(c.throw_centroid_x / POS_BUCKET))
        by = int(np.round(c.throw_centroid_y / POS_BUCKET))
        bz = int(np.round(c.throw_centroid_z / POS_BUCKET))
        bp = int(np.round(c.avg_pitch / ANG_BUCKET))
        byaw = int(np.round(c.avg_yaw / ANG_BUCKET))
        key = f"{bx},{by},{bz},{bp},{byaw},{c.grenade_type}"
        cluster_str_lookup[key] = c.cluster_id
        cluster_by_id[c.cluster_id] = c

    # ------------------------------------------------------------------
    # Vectorized cluster assignment — compute bucket columns, build a
    # composite string key, and map to cluster_id via the lookup dict.
    # ------------------------------------------------------------------
    work["_bx"] = np.round(work["throw_x"].values / POS_BUCKET).astype(int)
    work["_by"] = np.round(work["throw_y"].values / POS_BUCKET).astype(int)
    work["_bz"] = np.round(work["throw_z"].values / POS_BUCKET).astype(int)
    work["_bp"] = np.round(work["pitch"].values / ANG_BUCKET).astype(int)
    work["_byaw"] = np.round(work["yaw"].values / ANG_BUCKET).astype(int)
    work["_bkey"] = (
        work["_bx"].astype(str) + "," +
        work["_by"].astype(str) + "," +
        work["_bz"].astype(str) + "," +
        work["_bp"].astype(str) + "," +
        work["_byaw"].astype(str) + "," +
        work["grenade_type"]
    )
    work["_cid"] = work["_bkey"].map(cluster_str_lookup)
    work = work.dropna(subset=["_cid"])
    work["_cid"] = work["_cid"].astype(int)

    if len(work) < MIN_NADES:
        return []

    logger.info(
        "Execute detection: %d throws mapped to %d clusters on %s",
        len(work), len(cluster_by_id), map_name,
    )

    # ------------------------------------------------------------------
    # Group by (demo, round, team) and find execute bursts.
    # ------------------------------------------------------------------
    combos: Counter[tuple[int, ...]] = Counter()
    combo_wins: Counter[tuple[int, ...]] = Counter()
    combo_sides: dict[tuple[int, ...], str] = {}

    for (_, _, team), group in work.groupby(
        ["source_demo", "round_number", "team_num"], sort=False
    ):
        sorted_g = group.sort_values("tick")
        first_tick = float(sorted_g.iloc[0]["tick"])
        burst = sorted_g[sorted_g["tick"] <= first_tick + EXECUTE_TIME_WINDOW]

        unique_clusters = tuple(sorted(burst["_cid"].unique()))
        if len(unique_clusters) < MIN_NADES:
            continue

        combos[unique_clusters] += 1
        combo_sides[unique_clusters] = {2: "T", 3: "CT"}.get(int(team), "T")

        # Win check
        if "round_winner" in burst.columns:
            rw = burst.iloc[0].get("round_winner")
            team_label = {2: "T", 3: "CT"}.get(int(team))
            if rw and team_label and rw == team_label:
                combo_wins[unique_clusters] += 1

    # ------------------------------------------------------------------
    # Build ExecuteCombo objects for recurring combos.
    # ------------------------------------------------------------------
    from backend.analysis import callouts

    results: List[ExecuteCombo] = []
    for eid, (combo_key, count) in enumerate(combos.most_common()):
        if count < MIN_OCCURRENCES:
            break

        members: List[ExecuteComboMember] = []
        grenade_counts: Counter[str] = Counter()
        land_xs: list[float] = []
        land_ys: list[float] = []

        for cid in combo_key:
            c = cluster_by_id.get(cid)
            if not c:
                continue
            members.append(ExecuteComboMember(
                cluster_id=cid,
                grenade_type=c.grenade_type,
                label=c.label,
            ))
            short = c.grenade_type.replace("grenade", "")
            grenade_counts[short] += 1
            land_xs.append(c.land_centroid_x)
            land_ys.append(c.land_centroid_y)

        if len(members) < MIN_NADES:
            continue

        # Grenade summary like "2 Smokes + 1 Flash + 1 Molotov"
        label_map = {
            "smoke": "Smoke", "flash": "Flash", "he": "HE",
            "molotov": "Molotov", "decoy": "Decoy",
        }
        summary_parts = []
        for gtype in ["smoke", "flash", "he", "molotov", "decoy"]:
            n = grenade_counts.get(gtype, 0)
            if n > 0:
                name = label_map.get(gtype, gtype.title())
                summary_parts.append(f"{n} {name}{'s' if n > 1 else ''}")
        grenade_summary = " + ".join(summary_parts) or "Mixed"

        # Auto-name from average landing area
        avg_x = sum(land_xs) / len(land_xs) if land_xs else 0
        avg_y = sum(land_ys) / len(land_ys) if land_ys else 0
        area = callouts.lookup(map_name, avg_x, avg_y)
        map_display = map_name.replace("de_", "").title()
        if area:
            area_name = callouts.humanize(area)
            name = f"{map_display} {area_name} Execute"
        else:
            name = f"{map_display} Execute #{eid + 1}"

        total = combos[combo_key]
        wins = combo_wins.get(combo_key, 0)

        results.append(ExecuteCombo(
            execute_id=eid,
            map_name=map_name,
            name=name,
            members=members,
            occurrence_count=count,
            round_win_rate=round(wins / total, 4) if total > 0 else 0.0,
            side=combo_sides.get(combo_key),
            grenade_summary=grenade_summary,
        ))

    logger.info("Detected %d execute combos for %s", len(results), map_name)
    return results
