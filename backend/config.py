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

    # Anthropic (Claude) API for match-replay AI insights
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-4-6"

    # OpenRouter free API (used when anthropic_api_key is not set)
    openrouter_api_key: str = ""
    openrouter_model: str = "google/gemma-3-27b-it:free"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # Database — set DATABASE_URL for Supabase/PostgreSQL; leave empty for SQLite
    database_url: str = ""

    # CS2 replay integration
    cs2_game_dir: str = ""           # e.g. C:/Program Files (x86)/Steam/.../game/csgo
    cs2_demo_link_name: str = "cs2tool_demos"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
