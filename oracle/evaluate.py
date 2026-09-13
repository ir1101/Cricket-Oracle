"""Probability-quality metrics and reliability plots."""
import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score  # noqa: E402

COLORS = {"logistic": "#9A968C", "gbm": "#2F6F5E", "blend": "#C9772B", "calibrated": "#111111"}


def _bin_index(p, bins):
    return np.clip((np.asarray(p) * bins).astype(int), 0, bins - 1)


def expected_calibration_error(y, p, bins=10):
    y, p = np.asarray(y, dtype=float), np.asarray(p, dtype=float)
    idx = _bin_index(p, bins)
    return float(sum(
        (idx == b).mean() * abs(y[idx == b].mean() - p[idx == b].mean())
        for b in range(bins) if (idx == b).any()
    ))


def score(y, p):
    y = np.asarray(y)
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return {
        "log_loss": round(float(log_loss(y, p, labels=[0, 1])), 4),
        "brier": round(float(brier_score_loss(y, p)), 4),
        "auc": round(float(roc_auc_score(y, p)), 4),
        "ece": round(expected_calibration_error(y, p), 4),
    }


def reliability_plot(y, components, path, title, bins=10):
    y = np.asarray(y, dtype=float)
    fig, ax = plt.subplots(figsize=(5, 5), facecolor="#F3F2EE")
    ax.set_facecolor("#F3F2EE")
    ax.plot([0, 1], [0, 1], ls="--", lw=1, color="#BDB9AE", label="perfect")
    for name, p in components.items():
        idx = _bin_index(p, bins)
        filled = [b for b in range(bins) if (idx == b).any()]
        ax.plot(
            [np.mean(p[idx == b]) for b in filled],
            [y[idx == b].mean() for b in filled],
            marker="o", ms=4, lw=1.6, color=COLORS.get(name), label=name,
        )
    ax.set(xlim=(0, 1), ylim=(0, 1), xlabel="Predicted win probability", ylabel="Observed win rate", title=title)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.legend(frameon=False, loc="upper left")
    fig.savefig(path, dpi=130, bbox_inches="tight")
    plt.close(fig)
