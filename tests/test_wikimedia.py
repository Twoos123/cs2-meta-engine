"""Wikimedia Commons player photos: matching + license filtering (no network)."""
import json

import pytest

from backend.ingestion import wikimedia as wm


@pytest.mark.parametrize("lic,ok", [
    ("CC BY 2.0", True), ("CC BY-SA 4.0", True), ("CC BY 3.0", True), ("CC0", True),
    ("Public domain", True), ("CC BY-NC 2.0", False), ("CC BY-ND 4.0", False),
    ("CC BY-NC-SA 3.0", False), ("All rights reserved", False), (None, False),
])
def test_license_filter(lic, ok):
    assert wm.license_ok(lic) is ok


def _ent(label, aliases=(), desc="", img=True):
    return {
        "labels": {"en": {"value": label}},
        "aliases": {"en": [{"value": a} for a in aliases]},
        "descriptions": {"en": {"value": desc}},
        "claims": {"P18": [{}]} if img else {},
    }


def test_choose_exact_alias_prefers_counter_strike():
    ents = {
        "Q1": _ent("Nikola Kovač", ["NiKo"], "Bosnian Counter-Strike player"),
        "Q2": _ent("Niko Someone", ["niko"], "Finnish Dota 2 player"),
        "Q3": _ent("Nikolai", ["Nikolai"], "Counter-Strike coach"),
    }
    assert wm.choose_entity("NiKo", ents) == "Q1"


def test_choose_ambiguous_without_cs_hint_is_none():
    ents = {"Q1": _ent("A", ["rain"], "Norwegian singer"), "Q2": _ent("B", ["rain"], "painter")}
    assert wm.choose_entity("rain", ents) is None


def test_choose_requires_exact_name():
    assert wm.choose_entity("broky", {"Q1": _ent("Helvijs Saukants", ["brokyy"], "CS player")}) is None


def test_lookup_end_to_end_with_fake_api(monkeypatch, tmp_root):
    calls = []

    def fake_get(url, params):
        calls.append(params.get("action"))
        if params.get("list") == "search":
            return {"query": {"search": [{"title": "Q65246991"}]}}
        if params.get("action") == "wbgetentities":
            e = _ent("Mathieu Herbaut", ["ZywOo"], "French professional Counter-Strike player")
            e["claims"]["P18"] = [{"mainsnak": {"datavalue": {"value": "ZywOo 2022.jpg"}}}]
            return {"entities": {"Q65246991": e}}
        return {"query": {"pages": {"1": {"imageinfo": [{
            "thumburl": "https://upload.wikimedia.org/x/480px-ZywOo.jpg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC BY 2.0"},
                "Artist": {"value": '<a href="//x">Esports Kingdom</a>'},
            },
        }]}}}}

    monkeypatch.setattr(wm, "_get", fake_get)
    ref = wm.lookup("ZywOo")
    assert (ref.status, ref.license, ref.author) == ("ok", "CC BY 2.0", "Esports Kingdom")
    assert ref.attribution("ZywOo")["credit"] == "Photo: Esports Kingdom, CC BY 2.0 via Wikimedia Commons"
    n = len(calls)
    wm.lookup("ZywOo")              # second call served from the disk cache
    assert len(calls) == n


def test_photo_chain_uses_wikimedia_and_purges_unlicensed(monkeypatch, tmp_root):
    import backend.api.photos as m

    d = m._PHOTO_CACHE_DIR
    d.mkdir(parents=True, exist_ok=True)
    for p in d.iterdir():
        p.unlink()
    ref = wm.PhotoRef("ok", qid="Q1", file="a.jpg", image_url="https://upload.wikimedia.org/a.jpg",
                      license="CC BY 3.0", author="BLAST Premier")
    monkeypatch.setattr(wm, "lookup", lambda name: ref)
    monkeypatch.setattr(wm, "fetch_image", lambda url: (200, "image/jpeg", b"jpegbytes"))
    assert m._fetch_player_photo(None, None, name="device") == "ok"
    key = m._photo_key(None, "device")
    assert json.loads((d / f"{key}.json").read_text())["source"] == "wikimedia"

    (d / "11893.png").write_bytes(b"old hltv photo")          # HLTV-era, no sidecar
    assert m.purge_unlicensed_photos() == 1
    assert not (d / "11893.png").exists()
    assert (d / f"{key}.png").exists()                          # licensed photo kept


@pytest.mark.parametrize("url,ok", [
    ("https://upload.wikimedia.org/a.jpg", True),
    ("https://thumb.wikimedia.org/wikipedia/commons/thumb/d/dd/x.jpg/500px-x.jpg", True),
    ("https://evil.example/a.jpg", False),
])
def test_fetch_image_host_allowlist(monkeypatch, url, ok):
    import importlib

    real = importlib.reload(wm)            # undo the conftest offline stub for this test
    monkeypatch.setattr(real, "_http", lambda: type("S", (), {
        "get": staticmethod(lambda u, timeout=None: type("R", (), {
            "status_code": 200, "headers": {"content-type": "image/jpeg"}, "content": b"x"})())})())
    if ok:
        assert real.fetch_image(url)[0] == 200
    else:
        with pytest.raises(ValueError):
            real.fetch_image(url)
