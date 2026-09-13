"""Build features, evaluate both innings models, then fit the models the app serves.

    python -m oracle.train                  # evaluate on the held-out season, then refit on every season
    python -m oracle.train --compare-data   # compare ways of using non-IPL matches, on validation only
"""
import argparse
import json

import joblib
import numpy as np
import pandas as pd

from oracle import config
from oracle.evaluate import reliability_bins, reliability_plot, score
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
    | {"is_target", "y", "year", "date", "competition", "match_id", "innings", "terminal", "balls_cum"}
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


def production_model(frame, matches, innings):
    """The served model, built with the recipe in config.SERVED_RECIPE. Returns it with a description."""
    target_matches = matches[matches["competition"] == config.TARGET_COMPETITION]
    tune_years = [int(y) for y in sorted(target_matches["year"].unique())[-config.VAL_SEASONS:]]
    tune_start = target_matches.loc[target_matches["year"].isin(tune_years), "date"].min()
    usable = (frame["innings"] == innings) & ~frame["terminal"]
    in_target = frame["competition"] == config.TARGET_COMPETITION
    train = frame[usable & ((in_target & ~frame["year"].isin(tune_years)) | (~in_target & (frame["date"] < tune_start)))]
    tune = frame[usable & in_target & frame["year"].isin(tune_years)]
    model = OracleModel(innings).fit(train, tune)

    recipe = config.SERVED_RECIPE[innings]
    if recipe == "refit":
        model.refit(frame[usable], calibration_seasons=tune_years)
        trained_through = tune_years[-1]
    else:
        trained_through = min(tune_years) - 1
    return model, {"recipe": recipe, "trained_through": trained_through, "calibrated_on": tune_years,
                   "blend_weight": model.weight, "trees": model.trees}


def match_weighted_scores(part):
    """Accuracy and Brier score with each match counting once, however many deliveries it has in the cell."""
    if part.empty:
        return {"matches": 0, "accuracy": None, "brier": None}
    weights = 1 / part.groupby("match_id")["match_id"].transform("size").to_numpy()
    return {
        "matches": int(part["match_id"].nunique()),
        "accuracy": round(float(np.average(part["correct"], weights=weights)), 3),
        "brier": round(float(np.average((part["p"] - part["y"]) ** 2, weights=weights)), 4),
    }


def stage_confidence(frame):
    """How often the favourite won, by match stage and by how far the odds were from 50-50.

    Each of the latest seasons is predicted by a model trained only on earlier seasons.
    """
    in_target = frame["competition"] == config.TARGET_COMPETITION
    seasons = sorted(frame.loc[in_target, "year"].unique())[-config.CONFIDENCE_SEASONS:]
    scored = []
    for season in seasons:
        for innings in (1, 2):
            pool = frame[(frame["innings"] == innings) & ~frame["terminal"] & in_target]
            model = OracleModel(innings).fit(pool[pool["year"] <= season - 2], pool[pool["year"] == season - 1])
            test = pool[pool["year"] == season]
            scored.append(pd.DataFrame({
                "match_id": test["match_id"].to_numpy(),
                "innings": innings,
                "over": np.minimum(test["balls_cum"].to_numpy() // 6, 19),
                "y": test["y"].to_numpy(),
                "p": model.predict(test),
            }))
    rows = pd.concat(scored, ignore_index=True)
    rows["correct"] = ((rows["p"] > 0.5) == (rows["y"] == 1)).astype(float)
    rows["edge"] = (rows["p"] - 0.5).abs()

    bands = config.CONFIDENCE_BANDS
    stages = []
    for innings, lo, hi in config.CONFIDENCE_STAGES:
        part = rows[(rows["innings"] == innings) & (rows["over"] >= lo) & (rows["over"] < hi)]
        by_band = [
            {"from": a, "to": b, **match_weighted_scores(part[(part["edge"] >= a) & ((part["edge"] < b) | (b == bands[-1]))])}
            for a, b in zip(bands, bands[1:])
        ]
        stages.append({"innings": innings, "from_over": lo, "to_over": hi, **match_weighted_scores(part), "by_band": by_band})
    return {"seasons": [int(s) for s in seasons], "stages": stages}


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
                "gbm_trees": model.trees,
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
            "match_weighted": config.MATCH_WEIGHTED,
        },
        "innings": {},
    }
    for innings in (1, 2):
        # Evaluation model: the scores and reliability diagrams describe this one.
        parts = innings_parts(frame, masks, innings)
        model = OracleModel(innings).fit(parts["train"], parts["val"])
        test = parts["test"]
        components = model.components(test)
        report["innings"][innings] = {
            "blend_weight": model.weight,
            "gbm_trees": model.trees,
            "matches": {name: int(part["match_id"].nunique()) for name, part in parts.items()},
            "rows": {name: len(part) for name, part in parts.items()},
            "test": {name: score(test["y"], p) for name, p in components.items()},
            # Drawn by the site's model card as an interactive reliability diagram.
            "reliability": {name: reliability_bins(test["y"], components[name]) for name in ("logistic", "gbm", "calibrated")},
        }
        reliability_plot(
            test["y"].to_numpy(),
            {k: components[k] for k in ("logistic", "gbm", "calibrated")},
            config.REPORTS_DIR / f"reliability_innings{innings}.png",
            title=f"Innings {innings} · test season {', '.join(map(str, split['test']))}",
        )

        # Served model: built with the per-innings recipe in config.SERVED_RECIPE.
        served, description = production_model(frame, matches, innings)
        joblib.dump(served, config.MODELS_DIR / f"innings{innings}.joblib")
        report["innings"][innings]["served"] = description

    report["served"] = {innings: report["innings"][innings]["served"] for innings in (1, 2)}
    report["confidence"] = stage_confidence(frame)
    config.METRICS_PATH.write_text(json.dumps(report, indent=2))

    data = report["data"]
    print(f"train {split['train'][0]}-{split['train'][-1]}  val {split['val']}  test {split['test']}")
    print(f"training matches: {data['train_matches']} {data['train_by_competition']}  match weighted: {data['match_weighted']}")
    for innings, r in report["innings"].items():
        s = r["served"]
        print(f"\nInnings {innings}  (blend weight on GBM {r['blend_weight']:.2f}, {r['gbm_trees']} trees; served "
              f"'{s['recipe']}' through {s['trained_through']}: {s['blend_weight']:.2f}, {s['trees']} trees)")
        print(f"  {'model':<11}{'log loss':>9}{'brier':>8}{'auc':>8}{'ece':>8}")
        for name, s in r["test"].items():
            print(f"  {name:<11}{s['log_loss']:>9.4f}{s['brier']:>8.4f}{s['auc']:>8.4f}{s['ece']:>8.4f}")
    print(f"How often the favourite won, walk-forward {report['confidence']['seasons']}:")
    for s in report["confidence"]["stages"]:
        bands = "  ".join(f"{b['from']:.2f}-{b['to']:.2f}: {b['accuracy']} (n={b['matches']})" for b in s["by_band"])
        print(f"  inn {s['innings']} overs {s['from_over']:>2}-{s['to_over']:<2}  {s['accuracy']} over {s['matches']} matches | {bands}")


if __name__ == "__main__":
    main()
