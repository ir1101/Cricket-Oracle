"""FastAPI app: match replays, chase-difficulty heatmaps, and ad-hoc predictions.

    uvicorn api.main:app --reload
"""
import json
from contextlib import asynccontextmanager

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from oracle import config
from oracle.predict import Oracle
from oracle.replay import match_summary, replay

store = {}


@asynccontextmanager
async def lifespan(app):
    store["oracle"] = Oracle.load()
    matches = pd.read_parquet(config.MATCHES_PATH)
    store["matches"] = matches[matches["competition"] == config.TARGET_COMPETITION]
    store["states"] = pd.read_parquet(config.STATES_PATH)
    store["metrics"] = json.loads(config.METRICS_PATH.read_text())
    yield
    store.clear()


app = FastAPI(title="Cricket Oracle", lifespan=lifespan)


@app.get("/api/model")
def model_info():
    oracle = store["oracle"]
    return {**store["metrics"], "league_par": oracle.league_par, "venues": oracle.venue_pars}


@app.get("/api/matches")
def list_matches(year: int | None = None, team: str | None = None):
    matches = store["matches"]
    years = sorted(matches["year"].unique().tolist(), reverse=True)
    year = year or years[0]
    selected = matches[matches["year"] == year]
    if team:
        selected = selected[(selected["team1"] == team) | (selected["team2"] == team)]
    selected = selected.sort_values(["date", "match_id"], ascending=False)
    return {
        "years": years,
        "year": year,
        "teams": sorted(set(matches["team1"]) | set(matches["team2"])),
        "matches": [match_summary(row) for _, row in selected.iterrows()],
    }


@app.get("/api/matches/{match_id}/replay")
def match_replay(match_id: int):
    try:
        return replay(store["oracle"], store["states"], store["matches"], match_id)
    except KeyError:
        raise HTTPException(404, f"No match {match_id}")


@app.get("/api/heatmap")
def heatmap(
    target: int = Query(ge=1, le=300),
    wickets: int = Query(10, ge=1, le=10, description="wickets in hand"),
    venue: str | None = None,
    max_balls: int = Query(config.BALLS_PER_INNINGS, ge=6, le=config.BALLS_PER_INNINGS),
):
    return store["oracle"].heatmap_grid(target, wickets, venue, max_balls)


class MatchState(BaseModel):
    innings: int = Field(ge=1, le=2)
    runs: int = Field(ge=0)
    balls: int = Field(ge=0, le=config.BALLS_PER_INNINGS)
    wickets: int = Field(ge=0, le=10)
    target: int | None = Field(default=None, ge=1)
    venue: str | None = None


@app.post("/api/predict")
def predict(state: MatchState):
    if state.innings == 2 and state.target is None:
        raise HTTPException(422, "target is required for the second innings")
    oracle = store["oracle"]
    p = oracle.predict_one(state.innings, state.runs, state.balls, state.wickets, state.venue, state.target)
    return {
        "p_batting_side_wins": round(p, 4),
        "venue_par": round(oracle.par(state.venue), 1),
        "known_venue": state.venue in oracle.venue_pars,
    }


app.mount("/reports", StaticFiles(directory=config.REPORTS_DIR), name="reports")
app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
