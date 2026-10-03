"""
Shared database access for feature modules.

New code should get connections from `connect()` and write portable SQL so
the same statements run on SQLite (local dev) and PostgreSQL (cluster):

- `?` placeholders (translated for Postgres by this module)
- `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` — not `INSERT OR REPLACE`
- `CREATE TABLE IF NOT EXISTS`, `TEXT` / `INTEGER` / `REAL` column types
- no `AUTOINCREMENT`, `PRAGMA`, or SQLite-only functions
"""
from __future__ import annotations

import sqlite3

from backend.config import settings


def connect() -> sqlite3.Connection:
    """Connection to the app database with dict-style rows (`row["col"]`).

    Use as a context manager for a transaction:
        with connect() as conn:
            conn.execute("...", (a, b))
    """
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn
