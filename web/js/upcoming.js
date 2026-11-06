import {
  abbr, api, applySides, confidence, formatDate, formatNumber, h, initChrome, pct, plural, teamMark, tweenPercent,
} from "./core.js";

const $ = (id) => document.getElementById(id);
const groups = Object.fromEntries([...document.querySelectorAll("[data-group]")].map((g) => [g.dataset.group, g]));
const LIVE_REFRESH_MS = 5 * 60 * 1000;
const NEXT_UP = 3;
let refreshTimer = null;
let model = null;
let animateOdds = true; // the first render counts odds up from 50%; refreshes just show them

const kickoff = (iso) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayTitle = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "Date to be confirmed";

function startsIn(iso) {
  const minutes = Math.round((new Date(iso) - Date.now()) / 60000);
  if (minutes <= 0) return "Due to start";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `Starts in ${days}d ${hours}h`;
  return hours ? `Starts in ${hours}h ${minutes % 60}m` : `Starts in ${minutes}m`;
}

function edgeLabel(pre) {
  if (pre.slope === 0) return "No edge";
  const edge = Math.abs(pre.p_team1 - 0.5);
  return edge < 0.04 ? "Toss-up" : edge < 0.1 ? "Slight edge" : "Rating edge";
}

const signed = (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`;
const fixtureId = (m) => `fixture-${m.id}`;
const shortName = (m, side) => ((side === 1 ? m.short1 : m.short2) || abbr(side === 1 ? m.team1 : m.team2)).slice(0, 4);

function winnerOf(m) {
  const status = m.status.toLowerCase();
  if (status.startsWith(`${m.team1.toLowerCase()} won`)) return 1;
  if (status.startsWith(`${m.team2.toLowerCase()} won`)) return 2;
  return null;
}

function teamRow(side, m, p, { showOdds, outcome }) {
  const name = side === 1 ? m.team1 : m.team2;
  const score = side === 1 ? m.score1 : m.score2;
  let aside = null;
  if (outcome === "won") aside = h("span", { class: "pill pill-won", text: "Won" });
  else if (showOdds) {
    aside = h("span", { class: `fixture-prob${p == null ? " is-empty" : ""}`, text: p == null ? "–" : pct(p) });
    if (p != null && animateOdds) tweenPercent(aside, p, { initial: 0.5, duration: 700 });
  }

  return h("div", { class: `fixture-team t${side}${outcome ? ` is-${outcome}` : ""}` },
    teamMark(name, { logo: side === 1 ? m.logo1 : m.logo2, short: shortName(m, side) }),
    h("div", { class: "team-id" },
      h("span", { class: "fixture-name", text: name }),
      score ? h("span", { class: "fixture-score", text: score }) : null,
    ),
    aside,
  );
}

function calculatorLink(live) {
  const params = new URLSearchParams({
    innings: live.innings,
    runs: live.runs,
    wickets: live.wickets,
    overs: `${Math.floor(live.balls / 6)}.${live.balls % 6}`,
  });
  if (live.target) params.set("target", live.target);
  return `/calculator?${params}`;
}

function notesFor(m) {
  const pre = m.prematch;
  if (m.state === "upcoming") {
    if (!pre) return ["One of these teams has no rating history in this competition yet, so there are no pre-match odds."];
    if (pre.slope === 0) {
      return ["In recent seasons, past results haven't predicted winners in this competition, so neither side is favoured before the start."];
    }
    return [
      `Elo ${formatNumber(pre.rating1)} v ${formatNumber(pre.rating2)}. Run-rate form ${signed(pre.margin1)} v ${signed(pre.margin2)} an over.`,
      `Built from ${pre.matches1} and ${pre.matches2} past matches.`,
    ];
  }
  if (m.state === "live") {
    if (!m.live) return [m.status || "Live score unavailable.", pre ? "Showing pre-match odds until the score can be read." : ""];
    const situation = m.live.innings === 2
      ? `${m.live.batting} need ${plural(m.live.target - m.live.runs, "run")} off ${plural(120 - m.live.balls, "ball")}.`
      : `${m.live.batting} batting first.`;
    const record = confidence(model, m.live.innings, m.live.balls, m.live.p_team1).note;
    return [
      situation,
      record,
      m.competition === "ipl" ? "In-play odds from the Oracle." : "In-play odds from the IPL-trained model, so treat them as a guide.",
    ];
  }
  if (!pre) return [m.status];
  if (Math.abs(pre.p_team1 - 0.5) < 0.005) return [m.status, "Before the start, the ratings saw no edge."];
  const favourite = pre.p_team1 >= 0.5 ? m.team1 : m.team2;
  return [m.status, `Before the start, the ratings had ${favourite} at ${pct(Math.max(pre.p_team1, 1 - pre.p_team1))}.`];
}

function card(m) {
  const result = m.state === "result";
  const odds = result ? null : m.live ?? m.prematch;
  const p1 = odds?.p_team1 ?? null;
  const winner = result ? winnerOf(m) : null;
  const outcome = (side) => (winner ? (winner === side ? "won" : "lost") : null);

  const when = m.state === "upcoming" ? kickoff(m.start) : m.state === "live" ? "In play" : formatDate(m.start, { day: "numeric", month: "short" });
  const badge = m.state === "live"
    ? h("span", { class: "pill pill-live", text: "Live" })
    : m.state === "upcoming" && m.prematch ? h("span", { class: "pill", text: edgeLabel(m.prematch) }) : null;
  const series = m.state === "upcoming" && m.start ? `${m.series} · ${startsIn(m.start)}` : m.series;

  let bar = null;
  if (p1 != null) {
    bar = h("div", { class: "probbar", "aria-hidden": "true" }, h("span"));
    bar.style.setProperty("--p", p1);
  }

  const node = h("article", { class: `card fixture${m.state === "live" ? " is-live" : ""}`, id: fixtureId(m) },
    h("div", { class: "fixture-top" }, h("span", { text: when }), badge),
    h("p", { class: "fixture-series", text: series }),
    teamRow(1, m, p1, { showOdds: !result, outcome: outcome(1) }),
    teamRow(2, m, p1 == null ? null : 1 - p1, { showOdds: !result, outcome: outcome(2) }),
    bar,
    ...notesFor(m).filter(Boolean).map((text) => h("p", { class: "fixture-note", text })),
    m.live ? h("a", { class: "btn btn-arrow", href: calculatorLink(m.live), text: "Open in calculator" }) : null,
  );
  applySides(node, m.team1, m.team2);
  return node;
}

/** Cards numbered by position (--i), so motion.css can cascade them in. */
function cards(list) {
  return list.map((m, i) => {
    const el = card(m);
    el.style.setProperty("--i", Math.min(i, 10));
    return el;
  });
}

function fillGroup(group, items) {
  const days = group.querySelector(".fixture-days");
  if (!days) {
    group.querySelector(".fixture-grid").replaceChildren(...cards(items));
    return;
  }
  const byDay = new Map();
  for (const m of items) {
    const title = dayTitle(m.start);
    byDay.set(title, [...(byDay.get(title) ?? []), m]);
  }
  days.replaceChildren(
    ...[...byDay].map(([title, list]) =>
      h("div", { class: "fixture-day" },
        h("h3", { class: "fixture-day-title", text: title }),
        h("div", { class: "fixture-grid" }, ...cards(list)),
      ),
    ),
  );
}

/** The nearest live or upcoming fixtures in giant type, with each side's odds as a superscript. */
function renderNextUp(matches) {
  const next = matches.filter((m) => m.state === "live" || m.state === "upcoming").slice(0, NEXT_UP);
  $("nextup-section").hidden = !next.length;
  $("nextup").replaceChildren(
    ...next.map((m, i) => {
      const p1 = (m.live ?? m.prematch)?.p_team1;
      const side = (n, p) =>
        h("span", { class: `nextup-team t${n}` },
          teamMark(n === 1 ? m.team1 : m.team2, { logo: n === 1 ? m.logo1 : m.logo2, short: shortName(m, n) }),
          shortName(m, n),
          p == null ? null : h("sup", { text: pct(p) }),
        );
      const when = m.state === "live" ? "Live now" : `${kickoff(m.start)} · ${startsIn(m.start)}`;
      const row = h("li", {},
        h("a", { class: "nextup-row", href: `#${fixtureId(m)}`, "aria-label": `${m.team1} v ${m.team2}, ${when}` },
          h("span", { class: "nextup-teams", "aria-hidden": "true" },
            side(1, p1),
            h("span", { class: "nextup-v", text: "v" }),
            side(2, p1 == null ? null : 1 - p1),
          ),
          h("span", { class: "nextup-meta" }, h("strong", { text: when }), h("span", { text: m.series })),
        ),
      );
      applySides(row, m.team1, m.team2);
      row.firstChild.style.setProperty("--i", i);
      return row;
    }),
  );
}

function hideGroups() {
  Object.values(groups).forEach((group) => (group.hidden = true));
  $("empty").hidden = true;
  $("filter-empty").hidden = true;
  $("nextup-section").hidden = true;
}

function applyFilter() {
  const choice = document.querySelector('input[name="show"]:checked').value;
  let visible = 0;
  for (const [name, group] of Object.entries(groups)) {
    group.hidden = group.dataset.loaded !== "true" || group.dataset.empty === "true" || (choice !== "all" && choice !== name);
    visible += group.hidden ? 0 : 1;
  }
  const loaded = Object.values(groups).some((g) => g.dataset.loaded === "true");
  const anything = Object.values(groups).some((g) => g.dataset.empty === "false");
  $("filter-empty").hidden = !loaded || !anything || visible > 0;
}

function render(data) {
  const counts = { all: data.matches.length };
  for (const [name, group] of Object.entries(groups)) {
    const items = data.matches.filter((m) => m.state === name);
    counts[name] = items.length;
    fillGroup(group, items);
    group.querySelector("[data-count]").textContent = items.length === 1 ? "1 match" : `${items.length} matches`;
    group.dataset.loaded = "true";
    group.dataset.empty = String(!items.length);
  }
  document.querySelectorAll("[data-count-for]").forEach((el) => (el.textContent = String(counts[el.dataset.countFor] ?? 0)));
  $("empty").hidden = data.matches.length > 0;
  renderNextUp(data.matches);
  applyFilter();
  animateOdds = false;
  const time = new Date(data.fetched_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("updated").textContent = `Updated ${time} · refreshed at most every ${data.cache_minutes} minutes`;
}

function renderTrust(report, stats) {
  const stat = (value, label, extra = "") =>
    h("div", { class: `trust-stat ${extra}` }, h("strong", { text: value }), h("span", { text: label }));
  const items = [];
  if (report) {
    const all = report.all_competitions;
    const ipl = report.ipl;
    items.push(
      stat(all.auc.toFixed(2), `Pre-match AUC on ${formatNumber(all.matches)} matches since ${report.test_start.slice(0, 4)}, all competitions. 0.50 is a coin toss.`),
      report.slopes?.ipl === 0
        ? stat("50-50", "IPL pre-match odds. Recent seasons' results haven't predicted IPL winners, so no side is favoured.")
        : stat(ipl.auc.toFixed(2), `Pre-match AUC on ${ipl.matches} IPL matches. 0.50 is a coin toss.`),
    );
  }
  if (stats) items.push(stat(stats.chase_auc.toFixed(2), `In-play AUC once an IPL chase is under way (${stats.test_season} season).`, "is-inplay"));
  $("trust-stats").replaceChildren(...items);
}

function showError(message) {
  $("error-text").textContent = message;
  $("error").hidden = false;
}

async function load() {
  clearTimeout(refreshTimer);
  $("error").hidden = true;
  let data;
  try {
    data = await api("/api/upcoming");
  } catch (error) {
    $("loading").hidden = true;
    hideGroups();
    showError(error.message);
    return;
  }
  $("loading").hidden = true;
  model ??= await api("/api/model").catch(() => null);
  renderTrust(data.prematch_report, await api("/api/stats").catch(() => null));

  $("key-panel").hidden = data.status !== "no_key";
  if (data.status !== "ok") {
    hideGroups();
    $("updated").textContent = "";
    if (data.status === "error") showError(data.message);
    return;
  }
  render(data);
  if (data.matches.some((m) => m.state === "live")) refreshTimer = setTimeout(load, LIVE_REFRESH_MS);
}

initChrome();
$("retry").addEventListener("click", load);
$("filter").addEventListener("change", applyFilter);
load();
