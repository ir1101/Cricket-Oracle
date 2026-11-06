"""Pre-match win probabilities from team ratings, recalibrated per competition.

    python -m oracle.prematch   # rebuild ratings, score the held-out matches, write models/prematch.json

Each team gets two ratings within each competition: Elo on results, and a margin rating that tracks its
net run rate edge. A symmetric logistic on the two gaps gives a base logit. Each competition then scales
that logit by a slope learned from its recent out-of-sample predictions. A slope of 0 means past results
haven't predicted that competition's winners lately (the IPL since 2023), so its odds stay at 50-50.
"""
import json
import math
import re

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from oracle import config
from oracle.evaluate import score
from oracle.ingest import normalize_team

BASE_RATING = 1500.0
MARGIN_CLIP = 8.0  # runs per over, so one rout can't swing a rating


def replay_ratings(matches, k=config.ELO_K, carry=config.ELO_SEASON_CARRY):
    """Walk matches in date order, updating Elo ratings after each result.

    Ratings are kept per (competition, team) because club sides never meet across leagues.
    Returns the pre-match rating gap (team1 minus team2) for every match, and the final table.
    """
    m = matches.sort_values(["date", "match_id"])
    ratings, played, season = {}, {}, {}
    gaps = np.empty(len(m))
    for i, r in enumerate(m.itertuples(index=False)):
        keys = ((r.competition, r.team1), (r.competition, r.team2))
        for key in keys:
            if key in season and season[key] != r.year:
                ratings[key] = BASE_RATING + carry * (ratings[key] - BASE_RATING)
            season[key] = r.year
        a, b = (ratings.get(key, BASE_RATING) for key in keys)
        gaps[i] = a - b
        expected = 1 / (1 + 10 ** (-(a - b) / 400))
        change = k * (float(r.winner == r.team1) - expected)
        ratings[keys[0]], ratings[keys[1]] = a + change, b - change
        for key in keys:
            played[key] = played.get(key, 0) + 1

    table = pd.DataFrame(
        [(c, t, rating, played[(c, t)], season[(c, t)]) for (c, t), rating in ratings.items()],
        columns=["competition", "team", "rating", "matches", "last_season"],
    )
    return pd.Series(gaps, index=m["match_id"].to_numpy()), table


def net_run_rate_margins(matches, deliveries):
    """The side batting first's run rate minus the chasing side's, in runs per over, per match_id.

    As in net run rate, a side bowled out is charged its full allotment of balls.
    """
    d = deliveries.assign(out=(deliveries["wicket_kind"] != "").astype(int))
    innings = d.groupby(["match_id", "innings"]).agg(runs=("ball_runs", "sum"), balls=("legal", "sum"), wickets=("out", "sum"))
    innings = innings.reset_index().merge(matches[["match_id", "max_balls"]], on="match_id")
    balls = np.where(innings["wickets"] >= 10, innings["max_balls"], innings["balls"]).clip(1)
    innings["rpo"] = innings["runs"] / balls * 6
    rpo = innings.pivot(index="match_id", columns="innings", values="rpo")
    return (rpo[1] - rpo[2]).clip(-MARGIN_CLIP, MARGIN_CLIP).reindex(matches["match_id"]).fillna(0.0)


def replay_margins(matches, margins, k=config.MARGIN_K, carry=config.MARGIN_SEASON_CARRY):
    """Walk matches in date order, tracking each team's expected run rate edge within its competition.

    After each match both sides move k times the gap between the observed and expected margin.
    Returns the pre-match margin gap (team1 minus team2) for every match, and the final table.
    """
    m = matches.sort_values(["date", "match_id"])
    observed = margins.reindex(m["match_id"]).to_numpy()
    ratings, season = {}, {}
    gaps = np.empty(len(m))
    for i, r in enumerate(m.itertuples(index=False)):
        keys = ((r.competition, r.team1), (r.competition, r.team2))
        for key in keys:
            if key in season and season[key] != r.year:
                ratings[key] *= carry
            season[key] = r.year
        a, b = (ratings.get(key, 0.0) for key in keys)
        gaps[i] = a - b
        change = k * (observed[i] - (a - b))
        ratings[keys[0]], ratings[keys[1]] = a + change, b - change

    table = pd.DataFrame([(c, t, margin) for (c, t), margin in ratings.items()], columns=["competition", "team", "margin"])
    return pd.Series(gaps, index=m["match_id"].to_numpy()), table


def features(elo_gaps, margin_gaps):
    return np.column_stack([np.asarray(elo_gaps, dtype=float) / 100, np.asarray(margin_gaps, dtype=float)])


def fit_weights(X, team1_won, C=1e4):
    """Logistic weights without an intercept, fitted on every match seen from both sides.

    Who is listed first is arbitrary (in Cricsheet it is the side batting first), so the fit is symmetric.
    """
    X, won = np.asarray(X, dtype=float), np.asarray(team1_won)
    model = LogisticRegression(fit_intercept=False, C=C).fit(np.vstack([X, -X]), np.concatenate([won, 1 - won]))
    return model.coef_[0]


def probability(logit):
    return 1 / (1 + np.exp(-np.asarray(logit, dtype=float)))


def walk_forward_logits(X, won, years, first):
    """Base logits for every season from `first` on, each from weights fitted only on earlier seasons."""
    logits = np.full(len(years), np.nan)
    for season in sorted(set(years[years >= first])):
        train = years < season
        logits[years == season] = X[years == season] @ fit_weights(X[train], won[train])
    return logits


def competition_slopes(logits, won, competitions, years, season,
                       window=config.PREMATCH_RECAL_SEASONS, C=config.PREMATCH_RECAL_C):
    """How far to trust the base logit in each competition when predicting `season`.

    Fitted on the competition's out-of-sample logits from the previous `window` seasons. The penalty pulls
    thin evidence toward 0 (50-50), and a negative fit is treated as 0. With under 20 such matches the
    base logit is used as it is.
    """
    slopes = {}
    for competition in sorted(set(competitions)):
        rows = (competitions == competition) & (years < season) & (years >= season - window) & ~np.isnan(logits)
        if rows.sum() < 20:
            slopes[competition] = 1.0
        else:
            slopes[competition] = max(float(fit_weights(logits[rows][:, None], won[rows], C)[0]), 0.0)
    return slopes


def build(matches, deliveries):
    """Score the held-out seasons walk-forward, then fit the serving model on everything."""
    m = matches.sort_values(["date", "match_id"]).reset_index(drop=True)
    elo_gaps, elo_table = replay_ratings(m)
    margin_gaps, margin_table = replay_margins(m, net_run_rate_margins(m, deliveries))
    X = features(elo_gaps.to_numpy(), margin_gaps.to_numpy())
    won = (m["winner"] == m["team1"]).to_numpy().astype(int)
    years = m["year"].to_numpy()
    competitions = m["competition"].to_numpy()
    window = config.PREMATCH_RECAL_SEASONS
    test_year = int(config.PREMATCH_TEST_START[:4])
    first = max(test_year - 2 * window, int(years.min()) + 1)

    logits = walk_forward_logits(X, won, years, first)
    elo_logits = walk_forward_logits(X[:, :1], won, years, first)
    held_out = years >= test_year
    p = np.full(len(m), 0.5)
    for season in sorted(set(years[held_out])):
        rows = years == season
        slopes = competition_slopes(logits, won, competitions, years, season)
        p[rows] = probability(logits[rows] * np.array([slopes[c] for c in competitions[rows]]))
    p_elo = probability(elo_logits)

    in_target = competitions == config.TARGET_COMPETITION

    def section(pred):
        return {
            name: {"matches": int(mask.sum()), **score(won[mask], pred[mask]), "coin_flip_log_loss": round(math.log(2), 4)}
            for name, mask in (("all_competitions", held_out), (config.TARGET_COMPETITION, held_out & in_target))
        }

    latest = int(years.max())
    slopes = competition_slopes(logits, won, competitions, years, season=latest + 1)
    target_history = {
        season: round(competition_slopes(logits, won, competitions, years, season)[config.TARGET_COMPETITION], 3)
        for season in range(test_year - window, latest + 2)
    }
    report = {
        "test_start": config.PREMATCH_TEST_START,
        **section(p),
        "elo_only": section(p_elo),
        "slopes": {c: round(s, 3) for c, s in slopes.items()},
        "target_slopes_by_season": target_history,
    }

    weights = fit_weights(X, won)
    table = elo_table.merge(margin_table, on=["competition", "team"])
    payload = {
        "k": config.ELO_K,
        "season_carry": config.ELO_SEASON_CARRY,
        "margin_k": config.MARGIN_K,
        "margin_season_carry": config.MARGIN_SEASON_CARRY,
        "weights": {"elo": float(weights[0]), "margin": float(weights[1])},
        "slopes": report["slopes"],
        "as_of": str(m["date"].max()),
        "ratings": table.assign(rating=table["rating"].round(1), margin=table["margin"].round(3)).to_dict("records"),
    }
    return payload, report


def _name_key(team):
    key = re.sub(r"[^a-z0-9]+", " ", normalize_team(team).casefold()).strip()
    return re.sub(r"\bsaint\b", "st", key)  # fixtures say "Saint Lucia Kings", Cricsheet "St Lucia Kings"


class PrematchModel:
    def __init__(self, payload):
        self.weights = payload["weights"]
        self.slopes = payload["slopes"]
        self.carry = payload["season_carry"]
        self.margin_carry = payload["margin_season_carry"]
        self.as_of = payload["as_of"]
        self._by_name = {}
        for row in sorted(payload["ratings"], key=lambda r: r["last_season"], reverse=True):
            self._by_name.setdefault(_name_key(row["team"]), []).append(row)

    @classmethod
    def load(cls, path=config.PREMATCH_PATH):
        return cls(json.loads(path.read_text()))

    def rating(self, team, competition=None):
        """The team's rating row, preferring the given competition, then its most recent one."""
        rows = self._by_name.get(_name_key(team), [])
        preferred = [row for row in rows if row["competition"] == competition]
        return (preferred or rows or [None])[0]

    def _current(self, row, season):
        """(Elo, margin) for `season`, pulled toward the base the way a new season does in the replay."""
        if season is None or season == row["last_season"]:
            return row["rating"], row["margin"]
        return BASE_RATING + self.carry * (row["rating"] - BASE_RATING), self.margin_carry * row["margin"]

    def predict(self, team1, team2, competition=None, season=None):
        """P(team1 beats team2), or None unless both sides have ratings in the same competition."""
        a, b = self.rating(team1, competition), self.rating(team2, competition)
        if a is None or b is None or a["competition"] != b["competition"]:
            return None
        (rating1, margin1), (rating2, margin2) = self._current(a, season), self._current(b, season)
        logit = self.weights["elo"] * (rating1 - rating2) / 100 + self.weights["margin"] * (margin1 - margin2)
        slope = self.slopes.get(a["competition"], 1.0)
        return {
            "p_team1": round(float(probability(slope * logit)), 4),
            "rating1": round(rating1),
            "rating2": round(rating2),
            "margin1": round(margin1, 2),
            "margin2": round(margin2, 2),
            "matches1": a["matches"],
            "matches2": b["matches"],
            "competition": a["competition"],
            "slope": slope,
        }


def main():
    matches = pd.read_parquet(config.MATCHES_PATH)
    deliveries = pd.read_parquet(config.DELIVERIES_PATH, columns=["match_id", "innings", "ball_runs", "legal", "wicket_kind"])
    payload, report = build(matches, deliveries)
    config.MODELS_DIR.mkdir(exist_ok=True)
    config.REPORTS_DIR.mkdir(exist_ok=True)
    config.PREMATCH_PATH.write_text(json.dumps(payload, indent=1))
    (config.REPORTS_DIR / "prematch.json").write_text(json.dumps(report, indent=2))

    w = payload["weights"]
    print(f"{len(payload['ratings'])} team ratings as of {payload['as_of']}; "
          f"weights {w['elo']:.3f} per 100 Elo points, {w['margin']:.3f} per run an over of margin")
    for name in ("all_competitions", config.TARGET_COMPETITION):
        for label, r in (("ratings", report[name]), ("elo only", report["elo_only"][name])):
            print(f"  {name:<17}{label:<9} {r['matches']:>4} held-out matches  log loss {r['log_loss']:.4f} "
                  f"(coin flip {r['coin_flip_log_loss']})  auc {r['auc']:.3f}  brier {r['brier']:.4f}")
    print("slopes for upcoming matches:", report["slopes"])
    print(f"{config.TARGET_COMPETITION} slope by season predicted:", report["target_slopes_by_season"])


if __name__ == "__main__":
    main()
