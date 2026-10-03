"""Player-photo cache: transient HLTV failures must never blank or poison it."""
import os

import pytest


class _Resp:
    def __init__(self, status: int, body: bytes = b"", ctype: str = "image/png"):
        self.status_code = status
        self.content = body
        self.headers = {"content-type": ctype}


class _FakeScraper:
    """Image requests return a fixed response. The profile page fails (as
    under a Cloudflare challenge) unless `profile_ok`, in which case it
    carries a current bodyshot."""

    def __init__(self, resp: _Resp, profile_ok: bool = False):
        self._resp = resp
        self._profile_ok = profile_ok
        self._session = self

    def _get(self, url):
        if not self._profile_ok:
            raise RuntimeError("403 challenge")
        from bs4 import BeautifulSoup

        return BeautifulSoup(
            '<div class="playerBodyshot"><img class="bodyshot-img" '
            'src="https://img-cdn.hltv.org/playerbodyshot/abc.png"></div>',
            "html.parser",
        )

    def get(self, url, timeout=None):
        return self._resp


@pytest.fixture()
def photos(tmp_root):
    import backend.api.photos as m

    d = m._PHOTO_CACHE_DIR
    d.mkdir(parents=True, exist_ok=True)
    for p in d.iterdir():
        p.unlink()
    return m, d


def test_blocked_fetch_keeps_cached_photo(photos):
    m, d = photos
    (d / "1.png").write_bytes(b"old")
    out = m._fetch_player_photo(1, _FakeScraper(_Resp(403, ctype="text/html")), force=True)
    assert out == "error"
    assert (d / "1.png").read_bytes() == b"old"
    assert not (d / "1.404").exists()
    assert (d / "1.checked").exists()  # backs off before retrying


def test_refresh_never_falls_back_to_static_image(photos):
    # Profile page blocked, but the years-old static endpoint answers 200 —
    # a refresh must keep the current photo rather than swap in the old one.
    m, d = photos
    (d / "8.png").write_bytes(b"current")
    out = m._fetch_player_photo(8, _FakeScraper(_Resp(200, b"from-2019")), force=True)
    assert out == "error"
    assert (d / "8.png").read_bytes() == b"current"


def test_first_fetch_may_use_static_image(photos):
    m, d = photos
    assert m._fetch_player_photo(9, _FakeScraper(_Resp(200, b"static"))) == "ok"
    assert (d / "9.png").read_bytes() == b"static"


def test_blocked_fetch_does_not_mark_missing(photos):
    m, d = photos
    out = m._fetch_player_photo(2, _FakeScraper(_Resp(403, ctype="text/html")))
    assert out == "error"
    assert not (d / "2.404").exists()


def test_real_404_marks_missing(photos):
    m, d = photos
    assert m._fetch_player_photo(3, _FakeScraper(_Resp(404))) == "missing"
    assert (d / "3.404").exists()


def test_forced_refresh_replaces_photo(photos):
    m, d = photos
    (d / "4.png").write_bytes(b"old")
    (d / "4.checked").touch()
    scraper = _FakeScraper(_Resp(200, b"new"), profile_ok=True)
    assert m._fetch_player_photo(4, scraper, force=True) == "ok"
    assert (d / "4.png").read_bytes() == b"new"
    assert not (d / "4.checked").exists()


def test_staleness(photos):
    m, d = photos
    p = d / "5.png"
    p.write_bytes(b"x")
    assert not m._photo_needs_refresh(5)
    os.utime(p, (0, 0))
    assert m._photo_needs_refresh(5)
    (d / "5.checked").touch()  # failed a moment ago → back off
    assert not m._photo_needs_refresh(5)


def test_reset_marks_stale_instead_of_deleting(client, photos):
    m, d = photos
    (d / "6.png").write_bytes(b"keep")
    (d / "7.404").touch()
    r = client.post("/api/player-photos/clear")
    assert r.status_code == 200
    assert (d / "6.png").read_bytes() == b"keep"
    assert m._photo_needs_refresh(6)
    assert not (d / "7.404").exists()


def test_warm_runs_as_job_and_reports_from_db(client, monkeypatch):
    """Warm progress comes from the jobs table, so any API replica can serve it."""
    import time as _time

    import backend.api.photos as m

    monkeypatch.setattr(m, "_collect_known_hltv_ids", lambda: [101, 102, 103])
    monkeypatch.setattr(m, "_hltv_names", lambda: {})
    monkeypatch.setattr(m, "_hltv_scraper", lambda: None)
    monkeypatch.setattr(m.lp, "lookup_player_photos", lambda names: None)
    results = iter(["ok", "missing", "ok"])
    monkeypatch.setattr(m, "_fetch_player_photo", lambda *a, **k: next(results))

    r = client.post("/api/player-photos/warm")
    assert r.status_code == 200 and r.json()["total"] == 3
    deadline = _time.time() + 15
    while _time.time() < deadline:
        st = client.get("/api/player-photos/warm/status").json()
        if not st["running"] and st["done"] == 3:
            break
        _time.sleep(0.2)
    assert (st["done"], st["ok"], st["missing"], st["errors"]) == (3, 2, 1, 0)
