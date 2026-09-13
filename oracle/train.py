"""Build features, train both innings models, and write evaluation reports.

    python -m oracle.train                  # train, then score the held-out IPL season
    python -m oracle.train --compare-data   # compare ways of using non-IPL matches, on validation only
"""
import argparse
import json

import joblib
import pandas as pd

from oracle import config
from oracle.evaluate import reliability_plot, score
from oracle.features import build_states, season_split, venue_priors
from oracle.models import OracleModel

DATA_CANDIDATES = [
    {"other_weight": 0.0, "competition_feature": False},
    {"other_weight": 0.25, "competition_feature": False},
    {"other_weight": 1.0, "competition_feature": False},
    {"other_weight": 0.25, "competition_feature": True},
    {"other_weight": 1.0, "competition_feature": True},
]
MODEL_COLUMNS = sorted(
    set(config.FEATURES[1]) | set(config.FEATURES[2])
    | {"is_target", "y", "year", "date", "competition", "match_id", "innings", "terminal"}
)


def split_masks(states, matches):
    """Row masks for train, validation and test.

    Validation and test are target-competition seasons only, so scores stay comparable with a
    target-only model. Training adds other competitions' matches played before validation begins.
    """
    target_matches = matches[matches["competition"] == config.TARGET_COMPETITION]
    split = season_split(target_matches["year"])
    val_start = target_matches.loc[target_matches["year"].isin(split["val"]), "date"].min()
    in_target = states["competition"] == config.TARGET_COMPETITION
    masks = {
        "train": (in_target & states["year"].isin(split["train"])) | (~in_target & (states["date"] < val_start)),
        "val": in_target & states["year"].isin(split["val"]),
        "test": in_target & states["year"].isin(split["test"]),
    }
    return split, masks


def innings_parts(frame, masks, innings):
    # Finished chases are certain outcomes; the predictor handles them without the model.
    usable = (frame["innings"] == innings) & ~frame["terminal"]
    return {name: frame[usable & mask] for name, mask in masks.items()}


def compare_data(frame, masks):
    """Fit every data candidate and rank them by validation log loss. The test season is not used."""
    results = []
    print(f"{'other weight':>12} {'is_target':>10} {'inn 1 val':>10} {'inn 2 val':>10} {'mean':>8}")
    for candidate in DATA_CANDIDATES:
        result = dict(candidate)
        for innings in (1, 2):
            parts = innings_parts(frame, masks, innings)
            model = OracleModel(innings, **candidate).fit(parts["train"], parts["val"])
            result[f"innings{innings}"] = {
                "val_log_loss": score(parts["val"]["y"], model.predict(parts["val"]))["log_loss"],
                "blend_weight": model.weight,
                "gbm_trees": int(model.gbm.best_iteration_),
            }
        result["mean_val_log_loss"] = round((result["innings1"]["val_log_loss"] + result["innings2"]["val_log_loss"]) / 2, 4)
        results.append(result)
        print(
            f"{candidate['other_weight']:>12} {str(candidate['competition_feature']):>10} "
            f"{result['innings1']['val_log_loss']:>10.4f} {result['innings2']['val_log_loss']:>10.4f} "
            f"{result['mean_val_log_loss']:>8.4f}",
            flush=True,
        )
    best = min(results, key=lambda r: r["mean_val_log_loss"])
    (config.REPORTS_DIR / "data_comparison.json").write_text(json.dumps({"candidates": results, "best": best}, indent=2))
    print(f"\nBest on validation: other_weight={best['other_weight']}, competition_feature={best['competition_feature']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--compare-data", action="store_true",
                        help="compare ways of using non-IPL matches on the validation seasons, then exit")
    args = parser.parse_args()

    matches = pd.read_parquet(config.MATCHES_PATH)
    states = build_states(matches, pd.read_parquet(config.DELIVERIES_PATH))
    split, masks = split_masks(states, matches)
    config.MODELS_DIR.mkdir(exist_ok=True)
    config.REPORTS_DIR.mkdir(exist_ok=True)

    if not args.compare_data:
        # The app only replays the target competition, so the server loads just those states.
        states[states["competition"] == config.TARGET_COMPETITION].to_parquet(config.STATES_PATH, index=False)
    frame = states[MODEL_COLUMNS]
    del states

    if args.compare_data:
        compare_data(frame, masks)
        return

    if config.OTHER_COMPETITION_WEIGHT == 0:
        masks["train"] &= frame["competition"] == config.TARGET_COMPETITION
    (config.MODELS_DIR / "venue_priors.json").write_text(json.dumps(venue_priors(matches), indent=1))

    train_matches = frame.loc[masks["train"], ["match_id", "competition"]].drop_duplicates()
    report = {
        "split": split,
        "data": {
            "train_matches": len(train_matches),
            "train_by_competition": {k: int(v) for k, v in train_matches["competition"].value_counts().items()},
            "other_weight": config.OTHER_COMPETITION_WEIGHT,
            "competition_feature": config.COMPETITION_FEATURE,
        },
        "innings": {},
    }
    for innings in (1, 2):
        parts = innings_parts(frame, masks, innings)
        model = OracleModel(innings).fit(parts["train"], parts["val"])
        joblib.dump(model, config.MODELS_DIR / f"innings{innings}.joblib")

        test = parts["test"]
        components = model.components(test)
        report["innings"][innings] = {
            "blend_weight": model.weight,
            "gbm_trees": int(model.gbm.best_iteration_),
            "matches": {name: int(part["match_id"].nunique()) for name, part in parts.items()},
            "rows": {name: len(part) for name, part in parts.items()},
            "test": {name: score(test["y"], p) for name, p in components.items()},
        }
        reliability_plot(
            test["y"].to_numpy(),
            {k: components[k] for k in ("logistic", "gbm", "calibrated")},
            config.REPORTS_DIR / f"reliability_innings{innings}.png",
            title=f"Innings {innings} · test season {', '.join(map(str, split['test']))}",
        )

    config.METRICS_PATH.write_text(json.dumps(report, indent=2))
    data = report["data"]
    print(f"train {split['train'][0]}-{split['train'][-1]}  val {split['val']}  test {split['test']}")
    print(f"training matches: {data['train_matches']} {data['train_by_competition']}")
    for innings, r in report["innings"].items():
        print(f"\nInnings {innings}  (blend weight on GBM {r['blend_weight']:.2f}, {r['gbm_trees']} trees)")
        print(f"  {'model':<11}{'log loss':>9}{'brier':>8}{'auc':>8}{'ece':>8}")
        for name, s in r["test"].items():
            print(f"  {name:<11}{s['log_loss']:>9.4f}{s['brier']:>8.4f}{s['auc']:>8.4f}{s['ece']:>8.4f}")


if __name__ == "__main__":
    main()
