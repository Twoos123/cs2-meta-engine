"""
Test isolation: the backend resolves data/, demos/ and the SQLite DB relative
to the working directory, and reads settings when `backend.config` is first
imported. The autouse fixture below points everything at a throwaway
directory before any test imports `backend.main`.
"""
import os
import shutil
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session", autouse=True)
def tmp_root():
    tmp = Path(tempfile.mkdtemp(prefix="cs2-tests-"))
    (tmp / "demos").mkdir()
    old_cwd = os.getcwd()
    os.chdir(tmp)
    os.environ.update(
        DEMO_DIR=str(tmp / "demos"),
        DB_PATH=str(tmp / "data" / "lineups.db"),
        ADMIN_TOKEN="",
        ANTHROPIC_API_KEY="",
        OPENROUTER_API_KEY="",
        DATABASE_URL="",
    )
    yield tmp
    os.chdir(old_cwd)
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture(scope="session")
def client(tmp_root):
    from fastapi.testclient import TestClient

    from backend.main import app

    with TestClient(app) as c:
        yield c
