"""
Player photos from Wikimedia Commons, found through Wikidata.

Most Counter-Strike pros on Wikidata are items with occupation
"professional gamer" (Q4379701) whose label is their real name and whose
aliases include the in-game nickname; many have an `image` (P18) on Commons,
often an event photo released under CC BY / CC BY-SA.

Lookup for a nickname:
  1. CirrusSearch on Wikidata: `"<nick>" haswbstatement:P106=Q4379701`
  2. wbgetentities for the candidates → keep the one whose label/alias is
     exactly the nickname (preferring a Counter-Strike description)
  3. its P18 file → Commons imageinfo (thumbnail URL + license metadata)
  4. accept only reusable licenses (CC BY, CC BY-SA, CC0, public domain)

Etiquette (https://meta.wikimedia.org/wiki/User-Agent_policy): identifying
User-Agent, serial requests with a small delay, `maxlag`, and a 14-day disk
cache so each player is looked up rarely.
"""
from __future__ import annotations

import html
import json
import logging
import re
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import quote, urlparse

import requests

from backend.config import settings

logger = logging.getLogger(__name__)

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
PROFESSIONAL_GAMER = "Q4379701"
THUMB_WIDTH = 480
CACHE_TTL_S = 14 * 86400
MIN_INTERVAL_S = 0.5

CACHE_DIR = Path("data/wikimedia")

# Reusable without permission (attribution / share-alike are fine).
_ALLOWED = re.compile(r"^(CC[ -]BY(-SA)?( \d(\.\d)?)?|CC0( 1\.0)?|Public domain|PD\b.*)", re.I)
_DISALLOWED = re.compile(r"\b(NC|ND|NonCommercial|NoDerivs?)\b", re.I)
_CS_HINT = re.compile(r"counter[- ]?strike|\bcs(:go|2)?\b|esports?|professional gamer", re.I)


class WikimediaError(Exception):
    pass


@dataclass
class PhotoRef:
    status: str                    # ok | missing
    reason: str = ""
    qid: Optional[str] = None
    file: Optional[str] = None
    image_url: Optional[str] = None
    license: Optional[str] = None
    license_url: Optional[str] = None
    author: Optional[str] = None

    def attribution(self, name: str) -> dict:
        return {
            "source": "wikimedia",
            "player": name,
            "page_url": f"https://www.wikidata.org/wiki/{self.qid}" if self.qid else None,
            "file": self.file,
            "file_page_url": (
                f"https://commons.wikimedia.org/wiki/File:{quote(self.file)}" if self.file else None
            ),
            "image_url": self.image_url,
            "license": self.license,
            "license_url": self.license_url,
            "author": self.author,
            "credit": f"Photo: {self.author or 'unknown author'}, {self.license} via Wikimedia Commons",
        }


_session_lock = threading.Lock()
_session: Optional[requests.Session] = None
_last_request = 0.0


def _http() -> requests.Session:
    global _session
    if _session is None:
        s = requests.Session()
        s.headers.update({
            "User-Agent": (
                f"CS2MetaEngine/1.2 ({settings.liquipedia_contact}) "
                "player-photo lookup; python-requests"
            ),
            "Accept-Encoding": "gzip",
        })
        _session = s
    return _session


def _get(url: str, params: dict) -> dict:
    """Serial, gently paced GET returning JSON."""
    global _last_request
    with _session_lock:
        wait = MIN_INTERVAL_S - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            r = _http().get(url, params={**params, "format": "json", "maxlag": 5}, timeout=20)
        finally:
            _last_request = time.time()
    if r.status_code != 200:
        raise WikimediaError(f"HTTP {r.status_code} from {urlparse(url).hostname}")
    data = r.json()
    if "error" in data:
        raise WikimediaError(str(data["error"].get("info") or data["error"])[:200])
    return data


def _strip_html(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip() or None


def license_ok(short_name: Optional[str]) -> bool:
    if not short_name:
        return False
    return bool(_ALLOWED.match(short_name.strip())) and not _DISALLOWED.search(short_name)


def choose_entity(nick: str, entities: dict) -> Optional[str]:
    """Pick the item whose label or alias is exactly `nick` (case-insensitive),
    preferring a Counter-Strike / esports description."""
    want = nick.casefold()
    exact = []
    for qid, ent in entities.items():
        names = {v["value"].casefold() for v in (ent.get("labels") or {}).values()}
        for aliases in (ent.get("aliases") or {}).values():
            names.update(a["value"].casefold() for a in aliases)
        if want in names:
            desc = " ".join(d["value"] for d in (ent.get("descriptions") or {}).values())
            exact.append((bool(_CS_HINT.search(desc)), "P18" in (ent.get("claims") or {}), qid))
    if not exact:
        return None
    exact.sort(reverse=True)
    best = exact[0]
    # Ambiguous: several exact matches and none says Counter-Strike.
    if len(exact) > 1 and not best[0]:
        return None
    return best[2]


def _cache_path(nick: str) -> Path:
    safe = re.sub(r"[^a-z0-9_.-]", "_", nick.casefold())[:80]
    return CACHE_DIR / f"{safe}.json"


def lookup(nick: str) -> PhotoRef:
    """Find an openly licensed Commons photo for a player nickname."""
    path = _cache_path(nick)
    try:
        if time.time() - path.stat().st_mtime < CACHE_TTL_S:
            return PhotoRef(**json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        pass
    ref = _lookup_uncached(nick)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(ref)), encoding="utf-8")
    except OSError:
        pass
    return ref


def _lookup_uncached(nick: str) -> PhotoRef:
    found = _get(WIKIDATA_API, {
        "action": "query", "list": "search", "srlimit": 5,
        "srsearch": f'"{nick}" haswbstatement:P106={PROFESSIONAL_GAMER}',
    })
    qids = [h["title"] for h in found.get("query", {}).get("search", [])]
    if not qids:
        return PhotoRef("missing", "not on Wikidata as a professional gamer")
    ents = _get(WIKIDATA_API, {
        "action": "wbgetentities", "ids": "|".join(qids),
        "props": "labels|aliases|descriptions|claims", "languages": "en|mul",
    }).get("entities", {})
    qid = choose_entity(nick, ents)
    if not qid:
        return PhotoRef("missing", "no unambiguous Wikidata match")
    p18 = (ents[qid].get("claims") or {}).get("P18") or []
    if not p18:
        return PhotoRef("missing", "Wikidata item has no image", qid=qid)
    file = p18[0]["mainsnak"]["datavalue"]["value"]
    info = _get(COMMONS_API, {
        "action": "query", "prop": "imageinfo", "titles": f"File:{file}",
        "iiprop": "url|extmetadata", "iiurlwidth": THUMB_WIDTH,
    })
    page = next(iter(info.get("query", {}).get("pages", {}).values()), {})
    ii = (page.get("imageinfo") or [{}])[0]
    md = ii.get("extmetadata") or {}
    lic = _strip_html((md.get("LicenseShortName") or {}).get("value"))
    if not license_ok(lic):
        return PhotoRef("missing", f"license not reusable: {lic}", qid=qid, file=file, license=lic)
    return PhotoRef(
        "ok", qid=qid, file=file,
        image_url=ii.get("thumburl") or ii.get("url"),
        license=lic,
        license_url=_strip_html((md.get("LicenseUrl") or {}).get("value")),
        author=_strip_html((md.get("Artist") or {}).get("value")),
    )


def fetch_image(url: str) -> Tuple[int, str, bytes]:
    """Download a Commons image (only from upload.wikimedia.org)."""
    if urlparse(url).hostname != "upload.wikimedia.org":
        raise ValueError(f"refusing non-Commons image URL: {url}")
    global _last_request
    with _session_lock:
        wait = MIN_INTERVAL_S - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            r = _http().get(url, timeout=30)
        finally:
            _last_request = time.time()
    return r.status_code, r.headers.get("content-type", ""), r.content
