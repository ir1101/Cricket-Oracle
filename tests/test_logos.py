import json

import pytest

from oracle import logos


@pytest.mark.parametrize("team, expected", [
    ("Chennai Super Kings", "chennai-super-kings"),
    ("Kings XI Punjab", "punjab-kings"),  # renamed franchises share a logo key
    ("Royal Challengers Bangalore", "royal-challengers-bengaluru"),
    ("St. Lucia Kings", "st-lucia-kings"),
])
def test_slug(team, expected):
    assert logos.slug(team) == expected


def test_sized_asks_for_a_bigger_image_and_keeps_the_rest_of_the_link():
    url = logos.sized("https://g.cricapi.com/iapi/135-6378.png?w=48&v=2", size=128)
    assert url == "https://g.cricapi.com/iapi/135-6378.png?w=128&v=2"
    assert logos.sized("https://g.cricapi.com/iapi/9.webp", size=96).endswith("9.webp?w=96")


def test_from_series_info_reads_team_info():
    payload = {"data": {"matchList": [
        {"teamInfo": [
            {"name": "Mumbai Indians", "shortname": "MI", "img": "https://g.cricapi.com/iapi/226.png?w=48"},
            {"name": "Delhi Capitals", "shortname": "DC"},  # no image
        ]},
        {"teams": ["Tbc", "Tbc"]},
    ]}}
    assert logos.from_series_info(payload) == {"mumbai-indians": "https://g.cricapi.com/iapi/226.png?w=128"}


def test_from_fixtures_strips_short_names():
    payload = {"data": [
        {"t1": "Mumbai Indians [MI]", "t1img": "https://g.cricapi.com/iapi/226.png?w=48",
         "t2": "Chennai Super Kings [CSK]"},
    ]}
    assert logos.from_fixtures(payload) == {"mumbai-indians": "https://g.cricapi.com/iapi/226.png?w=128"}


def test_from_wikipedia_follows_renames_and_drops_tracking_parameters():
    payload = {"query": {
        "redirects": [{"from": "Pune Warriors India", "to": "Pune Warriors India (cricket team)"}],
        "pages": {
            "1": {"title": "Deccan Chargers", "thumbnail": {
                "source": "https://upload.wikimedia.org/wikipedia/en/a/a6/DC.png?utm_source=en.wikipedia.org&utm_campaign=api"}},
            "2": {"title": "Pune Warriors India (cricket team)", "thumbnail": {"source": "https://upload.wikimedia.org/pwi.png"}},
            "-1": {"title": "Kochi Tuskers Kerala", "missing": ""},
        },
    }}
    articles = {"Deccan Chargers": "Deccan Chargers", "Pune Warriors": "Pune Warriors India", "Kochi Tuskers Kerala": "Kochi Tuskers Kerala"}
    assert logos.from_wikipedia(payload, articles) == {
        "deccan-chargers": "https://upload.wikimedia.org/wikipedia/en/a/a6/DC.png",
        "pune-warriors": "https://upload.wikimedia.org/pwi.png",
    }


def test_every_defunct_ipl_team_has_a_wikipedia_article():
    assert {logos.slug(team) for team in logos.WIKIPEDIA_TEAMS} == {
        "deccan-chargers", "gujarat-lions", "kochi-tuskers-kerala", "pune-warriors", "rising-pune-supergiant",
    }


def test_remember_only_writes_new_logos(tmp_path):
    cache = tmp_path / "logos.json"
    assert logos.remember({"a": "1", "b": "2"}, cache) == 2
    assert logos.remember({"a": "1"}, cache) == 0
    assert logos.remember({"a": "3", "c": "4"}, cache) == 2
    assert json.loads(cache.read_text()) == {"a": "3", "b": "2", "c": "4"}


def test_local_files_win_over_cached_links(tmp_path):
    cache = tmp_path / "logos.json"
    cache.write_text(json.dumps({"mumbai-indians": "https://cdn/mi.png", "delhi-capitals": "https://cdn/dc.png"}))
    folder = tmp_path / "logos"
    folder.mkdir()
    (folder / "mumbai-indians.svg").write_text("<svg/>")
    (folder / "notes.txt").write_text("not an image")

    found = logos.available(cache, folder)
    assert found == {"mumbai-indians": "/images/logos/mumbai-indians.svg", "delhi-capitals": "https://cdn/dc.png"}


def test_team_logo_prefers_local_then_feed_then_cache():
    known = {"mumbai-indians": "https://cdn/cached.png"}
    assert logos.team_logo("Mumbai Indians", None, known, {}) == "https://cdn/cached.png"
    assert logos.team_logo("Mumbai Indians", "https://cdn/feed.png?w=48", known, {}) == "https://cdn/feed.png?w=128"
    local = {"mumbai-indians": "/images/logos/mumbai-indians.png"}
    assert logos.team_logo("Mumbai Indians", "https://cdn/feed.png", known, local) == local["mumbai-indians"]
    assert logos.team_logo("Unknown XI", None, known, {}) is None
