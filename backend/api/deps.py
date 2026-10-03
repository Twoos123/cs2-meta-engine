"""
Shared dependencies for API routers.

Routers import from here instead of from `backend.main` (which imports the
routers — that would be circular). Anything that needs a main.py helper at
request time should import it lazily inside the handler.
"""
from __future__ import annotations

import hmac
from typing import Optional

from fastapi import Depends, Header, HTTPException

from backend.analysis.player_stats import PlayerStatsStore
from backend.config import settings

# Open when ADMIN_TOKEN is unset (local dev); otherwise destructive routes
# need a matching X-Admin-Token header. The frontend prompts on 401.
ADMIN_REQUIRED_DETAIL = "admin token required"


async def require_admin(x_admin_token: Optional[str] = Header(default=None)) -> None:
    expected = settings.admin_token
    if not expected:
        return
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=401, detail=ADMIN_REQUIRED_DETAIL)


# Use as `dependencies=ADMIN` on a route decorator.
ADMIN = [Depends(require_admin)]

# Process-wide player stats store (SQLite/Postgres-backed).
player_stats = PlayerStatsStore()
