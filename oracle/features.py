"""Innings-state features, leakage-free venue priors, and the season split."""
import numpy as np
import pandas as pd

from oracle import config

DEFAULT_PAR = 160.0  # league level before any match has been seen


def state_features(runs, balls, wickets, max_balls, venue_par, recent_run_rate, wickets_last_30, target=np.nan):
    """Model features for a batting side's state after a delivery.

    All arguments broadcast against each other. Chase columns are NaN where target is NaN.
    """
    runs, balls, wickets, max_balls, venue_par, recent_run_rate, wickets_last_30, target = np.broadcast_arrays(
        *(np.atleast_1d(np.asarray(a, dtype=float))
          for a in (runs, balls, wickets, max_balls, venue_par, recent_run_rate, wickets_last_30, target))
    )
    balls_remaining = np.clip(max_balls - balls, 0, None)
    current_run_rate = runs * 6 / np.maximum(balls, 1)

    # Early in an innings the current rate is noisy, so lean on the venue's par rate.
    trust = balls / (balls + config.MOMENTUM_WINDOW)
    par_rate = venue_par * 6 / config.BALLS_PER_INNINGS
    projected_total = runs + (trust * current_run_rate + (1 - trust) * par_rate) * balls_remaining / 6

    runs_required = target - runs
    required_run_rate = np.clip(runs_required * 6 / np.maximum(balls_remaining, 1), -36, 36)
    return pd.DataFrame({
        "balls_remaining": balls_remaining,
        "wickets_in_hand": np.clip(10 - wickets, 0, 10),
        "current_run_rate": current_run_rate,
        "recent_run_rate": recent_run_rate,
        "wickets_last_30": wickets_last_30,
        "venue_par": venue_par,
        "runs": runs,
        "projected_total": projected_total,
        "runs_vs_par": runs - venue_par * balls / config.BALLS_PER_INNINGS,
        "projected_vs_par": projected_total - venue_par,
        "runs_required": runs_required,
        "required_run_rate": required_run_rate,
        "rrr_minus_crr": required_run_rate - current_run_rate,
        "target": target,
        "target_vs_par": target - venue_par,
    })


def neutral_momentum(runs, balls, wickets):
    """Recent-form values for a hypothetical state, assuming an even pace so far."""
    runs, balls, wickets = (np.asarray(a, dtype=float) for a in (runs, balls, wickets))
    played = np.maximum(balls, 1)
    return runs * 6 / played, wickets * np.minimum(played, config.MOMENTUM_WINDOW) / played


def recent_momentum(group_key, runs_cum, balls_cum, wickets_cum):
    """Run rate and wickets over the last MOMENTUM_WINDOW legal balls of each innings.

    Rows must be sorted by group_key, then delivery order within the group.
    """
    key = np.asarray(group_key, dtype=np.int64)
    balls = np.asarray(balls_cum, dtype=np.int64)
    runs = np.asarray(runs_cum, dtype=float)
    wickets = np.asarray(wickets_cum, dtype=float)

    # A single sorted composite lets one searchsorted find each row's window start.
    stride = int(balls.max(initial=0)) + config.MOMENTUM_WINDOW + 1
    composite = key * stride + balls
    start = np.searchsorted(composite, composite - config.MOMENTUM_WINDOW, side="right") - 1
    safe = np.clip(start, 0, None)
    in_innings = (start >= 0) & (key[safe] == key)

    window_runs = runs - np.where(in_innings, runs[safe], 0)
    window_balls = balls - np.where(in_innings, balls[safe], 0)
    window_wickets = wickets - np.where(in_innings, wickets[safe], 0)
    return window_runs * 6 / np.maximum(window_balls, 1), window_wickets


def _ordered_levels(matches):
    """Matches in date order with each competition's scoring level from strictly earlier matches.

    Competitions score at very different levels, so each keeps its own recency-weighted level.
    """
    m = matches.sort_values(["date", "match_id"]).reset_index(drop=True)
    totals = m["first_innings_total"].astype(float)
    league = totals.groupby(m["competition"]).transform(
        lambda s: s.shift().ewm(halflife=config.LEAGUE_HALFLIFE_MATCHES).mean()
    ).fillna(DEFAULT_PAR)
    return m, totals, league


def venue_par_by_match(matches):
    """Each match's venue par, built only from strictly earlier matches.

    par = the competition's level + the venue's shrunk average offset from the level of whichever
    competition it was hosting, so grounds shared between competitions pool their evidence.
    """
    m, totals, league = _ordered_levels(matches)
    offset = totals - league
    by_venue = offset.groupby(m["venue"])
    earlier_sum = by_venue.cumsum() - offset
    earlier_n = by_venue.cumcount()
    par = league + earlier_sum / (earlier_n + config.VENUE_PRIOR_PSEUDOCOUNT)
    return pd.Series(par.to_numpy(), index=m["match_id"].to_numpy(), name="venue_par")


def venue_priors(matches, competition=config.TARGET_COMPETITION):
    """Pars for future matches in one competition at the venues it uses, from every match in the data."""
    m, totals, league_before = _ordered_levels(matches)
    in_competition = m["competition"] == competition
    level = float(totals[in_competition].ewm(halflife=config.LEAGUE_HALFLIFE_MATCHES).mean().iloc[-1])
    offsets = (totals - league_before).groupby(m["venue"]).agg(["sum", "count"])
    effect = offsets["sum"] / (offsets["count"] + config.VENUE_PRIOR_PSEUDOCOUNT)
    return {
        "league": round(level, 1),
        "venues": {venue: round(level + effect[venue], 1) for venue in sorted(m.loc[in_competition, "venue"].unique())},
    }


def season_split(years):
    seasons = sorted({int(y) for y in years})
    held_out = config.TEST_SEASONS + config.VAL_SEASONS
    if len(seasons) <= held_out:
        raise ValueError(f"need more than {held_out} seasons, got {len(seasons)}")
    return {
        "train": seasons[:-held_out],
        "val": seasons[-held_out:-config.TEST_SEASONS],
        "test": seasons[-config.TEST_SEASONS:],
    }


def build_states(matches, deliveries):
    """One row per delivery: the batting side's state after that ball, and whether it won."""
    m = matches.assign(venue_par=matches["match_id"].map(venue_par_by_match(matches)))
    cols = ["match_id", "competition", "date", "year", "team1", "team2", "winner", "target_runs", "max_balls", "venue_par"]
    d = deliveries.merge(m[cols], on="match_id").sort_values(["match_id", "innings", "seq"], ignore_index=True)

    by_innings = d.groupby(["match_id", "innings"], sort=False)
    d["runs_cum"] = by_innings["ball_runs"].cumsum()
    d["wickets_cum"] = by_innings["wicket"].cumsum()
    d["balls_cum"] = by_innings["legal"].cumsum().astype(int)
    recent_rr, recent_wickets = recent_momentum(
        d["match_id"] * 3 + d["innings"], d["runs_cum"], d["balls_cum"], d["wickets_cum"]
    )

    chasing = (d["innings"] == 2).to_numpy()
    features = state_features(
        runs=d["runs_cum"], balls=d["balls_cum"], wickets=d["wickets_cum"], max_balls=d["max_balls"],
        venue_par=d["venue_par"], recent_run_rate=recent_rr, wickets_last_30=recent_wickets,
        target=np.where(chasing, d["target_runs"], np.nan),
    )
    states = pd.concat([d, features.drop(columns="venue_par")], axis=1)
    states["batting_team"] = np.where(chasing, d["team2"], d["team1"])
    states["y"] = (states["batting_team"] == states["winner"]).astype(int)
    states["is_target"] = (states["competition"] == config.TARGET_COMPETITION).astype(float)
    states["terminal"] = chasing & (
        (states["runs_required"] <= 0) | (states["wickets_in_hand"] <= 0) | (states["balls_remaining"] <= 0)
    )
    return states
