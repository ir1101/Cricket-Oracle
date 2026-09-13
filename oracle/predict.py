"""Score match states and build chase-difficulty grids from trained models."""
import json

import joblib
import numpy as np

from oracle import config
from oracle.features import neutral_momentum, state_features


class Oracle:
    def __init__(self, models, priors):
        self.models = models
        self.venue_pars = priors["venues"]
        self.league_par = priors["league"]
        self._grids = {}

    @classmethod
    def load(cls, models_dir=config.MODELS_DIR):
        models = {i: joblib.load(models_dir / f"innings{i}.joblib") for i in (1, 2)}
        return cls(models, json.loads((models_dir / "venue_priors.json").read_text()))

    def par(self, venue=None):
        return self.venue_pars.get(venue, self.league_par)

    def predict_states(self, states, innings):
        """Calibrated P(batting side wins) for each row of a feature frame."""
        p = self.models[innings].predict(states)
        if innings == 2:
            won = states["runs_required"].to_numpy() <= 0
            out_of_resources = (states["wickets_in_hand"].to_numpy() <= 0) | (states["balls_remaining"].to_numpy() <= 0)
            p = np.where(won, 1.0, np.where(out_of_resources, 0.0, p))
        return p

    def predict_one(self, innings, runs, balls, wickets, venue=None, target=None, max_balls=config.BALLS_PER_INNINGS):
        recent_rr, recent_wickets = neutral_momentum(runs, balls, wickets)
        features = state_features(
            runs=runs, balls=balls, wickets=wickets, max_balls=max_balls, venue_par=self.par(venue),
            recent_run_rate=recent_rr, wickets_last_30=recent_wickets,
            target=target if innings == 2 else np.nan,
        )
        return float(self.predict_states(features, innings)[0])

    def heatmap_grid(self, target, wickets_in_hand, venue=None, max_balls=config.BALLS_PER_INNINGS):
        """P(chase succeeds) over runs required x balls remaining; None marks unreachable states."""
        venue_par = self.par(venue)
        key = (target, wickets_in_hand, venue_par, max_balls)
        if key not in self._grids:
            self._grids[key] = self._grid(target, wickets_in_hand, venue_par, max_balls)
        return self._grids[key]

    def _grid(self, target, wickets_in_hand, venue_par, max_balls):
        runs_required = np.arange(1, target + 1)
        balls_remaining = np.arange(1, max_balls + 1)
        rr, br = np.meshgrid(runs_required, balls_remaining, indexing="ij")
        runs, balls, wickets = target - rr, max_balls - br, 10 - wickets_in_hand

        # Grid cells are hypothetical, so recent form assumes an even pace to reach them.
        recent_rr, recent_wickets = neutral_momentum(runs, balls, wickets)
        features = state_features(
            runs=runs.ravel(), balls=balls.ravel(), wickets=wickets, max_balls=max_balls, venue_par=venue_par,
            recent_run_rate=recent_rr.ravel(), wickets_last_30=np.ravel(recent_wickets), target=target,
        )
        p = self.predict_states(features, 2).reshape(rr.shape)

        # Nobody scores much faster than a boundary a ball or loses more wickets than balls bowled.
        reachable = (runs <= 6 * balls + 10) & (wickets <= balls)
        return {
            "target": target,
            "wickets_in_hand": wickets_in_hand,
            "venue_par": venue_par,
            "max_balls": max_balls,
            "runs_required": runs_required.tolist(),
            "balls_remaining": balls_remaining.tolist(),
            "p": [[round(float(v), 4) if ok else None for v, ok in zip(row, ok_row)]
                  for row, ok_row in zip(p, reachable)],
        }
