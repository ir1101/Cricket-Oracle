# Cricket Oracle

A match-outcome predictor for T20 cricket, trained on every IPL match from 2008 to 2026.
It turns ball-by-ball data into innings-state features and blends a logistic baseline with a
monotone gradient-boosted model.

The site has three sections:

- **History** (`/history`) replays any IPL match with ball-by-ball win probability and a
  chase-difficulty heatmap.
- **Upcoming** (`/upcoming`) lists men's T20 fixtures for the next seven days from CricketData.org.
  Pre-match odds come from team ratings, recalibrated per competition; in-play odds take over once a
  match is live.
- **Calculator** (`/calculator`) gives the odds for any situation you type in, plus the chase map for
  that target.

## Quick start

```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python -m oracle.ingest            # download 15 Cricsheet T20 archives (~40 MB) -> data/processed/*.parquet
python -m oracle.train --compare-data   # optional: re-check how much weight non-IPL matches get
python -m oracle.train             # features, both innings models, reports/metrics.json
python -m oracle.prematch          # team ratings for upcoming fixtures, reports/prematch.json
python -m oracle.logos             # optional: IPL team logos (CricketData.org, 3 API calls) and defunct teams' (Wikipedia)
uvicorn api.main:app               # then open http://localhost:8000
python -m pytest                   # 108 tests
```

For live fixtures, get a free key from [CricketData.org](https://cricketdata.org) and put it in a
`.env` file in the project folder (it is git-ignored):

```
CRICKETDATA_API_KEY=your-key-here
```

Without a key, the Upcoming page explains how to add one. The free tier allows 100 calls a day, so
the server caches the fixture feed for 30 minutes in `data/cache/`.

Photos go in `web/images/` and are shown in black and white. Each slot takes the first file whose
name starts with one of its prefixes:

| Slot | File name prefixes, in order of preference |
|---|---|
| Home page hero | `hero-loop` (an MP4 or WebM loop, skipped for reduced motion), then `hero-action`, then `hero` |
| "How sure is it?" band | `stadium`, then `spotlight` |
| Hover photos on the home page's tool links | `history`, `upcoming`, `calculator` |

Optional focal points go in `web/images/photos.json`, for example `{"hero-1.jpg": {"focus": "50% 0%"}}`.

Team logos appear before team names. They are the teams' trademarks, so they are linked from where
they're hosted, not copied into the project:
- **Current IPL teams:** `python -m oracle.logos` looks them up on CricketData.org, which serves them with its data.
- **Defunct IPL teams:** the same command looks up Deccan Chargers, Kochi Tuskers Kerala, Pune Warriors,
  Gujarat Lions and Rising Pune Supergiant on Wikipedia, since CricketData.org's history starts in 2022.
  Wikipedia hosts these logos under fair use for its own articles. That's fine for a personal or local
  site, but publishing commercially would need permission from the rights holders.
- **Other teams:** picked up from the fixtures feed as fixtures load.
- **Your own files:** a file in `web/images/logos/` named after the team (for example
  `chennai-super-kings.svg`) takes priority.
- **No logo:** the team shows a monogram in its colours.

## How it works

| Stage | Module | What it does |
|---|---|---|
| Ingest | `oracle/ingest.py` | Parses Cricsheet JSON for the IPL and 14 other men's T20 competitions and counts legal balls (wides and no-balls are not legal). Retired batters do not cost a wicket. Venue and franchise names are merged across renames and competitions. D/L results, ties, no-results, non-20-over matches, and T20Is not between two full members are dropped. |
| Features | `oracle/features.py` | One row per delivery. Covers balls remaining, wickets in hand, current run rate, run rate and wickets over the last 30 legal balls, and venue par. Chase rows add runs required, required rate and target. Scores are also restated relative to par. |
| Venue par | `oracle/features.py` | A recency-weighted scoring level for each competition plus the venue's shrunk offset from it. Offsets are pooled across every competition played at the ground. It is built only from earlier matches, so it never leaks the result. |
| Models | `oracle/models.py` | Logistic regression plus LightGBM with monotone constraints (more runs required never helps the chase; more balls or wickets never hurts). Recent seasons carry more training weight. The blend weight and Platt calibration are tuned on the validation seasons. The served chase model is retrained on every season through the latest, then its blend and calibration are re-learned from leave-one-season-out predictions for the two latest seasons. The served first-innings model is trained on earlier seasons and calibrated on the two latest, without a refit, because that scored better walk-forward. (Refitting while keeping the old calibrator counts recent trends twice.) |
| Split | `oracle/config.py` | By season, never at random. Train 2008–2023, validate 2024–2025, test 2026. |
| Confidence | `oracle/train.py` | Each of the latest three seasons is predicted by a model trained only on earlier seasons. The app shows how often the favourite won at that stage of a match and at that distance from 50-50. |
| Pre-match | `oracle/prematch.py` | Two ratings per team within each competition: Elo on results (K = 16) and a margin rating that tracks its net run rate edge. A logistic fit on the two gaps gives the odds. Each competition then scales them by how well they predicted its last five seasons out of sample. Where they didn't, odds are pulled to 50-50. |
| Fixtures | `oracle/fixtures.py` | Reads the CricketData.org `cricScore` feed and keeps men's 20-over matches only. Women's matches and shorter formats the feed also tags as T20 (Hong Kong Sixes, T10, The Hundred) are dropped. It attaches pre-match odds and reads live score strings into in-play odds. |
| Serve | `api/main.py` | FastAPI serves the API and the site in `web/`: a landing page plus the History, Upcoming and Calculator pages, sharing `web/css/base.css`, `web/css/motion.css` and `web/js/core.js`. Each match is drawn in its two teams' colours (`matchColors` in `core.js` swaps a colour when the two sides would clash). |

## Results on the 2026 test season

| | Log loss | Brier | AUC | Calibration error |
|---|---|---|---|---|
| **Chase**: logistic | 0.341 | 0.107 | 0.948 | 11.2% |
| **Chase**: gradient-boosted | 0.402 | 0.133 | 0.907 | 10.5% |
| **Chase**: calibrated blend | 0.343 | 0.110 | 0.942 | 10.6% |
| **First innings**: logistic | 0.693 | 0.246 | 0.704 | 19.7% |
| **First innings**: gradient-boosted | 0.642 | 0.226 | 0.682 | 11.4% |
| **First innings**: calibrated blend | 0.679 | 0.238 | 0.701 | 15.8% |

These scores come from a model trained on 2008–2023 and never shown 2026. The app serves newer models
built as described under Models above: the chase model has seen every season through 2026, and the
first-innings model is calibrated on 2025–26. Reliability plots are saved in `reports/`, and the site's
model card draws them interactively.

### How sure is it?

Share of matches the favourite went on to win. Each of 2024, 2025 and 2026 was predicted by a model
trained only on earlier seasons, and every match counts once per stage. The app shows the matching
row next to its odds.

| Stage | Favourite won | Odds within 10 points of 50-50 | Favourite 25+ points clear |
|---|---|---|---|
| First innings, overs 0–6 | 60% | 57% | 69% |
| First innings, overs 6–12 | 64% | 57% | 73% |
| First innings, overs 12–20 | 72% | 61% | 80% |
| Chase, overs 0–6 | 77% | 61% | 82% |
| Chase, overs 6–12 | 83% | 56% | 89% |
| Chase, overs 12–16 | 87% | 66% | 92% |
| Chase, overs 16–20 | 92% | 61% | 95% |

Early odds are genuinely uncertain. Two alternatives were tested walk-forward and neither beat this
model overall: a ball-by-ball simulation (better only in the last overs of a chase) and player-aware
features such as XI strength, set batters and bowling left (better only at the start of a chase).
Weighting every match equally in training gave a small, consistent gain and is switched on.

### Known limitations

- **2026 was an outlier for chasing.** Chasing sides won 63% of matches, against 45–52% in each of
  the three seasons before. No model fitted before the season could have expected that. It is
  the main reason calibration error on the test season is 11–17%. The models rank situations well
  (chase AUC 0.94) but underrate chasing sides in 2026.
- **Blend weights are tuned on validation, not on 2026.** The evaluated blend gives the GBM 25% for
  the first innings and 30% for the chase. On 2026 the first-innings GBM alone would have scored
  better (log loss 0.642); it was not re-tuned.
- **Other T20 competitions are ingested but not used for training.** Weighting them at 0.25 of an IPL
  match won narrowly on the 2024–25 validation seasons (mean log loss 0.481 vs 0.486). On 2026 it
  did worse on every metric except chase calibration error (chase log loss 0.355 vs 0.346), so the
  app ships the IPL-only model. That choice was made after seeing 2026, so the numbers above are
  somewhat optimistic. The other competitions still feed venue pars at grounds they share with the
  IPL, which improved the IPL-only model. The full comparison is in `reports/data_comparison.json`.
- **Heatmap cells and what-if situations are hypothetical states.** Their recent-form features
  assume the innings has gone at an even pace. Replay probabilities use the real ball-by-ball
  history, so the same score can get a slightly different number in the replay.
- **Pre-match odds are weak, and the IPL is a coin toss before the start.** Walk-forward over
  2021–26 (3,432 matches, each season predicted from earlier ones), the served ratings score log loss
  0.673 against 0.676 for Elo alone and 0.693 for a coin toss. The gain is small: the 90% interval
  runs from 0.007 better to 0.001 worse. On 2026 alone they are level with Elo (0.682 v 0.681, AUC
  0.59). In the IPL, no rating predicted winners out of sample from 2023 on, so IPL odds stay at
  50-50. Elo alone was worse than a coin toss there over 2021–26 (0.707). Auctions reshuffle squads,
  so past results say little. Also tested and dropped: player strength from each side's last XI
  (no gain, even with the actual XI) and the toss (the winner won 50.8%). Home sides won 53% of club
  matches, but the fixtures feed doesn't give the venue. The Upcoming page shows these numbers next
  to the in-play model.
- **Live odds for non-IPL matches use the IPL-trained model**, so treat them as a guide.
- **The fixture parser is built from CricketData.org's documented fields.** The `cricScore` feed
  itself isn't fully documented, so check the Upcoming page after adding a key.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/matches?year=&team=` | Seasons, teams, and that season's matches |
| `GET /api/matches/{id}/replay` | Match summary and, for every delivery, the state and P(team batting first wins) |
| `GET /api/heatmap?target=&wickets=&venue=&max_balls=` | P(chase succeeds) for each runs-required × balls-remaining cell; `null` marks unreachable states |
| `POST /api/predict` | `{innings, runs, balls, wickets, target?, venue?}` → `p_batting_side_wins`, `venue_par`, `known_venue` (unknown venues fall back to the league par) |
| `GET /api/model` | Test metrics, split, blend weights, venue pars |
| `GET /api/stats` | Headline numbers for the landing page |
| `GET /api/upcoming` | `status` (`ok`, `no_key` or `error`), fixtures with `prematch` and `live` odds, and the pre-match test report |
| `GET /api/images` | Photos and video loops found in `web/images/` |
| `GET /api/logos` | Team logo links by team slug (`chennai-super-kings`), local files first |

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
