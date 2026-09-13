import {
  abbr, api, clamp, confidence, confidenceLabel, fillSelect, formatDate, formatNumber, h, initChrome, overs, pct, plural,
} from "./core.js";
import { createHeatmap } from "./heatmap.js";

const MODEL_LABELS = {
  logistic: "Logistic baseline",
  gbm: "Gradient-boosted",
  blend: "Blend",
  calibrated: "Calibrated blend",
};
const CHART_MARGIN = { l: 48, r: 12, t: 12, b: 26 };
const CHART_HEIGHT = 240;
const CHART_HINT = "Hover to read any ball · click or drag to jump to it";

const els = Object.fromEntries(
  [
    "year", "team", "match", "error", "error-text", "retry", "stage", "match-title", "match-meta",
    "side-1", "side-2", "probbar", "confidence", "confidence-label", "confidence-note", "situation", "this-ball", "recent", "result",
    "to-start", "back", "play", "forward", "to-end", "to-chase", "to-calculator", "speed", "scrubber", "position",
    "chart", "chart-readout", "moments", "heat-caption", "wickets", "wickets-out", "follow", "heat-wrap", "heatmap", "legend-1", "legend-2",
    "readout", "split", "model-grid",
  ].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]),
);

const state = {
  match: null,
  timeline: [],
  index: 0,
  inningsStart: -1,
  timer: null,
  speed: 3,
  follow: true,
  wickets: 10,
  grids: new Map(),
  gridKey: "",
  hover: null,
  chartHover: null,
  model: null,
};

const heatmap = createHeatmap(els.heatmap, {
  onHover(cell) {
    state.hover = cell;
    renderReadout();
  },
});

function showError(message, retry) {
  els.errorText.textContent = message;
  els.error.hidden = false;
  els.retry.onclick = () => {
    els.error.hidden = true;
    retry();
  };
}

/* ---------- Match list ---------- */

async function loadListing(year, team, preferredId) {
  const params = new URLSearchParams();
  if (year) params.set("year", year);
  if (team) params.set("team", team);
  const listing = await api(`/api/matches?${params}`);

  fillSelect(els.year, listing.years.map((y) => [y, y]), listing.year);
  if (els.team.options.length <= 1) {
    fillSelect(els.team, [["", "All teams"], ...listing.teams.map((t) => [t, t])], team ?? "");
  }
  if (!listing.matches.length) {
    fillSelect(els.match, [["", `No ${team ? `${abbr(team)} ` : ""}matches in ${listing.year}`]], "");
    els.match.disabled = true;
    return null;
  }
  const label = (m) => `${formatDate(m.date, { day: "numeric", month: "short" })} · ${abbr(m.team1)} v ${abbr(m.team2)}${m.stage ? ` · ${m.stage}` : ""}`;
  fillSelect(els.match, listing.matches.map((m) => [m.match_id, label(m)]), preferredId);
  if (!els.match.value) els.match.value = String(listing.matches[0].match_id);
  els.match.disabled = false;
  return Number(els.match.value);
}

async function changeListing() {
  try {
    const id = await loadListing(Number(els.year.value), els.team.value || null, state.match?.match_id);
    if (id && id !== state.match?.match_id) await loadMatch(id);
  } catch (error) {
    showError(error.message, changeListing);
  }
}

async function loadMatch(id) {
  pause();
  els.stage.setAttribute("aria-busy", "true");
  try {
    const data = await api(`/api/matches/${id}/replay`);
    state.match = data.match;
    state.timeline = data.timeline;
    state.inningsStart = data.timeline.findIndex((t) => t.innings === 2);
    state.grids.clear();
    state.gridKey = "";
    state.chartHover = null;

    if (Number(els.year.value) !== data.match.year) {
      await loadListing(data.match.year, els.team.value || null, id);
    }
    els.match.value = String(id);
    history.replaceState(null, "", `#match=${id}`);
    els.scrubber.max = String(data.timeline.length - 1);
    renderMatchHead();
    seek(0);
  } catch (error) {
    showError(error.message, () => loadMatch(id));
  } finally {
    els.stage.setAttribute("aria-busy", "false");
  }
}

/* ---------- Playback ---------- */

function seek(index) {
  if (!state.timeline.length) return;
  state.index = clamp(index, 0, state.timeline.length - 1);
  els.scrubber.value = String(state.index);
  const ball = state.timeline[state.index];
  renderBoard(ball);
  renderTransport(ball);
  renderMoments();
  if (state.chartHover !== null) renderChartReadout();
  drawChart();
  updateHeatmap(ball);
}

function play() {
  if (!state.timeline.length) return;
  if (state.index >= state.timeline.length - 1) seek(0);
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.index >= state.timeline.length - 1) pause();
    else seek(state.index + 1);
  }, 1000 / state.speed);
  renderTransport(state.timeline[state.index]);
}

function pause() {
  clearInterval(state.timer);
  state.timer = null;
  renderTransport(state.timeline[state.index]);
}

function step(delta) {
  pause();
  seek(state.index + delta);
}

/* ---------- Scoreboard ---------- */

function renderMatchHead() {
  const m = state.match;
  els.matchTitle.textContent = `${m.team1} v ${m.team2}`;
  els.matchMeta.textContent = [m.stage, formatDate(m.date, { day: "numeric", month: "long", year: "numeric" }), m.venue, m.toss]
    .filter(Boolean)
    .join(" · ");
  els.side1.querySelector(".team-name").textContent = m.team1;
  els.side2.querySelector(".team-name").textContent = m.team2;
  els.legend1.textContent = `← ${abbr(m.team1)} favoured`;
  els.legend2.textContent = `${abbr(m.team2)} favoured →`;
  els.toChase.disabled = state.inningsStart < 0;
}

function describeBall(t) {
  if (t.wicket) return `OUT, ${t.player_out} (${t.wicket})`;
  if (t.extra === "wides") return plural(t.ball_runs, "wide");
  if (t.extra === "noballs") return t.batter_runs ? `No-ball, ${t.batter_runs} off the bat` : "No-ball";
  if (t.batter_runs === 6) return "SIX";
  if (t.batter_runs === 4) return "FOUR";
  if (t.extra === "legbyes") return plural(t.ball_runs, "leg bye");
  if (t.extra === "byes") return plural(t.ball_runs, "bye");
  return t.ball_runs ? plural(t.ball_runs, "run") : "No run";
}

function chipFor(t) {
  if (t.wicket) return ["W", "wicket"];
  if (t.extra === "wides") return [`${t.ball_runs}wd`, ""];
  if (t.extra === "noballs") return [`${t.ball_runs}nb`, ""];
  if (t.batter_runs === 6) return ["6", "six"];
  if (t.batter_runs === 4) return ["4", "four"];
  if (t.extra === "legbyes") return [`${t.ball_runs}lb`, ""];
  if (t.extra === "byes") return [`${t.ball_runs}b`, ""];
  return [t.ball_runs ? String(t.ball_runs) : "•", ""];
}

function setSide(el, score, p, batting) {
  el.querySelector(".team-score").textContent = score;
  el.querySelector(".team-prob").textContent = pct(p);
  el.dataset.batting = String(batting);
}

function renderBoard(t) {
  const { match, timeline, index, inningsStart } = state;
  const first = t.innings === 1 ? t : timeline[inningsStart - 1];
  setSide(els.side1, `${first.runs}/${first.wickets} (${overs(first.balls)})`, t.p_team1, t.innings === 1);
  setSide(els.side2, t.innings === 2 ? `${t.runs}/${t.wickets} (${overs(t.balls)})` : "Yet to bat", 1 - t.p_team1, t.innings === 2);
  els.probbar.style.setProperty("--p", t.p_team1);
  renderConfidence(t);

  if (t.innings === 1) {
    const inningsBreak = index === inningsStart - 1 ? ` · Innings break: ${abbr(match.team2)} need ${match.target}` : "";
    els.situation.textContent = `Run rate ${t.current_run_rate.toFixed(2)} · Venue par ${Math.round(match.venue_par)}${inningsBreak}`;
  } else if (t.runs_required > 0) {
    const required = t.balls_remaining ? t.required_run_rate.toFixed(2) : "–";
    els.situation.textContent =
      `${abbr(match.team2)} need ${plural(t.runs_required, "run")} off ${plural(t.balls_remaining, "ball")}` +
      ` · Required ${required} · Current ${t.current_run_rate.toFixed(2)}`;
  } else {
    els.situation.textContent = `${match.team2} reached the target of ${match.target}`;
  }

  const strong = document.createElement("strong");
  strong.textContent = describeBall(t);
  els.thisBall.replaceChildren(`${t.label} · ${t.bowler} to ${t.batter} · `, strong);

  const inningsFirst = t.innings === 2 ? inningsStart : 0;
  els.recent.replaceChildren(
    ...timeline.slice(Math.max(inningsFirst, index - 5), index + 1).map((ball) => {
      const [text, kind] = chipFor(ball);
      const li = document.createElement("li");
      li.className = `chip ${kind}`;
      li.textContent = text;
      li.title = `${ball.label}: ${describeBall(ball)}`;
      return li;
    }),
  );

  const finished = index === timeline.length - 1;
  els.result.hidden = !finished;
  els.result.textContent = finished ? `${match.winner} won by ${match.margin}` : "";
}

function renderConfidence(t) {
  const favourite = abbr(t.p_team1 >= 0.5 ? state.match.team1 : state.match.team2);
  const { level, note } = confidence(state.model, t.innings, t.balls, t.p_team1);
  els.confidence.dataset.level = level;
  els.confidenceLabel.textContent = confidenceLabel(level, favourite);
  els.confidenceNote.textContent = note;
}

function renderTransport(t) {
  const n = state.timeline.length;
  const playing = Boolean(state.timer);
  els.play.dataset.playing = String(playing);
  els.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  els.toStart.disabled = els.back.disabled = !n || state.index === 0;
  els.forward.disabled = els.toEnd.disabled = !n || state.index === n - 1;
  els.position.textContent = t ? `${t.innings === 1 ? "1st" : "2nd"} inns · ${t.label}` : "";
  if (t && state.match) {
    const params = new URLSearchParams({ innings: t.innings, runs: t.runs, wickets: t.wickets, overs: overs(t.balls), venue: state.match.venue });
    if (t.innings === 2) params.set("target", state.match.target);
    els.toCalculator.href = `/calculator?${params}`;
  }
}

/* ---------- Win probability chart ---------- */

function drawChart() {
  const { timeline, index, match, inningsStart } = state;
  if (!timeline.length) return;
  const width = els.chart.getBoundingClientRect().width || 600;
  const m = CHART_MARGIN;
  const w = width - m.l - m.r;
  const h = CHART_HEIGHT - m.t - m.b;
  const x = (i) => m.l + (i / Math.max(timeline.length - 1, 1)) * w;
  const y = (p) => m.t + (1 - p) * h;

  const played = timeline.slice(0, index + 1);
  const line = played.map((t, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(t.p_team1).toFixed(1)}`).join("");
  const area = `${line}L${x(index).toFixed(1)},${y(0.5)}L${x(0)},${y(0.5)}Z`;
  const wickets = played
    .map((t, i) => (t.wicket ? `<circle class="wk" cx="${x(i).toFixed(1)}" cy="${y(t.p_team1).toFixed(1)}" r="3"/>` : ""))
    .join("");
  const inningsBreak =
    inningsStart > 0 && index >= inningsStart
      ? `<line class="break" x1="${x(inningsStart)}" x2="${x(inningsStart)}" y1="${m.t}" y2="${m.t + h}"/>
         <text class="axis" x="${x(inningsStart) + 6}" y="${m.t + h - 4}">CHASE</text>`
      : "";
  // Tick every five overs per innings; the chase's ticks appear once it has started.
  const innings = [[0, inningsStart > 0 ? inningsStart : timeline.length]];
  if (inningsStart > 0 && index >= inningsStart) innings.push([inningsStart, timeline.length]);
  let overTicks = "";
  for (const [start, end] of innings) {
    overTicks += `<text class="axis" x="${x(start) + 2}" y="${m.t + h + 18}">${start ? "INN 2" : "INN 1"}</text>`;
    for (const over of [5, 10, 15]) {
      let at = -1;
      for (let k = start; k < end; k++) {
        if (timeline[k].balls >= over * 6) {
          at = k;
          break;
        }
      }
      if (at >= 0) {
        overTicks += `<line class="tick" x1="${x(at)}" x2="${x(at)}" y1="${m.t + h}" y2="${m.t + h + 5}"/>` +
          `<text class="axis" x="${x(at)}" y="${m.t + h + 18}" text-anchor="middle">${over}</text>`;
      }
    }
  }
  const hoverAt = state.chartHover;
  const guide = hoverAt === null
    ? ""
    : `<line class="guide" x1="${x(hoverAt)}" x2="${x(hoverAt)}" y1="${m.t}" y2="${m.t + h}"/>` +
      (hoverAt <= index ? `<circle class="hover-dot" cx="${x(hoverAt)}" cy="${y(timeline[hoverAt].p_team1)}" r="4"/>` : "");
  const current = played.at(-1);

  els.chart.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
  els.chart.setAttribute(
    "aria-label",
    `Win probability after ${current.label} of innings ${current.innings}: ${abbr(match.team1)} ${pct(current.p_team1)}, ${abbr(match.team2)} ${pct(1 - current.p_team1)}`,
  );
  els.chart.innerHTML = `
    <defs>
      <clipPath id="clip-top"><rect x="0" y="0" width="${width}" height="${y(0.5)}"/></clipPath>
      <clipPath id="clip-bottom"><rect x="0" y="${y(0.5)}" width="${width}" height="${CHART_HEIGHT}"/></clipPath>
    </defs>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(0.75)}" y2="${y(0.75)}"/>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(0.25)}" y2="${y(0.25)}"/>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(1)}" y2="${y(1)}"/>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="mid" x1="${m.l}" x2="${m.l + w}" y1="${y(0.5)}" y2="${y(0.5)}"/>
    <text class="axis axis-1" x="${m.l - 8}" y="${y(1) + 12}" text-anchor="end">${abbr(match.team1)}</text>
    <text class="axis" x="${m.l - 8}" y="${y(0.5) + 4}" text-anchor="end">50%</text>
    <text class="axis axis-2" x="${m.l - 8}" y="${y(0) - 4}" text-anchor="end">${abbr(match.team2)}</text>
    <path class="area-1" d="${area}" clip-path="url(#clip-top)"/>
    <path class="area-2" d="${area}" clip-path="url(#clip-bottom)"/>
    ${inningsBreak}
    <path class="line" d="${line}"/>
    ${wickets}
    ${overTicks}
    ${guide}
    <circle class="now" cx="${x(index).toFixed(1)}" cy="${y(current.p_team1).toFixed(1)}" r="4.5"/>`;
}

function chartIndexAt(event) {
  const rect = els.chart.getBoundingClientRect();
  const fraction = (event.clientX - rect.left - CHART_MARGIN.l) / (rect.width - CHART_MARGIN.l - CHART_MARGIN.r);
  return Math.round(clamp(fraction, 0, 1) * (state.timeline.length - 1));
}

function seekFromChart(event) {
  pause();
  seek(chartIndexAt(event));
}

function renderChartReadout() {
  const { match, timeline, chartHover: at } = state;
  if (at === null || !match) {
    els.chartReadout.textContent = CHART_HINT;
  } else if (at > state.index) {
    els.chartReadout.textContent = "Not played yet · click to jump ahead";
  } else {
    const t = timeline[at];
    els.chartReadout.textContent =
      `${t.innings === 1 ? "1st" : "2nd"} inns ${t.label} · ${describeBall(t)} · ` +
      `${abbr(match.team1)} ${pct(t.p_team1)} · ${abbr(match.team2)} ${pct(1 - t.p_team1)}`;
  }
}

/* ---------- Swing moments ---------- */

function renderMoments() {
  const { timeline, index, inningsStart, match } = state;
  const swings = [];
  for (let i = 1; i <= index; i++) {
    if (i === inningsStart) continue; // the hand-off between innings models isn't a moment on the field
    swings.push({ i, delta: timeline[i].p_team1 - timeline[i - 1].p_team1 });
  }
  const top = swings
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5)
    .filter((s) => Math.abs(s.delta) >= 0.02);

  if (!top.length) {
    els.moments.replaceChildren(h("li", { class: "moments-empty muted", text: "The biggest swings appear here as the match unfolds." }));
    return;
  }
  els.moments.replaceChildren(
    ...top.map(({ i, delta }) => {
      const t = timeline[i];
      const before = timeline[i - 1];
      const firstGained = delta > 0;
      const gainer = firstGained ? match.team1 : match.team2;
      const from = firstGained ? before.p_team1 : 1 - before.p_team1;
      const to = firstGained ? t.p_team1 : 1 - t.p_team1;
      const button = h("button", { type: "button", class: `moment ${firstGained ? "t1" : "t2"}`, "aria-current": i === index ? "true" : null },
        h("span", { class: "moment-delta tabular", text: `+${Math.round(Math.abs(delta) * 100)}` }),
        h("span", { class: "moment-body" },
          h("span", { class: "moment-title", text: `${t.innings === 1 ? "1st" : "2nd"} inns ${t.label} · ${describeBall(t)}` }),
          h("span", { class: "moment-meta mono muted", text: `${abbr(gainer)} ${pct(from)} → ${pct(to)} · ${t.bowler} to ${t.batter}` }),
        ),
      );
      button.addEventListener("click", () => {
        pause();
        seek(i);
      });
      return h("li", {}, button);
    }),
  );
}

/* ---------- Chase difficulty heatmap ---------- */

async function updateHeatmap(t) {
  const { match } = state;
  const chasing = t.innings === 2;
  if (state.follow) state.wickets = chasing ? clamp(10 - t.wickets, 1, 10) : 10;
  const params = {
    target: chasing ? match.target : Math.max(1, Math.round(match.venue_par)),
    wickets: state.wickets,
    venue: match.venue,
    max_balls: match.max_balls,
  };
  els.wickets.value = String(params.wickets);
  els.wicketsOut.textContent = String(params.wickets);
  els.heatCaption.textContent = chasing
    ? `${match.team2} chasing ${match.target}. Each cell is their chance of winning from that situation.`
    : `No target yet, so this shows a par chase of ${params.target} at ${match.venue}.`;

  const key = JSON.stringify(params);
  if (state.gridKey !== key) {
    state.gridKey = key;
    let grid = state.grids.get(key);
    if (!grid) {
      els.heatWrap.dataset.loading = "true";
      try {
        grid = await api(`/api/heatmap?${new URLSearchParams(params)}`);
        state.grids.set(key, grid);
      } catch (error) {
        state.gridKey = "";
        els.heatWrap.dataset.loading = "false";
        showError(error.message, () => seek(state.index));
        return;
      }
      if (state.gridKey !== key) return; // a newer request took over while this one was in flight
      els.heatWrap.dataset.loading = "false";
    }
    heatmap.setGrid(grid);
  }

  const current = state.timeline[state.index];
  const onMap = current.innings === 2 && heatmap.grid?.target === match.target;
  heatmap.setPath(
    onMap ? [{ balls_remaining: match.max_balls, runs_required: match.target }, ...state.timeline.slice(state.inningsStart, state.index + 1)] : [],
  );
  heatmap.setMarker(onMap ? current : null);
  heatmap.draw();
  renderReadout();
}

function renderReadout() {
  const t = state.timeline[state.index];
  const grid = heatmap.grid;
  if (!grid || !t) {
    els.readout.textContent = "";
    return;
  }
  const chaser = abbr(state.match.team2);
  const cell = state.hover;
  if (cell) {
    els.readout.textContent =
      cell.p === null
        ? `${plural(cell.r, "run")} needed off ${plural(cell.b, "ball")} can't happen in a chase of ${grid.target}.`
        : `${plural(cell.r, "run")} needed off ${plural(cell.b, "ball")} with ${grid.wickets_in_hand} wickets in hand: ${chaser} win ${pct(cell.p)}.`;
  } else if (t.innings === 2 && t.runs_required > 0 && t.balls_remaining > 0 && t.wickets < 10) {
    els.readout.textContent =
      `Now ${plural(t.runs_required, "run")} needed off ${plural(t.balls_remaining, "ball")}: ${chaser} ${pct(1 - t.p_team1)}. ` +
      "Hover the map to try other situations.";
  } else {
    els.readout.textContent = "Hover the map to see how hard any chase would be. The dashed line marks a 50-50 contest.";
  }
}

/* ---------- Model card ---------- */

function renderModelCard(model) {
  state.model = model;
  if (state.timeline.length) renderConfidence(state.timeline[state.index]);
  const { train, val, test } = model.split;
  const data = model.data;
  const others = data ? Object.keys(data.train_by_competition).length - 1 : 0;
  const sources = others
    ? ` Training also used matches from ${plural(others, "other T20 competition")} played before ${val[0]}.`
    : "";
  const describe = (s, name) =>
    s.recipe === "refit"
      ? `the ${name} model is retrained on every season through ${s.trained_through}, with calibration learned from held-out seasons`
      : `the ${name} model is trained through ${s.trained_through} and calibrated on ${s.calibrated_on.join(" and ")}`;
  const served = model.served?.["1"] && model.served?.["2"]
    ? ` In the live app, ${describe(model.served["1"], "first-innings")}, and ${describe(model.served["2"], "chase")}.`
    : "";
  els.split.textContent =
    `Scores below come from a model trained on IPL ${train[0]}–${train.at(-1)}, tuned on ${val.join(" and ")}, and tested on ${test.join(", ")}, ` +
    `a season it never saw.${sources}${served} Lower is better for log loss, Brier score and calibration error; higher is better for AUC.`;
  const panels = [["1", "First innings"], ["2", "Chase"]].map(([key, title], index) => modelPanel(model.innings[key], title, index));
  els.modelGrid.replaceChildren(...panels.map((panel) => panel.node));
  panels.forEach((panel) => panel.draw());
  new ResizeObserver(() => panels.forEach((panel) => panel.draw())).observe(els.modelGrid);
}

const SVG_NS = "http://www.w3.org/2000/svg";
// Drawn in this order, so the shipped calibrated blend sits on top.
const RELIABILITY_SERIES = [
  { key: "logistic", label: "Logistic baseline" },
  { key: "gbm", label: "Gradient-boosted" },
  { key: "calibrated", label: "Calibrated blend" },
];
const RELIABILITY_HINT = "Hover a band to compare predicted and observed win rates. Points on the dashed line are perfectly calibrated.";

function modelPanel(r, title, index) {
  const bins = r.reliability ?? {};
  const hidden = new Set();
  let hover = null;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "reliability-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Reliability diagram for the ${title.toLowerCase()} model: observed win rate against predicted probability on the test season.`);
  const readout = h("p", { class: "reliability-readout", text: RELIABILITY_HINT });

  const legend = h("div", { class: "reliability-legend", role: "group", "aria-label": "Show or hide models" },
    ...[...RELIABILITY_SERIES].reverse().map((series) => {
      const button = h("button", { type: "button", class: `legend-toggle series-${series.key}`, "aria-pressed": "true" },
        h("span", { class: "legend-swatch", "aria-hidden": "true" }),
        series.label,
      );
      button.addEventListener("click", () => {
        if (hidden.has(series.key)) hidden.delete(series.key);
        else hidden.add(series.key);
        button.setAttribute("aria-pressed", String(!hidden.has(series.key)));
        draw();
      });
      return button;
    }),
  );

  const final = r.test.calibrated;
  const kpi = (label, value) => h("div", { class: "kpi" }, h("dt", { class: "mono muted", text: label }), h("dd", { class: "tabular", text: value }));
  const cells = (s) => [s.log_loss.toFixed(3), s.brier.toFixed(3), s.auc.toFixed(3), `${(s.ece * 100).toFixed(1)}%`];
  const table = h("table", {},
    h("thead", {}, h("tr", {}, ...["Model", "Log loss", "Brier", "AUC", "Calib. error"].map((text) => h("th", { scope: "col", text })))),
    h("tbody", {}, ...Object.entries(r.test).map(([name, s]) =>
      h("tr", { class: name === "calibrated" ? "is-final" : "" },
        h("th", { scope: "row", text: MODEL_LABELS[name] ?? name }),
        ...cells(s).map((text) => h("td", { text })),
      ),
    )),
  );

  const node = h("article", { class: "model-panel" },
    h("div", { class: "model-panel-head" },
      h("p", { class: "mono muted", text: `(0${index + 1}) ${r.matches.test} test matches` }),
      h("h3", { text: title }),
    ),
    h("dl", { class: "kpis" },
      kpi("AUC", final.auc.toFixed(3)),
      kpi("Log loss", final.log_loss.toFixed(3)),
      kpi("Calib. error", `${(final.ece * 100).toFixed(1)}%`),
    ),
    h("figure", { class: "reliability" }, legend, svg, readout),
    h("div", { class: "table-wrap" }, table),
    h("p", { class: "mono muted", text: `Blend: ${Math.round(r.blend_weight * 100)}% gradient-boosted · ${r.gbm_trees} trees` }),
  );

  const inBand = (key, band) => (bins[key] ?? []).find((b) => Math.round(b.lo * 10) === band);

  function describe(band) {
    const range = `${band * 10}–${(band + 1) * 10}%`;
    const calibrated = inBand("calibrated", band);
    if (!calibrated) return `No calibrated predictions fell in the ${range} band.`;
    const others = [["gbm", "Gradient-boosted"], ["logistic", "Logistic"]]
      .filter(([key]) => !hidden.has(key) && inBand(key, band))
      .map(([key, label]) => `${label} ${pct(inBand(key, band).predicted)} → ${pct(inBand(key, band).observed)}`);
    return (
      `${range} band: the calibrated blend predicted ${pct(calibrated.predicted)}, and the batting side won ` +
      `${pct(calibrated.observed)} of ${formatNumber(calibrated.n)} deliveries.${others.length ? ` ${others.join(" · ")}.` : ""}`
    );
  }

  function draw() {
    const width = Math.round(svg.getBoundingClientRect().width) || 480;
    const height = Math.round(clamp(width * 0.8, 260, 440));
    const m = { l: 58, r: 12, t: 12, b: 46 };
    const w = width - m.l - m.r;
    const ht = height - m.t - m.b;
    const x = (v) => (m.l + v * w).toFixed(1);
    const y = (v) => (m.t + (1 - v) * ht).toFixed(1);
    const calibrated = bins.calibrated ?? [];
    const busiest = Math.max(1, ...calibrated.map((b) => b.n));
    const parts = [];

    if (hover !== null) {
      parts.push(`<rect class="rel-focus" x="${x(hover / 10)}" y="${m.t}" width="${(w / 10).toFixed(1)}" height="${ht}"/>`);
    }
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      parts.push(
        `<line class="rel-grid" x1="${x(0)}" x2="${x(1)}" y1="${y(t)}" y2="${y(t)}"/>`,
        `<line class="rel-grid" x1="${x(t)}" x2="${x(t)}" y1="${y(0)}" y2="${y(1)}"/>`,
        `<text class="rel-axis" x="${m.l - 10}" y="${(Number(y(t)) + 4).toFixed(1)}" text-anchor="end">${t * 100}%</text>`,
        `<text class="rel-axis" x="${x(t)}" y="${m.t + ht + 18}" text-anchor="middle">${t * 100}%</text>`,
      );
    }
    // How many deliveries each band holds, so sparse bands read as less certain.
    for (const b of calibrated) {
      const bar = (b.n / busiest) * ht * 0.22;
      parts.push(`<rect class="rel-bar" x="${(Number(x(b.lo)) + 2).toFixed(1)}" y="${(m.t + ht - bar).toFixed(1)}" width="${Math.max(0, w / 10 - 4).toFixed(1)}" height="${bar.toFixed(1)}"/>`);
    }
    parts.push(`<line class="rel-perfect" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>`);
    for (const series of RELIABILITY_SERIES) {
      const points = bins[series.key] ?? [];
      if (hidden.has(series.key) || !points.length) continue;
      const path = points.map((pt, i) => `${i ? "L" : "M"}${x(pt.predicted)},${y(pt.observed)}`).join("");
      const dots = points.map((pt) => `<circle class="rel-dot" cx="${x(pt.predicted)}" cy="${y(pt.observed)}" r="${series.key === "calibrated" ? 4.5 : 3}"/>`).join("");
      parts.push(`<g class="series-${series.key}"><path class="rel-line" d="${path}"/>${dots}</g>`);
    }
    parts.push(
      `<text class="rel-title" x="${x(0.5)}" y="${height - 6}" text-anchor="middle">PREDICTED WIN PROBABILITY</text>`,
      `<text class="rel-title" transform="translate(12 ${y(0.5)}) rotate(-90)" text-anchor="middle">OBSERVED WIN RATE</text>`,
    );
    for (let band = 0; band < 10; band++) {
      parts.push(`<rect class="rel-hit" data-band="${band}" x="${x(band / 10)}" y="${m.t}" width="${(w / 10).toFixed(1)}" height="${ht}"/>`);
    }

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.height = `${height}px`;
    svg.innerHTML = parts.join("");
  }

  svg.addEventListener("pointermove", (event) => {
    const hit = event.target.closest?.(".rel-hit");
    const band = hit ? Number(hit.dataset.band) : null;
    if (band === hover) return;
    hover = band;
    readout.textContent = hover === null ? RELIABILITY_HINT : describe(hover);
    draw();
  });
  svg.addEventListener("pointerleave", () => {
    hover = null;
    readout.textContent = RELIABILITY_HINT;
    draw();
  });

  return { node, draw };
}

/* ---------- Wiring ---------- */

function bind() {
  els.year.addEventListener("change", changeListing);
  els.team.addEventListener("change", changeListing);
  els.match.addEventListener("change", () => loadMatch(Number(els.match.value)));

  els.play.addEventListener("click", () => (state.timer ? pause() : play()));
  els.back.addEventListener("click", () => step(-1));
  els.forward.addEventListener("click", () => step(1));
  els.toStart.addEventListener("click", () => step(-state.index));
  els.toEnd.addEventListener("click", () => step(state.timeline.length));
  els.toChase.addEventListener("click", () => step(state.inningsStart - state.index));
  els.scrubber.addEventListener("input", () => step(Number(els.scrubber.value) - state.index));
  els.speed.addEventListener("change", () => {
    state.speed = Number(els.speed.value);
    if (state.timer) play();
  });

  els.chart.addEventListener("pointerdown", (event) => {
    if (!state.timeline.length) return;
    els.chart.setPointerCapture(event.pointerId);
    seekFromChart(event);
  });
  els.chart.addEventListener("pointermove", (event) => {
    if (!state.timeline.length) return;
    if (event.buttons) {
      seekFromChart(event);
      return;
    }
    const at = chartIndexAt(event);
    if (at === state.chartHover) return;
    state.chartHover = at;
    renderChartReadout();
    drawChart();
  });
  els.chart.addEventListener("pointerleave", () => {
    state.chartHover = null;
    renderChartReadout();
    drawChart();
  });
  new ResizeObserver(drawChart).observe(els.chart);

  els.wickets.addEventListener("input", () => {
    state.follow = false;
    els.follow.checked = false;
    state.wickets = Number(els.wickets.value);
    if (state.timeline.length) updateHeatmap(state.timeline[state.index]);
  });
  els.follow.addEventListener("change", () => {
    state.follow = els.follow.checked;
    if (state.timeline.length) updateHeatmap(state.timeline[state.index]);
  });

  document.addEventListener("keydown", (event) => {
    if (!state.timeline.length || event.target.matches("input, select, textarea") || event.metaKey || event.ctrlKey) return;
    const moves = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key === " " && !event.target.matches("button, a")) {
      event.preventDefault();
      state.timer ? pause() : play();
    } else if (event.key in moves) {
      event.preventDefault();
      step(moves[event.key] * (event.shiftKey ? 6 : 1));
    }
  });
}

async function boot() {
  api("/api/model")
    .then(renderModelCard)
    .catch(() => {
      els.split.textContent = "Model metrics are unavailable. Run `python -m oracle.train`, then restart the server.";
    });
  try {
    const fromHash = Number(new URLSearchParams(location.hash.slice(1)).get("match")) || null;
    const first = await loadListing(null, null, fromHash);
    if (fromHash || first) await loadMatch(fromHash ?? first);
  } catch (error) {
    els.stage.setAttribute("aria-busy", "false");
    els.matchTitle.textContent = "No match loaded";
    showError(error.message, boot);
  }
}

initChrome();
bind();
boot();
