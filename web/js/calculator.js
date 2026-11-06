import { api, clamp, confidence, confidenceLabel, fillSelect, h, initChrome, overs, pct, plural, stopTween, tweenPercent } from "./core.js";
import { createHeatmap } from "./heatmap.js";

const FIELDS = ["runs", "wickets", "overs", "target"];
const PRESETS = {
  thriller: { innings: 2, runs: 165, wickets: 7, overs: "19", target: 180 },
  cruise: { innings: 2, runs: 120, wickets: 2, overs: "14", target: 160 },
  collapse: { innings: 2, runs: 98, wickets: 6, overs: "12", target: 190 },
  blitz: { innings: 1, runs: 72, wickets: 0, overs: "6" },
  par: { innings: 1, runs: 88, wickets: 2, overs: "10" },
};

const $ = (id) => document.getElementById(id);
const form = $("whatif-form");
const els = {
  result: $("whatif-result"),
  targetField: $("wi-target-field"),
  p1: $("wi-p1"),
  p2: $("wi-p2"),
  side1: $("wi-side-1"),
  side2: $("wi-side-2"),
  bar: $("wi-bar"),
  summary: $("wi-summary"),
  confidence: $("wi-confidence"),
  confidenceLabel: $("wi-confidence-label"),
  confidenceNote: $("wi-confidence-note"),
  swings: $("wi-swings"),
  swingsTitle: $("wi-swings-title"),
  swingList: $("wi-swing-list"),
  heat: $("calc-heat"),
  heatNote: $("calc-heat-note"),
  heatWrap: $("calc-heat-wrap"),
  heatCaption: $("calc-heat-caption"),
  heatReadout: $("calc-readout"),
};
const calc = { timer: null, request: 0, touched: new Set(), heatKey: "", pendingVenue: null, model: null, last: null };
const heatmap = createHeatmap($("calc-heatmap"), { onHover: renderHeatReadout });

const predict = (state) =>
  api("/api/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });

function readWhatIf() {
  const fields = form.elements;
  const innings = Number(fields.innings.value);
  const errors = {};
  const whole = (name, lo, hi, message) => {
    const raw = fields[name].value.trim();
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < lo || value > hi) errors[name] = message;
    return value;
  };

  const runs = whole("runs", 0, 400, "Enter runs from 0 to 400.");
  const wickets = whole("wickets", 0, 10, "Enter wickets from 0 to 10.");
  const target = innings === 2 ? whole("target", 1, 300, "Enter a target from 1 to 300.") : null;
  const parts = /^(\d{1,2})(?:\.([0-5]))?$/.exec(fields.overs.value.trim());
  const balls = parts ? Number(parts[1]) * 6 + Number(parts[2] ?? 0) : NaN;
  if (!parts) errors.overs = "Use overs.balls, like 14.2. Balls after the dot run from 0 to 5.";
  else if (balls > 120) errors.overs = "A T20 innings has at most 20 overs.";

  return { errors, value: { innings, runs, wickets, balls, target, venue: fields.venue.value || null } };
}

// Errors appear once a field has been left, and clear as soon as it is fixed.
function renderFieldErrors(errors, reveal) {
  for (const name of FIELDS) {
    const box = $(`wi-${name}-error`);
    const show = Boolean(errors[name]) && calc.touched.has(name) && (reveal || !box.hidden);
    box.hidden = !show;
    box.textContent = show ? errors[name] : "";
    form.elements[name].setAttribute("aria-invalid", String(show));
  }
}

function scheduleWhatIf() {
  clearTimeout(calc.timer);
  calc.timer = setTimeout(runWhatIf, 250);
}

function setUnavailable(state, message) {
  els.result.dataset.state = state;
  stopTween(els.p1);
  stopTween(els.p2);
  els.p1.textContent = els.p2.textContent = "–";
  delete els.side1.dataset.fav;
  delete els.side2.dataset.fav;
  els.summary.textContent = message;
  els.swings.hidden = true;
  els.confidence.hidden = true;
  calc.last = null;
}

async function runWhatIf() {
  clearTimeout(calc.timer);
  const { errors, value } = readWhatIf();
  els.targetField.hidden = value.innings !== 2;
  renderFieldErrors(errors, false);

  const request = ++calc.request;
  if (Object.keys(errors).length) {
    setUnavailable("invalid", "Finish describing the situation to see who's favourite.");
    return;
  }

  els.result.dataset.state = "loading";
  try {
    const body = await predict(value);
    if (request !== calc.request) return;
    renderWhatIf(value, body);
    syncUrl(value);
    updateChaseMap(value);
    renderSwings(value, body.p_batting_side_wins, request);
  } catch (error) {
    if (request !== calc.request) return;
    setUnavailable("error", `Couldn't get a prediction. ${error.message}`);
  }
}

function describeWhatIf({ innings, runs, wickets, balls, target, venue }, venuePar) {
  const where = venue ? `at ${venue}` : "across the league";
  const par = Math.round(venuePar);
  if (innings === 1) {
    const rate = ((runs * 6) / Math.max(balls, 1)).toFixed(2);
    const parPace = Math.round((venuePar * balls) / 120);
    const gap = runs - parPace;
    const pace = gap === 0 ? "exactly on par pace" : `${plural(Math.abs(gap), "run")} ${gap > 0 ? "ahead of" : "behind"} par pace`;
    return `${runs}/${wickets} after ${overs(balls)} overs, a run rate of ${rate}. Par ${where} is ${par}, so that is ${pace}.`;
  }
  const need = target - runs;
  const left = 120 - balls;
  if (need <= 0) return "The target has already been reached.";
  if (wickets >= 10) return "The chasing side is all out.";
  if (left === 0) return "No balls are left, so the chase has fallen short.";
  const gap = target - par;
  const vsPar = gap === 0 ? `exactly par ${where}` : `${Math.abs(gap)} ${gap > 0 ? "above" : "below"} par ${where} (${par})`;
  return (
    `${plural(need, "run")} needed off ${plural(left, "ball")} with ${plural(10 - wickets, "wicket")} in hand, ` +
    `a required rate of ${((need * 6) / left).toFixed(2)}. The target of ${target} is ${vsPar}.`
  );
}

function renderWhatIf(value, body) {
  const pFirst = value.innings === 1 ? body.p_batting_side_wins : 1 - body.p_batting_side_wins;
  tweenPercent(els.p1, pFirst, { initial: 0.5 });
  tweenPercent(els.p2, 1 - pFirst, { initial: 0.5 });
  els.side1.dataset.fav = String(pFirst >= 0.5);
  els.side2.dataset.fav = String(pFirst < 0.5);
  els.bar.style.setProperty("--p", pFirst);
  els.summary.textContent = describeWhatIf(value, body.venue_par);
  els.result.dataset.state = "ready";
  els.result.dataset.innings = String(value.innings);
  calc.last = { value, pFirst };
  renderConfidence();
}

function renderConfidence() {
  if (!calc.last) return;
  const { value, pFirst } = calc.last;
  const favourite = pFirst >= 0.5 ? "side batting first" : "chasing side";
  const { level, note } = confidence(calc.model, value.innings, value.balls, pFirst);
  els.confidence.hidden = false;
  els.confidence.dataset.level = level;
  els.confidenceLabel.textContent = confidenceLabel(level, favourite);
  els.confidenceNote.textContent = note;
}

function syncUrl(value) {
  const params = new URLSearchParams({ innings: value.innings, runs: value.runs, wickets: value.wickets, overs: overs(value.balls) });
  if (value.innings === 2) params.set("target", value.target);
  if (value.venue) params.set("venue", value.venue);
  history.replaceState(null, "", `?${params}`);
}

/* ---------- What moves the needle ---------- */

function scenariosFor(value) {
  const next = (change) => ({ ...value, ...change });
  return [
    ["A wicket next ball", next({ wickets: value.wickets + 1, balls: value.balls + 1 })],
    ["A dot ball", next({ balls: value.balls + 1 })],
    ["A four", next({ runs: value.runs + 4, balls: value.balls + 1 })],
    ["A six", next({ runs: value.runs + 6, balls: value.balls + 1 })],
    ["A 15-run over", next({ runs: value.runs + 15, balls: value.balls + 6 })],
  ].filter(([, state]) => state.balls <= 120 && state.wickets <= 10);
}

async function renderSwings(value, base, request) {
  const decided = value.balls >= 120 || value.wickets >= 10 || (value.innings === 2 && value.target - value.runs <= 0);
  if (decided) {
    els.swings.hidden = true;
    return;
  }
  const scenarios = scenariosFor(value);
  const results = await Promise.all(scenarios.map(([, state]) => predict(state).catch(() => null)));
  if (request !== calc.request) return;

  els.swingsTitle.textContent = `What moves the needle for the ${value.innings === 1 ? "side batting first" : "chasing side"}`;
  els.swingList.replaceChildren(
    ...scenarios.map(([label], i) => {
      if (!results[i]) return null;
      const p = results[i].p_batting_side_wins;
      const diff = Math.round((p - base) * 100);
      const row = h("li", { class: `swing${diff > 0 ? " is-up" : diff < 0 ? " is-down" : ""}` },
        h("span", { class: "swing-label", text: label }),
        h("span", { class: "swing-value tabular", text: pct(p) }),
        h("span", { class: "swing-diff tabular", text: diff === 0 ? "±0" : `${diff > 0 ? "+" : "−"}${Math.abs(diff)}` }),
      );
      row.style.setProperty("--i", i); // rows cascade in
      return row;
    }),
  );
  els.swings.hidden = false;
}

/* ---------- Chase map ---------- */

async function updateChaseMap(value) {
  const chasing = value.innings === 2;
  els.heat.hidden = !chasing;
  els.heatNote.hidden = chasing;
  if (!chasing) return;

  const wicketsInHand = clamp(10 - value.wickets, 1, 10);
  const params = { target: value.target, wickets: wicketsInHand, max_balls: 120 };
  if (value.venue) params.venue = value.venue;
  const key = JSON.stringify(params);
  if (key !== calc.heatKey) {
    calc.heatKey = key;
    els.heatWrap.dataset.loading = "true";
    try {
      const grid = await api(`/api/heatmap?${new URLSearchParams(params)}`);
      if (calc.heatKey !== key) return; // superseded by a newer situation
      heatmap.setGrid(grid);
    } catch (error) {
      calc.heatKey = "";
      els.heatReadout.textContent = `Couldn't draw the chase map. ${error.message}`;
      return;
    } finally {
      if (calc.heatKey === key || !calc.heatKey) els.heatWrap.dataset.loading = "false";
    }
  }

  const need = value.target - value.runs;
  const inPlay = need > 0 && value.wickets < 10 && value.balls < 120;
  heatmap.setMarker(inPlay ? { balls_remaining: 120 - value.balls, runs_required: need } : null);
  heatmap.draw();
  els.heatCaption.textContent =
    `Target ${value.target} with ${plural(wicketsInHand, "wicket")} in hand${value.venue ? ` at ${value.venue}` : ""}. ` +
    (inPlay ? "The dot marks your situation." : "Your situation is off the map because the chase is already decided.") +
    " The dashed line is a 50-50 contest.";
  renderHeatReadout(null);
}

function renderHeatReadout(cell) {
  const grid = heatmap.grid;
  if (!grid) return;
  els.heatReadout.textContent = !cell
    ? "Hover the map to try nearby situations."
    : cell.p === null
      ? `${plural(cell.r, "run")} needed off ${plural(cell.b, "ball")} can't happen in a chase of ${grid.target}.`
      : `${plural(cell.r, "run")} needed off ${plural(cell.b, "ball")} with ${grid.wickets_in_hand} wickets in hand: the chasing side wins ${pct(cell.p)}.`;
}

/* ---------- Setup ---------- */

function applyPreset(name) {
  const preset = PRESETS[name];
  const fields = form.elements;
  fields.innings.value = String(preset.innings);
  fields.runs.value = String(preset.runs);
  fields.wickets.value = String(preset.wickets);
  fields.overs.value = preset.overs;
  if (preset.target) fields.target.value = String(preset.target);
  calc.touched.clear();
  runWhatIf();
}

function prefill() {
  const query = new URLSearchParams(location.search);
  const fields = form.elements;
  if (["1", "2"].includes(query.get("innings"))) fields.innings.value = query.get("innings");
  for (const name of FIELDS) if (query.has(name)) fields[name].value = query.get(name);
  calc.pendingVenue = query.get("venue");
}

function fillVenues(venues) {
  const wanted = calc.pendingVenue ?? form.elements.venue.value;
  const options = Object.entries(venues)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, par]) => [name, `${name} · par ${Math.round(par)}`]);
  fillSelect(form.elements.venue, [["", "Any venue (league par)"], ...options], wanted);
  if (form.elements.venue.value !== wanted) form.elements.venue.value = "";
  const changed = Boolean(calc.pendingVenue);
  calc.pendingVenue = null;
  if (changed) runWhatIf();
}

function bind() {
  form.addEventListener("input", (event) => {
    if (event.target.name === "innings" || event.target.name === "venue") runWhatIf();
    else scheduleWhatIf();
  });
  form.addEventListener("change", (event) => {
    if (event.target.name === "venue") runWhatIf();
  });
  form.addEventListener("focusout", (event) => {
    if (!FIELDS.includes(event.target.name)) return;
    calc.touched.add(event.target.name);
    renderFieldErrors(readWhatIf().errors, true);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    FIELDS.forEach((name) => calc.touched.add(name));
    renderFieldErrors(readWhatIf().errors, true);
    runWhatIf();
  });
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });
}

initChrome();
prefill();
bind();
runWhatIf();
api("/api/model")
  .then((model) => {
    calc.model = model;
    renderConfidence();
    fillVenues(model.venues);
  })
  .catch(() => {
    calc.pendingVenue = null;
  });
