import numpy as np
import pandas as pd
import pytest

from oracle import config
from oracle.features import (
    DEFAULT_PAR, recent_momentum, season_split, state_features, venue_par_by_match, venue_priors,
)

MATCHES = pd.DataFrame({
    "match_id": [1, 2, 3, 4],
    "competition": "ipl",
    "date": ["2020-04-01", "2020-04-02", "2020-04-03", "2020-04-04"],
    "venue": ["A", "B", "A", "A"],
    "first_innings_total": [150, 180, 200, 170],
})

MIXED = pd.DataFrame({
    "match_id": [1, 2, 3],
    "competition": ["ipl", "ipl", "bbl"],
    "date": ["2020-04-01", "2020-04-02", "2020-04-03"],
    "venue": ["A", "B", "A"],
    "first_innings_total": [200, 210, 150],
})


def test_each_competition_has_its_own_level_but_venues_share_evidence():
    par = venue_par_by_match(MIXED)
    # The BBL has no earlier matches, so it starts from the default level. Venue A played 40 above
    # its level in the IPL match, and that offset carries over, shrunk by the pseudocount.
    assert par[3] == pytest.approx(DEFAULT_PAR + 40 / (1 + config.VENUE_PRIOR_PSEUDOCOUNT))


def test_venue_priors_cover_only_target_venues_at_the_target_level():
    priors = venue_priors(MIXED)
    level = pd.Series([200.0, 210.0]).ewm(halflife=config.LEAGUE_HALFLIFE_MATCHES).mean().iloc[-1]
    assert set(priors["venues"]) == {"A", "B"}
    assert priors["league"] == pytest.approx(round(level, 1))


def test_venue_par_never_sees_the_current_or_later_matches():
    par = venue_par_by_match(MATCHES)
    changed = venue_par_by_match(MATCHES.assign(first_innings_total=[150, 180, 200, 999]))

    assert par[1] == DEFAULT_PAR
    assert np.allclose(par.loc[[1, 2, 3, 4]], changed.loc[[1, 2, 3, 4]])


def test_first_visit_to_a_venue_uses_the_league_level():
    par = venue_par_by_match(MATCHES)
    assert par[2] == pytest.approx(150.0)  # only match 1 has been seen, and venue B is new


def test_recent_momentum_uses_last_30_legal_balls_within_an_innings():
    # Innings 1: a wide, 10 dot balls (a wicket on the 5th), then 30 balls of 2 runs each.
    ball_runs = np.array([1] + [0] * 10 + [2] * 30)
    legal = np.array([0] + [1] * 40)
    wickets = np.zeros(41)
    wickets[5] = 1
    # Innings 2: five singles, which must not inherit innings 1 history.
    ball_runs = np.concatenate([ball_runs, np.ones(5)])
    legal = np.concatenate([legal, np.ones(5)])
    wickets = np.concatenate([wickets, np.zeros(5)])
    key = np.array([1] * 41 + [2] * 5)

    cum = lambda a: pd.Series(a).groupby(key).cumsum().to_numpy()  # noqa: E731
    rate, recent_wickets = recent_momentum(key, cum(ball_runs), cum(legal), cum(wickets))

    assert rate[10] == pytest.approx(0.6)  # 1 run from 10 legal balls
    assert recent_wickets[10] == 1
    assert rate[40] == pytest.approx(12.0)  # last 30 balls all went for two
    assert recent_wickets[40] == 0
    assert rate[-1] == pytest.approx(6.0)


def test_chase_features():
    f = state_features(runs=100, balls=90, wickets=4, max_balls=120, venue_par=170,
                       recent_run_rate=8, wickets_last_30=1, target=160).iloc[0]
    assert f["runs_required"] == 60
    assert f["balls_remaining"] == 30
    assert f["wickets_in_hand"] == 6
    assert f["required_run_rate"] == pytest.approx(12.0)
    assert f["rrr_minus_crr"] == pytest.approx(12.0 - 100 * 6 / 90)
    assert f["target_vs_par"] == -10


def test_season_split_holds_out_latest_seasons():
    split = season_split([2019, 2020, 2021, 2022, 2023, 2023])
    assert split == {"train": [2019, 2020], "val": [2021, 2022], "test": [2023]}
