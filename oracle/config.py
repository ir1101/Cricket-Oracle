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

# How non-target matches enter training, chosen with `python -m oracle.train --compare-data`.
# Validation log loss (mean of both innings): 0 -> 0.4857, 0.25 -> 0.4810, 1.0 -> 0.4826; the indicator
# did not help. 0.25 then lost to 0 on the 2026 test season on every metric except chase calibration
# error, so the app ships the IPL-only model. Other competitions still feed venue pars at shared grounds.
OTHER_COMPETITION_WEIGHT = 0.0  # sample weight relative to a target-competition match; 0 drops them
COMPETITION_FEATURE = False  # add an is_target indicator so models can learn a level shift

MATCHES_PATH = DATA_PROCESSED / "matches.parquet"
DELIVERIES_PATH = DATA_PROCESSED / "deliveries.parquet"
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
