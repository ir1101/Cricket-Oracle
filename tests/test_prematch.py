import math

import numpy as np
import pandas as pd
import pytest

from oracle.prematch import (
    BASE_RATING,
    PrematchModel,
    competition_slopes,
    fit_weights,
    net_run_rate_margins,
    replay_margins,
    replay_ratings,
)

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


def innings(match_id, number, runs_per_ball, balls, wickets=0):
    return pd.DataFrame({
        "match_id": match_id,
        "innings": number,
        "ball_runs": runs_per_ball,
        "legal": True,
        "wicket_kind": ["caught" if i < wickets else "" for i in range(balls)],
    })


def test_net_run_rate_margin_charges_a_bowled_out_side_its_full_overs():
    matches = pd.DataFrame({"match_id": [1, 2, 3], "max_balls": [120, 120, 120]})
    deliveries = pd.concat([
        innings(1, 1, 1, 12), innings(1, 2, 1, 6, wickets=1),  # 6 an over v 6 an over
        innings(2, 1, 1, 6), innings(2, 2, 0, 10, wickets=10),  # 6 an over v bowled out for 0
        innings(3, 1, 6, 6), innings(3, 2, 0, 6),  # 36 an over v 0: clipped
    ], ignore_index=True)
    wide = pd.DataFrame({"match_id": [1], "innings": [2], "ball_runs": [1], "legal": [False], "wicket_kind": [""]})
    margins = net_run_rate_margins(matches, pd.concat([deliveries, wide], ignore_index=True))

    assert margins.loc[1] == pytest.approx(6 - 7)  # the wide adds a run but not a ball
    assert margins.loc[2] == pytest.approx(6)
    assert margins.loc[3] == pytest.approx(8)


def test_margin_ratings_move_toward_observed_margins_and_stay_zero_sum():
    margins = pd.Series([4.0, 2.0, -1.0, 3.0], index=MATCHES["match_id"])
    gaps, table = replay_margins(MATCHES, margins, k=0.1, carry=1.0)
    ipl = table[table["competition"] == "ipl"].set_index("team")["margin"]

    assert gaps.loc[1] == 0
    assert gaps.loc[2] == pytest.approx(-0.8)  # A rose 0.4 and B fell 0.4 after A won the margin by 4
    assert ipl.sum() == pytest.approx(0)
    halved, _ = replay_margins(MATCHES, margins, k=0.1, carry=0.5)
    kept, _ = replay_margins(MATCHES, margins, k=0.1, carry=1.0)
    assert halved.loc[3] == pytest.approx(kept.loc[3] * 0.5)


def test_fit_weights_are_positive_when_bigger_gaps_win_more():
    rng = np.random.default_rng(1)
    X = rng.normal(size=(2000, 2))
    won = (rng.random(2000) < 1 / (1 + np.exp(-(0.8 * X[:, 0] + 0.4 * X[:, 1])))).astype(int)
    weights = fit_weights(X, won)
    assert weights[0] > weights[1] > 0


def test_competition_slopes_trust_signal_and_zero_out_noise():
    rng = np.random.default_rng(2)
    n = 1500
    logits = rng.normal(size=3 * n)
    competitions = np.array(["signal"] * n + ["noise"] * n + ["new"] * n)
    years = np.array([2024] * (2 * n) + [2025] * 10 + [2020] * (n - 10))
    won = np.where(
        competitions == "signal",
        rng.random(3 * n) < 1 / (1 + np.exp(-logits)),
        rng.random(3 * n) < 0.5,
    ).astype(int)
    slopes = competition_slopes(logits, won, competitions, years, season=2026, window=5, C=0.05)

    assert slopes["signal"] > 0.7
    assert slopes["noise"] < 0.2
    assert slopes["new"] == 1.0  # only 10 matches in the window


PAYLOAD = {
    "weights": {"elo": 0.4, "margin": 0.2},
    "slopes": {"ipl": 1.0, "psl": 0.0},
    "season_carry": 0.5,
    "margin_season_carry": 0.5,
    "as_of": "2026-05-31",
    "ratings": [
        {"competition": "ipl", "team": "Punjab Kings", "rating": 1600.0, "margin": 1.0, "matches": 40, "last_season": 2026},
        {"competition": "ipl", "team": "Mumbai Indians", "rating": 1500.0, "margin": -1.0, "matches": 60, "last_season": 2026},
        {"competition": "t20i", "team": "India", "rating": 1650.0, "margin": 2.0, "matches": 90, "last_season": 2026},
        {"competition": "psl", "team": "Lahore Qalandars", "rating": 1580.0, "margin": 0.5, "matches": 80, "last_season": 2026},
        {"competition": "psl", "team": "Karachi Kings", "rating": 1450.0, "margin": -0.5, "matches": 80, "last_season": 2026},
    ],
}


def test_predictions_use_normalised_names_and_are_symmetric():
    model = PrematchModel(PAYLOAD)
    forward = model.predict("Kings XI Punjab", "Mumbai Indians", "ipl", season=2026)
    backward = model.predict("Mumbai Indians", "Punjab Kings", "ipl", season=2026)

    assert forward["p_team1"] == pytest.approx(1 / (1 + math.exp(-(0.4 * 1 + 0.2 * 2))), abs=1e-4)
    assert forward["p_team1"] + backward["p_team1"] == pytest.approx(1, abs=1e-4)


def test_a_competition_with_no_recent_signal_gets_even_odds():
    prediction = PrematchModel(PAYLOAD).predict("Lahore Qalandars", "Karachi Kings", "psl", season=2026)
    assert prediction["p_team1"] == 0.5
    assert prediction["slope"] == 0.0


def test_saint_and_st_spellings_match():
    payload = {**PAYLOAD, "ratings": PAYLOAD["ratings"] + [
        {"competition": "cpl", "team": "St Lucia Kings", "rating": 1520.0, "margin": 0.0, "matches": 58, "last_season": 2026},
    ]}
    assert PrematchModel(payload).rating("Saint Lucia Kings", "cpl")["team"] == "St Lucia Kings"


def test_unknown_or_cross_competition_teams_get_no_prediction_and_new_seasons_regress():
    model = PrematchModel(PAYLOAD)
    assert model.predict("Nepal", "India") is None
    assert model.predict("India", "Mumbai Indians") is None  # ratings from different competitions don't compare
    next_season = model.predict("Punjab Kings", "Mumbai Indians", "ipl", season=2027)
    assert next_season["rating1"] == 1550
    assert next_season["margin1"] == 0.5
