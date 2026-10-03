"""
Seed a small, deterministic dataset for the Playwright e2e suite.

    python scripts/e2e_seed.py <data_dir>

Everything is written under <data_dir>, which becomes the backend's working
directory (``data/timelines`` and the photo cache are cwd-relative):

    <data_dir>/demos/2390001_mirage.dem          placeholder demo (empty)
    <data_dir>/data/lineups.db                   lineup_clusters + player_stats
    <data_dir>/data/timelines/<demo>.json        synthetic cached timeline
    <data_dir>/backend/data/player_photos/*.404  "no photo" markers, so
                                                 avatars never trigger a
                                                 Liquipedia lookup

The contents of <data_dir> are wiped first; the directory itself is kept
because the e2e backend runs with it as cwd. Schema comes from the app's own
modules (MetricsPipeline, PlayerStatsStore), so it stays in step with the
backend.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

DEMO_NAME = "2390001_mirage.dem"
MAP_NAME = "de_mirage"
TICK_RATE = 64
DECIMATION = 8

# (steamid, name, team_num) — 2 = T, 3 = CT.
PLAYERS = [
    ("76561198000000001", "e2e_alpha", 2),
    ("76561198000000002", "e2e_bravo", 2),
    ("76561198000000003", "e2e_charlie", 2),
    ("76561198000000004", "e2e_delta", 2),
    ("76561198000000005", "e2e_echo", 2),
    ("76561198000000006", "e2e_foxtrot", 3),
    ("76561198000000007", "e2e_golf", 3),
    ("76561198000000008", "e2e_hotel", 3),
    ("76561198000000009", "e2e_india", 3),
    ("76561198000000010", "e2e_juliet", 3),
]

# Round layout (ticks): 5 s freeze, 30 s live, then the next round.
ROUND_WINNERS = ["T", "CT", "T"]
FREEZE_TICKS = 5 * TICK_RATE
LIVE_TICKS = 30 * TICK_RATE
ROUND_GAP = 2 * TICK_RATE
ROUND_LEN = FREEZE_TICKS + LIVE_TICKS + ROUND_GAP

# Rough Mirage spawn / mid positions (world units).
T_SPAWN = (1250.0, -50.0)
CT_SPAWN = (-1650.0, -1900.0)
MID = (-350.0, -750.0)

# (label, grenade_type, side, throw xyz, land xyz, pitch, yaw, count, win_rate, thrower)
LINEUPS = [
    ("Mirage Window Smoke", "smokegrenade", "T", (1135, 650, -261), (-1140, -720, -103), -42.0, -151.0, 14, 0.64, "e2e_alpha"),
    ("Mirage Stairs Smoke", "smokegrenade", "T", (1155, -1010, -205), (-150, -1410, -40), -30.0, -167.0, 11, 0.58, "e2e_bravo"),
    ("Mirage Jungle Smoke", "smokegrenade", "T", (1200, -880, -167), (-920, -1170, -40), -35.0, -175.0, 9, 0.55, "e2e_charlie"),
    ("Mirage CT Smoke", "smokegrenade", "T", (1260, -460, -167), (-1140, -1900, -100), -38.0, -140.0, 7, 0.52, "e2e_alpha"),
    ("Mirage Connector Smoke", "smokegrenade", "CT", (-1400, -1500, -167), (-500, -1000, -100), -20.0, 30.0, 5, 0.47, "e2e_golf"),
    ("Mirage A Ramp Flash", "flashbang", "CT", (-300, -2100, -170), (230, -1700, -100), -60.0, 40.0, 8, 0.61, "e2e_hotel"),
    ("Mirage Top Mid Flash", "flashbang", "T", (400, -350, -160), (-200, -500, -100), -55.0, 170.0, 6, 0.50, "e2e_delta"),
]


def _reset_dir(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    for child in data_dir.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    (data_dir / "demos").mkdir()
    (data_dir / "data" / "timelines").mkdir(parents=True)


def _configure(data_dir: Path) -> None:
    """Point backend settings at data_dir. Must run before importing backend."""
    os.chdir(data_dir)
    os.environ.update(
        DEMO_DIR=str(data_dir / "demos"),
        DB_PATH=str(data_dir / "data" / "lineups.db"),
        DATABASE_URL="",
        ADMIN_TOKEN="",
        ANTHROPIC_API_KEY="",
        OPENROUTER_API_KEY="",
        FACEIT_API_KEY="",
    )
    sys.path.insert(0, str(REPO_ROOT))


def seed_lineups() -> int:
    from backend.analysis.metrics import MetricsPipeline
    from backend.models.schemas import LineupCluster, LineupRanking, TopThrower

    rankings = []
    by_type: dict[str, int] = {}
    for i, (label, gtype, side, throw, land, pitch, yaw, count, win, thrower) in enumerate(LINEUPS):
        rank = by_type.get(gtype, 0) + 1
        by_type[gtype] = rank
        mid = ((throw[0] + land[0]) / 2, (throw[1] + land[1]) / 2)
        cluster = LineupCluster(
            cluster_id=i,
            map_name=MAP_NAME,
            grenade_type=gtype,
            land_centroid_x=land[0], land_centroid_y=land[1], land_centroid_z=land[2],
            throw_centroid_x=throw[0], throw_centroid_y=throw[1], throw_centroid_z=throw[2],
            avg_pitch=pitch,
            avg_yaw=yaw,
            throw_count=count,
            round_win_rate=win,
            total_utility_damage=0.0,
            avg_utility_damage=0.0,
            label=label,
            top_throwers=[
                TopThrower(name=thrower, count=count - 2, demo_file=DEMO_NAME,
                           demo_tick=1000 + i * 100, demo_player_slot=1),
                TopThrower(name="e2e_echo", count=2),
            ],
            primary_technique="stand" if i % 2 == 0 else "jump",
            technique_agreement=1.0 if i % 3 else 0.8,
            primary_click="left",
            click_agreement=1.0,
            side=side,
            demo_file=DEMO_NAME,
            demo_tick=1000 + i * 100,
            demo_thrower_name=thrower,
            trajectory=[[throw[0], throw[1]], [mid[0], mid[1]], [land[0], land[1]]],
        )
        rankings.append(LineupRanking(rank=rank, cluster=cluster,
                                      impact_score=round(win * math.log1p(count), 4)))

    pipeline = MetricsPipeline()
    pipeline.clear_all()
    pipeline._persist_rankings(rankings)
    return len(rankings)


def _lerp(a: tuple[float, float], b: tuple[float, float], f: float) -> tuple[float, float]:
    f = max(0.0, min(1.0, f))
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)


def build_timeline() -> dict:
    from backend.ingestion.demo_parser import TIMELINE_CACHE_VERSION

    t_ids = [p[0] for p in PLAYERS if p[2] == 2]
    ct_ids = [p[0] for p in PLAYERS if p[2] == 3]

    rounds, events = [], []
    deaths_by_round: dict[int, list[tuple[int, str, str]]] = {}
    for n, winner in enumerate(ROUND_WINNERS, start=1):
        start = (n - 1) * ROUND_LEN + 100
        freeze_end = start + FREEZE_TICKS
        end = freeze_end + LIVE_TICKS
        rounds.append({"num": n, "start_tick": start, "freeze_end_tick": freeze_end,
                       "end_tick": end, "winner": winner})
        # Two kills per round, alternating who wins the duel.
        a, b = (n - 1) % 5, n % 5
        winners_side, losers_side = (t_ids, ct_ids) if winner == "T" else (ct_ids, t_ids)
        deaths = [
            (freeze_end + 10 * TICK_RATE, winners_side[a], losers_side[a]),
            (freeze_end + 18 * TICK_RATE, losers_side[b], winners_side[b]),
        ]
        deaths_by_round[n] = deaths
        events.append({"type": "round_start", "tick": start, "data": {}})
        events.append({"type": "round_freeze_end", "tick": freeze_end, "data": {}})
        for tick, attacker, victim in deaths:
            events.append({"type": "death", "tick": tick, "data": {
                "attacker": attacker, "victim": victim, "weapon": "ak47",
                "headshot": "True" if n % 2 else "False", "penetrated": "0",
                "noscope": "False", "attackerblind": "False", "thrusmoke": "False",
                "dominated": "0", "revenge": "0",
            }})
        for k, sid in enumerate(t_ids[:2] + ct_ids[:2]):
            events.append({"type": "fire", "tick": freeze_end + (4 + k) * TICK_RATE,
                           "data": {"shooter": sid, "weapon": "ak47"}})
        events.append({"type": "round_end", "tick": end, "data": {"winner": winner}})
    events.sort(key=lambda e: e["tick"])

    positions: dict[str, list[dict]] = {p[0]: [] for p in PLAYERS}
    damage = {p[0]: 0 for p in PLAYERS}
    kills = {p[0]: 0 for p in PLAYERS}
    died = {p[0]: 0 for p in PLAYERS}
    all_deaths = sorted(d for ds in deaths_by_round.values() for d in ds)

    for r in rounds:
        n = r["num"]
        dead_at = {victim: tick for tick, _a, victim in deaths_by_round[n]}
        for tick in range(r["start_tick"], r["end_tick"] + 1, DECIMATION):
            # Cumulative counters only advance on the tick of each kill.
            for dtick, attacker, victim in all_deaths:
                if tick - DECIMATION < dtick <= tick:
                    damage[attacker] += 100
                    kills[attacker] += 1
                    died[victim] += 1
            for idx, (sid, _name, tn) in enumerate(PLAYERS):
                slot = idx % 5
                spawn = T_SPAWN if tn == 2 else CT_SPAWN
                spawn = (spawn[0] + slot * 60.0, spawn[1] + slot * 45.0)
                target = (MID[0] + slot * 120.0 - 240.0, MID[1] + (slot - 2) * 150.0)
                f = (tick - r["freeze_end_tick"]) / (20 * TICK_RATE)
                x, y = _lerp(spawn, target, f)
                alive = sid not in dead_at or tick < dead_at[sid]
                yaw = math.degrees(math.atan2(target[1] - spawn[1], target[0] - spawn[0]))
                positions[sid].append({
                    "t": tick, "x": round(x, 1), "y": round(y, 1), "yaw": round(yaw, 1),
                    "alive": alive, "hp": 100 if alive else 0,
                    "w": "ak47" if tn == 2 else "m4a1",
                    "ar": 100, "hl": True, "tn": tn,
                    "inv": ["knife", "glock" if tn == 2 else "usp_silencer",
                            "ak47" if tn == 2 else "m4a1", "smokegrenade", "flashbang"],
                    "eq": 4700 + slot * 100, "cs": 3900 if tick < r["freeze_end_tick"] + 64 else 0,
                    "dmg": damage[sid], "ast": 0, "ktot": kills[sid], "dtot": died[sid],
                })

    grenades = []
    for r in rounds:
        fe = r["freeze_end_tick"]
        thrower = t_ids[r["num"] % 5]
        pts = [[fe + 3 * TICK_RATE + i * DECIMATION, 1135 - i * 140.0, 650 - i * 85.0]
               for i in range(17)]
        grenades.append({"type": "smokegrenade", "thrower": thrower, "points": pts,
                         "detonate_tick": pts[-1][0]})

    return {
        "cache_version": TIMELINE_CACHE_VERSION,
        "map_name": MAP_NAME,
        "tick_rate": TICK_RATE,
        "decimation": DECIMATION,
        "tick_max": rounds[-1]["end_tick"],
        "players": [{"steamid": sid, "name": name, "team_num": tn} for sid, name, tn in PLAYERS],
        "positions": positions,
        "grenades": grenades,
        "events": events,
        "rounds": rounds,
    }


def seed_timeline(data_dir: Path) -> dict:
    (data_dir / "demos" / DEMO_NAME).write_bytes(b"")
    bundle = build_timeline()
    (data_dir / "data" / "timelines" / f"{DEMO_NAME}.json").write_text(
        json.dumps(bundle), encoding="utf-8")
    return bundle


def seed_player_stats(bundle: dict) -> int:
    from backend.analysis.player_stats import PlayerStatsStore

    return PlayerStatsStore().ingest_timeline(bundle, DEMO_NAME)


def seed_photo_markers(data_dir: Path) -> int:
    """Mark every seeded player as "no reusable photo" so avatar requests
    answer 404 from the cache instead of queueing a Liquipedia lookup."""
    from backend.api import photos

    cache = data_dir / photos._PHOTO_CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)
    marker = json.dumps({"reasons": ["e2e seed"]})
    names = {p[1] for p in PLAYERS} | {row[-1] for row in LINEUPS}
    for name in names:
        (cache / f"{photos._photo_key(None, name)}.404").write_text(marker, encoding="utf-8")
    return len(names)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    data_dir = Path(argv[1]).resolve()
    if data_dir == REPO_ROOT or REPO_ROOT.is_relative_to(data_dir):
        print(f"refusing to wipe {data_dir}", file=sys.stderr)
        return 2
    _reset_dir(data_dir)
    _configure(data_dir)

    n_lineups = seed_lineups()
    bundle = seed_timeline(data_dir)
    n_stats = seed_player_stats(bundle)
    n_photos = seed_photo_markers(data_dir)
    print(f"e2e seed: {data_dir} | {n_lineups} lineups, demo {DEMO_NAME} "
          f"({len(bundle['rounds'])} rounds, {len(bundle['players'])} players), "
          f"{n_stats} player_stats rows, {n_photos} photo markers")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
