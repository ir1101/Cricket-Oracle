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

    Early stopping, the blend weight, and the calibrator are all tuned on the validation
    seasons, so the test seasons stay untouched until evaluation.
    """

    def __init__(self, innings, other_weight=config.OTHER_COMPETITION_WEIGHT,
                 competition_feature=config.COMPETITION_FEATURE):
        self.innings = innings
        self.other_weight = other_weight
        self.features = list(config.FEATURES[innings]) + (["is_target"] if competition_feature else [])

    def fit(self, train, val):
        if "competition" in train and self.other_weight == 0:
            train = train[train["competition"] == config.TARGET_COMPETITION]
        X, y = train[self.features], train["y"].to_numpy()
        X_val, y_val = val[self.features], val["y"].to_numpy()

        # Scoring has risen sharply in recent seasons, so older matches count for less.
        weights = np.ones(len(train))
        if "year" in train:
            age = (train["year"].max() - train["year"]).to_numpy()
            weights *= 0.5 ** (age / config.RECENCY_HALFLIFE_SEASONS)
        # Other competitions teach the shape of a T20 innings but play at their own scoring levels.
        if "competition" in train:
            weights *= np.where(train["competition"] == config.TARGET_COMPETITION, 1.0, self.other_weight)

        self.lr = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
        self.lr.fit(X, y, logisticregression__sample_weight=weights)

        # Deliveries within a match are highly correlated, so leaves need thousands of rows to
        # generalise; shallower trees beat num_leaves=15/min_child_samples=400 on validation.
        monotone = [config.MONOTONE[self.innings].get(f, 0) for f in self.features]
        self.gbm = LGBMClassifier(
            n_estimators=4000,
            learning_rate=0.03,
            num_leaves=7,
            min_child_samples=3000,
            subsample=0.8,
            subsample_freq=1,
            colsample_bytree=0.8,
            reg_lambda=1.0,
            monotone_constraints=monotone,
            monotone_constraints_method="advanced",
            verbose=-1,
        )
        self.gbm.fit(
            X, y, sample_weight=weights, eval_X=(X_val,), eval_y=(y_val,),
            callbacks=[early_stopping(150, verbose=False)],
        )

        p_lr, p_gbm = self._base(X_val)
        weights = np.linspace(0, 1, 21)
        losses = [log_loss(y_val, np.clip(w * p_gbm + (1 - w) * p_lr, EPS, 1 - EPS)) for w in weights]
        self.weight = float(weights[int(np.argmin(losses))])

        blend = self.weight * p_gbm + (1 - self.weight) * p_lr
        self.calibrator = LogisticRegression(C=1e6).fit(logit(blend)[:, None], y_val)
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
