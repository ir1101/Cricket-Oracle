"""FastAPI app: the Cricket Oracle site, match replays, chase heatmaps, predictions and live fixtures.

    uvicorn api.main:app --reload
"""
import json
from contextlib import asynccontextmanager
from urllib.parse import quote

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from oracle import config, fixtures, logos
from oracle.predict import Oracle
from oracle.prematch import PrematchModel
from oracle.replay import match_summary, replay

PAGES = ("history", "upcoming", "calculator")
IMAGES_DIR = config.WEB_DIR / "images"
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
VIDEO_TYPES = {".mp4", ".webm"}

store = {}


@asynccontextmanager
async def lifespan(app):
    matches = pd.read_parquet(config.MATCHES_PATH)
    target = matches[matches["competition"] == config.TARGET_COMPETITION]
    metrics = json.loads(config.METRICS_PATH.read_text())
    prematch_report = config.REPORTS_DIR / "prematch.json"

    store["oracle"] = Oracle.load()
    store["matches"] = target
    store["states"] = pd.read_parquet(config.STATES_PATH)
    store["metrics"] = metrics
    store["prematch"] = PrematchModel.load() if config.PREMATCH_PATH.exists() else None
    store["prematch_report"] = json.loads(prematch_report.read_text()) if prematch_report.exists() else None
    store["stats"] = {
        "matches": len(matches),
        "competitions": int(matches["competition"].nunique()),
        "ipl_matches": len(target),
        "ipl_deliveries": len(store["states"]),
        "first_season": int(target["year"].min()),
        "test_season": int(metrics["split"]["test"][-1]),
        "chase_auc": metrics["innings"]["2"]["test"]["calibrated"]["auc"],
        "first_innings_auc": metrics["innings"]["1"]["test"]["calibrated"]["auc"],
    }
    yield
    store.clear()


app = FastAPI(title="Cricket Oracle", lifespan=lifespan)


@app.middleware("http")
async def revalidate_site_files(request, call_next):
    response = await call_next(request)
    # Without this, browsers heuristically reuse stale JS and CSS after an update. no-cache still
    # allows cheap 304 revalidation through the ETags StaticFiles already sends.
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.get("/api/model")
def model_info():
    oracle = store["oracle"]
    return {**store["metrics"], "league_par": oracle.league_par, "venues": oracle.venue_pars}


@app.get("/api/stats")
def stats():
    return store["stats"]


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


@app.get("/api/upcoming")
def upcoming():
    # A plain def runs in the threadpool, so the blocking fixtures request never stalls the event loop.
    return {**fixtures.upcoming(store["prematch"], store["oracle"]), "prematch_report": store["prematch_report"]}


@app.get("/api/logos")
def team_logos():
    """Logo links by team slug (see oracle.logos.slug), for the teams the site can show a logo for."""
    return {"logos": logos.available()}


@app.get("/api/images")
def images():
    """Photos and video loops dropped into web/images, for the page's photo slots."""
    files = sorted(IMAGES_DIR.glob("*")) if IMAGES_DIR.exists() else []
    listing = lambda types: [{"name": p.name, "url": f"/images/{quote(p.name)}"} for p in files if p.suffix.lower() in types]
    return {"images": listing(IMAGE_TYPES), "videos": listing(VIDEO_TYPES)}


def serve_page(name):
    def page():
        return FileResponse(config.WEB_DIR / f"{name}.html")

    return page


for page_name in PAGES:
    app.get(f"/{page_name}", include_in_schema=False)(serve_page(page_name))

app.mount("/reports", StaticFiles(directory=config.REPORTS_DIR), name="reports")
app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
