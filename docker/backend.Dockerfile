# syntax=docker/dockerfile:1

# ---- build stage: install pinned deps into a self-contained venv -----------
FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.lock .
RUN pip install -r requirements.lock

# fail the build early if the Rust-backed parser wheel didn't install cleanly
RUN python -c "import demoparser2, awpy, pandas, sklearn, curl_cffi"

# ---- runtime stage ----------------------------------------------------------
FROM python:3.12-slim

# unrar (Debian non-free) + 7z: hltv_scraper shells out to whichever it finds
# on PATH to unpack HLTV .rar demo archives; unrar is the one that reliably
# handles RAR5
RUN sed -i 's/Components: main/Components: main contrib non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends unrar p7zip-full \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 app

WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY backend/ backend/

# runtime state dirs — the compose file mounts named volumes over these, and
# Docker copies this ownership onto each volume on first use
RUN mkdir -p data/timelines demos backend/data/player_photos \
    && chown -R app:app /app

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"]

# exactly one worker: HLTV/FACEIT ingest and photo-warming run as in-process
# asyncio tasks whose status lives in module globals the UI polls — a second
# worker would answer those polls with empty state
CMD ["uvicorn", "backend.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
