import { abbr, api, confidence, formatDate, formatNumber, h, initChrome, pct, plural } from "./core.js";

const $ = (id) => document.getElementById(id);
const groups = Object.fromEntries([...document.querySelectorAll("[data-group]")].map((g) => [g.dataset.group, g]));
const LIVE_REFRESH_MS = 5 * 60 * 1000;
let refreshTimer = null;
let model = null;

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

function edgeLabel(p) {
  const edge = Math.abs(p - 0.5);
  return edge < 0.04 ? "Toss-up" : edge < 0.1 ? "Slight edge" : "Rating edge";
}

function winnerOf(m) {
  const status = m.status.toLowerCase();
  if (status.startsWith(`${m.team1.toLowerCase()} won`)) return 1;
  if (status.startsWith(`${m.team2.toLowerCase()} won`)) return 2;
  return null;
}

function teamRow(side, m, p, { showOdds, outcome }) {
  const name = side === 1 ? m.team1 : m.team2;
  const short = side === 1 ? m.short1 : m.short2;
  const score = side === 1 ? m.score1 : m.score2;
  let aside = null;
  if (outcome === "won") aside = h("span", { class: "pill pill-won", text: "Won" });
  else if (showOdds) aside = h("span", { class: `fixture-prob${p == null ? " is-empty" : ""}`, text: p == null ? "–" : pct(p) });

  return h("div", { class: `fixture-team t${side}${outcome ? ` is-${outcome}` : ""}` },
    h("span", { class: "monogram", "aria-hidden": "true", text: (short || abbr(name)).slice(0, 4) }),
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
    return [pre
      ? `Ratings ${formatNumber(pre.rating1)} v ${formatNumber(pre.rating2)}, built from ${pre.matches1} and ${pre.matches2} past matches.`
      : "One of these teams has no rating history yet, so there are no pre-match odds."];
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
    : m.state === "upcoming" && m.prematch ? h("span", { class: "pill", text: edgeLabel(m.prematch.p_team1) }) : null;
  const series = m.state === "upcoming" && m.start ? `${m.series} · ${startsIn(m.start)}` : m.series;

  let bar = null;
  if (p1 != null) {
    bar = h("div", { class: "probbar", "aria-hidden": "true" }, h("span"));
    bar.style.setProperty("--p", p1);
  }

  return h("article", { class: `fixture${m.state === "live" ? " is-live" : ""}` },
    h("div", { class: "fixture-top mono" }, h("span", { text: when }), badge),
    h("p", { class: "fixture-series mono", text: series }),
    teamRow(1, m, p1, { showOdds: !result, outcome: outcome(1) }),
    teamRow(2, m, p1 == null ? null : 1 - p1, { showOdds: !result, outcome: outcome(2) }),
    bar,
    ...notesFor(m).filter(Boolean).map((text) => h("p", { class: "fixture-note", text })),
    m.live ? h("a", { class: "btn btn-arrow", href: calculatorLink(m.live), text: "Open in calculator" }) : null,
  );
}

function fillGroup(group, items) {
  const days = group.querySelector(".fixture-days");
  if (!days) {
    group.querySelector(".fixture-grid").replaceChildren(...items.map(card));
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
        h("h3", { class: "fixture-day-title mono", text: title }),
        h("div", { class: "fixture-grid" }, ...list.map(card)),
      ),
    ),
  );
}

function hideGroups() {
  Object.values(groups).forEach((group) => (group.hidden = true));
  $("empty").hidden = true;
  $("filter-empty").hidden = true;
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
  applyFilter();
  const time = new Date(data.fetched_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("updated").textContent = `Updated ${time} · refreshed at most every ${data.cache_minutes} minutes`;
}

function renderTrust(report, stats) {
  const stat = (value, label, extra = "") =>
    h("div", { class: `trust-stat ${extra}` }, h("strong", { class: "tabular", text: value }), h("span", { class: "mono muted", text: label }));
  const items = [];
  if (report) {
    const all = report.all_competitions;
    const ipl = report.ipl;
    items.push(
      stat(all.auc.toFixed(2), `Pre-match AUC · ${formatNumber(all.matches)} matches since ${report.test_start.slice(0, 4)}, all competitions`),
      stat(ipl.auc.toFixed(2), `Pre-match AUC · ${ipl.matches} IPL matches. 0.50 is a coin toss`),
    );
  }
  if (stats) items.push(stat(stats.chase_auc.toFixed(2), `In-play chase AUC · IPL ${stats.test_season}`, "is-inplay"));
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
