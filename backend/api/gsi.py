"""
CS2 Game State Integration receiver + live radar state.

CS2 POSTs a JSON snapshot of the game to the `uri` listed in a
`gamestate_integration_*.cfg` file under `game/csgo/cfg/`. We keep the latest
snapshot (normalised for the radar) plus a short in-memory history, and fan
updates out to the `/live` page over Server-Sent Events.

What CS2 sends depends on what the local client is doing:
- spectating (GOTV, observing, or watching a demo): `allplayers`, `bomb`,
  `grenades` and `phase_countdowns` for everyone; `player` is whoever is
  currently being observed.
- playing: only `player` (yourself), plus `map` / `round`.

Every payload is a full snapshot. The `previously` / `added` sections only
describe what changed since the last send, so they're dropped rather than
merged.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import math
import re
import secrets
import signal
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from backend.api.deps import ADMIN
from backend.config import settings
from backend.db import connect

logger = logging.getLogger(__name__)

router = APIRouter()

CFG_FILENAME = "gamestate_integration_cs2metaengine.cfg"
DEFAULT_URI = "http://127.0.0.1:8000/api/gsi"
_TOKEN_KEY = "gsi_token"

# A payload younger than this counts as "connected". CS2 re-sends at least
# every `heartbeat` seconds (5s in our cfg) even when nothing changes.
CONNECTED_WITHIN_S = 15.0
HISTORY_LEN = 120
# SSE connections are recycled so a dev-server reload never waits on them
# for long; EventSource reconnects transparently.
SSE_MAX_LIFETIME_S = 30.0
SSE_PING_S = 10.0

_URI_RE = re.compile(r"^https?://[^\s\"'{}\\]+$")


# ---------------------------------------------------------------------------
# Pydantic models (response shapes)
# ---------------------------------------------------------------------------

class GsiPlayer(BaseModel):
    steamid: str
    name: str
    team: Optional[str] = None           # "CT" | "T" | None
    observer_slot: Optional[int] = None
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    yaw: Optional[float] = None          # degrees, 0 = +X, 90 = +Y (CS2 convention)
    hp: int = 0
    armor: int = 0
    helmet: bool = False
    defuser: bool = False
    money: Optional[int] = None
    equip_value: Optional[int] = None
    flashed: int = 0
    burning: int = 0
    round_kills: int = 0
    active_weapon: Optional[str] = None  # "ak47", "knife", ...
    weapon_type: Optional[str] = None    # "Rifle", "Pistol", ...
    ammo_clip: Optional[int] = None
    ammo_reserve: Optional[int] = None
    primary: Optional[str] = None
    secondary: Optional[str] = None
    utility: List[str] = []
    has_bomb: bool = False
    kills: Optional[int] = None
    assists: Optional[int] = None
    deaths: Optional[int] = None
    mvps: Optional[int] = None
    score: Optional[int] = None
    alive: bool = False
    observed: bool = False
    is_self: bool = False


class GsiTeam(BaseModel):
    score: int = 0
    name: Optional[str] = None
    timeouts_remaining: Optional[int] = None
    consecutive_round_losses: Optional[int] = None


class GsiBomb(BaseModel):
    state: Optional[str] = None   # carried | dropped | planting | planted | defusing | defused | exploded
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    carrier: Optional[str] = None  # steamid
    countdown: Optional[float] = None


class GsiGrenade(BaseModel):
    id: str
    type: str
    owner: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    lifetime: Optional[float] = None
    effecttime: Optional[float] = None
    flames: List[List[float]] = []


class GsiState(BaseModel):
    mode: str                       # "spectator" | "playing" | "menu"
    map: Optional[str] = None
    game_mode: Optional[str] = None
    map_phase: Optional[str] = None  # warmup | live | intermission | gameover
    round: Optional[int] = None      # 1-based current round
    round_phase: Optional[str] = None  # freezetime | live | over
    round_winner: Optional[str] = None
    phase: Optional[str] = None      # phase_countdowns.phase (falls back to round phase)
    phase_ends_in: Optional[float] = None
    ct: GsiTeam = GsiTeam()
    t: GsiTeam = GsiTeam()
    round_wins: Dict[str, str] = {}
    players: List[GsiPlayer] = []
    observed_steamid: Optional[str] = None
    self_steamid: Optional[str] = None
    bomb: Optional[GsiBomb] = None
    grenades: List[GsiGrenade] = []
    provider: Optional[Dict[str, Any]] = None
    received_at: Optional[float] = None
    seq: int = 0
    age_seconds: Optional[float] = None


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def parse_vec(value: Any) -> Optional[Tuple[float, ...]]:
    """'x, y, z' strings (what GSI sends), lists or {x,y,z} dicts → floats."""
    if value is None:
        return None
    try:
        if isinstance(value, str):
            parts = [p for p in value.replace(";", ",").split(",") if p.strip()]
            nums = tuple(float(p) for p in parts)
        elif isinstance(value, dict):
            nums = tuple(float(value[k]) for k in ("x", "y", "z") if k in value)
        elif isinstance(value, (list, tuple)):
            nums = tuple(float(v) for v in value)
        else:
            return None
    except (TypeError, ValueError):
        return None
    if not nums or any(math.isnan(n) or math.isinf(n) for n in nums):
        return None
    return nums


def yaw_from_forward(forward: Any) -> Optional[float]:
    vec = parse_vec(forward)
    if not vec or len(vec) < 2:
        return None
    fx, fy = vec[0], vec[1]
    if fx == 0 and fy == 0:
        return None
    return round(math.degrees(math.atan2(fy, fx)), 1)


def _num(value: Any, default: Optional[float] = None) -> Optional[float]:
    if value is None or value == "":
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(out) or math.isinf(out) else out


def _int(value: Any, default: Optional[int] = None) -> Optional[int]:
    out = _num(value)
    return default if out is None else int(out)


def _bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes")
    return bool(value)


def _team(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    v = value.strip().upper()
    if v in ("CT", "COUNTER-TERRORIST", "COUNTER_TERRORIST"):
        return "CT"
    if v in ("T", "TERRORIST"):
        return "T"
    return None


def _weapon_name(raw: Any) -> Optional[str]:
    if not isinstance(raw, str) or not raw:
        return None
    return raw[len("weapon_"):] if raw.startswith("weapon_") else raw


def _summarise_weapons(weapons: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "active_weapon": None, "weapon_type": None, "ammo_clip": None,
        "ammo_reserve": None, "primary": None, "secondary": None,
        "utility": [], "has_bomb": False,
    }
    if not isinstance(weapons, dict):
        return out
    # weapon_0, weapon_1, ... — keep CS2's slot order
    def _slot(key: str) -> int:
        try:
            return int(key.rsplit("_", 1)[-1])
        except ValueError:
            return 999

    for key in sorted(weapons, key=_slot):
        w = weapons.get(key)
        if not isinstance(w, dict):
            continue
        name = _weapon_name(w.get("name"))
        wtype = w.get("type")
        state = w.get("state")
        if not name:
            continue
        if name == "c4" or wtype == "C4":
            out["has_bomb"] = True
        elif wtype == "Grenade":
            count = _int(w.get("ammo_reserve"), 1) or 1
            out["utility"].extend([name] * max(1, min(count, 2)))
        elif wtype == "Pistol":
            out["secondary"] = name
        elif wtype not in ("Knife", None, "Fists", "Melee", "StackableItem", "Breach Charge", "Tablet"):
            out["primary"] = name
        if state == "active":
            out["active_weapon"] = name
            out["weapon_type"] = wtype
            out["ammo_clip"] = _int(w.get("ammo_clip"))
            out["ammo_reserve"] = _int(w.get("ammo_reserve"))
    return out


def normalise_player(steamid: str, raw: Dict[str, Any]) -> GsiPlayer:
    state = raw.get("state") if isinstance(raw.get("state"), dict) else {}
    stats = raw.get("match_stats") if isinstance(raw.get("match_stats"), dict) else {}
    pos = parse_vec(raw.get("position"))
    hp = _int(state.get("health"), 0) or 0
    return GsiPlayer(
        steamid=str(steamid),
        name=str(raw.get("name") or steamid),
        team=_team(raw.get("team")),
        observer_slot=_int(raw.get("observer_slot")),
        x=pos[0] if pos and len(pos) > 0 else None,
        y=pos[1] if pos and len(pos) > 1 else None,
        z=pos[2] if pos and len(pos) > 2 else None,
        yaw=yaw_from_forward(raw.get("forward")),
        hp=hp,
        armor=_int(state.get("armor"), 0) or 0,
        helmet=_bool(state.get("helmet")),
        defuser=_bool(state.get("defusekit")),
        money=_int(state.get("money")),
        equip_value=_int(state.get("equip_value")),
        flashed=_int(state.get("flashed"), 0) or 0,
        burning=_int(state.get("burning"), 0) or 0,
        round_kills=_int(state.get("round_kills"), 0) or 0,
        kills=_int(stats.get("kills")),
        assists=_int(stats.get("assists")),
        deaths=_int(stats.get("deaths")),
        mvps=_int(stats.get("mvps")),
        score=_int(stats.get("score")),
        alive=hp > 0,
        **_summarise_weapons(raw.get("weapons")),
    )


def _normalise_team(raw: Any) -> GsiTeam:
    if not isinstance(raw, dict):
        return GsiTeam()
    return GsiTeam(
        score=_int(raw.get("score"), 0) or 0,
        name=raw.get("name") or None,
        timeouts_remaining=_int(raw.get("timeouts_remaining")),
        consecutive_round_losses=_int(raw.get("consecutive_round_losses")),
    )


def _normalise_bomb(raw: Any) -> Optional[GsiBomb]:
    if not isinstance(raw, dict) or not raw:
        return None
    pos = parse_vec(raw.get("position"))
    return GsiBomb(
        state=raw.get("state"),
        x=pos[0] if pos else None,
        y=pos[1] if pos and len(pos) > 1 else None,
        z=pos[2] if pos and len(pos) > 2 else None,
        carrier=str(raw["player"]) if raw.get("player") not in (None, "") else None,
        countdown=_num(raw.get("countdown")),
    )


def _normalise_grenades(raw: Any) -> List[GsiGrenade]:
    if not isinstance(raw, dict):
        return []
    out: List[GsiGrenade] = []
    for gid, g in raw.items():
        if not isinstance(g, dict):
            continue
        pos = parse_vec(g.get("position"))
        flames: List[List[float]] = []
        if isinstance(g.get("flames"), dict):
            for fv in g["flames"].values():
                fp = parse_vec(fv)
                if fp and len(fp) >= 2:
                    flames.append([round(c, 1) for c in fp[:3]])
        out.append(GsiGrenade(
            id=str(gid),
            type=str(g.get("type") or "unknown"),
            owner=str(g["owner"]) if g.get("owner") not in (None, "") else None,
            x=pos[0] if pos else None,
            y=pos[1] if pos and len(pos) > 1 else None,
            z=pos[2] if pos and len(pos) > 2 else None,
            lifetime=_num(g.get("lifetime")),
            effecttime=_num(g.get("effecttime")),
            flames=flames,
        ))
    return out


def normalise(payload: Dict[str, Any]) -> GsiState:
    """Raw GSI payload → radar-friendly state. Never raises on odd input."""
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else None
    mp = payload.get("map") if isinstance(payload.get("map"), dict) else {}
    rnd = payload.get("round") if isinstance(payload.get("round"), dict) else {}
    pc = payload.get("phase_countdowns") if isinstance(payload.get("phase_countdowns"), dict) else {}
    me = payload.get("player") if isinstance(payload.get("player"), dict) else None
    allplayers = payload.get("allplayers") if isinstance(payload.get("allplayers"), dict) else None

    players: List[GsiPlayer] = []
    observed: Optional[str] = None
    self_id = str(provider["steamid"]) if provider and provider.get("steamid") else None

    if allplayers:
        mode = "spectator"
        for sid, raw in allplayers.items():
            if isinstance(raw, dict):
                players.append(normalise_player(sid, raw))
        # While spectating, `player` is whoever the camera is on.
        if me:
            observed = str(me.get("steamid") or me.get("spectarget") or "") or None
        if observed and not any(p.steamid == observed for p in players):
            observed = None
    elif me and mp:
        mode = "playing"
        sid = str(me.get("steamid") or self_id or "self")
        p = normalise_player(sid, me)
        p.is_self = True
        p.observed = True
        observed = sid
        players.append(p)
    else:
        mode = "menu"

    for p in players:
        p.observed = p.steamid == observed
        if self_id and p.steamid == self_id:
            p.is_self = True
    players.sort(key=lambda p: (
        {"CT": 0, "T": 1}.get(p.team or "", 2),
        p.observer_slot if p.observer_slot is not None else 99,
        p.name.lower(),
    ))

    map_phase = mp.get("phase")
    completed = _int(mp.get("round"))
    round_no: Optional[int] = None
    if completed is not None:
        round_no = completed if map_phase == "gameover" else completed + 1

    round_wins = mp.get("round_wins") if isinstance(mp.get("round_wins"), dict) else {}

    bomb = _normalise_bomb(payload.get("bomb"))
    # Bomb carrier is also visible from the weapon list.
    if bomb is None:
        carrier = next((p for p in players if p.has_bomb), None)
        if carrier:
            bomb = GsiBomb(state="carried", x=carrier.x, y=carrier.y, z=carrier.z, carrier=carrier.steamid)

    return GsiState(
        mode=mode,
        map=mp.get("name") or None,
        game_mode=mp.get("mode") or None,
        map_phase=map_phase,
        round=round_no,
        round_phase=rnd.get("phase"),
        round_winner=_team(rnd.get("win_team")),
        phase=pc.get("phase") or rnd.get("phase") or map_phase,
        phase_ends_in=_num(pc.get("phase_ends_in")),
        ct=_normalise_team(mp.get("team_ct")),
        t=_normalise_team(mp.get("team_t")),
        round_wins={str(k): str(v) for k, v in round_wins.items()},
        players=players,
        observed_steamid=observed,
        self_steamid=self_id,
        bomb=bomb,
        grenades=_normalise_grenades(payload.get("grenades")),
        provider={
            k: provider.get(k) for k in ("name", "appid", "version", "steamid", "timestamp")
        } if provider else None,
    )


# ---------------------------------------------------------------------------
# Token (gsi_settings table)
# ---------------------------------------------------------------------------

_token_cache: Optional[str] = None


def _db_get_token() -> str:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS gsi_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            row = conn.execute("SELECT value FROM gsi_settings WHERE key = ?", (_TOKEN_KEY,)).fetchone()
            if row and row["value"]:
                return row["value"]
            conn.execute(
                "INSERT INTO gsi_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                (_TOKEN_KEY, secrets.token_urlsafe(24)),
            )
            row = conn.execute("SELECT value FROM gsi_settings WHERE key = ?", (_TOKEN_KEY,)).fetchone()
            return row["value"]
    finally:
        conn.close()


def get_token() -> str:
    global _token_cache
    if _token_cache is None:
        _token_cache = _db_get_token()
    return _token_cache


async def _token() -> str:
    """Token without touching the DB on the event loop (cached after first use)."""
    return _token_cache if _token_cache is not None else await asyncio.to_thread(get_token)


# ---------------------------------------------------------------------------
# In-memory state store
# ---------------------------------------------------------------------------

class _Store:
    def __init__(self) -> None:
        self.state: Optional[GsiState] = None
        self.received_at: Optional[float] = None
        self.seq = 0
        self.history: Deque[GsiState] = deque(maxlen=HISTORY_LEN)
        self.rejected = 0
        self._event: Optional[asyncio.Event] = None

    def event(self) -> asyncio.Event:
        if self._event is None:
            self._event = asyncio.Event()
        return self._event

    def put(self, state: GsiState, *, seq: Optional[int] = None,
            received_at: Optional[float] = None) -> None:
        self.received_at = received_at if received_at is not None else time.time()
        # Shared mode (several API replicas) needs a sequence every replica
        # agrees on: the receive time in ms. Single-process mode keeps 1, 2, 3…
        if seq is not None:
            self.seq = seq
        elif _shared():
            self.seq = max(self.seq + 1, int(self.received_at * 1000))
        else:
            self.seq += 1
        state.seq = self.seq
        state.received_at = self.received_at
        self.state = state
        self.history.append(state)
        # Wake every SSE waiter, then hand out a fresh Event for the next update.
        ev, self._event = self._event, None
        if ev is not None:
            ev.set()

    def age(self) -> Optional[float]:
        return None if self.received_at is None else max(0.0, time.time() - self.received_at)

    def snapshot(self) -> Optional[Dict[str, Any]]:
        if self.state is None:
            return None
        data = self.state.model_dump()
        age = self.age()
        data["age_seconds"] = round(age, 3) if age is not None else None
        return data

    def reset(self) -> None:
        self.__init__()


store = _Store()


# ---------------------------------------------------------------------------
# Cross-replica sharing (PROCESS_ROLE=api runs several API pods: CS2 posts
# to one, browsers may read from another). The latest state is mirrored to
# a one-row table and pulled by readers; single-process mode skips this.
# ---------------------------------------------------------------------------

_LIVE_DDL = (
    "CREATE TABLE IF NOT EXISTS gsi_live (id INTEGER PRIMARY KEY, seq BIGINT NOT NULL, "
    "received_at REAL NOT NULL, state TEXT NOT NULL)"
)


def _shared() -> bool:
    return settings.process_role == "api"


def _publish_sync(state_json: str, seq: int, received_at: float) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO gsi_live (id, seq, received_at, state) VALUES (1, ?, ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, "
            "received_at = excluded.received_at, state = excluded.state",
            (seq, received_at, state_json),
        )


def _pull_sync() -> None:
    """Adopt the shared state if another replica received something newer."""
    with connect() as conn:
        row = conn.execute("SELECT seq, received_at, state FROM gsi_live WHERE id = 1").fetchone()
    if row is None or int(row["seq"]) <= store.seq:
        return
    store.put(GsiState.model_validate_json(row["state"]),
              seq=int(row["seq"]), received_at=float(row["received_at"]))
    ev, store._event = store._event, None
    if ev is not None:
        ev.set()


async def _pull() -> None:
    if not _shared():
        return
    try:
        await asyncio.to_thread(_pull_sync)
    except Exception as exc:  # stale beats broken
        logger.debug("GSI shared pull failed: %s", exc)


# ---------------------------------------------------------------------------
# cfg text
# ---------------------------------------------------------------------------

_DATA_COMPONENTS = (
    "provider", "map", "round", "map_round_wins", "phase_countdowns",
    "player_id", "player_state", "player_weapons", "player_match_stats", "player_position",
    "allplayers_id", "allplayers_state", "allplayers_match_stats", "allplayers_weapons",
    "allplayers_position", "bomb", "grenades", "allgrenades",
)


def _check_uri(uri: str) -> str:
    uri = (uri or "").strip()
    if not uri:
        return DEFAULT_URI
    if len(uri) > 300 or not _URI_RE.match(uri):
        raise HTTPException(status_code=400, detail="uri must be an http(s) URL without spaces or quotes")
    return uri


def build_cfg(uri: str, token: str) -> str:
    data = "\n".join(f'        "{c}"{" " * max(1, 24 - len(c))}"1"' for c in _DATA_COMPONENTS)
    return (
        '"CS2 Meta Engine live radar"\n'
        "{\n"
        f'    "uri"          "{uri}"\n'
        '    "timeout"      "1.1"\n'
        '    "buffer"       "0.0"\n'
        '    "throttle"     "0.1"\n'
        '    "heartbeat"    "5.0"\n'
        '    "auth"\n'
        "    {\n"
        f'        "token"    "{token}"\n'
        "    }\n"
        '    "data"\n'
        "    {\n"
        f"{data}\n"
        "    }\n"
        "}\n"
    )


def _cfg_path() -> Optional[Path]:
    from backend.main import _resolve_cs2_dir

    cs2 = _resolve_cs2_dir()
    return Path(cs2) / "cfg" / CFG_FILENAME if cs2 else None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

_shutdown_event = asyncio.Event()


def _uvicorn_should_exit() -> bool:
    """True once uvicorn has caught a shutdown/reload signal.

    Uvicorn's `Server.shutdown()` waits for open connections to close
    *before* it runs lifespan shutdown (and so `on_shutdown` below), so an
    SSE stream must notice the signal itself or `--reload` hangs. Uvicorn's
    signal handler is the Server's bound `handle_exit`, which exposes its
    `should_exit` flag.
    """
    try:
        server = getattr(signal.getsignal(signal.SIGINT), "__self__", None)
        return bool(getattr(server, "should_exit", False))
    except Exception:
        return False


def _stopping() -> bool:
    return _shutdown_event.is_set() or _uvicorn_should_exit()


async def on_startup() -> None:
    _shutdown_event.clear()
    # CS2 posts ~10x/s while spectating — keep the request log readable.
    try:
        import backend.main as _main

        quiet = getattr(_main, "_QUIET_PATH_PREFIXES", None)
        if isinstance(quiet, tuple) and "/api/gsi" not in quiet:
            _main._QUIET_PATH_PREFIXES = quiet + ("/api/gsi",)
    except Exception:  # pragma: no cover
        pass
    try:
        await asyncio.to_thread(get_token)
    except Exception as exc:  # pragma: no cover
        logger.warning("GSI token init failed: %s", exc)
    if _shared():
        def _ddl() -> None:
            with connect() as conn:
                conn.execute(_LIVE_DDL)
        await asyncio.to_thread(_ddl)


async def on_shutdown() -> None:
    # End any SSE streams still open (e.g. under servers that run lifespan
    # shutdown first) and wake their waiters.
    _shutdown_event.set()
    ev = store._event
    if ev is not None:
        ev.set()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/api/gsi", summary="Receive a CS2 Game State Integration payload")
async def receive_gsi(request: Request):
    try:
        payload = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")

    auth = payload.get("auth") if isinstance(payload.get("auth"), dict) else {}
    sent = auth.get("token")
    if not isinstance(sent, str) or not hmac.compare_digest(sent, await _token()):
        store.rejected += 1
        raise HTTPException(status_code=401, detail="bad GSI token")

    for k in ("auth", "previously", "added"):
        payload.pop(k, None)
    try:
        state = normalise(payload)
    except Exception as exc:  # malformed but authenticated — don't make CS2 retry
        logger.warning("GSI payload could not be normalised: %s", exc)
        return {"ok": False}
    store.put(state)
    if _shared():
        try:
            await asyncio.to_thread(
                _publish_sync, state.model_dump_json(), store.seq, store.received_at,
            )
        except Exception as exc:
            logger.warning("GSI shared publish failed: %s", exc)
    return {"ok": True}


@router.get("/api/gsi/state", summary="Latest normalised live game state")
async def get_state():
    await _pull()
    snap = store.snapshot()
    if snap is None:
        return JSONResponse({"mode": "none", "players": [], "grenades": [], "age_seconds": None, "seq": 0})
    return snap


@router.get("/api/gsi/history", summary="Recent live states (oldest first)")
async def get_history(limit: int = Query(20, ge=1, le=HISTORY_LEN)):
    items = list(store.history)[-limit:]
    return {"count": len(items), "states": [s.model_dump() for s in items]}


@router.get("/api/gsi/stream", summary="Server-Sent Events stream of live state")
async def stream_state(request: Request):
    async def gen():
        yield "retry: 1000\n\n"
        last_seq = -1
        started = time.monotonic()
        last_send = 0.0
        while True:
            # Checked at least every 0.5s (the wait timeout below), so a
            # reload or a closed tab ends the stream promptly.
            if _stopping() or await request.is_disconnected():
                return
            if time.monotonic() - started > SSE_MAX_LIFETIME_S:
                return
            await _pull()
            if store.seq != last_seq and store.state is not None:
                last_seq = store.seq
                last_send = time.monotonic()
                yield f"event: state\nid: {last_seq}\ndata: {json.dumps(store.snapshot(), separators=(',', ':'))}\n\n"
                continue
            if time.monotonic() - last_send > SSE_PING_S:
                last_send = time.monotonic()
                # A named event (not a comment) so the client's watchdog sees it.
                age = store.age()
                yield f"event: ping\ndata: {json.dumps({'age_seconds': round(age, 2) if age is not None else None})}\n\n"
            ev = store.event()
            try:
                await asyncio.wait_for(ev.wait(), timeout=0.5)
            except asyncio.TimeoutError:
                pass

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/api/gsi/config", summary="CS2 gamestate_integration cfg text", response_class=PlainTextResponse)
async def get_config(uri: str = Query(DEFAULT_URI, description="Where CS2 should POST (must be reachable from the game)")):
    text = build_cfg(_check_uri(uri), await _token())
    return PlainTextResponse(
        text,
        headers={"Content-Disposition": f'inline; filename="{CFG_FILENAME}"'},
    )


class InstallRequest(BaseModel):
    uri: Optional[str] = None


@router.post("/api/gsi/install", summary="Write the GSI cfg into the CS2 cfg folder", dependencies=ADMIN)
async def install_config(body: Optional[InstallRequest] = None):
    uri = _check_uri(body.uri if body else "")
    path = _cfg_path()
    if path is None:
        raise HTTPException(
            status_code=400,
            detail="CS2 game directory not configured or detected. Set it in Settings first.",
        )
    if not path.parent.is_dir():
        raise HTTPException(status_code=400, detail=f"CS2 cfg folder not found: {path.parent}")
    text = build_cfg(uri, await _token())
    try:
        path.write_text(text, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write cfg: {exc}")
    logger.info("Installed GSI cfg at %s (uri=%s)", path, uri)
    return {
        "status": "installed",
        "path": str(path),
        "uri": uri,
        "restart_required": True,
        "message": "Restart CS2 so it loads the new game state integration config.",
    }


@router.get("/api/gsi/status", summary="GSI connection + install status")
async def get_status():
    age = store.age()
    st = store.state
    path = await asyncio.to_thread(_cfg_path)
    token = await _token()
    installed = False
    token_ok: Optional[bool] = None
    installed_uri: Optional[str] = None
    if path is not None:
        try:
            if path.is_file():
                installed = True
                text = path.read_text(encoding="utf-8", errors="replace")
                token_ok = f'"{token}"' in text
                m = re.search(r'"uri"\s+"([^"]*)"', text)
                installed_uri = m.group(1) if m else None
        except OSError:
            pass
    return {
        "connected": age is not None and age < CONNECTED_WITHIN_S,
        "last_payload_age": round(age, 3) if age is not None else None,
        "payloads_received": store.seq,
        "payloads_rejected": store.rejected,
        "mode": st.mode if st else None,
        "map": st.map if st else None,
        "provider": st.provider if st else None,
        "cs2_dir_found": path is not None,
        "cfg_installed": installed,
        "cfg_path": str(path) if path else None,
        "cfg_token_matches": token_ok,
        "cfg_uri": installed_uri,
        "default_uri": DEFAULT_URI,
    }
