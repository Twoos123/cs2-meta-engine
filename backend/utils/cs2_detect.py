"""
Auto-detect CS2 install path by reading Steam's registry key and library
folder config.  Works on Windows; returns None on other platforms.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Relative path from a Steam library root to CS2's game/csgo directory
_CS2_REL = (
    Path("steamapps")
    / "common"
    / "Counter-Strike Global Offensive"
    / "game"
    / "csgo"
)


def detect_cs2_game_dir() -> Optional[Path]:
    """Return the CS2 ``game/csgo`` directory, or *None* if not found."""
    if sys.platform != "win32":
        return None

    steam_path = _read_steam_path()
    if steam_path is None:
        return None

    candidates = [steam_path]
    candidates.extend(_parse_library_folders(steam_path))

    for lib in candidates:
        cs2_dir = lib / _CS2_REL
        if cs2_dir.is_dir():
            logger.info("Detected CS2 game dir: %s", cs2_dir)
            return cs2_dir

    logger.info("CS2 game dir not found in %d Steam libraries", len(candidates))
    return None


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------

def _read_steam_path() -> Optional[Path]:
    """Read the Steam install path from the Windows registry."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
        value, _ = winreg.QueryValueEx(key, "SteamPath")
        winreg.CloseKey(key)
        p = Path(str(value))
        if p.is_dir():
            return p
    except Exception as exc:
        logger.debug("Steam registry lookup failed: %s", exc)
    return None


def _parse_library_folders(steam_path: Path) -> list[Path]:
    """Parse ``steamapps/libraryfolders.vdf`` for additional library paths."""
    vdf = steam_path / "steamapps" / "libraryfolders.vdf"
    if not vdf.exists():
        return []

    paths: list[Path] = []
    try:
        for line in vdf.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if '"path"' in stripped:
                parts = stripped.split('"')
                if len(parts) >= 4:
                    p = Path(parts[3].replace("\\\\", "\\"))
                    if p.is_dir() and p != steam_path:
                        paths.append(p)
    except Exception as exc:
        logger.debug("Failed to parse libraryfolders.vdf: %s", exc)

    return paths
