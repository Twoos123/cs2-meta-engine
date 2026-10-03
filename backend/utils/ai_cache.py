"""
Tiny SQLite-backed KV for paid LLM outputs (match recaps, lineup
descriptions). The in-process dicts in main.py stay as a hot layer; this
survives pod restarts so a redeploy never re-bills the same prompt.
Uses the app database (SQLite locally, Postgres when DATABASE_URL is set).
"""
from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Optional

from backend import db

logger = logging.getLogger(__name__)


class AICache:
    def __init__(self, db_path: Optional[Path] = None) -> None:
        # An explicit path pins a private SQLite file (tests); otherwise use
        # the shared app database.
        self.db_path = db_path
        if db_path is not None:
            db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS ai_cache ("
                " kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,"
                " created INTEGER NOT NULL, PRIMARY KEY (kind, key))"
            )

    def _conn(self):
        if self.db_path is not None:
            return sqlite3.connect(self.db_path)
        return db.connect()

    def get(self, kind: str, key: str) -> Optional[str]:
        try:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT value FROM ai_cache WHERE kind = ? AND key = ?",
                    (kind, key),
                ).fetchone()
                return row[0] if row else None
        except Exception as exc:  # sqlite3 / psycopg2 errors
            logger.warning("ai_cache read failed: %s", exc)
            return None

    def put(self, kind: str, key: str, value: str) -> None:
        try:
            with self._conn() as conn:
                conn.execute(
                    "INSERT INTO ai_cache(kind, key, value, created)"
                    " VALUES(?, ?, ?, ?)"
                    " ON CONFLICT(kind, key) DO UPDATE SET"
                    " value = excluded.value, created = excluded.created",
                    (kind, key, value, int(time.time())),
                )
        except Exception as exc:  # sqlite3 / psycopg2 errors
            logger.warning("ai_cache write failed: %s", exc)


ai_cache = AICache()
