import json

import pytest


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_maps_empty_db(client):
    assert client.get("/api/maps").json() == {"maps": []}


def test_known_map_without_data_is_empty(client):
    r = client.get("/api/lineups/de_dust2/smokegrenade")
    assert r.status_code == 200
    assert r.json()["lineups"] == []


@pytest.mark.parametrize(
    "path",
    [
        "/api/lineups/de_banana",
        "/api/lineups/de_banana/smokegrenade",
        "/api/lineups/de_mirage/banana",
        "/api/callouts/de_banana",
        "/api/executes/de_banana",
    ],
)
def test_unknown_map_or_grenade_404(client, path):
    assert client.get(path).status_code == 404


@pytest.mark.parametrize("name", ["..%2F..%2F.env", "notademo.txt", "a%5Cb.dem"])
def test_demo_name_validation(client, name):
    assert client.get(f"/api/match-replay/{name}/timeline").status_code in (400, 404)
    assert client.get(f"/api/match-info/{name}").status_code in (400, 404)


def test_admin_guard(client, monkeypatch):
    from backend.config import settings

    monkeypatch.setattr(settings, "admin_token", "s3cret")
    assert client.delete("/api/match-replay/x.dem").status_code == 401
    assert client.delete("/api/data").status_code == 401
    wrong = {"X-Admin-Token": "nope"}
    assert client.delete("/api/match-replay/x.dem", headers=wrong).status_code == 401
    ok = {"X-Admin-Token": "s3cret"}
    assert client.delete("/api/match-replay/x.dem", headers=ok).status_code == 404
    # Reads stay open
    assert client.get("/api/maps").status_code == 200


def test_admin_guard_off_by_default(client):
    assert client.delete("/api/match-replay/x.dem").status_code == 404


def _write_cached_demo(tmp_root, name: str, winners: list[str]) -> None:
    from backend.ingestion.demo_parser import TIMELINE_CACHE_VERSION

    (tmp_root / "demos" / name).write_bytes(b"")
    rounds, samples = [], []
    for i, w in enumerate(winners, start=1):
        start = i * 1000
        rounds.append({"num": i, "start_tick": start, "freeze_end_tick": start + 100,
                       "end_tick": start + 900, "winner": w})
        samples.append({"t": start, "x": 0, "y": 0, "yaw": 0, "alive": True,
                        "hp": 100, "tn": 2 if i <= 12 else 3})
    bundle = {
        "cache_version": TIMELINE_CACHE_VERSION, "map_name": "de_mirage",
        "tick_rate": 64, "decimation": 8, "tick_max": len(winners) * 1000 + 900,
        "players": [{"steamid": "1", "name": "ref", "team_num": 2}],
        "positions": {"1": samples}, "grenades": [], "events": [], "rounds": rounds,
    }
    cache_dir = tmp_root / "data" / "timelines"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{name}.json").write_text(json.dumps(bundle))


def test_timeline_meta_flags_partial_demo(client, tmp_root):
    name = "999_mirage.dem"
    _write_cached_demo(tmp_root, name, ["T"] * 7 + ["CT"] * 5)

    r = client.get(f"/api/match-replay/{name}/timeline", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"
    assert len(r.json()["rounds"]) == 12

    meta = client.get(f"/api/match-replay/{name}/meta").json()
    assert meta == {"demo_file": name, "timeline_cached": True,
                    "complete": False, "score": [7, 5], "rounds": 12,
                    "player_steamids": ["1"]}

    listed = {d["demo_file"]: d for d in client.get("/api/match-replay/demos").json()}
    assert listed[name]["complete"] is False


def test_meta_missing_demo_404(client):
    assert client.get("/api/match-replay/nope.dem/meta").status_code == 404


def test_hltv_rating_scale():
    from backend.api.players import _hltv_rating

    # Exactly-average pro line over 1000 rounds: 679 kills (0.679 KPR),
    # 317 rounds survived, and 81 one-kill + 299 two-kill rounds, which gives
    # (81 + 4*299) / 1000 = 1.277 RMK. Every component is 1.0 → rating 1.0.
    avg = {"rounds_played": 1000, "kills": 679, "deaths": 683,
           "multi_2k": 299, "multi_3k": 0, "multi_4k": 0, "multi_5k": 0}
    assert _hltv_rating(avg) == pytest.approx(1.0)
    star = dict(avg, kills=900, deaths=550, multi_2k=250, multi_3k=40)
    assert _hltv_rating(star) > 1.2
    assert _hltv_rating({"rounds_played": 0}) == 0.0


@pytest.mark.parametrize(
    "uploaded,expected",
    [
        ("faze_vs_navi.dem", "faze-vs-navi_mirage.dem"),
        ("2393224_mirage.dem", "2393224_mirage.dem"),   # already canonical
        ("scrim.dem", "scrim_mirage.dem"),
    ],
)
def test_upload_named_by_header_map(tmp_root, monkeypatch, uploaded, expected):
    import backend.ingestion.hltv_scraper as hs
    from backend.main import _name_upload_by_map

    monkeypatch.setattr(hs, "_probe_dem_map", lambda p: "de_mirage")
    d = tmp_root / "uploads"
    d.mkdir(exist_ok=True)
    src = d / uploaded
    src.write_bytes(b"demo")
    out = _name_upload_by_map(src)
    assert out.name == expected
    assert out.read_bytes() == b"demo"
    out.unlink()


def test_upload_unreadable_header_keeps_name(tmp_root, monkeypatch):
    import backend.ingestion.hltv_scraper as hs
    from backend.main import _name_upload_by_map

    monkeypatch.setattr(hs, "_probe_dem_map", lambda p: None)
    src = tmp_root / "demos" / "weird_name.dem"
    src.write_bytes(b"x")
    assert _name_upload_by_map(src) == src
    src.unlink()
