"""
Persistent HLTV match/event catalog.

Shallow rows come from /results pages (cheap — the hourly refresh reads a
page or two); per-match enrichment (maps played, per-map demo links, team
logos) costs one match-page fetch and happens once per match, right after
the row first appears. Rows live in the same SQLite file as the lineup
tables so persistence stays one volume, one backup.

Storage reality check: catalog rows are a few KB per match. The expensive
artifact is always the .dem itself (~250 MB per map), which is why
`enforce_demo_retention` exists.
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import List, Optional, Set

from backend.config import settings
from backend.models.schemas import HLTVMatch

logger = logging.getLogger(__name__)


def is_big_event(event: str, stars: int) -> bool:
    """Auto-pull criterion: HLTV star rating or a tier-1 event-name pattern."""
    if stars >= settings.catalog_autopull_min_stars:
        return True
    try:
        return bool(re.search(settings.catalog_autopull_event_regex, event, re.I))
    except re.error:
        logger.warning("Bad CATALOG_AUTOPULL_EVENT_REGEX — ignoring")
        return False


def demo_dir_bytes(demo_dir: Path) -> int:
    if not demo_dir.exists():
        return 0
    return sum(p.stat().st_size for p in demo_dir.glob("*.dem"))


def enforce_demo_retention(
    demo_dir: Path, timeline_dir: Path, cap_gb: float,
) -> List[str]:
    """
    FIFO retention: while total .dem bytes exceed the cap, delete the
    oldest-downloaded demo and its timeline cache. Roster sidecars are kept —
    they're tiny and remain useful metadata even without the demo.
    """
    cap_bytes = int(cap_gb * 1024**3)
    deleted: List[str] = []
    dems = sorted(demo_dir.glob("*.dem"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in dems)
    for p in dems:
        if total <= cap_bytes:
            break
        size = p.stat().st_size
        try:
            p.unlink()
        except OSError as exc:
            logger.warning("retention: could not delete %s: %s", p.name, exc)
            continue
        (timeline_dir / f"{p.name}.json").unlink(missing_ok=True)
        total -= size
        deleted.append(p.name)
        logger.info("retention: deleted %s (%.0f MB)", p.name, size / 1024**2)
    return deleted


class MatchCatalog:
    """SQLite-backed store for HLTV match/event metadata."""

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.db_path = db_path or settings.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hltv_matches (
                    match_id       INTEGER PRIMARY KEY,
                    team1          TEXT NOT NULL,
                    team2          TEXT NOT NULL,
                    event          TEXT NOT NULL,
                    date_unix      INTEGER,
                    stars          INTEGER DEFAULT 0,
                    score1         INTEGER,
                    score2         INTEGER,
                    maps_json      TEXT DEFAULT '[]',
                    demo_available INTEGER DEFAULT -1,  -- -1 unknown / 0 no / 1 yes
                    demo_url       TEXT,
                    demo_urls_json TEXT DEFAULT '{}',
                    team1_logo     TEXT,
                    team2_logo     TEXT,
                    enriched_at    INTEGER DEFAULT 0,
                    first_seen     INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_hltv_matches_event"
                " ON hltv_matches(event)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_hltv_matches_date"
                " ON hltv_matches(date_unix)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS catalog_meta"
                " (key TEXT PRIMARY KEY, value TEXT)"
            )

    # ── meta ────────────────────────────────────────────────────────────

    def get_meta(self, key: str) -> Optional[str]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT value FROM catalog_meta WHERE key = ?", (key,)
            ).fetchone()
            return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO catalog_meta(key, value) VALUES(?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    # ── writes ──────────────────────────────────────────────────────────

    def known_ids(self) -> Set[int]:
        with self._conn() as conn:
            return {
                r["match_id"]
                for r in conn.execute("SELECT match_id FROM hltv_matches")
            }

    def upsert_shallow(self, matches: List[HLTVMatch]) -> List[int]:
        """Insert new rows; refresh score/stars/date on known ones. Returns new ids."""
        new_ids: List[int] = []
        now = int(time.time())
        with self._conn() as conn:
            for m in matches:
                exists = conn.execute(
                    "SELECT 1 FROM hltv_matches WHERE match_id = ?",
                    (m.match_id,),
                ).fetchone()
                if exists:
                    conn.execute(
                        "UPDATE hltv_matches SET stars = MAX(stars, ?),"
                        " score1 = COALESCE(?, score1),"
                        " score2 = COALESCE(?, score2),"
                        " date_unix = COALESCE(?, date_unix)"
                        " WHERE match_id = ?",
                        (m.stars, m.score1, m.score2, m.date_unix, m.match_id),
                    )
                else:
                    conn.execute(
                        "INSERT INTO hltv_matches"
                        " (match_id, team1, team2, event, date_unix, stars,"
                        "  score1, score2, first_seen)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            m.match_id, m.team1, m.team2, m.event,
                            m.date_unix, m.stars, m.score1, m.score2, now,
                        ),
                    )
                    new_ids.append(m.match_id)
        return new_ids

    def mark_enriched(
        self,
        match_id: int,
        *,
        maps: List[str],
        demo_available: bool,
        demo_url: Optional[str],
        demo_urls: dict,
        team1_logo: Optional[str],
        team2_logo: Optional[str],
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                "UPDATE hltv_matches SET maps_json = ?, demo_available = ?,"
                " demo_url = ?, demo_urls_json = ?,"
                " team1_logo = COALESCE(?, team1_logo),"
                " team2_logo = COALESCE(?, team2_logo),"
                " enriched_at = ? WHERE match_id = ?",
                (
                    json.dumps(maps), 1 if demo_available else 0,
                    demo_url, json.dumps(demo_urls),
                    team1_logo, team2_logo,
                    int(time.time()), match_id,
                ),
            )

    # ── reads ───────────────────────────────────────────────────────────

    def get(self, match_id: int) -> Optional[dict]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM hltv_matches WHERE match_id = ?", (match_id,)
            ).fetchone()
            return dict(row) if row else None

    def events(self, days: int = 45) -> List[dict]:
        cutoff = int(time.time()) - days * 86400
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT event, COUNT(*) AS match_count,"
                " MIN(date_unix) AS first_date_unix,"
                " MAX(date_unix) AS last_date_unix,"
                " MAX(stars) AS max_stars"
                " FROM hltv_matches"
                " WHERE date_unix IS NULL OR date_unix >= ?"
                " GROUP BY event ORDER BY last_date_unix DESC",
                (cutoff,),
            ).fetchall()
            return [dict(r) for r in rows]

    def matches(
        self,
        *,
        event: Optional[str] = None,
        team: Optional[str] = None,
        days: Optional[int] = None,
        limit: int = 300,
    ) -> List[dict]:
        clauses, params = [], []
        if event:
            clauses.append("event = ?")
            params.append(event)
        if team:
            clauses.append("(team1 LIKE ? OR team2 LIKE ?)")
            params.extend([f"%{team}%", f"%{team}%"])
        if days:
            clauses.append("(date_unix IS NULL OR date_unix >= ?)")
            params.append(int(time.time()) - days * 86400)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM hltv_matches {where}"
                " ORDER BY date_unix DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def row_to_match(self, row: dict) -> HLTVMatch:
        """Rebuild an HLTVMatch (with stored demo links) for the downloader."""
        return HLTVMatch(
            match_id=row["match_id"],
            team1=row["team1"],
            team2=row["team2"],
            event=row["event"],
            date=(
                time.strftime("%Y-%m-%d", time.gmtime(row["date_unix"]))
                if row.get("date_unix") else None
            ),
            date_unix=row.get("date_unix"),
            stars=row.get("stars") or 0,
            demo_url=row.get("demo_url"),
            demo_urls=json.loads(row.get("demo_urls_json") or "{}"),
            team1_logo=row.get("team1_logo"),
            team2_logo=row.get("team2_logo"),
        )
