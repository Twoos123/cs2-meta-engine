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
        FACEIT_API_KEY="",
        # TEST_DATABASE_URL=postgresql://... runs the whole suite on Postgres
        # (CI does this against a service container); default is SQLite.
        DATABASE_URL=os.environ.get("TEST_DATABASE_URL", ""),
    )
    # Test modules may import backend.config during collection — before this
    # fixture — which builds `settings` from the repo's real .env. Re-read it
    # now (cwd is the temp dir, so no .env) and update the shared instance.
    from backend import config

    fresh = config.Settings()
    for field in type(fresh).model_fields:
        setattr(config.settings, field, getattr(fresh, field))
    yield tmp
    os.chdir(old_cwd)
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture(scope="session")
def client(tmp_root):
    from fastapi.testclient import TestClient

    from backend.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _no_wikimedia_network(monkeypatch):
    """Tests never call Wikidata/Commons; tests that need them patch these."""
    from backend.ingestion import wikimedia

    def offline(*_a, **_k):
        raise wikimedia.WikimediaError("network disabled in tests")

    monkeypatch.setattr(wikimedia, "_get", offline)
    monkeypatch.setattr(wikimedia, "fetch_image", offline)
    monkeypatch.setattr(wikimedia, "CACHE_DIR", wikimedia.Path("data/wikimedia-test"))
