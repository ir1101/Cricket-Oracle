import numpy as np
import pandas as pd
import pytest

from oracle.features import neutral_momentum, state_features
from oracle.models import OracleModel
from oracle.train import match_weighted_scores


def chases(n, rng):
    target = rng.integers(120, 230, n)
    balls = rng.integers(0, 119, n)
    wickets = rng.integers(0, 10, n)
    runs = np.minimum(rng.normal(balls * 1.35, 15).clip(0).round(), target - 1)
    recent_rr, recent_wickets = neutral_momentum(runs, balls, wickets)
    frame = state_features(runs, balls, wickets, 120, 170.0, recent_rr, recent_wickets, target)
    true_logit = 1.5 - 0.6 * (frame["required_run_rate"] - 8) + 0.4 * (frame["wickets_in_hand"] - 6)
    frame["y"] = (rng.random(n) < 1 / (1 + np.exp(-true_logit))).astype(int)
    frame["match_id"] = rng.integers(0, n // 100, n)
    return frame


def test_match_weighting_gives_every_match_the_same_total_weight():
    weights = OracleModel(2, match_weighted=True)._weights(pd.DataFrame({"match_id": [1, 1, 1, 2]}))
    assert weights[:3].sum() == pytest.approx(weights[3])


def test_refit_keeps_the_tuned_blend_calibrator_and_tree_count():
    rng = np.random.default_rng(3)
    train, val = chases(12_000, rng), chases(4_000, rng)
    model = OracleModel(2, competition_feature=False).fit(train, val)
    weight, calibrator, trees = model.weight, model.calibrator, model.trees

    model.refit(pd.concat([train, val], ignore_index=True))

    assert model.weight == weight
    assert model.calibrator is calibrator
    assert model.gbm.n_estimators == trees
    p = model.predict(val)
    assert ((p > 0) & (p < 1)).all()


def test_refit_with_calibration_seasons_relearns_blend_from_held_out_seasons():
    rng = np.random.default_rng(4)
    seasons = [chases(6_000, rng).assign(year=year) for year in (2020, 2021, 2022)]
    model = OracleModel(2, competition_feature=False).fit(seasons[0], seasons[1])
    calibrator = model.calibrator

    model.refit(pd.concat(seasons, ignore_index=True), calibration_seasons=[2021, 2022])

    assert model.calibrator is not calibrator
    assert 0 <= model.weight <= 1
    p = model.predict(seasons[2])
    assert ((p > 0) & (p < 1)).all()


def test_match_weighted_scores_count_each_match_once():
    part = pd.DataFrame({
        "match_id": [1, 1, 1, 2],
        "correct": [1.0, 1.0, 1.0, 0.0],
        "p": [0.8, 0.8, 0.8, 0.6],
        "y": [1, 1, 1, 0],
    })
    scores = match_weighted_scores(part)
    assert scores["matches"] == 2
    assert scores["accuracy"] == pytest.approx(0.5)
    assert match_weighted_scores(part.iloc[0:0])["accuracy"] is None
