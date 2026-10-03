"""Database-backed job queue (backend/jobs.py)."""
import asyncio
import threading
import time

import pytest

from backend import jobs


@pytest.fixture()
def q(tmp_root):
    jobs.init_db()
    from backend import db

    with db.connect() as conn:
        conn.execute("DELETE FROM jobs WHERE kind LIKE 'test_%'")
    ran: list = []

    async def ok(job_id, payload):
        ran.append((job_id, payload))
        jobs.update_progress(job_id, {"phase": "working"})

    async def boom(job_id, payload):
        raise ValueError("nope")

    jobs.register("test_ok", ok, group="test_a")
    jobs.register("test_ok_b", ok, group="test_b")
    jobs.register("test_boom", boom, group="test_c")
    return ran


def _drain():
    """Run every claimable job once."""
    async def go():
        while True:
            job = jobs.claim()
            if not job:
                return
            await jobs.run_one(job)
    asyncio.run(go())


def test_enqueue_runs_and_records_progress(q):
    jid = jobs.enqueue("test_ok", {"x": 1})
    assert jobs.get(jid)["status"] == "queued"
    _drain()
    job = jobs.get(jid)
    assert job["status"] == "done"
    assert job["progress"] == {"phase": "working"}
    assert q == [(jid, {"x": 1})]


def test_exclusive_group_rejects_second(q):
    jobs.enqueue("test_ok", {})
    with pytest.raises(jobs.Busy):
        jobs.enqueue("test_ok", {})
    # other groups are independent
    jobs.enqueue("test_ok_b", {})
    _drain()


def test_group_runs_one_at_a_time(q):
    a = jobs.enqueue("test_ok", {"n": 1}, exclusive=False)
    b = jobs.enqueue("test_ok", {"n": 2}, exclusive=False)
    first = jobs.claim()
    assert first["id"] == a
    assert jobs.claim() is None          # b waits: group test_a is busy
    asyncio.run(jobs.run_one(first))
    assert jobs.claim()["id"] == b


def test_failure_marks_error(q):
    jid = jobs.enqueue("test_boom", {})
    _drain()
    job = jobs.get(jid)
    assert job["status"] == "error" and "nope" in job["error"]


def test_concurrent_claims_never_double_assign(q):
    ids = {jobs.enqueue(k, {}, exclusive=False) for k in ("test_ok", "test_ok_b", "test_boom")}
    got, lock = [], threading.Lock()

    def worker():
        for _ in range(5):
            job = jobs.claim()
            if job:
                with lock:
                    got.append(job["id"])

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(got) == sorted(ids)   # each job claimed exactly once


def test_ingest_endpoint_runs_through_queue(client):
    r = client.post("/api/ingest/run", json={"map_name": "de_mirage"})
    assert r.status_code == 200
    run_id = r.json()["run_id"]
    deadline = time.time() + 20
    while time.time() < deadline:
        st = client.get("/api/ingest/status").json()
        if st["last_completed_run_id"] >= run_id:
            break
        time.sleep(0.2)
    assert st["last_completed_run_id"] >= run_id
    assert st["status"] == "ready"
    assert jobs.get(run_id)["status"] in ("done", "error")
