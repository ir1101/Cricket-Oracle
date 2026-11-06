"""Upcoming, live and recent T20 fixtures from CricketData.org, with Oracle predictions attached.

The API key comes from the CRICKETDATA_API_KEY environment variable or a local .env file. The free
tier allows 100 calls a day, so responses are cached on disk for FIXTURE_CACHE_MINUTES.
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from oracle import config, logos

SCORE = re.compile(r"(?P<runs>\d+)(?:/(?P<wickets>\d+))?\s*\((?P<overs>\d+)(?:\.(?P<balls>\d))?\)")
# The feed tags some shorter formats as "t20" (Hong Kong Sixes play 5 overs a side). The models only
# know men's 20-over cricket, so those series are left out along with women's matches.
OUT_OF_SCOPE_SERIES = ("women", "sixes", "t10", "hundred")
SHORT_NAME = re.compile(r"\s*\[(?P<short>[^\]]+)\]\s*$")
STATED_START = re.compile(r"starts at (?P<month>[A-Z][a-z]{2}) (?P<day>\d{1,2}), (?P<hour>\d{1,2}):(?P<minute>\d{2}) GMT")


class FixtureError(Exception):
    """The fixtures API could not provide data. The message is safe to show on the page."""


def api_key():
    key = os.environ.get("CRICKETDATA_API_KEY", "").strip()
    if key:
        return key
    env_file = config.ROOT / ".env"
    if env_file.exists():
        raw = env_file.read_bytes()
        # Windows editors and PowerShell redirection may save the file with a BOM or as UTF-16.
        text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig", errors="replace")
        for line in text.splitlines():
            name, sep, value = line.partition("=")
            if sep and name.strip() == "CRICKETDATA_API_KEY":
                return value.strip().strip("'\"") or None
    return None


def fetch_scores(key, now=None):
    """The cricScore feed (last 7 days, live, next 7 days), cached on disk. Returns (payload, fetched_at)."""
    now = time.time() if now is None else now
    cache_path = config.FIXTURE_CACHE_PATH
    cached = json.loads(cache_path.read_text()) if cache_path.exists() else None
    if cached and now - cached["fetched_at"] < config.FIXTURE_CACHE_MINUTES * 60:
        return cached["payload"], cached["fetched_at"]

    url = f"{config.CRICKETDATA_URL}/cricScore?{urllib.parse.urlencode({'apikey': key})}"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            payload = json.load(response)
    except (OSError, ValueError) as error:
        if cached:  # a stale list beats an empty page
            return cached["payload"], cached["fetched_at"]
        # `from None` keeps the request URL, which contains the key, out of any traceback.
        raise FixtureError(f"CricketData.org could not be reached ({type(error).__name__}).") from None

    if payload.get("status") != "success":
        if cached:
            return cached["payload"], cached["fetched_at"]
        raise FixtureError(f"CricketData.org refused the request: {payload.get('reason') or 'no reason given'}.")

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"fetched_at": now, "payload": payload}))
    return payload, now


def split_team(raw):
    """'Mumbai Indians [MI]' -> ('Mumbai Indians', 'MI')."""
    raw = (raw or "").strip()
    found = SHORT_NAME.search(raw)
    return (raw[: found.start()].strip(), found["short"]) if found else (raw, None)


def parse_score(text):
    """'150/6 (16.2)' -> {'runs': 150, 'wickets': 6, 'balls': 98}. A score without wickets is all out."""
    found = list(SCORE.finditer(text or ""))
    if not found:
        return None
    last = found[-1]
    return {
        "runs": int(last["runs"]),
        "wickets": int(last["wickets"]) if last["wickets"] else 10,
        "balls": min(int(last["overs"]) * 6 + int(last["balls"] or 0), config.BALLS_PER_INNINGS),
    }


def fixture_start(item):
    """Start time as ISO UTC.

    When the status says "Match starts at Sep 14, 23:00 GMT", that wins: in the live feed, dateTimeGMT
    was a day earlier than the stated start for every upcoming match.
    """
    stamp = item.get("dateTimeGMT") or ""
    if stamp and not stamp.endswith("Z"):
        stamp += "Z"
    stated = STATED_START.search(item.get("status") or "")
    if not stamp or not stated:
        return stamp
    try:
        base = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        month = datetime.strptime(stated["month"], "%b").month
        # The status has no year, so take the reading closest to dateTimeGMT (handles New Year).
        candidates = [
            datetime(base.year + shift, month, int(stated["day"]), int(stated["hour"]), int(stated["minute"]), tzinfo=timezone.utc)
            for shift in (-1, 0, 1)
        ]
    except ValueError:
        return stamp
    return min(candidates, key=lambda c: abs(c - base)).strftime("%Y-%m-%dT%H:%M:%SZ")


def in_scope(series, team1, team2):
    """True for men's 20-over matches, the only ones the models were trained on."""
    name = (series or "").casefold()
    if any(word in name for word in OUT_OF_SCOPE_SERIES):
        return False
    return not any(team.casefold().endswith(" women") for team in (team1, team2))


def competition_for(series, team1, team2):
    """Best-guess competition code for a fixture, or None for women's and unknown competitions."""
    name = (series or "").casefold()
    if "women" in name:
        return None
    for keyword, code in config.SERIES_COMPETITIONS.items():
        if keyword in name:
            return code
    if {team1, team2} <= config.T20I_FULL_MEMBERS:
        return "t20i"
    return None


def _innings_done(score):
    return score["balls"] >= config.BALLS_PER_INNINGS or score["wickets"] >= 10


def live_odds(item, team1, team2, oracle):
    """In-play odds for a live T20 read from its score strings, or None when the state is ambiguous."""
    scores = (parse_score(item.get("t1s")), parse_score(item.get("t2s")))
    if scores[0] and scores[1]:
        done = [_innings_done(s) for s in scores]
        if done[0] == done[1]:
            return None
        batting = 1 if done[0] else 0
        innings, target = 2, scores[1 - batting]["runs"] + 1
    elif scores[0] or scores[1]:
        batting = 0 if scores[0] else 1
        innings, target = 1, None
    else:
        return None

    score = scores[batting]
    p_batting = oracle.predict_one(innings, score["runs"], score["balls"], score["wickets"], target=target)
    return {
        "innings": innings,
        "batting": (team1, team2)[batting],
        **score,
        "target": target,
        "p_team1": round(p_batting if batting == 0 else 1 - p_batting, 4),
    }


def build_fixtures(payload, prematch=None, oracle=None, known_logos=None, local_logos=None):
    """Men's T20 fixtures from a cricScore payload: live first, then upcoming by start, then recent results.

    `known_logos` and `local_logos` default to the logo cache and web/images/logos/.
    """
    known = logos.load() if known_logos is None else known_logos
    local = logos.local_files() if local_logos is None else local_logos
    fixtures = []
    for item in payload.get("data") or []:
        if (item.get("matchType") or "").lower() != "t20":
            continue
        (team1, short1), (team2, short2) = split_team(item.get("t1")), split_team(item.get("t2"))
        if not team1 or not team2 or not in_scope(item.get("series"), team1, team2):
            continue
        state = {"live": "live", "result": "result"}.get(item.get("ms"), "upcoming")
        start = fixture_start(item)
        competition = competition_for(item.get("series"), team1, team2)
        fixtures.append({
            "id": item.get("id"),
            "start": start,
            "state": state,
            "status": item.get("status") or "",
            "series": item.get("series") or "",
            "competition": competition,
            "team1": team1,
            "team2": team2,
            "short1": short1,
            "short2": short2,
            "logo1": logos.team_logo(team1, item.get("t1img"), known, local),
            "logo2": logos.team_logo(team2, item.get("t2img"), known, local),
            "score1": item.get("t1s") or "",
            "score2": item.get("t2s") or "",
            "prematch": prematch.predict(team1, team2, competition, int(start[:4]) if start else None) if prematch else None,
            "live": live_odds(item, team1, team2, oracle) if state == "live" and oracle else None,
        })

    by_start = sorted(fixtures, key=lambda f: f["start"])
    return (
        [f for f in by_start if f["state"] == "live"]
        + [f for f in by_start if f["state"] == "upcoming"]
        + [f for f in reversed(by_start) if f["state"] == "result"]
    )


def upcoming(prematch=None, oracle=None, now=None):
    key = api_key()
    if not key:
        return {"status": "no_key", "matches": []}
    try:
        payload, fetched_at = fetch_scores(key, now)
    except FixtureError as error:
        return {"status": "error", "message": str(error), "matches": []}
    logos.remember(logos.from_fixtures(payload))  # so the replay pages can show these teams' logos too
    info = payload.get("info") or {}
    return {
        "status": "ok",
        "fetched_at": datetime.fromtimestamp(fetched_at, timezone.utc).isoformat(timespec="seconds"),
        "cache_minutes": config.FIXTURE_CACHE_MINUTES,
        "hits_today": info.get("hitsToday"),
        "hits_limit": info.get("hitsLimit"),
        "matches": build_fixtures(payload, prematch, oracle),
    }
