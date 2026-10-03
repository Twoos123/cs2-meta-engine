"""CS2 Game State Integration: parsing, normalisation, auth, cfg and install."""
import json
import time
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _fixture(name: str, token: str = "") -> dict:
    data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    if token:
        data["auth"]["token"] = token
    return data


@pytest.fixture()
def gsi(client):
    import backend.api.gsi as m

    m.store.reset()
    yield m
    m.store.reset()


# ── pure parsing ────────────────────────────────────────────────────────


def test_parse_vec_and_yaw():
    from backend.api.gsi import parse_vec, yaw_from_forward

    assert parse_vec("-310.00, -2080.50, -168.03") == (-310.0, -2080.5, -168.03)
    assert parse_vec([1, "2", 3.5]) == (1.0, 2.0, 3.5)
    assert parse_vec({"x": 1, "y": 2, "z": 3}) == (1.0, 2.0, 3.0)
    assert parse_vec("nan, 1, 2") is None
    assert parse_vec("garbage") is None
    assert parse_vec(None) is None

    assert yaw_from_forward("1.00, 0.00, 0.00") == 0.0
    assert yaw_from_forward("0.00, 1.00, 0.00") == 90.0
    assert yaw_from_forward("-1.00, 0.00, 0.00") == 180.0
    assert yaw_from_forward("0.00, -1.00, 0.00") == -90.0
    assert yaw_from_forward("0.00, 0.00, 1.00") is None


def test_normalise_spectator_fixture():
    from backend.api.gsi import normalise

    st = normalise(_fixture("gsi_spectator.json"))
    assert st.mode == "spectator"
    assert st.map == "de_mirage"
    assert st.round == 14  # map.round counts completed rounds
    assert st.phase == "live" and st.phase_ends_in == pytest.approx(71.4)
    assert (st.ct.score, st.ct.name, st.t.score, st.t.name) == (7, "FaZe", 6, "NAVI")
    assert st.round_wins["2"] == "t_win_bomb"

    assert len(st.players) == 10
    assert [p.team for p in st.players] == ["CT"] * 5 + ["T"] * 5
    by_name = {p.name: p for p in st.players}

    s1 = by_name["s1mple"]
    assert (s1.x, s1.y, s1.z) == (540.0, -170.0, -260.0)
    assert isinstance(s1.x, float)
    assert s1.yaw == pytest.approx(177.1, abs=0.1)
    assert s1.observed and st.observed_steamid == s1.steamid
    assert s1.active_weapon == "ak47" and s1.weapon_type == "Rifle"
    assert s1.primary == "ak47" and s1.secondary == "glock"
    assert s1.has_bomb and "molotov" in s1.utility
    assert (s1.kills, s1.deaths, s1.money, s1.hp, s1.helmet) == (18, 8, 2650, 100, True)
    assert sum(p.observed for p in st.players) == 1

    dead = by_name["karrigan"]
    assert not dead.alive and dead.hp == 0 and dead.active_weapon is None
    assert by_name["ropz"].defuser and not by_name["rain"].defuser
    assert by_name["rain"].active_weapon == "awp"

    assert st.bomb is not None
    assert st.bomb.state == "carried" and st.bomb.carrier == s1.steamid
    assert (st.bomb.x, st.bomb.y) == (540.0, -170.0)

    nades = {g.type: g for g in st.grenades}
    assert set(nades) == {"smoke", "inferno", "flashbang"}
    assert nades["smoke"].effecttime == pytest.approx(7.2) and nades["smoke"].x == -760.0
    assert len(nades["inferno"].flames) == 3 and nades["inferno"].x is None
    assert nades["flashbang"].owner == "76561198000000007"


def test_normalise_playing_fixture():
    from backend.api.gsi import normalise

    st = normalise(_fixture("gsi_playing.json"))
    assert st.mode == "playing"
    assert st.round == 5 and st.round_phase == "freezetime" and st.phase == "freezetime"
    assert len(st.players) == 1
    me = st.players[0]
    assert me.is_self and me.observed and me.team == "CT"
    assert (me.x, me.y) == (-1660.0, -1980.0) and me.yaw == 90.0
    assert me.active_weapon == "m4a1_silencer" and me.ammo_clip == 20
    assert me.utility == ["smokegrenade", "flashbang", "flashbang"]
    assert st.bomb is None and st.grenades == []


def test_normalise_menu_and_junk():
    from backend.api.gsi import normalise

    assert normalise({"provider": {"name": "CS2", "appid": 730}}).mode == "menu"
    st = normalise({"map": "nope", "allplayers": {"1": "x", "2": {"position": "bad"}}})
    assert st.mode == "spectator" and len(st.players) == 1 and st.players[0].x is None


# ── endpoints ───────────────────────────────────────────────────────────


def test_token_is_persisted_and_required(client, gsi):
    tok = gsi.get_token()
    assert len(tok) >= 20
    gsi._token_cache = None
    assert gsi.get_token() == tok  # read back from gsi_settings

    payload = _fixture("gsi_spectator.json", "wrong")
    assert client.post("/api/gsi", json=payload).status_code == 401
    del payload["auth"]
    assert client.post("/api/gsi", json=payload).status_code == 401
    assert client.post("/api/gsi", content=b"{nope").status_code == 400
    assert client.get("/api/gsi/state").json()["mode"] == "none"


def test_post_then_state_status_history(client, gsi):
    tok = gsi.get_token()
    r = client.post("/api/gsi", json=_fixture("gsi_spectator.json", tok))
    assert r.status_code == 200 and r.json()["ok"] is True

    st = client.get("/api/gsi/state").json()
    assert st["mode"] == "spectator" and st["map"] == "de_mirage"
    assert 0 <= st["age_seconds"] < 5
    assert len(st["players"]) == 10
    assert all(isinstance(p["x"], float) for p in st["players"])
    assert "previously" not in st and "auth" not in json.dumps(st)

    client.post("/api/gsi", json=_fixture("gsi_playing.json", tok))
    st = client.get("/api/gsi/state").json()
    assert st["mode"] == "playing" and st["seq"] == 2

    hist = client.get("/api/gsi/history", params={"limit": 5}).json()
    assert [s["mode"] for s in hist["states"]] == ["spectator", "playing"]

    status = client.get("/api/gsi/status").json()
    assert status["connected"] is True
    assert status["payloads_received"] == 2
    assert status["provider"]["appid"] == 730


def test_stream_sends_current_state(client, gsi, monkeypatch):
    monkeypatch.setattr(gsi, "SSE_MAX_LIFETIME_S", 0.3)
    client.post("/api/gsi", json=_fixture("gsi_spectator.json", gsi.get_token()))
    with client.stream("GET", "/api/gsi/stream") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    data_line = next(line for line in body.splitlines() if line.startswith("data: "))
    assert json.loads(data_line[6:])["map"] == "de_mirage"


def test_stream_ends_promptly_on_shutdown(client, gsi):
    """An open SSE stream must not block a uvicorn --reload."""
    gsi._shutdown_event.set()
    try:
        t0 = time.monotonic()
        with client.stream("GET", "/api/gsi/stream") as r:
            "".join(r.iter_text())
        assert time.monotonic() - t0 < 2
    finally:
        gsi._shutdown_event.clear()


def test_detects_uvicorn_should_exit(gsi, monkeypatch):
    class FakeServer:
        should_exit = False

        def handle_exit(self, sig, frame):
            pass

    srv = FakeServer()
    monkeypatch.setattr(gsi.signal, "getsignal", lambda sig: srv.handle_exit)
    assert gsi._stopping() is False
    srv.should_exit = True
    assert gsi._stopping() is True


def test_config_text(client, gsi):
    r = client.get("/api/gsi/config")
    assert r.status_code == 200
    text = r.text
    assert '"uri"          "http://127.0.0.1:8000/api/gsi"' in text
    assert f'"token"    "{gsi.get_token()}"' in text
    for comp in ("allplayers_position", "allplayers_weapons", "bomb", "grenades", "phase_countdowns"):
        assert f'"{comp}"' in text
    assert text.count("{") == text.count("}")

    r = client.get("/api/gsi/config", params={"uri": "http://192.168.1.20:8000/api/gsi"})
    assert '"http://192.168.1.20:8000/api/gsi"' in r.text
    bad = client.get("/api/gsi/config", params={"uri": 'http://x" }\n"evil'})
    assert bad.status_code == 400


def test_install_writes_only_cfg(client, gsi, monkeypatch, tmp_path):
    import backend.main as main

    game = tmp_path / "game" / "csgo"
    (game / "cfg").mkdir(parents=True)
    monkeypatch.setattr(main, "_resolve_cs2_dir", lambda: str(game))

    assert client.get("/api/gsi/status").json()["cfg_installed"] is False
    r = client.post("/api/gsi/install", json={"uri": "http://10.0.0.5:8000/api/gsi"})
    assert r.status_code == 200, r.text
    out = r.json()
    path = Path(out["path"])
    assert path == game / "cfg" / "gamestate_integration_cs2metaengine.cfg"
    assert out["restart_required"] is True
    assert "http://10.0.0.5:8000/api/gsi" in path.read_text(encoding="utf-8")
    assert [p.name for p in (game / "cfg").iterdir()] == [path.name]

    status = client.get("/api/gsi/status").json()
    assert status["cfg_installed"] and status["cfg_token_matches"]
    assert status["cfg_uri"] == "http://10.0.0.5:8000/api/gsi"

    monkeypatch.setattr(main, "_resolve_cs2_dir", lambda: None)
    assert client.post("/api/gsi/install", json={}).status_code == 400
