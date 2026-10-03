"""
Current-build CS2 demos: no `grenade_thrown` event, pre-live rounds.

Newer CS2 builds stopped emitting `grenade_thrown`, so DemoParser rebuilds the
throw rows from projectile trajectories (parse_grenades) plus a batched
parse_ticks lookup. FACEIT demos also record a pre-live round before
mp_restartgame, which the round extraction must drop. These tests drive both
paths with a fake demoparser2 parser; one optional test cross-checks the
synthesis against real grenade_thrown events when a pro demo is present.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backend.analysis.validation import assess_completeness
from backend.ingestion import demo_parser as dpmod
from backend.ingestion.demo_parser import (
    DemoParser,
    _projectile_segments,
    _sample_round_state,
    extract_match_timeline,
    live_round_mask,
)

ROOT = Path(__file__).resolve().parents[1]

T_SID, CT_SID = 111, 222
DEAD_FROM = {T_SID: 7000}  # T player dies at tick 7000 (drops a live HE)


# ---------------------------------------------------------------------------
# Fake demoparser2 parser
# ---------------------------------------------------------------------------

def _projectile(cls: str, entity: int, sid: int, name: str, start: int, n: int,
                x0: float, still_after: int | None = None) -> list[dict]:
    rows = []
    for i in range(n):
        moving = still_after is None or i < still_after
        x = x0 + (i if moving else still_after) * 10.0
        rows.append({"grenade_type": cls, "grenade_entity_id": entity, "x": x, "y": 5.0,
                     "z": 64.0, "tick": start + i, "steamid": sid, "name": name})
    return rows


class FakeParser:
    """Minimal stand-in for demoparser2.DemoParser on a new-format demo."""

    def __init__(self, *_args, **_kwargs):
        rows: list[dict] = []
        # Pre-live smoke (round wiped by the restart) — must be dropped.
        rows += _projectile("CSmokeGrenadeProjectile", 11, T_SID, "tee", 500, 60, 0.0)
        # Smoke that flies 20 ticks then sits still (trajectory gets trimmed).
        rows += _projectile("CSmokeGrenadeProjectile", 7, T_SID, "tee", 1000, 100, 0.0, still_after=20)
        # Entity 9 reused by the same player for a second smoke 1000 ticks later.
        rows += _projectile("CSmokeGrenadeProjectile", 9, T_SID, "tee", 2000, 50, 100.0)
        rows += _projectile("CSmokeGrenadeProjectile", 9, T_SID, "tee", 3000, 50, 200.0)
        # Entity 7 recycled by the CT player as an HE.
        rows += _projectile("CHEGrenadeProjectile", 7, CT_SID, "ceetee", 5000, 40, 300.0)
        # CT incendiary (projectile class is CMolotovProjectile).
        rows += _projectile("CMolotovProjectile", 12, CT_SID, "ceetee", 6000, 40, 400.0)
        # HE dropped on death — spawns a projectile but isn't a throw.
        rows += _projectile("CHEGrenadeProjectile", 13, T_SID, "tee", 7000, 30, 500.0)
        g = pd.DataFrame(rows)
        # demoparser2 emits rows for entities that don't exist yet: NaN positions.
        nan_rows = g.head(5).copy()
        nan_rows[["x", "y", "z"]] = np.nan
        self._grenades = pd.concat([nan_rows, g], ignore_index=True)

    # -- events -----------------------------------------------------------
    def list_game_events(self):
        return ["round_end", "round_start", "smokegrenade_detonate", "player_hurt"]

    def parse_header(self):
        return {"map_name": "de_inferno", "patch_version": "14188"}

    def parse_player_info(self):
        return [{"steamid": str(T_SID), "name": "tee"}, {"steamid": str(CT_SID), "name": "ceetee"}]

    def parse_event(self, name, player=None, other=None):
        if name == "grenade_thrown":
            raise RuntimeError("EventNotFound")
        if name == "round_end":
            return pd.DataFrame({
                "round": [0, 1, 2, 3],
                "tick": [0, 900, 4000, 8000],
                "winner": [np.nan, "T", "CT", "T"],
                "reason": [np.nan, "ct_killed", "t_killed", "ct_killed"],
            })
        if name == "round_start":
            return pd.DataFrame({"tick": [0, 100, 950, 4100]})
        if name == "round_freeze_end":
            return pd.DataFrame({"tick": [200, 1000, 4200]})
        if name == "smokegrenade_detonate":
            return pd.DataFrame({
                "tick": [1100, 2040, 3040], "user_steamid": [str(T_SID)] * 3,
                "x": [190.0, 590.0, 690.0], "y": [5.0] * 3, "z": [0.0] * 3,
                "entityid": [7, 9, 9], "user_name": ["tee"] * 3,
            })
        return pd.DataFrame()

    def parse_grenades(self):
        return self._grenades.copy()

    # -- per-tick props ---------------------------------------------------
    def _state(self, sid: int, tick: int) -> dict:
        is_t = sid == T_SID
        return {
            "X": (100.0 + tick) if is_t else 500.0,  # T walks +1u/tick = 64 u/s
            "Y": 0.0 if is_t else 50.0,
            "Z": -10.0,
            "pitch": -12.5 if is_t else 3.0,
            "yaw": 90.0 if is_t else -45.0,
            "team_num": 2 if is_t else 3,
            "is_walking": False,
            "ducking": False,
            "duck_amount": 0.0,
            "is_alive": tick < DEAD_FROM.get(sid, 10**9),
            "active_weapon_name": "Smoke Grenade" if is_t else "Incendiary Grenade",
            # Current builds: right click for the CT, left for the T.
            "Grenade.m_flThrowStrength": 1.0 if is_t else 0.0,
            # Garbage on purpose — the parser must not trust sparse velocity.
            "velocity_X": 9999.0, "velocity_Y": 9999.0, "velocity_Z": 9999.0,
            # Pre-live round counted, then the restart reset the counter.
            "total_rounds_played": 1 if tick < 8000 else 2,
            "team_rounds_total": 1,
            "team_clan_name": "Alpha" if is_t else "Bravo",
            "health": 100, "inventory": [], "current_equip_value": 0,
            "cash_spent_this_round": 0, "armor_value": 0, "has_helmet": False,
        }

    def parse_ticks(self, wanted_props, ticks=None, players=None):
        if ticks is None:
            ticks = range(0, 8200, 8)
        rows = []
        for t in ticks:
            for sid, name in ((T_SID, "tee"), (CT_SID, "ceetee")):
                st = self._state(sid, int(t))
                row = {"tick": int(t), "steamid": sid, "name": name}
                # `buttons` is not networked on current builds: no column at all.
                row.update({p: st[p] for p in wanted_props if p in st})
                rows.append(row)
        return pd.DataFrame(rows)


@pytest.fixture
def fake_parser_cls(monkeypatch):
    import demoparser2

    monkeypatch.setattr(demoparser2, "DemoParser", FakeParser)
    return FakeParser


def _parse_fake() -> pd.DataFrame:
    dp = DemoParser()
    dp._dp_cls = FakeParser
    return dp.parse_demo(Path("fake_inferno.dem"))


# ---------------------------------------------------------------------------
# Projectile segmentation
# ---------------------------------------------------------------------------

def test_projectile_segments_split_recycled_entities():
    segs = _projectile_segments(FakeParser().parse_grenades())
    firsts = segs.groupby("seg").first().sort_values("tick")
    assert firsts["tick"].tolist() == [500, 1000, 2000, 3000, 5000, 6000, 7000]
    assert firsts["grenade_type"].tolist() == [
        "smokegrenade", "smokegrenade", "smokegrenade", "smokegrenade",
        "hegrenade", "molotov", "hegrenade",
    ]
    assert segs["x"].notna().all()


@pytest.mark.parametrize(
    "counters,expected",
    [
        ([1, 2, 3], [True, True, True]),
        ([1, 1, 2, 3], [False, True, True, True]),           # pre-live round + restart
        ([1, 2, 3, 2, 3, 4], [True, False, False, True, True, True]),  # backup restore
        ([1, 2, 3, 1, 2], [False, False, False, True, True]),  # full restart mid-demo
        ([1, None, 3], [True, True, True]),                    # unknown counter: keep
        ([], []),
    ],
)
def test_live_round_mask(counters, expected):
    assert live_round_mask(counters) == expected


def test_sample_round_state_reads_scoreboard():
    state = _sample_round_state(FakeParser(), [900, 4000, 8000])
    assert state["counters"] == [1, 1, 2]
    assert state["final_score"] == {"T": 1, "CT": 1}
    assert state["team_names"] == {"T": "Alpha", "CT": "Bravo"}


# ---------------------------------------------------------------------------
# Throw synthesis through the full lineup pipeline
# ---------------------------------------------------------------------------

def test_parse_demo_synthesises_throws_without_grenade_thrown():
    df = _parse_fake()

    # Pre-live smoke (round wiped) and death-dropped HE are gone.
    assert df["tick"].tolist() == [1000, 2000, 3000, 5000, 6000]
    assert df["grenade_type"].tolist() == [
        "smokegrenade", "smokegrenade", "smokegrenade", "hegrenade", "molotov",
    ]
    assert df["map_name"].unique().tolist() == ["de_inferno"]

    # Live rounds renumbered 1..N, winners from the matching round_end.
    assert df["round_number"].tolist() == [1, 1, 1, 2, 2]
    assert df["round_winner"].tolist() == ["CT", "CT", "CT", "T", "T"]

    # Player state comes from the tick BEFORE release (grenade_thrown semantics).
    t_rows = df[df["thrower_steamid"] == str(T_SID)]
    assert t_rows["throw_x"].tolist() == [100.0 + t - 1 for t in (1000, 2000, 3000)]
    assert (t_rows["pitch"] == -12.5).all() and (t_rows["yaw"] == 90.0).all()
    assert (t_rows["team_num"] == 2).all()
    assert (t_rows["thrower_name"] == "tee").all()
    assert set(df["thrower_steamid"]) == {str(T_SID), str(CT_SID)}

    # Velocity re-derived from positions (64 u/s), not the sparse velocity prop.
    assert (t_rows["throw_technique"] == "stand").all()  # 64 u/s < run threshold
    # Click from throw strength since the button mask is missing.
    assert df["click_type"].tolist() == ["left", "left", "left", "right", "right"]

    # Landings matched by thrower + type; the HE/molotov have no detonate events.
    assert df["land_x"].iloc[:3].tolist() == [190.0, 590.0, 690.0]
    assert df["land_x"].iloc[3:].isna().all()

    # Trajectories attached per lifetime, trimmed at the landing.
    trajs = df["trajectory"].tolist()
    assert all(isinstance(t, list) and len(t) >= 2 for t in trajs)
    assert trajs[0][0] == [0.0, 5.0] and trajs[0][-1][0] <= 200.0
    assert trajs[1][0][0] == 100.0 and trajs[2][0][0] == 200.0  # recycled id split

    assert (df["utility_damage"] == 0.0).all()


def test_synthesised_weapon_labels_incendiary():
    dp = DemoParser()
    raw = dp._synthesise_throws_from_projectiles(FakeParser())
    by_tick = dict(zip(raw["tick"], raw["weapon"]))
    assert by_tick[6000] == "incgrenade"
    assert by_tick[1000] == "smokegrenade"
    assert 7000 not in by_tick  # death drop


# ---------------------------------------------------------------------------
# Timeline: restarted rounds + final score
# ---------------------------------------------------------------------------

def test_timeline_drops_prelive_round_and_stores_score(fake_parser_cls):
    bundle = extract_match_timeline(Path("fake_inferno.dem"))
    rounds = bundle["rounds"]
    assert [r["num"] for r in rounds] == [1, 2]
    assert [r["end_tick"] for r in rounds] == [4000, 8000]
    assert rounds[0]["start_tick"] == 950
    assert bundle["final_score"] == {"T": 1, "CT": 1}
    assert bundle["team_names"] == {"T": "Alpha", "CT": "Bravo"}
    assert bundle["cache_version"] == dpmod.TIMELINE_CACHE_VERSION
    # Raw round_end markers are all kept (bomb-timer reset in the viewer).
    assert sum(e["type"] == "round_end" for e in bundle["events"]) == 3


def test_completeness_prefers_final_score():
    # A stray extra round makes side tracking say 13-10; the scoreboard wins.
    winners = ["T"] * 13 + ["CT"] * 10
    bundle = {
        "rounds": [{"num": i, "start_tick": i * 1000, "freeze_end_tick": i * 1000 + 100,
                    "end_tick": i * 1000 + 900, "winner": w} for i, w in enumerate(winners, 1)],
        "positions": {"ref": [{"t": 0, "tn": 2}]},
        "final_score": {"T": 13, "CT": 9},
    }
    assert assess_completeness(bundle) == {"complete": True, "score": [13, 9], "rounds": 23}

    bundle["final_score"] = {"T": 0, "CT": 0}  # unusable → fall back to side tracking
    assert assess_completeness(bundle)["score"] == [13, 10]


# ---------------------------------------------------------------------------
# Optional: real pro demo that still has grenade_thrown
# ---------------------------------------------------------------------------

OLD_DEMO = ROOT / "demos" / "2393224_mirage.dem"


@pytest.mark.skipif(not OLD_DEMO.exists(), reason="pro demo not available")
def test_synthesis_matches_grenade_thrown_on_old_demo():
    from demoparser2 import DemoParser as RealParser

    parser = RealParser(str(OLD_DEMO))
    dp = DemoParser()
    real = dp._finish_throw_rows(dp._parse_grenade_thrown_events(parser))
    syn = dp._finish_throw_rows(dp._synthesise_throws_from_projectiles(parser))

    m = real.merge(syn, on=["tick", "thrower_steamid"], suffixes=("_r", "_s"))
    assert len(m) == len(real)  # every real throw has a synthesised twin
    assert len(syn) - len(real) <= 2
    for col in ("throw_x", "throw_y", "throw_z", "pitch", "yaw",
                "throw_vel_x", "throw_vel_y", "throw_vel_z"):
        assert np.allclose(m[f"{col}_r"], m[f"{col}_s"], atol=1e-3), col
    assert (m["grenade_type_r"] == m["grenade_type_s"]).all()
    assert (m["team_num_r"].astype(int) == m["team_num_s"].astype(int)).all()
