"""
Central configuration — loaded from .env or environment variables.
Copy .env.example to .env and fill in your values.
"""
from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # Directories
    demo_dir: Path = Path("demos")
    db_path: Path = Path("data/lineups.db")

    # RCON (local CS2 server)
    rcon_host: str = "127.0.0.1"
    rcon_port: int = 27015
    rcon_password: str = "changeme"

    # HLTV scraping
    hltv_base_url: str = "https://www.hltv.org"
    hltv_request_delay: float = 2.5   # seconds between requests (be polite)
    hltv_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )

    # Download limits (HLTV BO5 demos can be 1+ GB)
    max_demo_size_mb: int = 2000       # skip archives larger than this
    download_chunk_size: int = 1024 * 1024  # 1 MiB streaming chunks

    # API
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    # FACEIT Data API v4
    faceit_api_key: str = ""
    faceit_base_url: str = "https://open.faceit.com/data/v4"
    # Downloads API (needs separate approval on the same key)
    faceit_downloads_url: str = "https://open.faceit.com/download/v2/demos/download"

    # Anthropic (Claude) API for match-replay AI insights
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5-5"

    # When set, destructive endpoints (deletes, uploads, CS2 path settings)
    # require a matching X-Admin-Token header. Leave empty for local dev.
    admin_token: str = ""

    # OpenRouter free API (used when anthropic_api_key is not set)
    openrouter_api_key: str = ""
    openrouter_model: str = "google/gemma-3-27b-it:free"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # HLTV match catalog (tournaments/matches browser)
    catalog_refresh_pages: int = 2          # /results pages per refresh (100 matches each)
    catalog_autopull: bool = False          # HLTV blocks server-side demo downloads — no-op
    catalog_autopull_min_stars: int = 2     # HLTV star rating threshold
    catalog_autopull_event_regex: str = (
        r"major|iem|esl pro league|blast premier|pgl|katowice|cologne"
    )
    demo_retention_gb: float = 50.0         # FIFO cap on the demos volume

    # ── Liquipedia (backend/ingestion/liquipedia.py: match catalog + player photos) ──
    # Free MediaWiki API, used under https://liquipedia.net/api-terms-of-use.
    # The contact goes in the User-Agent — a URL or a project address, never
    # a personal email by default.
    liquipedia_contact: str = "https://github.com/Twoos123/cs2-meta-engine"
    liquipedia_wiki: str = "counterstrike"
    liquipedia_cache_dir: Path = Path("data/liquipedia")
    # LiquipediaDB (api.liquipedia.net) key — optional; unused until set.
    liquipedia_api_key: str = ""
    # Catalog refresh: tournament pages parsed per run for maps + HLTV links
    # (each is an action=parse, so ≥30 s apart) and which tiers qualify.
    liquipedia_max_tournament_parses: int = 3
    liquipedia_enrich_tiers: str = "S,A"
    # HLTV as a secondary player-photo source (blocked by Cloudflare today).
    photo_hltv_fallback: bool = False

    # Database — set DATABASE_URL for Supabase/PostgreSQL; leave empty for SQLite
    database_url: str = ""

    # CS2 replay integration
    cs2_game_dir: str = ""           # e.g. C:/Program Files (x86)/Steam/.../game/csgo
    cs2_demo_link_name: str = "cs2tool_demos"

    # ── Demo auto-import (backend/api/imports.py, backend/ingestion/importer.py) ──
    # Folder watcher + archive uploads + HLTV browser-extension hand-off.
    # Watched folders and on/off switches live in the imports_settings table.
    import_inbox_dir: Path = Path("data/inbox")      # always-available drop folder
    import_tmp_dir: Path = Path("data/import_tmp")   # archive extraction scratch
    import_scan_interval_s: float = 15.0             # watcher poll interval
    import_settle_s: float = 10.0                    # ignore files modified more recently
    import_watch_autostart: bool = True              # start the watcher with the app
    import_hltv_handoff_minutes: float = 15.0        # watcher leaves fresh archives to the extension

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
