"""
Job worker process: `python -m backend.worker`.

Runs the job queue (backend/jobs.py) plus the feature modules' background
loops (folder watcher, …) without serving HTTP. In the cluster this is a
single-replica Deployment next to N API replicas started with
PROCESS_ROLE=api.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

# Must be set before backend.main is imported: settings are read at import.
os.environ.setdefault("PROCESS_ROLE", "worker")

from backend import jobs  # noqa: E402
from backend import main as app_main  # noqa: E402  (registers job handlers)

logger = logging.getLogger("backend.worker")


async def _run() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows: rely on KeyboardInterrupt
            pass

    # First start against an empty Postgres: bring over the SQLite data
    # the app accumulated before the switch (no-op afterwards).
    try:
        from backend.migrate_sqlite import maybe_auto_migrate

        copied = await asyncio.to_thread(maybe_auto_migrate)
        if copied:
            logger.info("imported SQLite data into Postgres: %s", copied)
    except Exception:
        logger.exception("SQLite → Postgres auto-import failed; continuing")

    for mod in app_main._FEATURE_MODULES:
        hook = getattr(mod, "on_startup", None)
        if hook:
            await hook()
    logger.info("worker %s started", jobs.WORKER_ID)
    try:
        await jobs.worker_loop(stop)
    finally:
        for mod in app_main._FEATURE_MODULES:
            hook = getattr(mod, "on_shutdown", None)
            if hook:
                await hook()
        logger.info("worker %s stopped", jobs.WORKER_ID)


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
