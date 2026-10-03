"""
Liquipedia client — match catalog + player photo metadata.

Everything goes through Liquipedia's free MediaWiki API and follows its
API terms of use (https://liquipedia.net/api-terms-of-use):

- A descriptive User-Agent with contact info (`settings.liquipedia_contact`).
- gzip accepted (httpx decodes it transparently).
- At most one request per 2 seconds, and at most one `action=parse` per
  30 seconds. Enforced by a process-wide throttle (`_Throttle`) whose last
  request times are also written to disk, so a `--reload` restart can't
  burst past the limit.
- Aggressive on-disk caching under `settings.liquipedia_cache_dir`; a
  failed refresh falls back to the stale copy.
- Only API endpoints are automated (no HTML page scraping). Image files are
  fetched from the URLs the API returns, through the same throttle.
- Content is CC-BY-SA 3.0: the UI credits Liquipedia wherever it is shown.

LiquipediaDB (api.liquipedia.net) needs an API key, so nothing here depends
on it; `lpdb_get` is the hook to use once `settings.liquipedia_api_key` is set.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote, unquote, urlparse

from backend.config import settings

logger = logging.getLogger(__name__)

CLIENT_VERSION = "1.2"
BASE = "https://liquipedia.net"
ATTRIBUTION = "Data from Liquipedia (CC-BY-SA 3.0)"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/3.0/"

# Rate limits from the terms of use.
MIN_INTERVAL_S = 2.0
PARSE_INTERVAL_S = 30.0
LPDB_INTERVAL_S = 60.0           # 60 requests / hour

# Cache lifetimes.
TICKER_TTL = 20 * 60             # Liquipedia:Matches
TOURNAMENT_TTL = 2 * 3600        # a tournament page's brackets
TIER_TTL = 7 * 86400             # a tournament's tier rarely changes
PLAYER_TTL = 14 * 86400          # player page → main image resolution
FILE_TTL = 14 * 86400            # file license
MISSING_TTL = 3 * 86400          # "no such page" — retry a bit sooner

BATCH = 50                       # MediaWiki titles-per-query limit


class LiquipediaError(RuntimeError):
    """Transient failure (network, 429, 5xx, API error) — callers retry later."""


def cache_dir() -> Path:
    d = Path(settings.liquipedia_cache_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def user_agent() -> str:
    contact = (settings.liquipedia_contact or "").strip() or (
        "https://github.com/Twoos123/cs2-meta-engine"
    )
    return (
        f"CS2MetaEngine/{CLIENT_VERSION} "
        f"(https://github.com/Twoos123/cs2-meta-engine; {contact})"
    )


def api_url(wiki: Optional[str] = None) -> str:
    return f"{BASE}/{wiki or settings.liquipedia_wiki}/api.php"


def page_url(title: str, wiki: Optional[str] = None) -> str:
    return f"{BASE}/{wiki or settings.liquipedia_wiki}/" + quote(
        title.replace(" ", "_"), safe="/:()'!,"
    )


# ─── Throttle ───────────────────────────────────────────────────────────


class _Throttle:
    """Process-wide request pacing. The lock is held while sleeping, so
    concurrent callers queue up and leave one at a time."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.sleep = time.sleep          # swapped out in tests
        self.clock = time.time
        self._last: Dict[str, float] = {}
        self._loaded = False

    def _state_file(self) -> Path:
        return cache_dir() / ".throttle.json"

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(self._state_file().read_text())
            self._last = {k: float(v) for k, v in data.items()}
        except Exception:
            self._last = {}

    def _save(self) -> None:
        try:
            self._state_file().write_text(json.dumps(self._last))
        except OSError:
            pass

    def wait(self, kind: str) -> None:
        """Block until a request of `kind` ("query" | "parse" | "file" |
        "lpdb") may go out, then record it."""
        with self._lock:
            self._load()
            now = self.clock()
            if kind == "lpdb":
                ready = self._last.get("lpdb", 0) + LPDB_INTERVAL_S
            else:
                ready = self._last.get("any", 0) + MIN_INTERVAL_S
                if kind == "parse":
                    ready = max(ready, self._last.get("parse", 0) + PARSE_INTERVAL_S)
            # Clamp: a clock jump must never wedge the client for hours.
            delay = min(max(0.0, ready - now), PARSE_INTERVAL_S + MIN_INTERVAL_S)
            if delay > 0:
                self.sleep(delay)
            stamp = self.clock()
            if kind == "lpdb":
                self._last["lpdb"] = stamp
            else:
                self._last["any"] = stamp
                if kind == "parse":
                    self._last["parse"] = stamp
            self._save()


throttle = _Throttle()


# ─── HTTP ───────────────────────────────────────────────────────────────

_client = None
_client_lock = threading.Lock()


def _http_client():
    """One shared client so connections are re-used (terms: don't open a new
    connection per request)."""
    global _client
    with _client_lock:
        if _client is None:
            import httpx

            _client = httpx.Client(
                headers={"User-Agent": user_agent(), "Accept-Encoding": "gzip"},
                timeout=30.0,
                follow_redirects=True,
            )
        return _client


def _http_get(
    url: str, params: Optional[dict] = None, headers: Optional[dict] = None,
) -> Tuple[int, Dict[str, str], bytes]:
    """The single network seam — tests monkeypatch this."""
    resp = _http_client().get(url, params=params, headers=headers)
    return resp.status_code, {k.lower(): v for k, v in resp.headers.items()}, resp.content


def _cache_path(sub: str, key: str) -> Path:
    d = cache_dir() / sub
    d.mkdir(parents=True, exist_ok=True)
    return d / (hashlib.sha1(key.encode("utf-8")).hexdigest()[:24] + ".json")


def _read_cache(path: Path, ttl: float) -> Tuple[Optional[dict], bool]:
    """Returns (payload, fresh)."""
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None, False
    age = time.time() - float(blob.get("fetched_at", 0))
    return blob.get("data"), age < ttl


def _write_cache(path: Path, data, url: str = "") -> None:
    tmp = path.with_suffix(".part")
    tmp.write_text(
        json.dumps({"fetched_at": time.time(), "url": url, "data": data}),
        encoding="utf-8",
    )
    tmp.replace(path)


def api_get(
    params: dict, *, ttl: float, wiki: Optional[str] = None,
    force: bool = False, not_before: Optional[float] = None,
) -> dict:
    """Cached, throttled MediaWiki API GET. `not_before` treats a cache entry
    fetched earlier than that epoch time as stale. A failed refresh serves
    the stale cache copy when there is one; otherwise raises LiquipediaError."""
    params = {**params, "format": "json", "formatversion": "2"}
    url = api_url(wiki)
    key = url + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    path = _cache_path("api", key)
    cached, fresh = _read_cache(path, ttl)
    if fresh and not_before:
        try:
            fresh = json.loads(path.read_text(encoding="utf-8"))["fetched_at"] >= not_before
        except Exception:
            fresh = False
    if cached is not None and fresh and not force:
        return cached

    kind = "parse" if params.get("action") == "parse" else "query"
    try:
        throttle.wait(kind)
        status, _headers, body = _http_get(url, params=params)
        if status != 200:
            raise LiquipediaError(f"HTTP {status} from {url}")
        data = json.loads(body)
        if "error" in data:
            raise LiquipediaError(f"API error: {data['error'].get('info') or data['error']}")
    except LiquipediaError:
        if cached is not None:
            logger.warning("liquipedia: refresh failed, serving stale cache for %s", params.get("page") or params.get("titles"))
            return cached
        raise
    except Exception as exc:
        if cached is not None:
            logger.warning("liquipedia: %s — serving stale cache", exc)
            return cached
        raise LiquipediaError(str(exc)) from exc
    _write_cache(path, data, url)
    return data


def fetch_file(url: str) -> Tuple[int, str, bytes]:
    """Download an image file the API pointed us at (throttled like any
    other request). Returns (status, content_type, body)."""
    host = urlparse(url).hostname or ""
    if host != "liquipedia.net":
        raise ValueError(f"refusing non-Liquipedia file URL: {url}")
    throttle.wait("file")
    try:
        status, headers, body = _http_get(url)
    except Exception as exc:
        raise LiquipediaError(str(exc)) from exc
    return status, headers.get("content-type", ""), body


# ─── LiquipediaDB hook (needs an API key; unused without one) ───────────


def lpdb_enabled() -> bool:
    return bool((settings.liquipedia_api_key or "").strip())


def lpdb_get(endpoint: str, params: dict) -> dict:
    """GET https://api.liquipedia.net/api/v3/{endpoint} — the structured
    LiquipediaDB API (60 requests/hour). Not used by the catalog today; once
    a key is configured, the refresh can switch to `lpdb_get("match", ...)`
    for maps/scores without any `action=parse` calls."""
    if not lpdb_enabled():
        raise LiquipediaError("LIQUIPEDIA_API_KEY is not set")
    throttle.wait("lpdb")
    status, _h, body = _http_get(
        f"https://api.liquipedia.net/api/v3/{endpoint}",
        params={"wiki": settings.liquipedia_wiki, **params},
        headers={"Authorization": f"Apikey {settings.liquipedia_api_key.strip()}"},
    )
    if status != 200:
        raise LiquipediaError(f"LPDB HTTP {status}")
    return json.loads(body)


# ─── Matches ────────────────────────────────────────────────────────────

_MAP_ALIASES = {"dustii": "dust2", "dust2": "dust2"}


def normalize_map(name: str) -> str:
    n = re.sub(r"[^a-z0-9]", "", name.lower().replace("de_", ""))
    return _MAP_ALIASES.get(n, n)


@dataclass
class LPMatch:
    page: str                     # tournament page title holding the match
    event: str                    # display name ("ESL Pro League Season 24")
    stage: str                    # "Round 1" (may be "")
    timestamp: int                # epoch seconds
    team1: str                    # Liquipedia team page title (or raw name)
    team2: str
    team1_short: str = ""
    team2_short: str = ""
    score1: Optional[int] = None
    score2: Optional[int] = None
    best_of: Optional[int] = None
    finished: bool = False
    maps: List[str] = field(default_factory=list)
    hltv_id: Optional[int] = None

    @property
    def key(self) -> str:
        return match_key(self.page, self.timestamp, self.team1, self.team2)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["key"] = self.key
        return d


def match_key(page: str, ts: int, team1: str, team2: str) -> str:
    """Stable Liquipedia match key. Liquipedia's rendered HTML carries no
    match id, so it is derived from the page, start time and team pair
    (order-insensitive). A reschedule changes it; the catalog upsert folds
    that case back into the existing row."""
    a, b = sorted([team1.strip().lower(), team2.strip().lower()])
    raw = f"{page.strip()}|{int(ts)}|{a}|{b}"
    return "lp:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _int(text: str) -> Optional[int]:
    text = (text or "").strip()
    return int(text) if text.isdigit() else None


def _title_from_href(href: str) -> str:
    path = href.split("#", 1)[0]
    prefix = f"/{settings.liquipedia_wiki}/"
    if path.startswith(prefix):
        path = path[len(prefix):]
    return unquote(path).replace("_", " ")


def _parse_header(root) -> Optional[dict]:
    """Shared by the ticker and bracket popups: `.match-info` blocks hold a
    timer, two opponents and the series score."""
    timer = root.select_one(".timer-object[data-timestamp]")
    if timer is None:
        return None
    try:
        ts = int(timer["data-timestamp"])
    except (TypeError, ValueError):
        return None
    opps = root.select(".match-info-header .match-info-header-opponent")
    if len(opps) != 2:
        return None
    teams: List[Tuple[str, str]] = []
    for opp in opps:
        link = opp.select_one(".name a[title]")
        if link is not None:
            full = re.sub(
                r"\s*\(page does not exist\)$", "", link["title"].split("#", 1)[0]
            ).strip()
            short_el = link.select_one(".team-shortname")
            short = (short_el.get_text(strip=True) if short_el else link.get_text(strip=True)) or full
        else:
            # Unlinked opponent (TBD / placeholder). Bracket popups repeat
            # the name in short/bracket/full variants — take one.
            name_el = (
                opp.select_one(".team-name") or opp.select_one(".team-shortname")
                or opp.select_one(".name")
            )
            full = short = name_el.get_text(" ", strip=True) if name_el else ""
        teams.append((full, short))
    if any(not full or full.upper() == "TBD" for full, _ in teams):
        return None
    scores = [
        _int(s.get_text()) for s in root.select(".match-info-header-scoreholder-score")
    ][:2]
    while len(scores) < 2:
        scores.append(None)
    bo_el = root.select_one(".match-info-header-scoreholder-lower")
    bo_m = re.search(r"Bo(\d+)", bo_el.get_text() if bo_el else "", re.I)
    finished = timer.get("data-finished") == "finished"
    return {
        "timestamp": ts,
        "team1": teams[0][0], "team1_short": teams[0][1],
        "team2": teams[1][0], "team2_short": teams[1][1],
        "score1": scores[0] if finished else None,
        "score2": scores[1] if finished else None,
        "best_of": int(bo_m.group(1)) if bo_m else None,
        "finished": finished,
    }


def parse_match_ticker(html: str) -> List[LPMatch]:
    """Parse the rendered `Liquipedia:Matches` page (upcoming + completed)."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    out: List[LPMatch] = []
    seen: set = set()
    for block in soup.select("div.match-info"):
        head = _parse_header(block)
        if head is None:
            continue
        link = block.select_one(".match-info-tournament-name a[title]")
        if link is None:
            continue
        page = link["title"].split("#", 1)[0].strip()
        text = link.get_text(" ", strip=True)
        event, stage = text, ""
        if "#" in (link.get("href") or "") and " - " in text:
            event, stage = (p.strip() for p in text.rsplit(" - ", 1))
        m = LPMatch(page=page, event=event, stage=stage, **head)
        if m.key in seen:
            continue
        seen.add(m.key)
        out.append(m)
    return out


def parse_tournament_matches(html: str, page: str, event: str) -> List[LPMatch]:
    """Parse the match popups of a tournament page: maps played and the HLTV
    match link live in each popup's body/footer."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    out: List[LPMatch] = []
    seen: set = set()
    for popup in soup.select(".brkts-popup"):
        head = _parse_header(popup)
        if head is None:
            continue
        maps: List[str] = []
        for row in popup.select(".brkts-popup-body-grid-row"):
            map_link = None
            for a in row.select(".brkts-popup-spaced a[title]"):
                if a.find_parent("s") is None:
                    map_link = a
                    break
            if map_link is None:
                continue
            main = [
                s.get_text(strip=True)
                for s in row.select(".brkts-popup-body-detailed-scores-main-score")
            ]
            if not any(main):          # not played (decider skipped / upcoming)
                continue
            tok = normalize_map(map_link.get_text(strip=True))
            if tok and tok not in maps:
                maps.append(tok)
        hltv_id = None
        for a in popup.select(".brkts-popup-footer a[href]"):
            hm = re.search(r"hltv\.org/matches/(\d+)", a["href"])
            if hm:
                hltv_id = int(hm.group(1))
                break
        m = LPMatch(page=page, event=event, stage="", maps=maps, hltv_id=hltv_id, **head)
        if m.key in seen:
            continue
        seen.add(m.key)
        out.append(m)
    return out


def fetch_recent_matches(force: bool = False) -> List[LPMatch]:
    """Upcoming + recently completed matches (one `action=parse`, cached)."""
    data = api_get(
        {"action": "parse", "page": "Liquipedia:Matches", "prop": "text",
         "disablelimitreport": "1"},
        ttl=TICKER_TTL, force=force,
    )
    return parse_match_ticker(data["parse"]["text"])


def fetch_tournament_matches(
    page: str, event: str, not_before: Optional[float] = None,
) -> List[LPMatch]:
    """Matches (with maps + HLTV id) from one tournament page. `not_before`
    forces a re-parse when the cached copy predates a newly finished match."""
    data = api_get(
        {"action": "parse", "page": page, "prop": "text",
         "disablelimitreport": "1"},
        ttl=TOURNAMENT_TTL, not_before=not_before,
    )
    return parse_tournament_matches(data["parse"]["text"], page, event)


_TIER_CATEGORIES = [
    ("S", "Category:S-Tier Tournaments"),
    ("A", "Category:A-Tier Tournaments"),
    ("B", "Category:B-Tier Tournaments"),
    ("C", "Category:C-Tier Tournaments"),
    ("Qualifier", "Category:Qualifier Tournaments"),
    ("Showmatch", "Category:Showmatch Tournaments"),
    ("Weekly", "Category:Weekly Tournaments"),
    ("Monthly", "Category:Monthly Tournaments"),
    ("Misc", "Category:Misc Tournaments"),
]


def tier_from_categories(categories: Iterable[str]) -> Optional[str]:
    cats = {c.replace("_", " ") for c in categories}
    cats |= {f"Category:{c}" for c in list(cats) if not c.startswith("Category:")}
    for tier, cat in _TIER_CATEGORIES:
        if cat in cats:
            return tier
    return None


def _chunks(items: List[str], n: int = BATCH):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _resolve_titles(query: dict) -> Dict[str, str]:
    """Map each requested title to its final title (normalized → redirected)."""
    out: Dict[str, str] = {}
    for n in query.get("normalized", []) or []:
        out[n["from"]] = n["to"]
    redirects = {r["from"]: r["to"] for r in query.get("redirects", []) or []}
    for k, v in list(out.items()):
        out[k] = redirects.get(v, v)
    for frm, to in redirects.items():
        out.setdefault(frm, to)
    return out


def fetch_tournament_tiers(pages: Iterable[str]) -> Dict[str, Optional[str]]:
    """Tier per tournament page via one cheap categories query per 50 pages,
    cached for a week per page."""
    result: Dict[str, Optional[str]] = {}
    todo: List[str] = []
    for p in dict.fromkeys(pages):
        cached, fresh = _read_cache(_cache_path("tiers", p), TIER_TTL)
        if cached is not None and fresh:
            result[p] = cached.get("tier")
        else:
            todo.append(p)
    for chunk in _chunks(todo):
        data = api_get(
            {"action": "query", "prop": "categories", "redirects": "1",
             "titles": "|".join(chunk), "cllimit": "max",
             "clcategories": "|".join(c for _, c in _TIER_CATEGORIES)},
            ttl=60,
        )
        q = data.get("query", {})
        final = _resolve_titles(q)
        by_title = {
            p["title"]: [c["title"] for c in p.get("categories", []) or []]
            for p in q.get("pages", []) or []
        }
        for p in chunk:
            tier = tier_from_categories(by_title.get(final.get(p, p), []))
            result[p] = tier
            _write_cache(_cache_path("tiers", p), {"tier": tier})
    return result


# ─── Player photos ──────────────────────────────────────────────────────

# FileInfo `|license=` values (Liquipedia commons Template:FileInfo) whose
# terms allow reuse with attribution. Everything else — `permission`
# (granted to Liquipedia only), `copyright`, publisher-owned, NC/ND — is
# rejected.
_REUSABLE = {
    "cc-by": "CC BY", "cc-by-2.0": "CC BY 2.0", "cc-by-3.0": "CC BY 3.0",
    "cc-by-4.0": "CC BY 4.0",
    "cc-by-sa": "CC BY-SA", "cc-by-sa-2.0": "CC BY-SA 2.0",
    "cc-by-sa-2.5": "CC BY-SA 2.5", "cc-by-sa-3.0": "CC BY-SA 3.0",
    "cc-by-sa-4.0": "CC BY-SA 4.0",
    "cc0": "CC0", "pd": "Public domain", "pdsimple": "Public domain",
}
_LICENSE_URLS = {
    "CC BY": "https://creativecommons.org/licenses/by/4.0/",
    "CC BY-SA": "https://creativecommons.org/licenses/by-sa/4.0/",
    "CC0": "https://creativecommons.org/publicdomain/zero/1.0/",
}


def classify_license(code: str) -> Tuple[bool, str]:
    """(reusable, human-readable name) for a FileInfo license code."""
    c = (code or "").strip().lower()
    if c in _REUSABLE:
        return True, _REUSABLE[c]
    return False, c or "unknown"


def license_url(name: str) -> Optional[str]:
    m = re.match(r"(CC BY(?:-SA)?) (\d\.\d)", name)
    if m:
        kind = "by-sa" if m.group(1).endswith("SA") else "by"
        return f"https://creativecommons.org/licenses/{kind}/{m.group(2)}/"
    return _LICENSE_URLS.get(name)


def _strip_wiki(text: str) -> str:
    text = re.sub(r"\[https?://\S+\s+([^\]]+)\]", r"\1", text)      # [url label]
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", text)    # [[a|b]]
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


def parse_file_info(wikitext: str) -> dict:
    """Pull license / author / copyright out of a commons file page."""
    def param(name: str) -> str:
        m = re.search(rf"\|\s*{name}\s*=", wikitext or "", re.I)
        if not m:
            return ""
        # Value runs to the next top-level `|`, `}}` or newline — pipes
        # inside [[link|label]] / [url label] belong to the value.
        rest, depth, end = wikitext[m.end():], 0, None
        for i, ch in enumerate(rest):
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth = max(0, depth - 1)
            elif ch == "\n" or (depth == 0 and (ch == "|" or rest.startswith("}}", i))):
                end = i
                break
        return _strip_wiki(rest[:end])

    code = param("license").lower()
    if not code:
        # Bare license templates, e.g. {{cc-by-sa-3.0}}.
        m = re.search(r"\{\{\s*(cc[\w.-]*|pd\w*)\s*\}\}", wikitext or "", re.I)
        code = m.group(1).lower() if m else ""
    return {"license_code": code, "author": param("author"), "copyright": param("copyright")}


@dataclass
class PhotoLookup:
    name: str
    status: str                  # "ok" | "rejected" | "missing"
    reason: str = ""
    page: Optional[str] = None   # Liquipedia player page title
    page_url: Optional[str] = None
    file: Optional[str] = None   # "File:…"
    file_page_url: Optional[str] = None
    image_url: Optional[str] = None
    license: Optional[str] = None
    license_url: Optional[str] = None
    author: Optional[str] = None
    copyright: Optional[str] = None

    def attribution(self) -> dict:
        return {
            "source": "liquipedia",
            "player": self.name,
            "page": self.page,
            "page_url": self.page_url,
            "file": self.file,
            "file_page_url": self.file_page_url,
            "image_url": self.image_url,
            "license": self.license,
            "license_url": self.license_url,
            "author": self.author,
            "copyright": self.copyright,
            "credit": (
                f"Photo: {self.author or 'unknown author'}, {self.license} via Liquipedia"
            ),
        }


_PLAYER_CATS = "Category:Players|Category:Disambiguation pages"


def _page_info_batch(titles: List[str]) -> Tuple[Dict[str, str], Dict[str, dict], set]:
    """One query for up to 50 titles: final title map, page info, redirect sources."""
    data = api_get(
        {"action": "query", "prop": "pageprops|categories", "redirects": "1",
         "ppprop": "metaimage|displaytitle|disambiguation",
         "clcategories": _PLAYER_CATS, "cllimit": "max",
         "titles": "|".join(titles)},
        ttl=60,
    )
    q = data.get("query", {})
    final = _resolve_titles(q)
    redirected = {r["from"] for r in q.get("redirects", []) or []}
    redirected |= {
        n["from"] for n in q.get("normalized", []) or [] if n["to"] in redirected
    }
    pages = {p["title"]: p for p in q.get("pages", []) or []}
    return final, pages, redirected


def _judge_page(name: str, page: Optional[dict], via_redirect: bool) -> Tuple[str, str]:
    """('player'|'disambig'|'missing'|'rejected', reason)."""
    if page is None or page.get("missing") or page.get("invalid"):
        return "missing", "no Liquipedia page with this name"
    cats = {c["title"] for c in page.get("categories", []) or []}
    props = page.get("pageprops", {}) or {}
    if "disambiguation" in props or "Category:Disambiguation pages" in cats:
        return "disambig", "disambiguation page"
    if "Category:Players" not in cats:
        return "rejected", "page is not a Counter-Strike player page (staff / caster / team?)"
    shown = re.sub(r"<[^>]+>", "", props.get("displaytitle") or page["title"]).strip()
    if not via_redirect and shown.lower() != name.strip().lower():
        return "rejected", f"name collision: page is '{shown}'"
    if not props.get("metaimage"):
        return "missing", "player page has no image"
    return "player", ""


def _resolve_pages(names: List[str]) -> Dict[str, Tuple[str, str, Optional[dict]]]:
    """name → (verdict, reason, page) after disambiguation handling."""
    out: Dict[str, Tuple[str, str, Optional[dict]]] = {}
    disambig: Dict[str, str] = {}            # name → disambig page title
    for chunk in _chunks(names):
        final, pages, redirected = _page_info_batch(chunk)
        for n in chunk:
            title = final.get(n, n)
            page = pages.get(title)
            verdict, reason = _judge_page(n, page, n in redirected)
            if verdict == "disambig":
                disambig[n] = title
            out[n] = (verdict, reason, page)

    if disambig:
        # Candidates linked from each disambiguation page; keep the one that
        # is a player page whose display name matches exactly.
        links: Dict[str, List[str]] = {}
        for chunk in _chunks(sorted(set(disambig.values()))):
            data = api_get(
                {"action": "query", "prop": "links", "plnamespace": "0",
                 "pllimit": "max", "titles": "|".join(chunk)},
                ttl=PLAYER_TTL,
            )
            for p in data.get("query", {}).get("pages", []) or []:
                links[p["title"]] = [x["title"] for x in p.get("links", []) or []][:25]
        cand_titles = sorted({t for ts in links.values() for t in ts})
        cand_pages: Dict[str, dict] = {}
        for chunk in _chunks(cand_titles):
            _f, pages, _r = _page_info_batch(chunk)
            cand_pages.update(pages)
        for n, dtitle in disambig.items():
            hits = []
            for t in links.get(dtitle, []):
                v, _reason = _judge_page(n, cand_pages.get(t), False)
                if v == "player":
                    hits.append(cand_pages[t])
            if len(hits) == 1:
                out[n] = ("player", "", hits[0])
            else:
                out[n] = (
                    "rejected",
                    f"ambiguous name ({len(hits)} matching player pages)",
                    None,
                )
    return out


def _file_infos(files: List[str]) -> Dict[str, dict]:
    """License + URLs per file, from the commons wiki (where the files and
    their FileInfo templates live). Cached per file."""
    out: Dict[str, dict] = {}
    todo: List[str] = []
    for f in dict.fromkeys(files):
        cached, fresh = _read_cache(_cache_path("files", f), FILE_TTL)
        if cached is not None and fresh:
            out[f] = cached
        else:
            todo.append(f)
    for chunk in _chunks(todo):
        data = api_get(
            {"action": "query", "prop": "revisions|imageinfo",
             "rvprop": "content", "rvslots": "main",
             "iiprop": "url|mime", "iiurlwidth": "400",
             "titles": "|".join(chunk)},
            ttl=60, wiki="commons",
        )
        q = data.get("query", {})
        final = _resolve_titles(q)
        pages = {p["title"]: p for p in q.get("pages", []) or []}
        for f in chunk:
            p = pages.get(final.get(f, f)) or {}
            revs = p.get("revisions") or [{}]
            text = ((revs[0].get("slots") or {}).get("main") or {}).get("content", "")
            ii = (p.get("imageinfo") or [{}])[0]
            info = {
                **parse_file_info(text),
                "missing": bool(p.get("missing")) or not ii,
                "url": ii.get("url"),
                "thumb_url": ii.get("thumburl") or ii.get("url"),
                "mime": ii.get("mime"),
                "description_url": ii.get("descriptionurl"),
            }
            out[f] = info
            _write_cache(_cache_path("files", f), info)
    return out


def lookup_player_photos(names: Iterable[str]) -> Dict[str, PhotoLookup]:
    """Resolve each player name to its Liquipedia main image and decide
    whether its license allows reuse. Costs ~2 API requests per 50 names
    (plus 2 more when a name hits a disambiguation page); results are
    cached per name for 14 days."""
    result: Dict[str, PhotoLookup] = {}
    todo: List[str] = []
    for n in dict.fromkeys(x.strip() for x in names if x and x.strip()):
        cached, fresh = _read_cache(_cache_path("players", n.lower()), PLAYER_TTL)
        if cached is not None and fresh:
            result[n] = PhotoLookup(**cached)
        else:
            todo.append(n)
    if not todo:
        return result

    pages = _resolve_pages(todo)
    files: Dict[str, str] = {}
    for n in todo:
        verdict, reason, page = pages[n]
        if verdict != "player":
            result[n] = PhotoLookup(
                name=n, status="missing" if verdict == "missing" else "rejected",
                reason=reason,
                page=page["title"] if page and not page.get("missing") else None,
                page_url=page_url(page["title"]) if page and not page.get("missing") else None,
            )
            continue
        img = (page.get("pageprops") or {})["metaimage"]
        files[n] = "File:" + img
        result[n] = PhotoLookup(
            name=n, status="ok", page=page["title"], page_url=page_url(page["title"]),
            file="File:" + img,
        )

    infos = _file_infos(list(files.values()))
    for n, f in files.items():
        info = infos.get(f) or {}
        r = result[n]
        r.file_page_url = info.get("description_url") or page_url(f, "commons")
        r.author = info.get("author") or None
        r.copyright = info.get("copyright") or None
        reusable, lic = classify_license(info.get("license_code", ""))
        r.license = lic
        if info.get("missing") or not info.get("thumb_url"):
            r.status, r.reason = "missing", "image file not found on Liquipedia commons"
        elif not reusable:
            r.status = "rejected"
            r.reason = f"license '{lic}' does not allow reuse"
            if r.copyright:
                r.reason += f" (© {r.copyright})"
        else:
            r.image_url = info["thumb_url"]
            r.license_url = license_url(lic)

    for n in todo:
        r = result[n]
        ttl_hint = r.status == "missing"
        path = _cache_path("players", n.lower())
        _write_cache(path, asdict(r))
        if ttl_hint:
            # Shorter life for "no page yet": backdate so it expires sooner.
            try:
                blob = json.loads(path.read_text(encoding="utf-8"))
                blob["fetched_at"] -= PLAYER_TTL - MISSING_TTL
                path.write_text(json.dumps(blob), encoding="utf-8")
            except Exception:
                pass
    return result
