"""
Persistent match/event catalog, fed by Liquipedia.

Rows come from two Liquipedia sources (see backend/ingestion/liquipedia.py):

- `Liquipedia:Matches` — upcoming + recently completed matches with teams,
  series score, start time and tournament. One cached `action=parse` per
  refresh.
- Tournament pages — maps played and the HLTV match link, parsed only for
  big-tier events that just finished a match (≤ N parses per refresh).

Each row has a stable `match_key` ("lp:<hash>"; legacy HLTV-scraped rows
keep "hltv:<id>"). Rows live in the app database so persistence stays one
volume, one backup. The pre-Liquipedia `hltv_matches` table is copied in
once and then left untouched.

Storage reality check: catalog rows are a few KB per match. The expensive
artifact is always the .dem itself (~250 MB per map), which is why
`enforce_demo_retention` exists.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

from backend.config import settings
from backend.db import connect

logger = logging.getLogger(__name__)

TIER_STARS = {"S": 3, "A": 2, "B": 1}
BIG_TIERS = {"S", "A"}


def tier_stars(tier: Optional[str]) -> int:
    return TIER_STARS.get(tier or "", 0)


def is_big_event(event: str, stars: int, tier: Optional[str] = None) -> bool:
    """Big = Liquipedia S/A-tier, a star rating at the threshold (legacy HLTV
    rows), or a tier-1 event-name pattern."""
    if tier in BIG_TIERS:
        return True
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
    """Store for catalog matches (`catalog_matches`) + small key/value meta."""

    def __init__(self, db_path: Optional[Path] = None) -> None:
        # `db_path` is accepted for backwards compatibility; connections come
        # from backend.db.connect() (settings.db_path).
        self._init_db()

    def _init_db(self) -> None:
        with connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS catalog_matches (
                    match_key      TEXT PRIMARY KEY,
                    source         TEXT NOT NULL,
                    hltv_id        INTEGER,
                    team1          TEXT NOT NULL,
                    team2          TEXT NOT NULL,
                    event          TEXT NOT NULL,
                    event_page     TEXT,
                    stage          TEXT,
                    tier           TEXT,
                    stars          INTEGER DEFAULT 0,
                    date_unix      INTEGER,
                    status         TEXT DEFAULT 'completed',
                    best_of        INTEGER,
                    score1         INTEGER,
                    score2         INTEGER,
                    maps_json      TEXT DEFAULT '[]',
                    demo_available INTEGER DEFAULT -1,
                    team1_logo     TEXT,
                    team2_logo     TEXT,
                    enriched_at    INTEGER DEFAULT 0,
                    completed_at   INTEGER,
                    first_seen     INTEGER NOT NULL,
                    updated_at     INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_catalog_matches_date"
                " ON catalog_matches(date_unix)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_catalog_matches_event"
                " ON catalog_matches(event)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS catalog_meta"
                " (key TEXT PRIMARY KEY, value TEXT)"
            )
        if not self.get_meta("migrated_hltv_matches_v1"):
            self._migrate_hltv_rows()
            self.set_meta("migrated_hltv_matches_v1", str(int(time.time())))

    def _migrate_hltv_rows(self) -> None:
        """Copy rows from the pre-Liquipedia `hltv_matches` table, if any."""
        try:
            with connect() as conn:
                rows = [dict(r) for r in conn.execute("SELECT * FROM hltv_matches")]
        except Exception:
            return  # table never existed
        now = int(time.time())
        with connect() as conn:
            for r in rows:
                conn.execute(
                    "INSERT INTO catalog_matches (match_key, source, hltv_id,"
                    " team1, team2, event, stars, date_unix, status, score1,"
                    " score2, maps_json, demo_available, team1_logo, team2_logo,"
                    " enriched_at, completed_at, first_seen, updated_at)"
                    " VALUES (?, 'hltv', ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?,"
                    " ?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT (match_key) DO NOTHING",
                    (
                        f"hltv:{r['match_id']}", r["match_id"], r["team1"],
                        r["team2"], r["event"], r.get("stars") or 0,
                        r.get("date_unix"), r.get("score1"), r.get("score2"),
                        r.get("maps_json") or "[]",
                        r.get("demo_available", -1),
                        r.get("team1_logo"), r.get("team2_logo"),
                        r.get("enriched_at") or 0, r.get("date_unix"),
                        r.get("first_seen") or now, now,
                    ),
                )
        if rows:
            logger.info("catalog: migrated %d legacy HLTV rows", len(rows))

    # ── meta ────────────────────────────────────────────────────────────

    def get_meta(self, key: str) -> Optional[str]:
        with connect() as conn:
            row = conn.execute(
                "SELECT value FROM catalog_meta WHERE key = ?", (key,)
            ).fetchone()
            return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with connect() as conn:
            conn.execute(
                "INSERT INTO catalog_meta(key, value) VALUES(?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    # ── writes ──────────────────────────────────────────────────────────

    def upsert_matches(
        self,
        matches: Iterable,               # liquipedia.LPMatch
        tiers: Dict[str, Optional[str]],
        *,
        enriched: bool = False,
    ) -> Tuple[int, int]:
        """Insert new Liquipedia matches, refresh known ones. Returns
        (new, updated). `enriched=True` marks rows from a tournament page
        (maps + HLTV link resolved)."""
        new = updated = 0
        now = int(time.time())
        with connect() as conn:
            for m in matches:
                tier = tiers.get(m.page)
                # Enriched only once something was actually found — a result
                # Liquipedia editors haven't filled in yet is retried later.
                done = enriched and m.finished and bool(m.maps or m.hltv_id)
                status = "completed" if m.finished else "upcoming"
                key = m.key
                row = conn.execute(
                    "SELECT match_key, status FROM catalog_matches WHERE match_key = ?",
                    (key,),
                ).fetchone()
                if row is None:
                    # A rescheduled match gets a new key — fold it into the
                    # existing upcoming row for the same pairing.
                    row = conn.execute(
                        "SELECT match_key, status FROM catalog_matches"
                        " WHERE source = 'liquipedia' AND event_page = ?"
                        " AND status = 'upcoming'"
                        " AND ((team1 = ? AND team2 = ?) OR (team1 = ? AND team2 = ?))"
                        " AND date_unix BETWEEN ? AND ?",
                        (
                            m.page, m.team1, m.team2, m.team2, m.team1,
                            m.timestamp - 3 * 86400, m.timestamp + 3 * 86400,
                        ),
                    ).fetchone()
                maps_json = json.dumps(m.maps) if m.maps else None
                if row is None:
                    conn.execute(
                        "INSERT INTO catalog_matches (match_key, source, hltv_id,"
                        " team1, team2, event, event_page, stage, tier, stars,"
                        " date_unix, status, best_of, score1, score2, maps_json,"
                        " enriched_at, completed_at, first_seen, updated_at)"
                        " VALUES (?, 'liquipedia', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        " ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            key, m.hltv_id, m.team1, m.team2, m.event, m.page,
                            m.stage or None, tier, tier_stars(tier), m.timestamp,
                            status, m.best_of, m.score1, m.score2,
                            maps_json or "[]", now if done else 0,
                            now if m.finished else None, now, now,
                        ),
                    )
                    new += 1
                    continue
                became_completed = m.finished and row["status"] != "completed"
                conn.execute(
                    "UPDATE catalog_matches SET match_key = ?,"
                    " hltv_id = COALESCE(?, hltv_id),"
                    " team1 = ?, team2 = ?,"
                    " event = CASE WHEN ? <> '' THEN ? ELSE event END,"
                    " stage = COALESCE(?, stage),"
                    " tier = COALESCE(?, tier), stars = MAX(stars, ?),"
                    " date_unix = ?, status = ?, best_of = COALESCE(?, best_of),"
                    " score1 = COALESCE(?, score1), score2 = COALESCE(?, score2),"
                    " maps_json = COALESCE(?, maps_json),"
                    " enriched_at = CASE WHEN ? > 0 THEN ? ELSE enriched_at END,"
                    " completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,"
                    " updated_at = ?"
                    " WHERE match_key = ?",
                    (
                        key, m.hltv_id, m.team1, m.team2,
                        m.event, m.event, m.stage or None,
                        tier, tier_stars(tier),
                        m.timestamp, status, m.best_of, m.score1, m.score2,
                        maps_json,
                        now if done else 0, now,
                        1 if became_completed else 0, now,
                        now, row["match_key"],
                    ),
                )
                updated += 1
        return new, updated

    # ── reads ───────────────────────────────────────────────────────────

    def tournaments_to_enrich(
        self, tiers: Set[str], limit: int, within_days: int = 3,
    ) -> List[Tuple[str, str, int]]:
        """(page, event, newest completed_at) for big tournaments with freshly
        completed matches that still lack maps / HLTV link."""
        if not tiers or limit <= 0:
            return []
        marks = ",".join("?" for _ in tiers)
        cutoff = int(time.time()) - within_days * 86400
        with connect() as conn:
            rows = conn.execute(
                "SELECT event_page, MAX(event) AS event,"
                " MAX(completed_at) AS completed_at, MAX(date_unix) AS last_date"
                " FROM catalog_matches"
                " WHERE source = 'liquipedia' AND status = 'completed'"
                " AND enriched_at = 0 AND event_page IS NOT NULL"
                f" AND tier IN ({marks}) AND date_unix >= ?"
                " GROUP BY event_page ORDER BY last_date DESC LIMIT ?",
                (*sorted(tiers), cutoff, limit),
            ).fetchall()
        return [
            (r["event_page"], r["event"], int(r["completed_at"] or 0)) for r in rows
        ]

    def get(self, match_key: str) -> Optional[dict]:
        with connect() as conn:
            row = conn.execute(
                "SELECT * FROM catalog_matches WHERE match_key = ?", (match_key,)
            ).fetchone()
            return dict(row) if row else None

    def events(self, days: int = 45) -> List[dict]:
        cutoff = int(time.time()) - days * 86400
        with connect() as conn:
            rows = conn.execute(
                "SELECT event, event_page, tier, stars, source, date_unix"
                " FROM catalog_matches"
                " WHERE date_unix IS NULL OR date_unix >= ?",
                (cutoff,),
            ).fetchall()
        order = ["S", "A", "B", "C"]
        agg: Dict[str, dict] = {}
        for r in rows:
            e = agg.setdefault(r["event"], {
                "event": r["event"], "match_count": 0,
                "first_date_unix": None, "last_date_unix": None,
                "max_stars": 0, "tier": None, "source": r["source"],
                "event_page": r["event_page"],
            })
            e["match_count"] += 1
            d = r["date_unix"]
            if d is not None:
                e["first_date_unix"] = d if e["first_date_unix"] is None else min(e["first_date_unix"], d)
                e["last_date_unix"] = d if e["last_date_unix"] is None else max(e["last_date_unix"], d)
            e["max_stars"] = max(e["max_stars"], r["stars"] or 0)
            t = r["tier"]
            if t and (
                e["tier"] is None
                or (t in order and (e["tier"] not in order or order.index(t) < order.index(e["tier"])))
            ):
                e["tier"] = t
            if r["event_page"] and not e["event_page"]:
                e["event_page"] = r["event_page"]
            if r["source"] == "liquipedia":
                e["source"] = "liquipedia"
        return sorted(agg.values(), key=lambda e: e["last_date_unix"] or 0, reverse=True)

    def matches(
        self,
        *,
        event: Optional[str] = None,
        team: Optional[str] = None,
        days: Optional[int] = None,
        status: Optional[str] = None,
        limit: int = 300,
    ) -> List[dict]:
        clauses, params = [], []
        if event:
            clauses.append("event = ?")
            params.append(event)
        if team:
            clauses.append("(LOWER(team1) LIKE ? OR LOWER(team2) LIKE ?)")
            params.extend([f"%{team.lower()}%", f"%{team.lower()}%"])
        if days:
            clauses.append("(date_unix IS NULL OR date_unix >= ?)")
            params.append(int(time.time()) - days * 86400)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM catalog_matches {where}"
                " ORDER BY date_unix DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            return [dict(r) for r in rows]
