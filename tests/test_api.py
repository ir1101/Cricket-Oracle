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
    calibrated = body["innings"]["2"]["reliability"]["calibrated"]
    assert calibrated and {"lo", "hi", "n", "predicted", "observed"} <= set(calibrated[0])
    assert set(body["served"]) == {"1", "2"}
    assert all(s["recipe"] in {"tuned", "refit"} and s["calibrated_on"] for s in body["served"].values())
    stages = body["confidence"]["stages"]
    assert stages and all({"innings", "from_over", "to_over", "accuracy", "matches", "by_band"} <= set(s) for s in stages)


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


def test_stats(client):
    body = client.get("/api/stats").json()
    assert body["ipl_matches"] > 1000
    assert body["ipl_deliveries"] > body["ipl_matches"]
    assert 0.5 < body["chase_auc"] <= 1


def test_images_lists_only_image_files(client):
    body = client.get("/api/images").json()
    assert all(item["name"].lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".avif")) for item in body["images"])


@pytest.mark.parametrize("path", ["/", "/history", "/upcoming", "/calculator"])
def test_pages_are_served(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


@pytest.mark.parametrize("path", ["/js/core.js", "/css/base.css", "/history"])
def test_site_files_are_revalidated(client, path):
    assert client.get(path).headers["cache-control"] == "no-cache"


def test_upcoming_without_a_key_explains_setup(client, monkeypatch):
    from oracle import fixtures

    monkeypatch.setattr(fixtures, "api_key", lambda: None)
    body = client.get("/api/upcoming").json()
    assert body["status"] == "no_key"
    assert body["matches"] == []
