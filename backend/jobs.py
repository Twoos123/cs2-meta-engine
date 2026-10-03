"""
Database-backed job queue.

Long work (HLTV/FACEIT ingest, lineup pipeline runs, …) is enqueued as a row
in `jobs` and executed by a worker. Because the queue and each job's
progress live in the database, any number of API replicas can enqueue and
report status, while one worker process does the heavy lifting.

Process roles (`settings.process_role`):
  all     API + an in-process worker (local dev / single container)
  api     API only — enqueues, never executes
  worker  `python -m backend.worker` — executes jobs, runs background loops

Jobs in the same `grp` run one at a time (e.g. every ingest kind shares the
"ingest" group, matching the old single asyncio lock). Claiming is atomic:
`FOR UPDATE SKIP LOCKED` on Postgres, a single UPDATE … RETURNING under
SQLite's write lock otherwise.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import threading
import time
from typing import Any, Awaitable, Callable, Optional

from backend import db

logger = logging.getLogger(__name__)

Handler = Callable[[int, dict], Awaitable[Any]]
_HANDLERS: dict[str, tuple[str, Handler]] = {}

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"
STALE_AFTER_S = 15 * 60  # a running job with no heartbeat for this long is dead

# Set to stop worker loops in this process from claiming new jobs (tests use
# it to exercise claim() directly; also handy when debugging).
PAUSED = threading.Event()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    grp          TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'queued',
    progress     TEXT NOT NULL DEFAULT '{}',
    error        TEXT,
    worker       TEXT,
    created_at   REAL NOT NULL,
    started_at   REAL,
    heartbeat_at REAL,
    finished_at  REAL
)
"""


def init_db() -> None:
    with db.connect() as conn:
        conn.execute(_SCHEMA)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, grp, id)")


def register(kind: str, handler: Handler, *, group: str) -> None:
    """Register the coroutine that executes jobs of `kind`."""
    _HANDLERS[kind] = (group, handler)


def group_of(kind: str) -> str:
    return _HANDLERS[kind][0]


def _row(r) -> Optional[dict]:
    if r is None:
        return None
    d = dict(r)
    for k in ("payload", "progress"):
        try:
            d[k] = json.loads(d.get(k) or "{}")
        except ValueError:
            d[k] = {}
    return d


# ---------------------------------------------------------------------------
# Producer side (API)
# ---------------------------------------------------------------------------

def active(group: str) -> Optional[dict]:
    """The queued or running job in `group`, if any (oldest first)."""
    with db.connect() as conn:
        return _row(conn.execute(
            "SELECT * FROM jobs WHERE grp = ? AND status IN ('queued', 'running') "
            "ORDER BY id LIMIT 1",
            (group,),
        ).fetchone())


def enqueue(kind: str, payload: dict, *, exclusive: bool = True) -> int:
    """Queue a job and return its id. With `exclusive`, refuse when the
    group already has a queued/running job (raises `Busy`)."""
    group = group_of(kind)
    if exclusive:
        busy = active(group)
        if busy:
            raise Busy(busy)
    with db.connect() as conn:
        job_id = conn.execute(
            "INSERT INTO jobs (kind, grp, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id",
            (kind, group, json.dumps(payload), time.time()),
        ).fetchone()[0]
    logger.info("job %d queued: %s %s", job_id, kind, payload)
    return int(job_id)


class Busy(Exception):
    def __init__(self, job: dict):
        self.job = job
        prog = job.get("progress") or {}
        super().__init__(
            f"{job['kind']} job {job['id']} is {job['status']}"
            + (f": {prog.get('phase')} — {prog.get('message')}" if prog.get("phase") else "")
        )


def get(job_id: int) -> Optional[dict]:
    with db.connect() as conn:
        return _row(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())


def latest(group: str) -> Optional[dict]:
    """Running job in `group`, else the most recent one."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE grp = ? ORDER BY "
            "CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC LIMIT 1",
            (group,),
        ).fetchone()
    return _row(row)


def last_finished_id(group: str) -> int:
    with db.connect() as conn:
        r = conn.execute(
            "SELECT MAX(id) FROM jobs WHERE grp = ? AND status IN ('done', 'error')",
            (group,),
        ).fetchone()
    return int(r[0] or 0)


def recent(limit: int = 20) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [_row(r) for r in rows]


# ---------------------------------------------------------------------------
# Worker side
# ---------------------------------------------------------------------------

def update_progress(job_id: int, progress: dict) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE jobs SET progress = ?, heartbeat_at = ? WHERE id = ?",
            (json.dumps(progress, default=str), time.time(), job_id),
        )


def _finish(job_id: int, status: str, error: Optional[str] = None) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?",
            (status, error, time.time(), job_id),
        )


def claim() -> Optional[dict]:
    """Atomically take the oldest queued job whose group is idle."""
    now = time.time()
    if db.is_postgres():
        sql = (
            "UPDATE jobs SET status = 'running', worker = ?, started_at = ?, heartbeat_at = ? "
            "WHERE id = (SELECT id FROM jobs j WHERE j.status = 'queued' AND NOT EXISTS "
            "(SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.grp = j.grp) "
            "ORDER BY j.id FOR UPDATE SKIP LOCKED LIMIT 1) AND status = 'queued' RETURNING *"
        )
    else:
        sql = (
            "UPDATE jobs SET status = 'running', worker = ?, started_at = ?, heartbeat_at = ? "
            "WHERE id = (SELECT id FROM jobs j WHERE j.status = 'queued' AND NOT EXISTS "
            "(SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.grp = j.grp) "
            "ORDER BY j.id LIMIT 1) AND status = 'queued' RETURNING *"
        )
    with db.connect() as conn:
        return _row(conn.execute(sql, (WORKER_ID, now, now)).fetchone())


def reap_stale() -> int:
    """Fail running jobs whose worker stopped heartbeating (crash, redeploy)."""
    cutoff = time.time() - STALE_AFTER_S
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = 'error', error = 'worker stopped responding', "
            "finished_at = ? WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < ?",
            (time.time(), cutoff),
        )
        return cur.rowcount or 0


def reap_own_orphans() -> int:
    """At worker start: anything still 'running' under this worker id (or,
    for the single in-process worker, any running job) can't be running."""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = 'error', error = 'interrupted by restart', "
            "finished_at = ? WHERE status = 'running'",
            (time.time(),),
        )
        return cur.rowcount or 0


async def run_one(job: dict) -> None:
    kind = job["kind"]
    entry = _HANDLERS.get(kind)
    if entry is None:
        _finish(job["id"], "error", f"no handler for job kind {kind!r}")
        return
    _, handler = entry
    logger.info("job %d started: %s", job["id"], kind)
    try:
        await handler(job["id"], job.get("payload") or {})
    except asyncio.CancelledError:
        _finish(job["id"], "error", "cancelled (shutdown)")
        raise
    except Exception as exc:  # handler bugs must not kill the worker
        logger.exception("job %d failed", job["id"])
        _finish(job["id"], "error", str(exc)[:2000])
        return
    current = get(job["id"]) or {}
    if current.get("status") == "running":
        _finish(job["id"], "done")
    logger.info("job %d finished: %s", job["id"], kind)


async def worker_loop(stop: asyncio.Event, *, poll_s: float = 1.0) -> None:
    """Claim and run jobs until `stop` is set."""
    init_db()
    orphans = reap_own_orphans()
    if orphans:
        logger.warning("marked %d interrupted job(s) as failed", orphans)
    last_reap = 0.0
    while not stop.is_set():
        try:
            if time.time() - last_reap > 60:
                reap_stale()
                last_reap = time.time()
            job = None if PAUSED.is_set() else await asyncio.to_thread(claim)
        except Exception:
            logger.exception("job claim failed")
            job = None
        if job:
            await run_one(job)
            continue
        try:
            await asyncio.wait_for(stop.wait(), timeout=poll_s)
        except asyncio.TimeoutError:
            pass
