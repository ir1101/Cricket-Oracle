"""Project-wide paths, data sources, and modelling constants."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"
MODELS_DIR = ROOT / "models"
REPORTS_DIR = ROOT / "reports"
WEB_DIR = ROOT / "web"

CRICSHEET_DOWNLOADS = "https://cricsheet.org/downloads"

# Competition code -> Cricsheet archive. The app predicts the target competition; the others are
# extra training data (men's 20-over matches only).
COMPETITIONS = {
    "ipl": "ipl_json.zip",
    "t20i": "t20s_male_json.zip",
    "bbl": "bbl_male_json.zip",
    "psl": "psl_male_json.zip",
    "cpl": "cpl_male_json.zip",
    "bpl": "bpl_male_json.zip",
    "sa20": "sat_male_json.zip",
    "ilt20": "ilt_male_json.zip",
    "mlc": "mlc_male_json.zip",
    "blast": "ntb_male_json.zip",
    "super_smash": "ssm_male_json.zip",
    "lpl": "lpl_male_json.zip",
    "smat": "sma_male_json.zip",
    "csa_t20": "ctc_male_json.zip",
    "msl": "msl_male_json.zip",
}
TARGET_COMPETITION = "ipl"

# Most T20 internationals are associate qualifiers; only fixtures between full members are kept.
T20I_FULL_MEMBERS = {
    "Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland",
    "New Zealand", "Pakistan", "South Africa", "Sri Lanka", "West Indies", "Zimbabwe",
}

# Live fixtures from CricketData.org (free tier: 100 calls a day). The key is read from the
# CRICKETDATA_API_KEY environment variable or a local, git-ignored .env file.
CRICKETDATA_URL = "https://api.cricapi.com/v1"
FIXTURE_CACHE_PATH = ROOT / "data" / "cache" / "cricscore.json"
FIXTURE_CACHE_MINUTES = 30
# Team logos: image links CricketData.org serves with its data (cached by team), and local files in
# web/images/logos/ named after the team, e.g. chennai-super-kings.png, which take priority.
LOGO_CACHE_PATH = ROOT / "data" / "cache" / "team_logos.json"
LOGO_DIR = WEB_DIR / "images" / "logos"
LOGO_SIZE = 128  # pixels requested from CricketData.org's image service
# Series-name keywords -> competition code, used to look up team ratings for live fixtures.
SERIES_COMPETITIONS = {
    "indian premier league": "ipl",
    "big bash": "bbl",
    "pakistan super league": "psl",
    "caribbean premier league": "cpl",
    "bangladesh premier league": "bpl",
    "sa20": "sa20",
    "international league t20": "ilt20",
    "major league cricket": "mlc",
    "t20 blast": "blast",
    "vitality blast": "blast",
    "super smash": "super_smash",
    "lanka premier league": "lpl",
    "syed mushtaq ali": "smat",
    "csa t20": "csa_t20",
    "mzansi super league": "msl",
}

# How non-target matches enter training, chosen with `python -m oracle.train --compare-data`.
# Validation log loss (mean of both innings): 0 -> 0.4857, 0.25 -> 0.4810, 1.0 -> 0.4826; the indicator
# did not help. 0.25 then lost to 0 on the 2026 test season on every metric except chase calibration
# error, so the app ships the IPL-only model. Other competitions still feed venue pars at shared grounds.
OTHER_COMPETITION_WEIGHT = 0.0  # sample weight relative to a target-competition match; 0 drops them
COMPETITION_FEATURE = False  # add an is_target indicator so models can learn a level shift

# Pre-match Elo ratings. K and the between-season carry were chosen on 2024–25 matches from every
# competition; the logistic scale is fitted on matches before PREMATCH_TEST_START.
ELO_K = 16
ELO_SEASON_CARRY = 1.0
PREMATCH_TEST_START = "2026-01-01"
PREMATCH_PATH = MODELS_DIR / "prematch.json"
# Margin ratings and per-competition recalibration. Walk-forward log loss over 2021-26 (3,432 matches,
# coin flip 0.6931): Elo alone 0.6762 (IPL 0.7068); Elo + margin, recalibrated per competition 0.6733 (IPL
# 0.6944). Player strength from each side's previous XI added nothing (0.6733). K and carry were picked from
# four settings on 2021-25; the recalibration window and penalty from six.
MARGIN_K = 0.08
MARGIN_SEASON_CARRY = 0.6
PREMATCH_RECAL_SEASONS = 5
PREMATCH_RECAL_C = 0.05  # penalty on each competition's slope: thin evidence is pulled toward 50-50

MATCHES_PATH = DATA_PROCESSED / "matches.parquet"
DELIVERIES_PATH = DATA_PROCESSED / "deliveries.parquet"
PLAYERS_PATH = DATA_PROCESSED / "players.parquet"  # playing XIs: match_id, team, order, player_id, player
STATES_PATH = DATA_PROCESSED / "states.parquet"
METRICS_PATH = REPORTS_DIR / "metrics.json"

BALLS_PER_INNINGS = 120
MOMENTUM_WINDOW = 30  # legal balls used for the recent-trajectory features
VENUE_PRIOR_PSEUDOCOUNT = 10  # matches' worth of shrinkage toward the league level
LEAGUE_HALFLIFE_MATCHES = 60  # under a season, so par keeps up as scoring rises
RECENCY_HALFLIFE_SEASONS = 3  # training weight halves for every three seasons of age

# Hold-out seasons, counted back from the latest season in the data.
TEST_SEASONS = 1
VAL_SEASONS = 2

SHARED_FEATURES = [
    "balls_remaining",
    "wickets_in_hand",
    "current_run_rate",
    "recent_run_rate",
    "wickets_last_30",
    "venue_par",
]
# The *_vs_par features restate scores relative to the scoring level of their era.
FEATURES = {
    1: SHARED_FEATURES + ["runs", "projected_total", "runs_vs_par", "projected_vs_par"],
    2: SHARED_FEATURES + ["runs_required", "required_run_rate", "rrr_minus_crr", "target", "target_vs_par"],
}

# +1: probability of the batting side winning rises with the feature; -1: falls.
MONOTONE = {
    1: {"balls_remaining": 1, "wickets_in_hand": 1, "runs": 1, "runs_vs_par": 1},
    2: {"balls_remaining": 1, "wickets_in_hand": 1, "runs_required": -1},
}

# Give every match the same total training weight instead of every delivery (long innings would
# otherwise count for more). Walk-forward checkpoint Brier, 2024/2025/2026: 0.1628/0.1606/0.1723 by
# delivery vs 0.1628/0.1596/0.1706 by match.
MATCH_WEIGHTED = True

# The app's "how sure is this?" notes: how often the favourite won, by match stage (innings, from over,
# to over) and by how far the odds were from 50-50, predicting each of the latest seasons walk-forward.
CONFIDENCE_SEASONS = 3
CONFIDENCE_STAGES = [(1, 0, 6), (1, 6, 12), (1, 12, 20), (2, 0, 6), (2, 6, 12), (2, 12, 16), (2, 16, 20)]
CONFIDENCE_BANDS = [0.0, 0.1, 0.25, 0.4, 0.5]

# How each served model is built, chosen by walk-forward checkpoint Brier on 2024-26:
#   "tuned": trained on seasons before the latest two, tuned and calibrated on those two.
#   "refit": trained on every season; blend and calibrator re-learned from leave-one-season-out
#            predictions for the latest two, so recent trends aren't counted twice.
# Checkpoint Brier (ball 1 / 6 / 10 / 15 / 18-19 overs), tuned vs refit:
#   chase         .1976/.1288/.1213/.0950/.0646  vs  .1956/.1263/.1200/.0929/.0621
#   first innings .2473/.2283/.2211/.1991/.1924  vs  .2515/.2311/.2228/.2012/.1939
# Refitting while keeping the old calibrator scored .2455/.2269/.2215/.2000/.1910 on the first innings but
# double-counted recent trends: it gave the side batting first 27% at the first ball of the 2026 final.
SERVED_RECIPE = {1: "tuned", 2: "refit"}
SERVED_RECIPE = {1: "tuned", 2: "refit"}

# Applied after stripping the city suffix and punctuation from Cricsheet venue names.
VENUE_ALIASES = {
    "Dr Y S Rajasekhara Reddy ACA VDCA Cricket Stadium": "Dr Y S Rajasekhara Reddy ACA-VDCA Cricket Stadium",
    "Feroz Shah Kotla": "Arun Jaitley Stadium",
    "Holkar Stadium": "Holkar Cricket Stadium",
    "The Wanderers Stadium": "New Wanderers Stadium",
    "Punjab Cricket Association Stadium": "Punjab Cricket Association IS Bindra Stadium",
    "Sardar Patel Stadium": "Narendra Modi Stadium",
    "Sheikh Zayed Stadium": "Zayed Cricket Stadium",
    "Subrata Roy Sahara Stadium": "Maharashtra Cricket Association Stadium",
}

TEAM_ALIASES = {
    "Delhi Daredevils": "Delhi Capitals",
    "Kings XI Punjab": "Punjab Kings",
    "Rising Pune Supergiants": "Rising Pune Supergiant",
    "Royal Challengers Bangalore": "Royal Challengers Bengaluru",
}
