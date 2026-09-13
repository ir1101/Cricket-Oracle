import json

import pytest

from oracle import config, fixtures

SAMPLE = {
    "status": "success",
    "info": {"hitsToday": 3, "hitsLimit": 100},
    "data": [
        {"id": "result-1", "dateTimeGMT": "2026-09-10T14:00:00", "matchType": "t20", "ms": "result",
         "status": "India won by 6 wickets", "t1": "Australia [AUS]", "t2": "India [IND]",
         "t1s": "171/8 (20)", "t2s": "172/4 (18.3)", "series": "Australia tour of India 2026"},
        {"id": "fixture-1", "dateTimeGMT": "2026-09-16T14:00:00", "matchType": "t20", "ms": "fixture",
         "status": "Match starts at Sep 16, 14:00 GMT", "t1": "India [IND]", "t2": "Australia [AUS]",
         "t1s": "", "t2s": "", "series": "Australia tour of India 2026"},
        {"id": "odi-1", "dateTimeGMT": "2026-09-15T09:00:00", "matchType": "odi", "ms": "fixture",
         "t1": "England [ENG]", "t2": "Ireland [IRE]", "series": "Ireland tour of England 2026"},
        {"id": "live-1", "dateTimeGMT": "2026-09-14T13:00:00", "matchType": "t20", "ms": "live",
         "status": "Mumbai Indians need 40 runs in 24 balls", "t1": "Mumbai Indians [MI]",
         "t2": "Chennai Super Kings [CSK]", "t1s": "150/6 (16)", "t2s": "189/5 (20)",
         "series": "Indian Premier League 2027"},
    ],
}


class StubPrematch:
    def predict(self, team1, team2, competition=None, season=None):
        return {"p_team1": 0.6, "rating1": 1540, "rating2": 1500, "matches1": 30, "matches2": 25}


class StubOracle:
    def __init__(self, p=0.25):
        self.p = p
        self.calls = []

    def predict_one(self, innings, runs, balls, wickets, venue=None, target=None, max_balls=120):
        self.calls.append((innings, runs, balls, wickets, target))
        return self.p


@pytest.mark.parametrize("text, expected", [
    ("150/6 (16)", {"runs": 150, "wickets": 6, "balls": 96}),
    ("189/5 (19.4)", {"runs": 189, "wickets": 5, "balls": 118}),
    ("121 (18.2)", {"runs": 121, "wickets": 10, "balls": 110}),
    ("", None),
    ("Yet to bat", None),
])
def test_parse_score(text, expected):
    assert fixtures.parse_score(text) == expected


def test_split_team():
    assert fixtures.split_team("Mumbai Indians [MI]") == ("Mumbai Indians", "MI")
    assert fixtures.split_team("India") == ("India", None)


@pytest.mark.parametrize("series, teams, expected", [
    ("Indian Premier League 2027", ("Mumbai Indians", "Chennai Super Kings"), "ipl"),
    ("Women's Big Bash League 2026", ("Sydney Sixers Women", "Perth Scorchers Women"), None),
    ("Australia tour of India 2026", ("India", "Australia"), "t20i"),
    ("Nepal tour of Oman 2026", ("Nepal", "Oman"), None),
])
def test_competition_for(series, teams, expected):
    assert fixtures.competition_for(series, *teams) == expected


def test_build_fixtures_filters_orders_and_predicts():
    oracle = StubOracle(p=0.25)
    matches = fixtures.build_fixtures(SAMPLE, StubPrematch(), oracle)

    assert [m["id"] for m in matches] == ["live-1", "fixture-1", "result-1"]
    live = matches[0]
    assert oracle.calls == [(2, 150, 96, 6, 190)]  # CSK's innings is complete, so Mumbai are chasing 190
    assert live["live"]["batting"] == "Mumbai Indians"
    assert live["live"]["p_team1"] == 0.25
    assert live["competition"] == "ipl"
    assert matches[1]["prematch"]["p_team1"] == 0.6
    assert matches[1]["start"] == "2026-09-16T14:00:00Z"


@pytest.mark.parametrize("stamp, status, expected", [
    ("2026-09-13T23:00:00", "Match starts at Sep 14, 23:00 GMT", "2026-09-14T23:00:00Z"),
    ("2026-12-31T20:00:00", "Match starts at Jan 1, 20:00 GMT", "2027-01-01T20:00:00Z"),
    ("2026-09-10T14:00:00", "India won by 6 wickets", "2026-09-10T14:00:00Z"),
    ("", "Match starts at Sep 14, 23:00 GMT", ""),
])
def test_fixture_start_prefers_the_stated_start(stamp, status, expected):
    assert fixtures.fixture_start({"dateTimeGMT": stamp, "status": status}) == expected


def test_first_innings_odds_are_flipped_when_team2_bats_first():
    item = {"t1s": "", "t2s": "45/1 (5.2)"}
    odds = fixtures.live_odds(item, "Team One", "Team Two", StubOracle(p=0.7))
    assert odds["innings"] == 1
    assert odds["batting"] == "Team Two"
    assert odds["p_team1"] == pytest.approx(0.3)


def test_ambiguous_live_scores_give_no_odds():
    item = {"t1s": "80/2 (10)", "t2s": "75/3 (10)"}
    assert fixtures.live_odds(item, "A", "B", StubOracle()) is None


def test_api_key_comes_from_env_then_dotenv(tmp_path, monkeypatch):
    monkeypatch.delenv("CRICKETDATA_API_KEY", raising=False)
    monkeypatch.setattr(config, "ROOT", tmp_path)
    assert fixtures.api_key() is None

    (tmp_path / ".env").write_text("OTHER=1\nCRICKETDATA_API_KEY = 'abc-123'\n")
    assert fixtures.api_key() == "abc-123"

    monkeypatch.setenv("CRICKETDATA_API_KEY", "from-env")
    assert fixtures.api_key() == "from-env"


@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16"])
def test_api_key_survives_windows_file_encodings(tmp_path, monkeypatch, encoding):
    monkeypatch.delenv("CRICKETDATA_API_KEY", raising=False)
    monkeypatch.setattr(config, "ROOT", tmp_path)
    (tmp_path / ".env").write_text("CRICKETDATA_API_KEY=abc-123\n", encoding=encoding)
    assert fixtures.api_key() == "abc-123"


def _no_network(*args, **kwargs):
    raise AssertionError("the network should not be used")


def test_fresh_cache_avoids_calling_the_api(tmp_path, monkeypatch):
    cache = tmp_path / "cricscore.json"
    cache.write_text(json.dumps({"fetched_at": 1000.0, "payload": SAMPLE}))
    monkeypatch.setattr(config, "FIXTURE_CACHE_PATH", cache)
    monkeypatch.setattr(fixtures.urllib.request, "urlopen", _no_network)

    payload, fetched_at = fixtures.fetch_scores("key", now=1000.0 + 60)
    assert payload == SAMPLE
    assert fetched_at == 1000.0


def test_stale_cache_is_served_when_the_api_is_unreachable(tmp_path, monkeypatch):
    cache = tmp_path / "cricscore.json"
    cache.write_text(json.dumps({"fetched_at": 0.0, "payload": SAMPLE}))
    monkeypatch.setattr(config, "FIXTURE_CACHE_PATH", cache)

    def unreachable(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(fixtures.urllib.request, "urlopen", unreachable)
    payload, fetched_at = fixtures.fetch_scores("key", now=10**9)
    assert payload == SAMPLE and fetched_at == 0.0


def test_unreachable_api_without_cache_is_a_readable_error(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "FIXTURE_CACHE_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(fixtures, "api_key", lambda: "secret-key")

    def unreachable(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(fixtures.urllib.request, "urlopen", unreachable)
    result = fixtures.upcoming()
    assert result["status"] == "error"
    assert "secret-key" not in result["message"]


def test_upcoming_reports_a_missing_key(monkeypatch):
    monkeypatch.setattr(fixtures, "api_key", lambda: None)
    assert fixtures.upcoming() == {"status": "no_key", "matches": []}
