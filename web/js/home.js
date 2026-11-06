// Landing page: the latest final as one big number, a scroll-driven replay, the three tools, and the track record.
import {
  abbr, api, applySides, clamp, formatNumber, h, initChrome, overs, pct, plural, reducedMotion, teamLogos, teamMark, teamSlug,
  tweenPercent, whenVisible,
} from "./core.js";

const $ = (id) => document.getElementById(id);

function describeBall(t) {
  if (t.wicket) return { text: `OUT, ${t.player_out} (${t.wicket})`, kind: "is-wicket" };
  if (t.extra === "wides") return { text: plural(t.ball_runs, "wide"), kind: "" };
  if (t.extra === "noballs") return { text: t.batter_runs ? `No-ball, ${t.batter_runs} off the bat` : "No-ball", kind: "" };
  if (t.batter_runs === 6) return { text: "SIX", kind: "is-boundary" };
  if (t.batter_runs === 4) return { text: "FOUR", kind: "is-boundary" };
  if (t.extra === "legbyes") return { text: plural(t.ball_runs, "leg bye"), kind: "" };
  if (t.extra === "byes") return { text: plural(t.ball_runs, "bye"), kind: "" };
  return { text: t.ball_runs ? plural(t.ball_runs, "run") : "No run", kind: "" };
}

/**
 * Draw a win-probability chart for `timeline` into `svg`, up to ball `upto`. Above the midline the side
 * batting first is favoured. Returns nothing; the svg's own CSS height sets the chart height.
 */
function drawChart(svg, match, timeline, { upto = timeline.length - 1, margin, ticks = false, marker = upto, drawIn = false } = {}) {
  const rect = svg.getBoundingClientRect();
  const width = Math.round(rect.width) || 800;
  const height = Math.round(rect.height) || 200;
  const m = margin;
  const w = width - m.l - m.r;
  const ht = height - m.t - m.b;
  const n = timeline.length;
  const x = (i) => (m.l + (i / Math.max(n - 1, 1)) * w).toFixed(1);
  const y = (p) => (m.t + (1 - p) * ht).toFixed(1);
  const inningsStart = timeline.findIndex((t) => t.innings === 2);
  const played = timeline.slice(0, upto + 1);
  const line = played.map((t, i) => `${i ? "L" : "M"}${x(i)},${y(t.p_team1)}`).join("");
  const area = `${line}L${x(upto)},${y(0.5)}L${x(0)},${y(0.5)}Z`;
  const id = svg.id;

  let extras = "";
  if (ticks) {
    extras += [0.25, 0.75].map((p) => `<line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(p)}" y2="${y(p)}"/>`).join("");
    extras += played.map((t, i) => (t.wicket ? `<circle class="wk" cx="${x(i)}" cy="${y(t.p_team1)}" r="3.5"/>` : "")).join("");
    for (const [start, end, label] of [[0, inningsStart > 0 ? inningsStart : n, "INN 1"], [inningsStart, n, "INN 2"]]) {
      if (start < 0 || start > upto) continue;
      extras += `<text class="axis" x="${Number(x(start)) + 4}" y="${m.t + ht + 18}">${label}</text>`;
      for (const over of [5, 10, 15]) {
        const at = timeline.findIndex((t, k) => k >= start && k < end && t.balls >= over * 6);
        if (at >= 0 && at <= upto) {
          extras += `<line class="tick" x1="${x(at)}" x2="${x(at)}" y1="${m.t + ht}" y2="${m.t + ht + 5}"/>` +
            `<text class="axis" x="${x(at)}" y="${m.t + ht + 18}" text-anchor="middle">${over}</text>`;
        }
      }
    }
  }
  const showBreak = inningsStart > 0 && (upto >= inningsStart || !ticks);
  const current = timeline[marker];

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <clipPath id="${id}-top"><rect x="0" y="0" width="${width}" height="${y(0.5)}"/></clipPath>
      <clipPath id="${id}-bottom"><rect x="0" y="${y(0.5)}" width="${width}" height="${height}"/></clipPath>
    </defs>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(1)}" y2="${y(1)}"/>
    <line class="grid" x1="${m.l}" x2="${m.l + w}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="mid" x1="${m.l}" x2="${m.l + w}" y1="${y(0.5)}" y2="${y(0.5)}"/>
    <text class="axis axis-1" x="${m.l - 10}" y="${Number(y(1)) + 11}" text-anchor="end">${abbr(match.team1)}</text>
    <text class="axis axis-2" x="${m.l - 10}" y="${Number(y(0)) - 3}" text-anchor="end">${abbr(match.team2)}</text>
    ${showBreak ? `<line class="break" x1="${x(inningsStart)}" x2="${x(inningsStart)}" y1="${m.t}" y2="${m.t + ht}"/>` : ""}
    ${extras}
    <path class="area-1" d="${area}" clip-path="url(#${id}-top)"/>
    <path class="area-2" d="${area}" clip-path="url(#${id}-bottom)"/>
    <path class="line" d="${line}"${drawIn ? ' pathLength="1"' : ""}/>
    ${current ? `<circle class="now-ring" cx="${x(marker)}" cy="${y(current.p_team1)}" r="5"/><circle class="now" cx="${x(marker)}" cy="${y(current.p_team1)}" r="5"/>` : ""}`;
}

/* ---------- Hero: the latest final at the innings break ---------- */

function renderHero(match, timeline, logos) {
  const hero = document.querySelector(".hero");
  const [c1, c2] = applySides(hero, match.team1, match.team2);
  const inningsStart = timeline.findIndex((t) => t.innings === 2);
  const breakAt = inningsStart > 0 ? inningsStart - 1 : timeline.length - 1;
  const t = timeline[breakAt];
  const firstFavoured = t.p_team1 >= 0.5;
  const favourite = firstFavoured ? match.team1 : match.team2;

  hero.style.setProperty("--fav-color", firstFavoured ? c1 : c2);
  hero.querySelector(".hero-team .team-swatch, .hero-team .team-mark")
    ?.replaceWith(teamMark(favourite, { logo: logos[teamSlug(favourite)] }));
  $("hero-moment").textContent = `IPL ${match.year} ${match.stage || "match"} · innings break`;
  tweenPercent($("hero-number"), firstFavoured ? t.p_team1 : 1 - t.p_team1, { initial: 0.5, duration: 1100 });
  $("hero-team").textContent = `${favourite} to win`;
  $("hero-context").textContent =
    `${match.team1} made ${t.runs}/${t.wickets}, so ${match.team2} needed ${match.target}${match.venue ? ` at ${match.venue}` : ""}. ` +
    `${match.winner} won by ${match.margin}.`;
  $("hero-replay").href = `/history#match=${match.match_id}`;
  $("hero-spark").setAttribute("aria-label", `Win probability across the ${match.year} final, ${match.team1} against ${match.team2}`);

  const spark = $("hero-spark");
  const draw = (drawIn = false) =>
    drawChart(spark, match, timeline, { margin: { l: 46, r: 8, t: 8, b: 8 }, marker: breakAt, drawIn });
  draw(!reducedMotion());
  if (!reducedMotion()) {
    spark.classList.add("is-drawing");
    setTimeout(() => spark.classList.remove("is-drawing"), 2200);
  }
  new ResizeObserver(() => draw()).observe(spark);
  $("hero-spark-caption").textContent =
    `${abbr(match.team1)} above the line, ${abbr(match.team2)} below. The dot is the innings break.`;
}

/* ---------- Scroll replay ---------- */

function initReplay(match, timeline, logos) {
  const section = $("replay");
  const svg = $("rp-chart");
  const sides = [...section.querySelectorAll(".replay-side")];
  applySides(section, match.team1, match.team2);
  sides.forEach((side, i) => {
    const team = i ? match.team2 : match.team1;
    side.querySelector(".team-swatch, .team-mark")?.replaceWith(teamMark(team, { logo: logos[teamSlug(team)] }));
  });
  $("rp-team-1").textContent = match.team1;
  $("rp-team-2").textContent = match.team2;
  $("rp-open").href = `/history#match=${match.match_id}`;
  const n = timeline.length;
  let shown = -1;

  const render = (index) => {
    const t = timeline[index];
    shown = index;
    $("rp-p1").textContent = pct(t.p_team1);
    $("rp-p2").textContent = pct(1 - t.p_team1);
    sides[0].dataset.fav = String(t.p_team1 >= 0.5);
    sides[1].dataset.fav = String(t.p_team1 < 0.5);
    $("rp-bar").style.setProperty("--p", t.p_team1);

    const ball = describeBall(t);
    const strong = h("strong", { class: ball.kind, text: ball.text });
    $("rp-ball").replaceChildren(`${t.innings === 1 ? "1st" : "2nd"} innings ${t.label} · ${t.bowler} to ${t.batter} · `, strong);
    const batting = t.innings === 1 ? match.team1 : match.team2;
    let score = `${abbr(batting)} ${t.runs}/${t.wickets} (${overs(t.balls)})`;
    if (index === n - 1) score += ` · ${match.winner} won by ${match.margin}`;
    else if (t.innings === 2 && t.runs_required > 0) score += ` · need ${plural(t.runs_required, "run")} off ${plural(t.balls_remaining, "ball")}`;
    $("rp-score").textContent = score;

    $("rp-progress").style.setProperty("--progress", n > 1 ? index / (n - 1) : 1);
    $("rp-progress-text").textContent = index === n - 1 ? "Full time. Scroll on for the tools." : `Ball ${index + 1} of ${n}. Keep scrolling.`;
    drawChart(svg, match, timeline, { upto: index, margin: { l: 48, r: 12, t: 12, b: 28 }, ticks: true });
  };

  new ResizeObserver(() => shown >= 0 && render(shown)).observe(svg);

  if (reducedMotion()) {
    section.classList.add("is-static");
    render(n - 1);
    return;
  }
  let queued = false;
  const update = () => {
    queued = false;
    const scrollable = section.offsetHeight - section.querySelector(".replay-sticky").offsetHeight;
    const progress = clamp(-section.getBoundingClientRect().top / Math.max(scrollable, 1), 0, 1);
    const index = Math.round(progress * (n - 1));
    if (index !== shown) render(index);
  };
  addEventListener("scroll", () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  addEventListener("resize", update);
  update();
}

/* ---------- Counts, track record ---------- */

async function loadCounts() {
  const [stats, upcoming] = await Promise.all([api("/api/stats").catch(() => null), api("/api/upcoming").catch(() => null)]);
  if (stats) $("way-count-history").textContent = `${formatNumber(stats.ipl_matches)} matches`;
  if (upcoming?.status === "ok") {
    const live = upcoming.matches.filter((m) => m.state === "live").length;
    const next = upcoming.matches.filter((m) => m.state === "upcoming").length;
    $("way-count-upcoming").textContent = live ? `${live} live now` : `${plural(next, "fixture")} this week`;
  } else {
    $("way-count-upcoming").textContent = "next 7 days";
  }
}

const SURE_STAGES = [
  { innings: 1, from: 0, label: "First six overs", sub: "of the match" },
  { innings: 1, from: 12, label: "End of the first innings", sub: "overs 12 to 20" },
  { innings: 2, from: 0, label: "Start of the chase", sub: "first six overs" },
  { innings: 2, from: 16, label: "Death overs", sub: "last four overs of a chase" },
];

async function loadTrackRecord() {
  const model = await api("/api/model").catch(() => null);
  const record = model?.confidence;
  const grid = $("sure-grid");
  if (!record) {
    grid.closest(".sure").hidden = true;
    return;
  }
  const seasons = `${record.seasons[0]} to ${record.seasons.at(-1)}`;
  $("sure-lede").textContent =
    `Each season from ${seasons} was predicted by a model that had never seen it. This is how often its favourite went on to win.`;
  grid.replaceChildren(
    ...SURE_STAGES.map(({ innings, from, label, sub }) => {
      const stage = record.stages.find((s) => s.innings === innings && s.from_over === from);
      if (!stage) return null;
      const number = h("span", { class: "sure-number tabular", text: "0%" });
      whenVisible(number, () => tweenPercent(number, stage.accuracy, { initial: 0.5, duration: 1200 }), 0.5);
      return h("div", { class: "sure-stat" },
        number,
        h("span", { class: "sure-label", text: label }),
        h("span", { class: "muted", text: `${sub} · ${formatNumber(stage.matches)} matches` }),
      );
    }),
  );
  grid.querySelectorAll(".sure-stat").forEach((stat, i) => stat.style.setProperty("--i", i));
}

/* ---------- Ways in: the photo follows the pointer ---------- */

function initWays() {
  for (const row of document.querySelectorAll(".way-row")) {
    row.addEventListener("pointermove", (event) => {
      const rect = row.getBoundingClientRect();
      row.style.setProperty("--peek-x", `${event.clientX - rect.left}px`);
    });
  }
}

async function loadFinal() {
  try {
    const [listing, logos] = await Promise.all([api("/api/matches"), teamLogos()]);
    const pick = listing.matches.find((m) => /^final$/i.test(m.stage)) ?? listing.matches[0];
    const { match, timeline } = await api(`/api/matches/${pick.match_id}/replay`);
    renderHero(match, timeline, logos);
    initReplay(match, timeline, logos);
  } catch {
    $("hero-moment").textContent = "Couldn't load the latest final. Is the server running?";
    $("replay").hidden = true;
  }
}

initChrome();
initWays();
loadFinal();
loadCounts();
loadTrackRecord();
