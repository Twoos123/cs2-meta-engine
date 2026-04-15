"""
Player statistics — cross-demo aggregation of per-player performance.

Source of truth is the cached timeline JSON (``data/timelines/*.json``), which
already contains everything needed: rounds, deaths, grenades, and per-tick
positions. This module reads a timeline dict and produces one row per
(player, demo, side) suitable for insertion into the ``player_stats`` table.
Query-time roll-ups in the FastAPI layer combine these rows into profile
summaries and detail views.

We deliberately do NOT re-parse .dem files here; the heavy parsing already
happened when the user opened a demo in the replay viewer.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from backend.config import settings

logger = logging.getLogger(__name__)


_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS player_stats (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    steamid        TEXT NOT NULL,
    name           TEXT NOT NULL,
    demo_file      TEXT NOT NULL,
    map_name       TEXT NOT NULL,
    side           TEXT NOT NULL,        -- "T" | "CT"
    rounds_played  INTEGER DEFAULT 0,
    kills          INTEGER DEFAULT 0,
    deaths         INTEGER DEFAULT 0,
    hs_kills       INTEGER DEFAULT 0,
    opening_kills  INTEGER DEFAULT 0,
    opening_deaths INTEGER DEFAULT 0,
    multi_2k       INTEGER DEFAULT 0,
    multi_3k       INTEGER DEFAULT 0,
    multi_4k       INTEGER DEFAULT 0,
    multi_5k       INTEGER DEFAULT 0,
    smokes_thrown  INTEGER DEFAULT 0,
    flashes_thrown INTEGER DEFAULT 0,
    hes_thrown     INTEGER DEFAULT 0,
    molos_thrown   INTEGER DEFAULT 0,
    rounds_alive   INTEGER DEFAULT 0,
    awp_kills      INTEGER DEFAULT 0,
    wallbang_kills INTEGER DEFAULT 0,
    noscope_kills  INTEGER DEFAULT 0,
    smoke_kills    INTEGER DEFAULT 0,
    blind_kills    INTEGER DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(steamid, demo_file, side)
);

CREATE INDEX IF NOT EXISTS idx_player_stats_steamid ON player_stats(steamid);
CREATE INDEX IF NOT EXISTS idx_player_stats_map ON player_stats(map_name);
CREATE INDEX IF NOT EXISTS idx_player_stats_demo ON player_stats(demo_file);
"""


_TRUE_VALUES = {"True", "true", "1", True, 1}


def _is_true(v: Any) -> bool:
    return v in _TRUE_VALUES


def _tick_to_round_num(rounds: List[dict], tick: int) -> int:
    for r in rounds:
        if r["start_tick"] <= tick <= r["end_tick"]:
            return int(r["num"])
    return 0


def _sample_at_tick(samples: List[dict], tick: int) -> Optional[dict]:
    """Binary-search nearest position sample for a given tick."""
    if not samples:
        return None
    lo, hi = 0, len(samples) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if samples[mid]["t"] < tick:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0 and abs(samples[lo - 1]["t"] - tick) < abs(samples[lo]["t"] - tick):
        return samples[lo - 1]
    return samples[lo]


def _side_at_tick(positions: Dict[str, List[dict]], steamid: str, tick: int) -> Optional[str]:
    s = _sample_at_tick(positions.get(steamid, []), tick)
    if not s:
        return None
    tn = s.get("tn")
    if tn == 2:
        return "T"
    if tn == 3:
        return "CT"
    return None


def aggregate_timeline(bundle: dict, demo_file: str) -> List[dict]:
    """
    Collapse a timeline bundle into per-(player, side) rows.

    Mirrors the logic in the frontend StatsPanel, plus side-aware attribution:
    each round is accounted to the side the player was on that round, so a
    player's T-half kills don't pollute their CT-half profile.

    Returns a list of dicts ready to bulk-insert into ``player_stats``.
    """
    map_name = bundle.get("map_name", "unknown")
    rounds: List[dict] = bundle.get("rounds", []) or []
    players: List[dict] = bundle.get("players", []) or []
    events: List[dict] = bundle.get("events", []) or []
    grenades: List[dict] = bundle.get("grenades", []) or []
    positions: Dict[str, List[dict]] = bundle.get("positions", {}) or {}

    if not rounds or not players:
        return []

    # Initialize (steamid, side) → stat row
    stats: Dict[Tuple[str, str], dict] = {}

    def _row(sid: str, name: str, side: str) -> dict:
        key = (sid, side)
        row = stats.get(key)
        if row is None:
            row = {
                "steamid": sid,
                "name": name,
                "demo_file": demo_file,
                "map_name": map_name,
                "side": side,
                "rounds_played": 0,
                "kills": 0,
                "deaths": 0,
                "hs_kills": 0,
                "opening_kills": 0,
                "opening_deaths": 0,
                "multi_2k": 0, "multi_3k": 0, "multi_4k": 0, "multi_5k": 0,
                "smokes_thrown": 0, "flashes_thrown": 0,
                "hes_thrown": 0, "molos_thrown": 0,
                "rounds_alive": 0,
                "awp_kills": 0,
                "wallbang_kills": 0, "noscope_kills": 0,
                "smoke_kills": 0, "blind_kills": 0,
            }
            stats[key] = row
        return row

    # Player name lookup (fallback to steamid when name is missing)
    name_by_sid = {p["steamid"]: p.get("name") or p["steamid"] for p in players}

    # Per-round side attribution: side of each player on each round.
    # We sample tn at a tick a few seconds into the round (past freezetime)
    # so it reflects the side they actually played, not a mid-round desync.
    round_side: Dict[Tuple[int, str], str] = {}
    for r in rounds:
        tick = r["start_tick"] + 320   # ~5s into round
        for sid in name_by_sid:
            side = _side_at_tick(positions, sid, tick)
            if side:
                round_side[(int(r["num"]), sid)] = side

    # Rounds played + rounds alive, attributed to each round's side
    for r in rounds:
        rn = int(r["num"])
        end_tick = int(r["end_tick"])
        for sid, name in name_by_sid.items():
            side = round_side.get((rn, sid))
            if not side:
                continue
            row = _row(sid, name, side)
            row["rounds_played"] += 1
            # Alive at round end?
            samples = positions.get(sid, [])
            nearest = _sample_at_tick(samples, end_tick)
            if nearest and nearest.get("alive"):
                row["rounds_alive"] += 1

    # Kills + deaths
    # Track first kill per round for opening-duel accounting.
    round_first_kill: Dict[int, bool] = {}
    round_kill_counts: Dict[Tuple[int, str], int] = {}  # (round, attacker) → count

    for evt in events:
        if evt.get("type") != "death":
            continue
        tick = int(evt["tick"])
        rn = _tick_to_round_num(rounds, tick)
        if rn == 0:
            continue
        data = evt.get("data", {}) or {}
        attacker = data.get("attacker")
        victim = data.get("victim")
        weapon = (data.get("weapon") or "").lower()

        if victim:
            vside = round_side.get((rn, victim))
            if vside:
                _row(victim, name_by_sid.get(victim, victim), vside)["deaths"] += 1

        if attacker and victim and attacker != victim:
            aside = round_side.get((rn, attacker))
            if aside:
                arow = _row(attacker, name_by_sid.get(attacker, attacker), aside)
                arow["kills"] += 1
                if _is_true(data.get("headshot")):
                    arow["hs_kills"] += 1
                pen = data.get("penetrated")
                if pen and str(pen) not in ("0", "False", "false"):
                    arow["wallbang_kills"] += 1
                if _is_true(data.get("noscope")):
                    arow["noscope_kills"] += 1
                if _is_true(data.get("thrusmoke")):
                    arow["smoke_kills"] += 1
                if _is_true(data.get("attackerblind")):
                    arow["blind_kills"] += 1
                if "awp" in weapon:
                    arow["awp_kills"] += 1

                # Opening duel — only the first kill of the round counts
                if not round_first_kill.get(rn):
                    round_first_kill[rn] = True
                    arow["opening_kills"] += 1
                    if vside := round_side.get((rn, victim)):
                        _row(victim, name_by_sid.get(victim, victim), vside)["opening_deaths"] += 1

                # Multi-kill counter
                key = (rn, attacker)
                round_kill_counts[key] = round_kill_counts.get(key, 0) + 1

    # Resolve multi-kill buckets per round
    for (rn, sid), count in round_kill_counts.items():
        side = round_side.get((rn, sid))
        if not side:
            continue
        row = _row(sid, name_by_sid.get(sid, sid), side)
        if count >= 5:
            row["multi_5k"] += 1
        elif count >= 4:
            row["multi_4k"] += 1
        elif count >= 3:
            row["multi_3k"] += 1
        elif count >= 2:
            row["multi_2k"] += 1

    # Grenade usage — attribute to side held at throw time (first point's tick)
    for g in grenades:
        thrower = g.get("thrower")
        pts = g.get("points") or []
        if not thrower or not pts:
            continue
        throw_tick = int(pts[0][0])
        rn = _tick_to_round_num(rounds, throw_tick)
        side = round_side.get((rn, thrower))
        if not side:
            side = _side_at_tick(positions, thrower, throw_tick)
        if not side:
            continue
        row = _row(thrower, name_by_sid.get(thrower, thrower), side)
        t = g.get("type")
        if t == "smokegrenade":
            row["smokes_thrown"] += 1
        elif t == "flashbang":
            row["flashes_thrown"] += 1
        elif t == "hegrenade":
            row["hes_thrown"] += 1
        elif t in ("molotov", "incgrenade"):
            row["molos_thrown"] += 1

    return list(stats.values())


class PlayerStatsStore:
    """
    SQLite-backed store for per-demo, per-side player stat rows. Upserts on
    (steamid, demo_file, side) so re-ingesting the same demo replaces the
    old row rather than duplicating.
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.db_path = db_path or settings.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SQLITE_SCHEMA)
            conn.commit()

    def upsert_rows(self, rows: Iterable[dict]) -> int:
        rows = list(rows)
        if not rows:
            return 0
        cols = [
            "steamid", "name", "demo_file", "map_name", "side",
            "rounds_played", "kills", "deaths", "hs_kills",
            "opening_kills", "opening_deaths",
            "multi_2k", "multi_3k", "multi_4k", "multi_5k",
            "smokes_thrown", "flashes_thrown", "hes_thrown", "molos_thrown",
            "rounds_alive", "awp_kills", "wallbang_kills",
            "noscope_kills", "smoke_kills", "blind_kills",
        ]
        placeholders = ",".join(["?"] * len(cols))
        update_cols = ",".join(f"{c}=excluded.{c}" for c in cols if c not in ("steamid", "demo_file", "side"))
        sql = (
            f"INSERT INTO player_stats ({','.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT(steamid, demo_file, side) DO UPDATE SET {update_cols}"
        )
        values = [tuple(r.get(c, 0) for c in cols) for r in rows]
        with self._connect() as conn:
            conn.executemany(sql, values)
            conn.commit()
        return len(values)

    def ingest_timeline(self, bundle: dict, demo_file: str) -> int:
        """Aggregate a timeline and persist its rows. Returns row count."""
        rows = aggregate_timeline(bundle, demo_file)
        return self.upsert_rows(rows)

    def refresh_from_cache(self, cache_dir: Path) -> dict:
        """
        Re-scan every cached timeline JSON in ``cache_dir`` and upsert its
        player stats. Use this after changing the aggregation logic or when
        the DB got out of sync with the cached timelines.
        """
        timelines = sorted(cache_dir.glob("*.json"))
        total = len(timelines)
        count = 0
        scanned = 0
        errors = 0
        logger.info("[player_stats] aggregating %d cached timelines", total)
        for i, p in enumerate(timelines, 1):
            scanned += 1
            try:
                with p.open("r", encoding="utf-8") as f:
                    bundle = json.load(f)
            except Exception as exc:
                logger.warning("[player_stats] %d/%d read failed %s: %s", i, total, p.name, exc)
                errors += 1
                continue
            demo_file = p.stem  # strip .json; cache file is named `<demo>.dem.json`
            try:
                rows = self.ingest_timeline(bundle, demo_file)
                count += rows
                logger.info(
                    "[player_stats] aggregated %d/%d — %s (+%d rows)",
                    i, total, demo_file, rows,
                )
            except Exception as exc:
                logger.exception("[player_stats] %d/%d aggregate failed %s: %s", i, total, p.name, exc)
                errors += 1
        logger.info(
            "[player_stats] refresh complete: %d timelines, %d rows, %d errors",
            scanned, count, errors,
        )
        return {"scanned": scanned, "rows_upserted": count, "errors": errors}

    # ------------------------------------------------------------------
    # Read path — summaries + detail
    # ------------------------------------------------------------------

    def list_summaries(self) -> List[dict]:
        """
        Return one row per player with aggregated totals across all demos
        and both sides. Used by the /api/players list page.
        """
        sql = """
        SELECT
            steamid,
            MAX(name) AS name,
            COUNT(DISTINCT demo_file) AS matches,
            SUM(rounds_played) AS rounds_played,
            SUM(kills) AS kills,
            SUM(deaths) AS deaths,
            SUM(hs_kills) AS hs_kills,
            SUM(opening_kills) AS opening_kills,
            SUM(opening_deaths) AS opening_deaths,
            SUM(multi_2k) AS multi_2k,
            SUM(multi_3k) AS multi_3k,
            SUM(multi_4k) AS multi_4k,
            SUM(multi_5k) AS multi_5k,
            SUM(smokes_thrown) AS smokes_thrown,
            SUM(flashes_thrown) AS flashes_thrown,
            SUM(hes_thrown) AS hes_thrown,
            SUM(molos_thrown) AS molos_thrown,
            SUM(rounds_alive) AS rounds_alive,
            SUM(awp_kills) AS awp_kills
        FROM player_stats
        GROUP BY steamid
        HAVING rounds_played > 0
        """
        with self._connect() as conn:
            rows = conn.execute(sql).fetchall()
        return [dict(r) for r in rows]

    def get_detail(self, steamid: str) -> Optional[dict]:
        """
        Return detail payload for a single player: totals, per-map splits,
        per-side splits, and the list of demos they appear in.
        """
        with self._connect() as conn:
            base = conn.execute(
                "SELECT MAX(name) AS name FROM player_stats WHERE steamid = ?",
                (steamid,),
            ).fetchone()
            if not base or not base["name"]:
                return None
            name = base["name"]

            totals = conn.execute(
                """
                SELECT
                    COUNT(DISTINCT demo_file) AS matches,
                    SUM(rounds_played) AS rounds_played,
                    SUM(kills) AS kills,
                    SUM(deaths) AS deaths,
                    SUM(hs_kills) AS hs_kills,
                    SUM(opening_kills) AS opening_kills,
                    SUM(opening_deaths) AS opening_deaths,
                    SUM(multi_2k) AS multi_2k,
                    SUM(multi_3k) AS multi_3k,
                    SUM(multi_4k) AS multi_4k,
                    SUM(multi_5k) AS multi_5k,
                    SUM(smokes_thrown) AS smokes_thrown,
                    SUM(flashes_thrown) AS flashes_thrown,
                    SUM(hes_thrown) AS hes_thrown,
                    SUM(molos_thrown) AS molos_thrown,
                    SUM(rounds_alive) AS rounds_alive,
                    SUM(awp_kills) AS awp_kills,
                    SUM(wallbang_kills) AS wallbang_kills,
                    SUM(noscope_kills) AS noscope_kills,
                    SUM(smoke_kills) AS smoke_kills,
                    SUM(blind_kills) AS blind_kills
                FROM player_stats
                WHERE steamid = ?
                """,
                (steamid,),
            ).fetchone()

            per_side = conn.execute(
                """
                SELECT
                    side,
                    SUM(rounds_played) AS rounds_played,
                    SUM(kills) AS kills,
                    SUM(deaths) AS deaths,
                    SUM(opening_kills) AS opening_kills,
                    SUM(opening_deaths) AS opening_deaths,
                    SUM(rounds_alive) AS rounds_alive
                FROM player_stats
                WHERE steamid = ?
                GROUP BY side
                """,
                (steamid,),
            ).fetchall()

            per_map = conn.execute(
                """
                SELECT
                    map_name,
                    COUNT(DISTINCT demo_file) AS matches,
                    SUM(rounds_played) AS rounds_played,
                    SUM(kills) AS kills,
                    SUM(deaths) AS deaths,
                    SUM(rounds_alive) AS rounds_alive,
                    SUM(opening_kills) AS opening_kills,
                    SUM(opening_deaths) AS opening_deaths
                FROM player_stats
                WHERE steamid = ?
                GROUP BY map_name
                ORDER BY matches DESC
                """,
                (steamid,),
            ).fetchall()

            demos = conn.execute(
                """
                SELECT
                    demo_file,
                    MAX(map_name) AS map_name,
                    SUM(kills) AS kills,
                    SUM(deaths) AS deaths,
                    SUM(rounds_played) AS rounds_played
                FROM player_stats
                WHERE steamid = ?
                GROUP BY demo_file
                ORDER BY demo_file DESC
                LIMIT 50
                """,
                (steamid,),
            ).fetchall()

        return {
            "steamid": steamid,
            "name": name,
            "totals": dict(totals) if totals else {},
            "per_side": [dict(r) for r in per_side],
            "per_map": [dict(r) for r in per_map],
            "demos": [dict(r) for r in demos],
        }
