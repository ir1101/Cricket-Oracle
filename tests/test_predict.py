import numpy as np
import pytest

from oracle import config
from oracle.features import neutral_momentum, state_features
from oracle.models import OracleModel
from oracle.predict import Oracle


def synthetic_chases(n, rng):
    target = rng.integers(120, 230, n)
    balls = rng.integers(0, 119, n)
    wickets = rng.integers(0, 10, n)
    runs = np.minimum(rng.normal(balls * 1.35, 15).clip(0).round(), target - 1)
    recent_rr, recent_wickets = neutral_momentum(runs, balls, wickets)
    f = state_features(runs, balls, wickets, 120, 170.0, recent_rr, recent_wickets, target)
    true_logit = 1.5 - 0.6 * (f["required_run_rate"] - 8) + 0.4 * (f["wickets_in_hand"] - 6)
    f["y"] = (rng.random(n) < 1 / (1 + np.exp(-true_logit))).astype(int)
    return f


@pytest.fixture(scope="module")
def oracle():
    rng = np.random.default_rng(0)
    model = OracleModel(2, competition_feature=False).fit(synthetic_chases(30_000, rng), synthetic_chases(8_000, rng))
    return Oracle({2: model}, {"league": 170.0, "venues": {}})


def test_heatmap_is_monotone_in_runs_required_and_balls_remaining(oracle):
    grid = oracle.heatmap_grid(target=180, wickets_in_hand=6)
    p = np.array([[np.nan if v is None else v for v in row] for row in grid["p"]])

    assert p.shape == (180, 120)
    finite = p[~np.isnan(p)]
    assert ((finite >= 0) & (finite <= 1)).all()
    with np.errstate(invalid="ignore"):
        assert (np.nan_to_num(np.diff(p, axis=0), nan=0) <= 1e-3).all()  # more runs needed: never easier
        assert (np.nan_to_num(np.diff(p, axis=1), nan=0) >= -1e-3).all()  # more balls left: never harder


def test_more_wickets_in_hand_never_hurts(oracle):
    p = [oracle.predict_one(2, runs=120, balls=90, wickets=10 - w, target=170) for w in range(1, 11)]
    assert all(b >= a - 1e-3 for a, b in zip(p, p[1:]))


def test_finished_chases_are_certain(oracle):
    assert oracle.predict_one(2, runs=170, balls=100, wickets=5, target=170) == 1.0
    assert oracle.predict_one(2, runs=150, balls=120, wickets=5, target=170) == 0.0
    assert oracle.predict_one(2, runs=150, balls=100, wickets=10, target=170) == 0.0


def test_unreachable_heatmap_cells_are_blank(oracle):
    grid = oracle.heatmap_grid(target=180, wickets_in_hand=10)
    # 1 run required with all 120 balls left would mean 179 runs off zero balls.
    assert grid["p"][0][config.BALLS_PER_INNINGS - 1] is None
    assert grid["p"][179][config.BALLS_PER_INNINGS - 1] is not None
