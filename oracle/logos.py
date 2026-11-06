"""Team logos, looked up by team.

    python -m oracle.logos   # find IPL teams' logos, cached in data/cache

Logos are the teams' trademarks, so they are linked from where they are hosted rather than copied
into the project:
- the current IPL teams from CricketData.org, which serves them with its data (three API calls);
- the defunct IPL teams, which CricketData.org doesn't cover, from their Wikipedia articles (one call).
  Wikipedia hosts these logos under fair use for its own articles, which is fine for a personal or
  local site; publishing the site commercially would need permission from the rights holders.

The fixtures feed carries images for most teams as well, and those are added to the cache as fixtures
load. A file in web/images/logos/ named after the team (for example chennai-super-kings.png) always
takes priority. Teams with no logo get a monogram.
"""
import json
import re
import sys
import urllib.parse
import urllib.request

from oracle import config
from oracle.ingest import normalize_team

IMAGE_SUFFIXES = {".svg", ".png", ".webp", ".jpg", ".jpeg", ".avif"}
SHORT_NAME = re.compile(r"\s*\[[^\]]+\]\s*$")

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
# Wikipedia asks API clients to identify themselves; the default Python agent is often refused.
USER_AGENT = "CricketOracle/1.0 (personal cricket analytics app)"
# Defunct IPL franchises (names as in the data) -> the Wikipedia article whose infobox has the logo.
WIKIPEDIA_TEAMS = {
    "Deccan Chargers": "Deccan Chargers",
    "Gujarat Lions": "Gujarat Lions",
    "Kochi Tuskers Kerala": "Kochi Tuskers Kerala",
    "Pune Warriors": "Pune Warriors India",
    "Rising Pune Supergiant": "Rising Pune Supergiant",
}


def slug(team):
    """'Kings XI Punjab' -> 'punjab-kings': the key logos are stored and looked up under."""
    return re.sub(r"[^a-z0-9]+", "-", normalize_team(team).casefold()).strip("-")


def sized(url, size=config.LOGO_SIZE):
    """The same CricketData.org image at `size` pixels (its links default to 48)."""
    parts = urllib.parse.urlsplit(url)
    query = dict(urllib.parse.parse_qsl(parts.query))
    query["w"] = str(size)
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def load(path=None):
    path = path or config.LOGO_CACHE_PATH
    return json.loads(path.read_text()) if path.exists() else {}


def remember(found, path=None):
    """Add newly found logos to the cache. Returns how many were new or changed."""
    path = path or config.LOGO_CACHE_PATH
    logos = load(path)
    changed = {k: v for k, v in found.items() if logos.get(k) != v}
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict(sorted({**logos, **changed}.items())), indent=1))
    return len(changed)


def local_files(directory=None):
    """Logo files dropped into web/images/logos/, by file name."""
    directory = directory or config.LOGO_DIR
    if not directory.exists():
        return {}
    return {
        p.stem.casefold(): f"/images/logos/{urllib.parse.quote(p.name)}"
        for p in sorted(directory.iterdir())
        if p.suffix.lower() in IMAGE_SUFFIXES
    }


def available(cache_path=None, directory=None):
    """Every logo the site can show, by team slug. Local files win over cached links."""
    return {**load(cache_path), **local_files(directory)}


def from_series_info(payload):
    """Team logos from a CricketData.org series_info response."""
    found = {}
    for match in (payload.get("data") or {}).get("matchList") or []:
        for team in match.get("teamInfo") or []:
            if team.get("name") and team.get("img"):
                found[slug(team["name"])] = sized(team["img"])
    return found


def from_fixtures(payload):
    """Team logos carried by fixtures in a cricScore payload."""
    found = {}
    for item in payload.get("data") or []:
        for side in ("1", "2"):
            name = SHORT_NAME.sub("", item.get(f"t{side}") or "").strip()
            image = item.get(f"t{side}img")
            if name and image:
                found[slug(name)] = sized(image)
    return found


def from_wikipedia(payload, articles):
    """Logos from a Wikipedia pageimages response. `articles` maps team name -> article title."""
    query = payload.get("query") or {}
    renamed = {r["from"]: r["to"] for r in (query.get("normalized") or []) + (query.get("redirects") or [])}
    images = {page.get("title"): (page.get("thumbnail") or {}).get("source") for page in (query.get("pages") or {}).values()}
    found = {}
    for team, title in articles.items():
        final = title
        while final in renamed:  # a title can be normalised and then redirected
            final = renamed[final]
        if images.get(final):
            found[slug(team)] = _without_tracking(images[final])
    return found


def _without_tracking(url):
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if not k.startswith("utm_")]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def fetch_wikipedia(articles=WIKIPEDIA_TEAMS):
    """Logos from the main image of each team's Wikipedia article, in one request."""
    params = {
        "action": "query",
        "format": "json",
        "prop": "pageimages",
        "piprop": "thumbnail|name",
        "pithumbsize": 256,
        "pilicense": "any",  # team logos are non-free images, which the default excludes
        "redirects": 1,
        "titles": "|".join(articles.values()),
    }
    request = urllib.request.Request(f"{WIKIPEDIA_API}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Wikipedia could not be reached ({type(error).__name__}).") from None
    return from_wikipedia(payload, articles)


def team_logo(team, image=None, known=None, local=None):
    """The logo to show for one team: a local file, else the feed's image, else a cached link."""
    key = slug(team)
    local = local_files() if local is None else local
    known = load() if known is None else known
    if key in local:
        return local[key]
    return sized(image) if image else known.get(key)


def _call(key, endpoint, **params):
    url = f"{config.CRICKETDATA_URL}/{endpoint}?{urllib.parse.urlencode({'apikey': key, **params})}"
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = json.load(response)
    except (OSError, ValueError) as error:
        # `from None` keeps the request URL, which contains the key, out of any traceback.
        raise RuntimeError(f"CricketData.org could not be reached ({type(error).__name__}).") from None
    if payload.get("status") != "success":
        raise RuntimeError(f"CricketData.org refused the request: {payload.get('reason') or 'no reason given'}.")
    return payload


def fetch_ipl(key, seasons=2):
    """Logos for the teams in the latest IPL seasons that have fixtures (one call each, plus a search)."""
    series = _call(key, "series", offset=0, search="Indian Premier League").get("data") or []
    played = [s for s in series if s.get("t20") and "premier league" in (s.get("name") or "").casefold()]
    played.sort(key=lambda s: s.get("startDate") or "", reverse=True)
    found = {}
    for entry in reversed(played[:seasons]):  # newest last, so the latest logo wins
        found.update(from_series_info(_call(key, "series_info", id=entry["id"])))
    return found


def main():
    from oracle.fixtures import api_key

    failed = False
    key = api_key()
    sources = [("current IPL teams (CricketData.org)", lambda: fetch_ipl(key) if key else None),
               ("defunct IPL teams (Wikipedia)", fetch_wikipedia)]
    for label, fetch in sources:
        try:
            found = fetch()
        except RuntimeError as error:
            print(f"{label}: {error}")
            failed = True
            continue
        if found is None:
            print(f"{label}: skipped, add CRICKETDATA_API_KEY to .env to look these up")
            continue
        new = remember(found)
        print(f"{label}: {len(found)} logos ({new} new or changed): {', '.join(sorted(found))}")
    print(f"{len(available())} team logos available in all, cached in {config.LOGO_CACHE_PATH}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
