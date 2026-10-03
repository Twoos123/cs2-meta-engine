# CS2 Meta-Analysis Engine

## Stack
- **Backend**: FastAPI + demoparser2 (Rust-backed, ≥0.42 for current CS2 builds) + SQLite locally / PostgreSQL in the cluster + Anthropic SDK
- **Frontend**: React 18 + Vite + Tailwind CSS (custom HUD theme)
- **React Router** (pages lazy-loaded in `App.tsx`) — `/` landing, `/lineups` Dashboard, `/replay` demo picker, `/replay/:file/*` replay tabs, `/anti-strat` opponent scouting, `/players` + `/players/:steamid`, `/matches` Liquipedia catalog, `/ingest` (HLTV/FACEIT/auto-import/extension tabs), `/live` GSI radar, `*` 404 page
- **Deploy**: Docker images → k3s on a Proxmox VM via `.github/workflows/deploy.yml` (tests on SQLite + a Postgres service, frontend build, Terraform validate on GitHub-hosted runners; deploy on a self-hosted runner). Cluster: postgres StatefulSet, backend ×2 (`PROCESS_ROLE=api`), worker ×1 (`python -m backend.worker`), web. IaC in `terraform/` (Proxmox VM), `terraform/cloudflare/` (tunnel + Access login), `ansible/`, `k8s/`
- **Browser extension**: `extension/` (Chrome MV3) — "Send to CS2 Meta Engine" on HLTV match pages

## How to run
```bash
# Backend
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev

# Tests / lint
pip install -r requirements-dev.txt && pytest
ruff check backend tests --select E9,F63,F7,F82,F401
cd frontend && npx tsc --noEmit
```

## Project structure
```
backend/
  main.py              — core endpoints (lineups, replay/timeline, ingest, FACEIT, settings) + app wiring
  db.py                — db.connect(): sqlite3 or Postgres (DATABASE_URL) with SQL translation
  jobs.py              — DB-backed job queue (ingest/pipeline/catalog jobs, groups, atomic claim)
  worker.py            — `python -m backend.worker`: runs jobs + background loops
  migrate_sqlite.py    — SQLite → Postgres copier (auto-runs once on worker start)
  api/deps.py          — shared ADMIN guard + player_stats store (import from here, not main)
  api/catalog.py       — /api/catalog/* (Liquipedia matches; refresh runs as a job)
  api/photos.py        — player photo proxy (Liquipedia licensed images only; 14-day refresh)
  api/players.py       — /api/players* (Rating 2.0, ADR/KAST/clutches, per-match stats)
  api/imports.py       — /api/import/* (folder watcher, archive uploads, extension hand-off)
  api/compare.py       — /api/compare/{demo} (your throws vs pro lineups)
  api/practice_lists.py — practice lists + CS2 .cfg export/install
  api/gsi.py           — CS2 Game State Integration receiver + live state/SSE
  config.py            — Settings (env vars, paths, API keys, ADMIN_TOKEN)
  models/schemas.py    — Pydantic models (LineupCluster, ExecuteCombo, MatchTimeline, DemoListEntry, etc.)
  analysis/
    clustering.py      — bucket-based lineup deduplication (NOT DBSCAN)
    metrics.py         — pipeline orchestrator + SQLite persistence
    executes.py        — execute combo detection (coordinated utility)
    callouts.py        — map callout polygon/origin lookup
    player_stats.py    — per-demo player aggregation (player_stats table)
    validation.py      — demo completeness (scoreboard final_score, MR12 + MR3 OT rules)
    compare.py         — throw-vs-pro matching and offset decomposition
  ingestion/
    demo_parser.py     — demoparser2 wrapper, parse_directory + extract_match_timeline
    hltv_scraper.py    — HLTV match scraper + demo downloader/extractor
    match_catalog.py   — match catalog storage + demo retention
    liquipedia.py      — Liquipedia MediaWiki API client (terms: UA, gzip, 2 s / 30 s-per-parse throttle, cache)
    importer.py        — .dem / archive / compressed demo import + naming + dedupe
    faceit_scraper.py  — FACEIT Data API + Downloads API (signed demo URLs)
  rcon/bridge.py       — RCON teleport for in-game practice
  data/
    radars/            — awpy radar PNGs + map-data.json calibration (also the "known maps" list)
    callouts/          — per-map callout JSON
tests/                 — pytest suite (conftest isolates data/ + demos/ in a temp dir)

frontend/src/
  api/client.ts        — typed API client (axios) + apiErrorMessage + admin-token interceptor
  components/
    AppHeader.tsx      — shared nav (mobile hamburger; `middle`/`actions` slots)
    LandingPage.tsx    — home page hub
    Dashboard.tsx      — lineup grid view, all lineup state management
    LineupCard.tsx     — lineup card with Copy/Replay/Practice/AI Describe
    RadarView.tsx      — radar overlay modal with filter controls
    MatchReplayViewer.tsx — full 2D match replay (SVG, requestAnimationFrame)
    ReplayLayout.tsx   — replay tab shell (Replay/Insights/Economy/Heatmap/Stats)
    DemoPickerPage.tsx — demo upload/browse for match replay
    AntiStratPage.tsx  — multi-demo opponent scouting (computed client-side)
    MatchesPage.tsx    — HLTV catalog browser
    Select.tsx         — accessible custom dropdown used everywhere
```

## Key patterns
- Lineup clustering uses **bucket-based deduplication** by (throw_x, throw_y, throw_z, pitch, yaw) rounded to POS_BUCKET=75u / ANG_BUCKET=6deg
- The lineup pipeline runs **per map** (`POST /api/ingest/run {"map_name": ...}`) — a map with demos but no lineups just hasn't been run
- cluster_id in the frontend = SQLite auto-increment `id`, NOT the sequential bucket index
- Unknown maps (not in radar map-data.json) / grenade types return 404; known maps with no data return empty lists
- All CSS uses custom `hud-panel`, `hud-btn`, `hud-btn-primary`, `hud-corner`, `hud-tab` classes
- Color tokens: `cs2-accent` (cyan), `cs2-green`, `cs2-red`, `cs2-blue`, `cs2-muted`, `cs2-border`
- Mobile: every page must work at 375px with no horizontal page scroll — Tailwind responsive utilities, tables in `overflow-x-auto`
- Grenade trails in MatchReplayViewer use entity ID recycling detection (split on tick gaps > 192)
- HLTV blocks server-side requests (Cloudflare 403) — never try to get around it; HLTV data arrives via the browser extension (user-initiated) and Liquipedia
- Long work = jobs: enqueue with `jobs.enqueue(kind, payload)`, register handlers with `jobs.register(kind, fn, group=...)`; status endpoints read the jobs table so API replicas agree. Background loops (folder watcher) run only when `PROCESS_ROLE` != `api`
- New DB code: `backend.db.connect()` + portable SQL (`?`, ON CONFLICT, RETURNING id, BIGINT for ms/bytes, no INSERT OR REPLACE); run the suite on Postgres with `TEST_DATABASE_URL` (e.g. via `pgserver`)
- Current CS2 demos have no `grenade_thrown` event — demo_parser rebuilds throws from projectile trajectories; replayed/pre-live rounds are dropped via `total_rounds_played`
- Timeline JSON cached to `data/timelines/{demo}.json` — delete cache to force re-parse. Completeness sidecars live in `data/timeline_meta/` (NOT in timelines/, which player-stats globs)
- Cached timelines are served as raw bytes (gzip via middleware) — don't re-add `model_validate` on the cache-hit path
- HLTV sometimes splits a map into `-p1/-p2` demos; the extractor keeps the largest part and `validation.py` flags it partial
- Player rating = HLTV Rating 1.0 formula (`_hltv_rating` in main.py), ≈1.00 average
- Destructive endpoints use `dependencies=_ADMIN` (X-Admin-Token when ADMIN_TOKEN is set)

## Environment
- ANTHROPIC_API_KEY — AI recap and AI lineup descriptions (default model `claude-opus-5-5`); OPENROUTER_API_KEY is the free fallback
- FACEIT_API_KEY — FACEIT Data API + Downloads API
- DATABASE_URL — Postgres (cluster); unset = SQLite at DB_PATH. PROCESS_ROLE — all (default) | api | worker
- ADMIN_TOKEN — optional; guards deletes/uploads/settings
- Demo files go in `demos/` directory (configurable via DEMO_DIR env var)
- RCON needs CS2 running with `-netconport 27015` and `rcon_password`
