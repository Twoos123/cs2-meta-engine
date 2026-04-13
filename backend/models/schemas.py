"""
Pydantic schemas shared between the FastAPI layer and the analysis pipeline.
"""
from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# HLTV / Ingestion
# ---------------------------------------------------------------------------

class HLTVMatch(BaseModel):
    match_id: int
    team1: str
    team2: str
    event: str
    map: Optional[str] = None
    demo_url: Optional[str] = None
    # Per-map demo download URLs for BO3/5 series. Keys are normalized map
    # tokens ("mirage", "nuke", …). When set, download_demo() uses the entry
    # matching the requested map instead of the (often series-wide) demo_url.
    demo_urls: Dict[str, str] = Field(default_factory=dict)
    date: Optional[str] = None
    # Player rosters scraped from the HLTV match page — used to filter
    # grenade throws to only the requested team's players.
    team1_players: List[str] = Field(default_factory=list)
    team2_players: List[str] = Field(default_factory=list)
    team1_logo: Optional[str] = None
    team2_logo: Optional[str] = None


class DemoIngestionResult(BaseModel):
    demo_path: str
    match_id: Optional[int] = None
    grenades_extracted: int
    rounds_extracted: int
    success: bool
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Grenade / Throw raw data
# ---------------------------------------------------------------------------

class GrenadeThrow(BaseModel):
    tick: int
    round_number: int
    thrower_steamid: str
    thrower_name: str
    grenade_type: str                # smokegrenade | hegrenade | flashbang | molotov
    map_name: str
    throw_x: float
    throw_y: float
    throw_z: float
    land_x: float
    land_y: float
    land_z: float
    pitch: float                     # view angle at throw time
    yaw: float
    round_winner: Optional[str] = None   # "CT" | "T" | None
    utility_damage: float = 0.0


# ---------------------------------------------------------------------------
# Clustering / Lineup
# ---------------------------------------------------------------------------

class TopThrower(BaseModel):
    name: str
    count: int
    # Per-player demo pointer — points at a real throw BY this player in this
    # cluster, so the replay flow can seek to a specific player's take when
    # the dashboard's player filter is active. Both Optional because
    # pre-migration rows won't have them and the restore path handles that
    # via the graceful fallback in /api/replay.
    demo_file: Optional[str] = None
    demo_tick: Optional[int] = None
    # 1-based slot index for spec_player during demo playback. CS2 demo
    # playback ignores spec_player "name" but reliably accepts numeric
    # slot indices 1–10. Derived by sorting unique entity_ids in parse_ticks.
    demo_player_slot: Optional[int] = None


class LineupCluster(BaseModel):
    cluster_id: int
    map_name: str
    grenade_type: str
    # Centroid of landing positions
    land_centroid_x: float
    land_centroid_y: float
    land_centroid_z: float
    # Average standing / throw position
    throw_centroid_x: float
    throw_centroid_y: float
    throw_centroid_z: float
    avg_pitch: float
    avg_yaw: float
    # Metrics
    throw_count: int
    round_win_rate: float            # 0–1
    total_utility_damage: float
    avg_utility_damage: float
    # Auto-generated label (e.g. "Mirage Window Smoke")
    label: Optional[str] = None
    # Top 3 players who threw this exact lineup, most frequent first.
    # Populated from thrower_name value_counts in the clustering step.
    top_throwers: List[TopThrower] = Field(default_factory=list)
    # Throw technique / click-type summary — derived in clustering from the
    # per-throw labels the demo parser attached. `technique_agreement` is the
    # fraction of throws in the cluster whose technique equals primary_technique
    # (same shape for click_agreement). None when no throws had classifiable
    # state — e.g. a cluster built from throws whose parse_ticks lookup failed.
    primary_technique: Optional[str] = None    # stand / walk / run / jump / running_jump / crouch
    technique_agreement: float = 0.0
    primary_click: Optional[str] = None        # left / right / both
    click_agreement: float = 0.0
    # Which side the throwers were on. A lineup is overwhelmingly one side
    # because throw position is in the bucket key — "T" / "CT" / None when
    # team_num was missing on every throw.
    side: Optional[str] = None
    # Pointer to a representative throw inside a real .dem file so the user
    # can jump straight to it via `playdemo <file>; demo_goto <tick>`. We
    # take these from the medoid row — the same throw whose standing
    # position we report — so the user always lands on a real tick from a
    # real demo, never an averaged ghost.
    demo_file: Optional[str] = None
    demo_tick: Optional[int] = None
    # Name of the player who threw the medoid grenade.
    demo_thrower_name: Optional[str] = None
    # 1-based slot index for the medoid thrower — CS2 demo playback only
    # supports numeric `spec_player <N>`, not `spec_player "name"`. The
    # slot is derived by sorting unique entity_ids from parse_ticks.
    demo_player_slot: Optional[int] = None
    # Decimated 2D projectile flight path (list of [x, y] pairs in world
    # coordinates) taken from the medoid throw's `parse_grenades()` entity.
    # None for old rows or throws where demoparser2 didn't emit a matching
    # entity — the radar falls back to a straight throw→land line in that
    # case. At most ~50 points per throw to keep payload small.
    trajectory: Optional[List[List[float]]] = None


class LineupRanking(BaseModel):
    rank: int
    cluster: LineupCluster
    impact_score: float              # composite of win_rate × frequency


# ---------------------------------------------------------------------------
# Execute detection (coordinated utility combos)
# ---------------------------------------------------------------------------

class ExecuteComboMember(BaseModel):
    """One lineup cluster that participates in an execute combo."""
    cluster_id: int
    grenade_type: str
    label: Optional[str] = None


class ExecuteCombo(BaseModel):
    """A recurring coordinated utility pattern detected across rounds."""
    execute_id: int
    map_name: str
    name: str                        # auto-generated, e.g. "Mirage B Site Execute"
    members: List[ExecuteComboMember]
    occurrence_count: int            # how many rounds this combo appeared
    round_win_rate: float            # win rate when this combo is used
    side: Optional[str] = None       # "T" | "CT"
    grenade_summary: str             # e.g. "2 Smokes + 1 Flash + 1 Molotov"


class LineupDescriptionResponse(BaseModel):
    """AI-generated description for a lineup cluster."""
    cluster_id: int
    map_name: str
    description: str
    model: str


# ---------------------------------------------------------------------------
# RCON / Practice
# ---------------------------------------------------------------------------

class PracticeRequest(BaseModel):
    cluster_id: int
    map_name: str


class PracticeResponse(BaseModel):
    success: bool
    commands_sent: List[str]
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# API response wrappers
# ---------------------------------------------------------------------------

class TopLineupsResponse(BaseModel):
    map_name: str
    grenade_type: str
    lineups: List[LineupRanking]
    total_clusters: int


# ---------------------------------------------------------------------------
# Match replay (full-match 2D viewer)
# ---------------------------------------------------------------------------

class DemoListEntry(BaseModel):
    """One scraped demo file, surfaced on the match-replay picker page."""
    demo_file: str           # filename only, not a full path (path-traversal guard)
    map_name: str            # parsed from filename token; "unknown" if missing
    match_id: Optional[int] = None
    size_bytes: int
    mtime: float             # unix seconds, for sort-by-date in the picker


class TimelinePlayer(BaseModel):
    steamid: str
    name: str
    team_num: int            # 2 = T, 3 = CT (Source engine convention)


class TimelinePosition(BaseModel):
    t: int                   # tick
    x: float
    y: float
    yaw: float
    alive: bool
    hp: int
    w: Optional[str] = None  # active weapon
    ar: Optional[int] = None # armor
    hl: Optional[bool] = None # helmet
    tn: Optional[int] = None # team_num
    inv: Optional[List[str]] = Field(default_factory=list) # full inventory
    eq: Optional[int] = None   # equipment value
    cs: Optional[int] = None   # cash spent this round


class TimelineGrenade(BaseModel):
    type: str                # normalized: smokegrenade / hegrenade / flashbang / molotov / decoy
    thrower: str             # steamid
    points: List[List[float]] = Field(default_factory=list)   # [[tick, x, y], ...]
    detonate_tick: Optional[int] = None


class TimelineEvent(BaseModel):
    type: str                # death / fire / bomb_plant / bomb_defuse / round_start / round_end
    tick: int
    # Free-form payload — kills carry attacker/victim steamids, fires carry
    # shooter, bomb events carry player and site, round_end carries winner.
    # Dict keeps the schema open for future event types.
    data: Dict[str, str] = Field(default_factory=dict)


class TimelineRound(BaseModel):
    num: int
    start_tick: int
    end_tick: int
    winner: Optional[str] = None      # "T" | "CT" | None


class MatchTimeline(BaseModel):
    map_name: str
    tick_rate: int = 64
    decimation: int = 8              # positions are every Nth tick
    tick_max: int
    players: List[TimelinePlayer]
    # Keyed by steamid → list of position samples sorted by tick.
    positions: Dict[str, List[TimelinePosition]]
    grenades: List[TimelineGrenade]
    events: List[TimelineEvent]
    rounds: List[TimelineRound]


class MatchInsightsResponse(BaseModel):
    demo_file: str
    summary: str             # plain markdown, 3–5 paragraphs
    model: str               # which Claude model produced it


class IngestionStatusResponse(BaseModel):
    total_demos: int
    total_grenades: int
    status: str
    # Monotonically-increasing ID of the most recently queued ingest/pipeline
    # task. Incremented in the POST handler before asyncio.create_task, so
    # frontend polls can capture it and compare against last_completed_run_id
    # to detect their task finishing — even when the pipeline runs so fast
    # (empty demos dir, no-op filter) that the poll never catches it in the
    # "running" state.
    run_id: int = 0
    last_completed_run_id: int = 0
