"""Turn a historical match into a ball-by-ball win-probability timeline."""
import numpy as np


def match_summary(match):
    return {
        "match_id": int(match["match_id"]),
        "date": match["date"],
        "year": int(match["year"]),
        "venue": match["venue"],
        "city": match["city"],
        "stage": match["stage"],
        "team1": match["team1"],
        "team2": match["team2"],
        "winner": match["winner"],
        "margin": match["margin"],
        "toss": f"{match['toss_winner']} chose to {match['toss_decision']}",
        "first_innings_total": int(match["first_innings_total"]),
        "target": int(match["target_runs"]),
        "max_balls": int(match["max_balls"]),
    }


def _optional(value, digits=None):
    if value is None or np.isnan(value):
        return None
    return round(float(value), digits) if digits is not None else int(value)


def replay(oracle, states, matches, match_id):
    """Match summary plus one entry per delivery, with P(team batting first wins)."""
    found = matches[matches["match_id"] == match_id]
    if found.empty:
        raise KeyError(match_id)
    match = found.iloc[0]
    rows = states[states["match_id"] == match_id].sort_values(["innings", "seq"])

    innings = rows["innings"].to_numpy()
    p_batting = np.empty(len(rows))
    for number in (1, 2):
        mask = innings == number
        if mask.any():
            p_batting[mask] = oracle.predict_states(rows[mask], number)
    p_team1 = np.where(innings == 1, p_batting, 1 - p_batting)

    timeline = [
        {
            "innings": int(r.innings),
            "label": r.label,
            "batter": r.batter,
            "bowler": r.bowler,
            "ball_runs": int(r.ball_runs),
            "batter_runs": int(r.batter_runs),
            "extra": r.extra_type,
            "legal": bool(r.legal),
            "wicket": r.wicket_kind,
            "player_out": r.player_out,
            "runs": int(r.runs_cum),
            "wickets": int(r.wickets_cum),
            "balls": int(r.balls_cum),
            "balls_remaining": int(r.balls_remaining),
            "current_run_rate": round(float(r.current_run_rate), 2),
            "runs_required": _optional(r.runs_required),
            "required_run_rate": _optional(r.required_run_rate, 2),
            "p_team1": round(float(p), 4),
        }
        for r, p in zip(rows.itertuples(index=False), p_team1)
    ]
    summary = match_summary(match)
    summary["venue_par"] = round(float(rows["venue_par"].iloc[0]), 1)
    return {"match": summary, "timeline": timeline}
