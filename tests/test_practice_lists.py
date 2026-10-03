import re

import pytest

from backend.models.schemas import LineupCluster


def _cluster(cid: int, map_name: str = "de_mirage", **kw) -> LineupCluster:
    base = dict(
        cluster_id=cid,
        map_name=map_name,
        grenade_type="smokegrenade",
        land_centroid_x=0.0,
        land_centroid_y=0.0,
        land_centroid_z=0.0,
        throw_centroid_x=100.0 * cid,
        throw_centroid_y=-50.5 * cid,
        throw_centroid_z=-160.03125,
        avg_pitch=-12.25,
        avg_yaw=171.5 + cid,
        throw_count=4,
        round_win_rate=0.5,
        total_utility_damage=0.0,
        avg_utility_damage=0.0,
        label=f"Window smoke {cid}",
        primary_technique="jump",
        primary_click="left",
    )
    base.update(kw)
    return LineupCluster(**base)


@pytest.fixture
def clusters(client, monkeypatch):
    """Fake lineup_clusters lookup: ids 1-4 on mirage, 9 on dust2."""
    import backend.main as main

    table = {(i, "de_mirage"): _cluster(i) for i in range(1, 5)}
    table[(2, "de_mirage")] = _cluster(
        2, label='Evil "label"; quit // nope', grenade_type="flashbang"
    )
    table[(9, "de_dust2")] = _cluster(9, map_name="de_dust2")
    monkeypatch.setattr(
        main._pipeline, "get_cluster_by_id", lambda cid, m: table.get((cid, m))
    )
    return table


@pytest.fixture
def plist(client, clusters):
    r = client.post("/api/practice-lists", json={"name": "Mirage A exec!", "map_name": "de_mirage"})
    assert r.status_code == 200, r.text
    lid = r.json()["id"]
    yield r.json()
    client.delete(f"/api/practice-lists/{lid}")


def _add(client, lid, cid, map_name="de_mirage"):
    return client.post(
        f"/api/practice-lists/{lid}/items", json={"cluster_id": cid, "map_name": map_name}
    )


def test_crud_and_items(client, plist):
    lid = plist["id"]
    assert plist["slug"] == "mirage_a_exec"
    assert plist["exec_command"] == "exec practice_mirage_a_exec"

    for cid in (1, 2, 3):
        assert _add(client, lid, cid).status_code == 200
    data = client.get(f"/api/practice-lists/{lid}").json()
    assert [i["cluster_id"] for i in data["items"]] == [1, 2, 3]
    assert data["items"][0]["throw_x"] == 100.0

    # Duplicate, wrong map, unknown cluster
    assert _add(client, lid, 1).status_code == 409
    r = _add(client, lid, 9, "de_dust2")
    assert r.status_code == 400 and "de_mirage" in r.json()["detail"]
    assert _add(client, lid, 77).status_code == 404

    # Rename
    r = client.patch(f"/api/practice-lists/{lid}", json={"name": "  B  split "})
    assert r.json()["name"] == "B split" and r.json()["slug"] == "b_split"

    ids = [i["item_id"] for i in data["items"]]
    # Reorder
    r = client.put(f"/api/practice-lists/{lid}/order", json={"item_ids": [ids[2], ids[0], ids[1]]})
    assert [i["cluster_id"] for i in r.json()["items"]] == [3, 1, 2]
    bad = client.put(f"/api/practice-lists/{lid}/order", json={"item_ids": [ids[0], ids[0], ids[1]]})
    assert bad.status_code == 400

    # Note
    r = client.patch(f"/api/practice-lists/{lid}/items/{ids[0]}", json={"note": "jump-throw"})
    assert next(i for i in r.json()["items"] if i["item_id"] == ids[0])["note"] == "jump-throw"

    # Remove renumbers positions
    r = client.delete(f"/api/practice-lists/{lid}/items/{ids[0]}")
    items = r.json()["items"]
    assert [i["cluster_id"] for i in items] == [3, 2]
    assert [i["position"] for i in items] == [0, 1]

    # Listing by map
    assert any(x["id"] == lid for x in client.get("/api/practice-lists?map_name=de_mirage").json())
    assert all(x["id"] != lid for x in client.get("/api/practice-lists?map_name=de_dust2").json())


def test_survives_cluster_rebuild(client, plist, clusters):
    lid = plist["id"]
    _add(client, lid, 1)
    clusters.clear()  # clusters table rebuilt / emptied
    r = client.get(f"/api/practice-lists/{lid}/cfg")
    assert r.status_code == 200
    assert "setpos 100.0000 -50.5000 -160.0312" in r.text


def test_delete_list(client, clusters):
    lid = client.post("/api/practice-lists", json={"name": "tmp", "map_name": "de_mirage"}).json()["id"]
    _add(client, lid, 1)
    assert client.delete(f"/api/practice-lists/{lid}").status_code == 200
    assert client.get(f"/api/practice-lists/{lid}").status_code == 404


def test_validation(client):
    assert client.post("/api/practice-lists", json={"name": "   ", "map_name": "de_mirage"}).status_code == 400
    assert client.post("/api/practice-lists", json={"name": "x", "map_name": "../etc"}).status_code == 400


def test_cfg_alias_chain_and_commands(client, plist, clusters):
    from backend.rcon.bridge import generate_console_string

    lid = plist["id"]
    for cid in (1, 2, 3):
        _add(client, lid, cid)
    r = client.get(f"/api/practice-lists/{lid}/cfg")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert 'filename="practice_mirage_a_exec.cfg"' in r.headers["content-disposition"]
    text = r.text

    for setting in (
        "sv_cheats 1",
        "sv_infinite_ammo 1",
        "ammo_grenade_limit_total 5",
        "sv_grenade_trajectory_prac_pipreview 1",
        "mp_roundtime_defuse 60",
        "mp_freezetime 0",
        "mp_warmup_end",
        "bot_kick",
    ):
        lines = text.splitlines()
        idx = lines.index(setting)
        assert lines[idx - 1].startswith("//"), f"{setting} has no comment"

    aliases = dict(re.findall(r'^alias "(cs2me_\d+)" "([^"]*)"$', text, re.M))
    assert list(aliases) == ["cs2me_1", "cs2me_2", "cs2me_3"]
    chain = {
        name: (
            re.search(r"alias cs2me_next (cs2me_\d+)", body).group(1),
            re.search(r"alias cs2me_prev (cs2me_\d+)", body).group(1),
        )
        for name, body in aliases.items()
    }
    assert chain == {
        "cs2me_1": ("cs2me_2", "cs2me_3"),
        "cs2me_2": ("cs2me_3", "cs2me_1"),
        "cs2me_3": ("cs2me_1", "cs2me_2"),
    }

    # Same setpos/setang/give as Copy Console (minus the sv_cheats prefix)
    for i, cid in enumerate((1, 2, 3), start=1):
        console = generate_console_string(clusters[(cid, "de_mirage")])
        expected = console.replace("sv_cheats 1; ", "")
        assert aliases[f"cs2me_{i}"].startswith(expected + "; echo [")
    assert "give weapon_flashbang" in aliases["cs2me_2"]
    assert "echo [1/3] Window smoke 1 - Jump, left click" in aliases["cs2me_1"]

    lines = text.splitlines()
    assert 'bind "]" "cs2me_next"' in lines
    assert 'bind "[" "cs2me_prev"' in lines
    assert lines[-1] == "cs2me_1"
    assert all(len(line) <= 255 for line in lines)


def test_cfg_sanitises_labels(client, plist, clusters):
    lid = plist["id"]
    _add(client, lid, 2)
    text = client.get(f"/api/practice-lists/{lid}/cfg").text
    body = re.search(r'^alias "cs2me_1" "([^"]*)"$', text, re.M).group(1)
    echo = body.split("; echo ", 1)[1].split("; alias")[0]
    assert '"' not in echo and ";" not in echo and "//" not in echo
    assert echo.startswith("[1/1] Evil label quit / nope")
    # Single-item list wraps onto itself
    assert "alias cs2me_next cs2me_1; alias cs2me_prev cs2me_1" in body
    # Every alias line has exactly the two outer quote pairs
    for line in text.splitlines():
        if line.startswith("alias "):
            assert line.count('"') == 4


def test_sanitize_unit():
    from backend.api.practice_lists import sanitize_cfg_text

    assert sanitize_cfg_text('a"b;c//d\ne') == "a b c/d e"
    assert sanitize_cfg_text("Café — Top") == "Caf Top"
    assert len(sanitize_cfg_text("x" * 200)) == 48
    assert sanitize_cfg_text(None) == ""


def test_cfg_keys_and_empty(client, plist, clusters):
    lid = plist["id"]
    assert client.get(f"/api/practice-lists/{lid}/cfg").status_code == 400  # empty
    _add(client, lid, 1)
    r = client.get(f"/api/practice-lists/{lid}/cfg", params={"next_key": "f6", "prev_key": "f5"})
    assert 'bind "f6" "cs2me_next"' in r.text and 'bind "f5" "cs2me_prev"' in r.text
    for bad in ('"', ";", "a b", "x;quit", "\\"):
        assert client.get(f"/api/practice-lists/{lid}/cfg", params={"next_key": bad}).status_code == 400
    assert client.get(f"/api/practice-lists/{lid}/cfg", params={"next_key": "[", "prev_key": "["}).status_code == 400


def test_install(client, plist, clusters, monkeypatch, tmp_path):
    import backend.main as main

    lid = plist["id"]
    _add(client, lid, 1)

    monkeypatch.setattr(main, "_resolve_cs2_dir", lambda: None)
    r = client.post(f"/api/practice-lists/{lid}/install")
    assert r.status_code == 404 and "CS2" in r.json()["detail"]

    game = tmp_path / "game" / "csgo"
    game.mkdir(parents=True)
    monkeypatch.setattr(main, "_resolve_cs2_dir", lambda: str(game))
    assert client.post(f"/api/practice-lists/{lid}/install").status_code == 404  # no cfg/

    (game / "cfg").mkdir()
    r = client.post(f"/api/practice-lists/{lid}/install")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["command"] == "exec practice_mirage_a_exec"
    written = game / "cfg" / "practice_mirage_a_exec.cfg"
    assert body["path"] == str(written)
    assert [p.name for p in (game / "cfg").iterdir()] == [written.name]
    assert written.read_text(encoding="utf-8").rstrip().endswith("cs2me_1")


def test_writes_are_admin_guarded(client, monkeypatch):
    from backend.config import settings

    monkeypatch.setattr(settings, "admin_token", "s3cret")
    assert client.post("/api/practice-lists", json={"name": "x", "map_name": "de_mirage"}).status_code == 401
    assert client.delete("/api/practice-lists/1").status_code == 401
    assert client.post("/api/practice-lists/1/install").status_code == 401
    assert client.get("/api/practice-lists").status_code == 200
