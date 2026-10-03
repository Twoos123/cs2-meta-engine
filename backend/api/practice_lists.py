"""
Practice lists — saved lineups and CS2 .cfg export.

A practice list is a named, ordered set of lineups for one map. Each item
keeps a snapshot of the lineup (label, grenade, stand position, angles,
technique) so the list still exports after the clusters table is rebuilt
and cluster ids are reassigned.

The `.cfg` export defines one alias per lineup (`cs2me_1` … `cs2me_N`).
Each alias teleports, gives the grenade, echoes what it is, and re-points
`cs2me_next` / `cs2me_prev` at its neighbours (wrapping around), so two
bound keys cycle the list in-game.

Endpoints
---------
GET    /api/practice-lists?map_name=de_mirage          lists (with items)
POST   /api/practice-lists                              create      (admin)
GET    /api/practice-lists/{id}                         one list
PATCH  /api/practice-lists/{id}                         rename      (admin)
DELETE /api/practice-lists/{id}                         delete      (admin)
POST   /api/practice-lists/{id}/items                   add lineup  (admin)
PATCH  /api/practice-lists/{id}/items/{item_id}         edit note   (admin)
DELETE /api/practice-lists/{id}/items/{item_id}         remove      (admin)
PUT    /api/practice-lists/{id}/order                   reorder     (admin)
GET    /api/practice-lists/{id}/cfg?next_key=]&prev_key=[   .cfg download
POST   /api/practice-lists/{id}/install                 write .cfg into CS2 (admin)
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.api.deps import ADMIN
from backend.db import connect
from backend.models.schemas import LineupCluster
from backend.rcon.bridge import generate_console_string

router = APIRouter()

MAX_LISTS_PER_MAP = 50
MAX_ITEMS_PER_LIST = 100
MAX_NAME_LEN = 60
MAX_NOTE_LEN = 200
# Source-engine console lines are limited (512 bytes historically); stay
# well under so nothing is ever truncated.
MAX_CFG_LINE = 255
MAX_ECHO_LABEL = 48
ALIAS_PREFIX = "cs2me_"

_MAP_RE = re.compile(r"^[a-z0-9_]{1,32}$")
# A key name for `bind`: a word key (f5, kp_plus, mwheelup, …) or one
# punctuation key. Never a quote, semicolon or backslash.
_KEY_RE = re.compile(r"^(?:[A-Za-z0-9_]{1,16}|[\[\]\-=,./'`])$")

TECHNIQUE_TEXT = {
    "stand": "Stand",
    "walk": "Walk",
    "run": "Run",
    "crouch": "Crouch",
    "jump": "Jump",
    "running_jump": "Run + Jump",
}
CLICK_TEXT = {"left": "left click", "right": "right click", "both": "left + right click"}

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS practice_lists (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        map_name    TEXT NOT NULL,
        created_at  TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS practice_list_items (
        id                 INTEGER PRIMARY KEY,
        list_id            INTEGER NOT NULL,
        cluster_id         INTEGER NOT NULL,
        position           INTEGER NOT NULL,
        note               TEXT NOT NULL DEFAULT '',
        label              TEXT,
        grenade_type       TEXT NOT NULL,
        throw_x            REAL NOT NULL,
        throw_y            REAL NOT NULL,
        throw_z            REAL NOT NULL,
        pitch              REAL NOT NULL,
        yaw                REAL NOT NULL,
        primary_technique  TEXT,
        primary_click      TEXT,
        side               TEXT,
        added_at           TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_practice_lists_map ON practice_lists (map_name)",
    "CREATE INDEX IF NOT EXISTS idx_practice_items_list ON practice_list_items (list_id, position)",
)

def _db() -> sqlite3.Connection:
    """Connection with the practice tables guaranteed to exist. The
    CREATE ... IF NOT EXISTS statements are cheap, and running them every
    time survives the DB file being deleted while the server runs."""
    conn = connect()
    with conn:
        for stmt in _SCHEMA:
            conn.execute(stmt)
    return conn


async def on_startup() -> None:
    _db().close()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _next_id(conn: sqlite3.Connection, table: str) -> int:
    # `table` is always one of our two fixed table names.
    row = conn.execute(f"SELECT MAX(id) AS m FROM {table}").fetchone()
    return int(row["m"] or 0) + 1


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class PracticeItem(BaseModel):
    item_id: int
    cluster_id: int
    position: int
    note: str = ""
    label: Optional[str] = None
    grenade_type: str
    throw_x: float
    throw_y: float
    throw_z: float
    pitch: float
    yaw: float
    primary_technique: Optional[str] = None
    primary_click: Optional[str] = None
    side: Optional[str] = None


class PracticeList(BaseModel):
    id: int
    name: str
    map_name: str
    created_at: str
    slug: str
    exec_command: str
    items: List[PracticeItem] = Field(default_factory=list)


class CreateListRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=MAX_NAME_LEN)
    map_name: str


class RenameListRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=MAX_NAME_LEN)


class AddItemRequest(BaseModel):
    cluster_id: int
    map_name: str
    note: str = Field(default="", max_length=MAX_NOTE_LEN)


class UpdateItemRequest(BaseModel):
    note: str = Field(default="", max_length=MAX_NOTE_LEN)


class ReorderRequest(BaseModel):
    item_ids: List[int]


class InstallResponse(BaseModel):
    path: str
    filename: str
    command: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.replace("\x00", "").split())
    if not cleaned:
        raise HTTPException(status_code=400, detail="List name can't be empty")
    return cleaned[:MAX_NAME_LEN]


def _check_map(map_name: str) -> str:
    if not _MAP_RE.match(map_name or ""):
        raise HTTPException(status_code=400, detail=f"Invalid map name: {map_name!r}")
    return map_name


def slugify(name: str, fallback: str) -> str:
    """Lower-case [a-z0-9_] slug for the cfg filename (`practice_<slug>.cfg`)."""
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40].strip("_")
    return slug or fallback


def _row_to_item(row) -> PracticeItem:
    return PracticeItem(
        item_id=row["id"],
        cluster_id=row["cluster_id"],
        position=row["position"],
        note=row["note"] or "",
        label=row["label"],
        grenade_type=row["grenade_type"],
        throw_x=row["throw_x"],
        throw_y=row["throw_y"],
        throw_z=row["throw_z"],
        pitch=row["pitch"],
        yaw=row["yaw"],
        primary_technique=row["primary_technique"],
        primary_click=row["primary_click"],
        side=row["side"],
    )


def _load_list(conn, list_id: int) -> PracticeList:
    row = conn.execute(
        "SELECT id, name, map_name, created_at FROM practice_lists WHERE id = ?",
        (list_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Practice list not found")
    items = conn.execute(
        "SELECT * FROM practice_list_items WHERE list_id = ? ORDER BY position, id",
        (list_id,),
    ).fetchall()
    slug = slugify(row["name"], f"list{row['id']}")
    return PracticeList(
        id=row["id"],
        name=row["name"],
        map_name=row["map_name"],
        created_at=row["created_at"],
        slug=slug,
        exec_command=f"exec practice_{slug}",
        items=[_row_to_item(r) for r in items],
    )


def _renumber(conn, list_id: int, ordered_ids: List[int]) -> None:
    for pos, item_id in enumerate(ordered_ids):
        conn.execute(
            "UPDATE practice_list_items SET position = ? WHERE id = ? AND list_id = ?",
            (pos, item_id, list_id),
        )


def _lookup_cluster(cluster_id: int, map_name: str) -> Optional[LineupCluster]:
    # Lazy: main.py imports this module.
    from backend.main import _pipeline

    return _pipeline.get_cluster_by_id(cluster_id, map_name)


def _validate_key(key: str, which: str) -> str:
    if not _KEY_RE.match(key or ""):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {which} key {key!r}: use a key name like ] or f5 (no quotes or semicolons)",
        )
    return key


# ---------------------------------------------------------------------------
# .cfg generation (pure — unit tested)
# ---------------------------------------------------------------------------

# Allow-list. Excludes quotes, `;`, `:` and the tokenizer break characters
# `{ } ( ) '`, which the console would split into separate tokens.
_ECHO_UNSAFE = re.compile(r"[^A-Za-z0-9 _\-.,!?#+&/]")


def sanitize_cfg_text(text: Optional[str], limit: int = MAX_ECHO_LABEL) -> str:
    """Make free text safe inside a quoted alias / echo / comment.

    Strips quotes, semicolons (command separators), `//` (comment start),
    braces and any non-printable / non-ASCII character, collapses whitespace
    and truncates to `limit`.
    """
    if not text:
        return ""
    s = _ECHO_UNSAFE.sub(" ", text)
    while "//" in s:
        s = s.replace("//", "/")
    s = " ".join(s.split())
    if len(s) > limit:
        s = s[: limit - 2].rstrip() + ".."
    return s


def item_to_cluster(item: PracticeItem, map_name: str) -> LineupCluster:
    """Rebuild a minimal LineupCluster from the stored snapshot so the cfg
    uses exactly the same setpos/setang/give as Copy Console."""
    return LineupCluster(
        cluster_id=item.cluster_id,
        map_name=map_name,
        grenade_type=item.grenade_type,
        land_centroid_x=0.0,
        land_centroid_y=0.0,
        land_centroid_z=0.0,
        throw_centroid_x=item.throw_x,
        throw_centroid_y=item.throw_y,
        throw_centroid_z=item.throw_z,
        avg_pitch=item.pitch,
        avg_yaw=item.yaw,
        throw_count=0,
        round_win_rate=0.0,
        total_utility_damage=0.0,
        avg_utility_damage=0.0,
        label=item.label,
        primary_technique=item.primary_technique,
        primary_click=item.primary_click,
    )


def lineup_commands(item: PracticeItem, map_name: str) -> List[str]:
    """setpos / setang / give for one item, from generate_console_string.
    `sv_cheats 1` is dropped — the cfg header sets it once."""
    cmds = [c.strip() for c in generate_console_string(item_to_cluster(item, map_name)).split(";")]
    return [c for c in cmds if c and c != "sv_cheats 1"]


def _echo_text(i: int, n: int, item: PracticeItem) -> str:
    label = sanitize_cfg_text(item.label) or f"Lineup {item.cluster_id}"
    parts = []
    tech = TECHNIQUE_TEXT.get(item.primary_technique or "")
    if tech:
        parts.append(tech)
    click = CLICK_TEXT.get(item.primary_click or "")
    if click:
        parts.append(click)
    suffix = sanitize_cfg_text(", ".join(parts), 32)
    text = f"[{i}/{n}] {label}"
    return f"{text} - {suffix}" if suffix else text


def build_cfg(
    plist: PracticeList,
    next_key: str = "]",
    prev_key: str = "[",
    generated_at: Optional[str] = None,
) -> str:
    """Render the practice list as a CS2 `.cfg`."""
    _validate_key(next_key, "next")
    _validate_key(prev_key, "prev")
    if next_key == prev_key:
        raise HTTPException(status_code=400, detail="Next and prev keys must differ")
    items = plist.items
    n = len(items)
    if n == 0:
        raise HTTPException(status_code=400, detail="This practice list is empty — add lineups first")

    name = sanitize_cfg_text(plist.name, MAX_NAME_LEN) or f"List {plist.id}"
    exec_name = f"practice_{plist.slug}"
    lines: List[str] = [
        "// ------------------------------------------------------------------",
        "// CS2 Meta Engine - practice list",
        f"// List: {name}",
        f"// Map: {plist.map_name} - {n} lineup{'s' if n != 1 else ''}",
        f"// Generated: {generated_at or _now()}",
        "//",
        f"// 1. Start a local server on the map:  map {plist.map_name}",
        f"// 2. In the console run:  exec {exec_name}",
        f"// 3. Press {next_key} for the next lineup, {prev_key} for the previous one.",
        "// ------------------------------------------------------------------",
        "",
        "// Practice-server settings",
        "// Allow setpos / setang / give (cheat commands)",
        "sv_cheats 1",
        "// Never run out of grenades",
        "sv_infinite_ammo 1",
        "// Carry up to five grenades at once",
        "ammo_grenade_limit_total 5",
        "// Show the predicted grenade trajectory while aiming",
        "sv_grenade_trajectory_prac_pipreview 1",
        "// 60-minute rounds so the round never ends mid-practice",
        "mp_roundtime_defuse 60",
        "// No freeze time after a round restart",
        "mp_freezetime 0",
        "// Leave warmup",
        "mp_warmup_end",
        "// Remove bots",
        "bot_kick",
        "",
        "// One alias per lineup: teleport, aim, give the grenade, then point",
        f"// {ALIAS_PREFIX}next / {ALIAS_PREFIX}prev at the neighbours (wraps around)",
    ]

    for idx, item in enumerate(items, start=1):
        nxt = idx % n + 1
        prv = (idx - 2) % n + 1
        body = "; ".join(
            lineup_commands(item, plist.map_name)
            + [
                f"echo {_echo_text(idx, n, item)}",
                f"alias {ALIAS_PREFIX}next {ALIAS_PREFIX}{nxt}",
                f"alias {ALIAS_PREFIX}prev {ALIAS_PREFIX}{prv}",
            ]
        )
        note = sanitize_cfg_text(item.note, 120)
        if note:
            lines.append(f"// {idx}: {note}")
        lines.append(f'alias "{ALIAS_PREFIX}{idx}" "{body}"')

    lines += [
        "",
        "// Cycle keys",
        f'bind "{next_key}" "{ALIAS_PREFIX}next"',
        f'bind "{prev_key}" "{ALIAS_PREFIX}prev"',
        "",
        f"echo Loaded {n} lineup{'s' if n != 1 else ''} - press {next_key} next, {prev_key} previous",
        f"{ALIAS_PREFIX}1",
        "",
    ]

    for line in lines:
        if len(line) > MAX_CFG_LINE:  # pragma: no cover - guarded by sanitising
            raise HTTPException(status_code=500, detail="Generated cfg line too long")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Endpoints — lists
# ---------------------------------------------------------------------------


@router.get("/api/practice-lists", response_model=List[PracticeList])
async def list_practice_lists(map_name: Optional[str] = Query(None)):
    conn = _db()
    try:
        if map_name:
            _check_map(map_name)
            rows = conn.execute(
                "SELECT id FROM practice_lists WHERE map_name = ? ORDER BY id", (map_name,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT id FROM practice_lists ORDER BY map_name, id").fetchall()
        return [_load_list(conn, r["id"]) for r in rows]
    finally:
        conn.close()


@router.post("/api/practice-lists", response_model=PracticeList, dependencies=ADMIN)
async def create_practice_list(req: CreateListRequest):
    name = _clean_name(req.name)
    map_name = _check_map(req.map_name)
    conn = _db()
    try:
        with conn:
            count = conn.execute(
                "SELECT COUNT(*) AS c FROM practice_lists WHERE map_name = ?", (map_name,)
            ).fetchone()["c"]
            if count >= MAX_LISTS_PER_MAP:
                raise HTTPException(status_code=400, detail=f"Too many lists for {map_name}")
            new_id = _next_id(conn, "practice_lists")
            conn.execute(
                "INSERT INTO practice_lists (id, name, map_name, created_at) VALUES (?, ?, ?, ?)",
                (new_id, name, map_name, _now()),
            )
        return _load_list(conn, new_id)
    finally:
        conn.close()


@router.get("/api/practice-lists/{list_id}", response_model=PracticeList)
async def get_practice_list(list_id: int):
    conn = _db()
    try:
        return _load_list(conn, list_id)
    finally:
        conn.close()


@router.patch("/api/practice-lists/{list_id}", response_model=PracticeList, dependencies=ADMIN)
async def rename_practice_list(list_id: int, req: RenameListRequest):
    name = _clean_name(req.name)
    conn = _db()
    try:
        _load_list(conn, list_id)
        with conn:
            conn.execute("UPDATE practice_lists SET name = ? WHERE id = ?", (name, list_id))
        return _load_list(conn, list_id)
    finally:
        conn.close()


@router.delete("/api/practice-lists/{list_id}", dependencies=ADMIN)
async def delete_practice_list(list_id: int):
    conn = _db()
    try:
        _load_list(conn, list_id)
        with conn:
            conn.execute("DELETE FROM practice_list_items WHERE list_id = ?", (list_id,))
            conn.execute("DELETE FROM practice_lists WHERE id = ?", (list_id,))
        return {"deleted": list_id}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Endpoints — items
# ---------------------------------------------------------------------------


@router.post("/api/practice-lists/{list_id}/items", response_model=PracticeList, dependencies=ADMIN)
async def add_practice_item(list_id: int, req: AddItemRequest):
    conn = _db()
    try:
        plist = _load_list(conn, list_id)
        if req.map_name != plist.map_name:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"“{plist.name}” is a {plist.map_name} list — this lineup is on "
                    f"{req.map_name}. Pick or create a {req.map_name} list instead."
                ),
            )
        if len(plist.items) >= MAX_ITEMS_PER_LIST:
            raise HTTPException(
                status_code=400, detail=f"A list holds at most {MAX_ITEMS_PER_LIST} lineups"
            )
        cluster = _lookup_cluster(req.cluster_id, plist.map_name)
        if cluster is None:
            raise HTTPException(status_code=404, detail="Lineup not found on this map")
        for it in plist.items:
            if (
                it.cluster_id == cluster.cluster_id
                and abs(it.throw_x - cluster.throw_centroid_x) < 1
                and abs(it.throw_y - cluster.throw_centroid_y) < 1
            ):
                raise HTTPException(status_code=409, detail="That lineup is already in this list")

        with conn:
            new_id = _next_id(conn, "practice_list_items")
            conn.execute(
                """
                INSERT INTO practice_list_items (
                    id, list_id, cluster_id, position, note, label, grenade_type,
                    throw_x, throw_y, throw_z, pitch, yaw,
                    primary_technique, primary_click, side, added_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id,
                    list_id,
                    cluster.cluster_id,
                    len(plist.items),
                    req.note.strip(),
                    cluster.label,
                    cluster.grenade_type,
                    cluster.throw_centroid_x,
                    cluster.throw_centroid_y,
                    cluster.throw_centroid_z,
                    cluster.avg_pitch,
                    cluster.avg_yaw,
                    cluster.primary_technique,
                    cluster.primary_click,
                    cluster.side,
                    _now(),
                ),
            )
        return _load_list(conn, list_id)
    finally:
        conn.close()


def _require_item(plist: PracticeList, item_id: int) -> PracticeItem:
    for it in plist.items:
        if it.item_id == item_id:
            return it
    raise HTTPException(status_code=404, detail="Item not found in this list")


@router.patch(
    "/api/practice-lists/{list_id}/items/{item_id}",
    response_model=PracticeList,
    dependencies=ADMIN,
)
async def update_practice_item(list_id: int, item_id: int, req: UpdateItemRequest):
    conn = _db()
    try:
        _require_item(_load_list(conn, list_id), item_id)
        with conn:
            conn.execute(
                "UPDATE practice_list_items SET note = ? WHERE id = ? AND list_id = ?",
                (req.note.strip(), item_id, list_id),
            )
        return _load_list(conn, list_id)
    finally:
        conn.close()


@router.delete(
    "/api/practice-lists/{list_id}/items/{item_id}",
    response_model=PracticeList,
    dependencies=ADMIN,
)
async def remove_practice_item(list_id: int, item_id: int):
    conn = _db()
    try:
        plist = _load_list(conn, list_id)
        _require_item(plist, item_id)
        with conn:
            conn.execute(
                "DELETE FROM practice_list_items WHERE id = ? AND list_id = ?", (item_id, list_id)
            )
            _renumber(conn, list_id, [it.item_id for it in plist.items if it.item_id != item_id])
        return _load_list(conn, list_id)
    finally:
        conn.close()


@router.put("/api/practice-lists/{list_id}/order", response_model=PracticeList, dependencies=ADMIN)
async def reorder_practice_items(list_id: int, req: ReorderRequest):
    conn = _db()
    try:
        plist = _load_list(conn, list_id)
        current = sorted(it.item_id for it in plist.items)
        if sorted(req.item_ids) != current or len(set(req.item_ids)) != len(req.item_ids):
            raise HTTPException(
                status_code=400,
                detail="item_ids must list every item in this list exactly once",
            )
        with conn:
            _renumber(conn, list_id, req.item_ids)
        return _load_list(conn, list_id)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Endpoints — export
# ---------------------------------------------------------------------------


@router.get("/api/practice-lists/{list_id}/cfg")
async def download_practice_cfg(
    list_id: int,
    next_key: str = Query("]", max_length=16),
    prev_key: str = Query("[", max_length=16),
):
    conn = _db()
    try:
        plist = _load_list(conn, list_id)
    finally:
        conn.close()
    text = build_cfg(plist, next_key, prev_key)
    filename = f"practice_{plist.slug}.cfg"
    return Response(
        content=text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/api/practice-lists/{list_id}/install",
    response_model=InstallResponse,
    dependencies=ADMIN,
)
async def install_practice_cfg(
    list_id: int,
    next_key: str = Query("]", max_length=16),
    prev_key: str = Query("[", max_length=16),
):
    conn = _db()
    try:
        plist = _load_list(conn, list_id)
    finally:
        conn.close()
    text = build_cfg(plist, next_key, prev_key)

    from backend.main import _resolve_cs2_dir

    cs2_dir = _resolve_cs2_dir()
    if not cs2_dir:
        raise HTTPException(
            status_code=404,
            detail=(
                "CS2 install not found. Set the game/csgo folder in Settings, "
                "or use Download .cfg and copy it into game/csgo/cfg yourself."
            ),
        )
    cfg_dir = Path(cs2_dir) / "cfg"
    if not cfg_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"No cfg folder at {cfg_dir} — is the CS2 path pointing at game/csgo?",
        )
    filename = f"practice_{plist.slug}.cfg"
    target = cfg_dir / filename
    # Slug is [a-z0-9_] only, but never write anywhere except cfg_dir.
    if target.resolve().parent != cfg_dir.resolve():
        raise HTTPException(status_code=400, detail="Refusing to write outside the cfg folder")
    try:
        target.write_text(text, encoding="utf-8", newline="\n")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Couldn't write {target}: {exc}") from exc
    return InstallResponse(path=str(target), filename=filename, command=f"exec practice_{plist.slug}")
