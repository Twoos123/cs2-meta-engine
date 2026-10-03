"""
Copy the SQLite database into PostgreSQL (one-time, when moving to
DATABASE_URL=postgres://…).

    python -m backend.migrate_sqlite --sqlite data/lineups.db [--force]

Tables are created by importing the app (each module creates its own schema
on import); rows are then copied for every table that exists on both sides,
using the columns they share. Identity sequences are advanced past the
copied ids. Rows already present in Postgres are kept (conflicting keys are skipped);
--force truncates each table first instead.

`maybe_auto_migrate()` runs the copy automatically on worker start when
Postgres has no lineups / player stats / practice lists yet and the SQLite
file has data, then records that it ran so it never repeats.
"""
from __future__ import annotations

import argparse
import logging
import sqlite3
import time
from pathlib import Path

from backend import db
from backend.config import settings

logger = logging.getLogger(__name__)

_MARKER_DDL = (
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at REAL)"
)
_MARKER = "sqlite_import"
_CORE_TABLES = ("lineup_clusters", "player_stats", "practice_lists")


def _pg_tables(conn) -> dict[str, list[str]]:
    rows = conn.execute(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"
    ).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r[0], []).append(r[1])
    return out


def _sqlite_tables(src: sqlite3.Connection) -> dict[str, list[str]]:
    names = [
        r[0] for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    return {n: [c[1] for c in src.execute(f'PRAGMA table_info("{n}")')] for n in names}


def _if_not_exists(ddl: str) -> str:
    for kw in ("CREATE TABLE ", "CREATE INDEX ", "CREATE UNIQUE INDEX "):
        if ddl.upper().startswith(kw) and "IF NOT EXISTS" not in ddl.upper():
            return ddl[: len(kw)] + "IF NOT EXISTS " + ddl[len(kw):]
    return ddl


def migrate(sqlite_path: Path, *, force: bool = False, batch: int = 1000) -> dict[str, int]:
    if not db.is_postgres():
        raise SystemExit("DATABASE_URL must point at Postgres")
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite file not found: {sqlite_path}")

    import backend.main  # noqa: F401  — creates every module's tables

    src = sqlite3.connect(sqlite_path)
    copied: dict[str, int] = {}
    with db.connect() as conn:
        pg = _pg_tables(conn)
        for table, src_cols in _sqlite_tables(src).items():
            if table not in pg:
                # Modules that create tables lazily (on first use) haven't
                # made them in Postgres yet — replay SQLite's own DDL
                # through the dialect translator.
                ddl = src.execute(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
                ).fetchone()[0]
                conn.execute(_if_not_exists(ddl))
                for (idx_sql,) in src.execute(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? "
                    "AND sql IS NOT NULL", (table,)
                ):
                    conn.execute(_if_not_exists(idx_sql))
                pg[table] = src_cols
                logger.info("created %s from its SQLite definition", table)
            cols = [c for c in src_cols if c in pg[table]]
            existing = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            if existing and force:
                conn.execute(f'TRUNCATE "{table}"')
                existing = 0
            col_list = ", ".join(f'"{c}"' for c in cols)
            # Rows already in Postgres win: only fill in what's missing
            # (conflicting keys are skipped), unless --force truncated.
            verb = "INSERT OR IGNORE INTO" if existing else "INSERT INTO"
            insert = f'{verb} "{table}" ({col_list}) VALUES ({", ".join("?" for _ in cols)})'
            n = 0
            cur = src.execute(f'SELECT {col_list} FROM "{table}"')
            while True:
                rows = cur.fetchmany(batch)
                if not rows:
                    break
                conn.executemany(insert, rows)
                n += len(rows)
            if "id" in cols and n:
                conn.execute(
                    f"SELECT setval(pg_get_serial_sequence('\"{table}\"', 'id'), "
                    f'(SELECT MAX(id) FROM "{table}"))'
                )
            copied[table] = n
            logger.info("copied %s: %d rows", table, n)
        conn.execute(_MARKER_DDL)
        conn.execute(
            "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?) "
            "ON CONFLICT (name) DO UPDATE SET applied_at = excluded.applied_at",
            (_MARKER, time.time()),
        )
    src.close()
    return copied


def maybe_auto_migrate(sqlite_path: Path | None = None) -> dict[str, int] | None:
    """Import SQLite data once, only into a completely empty Postgres."""
    if not db.is_postgres():
        return None
    sqlite_path = sqlite_path or settings.db_path
    if not sqlite_path.exists() or sqlite_path.stat().st_size == 0:
        return None
    with db.connect() as conn:
        conn.execute(_MARKER_DDL)
        if conn.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (_MARKER,)).fetchone():
            return None
        pg = _pg_tables(conn)
        # Judge "fresh" by the core data tables only: API pods starting in
        # parallel seed small rows (catalog meta, GSI token) that must not
        # block the import — those tables are merged, not overwritten.
        for table in _CORE_TABLES:
            if table in pg and conn.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone():
                logger.info("Postgres already has data (%s) — skipping SQLite import", table)
                return None
    logger.info("empty Postgres + SQLite data at %s — importing", sqlite_path)
    return migrate(sqlite_path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sqlite", type=Path, default=settings.db_path)
    ap.add_argument("--force", action="store_true", help="truncate Postgres tables before copying")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for table, n in migrate(args.sqlite, force=args.force).items():
        print(f"{table:28s} {n}")


if __name__ == "__main__":
    main()
