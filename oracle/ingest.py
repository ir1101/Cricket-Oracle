"""Download Cricsheet T20 ball-by-ball JSON and flatten it into parquet tables.

    python -m oracle.ingest [--competitions ipl bbl ...] [--force]
"""
import argparse
import json
import re
import urllib.request
import zipfile

import pandas as pd

from oracle import config

# Batters who retire are not dismissed, so they do not cost the side a wicket.
NON_DISMISSALS = {"retired hurt", "retired not out"}


def download(competition, force=False):
    archive = config.COMPETITIONS[competition]
    path = config.DATA_RAW / archive
    if path.exists() and not force:
        return path
    config.DATA_RAW.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(f"{config.CRICSHEET_DOWNLOADS}/{archive}", path)
    return path


def normalize_venue(name):
    name = re.sub(r"\s+", " ", name.split(",")[0].replace(".", " ")).strip()
    return config.VENUE_ALIASES.get(name, name)


def normalize_team(name):
    return config.TEAM_ALIASES.get(name, name)


def overs_to_balls(overs):
    """Cricsheet writes partial overs as e.g. 17.3 (17 overs and 3 balls)."""
    whole = int(overs)
    return whole * 6 + round((float(overs) - whole) * 10)


def describe_margin(by):
    return " ".join(f"{n} {kind[:-1] if n == 1 else kind}" for kind, n in by.items())


def describe_stage(event):
    if event.get("stage"):
        return event["stage"]
    return f"Match {event['match_number']}" if "match_number" in event else ""


def parse_match(match_id, data, competition=config.TARGET_COMPETITION):
    """Flatten one Cricsheet match into (match_row, delivery_rows), or None if excluded.

    Excluded: anything but a men's 20-over match of six-ball overs, T20 internationals not
    between two full members, no result, ties (settled by super over), results by a method
    such as D/L, and anything without exactly two regular innings.
    """
    info = data["info"]
    if info.get("gender", "male") != "male" or info.get("overs", 20) != 20 or info.get("balls_per_over", 6) != 6:
        return None
    if competition == "t20i" and not set(info["teams"]) <= config.T20I_FULL_MEMBERS:
        return None
    outcome = info["outcome"]
    if "winner" not in outcome or outcome.get("method"):
        return None
    innings = [inn for inn in data["innings"] if not inn.get("super_over")]
    if len(innings) != 2:
        return None

    rows = []
    totals = []
    for number, inn in enumerate(innings, start=1):
        seq = 0
        total = 0
        for over in inn["overs"]:
            legal_in_over = 0
            for d in over["deliveries"]:
                extras = d.get("extras", {})
                legal = "wides" not in extras and "noballs" not in extras
                legal_in_over += legal
                wickets = [w for w in d.get("wickets", []) if w["kind"] not in NON_DISMISSALS]
                rows.append({
                    "match_id": match_id,
                    "innings": number,
                    "seq": seq,
                    "over": over["over"],
                    # Illegal deliveries carry the number of the ball still to come.
                    "label": f"{over['over']}.{legal_in_over if legal else legal_in_over + 1}",
                    "batter": d["batter"],
                    "bowler": d["bowler"],
                    "ball_runs": d["runs"]["total"],
                    "batter_runs": d["runs"]["batter"],
                    "extra_type": next(iter(extras), ""),
                    "legal": legal,
                    "wicket": len(wickets),
                    "wicket_kind": wickets[0]["kind"] if wickets else "",
                    "player_out": wickets[0]["player_out"] if wickets else "",
                })
                seq += 1
                total += d["runs"]["total"]
        totals.append(total)

    target = innings[1].get("target", {})
    match = {
        "match_id": match_id,
        "competition": competition,
        "date": info["dates"][0],
        "year": int(info["dates"][0][:4]),
        "venue": normalize_venue(info["venue"]),
        "city": info.get("city") or "",
        "stage": describe_stage(info.get("event", {})),
        "team1": normalize_team(innings[0]["team"]),
        "team2": normalize_team(innings[1]["team"]),
        "winner": normalize_team(outcome["winner"]),
        "margin": describe_margin(outcome.get("by", {})),
        "toss_winner": normalize_team(info["toss"]["winner"]),
        "toss_decision": info["toss"]["decision"],
        "first_innings_total": totals[0],
        "target_runs": target.get("runs", totals[0] + 1),
        "max_balls": overs_to_balls(target["overs"]) if "overs" in target else config.BALLS_PER_INNINGS,
    }
    return match, rows


def build_tables(archives):
    """Parse {competition: zip path} into match and delivery tables, plus per-competition counts."""
    match_frames, delivery_frames, counts, seen = [], [], {}, set()
    for competition, path in archives.items():
        matches, deliveries, excluded = [], [], 0
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if not name.endswith(".json"):
                    continue
                match_id = int(name.rsplit("/", 1)[-1].removesuffix(".json"))
                parsed = None if match_id in seen else parse_match(match_id, json.loads(archive.read(name)), competition)
                if parsed is None:
                    excluded += 1
                    continue
                seen.add(match_id)
                matches.append(parsed[0])
                deliveries.extend(parsed[1])
        counts[competition] = {"kept": len(matches), "excluded": excluded}
        # Building a frame per archive keeps peak memory to one competition's worth of dicts.
        match_frames.append(pd.DataFrame(matches))
        delivery_frames.append(pd.DataFrame(deliveries))

    matches = pd.concat(match_frames, ignore_index=True).sort_values(["date", "match_id"], ignore_index=True)
    deliveries = pd.concat(delivery_frames, ignore_index=True).sort_values(["match_id", "innings", "seq"], ignore_index=True)
    return matches, deliveries, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--competitions", nargs="+", choices=list(config.COMPETITIONS), default=list(config.COMPETITIONS),
                        help="competitions to ingest (default: all)")
    parser.add_argument("--force", action="store_true", help="re-download the Cricsheet archives")
    args = parser.parse_args()
    if config.TARGET_COMPETITION not in args.competitions:
        parser.error(f"--competitions must include the target competition, {config.TARGET_COMPETITION}")

    archives = {competition: download(competition, args.force) for competition in args.competitions}
    matches, deliveries, counts = build_tables(archives)
    config.DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    matches.to_parquet(config.MATCHES_PATH, index=False)
    deliveries.to_parquet(config.DELIVERIES_PATH, index=False)

    for competition, n in counts.items():
        print(f"  {competition:<12} {n['kept']:>5} kept {n['excluded']:>5} excluded")
    print(
        f"{len(matches)} matches, {len(deliveries)} deliveries, seasons {matches['year'].min()}-{matches['year'].max()}, "
        f"{matches['venue'].nunique()} venues"
    )


if __name__ == "__main__":
    main()
