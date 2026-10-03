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
from bisect import bisect_right
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

# ---------------------------------------------------------------------------
# Advanced per-row counters (ADR / KAST / trades / clutches)
# ---------------------------------------------------------------------------
# Added after the original schema, so they're migrated in with
# `ALTER TABLE ... ADD COLUMN` (see PlayerStatsStore._migrate). All INTEGER,
# default 0 — rows written before this change read as "no data" via the
# has_* flags, never as "zero damage".
#
#   assists        assists in this (demo, side)
#   damage         total damage dealt (sum of per-round counter diffs)
#   kast_rounds    rounds with a Kill, Assist, Survival or Traded death
#   trade_kills    kills that avenged a teammate (see TRADE_WINDOW_SECONDS)
#   traded_deaths  deaths that a teammate avenged within the window
#   clutch_att_N   1vN situations entered (N = 1..5)
#   clutch_won_N   ...of which the player's team won the round
#   has_adr        1 when the timeline had the cumulative `dmg` counter
#   has_assists    1 when assists came from the `ast` counter or death events
#   has_kast       1 when the row was built by the KAST/trade/clutch logic
#                  (0 = legacy row from before these columns existed)
CLUTCH_SIZES = (1, 2, 3, 4, 5)
_V2_COLUMNS: List[str] = [
    "assists", "damage", "kast_rounds", "trade_kills", "traded_deaths",
    *(f"clutch_att_{n}" for n in CLUTCH_SIZES),
    *(f"clutch_won_{n}" for n in CLUTCH_SIZES),
    "has_adr", "has_assists", "has_kast",
]

# Trade window: a kill counts as a trade when it happens within this many
# seconds of the teammate's death it avenges (HLTV / Leetify use ~5s).
TRADE_WINDOW_SECONDS = 5

# SQL SELECT fragment shared by every read query: sums of the advanced
# counters, plus the round/kill/death totals restricted to rows that
# actually carry the data so rates aren't diluted by legacy rows.
_V2_SUMS_SQL = ",\n".join(
    [f"SUM({c}) AS {c}" for c in _V2_COLUMNS if not c.startswith("has_")]
    + [
        "SUM(CASE WHEN has_adr = 1 THEN rounds_played ELSE 0 END) AS adr_rounds",
        "SUM(CASE WHEN has_assists = 1 THEN rounds_played ELSE 0 END) AS assist_rounds",
        "SUM(CASE WHEN has_kast = 1 THEN rounds_played ELSE 0 END) AS kast_total_rounds",
        "SUM(CASE WHEN has_kast = 1 THEN kills ELSE 0 END) AS kast_kills",
        "SUM(CASE WHEN has_kast = 1 THEN deaths ELSE 0 END) AS kast_deaths",
    ]
)


# Plain sums of the original counters, shared by every read query.
_BASE_SUMS_SQL = ",\n".join(
    f"SUM({c}) AS {c}"
    for c in (
        "rounds_played", "kills", "deaths", "hs_kills",
        "opening_kills", "opening_deaths",
        "multi_2k", "multi_3k", "multi_4k", "multi_5k",
        "smokes_thrown", "flashes_thrown", "hes_thrown", "molos_thrown",
        "rounds_alive", "awp_kills",
    )
)

_TRUE_VALUES = {"True", "true", "1", True, 1}


def _is_true(v: Any) -> bool:
    return v in _TRUE_VALUES


def _counter_at(ticks: List[int], samples: List[dict], key: str, tick: int) -> Optional[int]:
    """Value of cumulative counter `key` in the last sample at or before
    `tick` (walking back past samples that lack the key). None if no
    sample at or before `tick` carries it."""
    i = bisect_right(ticks, tick) - 1
    while i >= 0:
        v = samples[i].get(key)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                return None
        i -= 1
    return None


def _per_round_counter_diffs(
    samples: List[dict], rounds: List[dict], key: str,
) -> Optional[Dict[int, int]]:
    """
    Per-round increments of a cumulative per-player counter (``dmg``,
    ``ast``): value at the last sample at or before each round's end tick,
    minus the same for the previous round (or the round-1 start tick).
    A negative diff means the game reset the counter (e.g. a restart after
    warmup), in which case the round's end value is taken as-is.
    Returns None when the timeline predates the counter.
    """
    if not samples or not any(s.get(key) is not None for s in samples):
        return None
    ticks = [int(s["t"]) for s in samples]
    prev = _counter_at(ticks, samples, key, int(rounds[0]["start_tick"])) or 0
    out: Dict[int, int] = {}
    for r in rounds:
        cur = _counter_at(ticks, samples, key, int(r["end_tick"]))
        if cur is None:
            cur = prev
        diff = cur - prev
        out[int(r["num"])] = cur if diff < 0 else diff
        prev = cur
    return out


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
                **{c: 0 for c in _V2_COLUMNS},
                "has_kast": 1,
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

    _aggregate_advanced(
        rounds=rounds,
        events=events,
        positions=positions,
        round_side=round_side,
        name_by_sid=name_by_sid,
        tick_rate=int(bundle.get("tick_rate") or 64),
        row_for=_row,
    )

    return list(stats.values())


def _aggregate_advanced(
    *,
    rounds: List[dict],
    events: List[dict],
    positions: Dict[str, List[dict]],
    round_side: Dict[Tuple[int, str], str],
    name_by_sid: Dict[str, str],
    tick_rate: int,
    row_for,
) -> None:
    """
    ADR, KAST, trades and clutches. Mutates the per-(player, side) rows
    returned by ``row_for(steamid, name, side)``.

    Definitions
    -----------
    * Trade window — ``TRADE_WINDOW_SECONDS`` (5s) × tick_rate ticks.
    * Trade kill — the player kills an enemy who, within the previous
      window, killed one of the player's teammates.
    * Traded death — the player dies and their killer is killed by one of
      the player's teammates within the window after the death.
    * KAST — a round counts when the player got a Kill, an Assist,
      Survived (no death event that round) or was Traded.
    * Assists — per-round diffs of the cumulative ``ast`` counter; falls
      back to an ``assister`` key on death events when the counter is
      missing (older caches have neither, so assists stay unknown).
    * Damage / ADR — per-round diffs of the cumulative ``dmg`` counter,
      sampled at the last position at or before each round's end tick.
      Missing counter → ``has_adr`` = 0 and ADR is reported as null.
    * Clutch (1vX) — the moment a player becomes the last one alive on
      their team while X ≥ 1 enemies are still alive. At most one clutch
      per team per round; won = their team won the round. Only deaths
      after freeze time ends are counted, so warmup kills can't fake one.

    All attribution follows ``round_side`` (the side the player played that
    round); deaths are bucketed by round using the [start_tick, end_tick]
    window, the same as kills/deaths in ``aggregate_timeline``.
    """
    window = TRADE_WINDOW_SECONDS * max(int(tick_rate or 64), 1)

    # ── Death events grouped by round, in tick order ──
    deaths_by_round: Dict[int, List[dict]] = {int(r["num"]): [] for r in rounds}
    for evt in events:
        if evt.get("type") != "death":
            continue
        tick = int(evt["tick"])
        rn = _tick_to_round_num(rounds, tick)
        if rn == 0:
            continue
        data = evt.get("data", {}) or {}
        victim = data.get("victim") or ""
        if not victim:
            continue
        deaths_by_round[rn].append({
            "tick": tick,
            "attacker": data.get("attacker") or "",
            "victim": victim,
            "assister": data.get("assister") or "",
        })
    for lst in deaths_by_round.values():
        lst.sort(key=lambda d: d["tick"])

    # ── Per-round damage / assist increments from cumulative counters ──
    dmg_diffs: Dict[str, Optional[Dict[int, int]]] = {}
    ast_diffs: Dict[str, Optional[Dict[int, int]]] = {}
    for sid in name_by_sid:
        samples = positions.get(sid, []) or []
        dmg_diffs[sid] = _per_round_counter_diffs(samples, rounds, "dmg")
        ast_diffs[sid] = _per_round_counter_diffs(samples, rounds, "ast")
    has_assister_events = any(
        d["assister"] for lst in deaths_by_round.values() for d in lst
    )

    for r in rounds:
        rn = int(r["num"])
        winner = r.get("winner")
        deaths = deaths_by_round.get(rn, [])

        def side_of(sid: str) -> Optional[str]:
            return round_side.get((rn, sid)) if sid else None

        def is_enemy_kill(d: dict) -> bool:
            a, v = d["attacker"], d["victim"]
            if not a or a == v:
                return False
            a_side, v_side = side_of(a), side_of(v)
            return a_side is not None and a_side != v_side

        killed: set = set()      # got at least one enemy kill
        died: set = set()
        traded: set = set()      # had a death avenged
        event_assists: Dict[str, int] = {}

        for i, d in enumerate(deaths):
            died.add(d["victim"])
            if d["assister"]:
                event_assists[d["assister"]] = event_assists.get(d["assister"], 0) + 1
            if not is_enemy_kill(d):
                continue
            killer, victim = d["attacker"], d["victim"]
            killed.add(killer)
            k_side = side_of(killer)

            # Trade kill: `victim` killed one of `killer`'s teammates in the
            # preceding window. Each such avenged teammate is a traded death.
            is_trade = False
            for prev in deaths[:i]:
                if d["tick"] - prev["tick"] > window:
                    continue
                if (
                    prev["attacker"] == victim
                    and prev["victim"] != killer
                    and side_of(prev["victim"]) == k_side
                ):
                    is_trade = True
                    if prev["victim"] not in traded:
                        traded.add(prev["victim"])
                        row_for(
                            prev["victim"],
                            name_by_sid.get(prev["victim"], prev["victim"]),
                            k_side,
                        )["traded_deaths"] += 1
            if is_trade:
                row_for(killer, name_by_sid.get(killer, killer), k_side)["trade_kills"] += 1

        # ── Clutches ──
        live_from = int(r.get("freeze_end_tick") or r["start_tick"])
        alive: Dict[str, set] = {"T": set(), "CT": set()}
        for sid in name_by_sid:
            s = side_of(sid)
            if s in alive:
                alive[s].add(sid)
        clutched: set = set()
        for d in deaths:
            if d["tick"] < live_from:
                continue
            v_side = side_of(d["victim"])
            if v_side not in alive:
                continue
            alive[v_side].discard(d["victim"])
            for side, other in (("T", "CT"), ("CT", "T")):
                if side in clutched or len(alive[side]) != 1 or not alive[other]:
                    continue
                clutched.add(side)
                (sid,) = tuple(alive[side])
                x = min(len(alive[other]), 5)
                row = row_for(sid, name_by_sid.get(sid, sid), side)
                row[f"clutch_att_{x}"] += 1
                if winner == side:
                    row[f"clutch_won_{x}"] += 1

        # ── Per-player round accounting: damage, assists, KAST ──
        for sid, name in name_by_sid.items():
            side = side_of(sid)
            if not side:
                continue
            row = row_for(sid, name, side)

            dd = dmg_diffs.get(sid)
            if dd is not None:
                row["has_adr"] = 1
                row["damage"] += dd.get(rn, 0)

            ad = ast_diffs.get(sid)
            if ad is not None:
                round_assists = ad.get(rn, 0)
                row["has_assists"] = 1
            elif has_assister_events:
                round_assists = event_assists.get(sid, 0)
                row["has_assists"] = 1
            else:
                round_assists = 0
            row["assists"] += round_assists

            if sid in killed or round_assists > 0 or sid not in died or sid in traded:
                row["kast_rounds"] += 1


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
        # The app DB goes through the shared connector (Postgres-ready);
        # an explicit db_path (tests, tooling) keeps a direct connection.
        if Path(self.db_path) == Path(settings.db_path):
            from backend.db import connect

            return connect()
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SQLITE_SCHEMA)
            conn.commit()
        self._migrate()

    def _migrate(self) -> None:
        """Add the ADR/KAST/trade/clutch columns to pre-existing tables.
        Existing columns are read from the cursor description (portable,
        no PRAGMA); each ADD COLUMN is still guarded in case another
        process raced us to it."""
        with self._connect() as conn:
            cur = conn.execute("SELECT * FROM player_stats LIMIT 0")
            existing = {d[0] for d in cur.description}
            for col in _V2_COLUMNS:
                if col in existing:
                    continue
                try:
                    conn.execute(f"ALTER TABLE player_stats ADD COLUMN {col} INTEGER DEFAULT 0")
                except Exception as exc:  # already added concurrently
                    logger.debug("[player_stats] add column %s skipped: %s", col, exc)
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
            *_V2_COLUMNS,
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
        sql = f"""
        SELECT
            steamid,
            MAX(name) AS name,
            COUNT(DISTINCT demo_file) AS matches,
            {_BASE_SUMS_SQL},
            {_V2_SUMS_SQL}
        FROM player_stats
        GROUP BY steamid
        HAVING SUM(rounds_played) > 0
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
                f"""
                SELECT
                    COUNT(DISTINCT demo_file) AS matches,
                    {_BASE_SUMS_SQL},
                    SUM(wallbang_kills) AS wallbang_kills,
                    SUM(noscope_kills) AS noscope_kills,
                    SUM(smoke_kills) AS smoke_kills,
                    SUM(blind_kills) AS blind_kills,
                    {_V2_SUMS_SQL}
                FROM player_stats
                WHERE steamid = ?
                """,
                (steamid,),
            ).fetchone()

            per_side = conn.execute(
                f"""
                SELECT
                    side,
                    {_BASE_SUMS_SQL},
                    {_V2_SUMS_SQL}
                FROM player_stats
                WHERE steamid = ?
                GROUP BY side
                """,
                (steamid,),
            ).fetchall()

            per_map = conn.execute(
                f"""
                SELECT
                    map_name,
                    COUNT(DISTINCT demo_file) AS matches,
                    {_BASE_SUMS_SQL},
                    {_V2_SUMS_SQL}
                FROM player_stats
                WHERE steamid = ?
                GROUP BY map_name
                ORDER BY matches DESC
                """,
                (steamid,),
            ).fetchall()

            demos = conn.execute(
                f"""
                SELECT
                    demo_file,
                    MAX(map_name) AS map_name,
                    {_BASE_SUMS_SQL},
                    {_V2_SUMS_SQL}
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

    def get_match(self, demo_file: str) -> List[dict]:
        """
        Per-player totals for one demo, both sides combined. ``legacy`` is
        1 when any of the player's rows predates the KAST/trade/clutch
        columns (the caller can then re-ingest from the cached timeline).
        """
        sql = f"""
        SELECT
            steamid,
            MAX(name) AS name,
            MAX(map_name) AS map_name,
            MIN(has_kast) AS min_has_kast,
            {_BASE_SUMS_SQL},
            {_V2_SUMS_SQL}
        FROM player_stats
        WHERE demo_file = ?
        GROUP BY steamid
        """
        with self._connect() as conn:
            rows = [dict(r) for r in conn.execute(sql, (demo_file,)).fetchall()]
        for r in rows:
            r["legacy"] = 0 if r.pop("min_has_kast") else 1
        return rows
