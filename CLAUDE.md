# CS2 Meta-Analysis Engine

## Stack
- **Backend**: FastAPI + demoparser2 (Rust-backed) + SQLite + Anthropic SDK
- **Frontend**: React 18 + Vite + Tailwind CSS (custom HUD theme)
- **No React Router** — view switching via state in Dashboard.tsx (`view: "grid" | "picker" | "replay"`)

## How to run
```bash
# Backend
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev
```

## Project structure
```
backend/
  main.py              — all FastAPI endpoints
  config.py            — Settings (env vars, paths, API keys)
  models/schemas.py    — Pydantic models (LineupCluster, ExecuteCombo, Timeline, etc.)
  analysis/
    clustering.py      — bucket-based lineup deduplication (NOT DBSCAN)
    metrics.py         — pipeline orchestrator + SQLite persistence
    executes.py        — execute combo detection (coordinated utility)
    callouts.py        — map callout polygon/origin lookup
  ingestion/
    demo_parser.py     — demoparser2 wrapper, parse_directory + extract_match_timeline
    hltv_scraper.py    — HLTV match scraper + demo downloader
  rcon/bridge.py       — RCON teleport for in-game practice
  data/
    radars/            — awpy radar PNGs + map-data.json calibration
    callouts/          — per-map callout JSON
    lineup_data.db     — SQLite (lineup_clusters + execute_combos tables)

frontend/src/
  api/client.ts        — typed API client (axios)
  components/
    Dashboard.tsx      — main view, all state management
    LineupCard.tsx     — individual lineup card with Copy/Replay/Practice/AI Describe
    RadarView.tsx      — radar overlay modal with filter controls
    ScatterPlot.tsx    — win rate vs throw count scatter
    MatchReplayViewer.tsx — full 2D match replay (SVG, requestAnimationFrame)
    DemoPickerPage.tsx — demo upload/browse for match replay
    IngestPanel.tsx    — HLTV ingest controls
```

## Key patterns
- Lineup clustering uses **bucket-based deduplication** by (throw_x, throw_y, throw_z, pitch, yaw) rounded to POS_BUCKET=75u / ANG_BUCKET=6deg
- cluster_id in the frontend = SQLite auto-increment `id`, NOT the sequential bucket index
- All CSS uses custom `hud-panel`, `hud-btn`, `hud-btn-primary`, `hud-corner`, `hud-tab` classes
- Color tokens: `cs2-accent` (cyan), `cs2-green`, `cs2-red`, `cs2-blue`, `cs2-muted`, `cs2-border`
- Grenade trails in MatchReplayViewer use entity ID recycling detection (split on tick gaps > 192)
- Timeline JSON cached to `data/timelines/{demo}.json` — delete cache to force re-parse

## Environment
- ANTHROPIC_API_KEY — required for AI recap and AI lineup descriptions
- Demo files go in `demos/` directory (configurable via DEMO_DIR env var)
- RCON needs CS2 running with `-netconport 27015` and `rcon_password`
