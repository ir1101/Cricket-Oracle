"""Logistic baseline + monotone LightGBM, blended and Platt-calibrated."""
import numpy as np
from lightgbm import LGBMClassifier, early_stopping
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from oracle import config

EPS = 1e-6


def logit(p):
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


class OracleModel:
    """Win-probability model for one innings.

    fit() tunes early stopping, the blend weight and the calibrator on held-out seasons. refit() retrains
    the base models on more data; see its docstring for how calibration is kept honest.
    """

    def __init__(self, innings, other_weight=config.OTHER_COMPETITION_WEIGHT,
                 competition_feature=config.COMPETITION_FEATURE, match_weighted=config.MATCH_WEIGHTED):
        self.innings = innings
        self.other_weight = other_weight
        self.match_weighted = match_weighted
        self.features = list(config.FEATURES[innings]) + (["is_target"] if competition_feature else [])

    def _usable(self, frame):
        if "competition" in frame and self.other_weight == 0:
            return frame[frame["competition"] == config.TARGET_COMPETITION]
        return frame

    def _weights(self, frame):
        weights = np.ones(len(frame))
        # Scoring has risen sharply in recent seasons, so older matches count for less.
        if "year" in frame:
            age = (frame["year"].max() - frame["year"]).to_numpy()
            weights *= 0.5 ** (age / config.RECENCY_HALFLIFE_SEASONS)
        # Other competitions teach the shape of a T20 innings but play at their own scoring levels.
        if "competition" in frame:
            weights *= np.where(frame["competition"] == config.TARGET_COMPETITION, 1.0, self.other_weight)
        if self.match_weighted and "match_id" in frame:
            per_match = frame.groupby("match_id")["match_id"].transform("size").to_numpy()
            weights *= per_match.mean() / per_match
        return weights

    def _gbm(self, n_estimators):
        # Deliveries within a match are highly correlated, so leaves need thousands of rows to
        # generalise; shallower trees beat num_leaves=15/min_child_samples=400 on validation.
        return LGBMClassifier(
            n_estimators=n_estimators,
            learning_rate=0.03,
            num_leaves=7,
            min_child_samples=3000,
            subsample=0.8,
            subsample_freq=1,
            colsample_bytree=0.8,
            reg_lambda=1.0,
            monotone_constraints=[config.MONOTONE[self.innings].get(f, 0) for f in self.features],
            monotone_constraints_method="advanced",
            verbose=-1,
        )

    def _base_fit(self, frame):
        """Logistic and GBM models trained on `frame` with the tuned tree count."""
        X, y, weights = frame[self.features], frame["y"].to_numpy(), self._weights(frame)
        lr = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
        lr.fit(X, y, logisticregression__sample_weight=weights)
        return lr, self._gbm(self.trees).fit(X, y, sample_weight=weights)

    def _tune_blend(self, p_lr, p_gbm, y):
        """Pick the blend weight and Platt calibrator from held-out predictions."""
        grid = np.linspace(0, 1, 21)
        losses = [log_loss(y, np.clip(w * p_gbm + (1 - w) * p_lr, EPS, 1 - EPS)) for w in grid]
        self.weight = float(grid[int(np.argmin(losses))])
        blend = self.weight * p_gbm + (1 - self.weight) * p_lr
        self.calibrator = LogisticRegression(C=1e6).fit(logit(blend)[:, None], y)

    def fit(self, train, val):
        train = self._usable(train)
        X, y = train[self.features], train["y"].to_numpy()
        X_val, y_val = val[self.features], val["y"].to_numpy()
        weights = self._weights(train)

        self.lr = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
        self.lr.fit(X, y, logisticregression__sample_weight=weights)

        self.gbm = self._gbm(4000)
        self.gbm.fit(
            X, y, sample_weight=weights, eval_X=(X_val,), eval_y=(y_val,),
            callbacks=[early_stopping(150, verbose=False)],
        )
        self.trees = max(int(self.gbm.best_iteration_ or self.gbm.n_estimators), 1)
        self._tune_blend(*self._base(X_val), y_val)
        return self

    def refit(self, data, calibration_seasons=()):
        """Retrain the logistic and GBM models on `data` with the tuned tree count.

        Without calibration_seasons the blend weight and calibrator from fit() are kept. That double
        counts any trend in the tuning seasons: the refit models learn it, and the calibrator (fitted
        before the refit) corrects for it again. Passing the tuning seasons re-learns the blend and
        calibrator from leave-one-season-out predictions, each made by a model trained on every other
        season in `data`.
        """
        data = self._usable(data)
        if calibration_seasons:
            p_lr, p_gbm, ys = [], [], []
            for season in calibration_seasons:
                lr, gbm = self._base_fit(data[data["year"] != season])
                held = data[data["year"] == season]
                p_lr.append(lr.predict_proba(held[self.features])[:, 1])
                p_gbm.append(gbm.predict_proba(held[self.features])[:, 1])
                ys.append(held["y"].to_numpy())
            self._tune_blend(np.concatenate(p_lr), np.concatenate(p_gbm), np.concatenate(ys))
        self.lr, self.gbm = self._base_fit(data)
        return self

    def _base(self, X):
        if "is_target" in self.features and "is_target" not in X:
            X = X.assign(is_target=1.0)  # hypothetical states are always in the target competition
        X = X[self.features]
        return self.lr.predict_proba(X)[:, 1], self.gbm.predict_proba(X)[:, 1]

    def components(self, X):
        p_lr, p_gbm = self._base(X)
        blend = self.weight * p_gbm + (1 - self.weight) * p_lr
        calibrated = self.calibrator.predict_proba(logit(blend)[:, None])[:, 1]
        return {"logistic": p_lr, "gbm": p_gbm, "blend": blend, "calibrated": calibrated}

    def predict(self, X):
        return self.components(X)["calibrated"]
