"""Demo auto-import: importer naming/dedupe/archives, watcher scan, API endpoints."""
import bz2
import gzip
import io
import json
import os
import time
import zipfile
from pathlib import Path

import pytest

MAGIC = b"PBDEMS2\x00"


def _dem_bytes(size: int = 4096, fill: bytes = b"x") -> bytes:
    return MAGIC + fill * size


def _write(path: Path, data: bytes, age_s: float = 60) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    t = time.time() - age_s
    os.utime(path, (t, t))
    return path


@pytest.fixture()
def imp(tmp_root, monkeypatch):
    """Importer with a clean demo dir and tables; header probing disabled
    (fake demos have no real header, so the map comes from the filename)."""
    from backend.config import settings
    from backend.db import connect
    from backend.ingestion import importer

    importer.ensure_tables()
    with connect() as conn:
        conn.execute("DELETE FROM imports_sources")
        conn.execute("DELETE FROM imports_settings")
        conn.execute("DELETE FROM imports_hltv_pending")
    for p in settings.demo_dir.glob("*"):
        if p.is_file():
            p.unlink()
    monkeypatch.setattr(importer._hltv, "_probe_dem_map", lambda p: None)
    return importer


@pytest.fixture()
def src_dir(tmp_root):
    import shutil

    d = tmp_root / "src"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir()
    return d


def _demos():
    from backend.config import settings

    return sorted(p.name for p in settings.demo_dir.glob("*.dem"))


# ── naming helpers ─────────────────────────────────────────────────────────

def test_kind_and_prefix(imp):
    assert imp.kind_of("a.dem") == "dem"
    assert imp.kind_of("a.DEM.ZST") == "zst"
    assert imp.kind_of("a.dem.gz") == "gz"
    assert imp.kind_of("a.rar") == "rar"
    assert imp.kind_of("a.txt") is None
    assert imp.kind_of("a.rar.crdownload") is None
    assert imp.stem_of("faze_vs_navi.dem.bz2") == "faze_vs_navi"
    assert imp.make_prefix("faze_vs navi") == "faze-vs-navi"
    assert "_" not in imp.make_prefix("a_b_c")


# ── plain demos ────────────────────────────────────────────────────────────

def test_plain_dem_copied_and_deduped(imp, src_dir):
    src = _write(src_dir / "faze_vs_navi_mirage.dem", _dem_bytes())
    before = src.read_bytes()

    r = imp.import_file(src)
    assert r.status == "imported", r.error
    assert r.demos == ["faze-vs-navi_mirage.dem"]
    assert r.maps == ["mirage"]
    # the user's file is untouched
    assert src.exists() and src.read_bytes() == before

    again = imp.import_file(src)
    assert again.status == "duplicate"
    assert again.demos == ["faze-vs-navi_mirage.dem"]
    assert _demos() == ["faze-vs-navi_mirage.dem"]


def test_same_content_other_path_is_duplicate(imp, src_dir):
    data = _dem_bytes()
    imp.import_file(_write(src_dir / "one_nuke.dem", data))
    r = imp.import_file(_write(src_dir / "copy" / "two_nuke.dem", data))
    assert r.status == "duplicate"
    assert _demos() == ["one_nuke.dem"]


def test_header_map_wins(imp, src_dir, monkeypatch):
    monkeypatch.setattr(imp._hltv, "_probe_dem_map", lambda p: "de_ancient")
    src = _write(src_dir / "match730_0037_0909_408.dem", _dem_bytes())
    r = imp.import_file(src)
    assert r.demos == ["match730-0037-0909-408_ancient.dem"]


def test_not_a_demo_is_rejected(imp, src_dir):
    r = imp.import_file(_write(src_dir / "junk_mirage.dem", b"not a demo at all"))
    assert r.status == "error"
    assert "not a CS2 demo" in r.error
    # failures are remembered, and the watcher doesn't retry them
    assert imp.import_file(src_dir / "junk_mirage.dem").status == "skipped"


def test_unknown_map_is_rejected(imp, src_dir):
    r = imp.import_file(_write(src_dir / "something.dem", _dem_bytes()))
    assert r.status == "error"
    assert "map" in r.error


def test_existing_destination_same_size_is_not_rewritten(imp, src_dir):
    from backend.config import settings

    data = _dem_bytes(size=5000)
    _write(settings.demo_dir / "abc_dust2.dem", data)
    r = imp.import_file(_write(src_dir / "abc_dust2.dem", data))
    assert r.status == "duplicate"
    assert r.new_demos == []
    assert _demos() == ["abc_dust2.dem"]


def test_name_collision_gets_suffix(imp, src_dir):
    imp.import_file(_write(src_dir / "a" / "scrim_mirage.dem", _dem_bytes(100)))
    r = imp.import_file(_write(src_dir / "b" / "scrim_mirage.dem", _dem_bytes(200)))
    assert r.demos == ["scrim-2_mirage.dem"]


# ── compressed + archives ──────────────────────────────────────────────────

def test_compressed_single_demos(imp, src_dir):
    import zstandard

    data = _dem_bytes(3000)
    _write(src_dir / "f1_de_inferno.dem.gz", gzip.compress(data))
    _write(src_dir / "f2_de_nuke.dem.bz2", bz2.compress(data + b"1"))
    _write(src_dir / "f3_de_anubis.dem.zst", zstandard.ZstdCompressor().compress(data + b"22"))

    names = []
    for f in sorted(src_dir.iterdir()):
        r = imp.import_file(f)
        assert r.status == "imported", r.error
        names += r.demos
    assert sorted(names) == ["f1-de_inferno.dem", "f2-de_nuke.dem", "f3-de_anubis.dem"]
    from backend.config import settings
    assert (settings.demo_dir / "f1-de_inferno.dem").read_bytes() == data


def _zip(path: Path, members: dict) -> Path:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return _write(path, buf.getvalue())


def test_hltv_zip_with_parts_keeps_largest(imp, src_dir):
    arch = _zip(src_dir / "vitality-vs-mouz.zip", {
        "vitality-vs-mouz-m1-mirage.dem": _dem_bytes(1000),
        "vitality-vs-mouz-m2-nuke-p1.dem": _dem_bytes(500, b"a"),
        "vitality-vs-mouz-m2-nuke-p2.dem": _dem_bytes(2000, b"b"),
        "readme.txt": b"hi",
    })
    r = imp.import_file(arch, prefix="2380001", origin="hltv")
    assert r.status == "imported", r.error
    assert sorted(r.demos) == ["2380001_mirage.dem", "2380001_nuke.dem"]
    from backend.config import settings
    assert (settings.demo_dir / "2380001_nuke.dem").stat().st_size == len(_dem_bytes(2000))
    assert arch.exists()  # source archive is never deleted


def test_zip_without_match_id_uses_archive_stem(imp, src_dir):
    arch = _zip(src_dir / "my_scrims.zip", {
        "day1_mirage.dem": _dem_bytes(100, b"a"),
        "day2_mirage.dem": _dem_bytes(100, b"b"),
    })
    r = imp.import_file(arch)
    assert sorted(r.demos) == ["my-scrims-2_mirage.dem", "my-scrims_mirage.dem"]


def test_zip_without_demos(imp, src_dir):
    r = imp.import_file(_zip(src_dir / "empty.zip", {"a.txt": b"x"}))
    assert r.status == "error" and "No .dem" in r.error


# ── watcher scan ───────────────────────────────────────────────────────────

def test_scan_candidates_skips_partial_and_fresh(imp, src_dir):
    _write(src_dir / "ok_mirage.dem", _dem_bytes())
    _write(src_dir / "fresh_mirage.dem", _dem_bytes(), age_s=0)
    _write(src_dir / "busy.rar", b"x")
    _write(src_dir / "busy.rar.crdownload", b"x")
    _write(src_dir / "half.zip.part", b"x")
    _write(src_dir / "notes.txt", b"x")
    (src_dir / "sub").mkdir()
    _write(src_dir / "sub" / "deep_mirage.dem", _dem_bytes())
    got = [p.name for p in imp.scan_candidates([src_dir], settle_s=10)]
    assert got == ["ok_mirage.dem"]


# ── API ────────────────────────────────────────────────────────────────────

@pytest.fixture()
def api(client, imp, monkeypatch, src_dir):
    import backend.api.imports as m

    queued = []
    monkeypatch.setattr(m, "_enqueue_parse", lambda r: queued.append(r))
    downloads = src_dir / "Downloads"
    downloads.mkdir()
    monkeypatch.setattr(m, "_downloads_dir", lambda: downloads)
    m._seen.clear()
    return client, m, queued, downloads


def test_settings_roundtrip_and_validation(api, src_dir):
    client, _m, _q, _d = api
    s = client.get("/api/import/settings").json()
    assert s["watch_folders"] == ["@cs2-replays", "@inbox"]
    assert s["watch_downloads"] is False and s["enabled"] is True

    assert client.put("/api/import/settings", json={"my_steamid": "123"}).status_code == 400
    r = client.put("/api/import/settings", json={"my_steamid": "76561198000000001"})
    assert r.status_code == 200 and r.json()["my_steamid"] == "76561198000000001"

    missing = str(src_dir / "nope")
    assert client.put("/api/import/settings", json={"watch_folders": [missing]}).status_code == 400
    assert client.put("/api/import/settings", json={"watch_folders": ["relative/dir"]}).status_code == 400
    from backend.config import settings
    bad = client.put("/api/import/settings", json={"watch_folders": [str(settings.demo_dir.resolve())]})
    assert bad.status_code == 400

    r = client.put("/api/import/settings", json={"watch_folders": ["@inbox", str(src_dir)]})
    assert r.status_code == 200
    kinds = [f["kind"] for f in r.json()["folders"]]
    assert kinds == ["inbox", "custom"]

    status = client.get("/api/import/status").json()
    assert {"watcher_running", "folders", "recent", "last_scan_at"} <= set(status)


def test_scan_endpoint_imports_watched_files(api, src_dir):
    client, _m, queued, _d = api
    watch = src_dir / "watch"
    _write(watch / "pug_mirage.dem", _dem_bytes())
    client.put("/api/import/settings", json={"watch_folders": [str(watch)]})

    r = client.post("/api/import/scan").json()
    assert r["imported"] == 1
    assert r["results"][0]["demos"] == ["pug_mirage.dem"]
    assert queued and queued[0].new_demos == ["pug_mirage.dem"]

    # second scan: nothing new
    assert client.post("/api/import/scan").json()["handled"] == 0
    recent = client.get("/api/import/status").json()["recent"]
    assert recent[0]["status"] == "imported" and recent[0]["parse_state"] == "pending"


def test_upload_zip(api):
    client, _m, queued, _d = api
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("x-m1-ancient.dem", _dem_bytes(300))
    r = client.post(
        "/api/import/upload",
        files={"file": ("team_scrim.zip", buf.getvalue(), "application/zip")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["demos"] == ["team-scrim_ancient.dem"]
    from backend.config import settings
    # the inbox copy written by the upload is cleaned up
    assert not any(settings.import_inbox_dir.glob("*.zip"))

    bad = client.post("/api/import/upload", files={"file": ("x.exe", b"MZ", "application/octet-stream")})
    assert bad.status_code == 400


HLTV_HTML = """
<html><body>
<div class="team1-gradient"><a href="/team/9565/vitality">
  <img class="logo" src="https://img-cdn.hltv.org/teamlogo/vit.png"><div class="teamName">Vitality</div></a></div>
<div class="team2-gradient"><a href="/team/4494/mouz">
  <img class="logo" src="https://img-cdn.hltv.org/teamlogo/mouz.png"><div class="teamName">MOUZ</div></a></div>
<div class="timeAndEvent">
  <div class="date" data-unix="1750000000000">15th of June 2025</div>
  <div class="event text-ellipsis"><a href="/events/1/iem">IEM Cologne 2025</a></div>
</div>
<div class="mapholder"><div class="mapname">Mirage</div><div class="results">13 - 9</div></div>
<div class="mapholder"><div class="mapname">Nuke</div><div class="results">13 - 11</div></div>
<div class="mapholder"><div class="mapname">Inferno</div><div class="results">-</div></div>
<div class="streams"><a href="/download/demo/98765">GOTV Demo</a>
  <a href="https://evil.example.com/download/demo/1.rar">mirror</a></div>
<div class="lineups">
  <div class="players">
    <div class="flagAlign" data-player-id="7322"><div class="text-ellipsis">apEX</div></div>
    <div class="flagAlign" data-player-id="11893"><div class="text-ellipsis">ZywOo</div></div>
  </div>
  <div class="players">
    <div class="flagAlign" data-player-id="18053"><div class="text-ellipsis">torzsi</div></div>
    <div class="flagAlign" data-player-id="15165"><div class="text-ellipsis">xertioN</div></div>
  </div>
</div>
</body></html>
"""


def test_hltv_page_parses_and_writes_roster(api):
    client, _m, _q, _d = api
    from backend.config import settings

    url = "https://www.hltv.org/matches/2380002/vitality-vs-mouz-iem-cologne-2025"
    r = client.post("/api/import/hltv-page", json={"url": url, "html": HLTV_HTML})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["match_id"] == 2380002
    assert [t["name"] for t in body["teams"]] == ["Vitality", "MOUZ"]
    assert body["event"] == "IEM Cologne 2025"
    assert body["maps"] == ["mirage", "nuke"]
    assert body["demo_urls"] == ["https://www.hltv.org/download/demo/98765"]

    roster = json.loads((settings.demo_dir / "2380002.roster.json").read_text())
    assert roster["team1"]["name"] == "Vitality"
    assert roster["team1"]["players_detailed"][1] == {"name": "ZywOo", "hltv_id": 11893}
    assert roster["team2"]["logo"].endswith("mouz.png")

    pending = client.get("/api/import/status").json()["pending_hltv"]
    assert pending[0]["match_id"] == 2380002


@pytest.mark.parametrize("url", [
    "http://www.hltv.org/matches/1/x",
    "https://hltv.org.evil.com/matches/1/x",
    "https://www.hltv.org/results",
    "https://www.hltv.org/matches/abc/x",
])
def test_hltv_page_rejects_other_urls(api, url):
    client, _m, _q, _d = api
    assert client.post("/api/import/hltv-page", json={"url": url, "html": "<html></html>"}).status_code == 400


def test_hltv_download_paths(api, src_dir):
    client, _m, queued, downloads = api
    arch = _zip(downloads / "vitality-vs-mouz-bo3.zip", {
        "vitality-vs-mouz-m1-mirage.dem": _dem_bytes(800),
        "vitality-vs-mouz-m2-nuke.dem": _dem_bytes(900),
    })

    # outside Downloads / watched folders
    outside = _zip(src_dir / "elsewhere" / "x.zip", {"a_mirage.dem": _dem_bytes()})
    r = client.post("/api/import/hltv-download", json={"match_id": 2380003, "file_path": str(outside)})
    assert r.status_code == 403

    # path that isn't on this machine
    r = client.post("/api/import/hltv-download",
                    json={"match_id": 2380003, "file_path": str(downloads / "gone.rar")})
    assert r.status_code == 404 and "Demo picker" in r.json()["detail"]

    # wrong extension
    r = client.post("/api/import/hltv-download",
                    json={"match_id": 2380003, "file_path": str(downloads / "x.exe")})
    assert r.status_code == 400

    r = client.post("/api/import/hltv-download", json={"match_id": 2380003, "file_path": str(arch)})
    assert r.status_code == 200, r.text
    assert sorted(r.json()["demos"]) == ["2380003_mirage.dem", "2380003_nuke.dem"]
    assert arch.exists()
    assert len(queued) == 1

    # the extension retrying the same file is harmless
    again = client.post("/api/import/hltv-download", json={"match_id": 2380003, "file_path": str(arch)})
    assert again.json()["status"] == "duplicate"


def test_watcher_leaves_fresh_archives_to_extension(api, src_dir):
    client, m, _q, downloads = api
    client.put("/api/import/settings", json={"watch_folders": [], "watch_downloads": True})
    m.importer.add_pending_hltv(2380004, ["mirage"])
    with m.importer.connect() as conn:
        conn.execute("UPDATE imports_hltv_pending SET created_at = ?", (time.time() - 60,))
    # downloaded after the user clicked Send → left for /hltv-download
    arch = _zip(downloads / "fresh.zip", {"a_mirage.dem": _dem_bytes()})
    os.utime(arch, (time.time() - 30, time.time() - 30))
    # an older archive is fair game
    old = _zip(downloads / "old_scrim.zip", {"b_nuke.dem": _dem_bytes()})
    os.utime(old, (time.time() - 3600, time.time() - 3600))

    r = client.post("/api/import/scan").json()
    assert [Path(x["source"]).name for x in r["results"]] == ["old_scrim.zip"]
