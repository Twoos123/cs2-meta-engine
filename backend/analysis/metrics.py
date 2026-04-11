"""
Metrics pipeline — orchestrates parsing → clustering → ranking for a full
analysis run, and persists results to a lightweight SQLite database so the
FastAPI layer can serve them without re-running the pipeline.

Usage
-----
    from pathlib import Path
    from backend.analysis.metrics import MetricsPipeline

    pipeline = MetricsPipeline()
    pipeline.run(demo_dir=Path("demos"), map_name="de_mirage")

    top10 = pipeline.get_top_lineups(map_name="de_mirage",
                                     grenade_type="smokegrenade",
                                     limit=10)
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Iterable, List, Optional

import pandas as pd

from backend.config import settings
from backend.ingestion.demo_parser import DemoParser
from backend.analysis.clustering import GrenadeClusterer
from backend.models.schemas import LineupCluster, LineupRanking, TopThrower

logger = logging.getLogger(__name__)

DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS lineup_clusters (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id            INTEGER NOT NULL,
    map_name              TEXT NOT NULL,
    grenade_type          TEXT NOT NULL,
    land_cx               REAL,
    land_cy               REAL,
    land_cz               REAL,
    throw_cx              REAL,
    throw_cy              REAL,
    throw_cz              REAL,
    avg_pitch             REAL,
    avg_yaw               REAL,
    throw_count           INTEGER,
    round_win_rate        REAL,
    total_ud              REAL,
    avg_ud                REAL,
    label                 TEXT,
    top_throwers          TEXT,
    primary_technique     TEXT,
    technique_agreement   REAL,
    primary_click         TEXT,
    click_agreement       REAL,
    impact_score          REAL,
    rank_position         INTEGER,
    created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_map_type ON lineup_clusters (map_name, grenade_type);
"""


class MetricsPipeline:
    """
    End-to-end orchestrator: parse → cluster → rank → persist.
    Also provides read methods for the FastAPI layer.
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.db_path = db_path or settings.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

        self._parser = DemoParser()
        self._clusterer = GrenadeClusterer()

    # ------------------------------------------------------------------
    # Public API — write path
    # ------------------------------------------------------------------

    def run(
        self,
        *,
        demo_dir: Path,
        map_name: Optional[str] = None,
        grenade_types: Optional[List[str]] = None,
        clear_existing: bool = False,
        player_names: Optional[Iterable[str]] = None,
    ) -> List[LineupRanking]:
        """
        Full pipeline:
          1. Parse all .dem files in demo_dir
          2. Cluster by (map, grenade_type)
          3. Rank by impact score
          4. Persist to SQLite

        Parameters
        ----------
        demo_dir : Path
            Directory containing .dem files.
        map_name : str, optional
            Filter to a specific map (e.g. "de_mirage").  If None, all maps.
        grenade_types : list[str], optional
            Filter to specific types.  Default: all types.
        clear_existing : bool
            If True, drop existing rows for (map, type) before inserting.
        player_names : Iterable[str], optional
            Restrict analysis to throws by players with these names (case
            insensitive). When set by /api/ingest/hltv's team_name filter,
            only that team's roster is used.
        """
        logger.info("=== MetricsPipeline.run() ===")
        if player_names:
            name_list = [n for n in player_names if n]
            logger.info("  player filter: %d names — %s", len(name_list), name_list)
        df = self._parser.parse_directory(
            demo_dir,
            map_name=map_name,
            player_names=player_names,
        )
        if df.empty:
            logger.warning("No data parsed — aborting pipeline.")
            return []

        if grenade_types:
            df = df[df["grenade_type"].isin(grenade_types)]

        maps = [map_name] if map_name else df["map_name"].unique().tolist()
        types = grenade_types or df["grenade_type"].unique().tolist()

        all_rankings: List[LineupRanking] = []

        for m in maps:
            for g in types:
                clusters = self._clusterer.cluster(df, map_name=m, grenade_type=g)
                rankings = self._clusterer.rank(clusters)
                if rankings:
                    if clear_existing:
                        self._delete_clusters(map_name=m, grenade_type=g)
                    self._persist_rankings(rankings)
                    all_rankings.extend(rankings)

        logger.info("Pipeline complete — %d ranked lineups stored.", len(all_rankings))
        return all_rankings

    # ------------------------------------------------------------------
    # Public API — read path (used by FastAPI)
    # ------------------------------------------------------------------

    def get_top_lineups(
        self,
        *,
        map_name: str,
        grenade_type: str,
        limit: int = 10,
    ) -> List[LineupRanking]:
        """Return the top `limit` ranked lineups from the DB."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM lineup_clusters
                WHERE map_name = ? AND grenade_type = ?
                ORDER BY rank_position ASC
                LIMIT ?
                """,
                (map_name, grenade_type, limit),
            ).fetchall()

        return [self._row_to_ranking(r) for r in rows]

    def get_cluster_by_id(
        self,
        cluster_id: int,
        map_name: str,
    ) -> Optional[LineupCluster]:
        """
        Look up a single cluster by its row id.

        `cluster_id` is the SQLite autoincrement `id` column, which is unique
        per row. We used to key on the raw DBSCAN label (0, 1, 2…) which
        collides across grenade types — every type restarts labels at 0, so
        requesting cluster 0 on Mirage could return the Smoke OR HE OR Flash
        lineup depending on insertion order. `_row_to_ranking` now exposes
        the row id as `cluster.cluster_id`, so the frontend's existing
        references resolve to the correct type automatically.
        """
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM lineup_clusters
                WHERE id = ? AND map_name = ?
                LIMIT 1
                """,
                (cluster_id, map_name),
            ).fetchone()

        if row is None:
            return None
        return self._row_to_ranking(row).cluster

    def list_available_maps(self) -> List[str]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT map_name FROM lineup_clusters ORDER BY map_name"
            ).fetchall()
        return [r["map_name"] for r in rows]

    def list_available_types(self, map_name: str) -> List[str]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT grenade_type FROM lineup_clusters WHERE map_name = ?",
                (map_name,),
            ).fetchall()
        return [r["grenade_type"] for r in rows]

    def get_stats(self) -> dict:
        with self._connect() as conn:
            total = conn.execute(
                "SELECT COUNT(*) as n FROM lineup_clusters"
            ).fetchone()["n"]
            maps = conn.execute(
                "SELECT COUNT(DISTINCT map_name) as n FROM lineup_clusters"
            ).fetchone()["n"]
        return {"total_lineups": total, "total_maps": maps}

    # ------------------------------------------------------------------
    # Private — DB helpers
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(DB_SCHEMA)
            # Add columns to older DBs. SQLite has no IF NOT EXISTS for
            # ADD COLUMN, so we guard each call with a column-list probe and
            # still swallow the duplicate-column error as a belt-and-braces.
            existing = {
                r["name"]
                for r in conn.execute("PRAGMA table_info(lineup_clusters)").fetchall()
            }
            migrations = [
                ("top_throwers",        "ALTER TABLE lineup_clusters ADD COLUMN top_throwers TEXT"),
                ("primary_technique",   "ALTER TABLE lineup_clusters ADD COLUMN primary_technique TEXT"),
                ("technique_agreement", "ALTER TABLE lineup_clusters ADD COLUMN technique_agreement REAL"),
                ("primary_click",       "ALTER TABLE lineup_clusters ADD COLUMN primary_click TEXT"),
                ("click_agreement",     "ALTER TABLE lineup_clusters ADD COLUMN click_agreement REAL"),
            ]
            for col, stmt in migrations:
                if col in existing:
                    continue
                try:
                    conn.execute(stmt)
                except sqlite3.OperationalError:
                    pass
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _persist_rankings(self, rankings: List[LineupRanking]) -> None:
        rows = []
        for r in rankings:
            c = r.cluster
            rows.append(
                (
                    c.cluster_id,
                    c.map_name,
                    c.grenade_type,
                    c.land_centroid_x,
                    c.land_centroid_y,
                    c.land_centroid_z,
                    c.throw_centroid_x,
                    c.throw_centroid_y,
                    c.throw_centroid_z,
                    c.avg_pitch,
                    c.avg_yaw,
                    c.throw_count,
                    c.round_win_rate,
                    c.total_utility_damage,
                    c.avg_utility_damage,
                    c.label,
                    json.dumps([t.model_dump() for t in c.top_throwers]),
                    c.primary_technique,
                    c.technique_agreement,
                    c.primary_click,
                    c.click_agreement,
                    r.impact_score,
                    r.rank,
                )
            )
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO lineup_clusters
                  (cluster_id, map_name, grenade_type,
                   land_cx, land_cy, land_cz,
                   throw_cx, throw_cy, throw_cz,
                   avg_pitch, avg_yaw,
                   throw_count, round_win_rate, total_ud, avg_ud,
                   label, top_throwers,
                   primary_technique, technique_agreement,
                   primary_click, click_agreement,
                   impact_score, rank_position)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                rows,
            )
            conn.commit()

    def _delete_clusters(self, *, map_name: str, grenade_type: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM lineup_clusters WHERE map_name=? AND grenade_type=?",
                (map_name, grenade_type),
            )
            conn.commit()

    def clear_all(self) -> int:
        """Drop every row from lineup_clusters. Returns the number deleted."""
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM lineup_clusters")
            deleted = cur.rowcount
            conn.commit()
        logger.info("Cleared %d rows from lineup_clusters", deleted)
        return deleted

    @staticmethod
    def _row_to_ranking(row: sqlite3.Row) -> LineupRanking:
        keys = set(row.keys())
        raw_tt = row["top_throwers"] if "top_throwers" in keys else None
        throwers: List[TopThrower] = []
        if raw_tt:
            try:
                throwers = [TopThrower(**t) for t in json.loads(raw_tt)]
            except Exception:
                throwers = []

        def _opt(col: str):
            return row[col] if col in keys else None

        cluster = LineupCluster(
            cluster_id=row["id"],
            map_name=row["map_name"],
            grenade_type=row["grenade_type"],
            land_centroid_x=row["land_cx"],
            land_centroid_y=row["land_cy"],
            land_centroid_z=row["land_cz"],
            throw_centroid_x=row["throw_cx"],
            throw_centroid_y=row["throw_cy"],
            throw_centroid_z=row["throw_cz"],
            avg_pitch=row["avg_pitch"],
            avg_yaw=row["avg_yaw"],
            throw_count=row["throw_count"],
            round_win_rate=row["round_win_rate"],
            total_utility_damage=row["total_ud"],
            avg_utility_damage=row["avg_ud"],
            label=row["label"],
            top_throwers=throwers,
            primary_technique=_opt("primary_technique"),
            technique_agreement=_opt("technique_agreement") or 0.0,
            primary_click=_opt("primary_click"),
            click_agreement=_opt("click_agreement") or 0.0,
        )
        return LineupRanking(
            rank=row["rank_position"],
            cluster=cluster,
            impact_score=row["impact_score"],
        )
