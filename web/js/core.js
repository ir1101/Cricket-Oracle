// Shared helpers and page chrome: API access, formatting, nav state, ticker, photo slots, counters.

export const TEAM_ABBR = {
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
  "New Zealand": "NZ",
  "South Africa": "SA",
  "Sri Lanka": "SL",
  "West Indies": "WI",
};

const PHOTO_PREFIXES = ["hero", "spotlight", "history", "upcoming", "calculator", "gallery"];

export const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const overs = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
export const formatNumber = (n) => Number(n).toLocaleString("en-GB");

export function abbr(team) {
  if (TEAM_ABBR[team]) return TEAM_ABBR[team];
  const words = team.split(/\s+/).filter(Boolean);
  return words.length === 1 ? words[0].slice(0, 3).toUpperCase() : words.map((w) => w[0]).join("").toUpperCase();
}

export function pct(p) {
  if (p > 0.995 && p < 1) return ">99%";
  if (p < 0.005 && p > 0) return "<1%";
  return `${Math.round(p * 100)}%`;
}

/**
 * How sure the model is, and its track record in similar spots, for P(team) at a match stage.
 * `model` is the /api/model payload; its `confidence` table comes from walk-forward tests.
 */
export function confidence(model, innings, balls, p) {
  if (p <= 0.005 || p >= 0.995) return { level: "decided", note: "" };
  const edge = Math.abs(p - 0.5);
  const level = edge < 0.1 ? "close" : edge < 0.25 ? "lean" : "strong";
  const record = model?.confidence;
  const over = Math.min(Math.floor(balls / 6), 19);
  const stage = record?.stages.find((s) => s.innings === innings && over >= s.from_over && over < s.to_over);
  if (!stage) return { level, note: "" };
  const bands = stage.by_band;
  const band = bands.find((b, i) => edge >= b.from && (edge < b.to || i === bands.length - 1));
  const seasons = `${record.seasons[0]}–${String(record.seasons.at(-1)).slice(2)}`;
  let note = "";
  if (band?.accuracy != null && band.matches >= 20) {
    note = `When the model was this sure at this stage (${seasons}), the favourite won ${pct(band.accuracy)} of the time.`;
  } else if (stage.accuracy != null) {
    note = `At this stage of the ${innings === 1 ? "first innings" : "chase"} (${seasons}), the favourite won ${pct(stage.accuracy)} of the time.`;
  }
  return { level, note };
}

export function confidenceLabel(level, favourite) {
  return {
    decided: "All but decided",
    close: "Too close to call",
    lean: `Edge: ${favourite}`,
    strong: `Clear favourite: ${favourite}`,
  }[level];
}

export function formatDate(iso, options = { day: "numeric", month: "short", year: "numeric" }) {
  const date = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return date.toLocaleDateString("en-GB", options);
}

export async function api(path, options) {
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

/** Create an element with properties/attributes and children; text is always set safely. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role" || key === "href") node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export function fillSelect(select, options, selected) {
  select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  select.value = String(selected ?? "");
}

function markCurrentNav() {
  const page = document.body.dataset.page;
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === page) link.setAttribute("aria-current", "page");
  }
}

function tickerEntries(upcoming, stats) {
  const entries = [];
  if (upcoming?.status === "ok") {
    for (const m of upcoming.matches.slice(0, 14)) {
      const odds = m.live?.p_team1 ?? m.prematch?.p_team1;
      const label = m.state === "live" ? "Live" : m.state === "result" ? "Result" : formatDate(m.start, { day: "numeric", month: "short" });
      const detail = m.state === "result" ? m.status : odds != null ? `${abbr(m.team1)} ${pct(odds)} · ${abbr(m.team2)} ${pct(1 - odds)}` : m.series;
      entries.push({ live: m.state === "live", text: `${abbr(m.team1)} v ${abbr(m.team2)}`, label, detail });
    }
  }
  if (stats) {
    entries.push(
      { label: "Model", text: `Chase AUC ${stats.chase_auc.toFixed(2)}`, detail: `on the unseen ${stats.test_season} season` },
      { label: "Data", text: `${formatNumber(stats.ipl_matches)} IPL matches`, detail: `${formatNumber(stats.ipl_deliveries)} deliveries since ${stats.first_season}` },
      { label: "Data", text: `${formatNumber(stats.matches)} T20 matches`, detail: `from ${stats.competitions} competitions for venue pars` },
    );
  }
  return entries;
}

async function initTicker() {
  const track = document.getElementById("ticker-track");
  if (!track) return;
  const [upcoming, stats] = await Promise.all([
    api("/api/upcoming").catch(() => null),
    api("/api/stats").catch(() => null),
  ]);
  const entries = tickerEntries(upcoming, stats);
  if (!entries.length) return;

  const render = (hidden) =>
    entries.map((e) =>
      h("span", { class: "ticker-item", "aria-hidden": hidden ? "true" : null },
        h("span", { class: e.live ? "live" : "", text: `■ ${e.label}` }),
        h("span", { text: e.text }),
        h("span", { class: "muted", text: e.detail }),
      ),
    );
  // Two copies make the loop seamless; the second is hidden from assistive tech.
  track.replaceChildren(...render(false), ...render(true));
  track.style.setProperty("--ticker-duration", `${Math.max(30, entries.length * 7)}s`);
}

async function fillPhotos() {
  const slots = [...document.querySelectorAll("[data-slot]")];
  if (!slots.length) return;
  let images;
  let notes;
  try {
    // photos.json holds optional per-file focal points, e.g. {"hero-1.jpg": {"focus": "50% 0%"}}.
    [{ images }, notes] = await Promise.all([api("/api/images"), api("/images/photos.json").catch(() => ({}))]);
  } catch {
    return;
  }
  const placePhoto = (slot, file) => place(slot, file, notes[file.name]);
  const unused = [...images];
  const claim = (predicate) => {
    const i = unused.findIndex(predicate);
    return i >= 0 ? unused.splice(i, 1)[0] : null;
  };
  const waiting = [];
  for (const slot of slots) {
    const file = claim((f) => f.name.toLowerCase().startsWith(slot.dataset.slot));
    if (file) placePhoto(slot, file);
    else waiting.push(slot);
  }
  // Files without a recognised prefix fill the remaining slots in page order.
  for (const slot of waiting) {
    const file = claim((f) => !PHOTO_PREFIXES.some((p) => f.name.toLowerCase().startsWith(p)));
    if (!file) break;
    placePhoto(slot, file);
  }
}

function place(slot, file, note = {}) {
  const img = new Image();
  img.alt = slot.dataset.alt ?? "";
  img.decoding = "async";
  if (note.focus) img.style.objectPosition = note.focus;
  img.loading = slot.hasAttribute("data-eager") ? "eager" : "lazy";
  img.addEventListener("load", () => slot.classList.add("has-photo"), { once: true });
  img.src = file.url;
  slot.prepend(img);
}

/** Render a value as rolling digit strips that settle on the value when scrolled into view. */
export function setCounter(el, text) {
  el.setAttribute("aria-label", text);
  el.replaceChildren(
    ...[...text].map((ch) => {
      if (!/\d/.test(ch)) return h("span", { "aria-hidden": "true", text: ch });
      const strip = h("span", { class: "digit-strip" }, ...Array.from({ length: 10 }, (_, d) => h("span", { text: String(d) })));
      strip.dataset.target = ch;
      return h("span", { class: "digit", "aria-hidden": "true" }, strip);
    }),
  );
  const settle = () => el.querySelectorAll(".digit-strip").forEach((s) => (s.style.transform = `translateY(-${s.dataset.target}em)`));
  if (!("IntersectionObserver" in window)) return settle();
  const observer = new IntersectionObserver((records) => {
    if (records.some((r) => r.isIntersecting)) {
      settle();
      observer.disconnect();
    }
  }, { threshold: 0.4 });
  observer.observe(el);
}

/** Fade sections in as they scroll into view; everything shows at once for reduced motion. */
function initReveal() {
  const items = document.querySelectorAll("[data-reveal]");
  if (!items.length) return;
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach((el) => el.classList.add("is-revealed"));
    return;
  }
  document.documentElement.classList.add("reveal-ready");
  const observer = new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      record.target.classList.add("is-revealed");
      observer.unobserve(record.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  items.forEach((el) => observer.observe(el));
}

export function initChrome() {
  markCurrentNav();
  initTicker();
  fillPhotos();
  initReveal();
}
