import { abbr, api, formatDate, formatNumber, initChrome, setCounter } from "./core.js";

const $ = (id) => document.getElementById(id);

async function loadStats() {
  try {
    const stats = await api("/api/stats");
    setCounter($("stat-auc"), stats.chase_auc.toFixed(2));
    setCounter($("stat-ipl"), formatNumber(stats.ipl_matches));
    setCounter($("stat-deliveries"), formatNumber(stats.ipl_deliveries));
    setCounter($("stat-competitions"), String(stats.competitions));
    document.querySelectorAll('[data-stat="test-season"]').forEach((el) => (el.textContent = String(stats.test_season)));
  } catch {
    // The counters keep their placeholder dashes when the stats can't be loaded.
  }
}

function shortBall(t) {
  if (t.wicket) return `${t.player_out} out`;
  if (t.batter_runs === 6) return `six by ${t.batter}`;
  if (t.batter_runs === 4) return `four by ${t.batter}`;
  return t.ball_runs ? `${t.ball_runs} run${t.ball_runs === 1 ? "" : "s"}` : "dot ball";
}

/** Draw the whole match's win-probability curve and return the ball with the biggest swing. */
function drawTeaser(svg, match, timeline) {
  const width = Math.round(svg.getBoundingClientRect().width) || 640;
  const height = 180;
  const m = { l: 48, r: 10, t: 10, b: 10 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const x = (i) => (m.l + (i / Math.max(timeline.length - 1, 1)) * w).toFixed(1);
  const y = (p) => (m.t + (1 - p) * h).toFixed(1);
  const inningsStart = timeline.findIndex((t) => t.innings === 2);

  let swing = null;
  for (let i = 1; i < timeline.length; i++) {
    if (i === inningsStart) continue; // the hand-off between innings models isn't a moment on the field
    const delta = Math.abs(timeline[i].p_team1 - timeline[i - 1].p_team1);
    if (!swing || delta > swing.delta) swing = { i, delta };
  }

  const line = timeline.map((t, i) => `${i ? "L" : "M"}${x(i)},${y(t.p_team1)}`).join("");
  const area = `${line}L${x(timeline.length - 1)},${y(0.5)}L${x(0)},${y(0.5)}Z`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.height = `${height}px`;
  svg.innerHTML = `
    <defs>
      <clipPath id="teaser-top"><rect x="0" y="0" width="${width}" height="${y(0.5)}"/></clipPath>
      <clipPath id="teaser-bottom"><rect x="0" y="${y(0.5)}" width="${width}" height="${height}"/></clipPath>
    </defs>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(1)}" y2="${y(1)}"/>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="mid" x1="${m.l}" x2="${m.l + w}" y1="${y(0.5)}" y2="${y(0.5)}"/>
    <text class="axis axis-1" x="${m.l - 8}" y="${Number(y(1)) + 11}" text-anchor="end">${abbr(match.team1)}</text>
    <text class="axis axis-2" x="${m.l - 8}" y="${Number(y(0)) - 3}" text-anchor="end">${abbr(match.team2)}</text>
    <path class="area-1" d="${area}" clip-path="url(#teaser-top)"/>
    <path class="area-2" d="${area}" clip-path="url(#teaser-bottom)"/>
    ${inningsStart > 0 ? `<line class="break" x1="${x(inningsStart)}" x2="${x(inningsStart)}" y1="${m.t}" y2="${m.t + h}"/>` : ""}
    <path class="line" d="${line}"/>
    ${swing ? `<circle class="swing-dot" cx="${x(swing.i)}" cy="${y(timeline[swing.i].p_team1)}" r="6"/>` : ""}`;
  return swing;
}

async function loadTeaser() {
  try {
    const listing = await api("/api/matches");
    const pick = listing.matches.find((m) => /^final$/i.test(m.stage)) ?? listing.matches[0];
    const { match, timeline } = await api(`/api/matches/${pick.match_id}/replay`);
    $("teaser-title").textContent = `${match.team1} v ${match.team2}`;
    $("teaser-meta").textContent = `${match.stage || "Match"} · ${formatDate(match.date)} · ${match.winner} won by ${match.margin}`;
    $("teaser-link").href = `/history#match=${match.match_id}`;

    const svg = $("teaser-chart");
    const draw = () => {
      const swing = drawTeaser(svg, match, timeline);
      if (!swing) return;
      const t = timeline[swing.i];
      $("teaser-caption").textContent =
        `Red dot: biggest swing, ${t.innings === 1 ? "1st" : "2nd"} innings ${t.label}, ${shortBall(t)} (${Math.round(swing.delta * 100)} points)`;
    };
    draw();
    new ResizeObserver(draw).observe(svg);
  } catch {
    $("teaser").hidden = true;
  }
}

initChrome();
loadStats();
loadTeaser();
