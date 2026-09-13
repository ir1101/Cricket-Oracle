const TEAM_ABBR = {
  "Chennai Super Kings": "CSK",
  "Deccan Chargers": "DCG",
  "Delhi Capitals": "DC",
  "Gujarat Lions": "GL",
  "Gujarat Titans": "GT",
  "Kochi Tuskers Kerala": "KTK",
  "Kolkata Knight Riders": "KKR",
  "Lucknow Super Giants": "LSG",
  "Mumbai Indians": "MI",
  "Pune Warriors": "PWI",
  "Punjab Kings": "PBKS",
  "Rajasthan Royals": "RR",
  "Rising Pune Supergiant": "RPS",
  "Royal Challengers Bengaluru": "RCB",
  "Sunrisers Hyderabad": "SRH",
};

const MODEL_LABELS = {
  logistic: "Logistic baseline",
  gbm: "Gradient-boosted",
  blend: "Blend",
  calibrated: "Calibrated blend",
};

const UNREACHABLE = [226, 223, 215];
const HEAT_MARGIN = { l: 52, r: 14, t: 14, b: 44 };
const CHART_MARGIN = { l: 48, r: 12, t: 12, b: 12 };
const CHART_HEIGHT = 220;

const els = Object.fromEntries(
  [
    "year", "team", "match", "error", "error-text", "retry", "stage", "match-title", "match-meta",
    "side-1", "side-2", "probbar", "situation", "this-ball", "recent", "result",
    "to-start", "back", "play", "forward", "to-end", "to-chase", "speed", "scrubber", "position", "chart",
    "heat-caption", "wickets", "wickets-out", "follow", "heat-wrap", "heatmap", "legend-1", "legend-2", "readout",
    "split", "model-grid",
    "whatif-form", "whatif-result", "wi-target-field", "wi-p1", "wi-p2", "wi-bar", "wi-summary", "wi-from-replay",
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
  grid: null,
  hover: null,
};

const abbr = (team) => TEAM_ABBR[team] ?? team.split(/\s+/).map((word) => word[0]).join("").toUpperCase();
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const overs = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const longDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

function pct(p) {
  if (p > 0.995 && p < 1) return ">99%";
  if (p < 0.005 && p > 0) return "<1%";
  return `${Math.round(p * 100)}%`;
}

async function api(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("Can't reach the Cricket Oracle server. Start it with `uvicorn api.main:app`, then try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `The server answered ${response.status}.`);
  }
  return response.json();
}

function showError(message, retry) {
  els.errorText.textContent = message;
  els.error.hidden = false;
  els.retry.onclick = () => {
    els.error.hidden = true;
    retry();
  };
}

function fillSelect(select, options, selected) {
  select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  select.value = String(selected ?? "");
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
  const label = (m) => `${shortDate(m.date)} · ${abbr(m.team1)} v ${abbr(m.team2)}${m.stage ? ` · ${m.stage}` : ""}`;
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
    state.grid = null;

    if (Number(els.year.value) !== data.match.year) {
      await loadListing(data.match.year, els.team.value || null, id);
    }
    els.match.value = String(id);
    history.replaceState(null, "", `#match=${id}`);
    els.scrubber.max = String(data.timeline.length - 1);
    renderMatchHead();
    seek(0);
    els.wiFromReplay.disabled = false;
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
  els.matchMeta.textContent = [m.stage, longDate(m.date), m.venue, m.toss].filter(Boolean).join(" · ");
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
  const recent = timeline.slice(Math.max(inningsFirst, index - 5), index + 1);
  els.recent.replaceChildren(
    ...recent.map((ball) => {
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

function renderTransport(t) {
  const n = state.timeline.length;
  const playing = Boolean(state.timer);
  els.play.dataset.playing = String(playing);
  els.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  els.toStart.disabled = els.back.disabled = !n || state.index === 0;
  els.forward.disabled = els.toEnd.disabled = !n || state.index === n - 1;
  els.position.textContent = t ? `${t.innings === 1 ? "1st" : "2nd"} inns · ${t.label}` : "";
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
         <text class="axis" x="${x(inningsStart) + 6}" y="${m.t + h - 4}">Chase</text>`
      : "";
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
    <circle class="now" cx="${x(index).toFixed(1)}" cy="${y(current.p_team1).toFixed(1)}" r="4.5"/>`;
}

function seekFromChart(event) {
  const rect = els.chart.getBoundingClientRect();
  const fraction = (event.clientX - rect.left - CHART_MARGIN.l) / (rect.width - CHART_MARGIN.l - CHART_MARGIN.r);
  pause();
  seek(Math.round(clamp(fraction, 0, 1) * (state.timeline.length - 1)));
}

/* ---------- Chase difficulty heatmap ---------- */

// Interpolating in OKLab keeps equal steps looking equal, so the pale band sits on the 50-50 line
// instead of drifting toward the orange side as it does with a plain RGB blend.
const toLinear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => Math.round(255 * clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055, 0, 1));

function hexToOklab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toSrgb);
}

// P(chasing side wins): 0 = team batting first favoured (blue), 1 = chasing side favoured (orange).
const RAMP = [[0, "#1f5c8f"], [0.5, "#f1efea"], [1, "#a34f14"]].map(([stop, hex]) => [stop, hexToOklab(hex)]);
const RAMP_LUT = Array.from({ length: 256 }, (_, i) => {
  const p = i / 255;
  const [[lo, from], [hi, to]] = p <= 0.5 ? [RAMP[0], RAMP[1]] : [RAMP[1], RAMP[2]];
  const f = (p - lo) / (hi - lo);
  return oklabToRgb(from.map((c, k) => c + (to[k] - c) * f));
});

const colorFor = (p) => RAMP_LUT[Math.round(clamp(p, 0, 1) * 255)];

function rasterize(grid) {
  const rows = grid.target;
  const cols = grid.max_balls;
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(cols, rows);
  // Pixel (0, 0) is the start of the chase: every run still required, every ball still to come.
  for (let py = 0; py < rows; py++) {
    const row = grid.p[rows - py - 1];
    for (let px = 0; px < cols; px++) {
      const p = row[cols - px - 1];
      const [r, g, b] = p === null ? UNREACHABLE : colorFor(p);
      const o = (py * cols + px) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // The 50-50 line: per balls-remaining column, the most runs the chase can need and still be favourite.
  const boundary = Array.from({ length: cols }, (_, b) => {
    let edge = 0;
    for (let r = 0; r < rows; r++) {
      const p = grid.p[r][b];
      if (p === null) continue;
      if (p < 0.5) break;
      edge = r + 1;
    }
    return edge;
  });
  return { grid, image: canvas, boundary };
}

function heatLayout() {
  const rect = els.heatmap.getBoundingClientRect();
  const m = HEAT_MARGIN;
  return { rect, m, w: rect.width - m.l - m.r, h: rect.height - m.t - m.b };
}

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
    if (!state.grids.has(key)) {
      els.heatWrap.dataset.loading = "true";
      try {
        const grid = await api(`/api/heatmap?${new URLSearchParams(params)}`);
        state.grids.set(key, rasterize(grid));
      } catch (error) {
        state.gridKey = "";
        showError(error.message, () => seek(state.index));
        return;
      } finally {
        if (state.gridKey === key || !state.gridKey) els.heatWrap.dataset.loading = "false";
      }
    }
    if (state.gridKey !== key) return; // a newer request took over while this one was in flight
    state.grid = state.grids.get(key);
  }
  drawHeatmap();
}

function niceStep(range) {
  return [10, 20, 25, 50, 100].find((s) => range / s <= 6) ?? 100;
}

function drawHeatmap() {
  const canvas = els.heatmap;
  const { rect, m, w, h } = heatLayout();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  renderReadout();
  if (!state.grid || w <= 0 || h <= 0) return;

  const { grid, image, boundary } = state.grid;
  const cols = grid.max_balls;
  const rows = grid.target;
  const xOf = (b) => m.l + ((cols - clamp(b, 0, cols)) / cols) * w;
  const yOf = (r) => m.t + ((rows - clamp(r, 0, rows)) / rows) * h;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--ink").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const rule = css.getPropertyValue("--rule-strong").trim();
  const surface = css.getPropertyValue("--surface").trim();

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, m.l, m.t, w, h);
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  ctx.strokeRect(m.l + 0.5, m.t + 0.5, w - 1, h - 1);

  ctx.save();
  ctx.beginPath();
  let penDown = false;
  boundary.forEach((edge, b) => {
    if (!edge) {
      penDown = false;
      return;
    }
    const px = xOf(b + 0.5);
    const py = yOf(edge);
    if (penDown) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    penDown = true;
  });
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.65;
  ctx.stroke();
  ctx.restore();

  ctx.font = `12px ${css.getPropertyValue("--font")}`;
  ctx.fillStyle = muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let b = cols; b >= 0; b -= 24) ctx.fillText(String(b), xOf(b), m.t + h + 6);
  ctx.fillText("Balls remaining", m.l + w / 2, m.t + h + 24);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let r = 0; r <= rows; r += niceStep(rows)) ctx.fillText(String(r), m.l - 8, yOf(r));
  ctx.save();
  ctx.translate(14, m.t + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("Runs required", 0, 0);
  ctx.restore();

  const t = state.timeline[state.index];
  if (t?.innings === 2 && rows === state.match.target) {
    const path = [{ balls_remaining: cols, runs_required: rows }, ...state.timeline.slice(state.inningsStart, state.index + 1)];
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, xOf(p.balls_remaining), yOf(p.runs_required)));
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = surface;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(xOf(t.balls_remaining), yOf(t.runs_required), 6, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = surface;
    ctx.stroke();
  }

  if (state.hover) {
    ctx.beginPath();
    ctx.arc(xOf(state.hover.b - 0.5), yOf(state.hover.r - 0.5), 5, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
}

function cellAt(event) {
  if (!state.grid) return null;
  const { rect, m, w, h } = heatLayout();
  const fx = (event.clientX - rect.left - m.l) / w;
  const fy = (event.clientY - rect.top - m.t) / h;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const { max_balls: cols, target: rows } = state.grid.grid;
  return { b: clamp(Math.ceil(cols - fx * cols), 1, cols), r: clamp(Math.ceil(rows - fy * rows), 1, rows) };
}

function renderReadout() {
  const t = state.timeline[state.index];
  if (!state.grid || !t) {
    els.readout.textContent = "";
    return;
  }
  const { grid } = state.grid;
  const chaser = abbr(state.match.team2);
  if (state.hover) {
    const { b, r } = state.hover;
    const p = grid.p[r - 1][b - 1];
    els.readout.textContent =
      p === null
        ? `${plural(r, "run")} needed off ${plural(b, "ball")} can't happen in a chase of ${grid.target}.`
        : `${plural(r, "run")} needed off ${plural(b, "ball")} with ${grid.wickets_in_hand} wickets in hand: ${chaser} win ${pct(p)}.`;
  } else if (t.innings === 2 && t.runs_required > 0 && t.balls_remaining > 0 && t.wickets < 10) {
    els.readout.textContent =
      `Now ${plural(t.runs_required, "run")} needed off ${plural(t.balls_remaining, "ball")}: ${chaser} ${pct(1 - t.p_team1)}. ` +
      "Hover the map to try other situations.";
  } else {
    els.readout.textContent = "Hover the map to see how hard any chase would be. The dashed line marks a 50-50 contest.";
  }
}

/* ---------- What-if calculator ---------- */

const WHATIF_FIELDS = ["runs", "wickets", "overs", "target"];
const whatif = { timer: null, request: 0, touched: new Set() };

function readWhatIf() {
  const fields = els.whatifForm.elements;
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
  const target = innings === 2 ? whole("target", 1, 400, "Enter a target from 1 to 400.") : null;
  const parts = /^(\d{1,2})(?:\.([0-5]))?$/.exec(fields.overs.value.trim());
  const balls = parts ? Number(parts[1]) * 6 + Number(parts[2] ?? 0) : NaN;
  if (!parts) errors.overs = "Use overs.balls, like 14.2. Balls after the dot run from 0 to 5.";
  else if (balls > 120) errors.overs = "A T20 innings has at most 20 overs.";

  return { errors, value: { innings, runs, wickets, balls, target, venue: fields.venue.value || null } };
}

// Errors appear once a field has been left, and clear as soon as it is fixed.
function renderFieldErrors(errors, reveal) {
  for (const name of WHATIF_FIELDS) {
    const box = document.getElementById(`wi-${name}-error`);
    const show = Boolean(errors[name]) && whatif.touched.has(name) && (reveal || !box.hidden);
    box.hidden = !show;
    box.textContent = show ? errors[name] : "";
    els.whatifForm.elements[name].setAttribute("aria-invalid", String(show));
  }
}

function scheduleWhatIf() {
  clearTimeout(whatif.timer);
  whatif.timer = setTimeout(runWhatIf, 250);
}

async function runWhatIf() {
  clearTimeout(whatif.timer);
  const { errors, value } = readWhatIf();
  els.wiTargetField.hidden = value.innings !== 2;
  renderFieldErrors(errors, false);

  const request = ++whatif.request;
  if (Object.keys(errors).length) {
    els.whatifResult.dataset.state = "invalid";
    els.wiP1.textContent = els.wiP2.textContent = "–";
    els.wiSummary.textContent = "Finish describing the situation to see who's favourite.";
    return;
  }

  els.whatifResult.dataset.state = "loading";
  try {
    const body = await api("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (request === whatif.request) renderWhatIf(value, body);
  } catch (error) {
    if (request !== whatif.request) return;
    els.whatifResult.dataset.state = "error";
    els.wiP1.textContent = els.wiP2.textContent = "–";
    els.wiSummary.textContent = `Couldn't get a prediction. ${error.message}`;
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
  els.wiP1.textContent = pct(pFirst);
  els.wiP2.textContent = pct(1 - pFirst);
  els.wiBar.style.setProperty("--p", pFirst);
  els.wiSummary.textContent = describeWhatIf(value, body.venue_par);
  els.whatifResult.dataset.state = "ready";
}

function fillVenues(venues) {
  const current = els.whatifForm.elements.venue.value;
  fillSelect(
    els.whatifForm.elements.venue,
    [["", "Any venue (league par)"], ...Object.entries(venues).sort(([a], [b]) => a.localeCompare(b)).map(([name, par]) => [name, `${name} · par ${Math.round(par)}`])],
    current,
  );
}

function copyReplayBall() {
  const t = state.timeline[state.index];
  if (!t) return;
  const fields = els.whatifForm.elements;
  fields.innings.value = String(t.innings);
  fields.runs.value = String(t.runs);
  fields.wickets.value = String(t.wickets);
  fields.overs.value = overs(t.balls);
  fields.target.value = String(state.match.target);
  fields.venue.value = state.match.venue;
  if (fields.venue.value !== state.match.venue) fields.venue.value = "";
  whatif.touched.clear();
  runWhatIf();
}

/* ---------- Model card ---------- */

function renderModelCard(model) {
  const { train, val, test } = model.split;
  const data = model.data;
  const others = data ? Object.keys(data.train_by_competition).length - 1 : 0;
  const sources = others
    ? ` Training also used matches from ${plural(others, "other T20 competition")} played before ${val[0]}` +
      `${data.other_weight < 1 ? `, each weighted at ${data.other_weight} of an IPL match` : ""}` +
      ` (${data.train_matches.toLocaleString("en-GB")} matches in all).`
    : "";
  els.split.textContent =
    `Trained on IPL ${train[0]}–${train.at(-1)}, tuned on ${val.join(" and ")}, and scored below on ${test.join(", ")}, ` +
    `a season the models never saw.${sources} Lower is better for log loss, Brier score and calibration error; higher is better for AUC.`;
  els.modelGrid.replaceChildren(
    ...[["1", "First innings"], ["2", "Chase"]].map(([key, title]) => {
      const r = model.innings[key];
      const rows = Object.entries(r.test)
        .map(
          ([name, s]) => `<tr${name === "calibrated" ? ' class="is-final"' : ""}>
            <th scope="row">${MODEL_LABELS[name] ?? name}</th>
            <td>${s.log_loss.toFixed(3)}</td><td>${s.brier.toFixed(3)}</td><td>${s.auc.toFixed(3)}</td><td>${(s.ece * 100).toFixed(1)}%</td>
          </tr>`,
        )
        .join("");
      const article = document.createElement("article");
      article.innerHTML = `
        <h3>${title}</h3>
        <p class="meta">${r.matches.test} test matches · blend is ${Math.round(r.blend_weight * 100)}% gradient-boosted,
          ${Math.round((1 - r.blend_weight) * 100)}% logistic · ${r.gbm_trees} trees</p>
        <div class="table-wrap"><table>
          <thead><tr><th scope="col">Model</th><th scope="col">Log loss</th><th scope="col">Brier</th><th scope="col">AUC</th><th scope="col">Calib. error</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <img src="/reports/reliability_innings${key}.png" width="650" height="650" loading="lazy"
          alt="Reliability curve for the ${title.toLowerCase()} model: predicted win probability plotted against the observed win rate on the test season.">`;
      return article;
    }),
  );
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
    if (event.buttons && state.timeline.length) seekFromChart(event);
  });

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
  els.heatmap.addEventListener("pointermove", (event) => {
    const cell = cellAt(event);
    if (cell?.b === state.hover?.b && cell?.r === state.hover?.r) return;
    state.hover = cell;
    drawHeatmap();
  });
  els.heatmap.addEventListener("pointerleave", () => {
    state.hover = null;
    drawHeatmap();
  });

  document.addEventListener("keydown", (event) => {
    if (!state.timeline.length || event.target.matches("input, select, textarea") || event.metaKey || event.ctrlKey) return;
    const moves = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key === " " && !event.target.matches("button")) {
      event.preventDefault();
      state.timer ? pause() : play();
    } else if (event.key in moves) {
      event.preventDefault();
      step(moves[event.key] * (event.shiftKey ? 6 : 1));
    }
  });

  new ResizeObserver(() => {
    drawChart();
    drawHeatmap();
  }).observe(els.stage);

  els.whatifForm.addEventListener("input", (event) => {
    if (event.target.name === "innings" || event.target.name === "venue") runWhatIf();
    else scheduleWhatIf();
  });
  els.whatifForm.addEventListener("change", (event) => {
    if (event.target.name === "venue") runWhatIf();
  });
  els.whatifForm.addEventListener("focusout", (event) => {
    if (!WHATIF_FIELDS.includes(event.target.name)) return;
    whatif.touched.add(event.target.name);
    renderFieldErrors(readWhatIf().errors, true);
  });
  els.whatifForm.addEventListener("submit", (event) => {
    event.preventDefault();
    WHATIF_FIELDS.forEach((name) => whatif.touched.add(name));
    renderFieldErrors(readWhatIf().errors, true);
    runWhatIf();
  });
  els.wiFromReplay.addEventListener("click", copyReplayBall);
}

async function boot() {
  runWhatIf();
  api("/api/model")
    .then((model) => {
      renderModelCard(model);
      fillVenues(model.venues);
    })
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

bind();
boot();
