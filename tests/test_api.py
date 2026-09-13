import pytest

from oracle import config

ARTIFACTS = [
    config.MATCHES_PATH,
    config.STATES_PATH,
    config.METRICS_PATH,
    config.MODELS_DIR / "innings1.joblib",
    config.MODELS_DIR / "innings2.joblib",
]
pytestmark = pytest.mark.skipif(
    not all(p.exists() for p in ARTIFACTS),
    reason="run `python -m oracle.ingest` and `python -m oracle.train` first",
)


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from api.main import app

    with TestClient(app) as c:
        yield c


def test_model_card(client):
    body = client.get("/api/model").json()
    assert set(body["innings"]) == {"1", "2"}
    assert body["venues"]


def test_replay_ends_with_the_actual_winner(client):
    listing = client.get("/api/matches").json()
    match = listing["matches"][0]
    body = client.get(f"/api/matches/{match['match_id']}/replay").json()

    timeline = body["timeline"]
    assert timeline and all(0 <= t["p_team1"] <= 1 for t in timeline)
    assert {t["innings"] for t in timeline} == {1, 2}
    assert round(timeline[-1]["p_team1"]) == (body["match"]["winner"] == body["match"]["team1"])


def test_unknown_match_is_404(client):
    assert client.get("/api/matches/1/replay").status_code == 404


def test_heatmap_shape(client):
    body = client.get("/api/heatmap", params={"target": 190, "wickets": 7}).json()
    assert len(body["p"]) == 190
    assert all(len(row) == 120 for row in body["p"])


def test_predict(client):
    ok = client.post("/api/predict", json={"innings": 2, "runs": 100, "balls": 72, "wickets": 3, "target": 180})
    assert ok.status_code == 200
    assert 0 < ok.json()["p_batting_side_wins"] < 1
    assert ok.json()["known_venue"] is False
    assert client.post("/api/predict", json={"innings": 2, "runs": 100, "balls": 72, "wickets": 3}).status_code == 422
    assert client.post("/api/predict", json={"innings": 1, "runs": 50, "balls": 121, "wickets": 0}).status_code == 422


def test_predict_uses_the_venue_par(client):
    venues = client.get("/api/model").json()["venues"]
    venue, par = next(iter(venues.items()))
    body = client.post("/api/predict", json={"innings": 1, "runs": 80, "balls": 60, "wickets": 2, "venue": venue}).json()
    assert body["known_venue"] is True
    assert body["venue_par"] == par


def test_predict_finished_chase(client):
    body = client.post("/api/predict", json={"innings": 2, "runs": 181, "balls": 100, "wickets": 4, "target": 180}).json()
    assert body["p_batting_side_wins"] == 1.0
