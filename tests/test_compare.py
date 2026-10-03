"""Your-throw-vs-pro-lineup comparison: geometry, matching and the endpoint."""
import math

import pytest

from backend.analysis.compare import (
    angle_delta,
    build_summary,
    classify_quality,
    compare_throw,
    decompose_offset,
    find_best_lineup,
    normalize_pitch,
    normalize_yaw,
)


# ---------------------------------------------------------------------------
# Angle conventions: yaw CCW from +x, pitch positive = looking down
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [(0, 0), (180, 180), (-180, 180), (270, -90), (-270, 90), (725, 5), (-190, 170)],
)
def test_normalize_yaw(raw, expected):
    assert normalize_yaw(raw) == pytest.approx(expected)


@pytest.mark.parametrize("raw,expected", [(10, 10), (-30, -30), (350, -10), (275, -85)])
def test_normalize_pitch(raw, expected):
    assert normalize_pitch(raw) == pytest.approx(expected)


def test_angle_delta_wraps_across_180():
    # 179° → −179° is a 2° CCW turn, not 358° the other way.
    assert angle_delta(-179, 179) == pytest.approx(2)
    assert angle_delta(179, -179) == pytest.approx(-2)


@pytest.mark.parametrize(
    "yaw,dx,dy,fwd,right",
    [
        # Facing +x (east): +x is forward, −y (south) is the player's right.
        (0, 10, 0, 10, 0),
        (0, 0, -10, 0, 10),
        (0, 0, 10, 0, -10),
        # Facing +y (north): +y forward, +x (east) is the right.
        (90, 0, 10, 10, 0),
        (90, 10, 0, 0, 10),
        # Facing −x (west): −x forward, +y (north) is the right.
        (180, -10, 0, 10, 0),
        (180, 0, 10, 0, 10),
        # Facing −y (south): −x (west) is the right.
        (-90, -10, 0, 0, 10),
    ],
)
def test_decompose_offset_axes(yaw, dx, dy, fwd, right):
    f, r, v = decompose_offset(dx, dy, 7, yaw)
    assert f == pytest.approx(fwd, abs=1e-9)
    assert r == pytest.approx(right, abs=1e-9)
    assert v == 7


def test_decompose_offset_diagonal_preserves_length():
    f, r, _ = decompose_offset(3, 4, 0, 37)
    assert math.hypot(f, r) == pytest.approx(5)
    # Facing 45°, an offset along +x is half forward, half to the right.
    f, r, _ = decompose_offset(10, 0, 0, 45)
    assert f == pytest.approx(10 / math.sqrt(2))
    assert r == pytest.approx(10 / math.sqrt(2))


# ---------------------------------------------------------------------------
# Matching + deltas
# ---------------------------------------------------------------------------

PRO = {
    "id": 7, "label": "Mirage Window Smoke", "grenade_type": "smokegrenade",
    "side": "T", "throw_count": 12, "round_win_rate": 0.6,
    "throw_cx": 0.0, "throw_cy": 0.0, "throw_cz": 0.0,
    "land_cx": 1000.0, "land_cy": 0.0, "land_cz": 0.0,
    "avg_pitch": -10.0, "avg_yaw": 0.0, "primary_technique": "jump",
}


def _throw(**kw):
    base = {
        "grenade_type": "smokegrenade",
        "throw_x": 0.0, "throw_y": 0.0, "throw_z": 0.0,
        "land_x": 1000.0, "land_y": 0.0, "land_z": 0.0,
        "pitch": -10.0, "yaw": 0.0,
    }
    base.update(kw)
    return base


def test_find_best_lineup_prefers_closest_landing_and_throw():
    far_throw = {**PRO, "id": 8, "throw_cx": 600.0}  # same landing, other spot
    other_type = {**PRO, "id": 9, "grenade_type": "flashbang"}
    too_far = {**PRO, "id": 10, "land_cx": 1200.0}
    best = find_best_lineup(_throw(throw_x=20.0), [far_throw, other_type, too_far, PRO])
    assert best is not None
    assert best[0]["id"] == 7
    assert best[1] == pytest.approx(0)
    assert best[2] == pytest.approx(20)


def test_find_best_lineup_none_outside_radius_or_without_landing():
    assert find_best_lineup(_throw(land_x=1300.0), [PRO]) is None
    assert find_best_lineup(_throw(land_x=None), [PRO]) is None
    assert find_best_lineup(_throw(land_x=float("nan")), [PRO]) is None


def test_compare_throw_deltas_and_summary():
    # Pro faces +x. We stand 12u to the pro's left (+y), look 3° higher
    # (pitch −13 vs −10) and land 40u short of the pro's landing point.
    t = _throw(throw_y=12.0, pitch=-13.0, land_x=960.0)
    lu, land_d, throw_d = find_best_lineup(t, [PRO])
    m = compare_throw(t, lu, land_d, throw_d)
    assert m["offset_right"] == pytest.approx(-12)
    assert m["offset_forward"] == pytest.approx(0)
    assert m["pitch_delta"] == pytest.approx(-3)
    assert m["yaw_delta"] == pytest.approx(0)
    assert m["land_along"] == pytest.approx(-40)
    assert m["land_distance"] == pytest.approx(40)
    assert m["summary"] == "12u left, 3° too high, landed 40u short"
    assert m["quality"] == "close"
    assert m["label"] == "Mirage Window Smoke"


def test_compare_throw_yaw_left_and_pitch_low():
    t = _throw(yaw=4.0, pitch=-8.0, land_x=1050.0)
    lu, land_d, throw_d = find_best_lineup(t, [PRO])
    m = compare_throw(t, lu, land_d, throw_d)
    assert m["yaw_delta"] == pytest.approx(4)
    assert m["pitch_delta"] == pytest.approx(2)
    assert "4° too far left" in m["summary"]
    assert "2° too low" in m["summary"]
    assert "landed 50u long" in m["summary"]


def test_perfect_throw_is_on_point():
    t = _throw()
    lu, land_d, throw_d = find_best_lineup(t, [PRO])
    m = compare_throw(t, lu, land_d, throw_d)
    assert m["quality"] == "on-point"
    assert m["summary"].startswith("Spot on")


def test_quality_thresholds():
    assert classify_quality(10, 20, 1, 1) == "on-point"
    assert classify_quality(80, 70, 3, 1) == "close"
    assert classify_quality(300, 140, 1, 1) == "off"
    assert classify_quality(10, 10, 15, 0) == "off"


def test_build_summary_ignores_noise():
    assert build_summary(1, -2, 3, 0.1, -0.2, 3, 3).startswith("Spot on")


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

def test_compare_rejects_bad_names(client):
    assert client.get("/api/compare/..%2F..%2F.env").status_code in (400, 404)
    assert client.get("/api/compare/notademo.txt").status_code == 400
    assert client.get("/api/compare/missing_mirage.dem").status_code == 404


@pytest.fixture()
def fake_demo(client, tmp_root, monkeypatch):
    """A demo whose parse is stubbed, on a map with one pro lineup."""
    import backend.api.compare as cmp
    from backend.db import connect

    demo = tmp_root / "demos" / "unit_testmap.dem"
    demo.write_bytes(b"not really a demo")
    calls = {"n": 0}

    def fake_parse(path):
        calls["n"] += 1
        return {
            "map_name": "de_testmap",
            "throws": [
                {**_throw(throw_y=12.0, pitch=-13.0, land_x=960.0),
                 "tick": 500, "round_number": 2, "team_num": 2,
                 "thrower_steamid": "111", "thrower_name": "me"},
                {**_throw(land_x=5000.0), "tick": 900, "round_number": 3, "team_num": 2,
                 "thrower_steamid": "111", "thrower_name": "me"},
                {**_throw(), "tick": 700, "round_number": 2, "team_num": 3,
                 "thrower_steamid": "222", "thrower_name": "you"},
            ],
        }

    monkeypatch.setattr(cmp, "_parse_throws", fake_parse)
    with connect() as conn:
        conn.execute(
            "INSERT INTO lineup_clusters (cluster_id, map_name, grenade_type, label, side, "
            "throw_count, round_win_rate, land_cx, land_cy, land_cz, throw_cx, throw_cy, "
            "throw_cz, avg_pitch, avg_yaw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (1, "de_testmap", "smokegrenade", "Test Window Smoke", "T", 12, 0.6,
             1000.0, 0.0, 0.0, 0.0, 0.0, 0.0, -10.0, 0.0),
        )
    yield calls
    with connect() as conn:
        conn.execute("DELETE FROM lineup_clusters WHERE map_name = ?", ("de_testmap",))
    cache = cmp._cache_path(demo.name)
    if cache.exists():
        cache.unlink()
    demo.unlink()


def test_compare_endpoint_matches_and_caches(client, fake_demo):
    r = client.get("/api/compare/unit_testmap.dem", params={"steamid": "111"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["map_name"] == "de_testmap"
    assert body["has_lineup_data"] is True
    assert body["player_name"] == "me"
    assert {p["steamid"] for p in body["players"]} == {"111", "222"}
    assert [t["tick"] for t in body["throws"]] == [500, 900]
    first, second = body["throws"]
    assert first["side"] == "T"
    assert first["matched"]["label"] == "Test Window Smoke"
    assert first["matched"]["summary"] == "12u left, 3° too high, landed 40u short"
    assert second["matched"] is None
    assert second["no_match_reason"]
    assert body["matched_count"] == 1

    # Second call is served from the JSON cache — no re-parse.
    assert client.get("/api/compare/unit_testmap.dem", params={"steamid": "222"}).status_code == 200
    assert fake_demo["n"] == 1


def test_compare_endpoint_without_lineup_data(client, tmp_root, monkeypatch):
    import backend.api.compare as cmp

    demo = tmp_root / "demos" / "unit_nodata.dem"
    demo.write_bytes(b"x")
    monkeypatch.setattr(cmp, "_parse_throws", lambda p: {
        "map_name": "de_nolineups",
        "throws": [{**_throw(), "tick": 1, "round_number": 1, "team_num": 3,
                    "thrower_steamid": "111", "thrower_name": "me"}],
    })
    try:
        body = client.get("/api/compare/unit_nodata.dem", params={"steamid": "111"}).json()
        assert body["has_lineup_data"] is False
        assert "de_nolineups" in body["message"]
        assert body["throws"][0]["matched"] is None
    finally:
        cache = cmp._cache_path(demo.name)
        if cache.exists():
            cache.unlink()
        demo.unlink()
