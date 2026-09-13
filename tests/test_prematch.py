import math

import numpy as np
import pandas as pd
import pytest

from oracle.prematch import BASE_RATING, PrematchModel, fit_scale, replay_ratings

MATCHES = pd.DataFrame({
    "match_id": [1, 2, 3, 4],
    "competition": ["ipl", "ipl", "ipl", "bbl"],
    "date": ["2020-04-01", "2020-04-05", "2021-04-01", "2021-01-01"],
    "year": [2020, 2020, 2021, 2021],
    "team1": ["A", "B", "A", "A"],
    "team2": ["B", "A", "B", "C"],
    "winner": ["A", "A", "B", "C"],
})


def test_ratings_follow_results_and_stay_within_a_competition():
    gaps, table = replay_ratings(MATCHES, k=16, carry=1.0)
    ipl = table[table["competition"] == "ipl"].set_index("team")["rating"]

    assert gaps.loc[1] == 0
    assert gaps.loc[2] == pytest.approx(-16)  # B lost the first match, so starts 16 points behind A
    assert ipl.sum() == pytest.approx(2 * BASE_RATING)  # Elo is zero-sum
    assert gaps.loc[4] == 0  # the BBL's "A" is a different side from the IPL's "A"


def test_season_carry_pulls_ratings_back_toward_the_base():
    halved, _ = replay_ratings(MATCHES, k=16, carry=0.5)
    kept, _ = replay_ratings(MATCHES, k=16, carry=1.0)
    assert halved.loc[3] == pytest.approx(kept.loc[3] * 0.5)


def test_fit_scale_is_positive_when_higher_ratings_win_more():
    gaps = np.linspace(-300, 300, 400)
    rng = np.random.default_rng(1)
    won = (rng.random(400) < 1 / (1 + np.exp(-gaps / 150))).astype(int)
    assert fit_scale(gaps, won) > 0


PAYLOAD = {
    "scale": 0.8,
    "season_carry": 0.5,
    "as_of": "2026-05-31",
    "ratings": [
        {"competition": "ipl", "team": "Punjab Kings", "rating": 1600.0, "matches": 40, "last_season": 2026},
        {"competition": "ipl", "team": "Mumbai Indians", "rating": 1500.0, "matches": 60, "last_season": 2026},
        {"competition": "t20i", "team": "India", "rating": 1650.0, "matches": 90, "last_season": 2026},
    ],
}


def test_predictions_use_normalised_names_and_are_symmetric():
    model = PrematchModel(PAYLOAD)
    forward = model.predict("Kings XI Punjab", "Mumbai Indians", "ipl", season=2026)
    backward = model.predict("Mumbai Indians", "Punjab Kings", "ipl", season=2026)

    assert forward["p_team1"] == pytest.approx(1 / (1 + math.exp(-0.8)), abs=1e-4)
    assert forward["p_team1"] + backward["p_team1"] == pytest.approx(1, abs=1e-4)


def test_saint_and_st_spellings_match():
    payload = {**PAYLOAD, "ratings": PAYLOAD["ratings"] + [
        {"competition": "cpl", "team": "St Lucia Kings", "rating": 1520.0, "matches": 58, "last_season": 2026},
    ]}
    assert PrematchModel(payload).rating("Saint Lucia Kings", "cpl")["team"] == "St Lucia Kings"


def test_unknown_teams_get_no_prediction_and_new_seasons_regress():
    model = PrematchModel(PAYLOAD)
    assert model.predict("Nepal", "India") is None
    assert model.predict("Punjab Kings", "Mumbai Indians", "ipl", season=2027)["rating1"] == 1550
