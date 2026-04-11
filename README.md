# CS2 Meta Engine

Mines pro CS2 demos from HLTV, extracts every grenade throw, buckets the
identical lineups, ranks them by round-win-rate × utility damage, and drops
them on a HUD-styled dashboard you can filter, group, and practice from.

Every lineup also carries its throw *technique* (stand / walk / run / jump /
running-jump / crouch) and *click type* (left / right / both) — recovered by
looking up the player's button state 8 ticks before the `grenade_thrown`
event, so you know exactly how the pros threw it.

<img width="1801" height="1184" alt="image" src="https://github.com/user-attachments/assets/c25576d0-0159-4ba6-a404-74a2b93c429c" />

## What's in the box

**Backend** (FastAPI + demoparser2 + SQLite)

- `backend/ingestion/hltv_scraper.py` — scrapes HLTV match pages, downloads
  the demo archive (RAR or tar.gz), and extracts the `.dem` with live
  progress logging so a 900 MB BO5 never looks hung.
- `backend/ingestion/demo_parser.py` — uses Rust-backed **demoparser2** to
  pull `grenade_thrown`, `round_end`, player `velocity_X/Y/Z`, `ducking`,
  `is_walking`, and `buttons` fields. Does a second `parse_ticks` pass at
  `tick - 8` per throw to recover the attack buttons before they were
  released.
- `backend/analysis/clustering.py` — bucket-based dedup: any two throws that
  share the same `(map, type, landing_bucket_50u, throw_bucket_50u,
  yaw_bucket_3°, pitch_bucket_3°)` collapse into one lineup. A throw-yaw
  unit-vector average handles the 360°→0° wrap. Also tags each cluster with
  the most common throw technique + click type and their agreement ratios.
- `backend/analysis/metrics.py` — computes `impact_score = round_win_rate ×
  log(throw_count + 1) × (1 + avg_utility_damage / 100)` and persists to
  `data/lineups.db`. A small migration loop adds columns in place so older
  DBs keep working.
- `backend/analysis/callouts.py` — nearest-origin callout lookup loaded from
  `backend/data/callouts/*.json` (extracted from CS2Callouts).
- `backend/main.py` — FastAPI app with endpoints for lineups, callouts,
  radar images, ingest triggers, demos-on-disk listing, and RCON practice.

**Frontend** (React + Vite + Tailwind, HUD theme)

- `Dashboard.tsx` — map/grenade picker, scatter chart, ingest panel, and a
  grouped or flat grid of lineup cards. Grouping buckets lineups by the
  callout *nearest to where the grenade lands* (not where it was thrown
  from) so "B Site smokes" contains every lineup that covers B.
- `ScatterPlot.tsx` — Usage vs Win Rate. Dot size = utility damage, dot
  color = grenade type.
- `LineupCard.tsx` — rank, win rate, utility damage, technique + click
  badges, "Copy Console" (dumps a paste-ready `setpos/setang/give` string)
  and "Practice in Game" (same thing over RCON).
- `RadarView.tsx` — modal overlay that draws every visible lineup on the
  awpy radar PNG with throw→land dashed lines, color-coded by grenade type,
  with toggleable callout labels.

## How a lineup is defined

Instead of DBSCAN on landing coordinates (previous version), the engine
now buckets throws along **six** dimensions:

| Dimension             | Bucket size |
| --------------------- | ----------- |
| landing `(x, y)`      | 50 units    |
| throw position `(x, y)` | 50 units  |
| yaw                   | 3°          |
| pitch                 | 3°          |

Two throws hash to the same bucket only if the player stood in the same
spot and aimed at the same spot. This kills near-duplicates without
collapsing genuinely different lineups that happen to land near each other.

A lineup is kept only if:

- `throw_count ≥ 2` (at least two pro reproductions)
- `round_win_rate ≥ 0.5`

Techniques are classified per-throw from velocity and duck state:

```
|vel_z| > 10                       → jump        (≈ airborne)
|vel_z| > 10 and horiz > 200       → running_jump
ducking or duck_amount > 0.5       → crouch
is_walking flag                    → walk
horiz > 200                        → run
otherwise                          → stand
```

Click type comes from the Source button bitmask, with `IN_ATTACK = bit 0`
and `IN_ATTACK2 = bit 11`. Because the attack button is usually already
released by the time `grenade_thrown` fires, the parser re-queries
`parse_ticks(["buttons"])` at `tick − 8` for the same player and falls
back to the throw-tick bitmask only if the earlier lookup is 0.

## Quick start

### Prerequisites
- Python 3.10+
- Node.js 18+
- WinRAR installed and on `PATH` (or 7-Zip/`tar.exe`) — required to unpack
  HLTV `.rar` demo archives
- (Optional) CS2 launched with `-netconport 27015` for in-game practice

### Install
```bat
install.bat
```
This creates a Python venv, installs backend deps, and runs
`npm install` in `frontend/`.

### Configure (optional)
Edit `.env` in the repo root:
```
RCON_PASSWORD=changeme
DEMOS_DIR=demos
DB_PATH=data/lineups.db
MIN_WIN_RATE=0.5
MIN_THROW_COUNT=2
```

### Run
```bat
run_backend.bat     # FastAPI on http://localhost:8000
run_frontend.bat    # Vite on http://localhost:5173
```

### Ingest demos
1. Open `http://localhost:5173`
2. Click **Ingest** in the header
3. Pick a team/event/map, set match count
4. Click **Fetch + Analyse** — the status line streams through download,
   extract, parse, cluster, and persist

A typical BO5 is ~900 MB compressed → ~300 MB uncompressed per map; expect
30–60 s extract per match and 1–2 min to parse. Progress is logged every
10 MB for both download and extraction.

## API

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET`  | `/api/lineups/{map}/{type}?limit=N` | Ranked lineups for a map + grenade type |
| `GET`  | `/api/lineups/{map}?limit=N`        | All grenade types for a map |
| `GET`  | `/api/maps`                         | Maps with analysed data |
| `GET`  | `/api/demos`                        | Demos currently on disk, grouped by map |
| `GET`  | `/api/callouts/{map}`               | Callout origins for a map |
| `GET`  | `/api/radars/{map}`                 | Radar calibration `{pos_x, pos_y, scale}` |
| `GET`  | `/api/radars/{map}.png`             | Radar PNG (1024×1024) |
| `GET`  | `/api/console/{cluster_id}?map_name=` | Console paste string |
| `POST` | `/api/practice`                     | RCON teleport + give grenade |
| `POST` | `/api/ingest/hltv`                  | Queue an HLTV scrape + pipeline run |
| `POST` | `/api/ingest/run`                   | Re-run the pipeline on existing demos |
| `GET`  | `/api/ingest/status`                | Poll pipeline progress |
| `DELETE` | `/api/data`                       | Wipe `lineups.db` (demos on disk are kept) |
| `GET`  | `/api/stats`                        | Totals summary |

Interactive docs at `http://localhost:8000/docs`.

## Practicing a lineup

Each card exposes two actions:

- **Copy Console** → copies a single-line
  `setpos X Y Z; setang P Y 0; give weapon_smokegrenade` string. Paste it
  into the CS2 console. No RCON required.
- **Practice in Game** → sends those same commands over RCON. Requires
  CS2 launched with `-netconport 27015` and `rcon_password` set to match
  your `.env`.

`sv_cheats 1` must be on for `setpos`/`setang` to work.

## Project layout

```
cs2tool/
├── backend/
│   ├── analysis/         clustering, callouts, metrics
│   ├── data/callouts/    per-map callout JSONs
│   ├── data/radars/      awpy radar PNGs + calibration JSONs
│   ├── ingestion/        hltv_scraper, demo_parser
│   ├── models/           pydantic schemas
│   ├── rcon/             aiorcon bridge
│   └── main.py           FastAPI app
├── frontend/
│   └── src/
│       ├── api/client.ts     typed Axios client
│       └── components/       Dashboard, ScatterPlot, LineupCard, RadarView, IngestPanel
├── scripts/              one-off probes + callout extractor
├── demos/                .dem files (gitignored)
├── data/                 SQLite DB (gitignored)
├── install.bat
├── run_backend.bat
├── run_frontend.bat
└── requirements.txt
```

## Credits

- **demoparser2** — Rust-based CS2 demo parser (LaihoE)
- **awpy** — radar assets + calibration data
- **CS2Callouts** — `env_cs_place` origin extraction
- **HLTV.org** — match + demo sourcing

---

This is a research/educational project. Use it on demos you have the right
to analyse, and respect HLTV's rate limits.
