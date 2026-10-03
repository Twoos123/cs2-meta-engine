import pytest

from backend.analysis.validation import assess_completeness, is_finished


@pytest.mark.parametrize(
    "w,l,expected",
    [
        (13, 0, True),
        (13, 11, True),
        (7, 5, False),     # split demo, first half only
        (5, 0, False),
        (12, 12, False),   # going to overtime
        (13, 12, False),   # impossible in MR12 — must go to 12:12 → OT
        (16, 12, True),    # OT won 4-0
        (16, 14, True),
        (15, 15, False),   # second OT pending
        (19, 17, True),
        (17, 15, False),
    ],
)
def test_is_finished(w, l, expected):
    assert is_finished(w, l) is expected
    assert is_finished(l, w) is expected  # argument order doesn't matter


def _bundle(winners: list[str]) -> dict:
    """Timeline where one player is T for rounds 1-12 and CT afterwards."""
    rounds, samples = [], []
    for i, winner in enumerate(winners, start=1):
        start = i * 1000
        rounds.append({"num": i, "start_tick": start, "freeze_end_tick": start + 100,
                       "end_tick": start + 900, "winner": winner})
        samples.append({"t": start, "tn": 2 if i <= 12 else 3})
    return {"rounds": rounds, "positions": {"ref": samples}}


def test_completeness_follows_side_swap():
    # Team A (starts T) wins 7 T rounds, then all 6 CT rounds after halftime.
    winners = ["T"] * 7 + ["CT"] * 5 + ["CT"] * 6
    out = assess_completeness(_bundle(winners))
    assert out == {"complete": True, "score": [13, 5], "rounds": 18}


def test_completeness_flags_partial_demo():
    out = assess_completeness(_bundle(["T"] * 7 + ["CT"] * 5))
    assert out["complete"] is False
    assert out["score"] == [7, 5]


def test_completeness_unknown_without_team_info():
    bundle = _bundle(["T"] * 13)
    for s in bundle["positions"]["ref"]:
        del s["tn"]
    assert assess_completeness(bundle)["complete"] is None


@pytest.mark.parametrize(
    "raw,expected",
    [("TopofMid", "Top of Mid"), ("BApartments", "B Apartments"),
     ("CTSpawn", "CT Spawn"), ("Roof", "Roof")],
)
def test_callout_humanize(raw, expected):
    from backend.analysis.callouts import humanize

    assert humanize(raw) == expected
