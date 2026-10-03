"""Liquipedia client, catalog and photo licensing — saved fixtures, no network.

Fixtures in tests/fixtures/liquipedia/ are trimmed real API responses
(October 2026): `action=parse` of Liquipedia:Matches and of
ESL/Pro League/Season 24, a pageprops/categories query for player names,
and commons file pages with their FileInfo license templates.
"""
import copy
import json
from pathlib import Path

import pytest

FIX = Path(__file__).parent / "fixtures" / "liquipedia"


def _fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


@pytest.fixture()
def lp(tmp_path, monkeypatch):
    from backend.config import settings
    from backend.ingestion import liquipedia as m

    monkeypatch.setattr(settings, "liquipedia_cache_dir", tmp_path / "lpcache")
    clock = {"t": 1_000_000.0}
    sleeps = []

    def fake_sleep(s):
        sleeps.append(s)
        clock["t"] += s

    monkeypatch.setattr(m.throttle, "sleep", fake_sleep)
    monkeypatch.setattr(m.throttle, "clock", lambda: clock["t"])
    monkeypatch.setattr(m.throttle, "_last", {})
    monkeypatch.setattr(m.throttle, "_loaded", True)
    m._test_sleeps = sleeps
    m._test_clock = clock

    def no_network(*a, **k):
        raise AssertionError("unexpected network access")

    monkeypatch.setattr(m, "_http_get", no_network)
    return m


def _route(monkeypatch, lp, *, commons=None, wiki=None, parse=None, files=None, calls=None):
    """Fake `_http_get` that answers from fixtures by endpoint."""
    def fake(url, params=None, headers=None):
        if calls is not None:
            calls.append((url, dict(params or {})))
        if "/commons/images/" in url:
            status, ctype, body = (files or {}).get(url, (404, "text/html", b""))
            return status, {"content-type": ctype}, body
        if "/commons/api.php" in url:
            return 200, {}, json.dumps(commons).encode()
        if params and params.get("action") == "parse":
            return 200, {}, json.dumps(parse[params["page"]]).encode()
        return 200, {}, json.dumps(wiki).encode()

    monkeypatch.setattr(lp, "_http_get", fake)


# ─── Parsers ────────────────────────────────────────────────────────────


def test_parse_match_ticker(lp):
    html = _fixture("matches_parse.json")["parse"]["text"]
    ms = lp.parse_match_ticker(html)
    assert len(ms) == 4
    upcoming = [m for m in ms if not m.finished]
    done = [m for m in ms if m.finished]
    assert len(upcoming) == 2 and len(done) == 2
    aurora = next(m for m in done if m.team1 == "Aurora Gaming")
    assert (aurora.team2, aurora.score1, aurora.score2) == ("9z Team", 2, 0)
    assert aurora.team1_short == "Aurora"
    assert aurora.page == "ESL/Pro League/Season 24"
    assert (aurora.event, aurora.stage) == ("ESL Pro League Season 24", "Round 1")
    assert aurora.best_of == 3 and aurora.timestamp == 1791036000
    # Upcoming matches show 0:0 on the page — that is not a score.
    assert all(m.score1 is None and m.score2 is None for m in upcoming)


def test_parse_tournament_matches_maps_and_hltv(lp):
    html = _fixture("tournament_parse.json")["parse"]["text"]
    ms = lp.parse_tournament_matches(html, "ESL/Pro League/Season 24", "ESL Pro League Season 24")
    falcons = next(m for m in ms if m.team1 == "Team Falcons")
    assert falcons.hltv_id == 2398717
    assert falcons.maps == ["mirage", "anubis"]      # struck-out Nuke not played
    legacy = next(m for m in ms if m.team1 == "Legacy")
    assert legacy.maps == ["dust2", "inferno", "ancient"]
    assert legacy.team2_short == "PV"


def test_match_key_is_stable_and_order_insensitive(lp):
    a = lp.match_key("ESL/Pro League/Season 24", 1791036000, "Aurora Gaming", "9z Team")
    b = lp.match_key("ESL/Pro League/Season 24", 1791036000, "9z team", "aurora gaming")
    assert a == b and a.startswith("lp:")
    assert a != lp.match_key("ESL/Pro League/Season 24", 1791036001, "Aurora Gaming", "9z Team")


def test_tier_from_categories(lp):
    assert lp.tier_from_categories(["Category:S-Tier Tournaments"]) == "S"
    assert lp.tier_from_categories(["S-Tier_Tournaments", "Live_Tournaments"]) == "S"
    assert lp.tier_from_categories(["Category:Qualifier Tournaments"]) == "Qualifier"
    assert lp.tier_from_categories([]) is None


# ─── Licensing ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "code,ok,name",
    [
        ("cc-by-sa-3.0", True, "CC BY-SA 3.0"),
        ("CC-BY-4.0", True, "CC BY 4.0"),
        ("cc0", True, "CC0"),
        ("pd", True, "Public domain"),
        ("permission", False, "permission"),
        ("copyright", False, "copyright"),
        ("cc-by-nc-sa-3.0", False, "cc-by-nc-sa-3.0"),
        ("", False, "unknown"),
    ],
)
def test_classify_license(lp, code, ok, name):
    assert lp.classify_license(code) == (ok, name)


def test_parse_file_info(lp):
    page = _fixture("commons_files.json")["query"]["pages"][0]
    text = page["revisions"][0]["slots"]["main"]["content"]
    info = lp.parse_file_info(text)
    assert info["license_code"] == "permission"
    assert info["author"]
    assert lp.parse_file_info("{{cc-by-sa-3.0}}")["license_code"] == "cc-by-sa-3.0"
    assert lp.parse_file_info("|license=cc-by-4.0\n|author=[[User:X|Jane Doe]]\n")["author"] == "Jane Doe"


# ─── Terms of use: throttle, cache, User-Agent ──────────────────────────


def test_user_agent_identifies_project_without_personal_email(lp):
    ua = lp.user_agent()
    assert ua.startswith("CS2MetaEngine/")
    assert "https://github.com/Twoos123/cs2-meta-engine" in ua
    assert "@" not in ua


def test_throttle_spacing(lp):
    lp.throttle.wait("query")
    lp.throttle.wait("query")
    lp.throttle.wait("parse")
    lp.throttle.wait("parse")
    s = lp._test_sleeps
    assert s[0] == pytest.approx(2.0)                 # 1 request / 2 s
    assert s[1] == pytest.approx(2.0)
    assert s[2] == pytest.approx(30.0)                # 1 parse / 30 s


def test_api_get_caches_and_serves_stale_on_error(lp, monkeypatch):
    calls = []
    _route(monkeypatch, lp, parse={"Liquipedia:Matches": _fixture("matches_parse.json")}, calls=calls)
    first = lp.fetch_recent_matches()
    again = lp.fetch_recent_matches()
    assert len(calls) == 1 and len(first) == len(again) == 4
    assert calls[0][1]["action"] == "parse" and calls[0][1]["format"] == "json"

    def broken(*a, **k):
        return 503, {}, b"down"

    monkeypatch.setattr(lp, "_http_get", broken)
    assert len(lp.fetch_recent_matches(force=True)) == 4   # stale copy


def test_api_get_raises_without_cache(lp, monkeypatch):
    monkeypatch.setattr(lp, "_http_get", lambda *a, **k: (429, {}, b""))
    with pytest.raises(lp.LiquipediaError):
        lp.fetch_recent_matches()


def test_fetch_file_refuses_other_hosts(lp):
    with pytest.raises(ValueError):
        lp.fetch_file("https://img-cdn.hltv.org/playerbodyshot/x.png")


# ─── Player photo lookups ───────────────────────────────────────────────


def _cc_commons():
    """The real ZywOo file page with its license switched to CC BY-SA 3.0."""
    data = copy.deepcopy(_fixture("commons_files.json"))
    for p in data["query"]["pages"]:
        if "ZywOo" in p["title"]:
            slot = p["revisions"][0]["slots"]["main"]
            slot["content"] = slot["content"].replace("|license=permission", "|license=cc-by-sa-3.0")
    return data


def test_lookup_rejects_permission_licensed_photo(lp, monkeypatch):
    _route(monkeypatch, lp, wiki=_fixture("players_query.json"), commons=_fixture("commons_files.json"))
    res = lp.lookup_player_photos(["ZywOo"])["ZywOo"]
    assert res.status == "rejected"
    assert "permission" in res.reason
    assert res.image_url is None


def test_lookup_name_checks(lp, monkeypatch):
    _route(monkeypatch, lp, wiki=_fixture("players_query.json"), commons=_fixture("commons_files.json"))
    out = lp.lookup_player_photos(["alex", "Nonexistentplayerxyz", "Seb"])
    assert out["alex"].status == "rejected"          # caster/staff page, not a player
    assert "not a Counter-Strike player" in out["alex"].reason
    assert out["Nonexistentplayerxyz"].status == "missing"
    assert out["Seb"].status == "missing"            # file not on commons fixture


def test_lookup_accepts_reusable_license_and_caches(lp, monkeypatch):
    calls = []
    _route(monkeypatch, lp, wiki=_fixture("players_query.json"), commons=_cc_commons(), calls=calls)
    res = lp.lookup_player_photos(["ZywOo"])["ZywOo"]
    assert res.status == "ok"
    assert res.license == "CC BY-SA 3.0"
    assert res.license_url == "https://creativecommons.org/licenses/by-sa/3.0/"
    assert res.author == "Stephanie Lindgren"
    assert res.image_url.startswith("https://liquipedia.net/commons/images/")
    assert "via Liquipedia" in res.attribution()["credit"]
    n = len(calls)
    lp.lookup_player_photos(["ZywOo"])
    assert len(calls) == n                            # per-name cache, no new request


# ─── Photo cache with the Liquipedia source ─────────────────────────────


@pytest.fixture()
def photos(tmp_root, lp):
    import backend.api.photos as m

    d = m._PHOTO_CACHE_DIR
    d.mkdir(parents=True, exist_ok=True)
    for p in d.iterdir():
        if p.is_file():
            p.unlink()
    return m, d


def test_photo_by_name_saves_image_and_attribution(photos, lp, monkeypatch):
    m, d = photos
    commons = _cc_commons()
    page = next(p for p in commons["query"]["pages"] if "ZywOo" in p["title"])
    thumb = page["imageinfo"][0]["url"]   # no iiurlwidth in the fixture → full URL
    _route(monkeypatch, lp, wiki=_fixture("players_query.json"), commons=commons,
           files={thumb: (200, "image/jpeg", b"\xff\xd8\xff-jpeg")})
    assert m._fetch_player_photo(None, None, name="ZywOo") == "ok"
    key = m.name_key("ZywOo")
    assert (d / f"{key}.png").read_bytes().startswith(b"\xff\xd8\xff")
    attr = json.loads((d / f"{key}.json").read_text())
    assert attr["license"] == "CC BY-SA 3.0" and attr["source"] == "liquipedia"
    assert attr["credit"] == "Photo: Stephanie Lindgren, CC BY-SA 3.0 via Liquipedia"


def test_photo_rejected_license_marks_missing_but_keeps_old(photos, lp, monkeypatch):
    m, d = photos
    _route(monkeypatch, lp, wiki=_fixture("players_query.json"), commons=_fixture("commons_files.json"))
    key = m.name_key("ZywOo")
    assert m._fetch_player_photo(None, None, name="ZywOo") == "missing"
    reasons = json.loads((d / f"{key}.404").read_text())["reasons"]
    assert any("permission" in r for r in reasons)
    # A photo cached earlier is kept when a refresh finds nothing usable.
    (d / f"{key}.404").unlink()
    (d / f"{key}.png").write_bytes(b"old")
    assert m._fetch_player_photo(None, None, force=True, name="ZywOo") == "ok"
    assert (d / f"{key}.png").read_bytes() == b"old"


def test_photo_transient_liquipedia_error_never_marks_missing(photos, lp, monkeypatch):
    m, d = photos
    monkeypatch.setattr(lp, "_http_get", lambda *a, **k: (503, {}, b""))
    key = m.name_key("ropz")
    (d / f"{key}.png").write_bytes(b"good")
    assert m._fetch_player_photo(None, None, force=True, name="ropz") == "error"
    assert (d / f"{key}.png").read_bytes() == b"good"
    assert not (d / f"{key}.404").exists()
    assert (d / f"{key}.checked").exists()


def test_name_keys_are_filesystem_safe(photos):
    m, _d = photos
    k = m.name_key("../../etc/passwd")
    assert "/" not in k and ".." not in k and k.startswith("n_")
    assert m.name_key("ZywOo") == m.name_key("zywoo")
    assert m.clean_player_name("a/b") is None
    assert m.clean_player_name("x" * 65) is None
    assert m.clean_player_name("  m0NESY ") == "m0NESY"


def test_photo_endpoints(client, photos):
    m, d = photos
    key = m.name_key("ZywOo")
    (d / f"{key}.png").write_bytes(b"\xff\xd8\xffjpeg")
    (d / f"{key}.json").write_text(json.dumps({"source": "liquipedia", "license": "CC BY-SA 3.0",
                                               "credit": "Photo: X, CC BY-SA 3.0 via Liquipedia"}))
    r = client.get("/api/player-photo/by-name/ZywOo.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    a = client.get("/api/player-photo/by-name/ZywOo/attribution").json()
    assert a["available"] and a["license"] == "CC BY-SA 3.0"
    assert client.get("/api/player-photo/by-name/%3Cx%3E.png").status_code == 400
    (d / "77.404").write_text(json.dumps({"reasons": ["liquipedia: license 'permission' does not allow reuse"]}))
    assert client.get("/api/player-photo/77.png").status_code == 404
    a = client.get("/api/player-photo/77/attribution").json()
    assert a["available"] is False and "permission" in a["reasons"][0]


# ─── Catalog ────────────────────────────────────────────────────────────


def test_catalog_refresh_flow_and_endpoints(client, lp, monkeypatch, tmp_root):
    import time as _time

    from backend.config import settings
    from backend.ingestion.match_catalog import MatchCatalog

    # Shift the fixture (saved 2026-10-03) so its matches are always recent.
    shift = int(_time.time()) - 1791040000
    cat = MatchCatalog()
    ticker = lp.parse_match_ticker(_fixture("matches_parse.json")["parse"]["text"])
    for m in ticker:
        m.timestamp += shift
    tiers = {"ESL/Pro League/Season 24": "S", "Stake Ranked/Episode 4": "C"}
    new, upd = cat.upsert_matches(ticker, tiers)
    assert (new, upd) == (4, 0)
    assert cat.upsert_matches(ticker, tiers) == (0, 4)          # idempotent

    todo = cat.tournaments_to_enrich({"S", "A"}, 3)
    assert [t[0] for t in todo] == ["ESL/Pro League/Season 24"]

    html = _fixture("tournament_parse.json")["parse"]["text"]
    rows = lp.parse_tournament_matches(html, "ESL/Pro League/Season 24", "ESL Pro League Season 24")
    for m in rows:
        m.timestamp += shift
    cat.upsert_matches(rows, tiers, enriched=True)

    # A local demo named after the HLTV id is matched to its row.
    (settings.demo_dir / "2398717_mirage.dem").write_bytes(b"x")
    try:
        r = client.get("/api/catalog/matches", params={"days": 30})
        assert r.status_code == 200
        by_teams = {(m["team1"], m["team2"]): m for m in r.json()}
        falcons = by_teams[("Team Falcons", "TYLOO")]
        assert falcons["hltv_url"] == "https://www.hltv.org/matches/2398717/-"
        assert falcons["liquipedia_url"] == "https://liquipedia.net/counterstrike/ESL/Pro_League/Season_24"
        assert falcons["maps"] == ["mirage", "anubis"]
        assert falcons["local_demos"] == ["2398717_mirage.dem"]
        assert falcons["local_maps"] == ["mirage"]
        assert falcons["tier"] == "S" and falcons["source"] == "liquipedia"
        assert falcons["match_key"].startswith("lp:")
        upcoming = by_teams[("MOUZ", "M80")]
        assert upcoming["status"] == "upcoming" and upcoming["hltv_url"] is None

        ev = {e["event"]: e for e in client.get("/api/catalog/events", params={"days": 30}).json()}
        assert ev["ESL Pro League Season 24"]["big"] is True
        assert ev["ESL Pro League Season 24"]["tier"] == "S"
        assert ev["Stake Ranked Episode 4"]["big"] is False

        st = client.get("/api/catalog/status").json()
        assert st["source"] == "liquipedia" and "CC-BY-SA" in st["attribution"]
        assert st["autopull_enabled"] is False
        assert client.post("/api/catalog/matches/2398717/fetch").status_code == 410
        assert client.post("/api/catalog/backfill-rosters").status_code == 410
    finally:
        (settings.demo_dir / "2398717_mirage.dem").unlink()


def test_local_demo_match_by_team_names(tmp_path):
    from backend.api.catalog import local_demos_for, local_roster_index

    (tmp_path / "2393087.roster.json").write_text(json.dumps({
        "match_id": 2393087, "event": "IEM Rio 2026", "date": "",
        "team1": {"name": "Aurora"}, "team2": {"name": "HOTU"},
    }))
    (tmp_path / "2393087_mirage.dem").write_bytes(b"x")
    idx = local_roster_index(tmp_path)
    row = {"team1": "Aurora Gaming", "team2": "HOTU", "event": "IEM Rio 2026",
           "date_unix": 1790000000, "hltv_id": None}
    assert local_demos_for(row, tmp_path, idx) == ["2393087_mirage.dem"]
    other = {**row, "event": "BLAST Open Fall 2026"}
    assert local_demos_for(other, tmp_path, idx) == []


def test_reschedule_folds_into_existing_row(client, lp):
    from backend.ingestion.match_catalog import MatchCatalog

    cat = MatchCatalog()
    m1 = lp.LPMatch(page="X/Cup", event="X Cup", stage="", timestamp=1791100000,
                    team1="Alpha", team2="Beta", best_of=3)
    cat.upsert_matches([m1], {})
    m2 = lp.LPMatch(page="X/Cup", event="X Cup", stage="", timestamp=1791103600,
                    team1="Alpha", team2="Beta", best_of=3)
    assert cat.upsert_matches([m2], {}) == (0, 1)
    assert cat.get(m1.key) is None and cat.get(m2.key)["date_unix"] == 1791103600
