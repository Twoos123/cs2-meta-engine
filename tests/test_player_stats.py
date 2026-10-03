"""ADR / KAST / trades / clutches aggregation, Rating 2.0, and the per-match endpoint."""
import json
import sqlite3

import pytest

from backend.analysis.player_stats import (
    TRADE_WINDOW_SECONDS,
    PlayerStatsStore,
    aggregate_timeline,
)

T_TEAM = ("a1", "a2", "a3")
CT_TEAM = ("b1", "b2")


def _death(tick, attacker, victim):
    return {"type": "death", "tick": tick, "data": {"attacker": attacker, "victim": victim}}


def _bundle(counters=True, deaths=None, winners=("CT", "T")):
    """Two rounds, 3 T vs 2 CT.

    Round 1 (ticks 0-2000, CT win):
      500  b1 kills a1
      600  a2 kills b1   → trade kill (a2), traded death (a1); b2 now 1v2
      1500 b2 kills a2   → a3 now 1v1
      1600 b2 kills a3
    Round 2 (ticks 3000-5000, T win): nobody dies.
    """
    rounds = [
        {"num": 1, "start_tick": 0, "freeze_end_tick": 100, "end_tick": 2000, "winner": winners[0]},
        {"num": 2, "start_tick": 3000, "freeze_end_tick": 3100, "end_tick": 5000, "winner": winners[1]},
    ]
    if deaths is None:
        deaths = [_death(500, "b1", "a1"), _death(600, "a2", "b1"),
                  _death(1500, "b2", "a2"), _death(1600, "b2", "a3")]
    # Cumulative counters sampled at round start / ~5s in / just before end.
    dmg = {"a2": (0, 0, 100, 100, 100, 150), "b2": (0, 0, 250, 250, 250, 250)}
    ast = {"a1": (0, 0, 1, 1, 1, 1)}
    positions = {}
    for sid in T_TEAM + CT_TEAM:
        tn = 2 if sid in T_TEAM else 3
        samples = []
        for i, t in enumerate((0, 320, 1992, 3000, 3320, 4992)):
            s = {"t": t, "x": 0, "y": 0, "yaw": 0, "alive": True, "hp": 100, "tn": tn}
            if counters:
                s["dmg"] = dmg.get(sid, (0,) * 6)[i]
                s["ast"] = ast.get(sid, (0,) * 6)[i]
            samples.append(s)
        positions[sid] = samples
    return {
        "map_name": "de_mirage", "tick_rate": 64,
        "players": [{"steamid": s, "name": s.upper(), "team_num": 2 if s in T_TEAM else 3}
                    for s in T_TEAM + CT_TEAM],
        "positions": positions, "grenades": [], "events": deaths, "rounds": rounds,
    }


def _by_sid(rows):
    out = {}
    for r in rows:
        assert r["steamid"] not in out, "one side per player in this fixture"
        out[r["steamid"]] = r
    return out


def test_trades_kast_adr_clutches():
    rows = _by_sid(aggregate_timeline(_bundle(), "x.dem"))

    # Trades
    assert rows["a2"]["trade_kills"] == 1
    assert rows["a1"]["traded_deaths"] == 1
    assert rows["b1"]["traded_deaths"] == 0      # a2 died 900 ticks later: too late
    assert sum(r["trade_kills"] for r in rows.values()) == 1

    # KAST over 2 rounds: everyone survives round 2.
    assert rows["a1"]["kast_rounds"] == 2        # traded (and assisted) in round 1
    assert rows["a2"]["kast_rounds"] == 2        # kill
    assert rows["a3"]["kast_rounds"] == 1        # died untraded, no K/A
    assert rows["b1"]["kast_rounds"] == 2        # kill
    assert rows["b2"]["kast_rounds"] == 2

    # Assists + damage from per-round counter diffs
    assert rows["a1"]["assists"] == 1 and rows["a1"]["has_assists"] == 1
    assert rows["a2"]["damage"] == 150 and rows["a2"]["has_adr"] == 1
    assert rows["b2"]["damage"] == 250

    # Clutches: b2 1v2 won (CT won round 1), a3 1v1 lost.
    assert rows["b2"]["clutch_att_2"] == 1 and rows["b2"]["clutch_won_2"] == 1
    assert rows["a3"]["clutch_att_1"] == 1 and rows["a3"]["clutch_won_1"] == 0
    total_att = sum(r[f"clutch_att_{n}"] for r in rows.values() for n in range(1, 6))
    assert total_att == 2


def test_trade_window_boundary():
    window = TRADE_WINDOW_SECONDS * 64
    for gap, expected in ((window, 1), (window + 1, 0)):
        deaths = [_death(500, "b1", "a1"), _death(500 + gap, "a2", "b1")]
        rows = _by_sid(aggregate_timeline(_bundle(deaths=deaths), "x.dem"))
        assert rows["a2"]["trade_kills"] == expected
        assert rows["a1"]["traded_deaths"] == expected


def test_one_clutch_per_team_per_round_and_lost_clutch():
    # CT loses round 1 this time: b2's 1v2 is a lost clutch.
    rows = _by_sid(aggregate_timeline(_bundle(winners=("T", "T")), "x.dem"))
    assert rows["b2"]["clutch_att_2"] == 1 and rows["b2"]["clutch_won_2"] == 0
    assert rows["a3"]["clutch_won_1"] == 1


def test_legacy_timeline_without_counters():
    rows = _by_sid(aggregate_timeline(_bundle(counters=False), "x.dem"))
    assert all(r["has_adr"] == 0 and r["damage"] == 0 for r in rows.values())
    assert all(r["has_assists"] == 0 for r in rows.values())
    assert all(r["has_kast"] == 1 for r in rows.values())
    # Without assist data a1 still gets KAST from the trade.
    assert rows["a1"]["kast_rounds"] == 2


def test_assister_event_fallback():
    deaths = [_death(500, "b1", "a1"), _death(600, "a2", "b1")]
    deaths[1]["data"]["assister"] = "a3"
    rows = _by_sid(aggregate_timeline(_bundle(counters=False, deaths=deaths), "x.dem"))
    assert rows["a3"]["assists"] == 1 and rows["a3"]["has_assists"] == 1


def test_rating_2_scale_and_fallback():
    from backend.api.players import _hltv_rating_2, _to_summary

    # Average pro line → ~1.0
    avg = _hltv_rating_2(kpr=0.68, dpr=0.66, apr=0.13, kast_pct=72.0, adr=76.0)
    assert avg == pytest.approx(1.0, abs=0.1)
    star = _hltv_rating_2(kpr=0.85, dpr=0.58, apr=0.12, kast_pct=78.0, adr=90.0)
    assert star > 1.25

    base = {"steamid": "1", "name": "p", "matches": 1, "rounds_played": 100,
            "kills": 68, "deaths": 66, "multi_2k": 15}
    legacy = _to_summary(base)
    assert legacy["rating_version"] == "1.0"
    assert legacy["rating"] == legacy["rating_1"]
    assert legacy["adr"] is None and legacy["kast_pct"] is None

    full = _to_summary(dict(base, damage=7600, adr_rounds=100, kast_rounds=72,
                            kast_total_rounds=100, assists=13, assist_rounds=100,
                            kast_kills=68, kast_deaths=66, trade_kills=10,
                            traded_deaths=11, clutch_att_1=3, clutch_won_1=2))
    assert full["rating_version"] == "2.0"
    assert full["adr"] == 76.0 and full["kast_pct"] == 0.72 and full["apr"] == 0.13
    assert full["trade_kill_pct"] == pytest.approx(10 / 68, abs=1e-3)
    assert full["clutches_attempted"] == 3 and full["clutches_won"] == 2
    assert full["clutches"][0] == {"x": 1, "attempted": 3, "won": 2}
    assert full["rating"] == pytest.approx(1.0, abs=0.1)


def test_store_migrates_legacy_table(tmp_path):
    from backend.analysis.player_stats import _SQLITE_SCHEMA, _V2_COLUMNS

    db = tmp_path / "legacy.db"
    with sqlite3.connect(db) as conn:
        conn.executescript(_SQLITE_SCHEMA)       # original table, no v2 columns
        cols = {d[0] for d in conn.execute("SELECT * FROM player_stats LIMIT 0").description}
        assert not cols & set(_V2_COLUMNS)
        conn.execute(
            "INSERT INTO player_stats (steamid, name, demo_file, map_name, side, rounds_played)"
            " VALUES ('a1', 'A1', 'x.dem', 'de_mirage', 'T', 2)"
        )
    store = PlayerStatsStore(db_path=db)   # CREATE IF NOT EXISTS + ALTERs
    legacy = store.get_match("x.dem")
    assert legacy[0]["legacy"] == 1

    store.ingest_timeline(_bundle(), "x.dem")
    rows = {r["steamid"]: r for r in store.get_match("x.dem")}
    assert rows["a1"]["legacy"] == 0
    assert rows["a2"]["damage"] == 150 and rows["a2"]["adr_rounds"] == 2
    assert rows["b2"]["clutch_won_2"] == 1


def test_match_endpoint(client, tmp_root):
    name = "777_mirage.dem"
    (tmp_root / "demos" / name).write_bytes(b"")
    cache_dir = tmp_root / "data" / "timelines"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{name}.json").write_text(json.dumps(_bundle()))

    r = client.get(f"/api/players/match/{name}")
    assert r.status_code == 200
    body = r.json()
    assert body["demo_file"] == name and body["has_adr"] is True
    players = {p["steamid"]: p for p in body["players"]}
    assert players["a2"]["adr"] == 75.0
    assert players["a2"]["trade_kills"] == 1
    assert players["b2"]["clutches_won"] == 1
    assert players["a3"]["kast_pct"] == 0.5
    assert all(p["rating_version"] == "2.0" for p in players.values())

    # The cross-demo list picks up the same rows.
    listed = {p["steamid"]: p for p in client.get("/api/players").json()}
    assert listed["a2"]["adr"] == 75.0

    detail = client.get("/api/players/b2").json()
    assert detail["summary"]["clutches"][1] == {"x": 2, "attempted": 1, "won": 1}
    assert detail["per_map"][0]["adr"] == 125.0


@pytest.mark.parametrize("name", ["notademo.txt", "..%2F..%2Fsecret.dem", "a%5Cb.dem"])
def test_match_endpoint_rejects_bad_names(client, name):
    assert client.get(f"/api/players/match/{name}").status_code in (400, 404)


def test_match_endpoint_unknown_demo(client):
    assert client.get("/api/players/match/missing.dem").status_code == 404
