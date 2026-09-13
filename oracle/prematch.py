"""Pre-match win probabilities from Elo team ratings.

    python -m oracle.prematch   # rebuild ratings, score the held-out matches, write models/prematch.json

T20 results are noisy before a ball is bowled: on 2024–25 validation these ratings were only a little
better than a coin flip across all competitions, and no better for the IPL. Treat them as a weak prior.
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


def fit_scale(gaps, team1_won):
    """Logistic slope on the rating gap (per 100 points). No intercept: who is listed first is arbitrary."""
    model = LogisticRegression(fit_intercept=False).fit(np.asarray(gaps)[:, None] / 100, team1_won)
    return float(model.coef_[0][0])


def probability(gap, scale):
    return 1 / (1 + np.exp(-scale * np.asarray(gap, dtype=float) / 100))


def build(matches):
    """Score the held-out matches, then fit the serving model on everything."""
    m = matches.sort_values(["date", "match_id"]).reset_index(drop=True)
    gaps, table = replay_ratings(m)
    gaps = gaps.to_numpy()
    won = (m["winner"] == m["team1"]).to_numpy().astype(int)
    held_out = (m["date"] >= config.PREMATCH_TEST_START).to_numpy()
    in_target = (m["competition"] == config.TARGET_COMPETITION).to_numpy()

    p = probability(gaps, fit_scale(gaps[~held_out], won[~held_out]))
    report = {"k": config.ELO_K, "season_carry": config.ELO_SEASON_CARRY, "test_start": config.PREMATCH_TEST_START}
    for name, mask in (("all_competitions", held_out), (config.TARGET_COMPETITION, held_out & in_target)):
        report[name] = {"matches": int(mask.sum()), **score(won[mask], p[mask]), "coin_flip_log_loss": round(math.log(2), 4)}

    payload = {
        "k": config.ELO_K,
        "season_carry": config.ELO_SEASON_CARRY,
        "scale": fit_scale(gaps, won),
        "as_of": str(m["date"].max()),
        "ratings": table.assign(rating=table["rating"].round(1)).to_dict("records"),
    }
    return payload, report


def _name_key(team):
    key = re.sub(r"[^a-z0-9]+", " ", normalize_team(team).casefold()).strip()
    return re.sub(r"\bsaint\b", "st", key)  # fixtures say "Saint Lucia Kings", Cricsheet "St Lucia Kings"


class PrematchModel:
    def __init__(self, payload):
        self.scale = payload["scale"]
        self.carry = payload["season_carry"]
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
        if season is None or season == row["last_season"]:
            return row["rating"]
        return BASE_RATING + self.carry * (row["rating"] - BASE_RATING)

    def predict(self, team1, team2, competition=None, season=None):
        """P(team1 beats team2), or None when either side has no rating history."""
        a, b = self.rating(team1, competition), self.rating(team2, competition)
        if a is None or b is None:
            return None
        rating1, rating2 = self._current(a, season), self._current(b, season)
        return {
            "p_team1": round(float(probability(rating1 - rating2, self.scale)), 4),
            "rating1": round(rating1),
            "rating2": round(rating2),
            "matches1": a["matches"],
            "matches2": b["matches"],
        }


def main():
    matches = pd.read_parquet(config.MATCHES_PATH)
    payload, report = build(matches)
    config.MODELS_DIR.mkdir(exist_ok=True)
    config.REPORTS_DIR.mkdir(exist_ok=True)
    config.PREMATCH_PATH.write_text(json.dumps(payload, indent=1))
    (config.REPORTS_DIR / "prematch.json").write_text(json.dumps(report, indent=2))

    print(f"{len(payload['ratings'])} team ratings as of {payload['as_of']}, scale {payload['scale']:.3f} per 100 points")
    for name in ("all_competitions", config.TARGET_COMPETITION):
        r = report[name]
        print(f"  {name:<17} {r['matches']:>4} held-out matches  log loss {r['log_loss']:.4f} "
              f"(coin flip {r['coin_flip_log_loss']})  auc {r['auc']:.3f}  brier {r['brier']:.4f}")


if __name__ == "__main__":
    main()
