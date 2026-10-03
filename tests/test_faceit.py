"""FACEIT Downloads API flow — no network: requests are faked."""
import pytest


class _Resp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload or {}

    def json(self):
        return self._payload


@pytest.fixture()
def scraper(tmp_root):
    from backend.ingestion.faceit_scraper import FaceitScraper

    return FaceitScraper(api_key="test-key")


def test_signed_url_returned(scraper, monkeypatch):
    calls = {}

    def fake_post(url, json=None, timeout=None):
        calls["url"], calls["body"] = url, json
        return _Resp(200, {"payload": {"download_url": "https://signed.example/x.dem.gz?sig=1"}})

    monkeypatch.setattr(scraper.session, "post", fake_post)
    res = "https://demos.faceit.com/cs2/1-abc-1-1.dem.gz"
    assert scraper.signed_download_url(res) == "https://signed.example/x.dem.gz?sig=1"
    assert calls["body"] == {"resource_url": res}
    assert calls["url"].endswith("/download/v2/demos/download")
    assert scraper.downloads_api_status == "ok"


@pytest.mark.parametrize("status", [401, 403])
def test_not_granted_falls_back(scraper, monkeypatch, status):
    monkeypatch.setattr(scraper.session, "post", lambda *a, **k: _Resp(status))
    assert scraper.signed_download_url("https://demos.faceit.com/x.dem.gz") is None
    assert scraper.downloads_api_status == "not_granted"


def test_auth_header_uses_key(scraper):
    assert scraper.session.headers["Authorization"] == "Bearer test-key"
