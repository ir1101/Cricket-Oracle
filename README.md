# Cricket Oracle

A match-outcome predictor for T20 cricket, trained on every IPL match from 2008 to 2026.
It turns ball-by-ball data into innings-state features and blends a logistic baseline with a
monotone gradient-boosted model. Calibrated win probabilities drive a replay of any match with a
chase-difficulty heatmap that updates ball by ball. A what-if calculator gives the odds for any
situation you type in (score, overs, wickets, target, venue).

## Quick start

```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python -m oracle.ingest            # download 15 Cricsheet T20 archives (~40 MB) -> data/processed/*.parquet
python -m oracle.train --compare-data   # optional: re-check how much weight non-IPL matches get
python -m oracle.train             # features, both innings models, reports/metrics.json
uvicorn api.main:app               # then open http://localhost:8000
python -m pytest                   # 26 tests
```

## How it works

| Stage | Module | What it does |
|---|---|---|
| Ingest | `oracle/ingest.py` | Parses Cricsheet JSON for the IPL and 14 other men's T20 competitions and counts legal balls (wides and no-balls are not legal). Retired batters do not cost a wicket. Venue and franchise names are merged across renames and competitions. D/L results, ties, no-results, non-20-over matches, and T20Is not between two full members are dropped. |
| Features | `oracle/features.py` | One row per delivery. Covers balls remaining, wickets in hand, current run rate, run rate and wickets over the last 30 legal balls, and venue par. Chase rows add runs required, required rate and target. Scores are also restated relative to par. |
| Venue par | `oracle/features.py` | A recency-weighted scoring level for each competition plus the venue's shrunk offset from it. Offsets are pooled across every competition played at the ground. It is built only from earlier matches, so it never leaks the result. |
| Models | `oracle/models.py` | Logistic regression plus LightGBM with monotone constraints (more runs required never helps the chase; more balls or wickets never hurts). Recent seasons carry more training weight. The blend weight and Platt calibration are tuned on the validation seasons. |
| Split | `oracle/config.py` | By season, never at random. Train 2008–2023, validate 2024–2025, test 2026. |
| Serve | `api/main.py` | FastAPI serves replays, heatmap grids and ad-hoc predictions, plus the static page in `web/`. |

## Results on the 2026 test season

| | Log loss | Brier | AUC | Calibration error |
|---|---|---|---|---|
| **Chase**: logistic | 0.349 | 0.110 | 0.948 | 11.8% |
| **Chase**: gradient-boosted | 0.413 | 0.137 | 0.904 | 11.5% |
| **Chase**: calibrated blend (shipped) | 0.346 | 0.111 | 0.941 | 10.6% |
| **First innings**: logistic | 0.695 | 0.247 | 0.704 | 20.0% |
| **First innings**: gradient-boosted | 0.643 | 0.226 | 0.682 | 11.5% |
| **First innings**: calibrated blend (shipped) | 0.681 | 0.239 | 0.700 | 15.8% |

Reliability plots are saved in `reports/`.

### Known limitations

- **2026 was an outlier for chasing.** Chasing sides won 63% of matches, against 45–52% in each of
  the three seasons before. No model fitted before the season could have expected that. It is
  the main reason calibration error on the test season is 11–17%. The models rank situations well
  (chase AUC 0.94) but underrate chasing sides in 2026.
- **Blend weights are tuned on validation, not on 2026.** The blend gives the GBM 30% in both
  innings. On 2026 the first-innings GBM alone would have scored better (log loss 0.643); it was not
  re-tuned.
- **Other T20 competitions are ingested but not used for training.** Weighting them at 0.25 of an IPL
  match won narrowly on the 2024–25 validation seasons (mean log loss 0.481 vs 0.486). On 2026 it
  did worse on every metric except chase calibration error (chase log loss 0.355 vs 0.346), so the
  app ships the IPL-only model. That choice was made after seeing 2026, so the numbers above are
  somewhat optimistic. The other competitions still feed venue pars at grounds they share with the
  IPL, which improved the IPL-only model. The full comparison is in `reports/data_comparison.json`.
- **Heatmap cells and what-if situations are hypothetical states.** Their recent-form features
  assume the innings has gone at an even pace. Replay probabilities use the real ball-by-ball
  history, so the same score can get a slightly different number in the replay.
- Replay only. There is no live score feed yet.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/matches?year=&team=` | Seasons, teams, and that season's matches |
| `GET /api/matches/{id}/replay` | Match summary and, for every delivery, the state and P(team batting first wins) |
| `GET /api/heatmap?target=&wickets=&venue=&max_balls=` | P(chase succeeds) for each runs-required × balls-remaining cell; `null` marks unreachable states |
| `POST /api/predict` | `{innings, runs, balls, wickets, target?, venue?}` → `p_batting_side_wins`, `venue_par`, `known_venue` (unknown venues fall back to the league par) |
| `GET /api/model` | Test metrics, split, blend weights, venue pars |

## Data

Ball-by-ball data from [Cricsheet](https://cricsheet.org), used under the Open Data Commons
Attribution License.

| Code | Competition | Matches kept |
|---|---|---|
| `ipl` | Indian Premier League (the app's target) | 1,195 |
| `t20i` | Men's T20 internationals, full members only | 1,019 |
| `blast` | English T20 Blast | 1,436 |
| `smat` | Syed Mushtaq Ali Trophy (Indian domestic) | 681 |
| `bbl` | Big Bash League | 615 |
| `bpl` | Bangladesh Premier League | 463 |
| `cpl` | Caribbean Premier League | 397 |
| `psl` | Pakistan Super League | 346 |
| `csa_t20` | CSA T20 Challenge | 269 |
| `super_smash` | Super Smash (New Zealand) | 241 |
| `lpl` | Lanka Premier League | 133 |
| `ilt20` | International League T20 | 132 |
| `sa20` | SA20 | 117 |
| `mlc` | Major League Cricket | 105 |
| `msl` | Mzansi Super League | 49 |
