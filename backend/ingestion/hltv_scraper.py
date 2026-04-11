"""
HLTV scraper — fetches match listings and demo download links.

HLTV is protected by Cloudflare which blocks the standard `requests` user-agent
and TLS fingerprint. We use `curl_cffi` with `impersonate="chrome124"` to forge
a real Chrome TLS handshake, which HLTV accepts.

A polite delay (config.hltv_request_delay) is inserted between every request.

Usage
-----
    from backend.ingestion.hltv_scraper import HLTVScraper

    scraper = HLTVScraper()
    matches = scraper.get_matches(map_name="de_mirage", limit=20)
    for m in matches:
        path = scraper.download_demo(m, output_dir=Path("demos"))
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import zipfile
import logging
import rarfile
from pathlib import Path
from typing import List, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from backend.config import settings
from backend.models.schemas import HLTVMatch

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RAR tool auto-detection
# ---------------------------------------------------------------------------
# HLTV demos arrive as .rar archives. Python has no built-in RAR support, so
# we need an external tool. We try, in order:
#
#   1. rarfile + 7z/unrar on PATH or in common install locations
#   2. Windows built-in tar.exe (bsdtar / libarchive — handles RAR4, maybe RAR5)
#
# If nothing works, we log a clear install message.

def _find_rar_backend() -> Optional[str]:
    """
    Search for an archiver tool that can read .rar files.
    Configures rarfile.UNRAR_TOOL if a compatible one is found.
    Returns the tool path or None.
    """
    # Tools rarfile knows how to drive:
    candidates: list[str] = []

    # PATH lookups
    for name in ("unrar", "unrar.exe", "7z", "7z.exe", "7za", "7za.exe"):
        p = shutil.which(name)
        if p and p not in candidates:
            candidates.append(p)

    # Common Windows install paths
    for path in (
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
        r"C:\Program Files\WinRAR\UnRAR.exe",
        r"C:\Program Files (x86)\WinRAR\UnRAR.exe",
    ):
        if os.path.exists(path) and path not in candidates:
            candidates.append(path)

    for path in candidates:
        rarfile.UNRAR_TOOL = path
        try:
            # Ask rarfile to self-test the tool by probing its version
            rarfile.tool_setup(force=True)
            logger.info("RAR backend: %s", path)
            return path
        except Exception as exc:
            logger.debug("RAR tool %s rejected: %s", path, exc)

    return None


_RAR_BACKEND = _find_rar_backend()


def _extract_rar_via_windows_tar(
    archive_path: Path, target_dir: Path
) -> list[Path]:
    """
    Fallback extractor using C:\\Windows\\System32\\tar.exe (bsdtar).
    Windows 10 1803+ ships libarchive-based tar which can read RAR4 archives.

    Returns a list of extracted .dem file paths (empty on failure).
    """
    tar_exe = Path(r"C:\Windows\System32\tar.exe")
    if not tar_exe.exists():
        return []

    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [str(tar_exe), "-xf", str(archive_path), "-C", str(target_dir)],
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0:
            logger.debug("Windows tar failed: %s", result.stderr.strip())
            return []
    except Exception as exc:
        logger.debug("Windows tar exception: %s", exc)
        return []

    return sorted(target_dir.rglob("*.dem"))


class _TempExtractDir:
    """
    Context manager that creates a temp extraction directory next to the
    archive (so we stay on the same filesystem — fast renames, large disk).
    Cleans up on exit regardless of success.
    """

    def __init__(self, archive_path: Path) -> None:
        self._dir = archive_path.parent / f"{archive_path.stem}.extract"

    def __enter__(self) -> Path:
        if self._dir.exists():
            shutil.rmtree(self._dir, ignore_errors=True)
        self._dir.mkdir(parents=True, exist_ok=True)
        return self._dir

    def __exit__(self, exc_type, exc, tb) -> None:
        shutil.rmtree(self._dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Map-name normalisation
# ---------------------------------------------------------------------------
# HLTV displays maps as "Mirage" / "Dust2" / etc. — we accept either form.
MAP_ALIASES = {
    "de_mirage": "mirage",
    "de_dust2": "dust2",
    "de_inferno": "inferno",
    "de_nuke": "nuke",
    "de_ancient": "ancient",
    "de_anubis": "anubis",
    "de_vertigo": "vertigo",
    "de_overpass": "overpass",
    "de_train": "train",
}


def _normalize_map(name: str) -> str:
    """de_mirage / Mirage / mirage → 'mirage'"""
    n = name.lower().strip()
    return MAP_ALIASES.get(n, n.replace("de_", ""))


def _probe_dem_map(dem_path: Path) -> Optional[str]:
    """
    Read a .dem file's header and return its map name (e.g. 'de_mirage').
    Used as a fallback when archive filename conventions don't encode the map.
    """
    try:
        from demoparser2 import DemoParser as _DP
        parser = _DP(str(dem_path))
        header = parser.parse_header()
        if isinstance(header, dict):
            return header.get("map_name") or header.get("map")
    except Exception as exc:
        logger.debug("Header probe failed for %s: %s", dem_path.name, exc)
    return None


class HLTVScraper:
    """
    Thin wrapper around HLTV's public pages for fetching demo links.
    Uses curl_cffi to bypass Cloudflare's bot detection.
    """

    def __init__(self) -> None:
        try:
            from curl_cffi import requests as cffi_requests
        except ImportError as exc:
            raise RuntimeError(
                "curl_cffi is required to scrape HLTV.  Install it with:\n"
                "    pip install curl_cffi"
            ) from exc

        self._cffi = cffi_requests
        self._session = cffi_requests.Session(impersonate="chrome124")
        self._session.headers.update(
            {
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": settings.hltv_base_url,
            }
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get(self, url: str) -> BeautifulSoup:
        """GET a page and return a BeautifulSoup object. Respects rate-limit."""
        time.sleep(settings.hltv_request_delay)
        logger.debug("GET %s", url)
        resp = self._session.get(url, timeout=30)
        if resp.status_code != 200:
            logger.error("HLTV returned %d for %s", resp.status_code, url)
            resp.raise_for_status()
        return BeautifulSoup(resp.text, "lxml")

    def _absolute(self, path: str) -> str:
        return urljoin(settings.hltv_base_url, path)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_matches(
        self,
        *,
        team_name: Optional[str] = None,
        event_name: Optional[str] = None,
        map_name: Optional[str] = None,
        limit: int = 10,
        skip_match_ids: Optional[set] = None,
    ) -> List[HLTVMatch]:
        """
        Return up to `limit` recent completed matches, optionally filtered.

        Parameters
        ----------
        team_name : str, optional
            Case-insensitive substring filter on team names.
        event_name : str, optional
            Case-insensitive substring filter on event name.
        map_name : str, optional
            e.g. "de_mirage" / "Mirage" / "mirage" — all accepted.
            Only matches that include this map will be returned.
        limit : int
            Maximum number of results.
        skip_match_ids : set[int], optional
            Match IDs to skip entirely — used by the ingest task to pass the
            set of demos already cached on disk so the scraper searches past
            them and returns `limit` brand-new matches instead of repeatedly
            rediscovering the cache.
        """
        normalized_map = _normalize_map(map_name) if map_name else None
        skip_ids: set = skip_match_ids or set()

        collected: List[HLTVMatch] = []
        offset = 0
        pages_checked = 0
        # Narrow filters (e.g. team + map) can burn hundreds of results per
        # hit, so the cap has to be generous. 50 pages = 5000 HLTV results,
        # roughly the last 2 months of tier-1 play.
        MAX_PAGES = 50

        while len(collected) < limit and pages_checked < MAX_PAGES:
            url = self._absolute(f"/results?offset={offset}")
            try:
                soup = self._get(url)
            except Exception as exc:
                logger.error("Failed to fetch %s: %s", url, exc)
                break

            result_divs = soup.select("div.result-con")
            if not result_divs:
                logger.info("No more results at offset=%d", offset)
                break

            logger.info(
                "Scanning %d matches at offset=%d (collected %d/%d)",
                len(result_divs),
                offset,
                len(collected),
                limit,
            )

            for div in result_divs:
                if len(collected) >= limit:
                    break

                try:
                    match = self._parse_result_div(div)
                except Exception as exc:
                    logger.warning("Could not parse result div: %s", exc)
                    continue

                if match is None:
                    continue

                # Skip already-cached match IDs so each ingest click brings
                # back brand-new matches — otherwise the scraper keeps
                # re-surfacing the same few results and the caller sees a
                # suspiciously empty pipeline run.
                if match.match_id in skip_ids:
                    continue

                # Cheap filters first (don't hit the match page yet)
                if team_name and team_name.lower() not in (
                    match.team1.lower() + " " + match.team2.lower()
                ):
                    continue
                if event_name and event_name.lower() not in match.event.lower():
                    continue

                # Expensive filter: must fetch match page to see maps + demo link
                logger.info(
                    "  → fetching match page %d (%s vs %s)",
                    match.match_id, match.team1, match.team2,
                )
                enriched = self._enrich_with_maps_and_demo(match)
                if enriched is None:
                    logger.info("    match page fetch failed — skipping")
                    continue

                logger.info(
                    "    maps on page: %s | per-map demos: %s",
                    enriched.maps_played or "[]",
                    sorted(enriched.match.demo_urls.keys()) or "[none]",
                )

                if normalized_map:
                    map_list_norm = [_normalize_map(m) for m in enriched.maps_played]
                    if normalized_map not in map_list_norm:
                        logger.info(
                            "    %s not played in this match — skipping",
                            normalized_map,
                        )
                        continue

                if not enriched.match.demo_url:
                    logger.debug("No demo link for match %d — skipping", match.match_id)
                    continue

                logger.info(
                    "  ✓ %s vs %s (%s) — demo available",
                    match.team1,
                    match.team2,
                    match.event,
                )
                collected.append(enriched.match)

            offset += 100
            pages_checked += 1

        return collected[:limit]

    def get_demo_link(self, match: HLTVMatch) -> Optional[str]:
        """Fetch (or refresh) the demo download link for a match."""
        match_url = self._absolute(f"/matches/{match.match_id}/-")
        try:
            soup = self._get(match_url)
        except Exception as exc:
            logger.error("Could not fetch match page %d: %s", match.match_id, exc)
            return None

        fallback, _ = self._extract_demo_links(soup)
        return fallback

    def download_demo(
        self,
        match: HLTVMatch,
        output_dir: Path,
        *,
        skip_existing: bool = True,
        prefer_map: Optional[str] = None,
    ) -> Optional[Path]:
        """
        Download the demo archive for `match` into `output_dir` and extract
        the .dem inside — preferring the one matching `prefer_map` if set.

        HLTV BO3/BO5 archives contain one .dem per map. Without a hint we'd
        pick the first (usually map 1), which is often *not* the map the user
        filtered for — causing off-map lineups to end up labeled as the
        requested map. Passing `prefer_map="de_mirage"` tells the extractor
        to select the .dem whose filename contains "mirage".

        The download is streamed in 1 MiB chunks straight to a .tmp file
        (so we never hold the full archive in memory — important because BO5
        demos can exceed 1 GB). Progress is logged every 10 MB.

        Archives larger than `settings.max_demo_size_mb` are skipped so we don't
        accidentally pull a 2 GB file from an HLTV BO5 final.

        Returns the .dem file path or None on failure.
        """
        output_dir.mkdir(parents=True, exist_ok=True)

        token = _normalize_map(prefer_map) if prefer_map else None

        # If the match page had per-map download buttons and we know which
        # map the caller wants, use that link directly. Otherwise fall back
        # to whichever single demo_url was collected during enrichment.
        demo_url: Optional[str] = None
        if token and match.demo_urls:
            demo_url = match.demo_urls.get(token)
            if demo_url:
                logger.info(
                    "  Using per-map download link for %s (match %d)",
                    token, match.match_id,
                )
        if not demo_url:
            demo_url = match.demo_url or self.get_demo_link(match)
        if not demo_url:
            logger.warning("No demo URL for match %d", match.match_id)
            return None

        # Suffix the saved filename with the map token so we don't collide
        # with a different map from the same BO3/5 match. Without this,
        # re-ingesting a different map just returns the cached wrong-map
        # .dem because skip_existing sees the unsuffixed file.
        filename = f"{match.match_id}_{token}.dem" if token else f"{match.match_id}.dem"
        dest = output_dir / filename

        if skip_existing and dest.exists():
            logger.info("Demo already exists: %s", dest)
            return dest

        time.sleep(settings.hltv_request_delay)
        archive_path = output_dir / f"{match.match_id}.archive.tmp"

        try:
            resp = self._session.get(
                demo_url,
                timeout=600,         # 10 min for huge downloads
                stream=True,
                allow_redirects=True,
            )
            resp.raise_for_status()

            total = int(resp.headers.get("content-length", 0))
            total_mb = total / (1024 * 1024) if total else 0

            if total_mb and total_mb > settings.max_demo_size_mb:
                logger.warning(
                    "Skipping match %d — archive is %.0f MB (> %d MB limit). "
                    "Bump MAX_DEMO_SIZE_MB in .env to allow it.",
                    match.match_id, total_mb, settings.max_demo_size_mb,
                )
                resp.close()
                return None

            logger.info(
                "Downloading match %d — %.0f MB …", match.match_id, total_mb
            )

            downloaded = 0
            next_log_at = 10 * 1024 * 1024  # log every 10 MB
            with open(archive_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=settings.download_chunk_size):
                    if not chunk:
                        continue
                    f.write(chunk)
                    downloaded += len(chunk)
                    if downloaded >= next_log_at:
                        pct = (downloaded / total * 100) if total else 0
                        logger.info(
                            "    %d MB / %d MB (%.0f%%)",
                            downloaded // (1024 * 1024),
                            int(total_mb),
                            pct,
                        )
                        next_log_at += 10 * 1024 * 1024

            resp.close()
            logger.info(
                "  Download complete — %.1f MB written to tmp",
                downloaded / (1024 * 1024),
            )
        except Exception as exc:
            logger.error("Download failed for match %d: %s", match.match_id, exc)
            if archive_path.exists():
                archive_path.unlink(missing_ok=True)
            return None

        # Extract the .dem from the archive on disk. When a prefer_map hint
        # is set we pick the file whose name contains that map, so BO3/BO5
        # archives return the correct map instead of whichever was listed
        # first.
        try:
            extracted = self._extract_first_dem_from_path(
                archive_path, prefer_map=prefer_map
            )
        finally:
            archive_path.unlink(missing_ok=True)

        if extracted is None:
            logger.error(
                "Could not find a .dem file inside archive for match %d",
                match.match_id,
            )
            return None

        dest.write_bytes(extracted)
        logger.info(
            "Saved demo → %s (%.1f MB)", dest, len(extracted) / (1024 * 1024)
        )

        # Sidecar roster file — lets the pipeline filter throws by player name
        # when the user passes team_name=… to /api/ingest/hltv.
        if match.team1_players or match.team2_players:
            roster_path = output_dir / f"{match.match_id}.roster.json"
            try:
                roster_path.write_text(
                    json.dumps(
                        {
                            "match_id": match.match_id,
                            "team1": {
                                "name": match.team1,
                                "players": list(match.team1_players),
                            },
                            "team2": {
                                "name": match.team2,
                                "players": list(match.team2_players),
                            },
                        },
                        indent=2,
                    ),
                    encoding="utf-8",
                )
            except Exception as exc:
                logger.warning("Could not write roster sidecar for %d: %s", match.match_id, exc)

        return dest

    # ------------------------------------------------------------------
    # Private parsing helpers
    # ------------------------------------------------------------------

    def _parse_result_div(self, div) -> Optional[HLTVMatch]:
        """Parse a single result-con div into an HLTVMatch."""
        a_tag = div.select_one("a.a-reset")
        if not a_tag:
            return None

        href = a_tag.get("href", "")
        match_id_match = re.search(r"/matches/(\d+)/", href)
        if not match_id_match:
            return None
        match_id = int(match_id_match.group(1))

        teams = div.select(".team")
        team1 = teams[0].get_text(strip=True) if len(teams) > 0 else "Team1"
        team2 = teams[1].get_text(strip=True) if len(teams) > 1 else "Team2"

        event_tag = div.select_one(".event-name")
        event = event_tag.get_text(strip=True) if event_tag else "Unknown Event"

        return HLTVMatch(
            match_id=match_id,
            team1=team1,
            team2=team2,
            event=event,
        )

    class _EnrichedMatch:
        """Local container to return both the enriched match and its map list."""

        def __init__(self, match: HLTVMatch, maps_played: List[str]) -> None:
            self.match = match
            self.maps_played = maps_played

    def _enrich_with_maps_and_demo(
        self, match: HLTVMatch
    ) -> Optional["HLTVScraper._EnrichedMatch"]:
        """Fetch the match page to collect maps played + demo link + rosters."""
        match_url = self._absolute(f"/matches/{match.match_id}/-")
        try:
            soup = self._get(match_url)
        except Exception as exc:
            logger.warning("Could not fetch match page %d: %s", match.match_id, exc)
            return None

        # Maps played — HLTV shows each map in a .mapname element
        maps = [m.get_text(strip=True) for m in soup.select(".mapname")]
        maps = [m for m in maps if m and m.lower() != "tbd"]

        demo_url, demo_urls = self._extract_demo_links(soup)
        if demo_urls:
            logger.debug(
                "  per-map demo links for %d: %s",
                match.match_id, sorted(demo_urls.keys()),
            )

        team1_players, team2_players = self._extract_rosters(soup)
        if team1_players or team2_players:
            logger.debug(
                "  rosters: %s=%s, %s=%s",
                match.team1, team1_players, match.team2, team2_players,
            )

        enriched = match.model_copy(
            update={
                "map": maps[0] if maps else None,
                "demo_url": demo_url,
                "demo_urls": demo_urls,
                "team1_players": team1_players,
                "team2_players": team2_players,
            }
        )
        return HLTVScraper._EnrichedMatch(enriched, maps)

    def _extract_rosters(
        self, soup: BeautifulSoup
    ) -> tuple[List[str], List[str]]:
        """
        Pull the two team rosters from an HLTV match page.

        HLTV has reorganized the match page markup several times, so we try a
        handful of selectors before giving up. Each returns two lists parallel
        to (match.team1, match.team2). On failure, both lists are empty —
        the caller treats that as "no filter" and keeps every player.
        """
        selector_groups = [
            ("div.lineup.standard-box", "a.flagAlign, .player a, .player"),
            ("div.teamPlayers",         "a, .player"),
            ("table.lineup",            "a.player-compare, td a"),
            ("#all-teams .players",     "a"),
        ]

        for container_sel, player_sel in selector_groups:
            containers = soup.select(container_sel)
            if len(containers) < 2:
                continue

            def _players_from(container) -> List[str]:
                names: List[str] = []
                for el in container.select(player_sel):
                    name = el.get_text(strip=True)
                    if not name or name.lower() in {"tbd", ""}:
                        continue
                    if name not in names:
                        names.append(name)
                    if len(names) >= 5:
                        break
                return names

            t1 = _players_from(containers[0])
            t2 = _players_from(containers[1])
            if t1 and t2:
                return t1, t2

        return [], []

    def _extract_demo_links(
        self, soup: BeautifulSoup
    ) -> tuple[Optional[str], dict[str, str]]:
        """
        Find GOTV demo download links on a match page.

        HLTV BO3/5 pages often have one download button per map (e.g. one link
        for Mirage, another for Nuke). We collect all `/download/demo/\\d+`
        links and try to tag each with its map by inspecting the surrounding
        DOM context — looking for a map name token ("mirage", "nuke", …) in
        the link text, title attribute, or the ancestor container.

        Returns (fallback_url, map_links) where:
          - `fallback_url` is the first demo link on the page (series archive
            or the first per-map download, preserving old behavior).
          - `map_links` is {normalized_map_token: absolute_url} for every link
            we could tag to a specific map. May be empty.
        """
        # Collect every candidate link in document order.
        candidates: list = []
        for a in soup.select("a[href]"):
            href = a.get("href", "")
            if re.search(r"/download/demo/\d+", href):
                candidates.append(a)

        # Legacy fallback — links that end with an archive extension.
        if not candidates:
            for a in soup.select("a[href]"):
                href = a.get("href", "")
                if "demo" in href.lower() and (
                    "getdemo" in href.lower()
                    or href.endswith((".rar", ".zip", ".dem"))
                ):
                    candidates.append(a)

        if not candidates:
            return None, {}

        map_tokens = {
            "mirage", "dust2", "inferno", "nuke", "ancient",
            "anubis", "vertigo", "overpass", "train", "cache", "cobblestone",
        }

        def _tag_link(a) -> Optional[str]:
            """Try to identify which map this demo link downloads for."""
            # 1) Text on the link itself
            texts: list[str] = []
            link_text = (a.get_text(" ", strip=True) or "").lower()
            if link_text:
                texts.append(link_text)
            for attr in ("title", "data-original-title", "aria-label"):
                val = a.get(attr) or ""
                if val:
                    texts.append(val.lower())

            # 2) Walk up to 4 ancestors and collect their text — the download
            #    button is usually inside a per-map section (e.g. a card with
            #    the map name). Keeps the search scoped to avoid grabbing
            #    other map names elsewhere on the page.
            node = a
            for _ in range(4):
                node = node.parent
                if node is None:
                    break
                if hasattr(node, "get_text"):
                    texts.append(node.get_text(" ", strip=True).lower()[:500])

            blob = " ".join(texts)
            for token in map_tokens:
                if re.search(rf"\b{re.escape(token)}\b", blob):
                    return token
            return None

        fallback_url = self._absolute(candidates[0].get("href", ""))
        map_links: dict[str, str] = {}
        for a in candidates:
            token = _tag_link(a)
            if token and token not in map_links:
                map_links[token] = self._absolute(a.get("href", ""))

        return fallback_url, map_links

    def _extract_first_dem_from_path(
        self,
        archive_path: Path,
        *,
        prefer_map: Optional[str] = None,
    ) -> Optional[bytes]:
        """
        Try to read a .dem file out of an archive on disk.
        Tries, in order: ZIP → rarfile with auto-detected backend →
        Windows tar.exe (bsdtar) → raw .dem passthrough.

        When `prefer_map` is given (e.g. "de_mirage"), the extractor picks
        the .dem whose filename contains the normalized map token ("mirage")
        so BO3/BO5 archives return the correct map.
        """
        map_token = _normalize_map(prefer_map) if prefer_map else None

        def _pick(names: list[str]) -> Optional[str]:
            """Pick the best-matching .dem from a list of archive filenames."""
            if not names:
                return None
            if map_token:
                for n in names:
                    if map_token in Path(n).name.lower():
                        return n
                # No filename match and (for ZIP) no cheap header-probe path —
                # discard rather than save a mislabeled demo.
                logger.warning(
                    "  no .dem in archive matches %s — discarding archive",
                    map_token,
                )
                return None
            return names[0]

        # --- try ZIP (stdlib, always works) ---
        try:
            with zipfile.ZipFile(archive_path) as zf:
                dem_names = [n for n in zf.namelist() if n.endswith(".dem")]
                chosen = _pick(dem_names)
                if chosen:
                    logger.info("  Extracting from ZIP → %s", chosen)
                    return zf.read(chosen)
        except zipfile.BadZipFile:
            pass
        except Exception as exc:
            logger.debug("ZIP extract failed: %s", exc)

        # --- try RAR via rarfile (needs 7z / unrar) ---
        # We extract to a real temp file (instead of streaming via an in-memory
        # pipe) so a background thread can poll the growing file and emit
        # progress lines. UnRAR.exe is single-threaded and CPU-bound on large
        # BO5 demos — without this the log looks frozen for 30–120 seconds.
        if _RAR_BACKEND:
            try:
                with rarfile.RarFile(archive_path) as rf:
                    dem_infos = [i for i in rf.infolist() if i.filename.endswith(".dem")]
                    if not dem_infos:
                        dem_infos = []

                    # Fast path: pick by filename substring match.
                    target = None
                    if dem_infos and map_token:
                        for info in dem_infos:
                            if map_token in Path(info.filename).name.lower():
                                target = info
                                break

                    def _extract_with_progress(
                        info, verify_token: Optional[str]
                    ) -> Optional[bytes]:
                        total_bytes = info.file_size or 0
                        logger.info(
                            "  Extracting from RAR → %s (%.0f MB uncompressed)",
                            info.filename,
                            total_bytes / (1024 * 1024),
                        )
                        with _TempExtractDir(archive_path) as tmp_dir:
                            out_path = tmp_dir / Path(info.filename).name
                            stop = threading.Event()

                            def _tick() -> None:
                                next_log_at = 10 * 1024 * 1024
                                while not stop.wait(1.0):
                                    try:
                                        size = out_path.stat().st_size
                                    except FileNotFoundError:
                                        continue
                                    if size >= next_log_at:
                                        pct = (size / total_bytes * 100) if total_bytes else 0
                                        logger.info(
                                            "    extracted %d MB / %d MB (%.0f%%)",
                                            size // (1024 * 1024),
                                            total_bytes // (1024 * 1024),
                                            pct,
                                        )
                                        next_log_at = (
                                            (size // (10 * 1024 * 1024)) + 1
                                        ) * 10 * 1024 * 1024

                            ticker = threading.Thread(target=_tick, daemon=True)
                            ticker.start()
                            try:
                                rf.extract(info, path=tmp_dir)
                            finally:
                                stop.set()
                                ticker.join(timeout=2)

                            extracted_file = next(tmp_dir.rglob("*.dem"), None)
                            if extracted_file is None:
                                return None
                            if verify_token:
                                actual = _probe_dem_map(extracted_file)
                                if actual and _normalize_map(actual) != verify_token:
                                    logger.info(
                                        "  %s is %s — not %s, discarding",
                                        info.filename, actual, verify_token,
                                    )
                                    return None
                            data = extracted_file.read_bytes()
                            logger.info(
                                "  Extraction complete — %.1f MB",
                                len(data) / (1024 * 1024),
                            )
                            return data

                    # If filename-match picked a candidate, try it first.
                    if target is not None:
                        data = _extract_with_progress(target, map_token)
                        if data is not None:
                            return data

                    # Header-based fallback: extract each remaining .dem one
                    # at a time and keep whichever one's header says it is
                    # the requested map. Needed when HLTV archives don't
                    # encode the map in the .dem filename.
                    if map_token and dem_infos:
                        logger.info(
                            "  Filename match for %s missed — probing %d demo header(s)",
                            map_token, len(dem_infos),
                        )
                        for info in dem_infos:
                            if info is target:
                                continue
                            data = _extract_with_progress(info, map_token)
                            if data is not None:
                                return data
                        logger.warning(
                            "  no .dem in RAR had header map=%s — discarding archive",
                            map_token,
                        )
                        return None

                    # No map preference (map_token is None): take the first .dem.
                    if dem_infos:
                        data = _extract_with_progress(dem_infos[0], None)
                        if data is not None:
                            return data
            except rarfile.NotRarFile:
                pass
            except Exception as exc:
                logger.warning("rarfile extraction failed: %s", exc)

        # --- fallback: Windows tar.exe (libarchive, handles RAR4) ---
        logger.info("  Extracting via Windows tar → %s", archive_path.name)
        with _TempExtractDir(archive_path) as tmp_dir:
            dems = _extract_rar_via_windows_tar(archive_path, tmp_dir)
            if dems:
                chosen_path: Optional[Path] = None
                # Fast path: filename substring match.
                if map_token:
                    for p in dems:
                        if map_token in p.name.lower():
                            chosen_path = p
                            break
                # Header-based fallback: all files are already on disk,
                # so probing is cheap compared to the RAR case.
                if chosen_path is None and map_token:
                    logger.info(
                        "  Filename match for %s missed — probing %d demo header(s)",
                        map_token, len(dems),
                    )
                    for p in dems:
                        actual = _probe_dem_map(p)
                        if actual and _normalize_map(actual) == map_token:
                            chosen_path = p
                            break
                    if chosen_path is None:
                        logger.warning(
                            "  no .dem in tar output matched %s — discarding archive",
                            map_token,
                        )
                        return None
                if chosen_path is None:
                    chosen_path = dems[0]
                logger.info(
                    "  Windows tar extracted %d .dem file(s) → %s",
                    len(dems),
                    chosen_path.name,
                )
                return chosen_path.read_bytes()

        # --- maybe it IS a raw .dem (rare but possible) ---
        try:
            with open(archive_path, "rb") as f:
                head = f.read(8)
                if head == b"HL2DEMO\0":
                    logger.info("  Raw .dem file (no archive)")
                    f.seek(0)
                    return f.read()
        except Exception:
            pass

        logger.error(
            "\n"
            "┌─────────────────────────────────────────────────────────────┐\n"
            "│ Could not extract .dem from archive.                        │\n"
            "│                                                             │\n"
            "│ The archive is likely RAR5, which Windows tar.exe cannot    │\n"
            "│ read. Install 7-Zip to enable full RAR support:             │\n"
            "│                                                             │\n"
            "│    https://www.7-zip.org/download.html                      │\n"
            "│                                                             │\n"
            "│ After install, restart the backend — auto-detection will    │\n"
            "│ pick up 7z.exe from Program Files.                          │\n"
            "└─────────────────────────────────────────────────────────────┘"
        )
        return None
