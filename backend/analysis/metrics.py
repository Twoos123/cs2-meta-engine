"""
Metrics pipeline — orchestrates parsing → clustering → ranking for a full
analysis run, and persists results to a database so the FastAPI layer can
serve them without re-running the pipeline.

Supports two backends:
  - **SQLite** (default) — zero-config local file at ``data/lineups.db``
  - **PostgreSQL / Supabase** — set ``DATABASE_URL`` env var to a
    ``postgresql://…`` connection string

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
from backend.models.schemas import (
    ExecuteCombo,
    ExecuteComboMember,
    LineupCluster,
    LineupRanking,
    TopThrower,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Schema definitions (one per backend)
# ---------------------------------------------------------------------------

_SQLITE_SCHEMA = """
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
    side                  TEXT,
    demo_file             TEXT,
    demo_tick             INTEGER,
    demo_thrower_name     TEXT,
    trajectory            TEXT,
    impact_score          REAL,
    rank_position         INTEGER,
    created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_map_type ON lineup_clusters (map_name, grenade_type);

CREATE TABLE IF NOT EXISTS execute_combos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    map_name          TEXT NOT NULL,
    name              TEXT,
    members           TEXT,
    occurrence_count  INTEGER,
    round_win_rate    REAL,
    side              TEXT,
    grenade_summary   TEXT,
    created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_exec_map ON execute_combos (map_name);
"""

_PG_SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS lineup_clusters (
        id                    SERIAL PRIMARY KEY,
        cluster_id            INTEGER NOT NULL,
        map_name              TEXT NOT NULL,
        grenade_type          TEXT NOT NULL,
        land_cx               DOUBLE PRECISION,
        land_cy               DOUBLE PRECISION,
        land_cz               DOUBLE PRECISION,
        throw_cx              DOUBLE PRECISION,
        throw_cy              DOUBLE PRECISION,
        throw_cz              DOUBLE PRECISION,
        avg_pitch             DOUBLE PRECISION,
        avg_yaw               DOUBLE PRECISION,
        throw_count           INTEGER,
        round_win_rate        DOUBLE PRECISION,
        total_ud              DOUBLE PRECISION,
        avg_ud                DOUBLE PRECISION,
        label                 TEXT,
        top_throwers          JSONB,
        primary_technique     TEXT,
        technique_agreement   DOUBLE PRECISION,
        primary_click         TEXT,
        click_agreement       DOUBLE PRECISION,
        side                  TEXT,
        demo_file             TEXT,
        demo_tick             INTEGER,
        demo_thrower_name     TEXT,
        trajectory            JSONB,
        impact_score          DOUBLE PRECISION,
        rank_position         INTEGER,
        created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_map_type ON lineup_clusters (map_name, grenade_type)",
    """
    CREATE TABLE IF NOT EXISTS execute_combos (
        id                SERIAL PRIMARY KEY,
        map_name          TEXT NOT NULL,
        name              TEXT,
        members           JSONB,
        occurrence_count  INTEGER,
        round_win_rate    DOUBLE PRECISION,
        side              TEXT,
        grenade_summary   TEXT,
        created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_exec_map ON execute_combos (map_name)",
]

# Columns that may be missing on older DBs (migration list)
_MIGRATION_COLS_CLUSTERS = [
    ("top_throwers",        "TEXT",    "JSONB"),
    ("primary_technique",   "TEXT",    "TEXT"),
    ("technique_agreement", "REAL",    "DOUBLE PRECISION"),
    ("primary_click",       "TEXT",    "TEXT"),
    ("click_agreement",     "REAL",    "DOUBLE PRECISION"),
    ("side",                "TEXT",    "TEXT"),
    ("demo_file",           "TEXT",    "TEXT"),
    ("demo_tick",           "INTEGER", "INTEGER"),
    ("demo_thrower_name",   "TEXT",    "TEXT"),
    ("trajectory",          "TEXT",    "JSONB"),
]


class MetricsPipeline:
    """
    End-to-end orchestrator: parse → cluster → rank → persist.
    Also provides read methods for the FastAPI layer.
    """

    def __init__(
        self,
        db_path: Optional[Path] = None,
        database_url: Optional[str] = None,
    ) -> None:
        self._database_url = database_url or settings.database_url
        self._use_pg = bool(self._database_url)

        if not self._use_pg:
            self.db_path = db_path or settings.db_path
            self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._init_db()

        self._parser = DemoParser()
        self._clusterer = GrenadeClusterer()

    # ------------------------------------------------------------------
    # SQL dialect helpers
    # ------------------------------------------------------------------

    def _q(self, sql: str) -> str:
        """Convert ``?`` parameter placeholders to ``%s`` for PostgreSQL."""
        if self._use_pg:
            return sql.replace("?", "%s")
        return sql

    def _json_val(self, obj):
        """Wrap a Python object for insertion into a JSON/JSONB column."""
        if self._use_pg:
            from psycopg2.extras import Json
            return Json(obj)
        return json.dumps(obj)

    def _json_read(self, raw):
        """Deserialize a JSON column value to a Python object."""
        if raw is None:
            return None
        if isinstance(raw, (dict, list)):
            return raw  # psycopg2 JSONB → already decoded
        try:
            return json.loads(raw)
        except Exception:
            return None

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
          4. Persist to database

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

        # ----------------------------------------------------------
        # Execute detection — find coordinated utility combos
        # ----------------------------------------------------------
        for m in maps:
            all_clusters_for_map = []
            for g in types:
                all_clusters_for_map.extend(
                    self.get_top_lineups(map_name=m, grenade_type=g, limit=9999)
                )
            if len(all_clusters_for_map) >= 3:
                from backend.analysis.executes import detect_executes

                executes = detect_executes(
                    df, [r.cluster for r in all_clusters_for_map], m,
                )
                if clear_existing:
                    self._delete_executes(map_name=m)
                if executes:
                    self._persist_executes(executes, m)

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
        side: Optional[str] = None,
    ) -> List[LineupRanking]:
        """Return the top `limit` ranked lineups from the DB.

        `side` filters to "T" or "CT" — older rows (where side wasn't yet
        persisted) are NULL and excluded by the filter so the user doesn't
        see ghosts from before the column existed.
        """
        sql = "SELECT * FROM lineup_clusters WHERE map_name = ? AND grenade_type = ?"
        params: list = [map_name, grenade_type]
        if side in ("T", "CT"):
            sql += " AND side = ?"
            params.append(side)
        sql += " ORDER BY rank_position ASC LIMIT ?"
        params.append(limit)

        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute(self._q(sql), tuple(params))
            rows = cur.fetchall()

        return [self._row_to_ranking(r) for r in rows]

    def get_cluster_by_id(
        self,
        cluster_id: int,
        map_name: str,
    ) -> Optional[LineupCluster]:
        """
        Look up a single cluster by its row id.

        `cluster_id` is the auto-increment `id` column, which is unique
        per row.
        """
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute(
                self._q(
                    "SELECT * FROM lineup_clusters WHERE id = ? AND map_name = ? LIMIT 1"
                ),
                (cluster_id, map_name),
            )
            row = cur.fetchone()

        if row is None:
            return None
        return self._row_to_ranking(row).cluster

    def list_available_maps(self) -> List[str]:
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute("SELECT DISTINCT map_name FROM lineup_clusters ORDER BY map_name")
            rows = cur.fetchall()
        return [r["map_name"] for r in rows]

    def list_available_types(self, map_name: str) -> List[str]:
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute(
                self._q("SELECT DISTINCT grenade_type FROM lineup_clusters WHERE map_name = ?"),
                (map_name,),
            )
            rows = cur.fetchall()
        return [r["grenade_type"] for r in rows]

    def get_stats(self) -> dict:
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute("SELECT COUNT(*) as n FROM lineup_clusters")
            total = cur.fetchone()["n"]
            cur.execute("SELECT COUNT(DISTINCT map_name) as n FROM lineup_clusters")
            maps = cur.fetchone()["n"]
        return {"total_lineups": total, "total_maps": maps}

    # ------------------------------------------------------------------
    # Private — DB helpers
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        with self._connect() as conn:
            if self._use_pg:
                cur = self._cursor(conn)
                for stmt in _PG_SCHEMA_STATEMENTS:
                    cur.execute(stmt)
                conn.commit()

                # Migration: add missing columns
                cur.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'lineup_clusters'"
                )
                existing = {r["column_name"] for r in cur.fetchall()}
                for col, _sqlite_type, pg_type in _MIGRATION_COLS_CLUSTERS:
                    if col not in existing:
                        try:
                            cur.execute(
                                f"ALTER TABLE lineup_clusters ADD COLUMN {col} {pg_type}"
                            )
                        except Exception:
                            pass
                conn.commit()
            else:
                conn.executescript(_SQLITE_SCHEMA)
                existing = {
                    r["name"]
                    for r in conn.execute("PRAGMA table_info(lineup_clusters)").fetchall()
                }
                for col, sqlite_type, _pg_type in _MIGRATION_COLS_CLUSTERS:
                    if col in existing:
                        continue
                    try:
                        conn.execute(
                            f"ALTER TABLE lineup_clusters ADD COLUMN {col} {sqlite_type}"
                        )
                    except sqlite3.OperationalError:
                        pass
                conn.commit()

    def _connect(self):
        """Return a DB connection (SQLite or PostgreSQL)."""
        if self._use_pg:
            import psycopg2
            conn = psycopg2.connect(self._database_url)
            return conn
        else:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            return conn

    def _cursor(self, conn):
        """Return a dict-style cursor for the connection."""
        if self._use_pg:
            from psycopg2.extras import RealDictCursor
            return conn.cursor(cursor_factory=RealDictCursor)
        # SQLite: conn.row_factory is already sqlite3.Row, so the cursor
        # returned by conn.cursor() will yield Row objects with dict-style
        # access via row["column_name"].
        return conn.cursor()

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
                    self._json_val([t.model_dump() for t in c.top_throwers]),
                    c.primary_technique,
                    c.technique_agreement,
                    c.primary_click,
                    c.click_agreement,
                    c.side,
                    c.demo_file,
                    c.demo_tick,
                    c.demo_thrower_name,
                    self._json_val(c.trajectory) if c.trajectory else None,
                    r.impact_score,
                    r.rank,
                )
            )

        insert_sql = self._q(
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
               side, demo_file, demo_tick, demo_thrower_name, trajectory,
               impact_score, rank_position)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """
        )

        with self._connect() as conn:
            cur = self._cursor(conn)
            if self._use_pg:
                for row in rows:
                    cur.execute(insert_sql, row)
            else:
                cur.executemany(insert_sql, rows)
            conn.commit()

    def _delete_clusters(self, *, map_name: str, grenade_type: str) -> None:
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute(
                self._q("DELETE FROM lineup_clusters WHERE map_name=? AND grenade_type=?"),
                (map_name, grenade_type),
            )
            conn.commit()

    def clear_all(self) -> int:
        """Drop every row from lineup_clusters and execute_combos."""
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute("DELETE FROM lineup_clusters")
            deleted = cur.rowcount
            cur.execute("DELETE FROM execute_combos")
            conn.commit()
        logger.info("Cleared %d rows from lineup_clusters", deleted)
        return deleted

    # ------------------------------------------------------------------
    # Execute combos — persistence and read
    # ------------------------------------------------------------------

    def get_executes(self, *, map_name: str) -> List[ExecuteCombo]:
        """Return all detected execute combos for a map."""
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute(
                self._q("SELECT * FROM execute_combos WHERE map_name = ? ORDER BY occurrence_count DESC"),
                (map_name,),
            )
            rows = cur.fetchall()

        results: List[ExecuteCombo] = []
        for row in rows:
            members: List[ExecuteComboMember] = []
            raw = row["members"]
            parsed = self._json_read(raw)
            if parsed and isinstance(parsed, list):
                try:
                    members = [ExecuteComboMember(**m) for m in parsed]
                except Exception:
                    members = []
            results.append(ExecuteCombo(
                execute_id=row["id"],
                map_name=row["map_name"],
                name=row["name"] or "",
                members=members,
                occurrence_count=row["occurrence_count"] or 0,
                round_win_rate=row["round_win_rate"] or 0.0,
                side=row["side"],
                grenade_summary=row["grenade_summary"] or "",
            ))
        return results

    def _persist_executes(self, executes: List[ExecuteCombo], map_name: str) -> None:
        rows = []
        for e in executes:
            rows.append((
                map_name,
                e.name,
                self._json_val([m.model_dump() for m in e.members]),
                e.occurrence_count,
                e.round_win_rate,
                e.side,
                e.grenade_summary,
            ))

        insert_sql = self._q(
            """
            INSERT INTO execute_combos
                (map_name, name, members, occurrence_count,
                 round_win_rate, side, grenade_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """
        )

        with self._connect() as conn:
            cur = self._cursor(conn)
            if self._use_pg:
                for row in rows:
                    cur.execute(insert_sql, row)
            else:
                cur.executemany(insert_sql, rows)
            conn.commit()
        logger.info("Persisted %d execute combos for %s", len(rows), map_name)

    def _delete_executes(self, *, map_name: str) -> None:
        with self._connect() as conn:
            cur = self._cursor(conn)
            cur.execute(
                self._q("DELETE FROM execute_combos WHERE map_name = ?"),
                (map_name,),
            )
            conn.commit()

    # ------------------------------------------------------------------
    # Row → Pydantic conversion
    # ------------------------------------------------------------------

    def _row_to_ranking(self, row) -> LineupRanking:
        keys = set(row.keys())
        raw_tt = row["top_throwers"] if "top_throwers" in keys else None
        throwers: List[TopThrower] = []
        parsed_tt = self._json_read(raw_tt)
        if parsed_tt and isinstance(parsed_tt, list):
            try:
                throwers = [TopThrower(**t) for t in parsed_tt]
            except Exception:
                throwers = []

        def _opt(col: str):
            return row[col] if col in keys else None

        raw_traj = _opt("trajectory")
        parsed_traj = self._json_read(raw_traj)
        trajectory: Optional[List[List[float]]] = None
        if isinstance(parsed_traj, list) and len(parsed_traj) >= 2:
            trajectory = parsed_traj

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
            side=_opt("side"),
            demo_file=_opt("demo_file"),
            demo_tick=_opt("demo_tick"),
            demo_thrower_name=_opt("demo_thrower_name"),
            trajectory=trajectory,
        )
        return LineupRanking(
            rank=row["rank_position"],
            cluster=cluster,
            impact_score=row["impact_score"],
        )
