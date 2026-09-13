import json
from pathlib import Path

import pytest

from oracle.ingest import normalize_venue, overs_to_balls, parse_match

FIXTURE = Path(__file__).parent / "fixtures" / "sample_match.json"


def load_fixture():
    return json.loads(FIXTURE.read_text())


def test_parse_counts_legal_balls_runs_and_dismissals():
    match, rows = parse_match(1, load_fixture())
    first = [r for r in rows if r["innings"] == 1]

    assert len(first) == 6
    assert sum(r["legal"] for r in first) == 4  # the wide and the no-ball are not legal
    assert sum(r["ball_runs"] for r in first) == 13
    assert sum(r["wicket"] for r in first) == 1  # retired hurt is not a dismissal
    assert [r["label"] for r in first] == ["0.1", "0.2", "0.2", "0.3", "0.3", "0.4"]
    assert match["first_innings_total"] == 13
    assert match["target_runs"] == 14
    assert match["max_balls"] == 120


def test_parse_normalizes_names_and_describes_result():
    match, _ = parse_match(1, load_fixture())

    assert match["venue"] == "M Chinnaswamy Stadium"
    assert match["team1"] == match["winner"] == "Royal Challengers Bengaluru"
    assert match["team2"] == "Punjab Kings"
    assert match["stage"] == "Match 7"
    assert match["margin"] == "11 runs"


@pytest.mark.parametrize("outcome", [
    {"result": "no result"},
    {"result": "tie", "eliminator": "Kings XI Punjab"},
    {"winner": "Kings XI Punjab", "by": {"runs": 3}, "method": "D/L"},
])
def test_matches_without_a_clean_result_are_excluded(outcome):
    data = load_fixture()
    data["info"]["outcome"] = outcome
    assert parse_match(1, data) is None


@pytest.mark.parametrize("key, value", [("gender", "female"), ("overs", 50), ("balls_per_over", 5)])
def test_only_mens_20_over_six_ball_matches_are_kept(key, value):
    data = load_fixture()
    data["info"][key] = value
    assert parse_match(1, data) is None


def test_t20is_are_kept_only_between_full_members():
    data = load_fixture()
    data["info"]["teams"] = ["Nepal", "India"]
    assert parse_match(1, data, "t20i") is None

    data["info"]["teams"] = ["Australia", "India"]
    match, _ = parse_match(1, data, "t20i")
    assert match["competition"] == "t20i"


def test_super_over_innings_are_ignored():
    data = load_fixture()
    data["innings"].append({"team": "Kings XI Punjab", "super_over": True, "overs": []})
    _, rows = parse_match(1, data)
    assert {r["innings"] for r in rows} == {1, 2}


def test_reduced_overs_target_sets_innings_length():
    data = load_fixture()
    data["innings"][1]["target"] = {"overs": 17.3, "runs": 150}
    match, _ = parse_match(1, data)
    assert match["max_balls"] == overs_to_balls(17.3) == 105


@pytest.mark.parametrize("raw, expected", [
    ("M.Chinnaswamy Stadium", "M Chinnaswamy Stadium"),
    ("MA Chidambaram Stadium, Chepauk, Chennai", "MA Chidambaram Stadium"),
    ("Feroz Shah Kotla", "Arun Jaitley Stadium"),
    ("Punjab Cricket Association Stadium, Mohali", "Punjab Cricket Association IS Bindra Stadium"),
    ("Dr. Y.S. Rajasekhara Reddy ACA-VDCA Cricket Stadium", "Dr Y S Rajasekhara Reddy ACA-VDCA Cricket Stadium"),
    ("Dr. Y.S. Rajasekhara Reddy ACA VDCA Cricket Stadium, Visakhapatnam", "Dr Y S Rajasekhara Reddy ACA-VDCA Cricket Stadium"),
    ("Holkar Stadium, Indore", "Holkar Cricket Stadium"),
    ("The Wanderers Stadium, Johannesburg", "New Wanderers Stadium"),
])
def test_normalize_venue(raw, expected):
    assert normalize_venue(raw) == expected
