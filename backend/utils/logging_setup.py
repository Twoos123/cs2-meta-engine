"""
Centralised logging configuration — colorised, readable, and verbose by
default so the terminal acts as a live feed of what the app is doing.

Main.py calls `install_logging()` once at startup; module-level
`logging.getLogger(__name__)` handles in the rest of the codebase are
unchanged.

Features:
- `LOG_LEVEL=DEBUG` env var bumps every logger to DEBUG without touching
  individual `getLogger` calls.
- Short module names (`ingestion.demo_parser` instead of
  `backend.ingestion.demo_parser`) so lines fit comfortably at 120 cols.
- ANSI-colored level tags (red/yellow/green/cyan/dim) on TTYs; plain
  output when stdout is piped to a file.
- Noisy 3rd-party loggers (uvicorn.access, httpx, urllib3) are pinned at
  WARNING so they don't drown out the app's own lifecycle events.
"""
from __future__ import annotations

import logging
import os
import sys


# ANSI colour codes — matched to logging levels. Values chosen to be
# readable on both dark and light terminal themes.
_COLORS = {
    "DEBUG":    "\033[2;36m",      # dim cyan
    "INFO":     "\033[32m",        # green
    "WARNING":  "\033[33m",        # yellow
    "ERROR":    "\033[31m",        # red
    "CRITICAL": "\033[1;41;97m",   # bold white-on-red
}
_DIM = "\033[2m"
_BOLD = "\033[1m"
_RESET = "\033[0m"


class _ColorFormatter(logging.Formatter):
    """Pretty console formatter.

    Output shape:
        12:34:56.789  [INFO   ]  ingestion.demo_parser  — parsing navi-vs-faze.dem

    The level tag is padded to 7 chars (max of DEBUG/INFO/WARNING/ERROR/
    CRITICAL) so the message column always aligns regardless of level.
    """

    _LEVEL_WIDTH = 7

    def __init__(self, use_color: bool):
        super().__init__()
        self.use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        # Trim the leading "backend." off so lines don't waste column
        # budget on a prefix that's the same on every record.
        name = record.name
        if name.startswith("backend."):
            name = name[len("backend."):]

        level_tag = record.levelname.ljust(self._LEVEL_WIDTH)
        ts = self.formatTime(record, datefmt="%H:%M:%S")
        msec = int(record.msecs)

        base = record.getMessage()
        if record.exc_info:
            base = f"{base}\n{self.formatException(record.exc_info)}"

        if self.use_color:
            color = _COLORS.get(record.levelname, "")
            return (
                f"{_DIM}{ts}.{msec:03d}{_RESET}  "
                f"{color}[{level_tag}]{_RESET}  "
                f"{_BOLD}{name}{_RESET}  — {base}"
            )
        return f"{ts}.{msec:03d}  [{level_tag}]  {name}  — {base}"


def _resolve_level() -> int:
    """Read LOG_LEVEL from env; default INFO. Accepts numeric or names."""
    raw = os.environ.get("LOG_LEVEL", "").strip()
    if not raw:
        return logging.INFO
    if raw.isdigit():
        return int(raw)
    return logging.getLevelName(raw.upper()) if raw else logging.INFO


def install_logging() -> None:
    """Configure the root logger and tame noisy 3rd-party loggers.

    Safe to call multiple times — it replaces any existing root handlers
    rather than appending, so reloader-induced double-configuration
    (uvicorn --reload) doesn't produce duplicate log lines.
    """
    level = _resolve_level()

    # Stdout is a TTY when run directly; False when uvicorn's launcher
    # pipes output. Colours would leak as literal escape codes into log
    # files, so detect carefully.
    use_color = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

    # Windows consoles default to cp1252 and choke on Unicode box-drawing
    # or em-dashes in log messages. Reconfigure stdout to UTF-8 when the
    # stream supports it (Python 3.7+); fall back to ASCII replacement
    # otherwise so logging never raises UnicodeEncodeError mid-run.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_ColorFormatter(use_color=use_color))

    root = logging.getLogger()
    root.setLevel(level)
    # Wipe any prior handlers (basicConfig from an earlier import, etc.)
    # — keeping them would double every log line.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)

    # Dampen 3rd-party chatter that would drown out app lifecycle lines.
    for noisy in (
        "uvicorn.access",   # per-request stub — our own middleware logs these
        "httpx",            # verbose request/response framing
        "httpcore",
        "urllib3",
        "asyncio",
        "multipart.multipart",
    ):
        logging.getLogger(noisy).setLevel(logging.WARNING)
