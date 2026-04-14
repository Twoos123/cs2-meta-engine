"""
FACEIT Data API v4 client.

Uses the official Data API (requires a server-side key from developers.faceit.com).
Demo download attempts a direct GET on the signed URL returned in match details;
if that fails (pending Downloads API approval), the caller falls back to opening
the URL in the user's browser so their logged-in FACEIT session can download it.
"""
from __future__ import annotations

import gzip
import logging
import re
import shutil
from pathlib import Path
from typing import List, Optional

import requests
import zstandard

from backend.config import settings
from backend.models.schemas import FaceitMatchEntry

logger = logging.getLogger(__name__)


# Map FACEIT map names → CS2 internal tokens used elsewhere in the codebase.
# FACEIT reports names like "de_mirage" directly for most pools; keep as-is.
def _normalize_map(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    raw = raw.strip().lower()
    if raw.startswith("de_"):
        return raw
    return f"de_{raw}"


class FaceitScraperError(Exception):
    pass


class FaceitScraper:
    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key or settings.faceit_api_key
        if not self.api_key:
            raise FaceitScraperError(
                "FACEIT_API_KEY not set. Add it to your .env file."
            )
        self.base = settings.faceit_base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.api_key}"})

    # ---- URL parsing ------------------------------------------------------

    @staticmethod
    def extract_nickname(faceit_url: str) -> str:
        """Pull the nickname out of any FACEIT profile URL variant."""
        m = re.search(r"/players/([^/?#]+)", faceit_url.strip())
        if not m:
            raise FaceitScraperError(
                f"Could not extract a nickname from '{faceit_url}'. "
                "Expected something like https://www.faceit.com/en/players/<nick>."
            )
        return m.group(1)

    # ---- Data API calls ---------------------------------------------------

    def get_player(self, nickname: str) -> dict:
        r = self.session.get(
            f"{self.base}/players",
            params={"nickname": nickname, "game": "cs2"},
            timeout=15,
        )
        if r.status_code == 404:
            raise FaceitScraperError(f"Player '{nickname}' not found on FACEIT.")
        r.raise_for_status()
        return r.json()

    def get_match_history(self, player_id: str, limit: int = 30) -> List[dict]:
        r = self.session.get(
            f"{self.base}/players/{player_id}/history",
            params={"game": "cs2", "limit": min(max(limit, 1), 100), "offset": 0},
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("items", []) or []

    def get_match_details(self, match_id: str) -> dict:
        r = self.session.get(f"{self.base}/matches/{match_id}", timeout=15)
        if r.status_code == 404:
            raise FaceitScraperError(f"Match '{match_id}' not found.")
        r.raise_for_status()
        return r.json()

    # ---- Flattening -------------------------------------------------------

    def list_matches(self, faceit_url: str, limit: int = 30) -> tuple[dict, List[FaceitMatchEntry]]:
        """
        Resolve a FACEIT profile URL → (player dict, up to `limit` match entries).
        """
        nickname = self.extract_nickname(faceit_url)
        player = self.get_player(nickname)
        player_id = player.get("player_id")
        if not player_id:
            raise FaceitScraperError(f"No player_id returned for '{nickname}'.")

        raw = self.get_match_history(player_id, limit=limit)
        entries: List[FaceitMatchEntry] = []
        for item in raw:
            teams = item.get("teams") or {}
            f1 = teams.get("faction1") or {}
            f2 = teams.get("faction2") or {}
            results = item.get("results") or {}
            score = results.get("score") or {}

            # FACEIT history items carry map under several possible shapes
            # depending on game mode — none are guaranteed.
            map_raw = None
            voting = item.get("voting") or {}
            pick = voting.get("map", {}).get("pick") or []
            if isinstance(pick, list) and pick:
                map_raw = pick[0]

            entries.append(
                FaceitMatchEntry(
                    match_id=str(item.get("match_id") or ""),
                    map_name=_normalize_map(map_raw),
                    team1_name=str(f1.get("nickname") or f1.get("name") or "Team 1"),
                    team2_name=str(f2.get("nickname") or f2.get("name") or "Team 2"),
                    team1_score=score.get("faction1"),
                    team2_score=score.get("faction2"),
                    winner=results.get("winner"),
                    finished_at=item.get("finished_at"),
                    status=item.get("status"),
                    faceit_url=item.get("faceit_url"),
                )
            )
        return player, entries

    # ---- Demo download ----------------------------------------------------

    def resolve_demo(self, match_id: str) -> tuple[str, Optional[str]]:
        """
        Returns (demo_url, normalized_map_token) for a given match.
        Raises if match details have no demo_url array.
        """
        details = self.get_match_details(match_id)
        demo_urls = details.get("demo_url") or []
        if not isinstance(demo_urls, list) or not demo_urls:
            raise FaceitScraperError(
                f"Match {match_id} has no demo_url (the match may still be "
                "in progress, or demos were never uploaded)."
            )
        demo_url = str(demo_urls[0])

        map_token: Optional[str] = None
        voting = details.get("voting") or {}
        pick = voting.get("map", {}).get("pick") or []
        if isinstance(pick, list) and pick:
            map_token = _normalize_map(pick[0])

        return demo_url, map_token

    def try_download_demo(self, demo_url: str, dest: Path) -> bool:
        """
        Attempt a direct GET on FACEIT's signed demo URL.
        Returns True if the .dem was written to `dest`, False otherwise.

        FACEIT ships demos as either `.dem.gz` (older) or `.dem.zst` (current)
        — we sniff the URL path to pick the decompressor. When the Downloads
        API scope is not yet granted, a plain GET typically returns 401/403
        and we return False so the caller can fall back to a manual browser
        download.
        """
        path_only = demo_url.split("?", 1)[0].lower()
        if path_only.endswith(".zst"):
            ext, decompress = ".zst", _decompress_zstd
        elif path_only.endswith(".gz"):
            ext, decompress = ".gz", _decompress_gzip
        else:
            logger.warning(
                "FACEIT demo URL has unknown compression suffix: %s", path_only,
            )
            return False

        blob_path = dest.with_suffix(dest.suffix + ext)
        try:
            with self.session.get(demo_url, stream=True, timeout=120) as r:
                if r.status_code != 200:
                    logger.warning(
                        "FACEIT demo direct-download returned HTTP %s for %s",
                        r.status_code, path_only,
                    )
                    return False
                blob_path.parent.mkdir(parents=True, exist_ok=True)
                with open(blob_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
        except Exception as exc:
            logger.warning("FACEIT demo direct-download failed: %s", exc)
            blob_path.unlink(missing_ok=True)
            return False

        try:
            decompress(blob_path, dest)
        except Exception as exc:
            logger.warning("FACEIT demo decompress (%s) failed: %s", ext, exc)
            blob_path.unlink(missing_ok=True)
            dest.unlink(missing_ok=True)
            return False
        finally:
            blob_path.unlink(missing_ok=True)

        return True


def _decompress_gzip(src: Path, dest: Path) -> None:
    with gzip.open(src, "rb") as src_f, open(dest, "wb") as out:
        shutil.copyfileobj(src_f, out)


def _decompress_zstd(src: Path, dest: Path) -> None:
    dctx = zstandard.ZstdDecompressor()
    with open(src, "rb") as src_f, open(dest, "wb") as out:
        dctx.copy_stream(src_f, out)
