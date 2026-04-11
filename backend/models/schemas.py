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


class LineupRanking(BaseModel):
    rank: int
    cluster: LineupCluster
    impact_score: float              # composite of win_rate × frequency


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
