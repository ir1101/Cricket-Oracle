// Shared helpers and page chrome: API access, formatting, team colours, nav, live pill, photos, motion.

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

// [primary, secondary] team colours, lifted where needed so they read on a black background.
const TEAM_COLORS = {
  "Chennai Super Kings": ["#f9cd1b", "#5aa9ff"],
  "Mumbai Indians": ["#3d8bff", "#e7c35a"],
  "Royal Challengers Bengaluru": ["#ff4b4b", "#e3c16f"],
  "Kolkata Knight Riders": ["#a47dff", "#e8c547"],
  "Sunrisers Hyderabad": ["#ff8a2b", "#f3f0e8"],
  "Rajasthan Royals": ["#ff4fa0", "#5c8dff"],
  "Delhi Capitals": ["#4c84ff", "#ff5a5a"],
  "Punjab Kings": ["#ff5560", "#cfd5dd"],
  "Gujarat Titans": ["#7ea6dd", "#d8b66e"],
  "Lucknow Super Giants": ["#2ec5f0", "#ff8b3d"],
  "Deccan Chargers": ["#9ec3e6", "#f2c14e"],
  "Gujarat Lions": ["#ff7a35", "#7fb2ff"],
  "Kochi Tuskers Kerala": ["#ff8f4d", "#b58cff"],
  "Pune Warriors": ["#4fb0ff", "#e8e4d8"],
  "Rising Pune Supergiant": ["#e55bc1", "#7fb2ff"],
  India: ["#4f9bff", "#ff9a3c"],
  Australia: ["#ffd23f", "#2fbf71"],
  England: ["#5b8cff", "#ff5a5f"],
  Pakistan: ["#2fbf71", "#f3f0e8"],
  "South Africa": ["#2fbf71", "#ffd23f"],
  "New Zealand": ["#e9e7df", "#8c8c86"],
  "West Indies": ["#d4506a", "#ffd23f"],
  "Sri Lanka": ["#4f7dff", "#ffc845"],
  Bangladesh: ["#2fbf71", "#ff5a5f"],
  Afghanistan: ["#4f7dff", "#ff5a5f"],
  Ireland: ["#3ccb7f", "#f3f0e8"],
  Zimbabwe: ["#ff5a5f", "#ffd23f"],
};
// Teams without known colours get one of these, picked from their name so it never changes.
const FALLBACK_COLORS = ["#7cc4ff", "#ffb65c", "#b58cff", "#5fd7a8", "#ff7fa8", "#e6d35c", "#ff8a5c", "#9fb3c8"];
const CHALK = "#ebe9e1";
const VOLT = "#d4ff3a";
const MIN_DISTANCE = 0.15; // OKLab distance below which two sides would be hard to tell apart

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

/* ---------- Colour ---------- */

const toLinear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function hexToOklab(hex) {
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

const distance = (a, b) => Math.hypot(...hexToOklab(a).map((v, i) => v - hexToOklab(b)[i]));

function colorsFor(team) {
  if (TEAM_COLORS[team]) return TEAM_COLORS[team];
  let hash = 0;
  for (const ch of team) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const i = hash % FALLBACK_COLORS.length;
  return [FALLBACK_COLORS[i], FALLBACK_COLORS[(i + 3) % FALLBACK_COLORS.length]];
}

/** The two colours a match is drawn in. The second side switches colour when the pair would clash. */
export function matchColors(team1, team2) {
  if (!team1 || !team2) return [CHALK, VOLT];
  const first = colorsFor(team1)[0];
  const candidates = [...colorsFor(team2), CHALK, VOLT];
  const second = candidates.find((c) => distance(first, c) >= MIN_DISTANCE) ?? CHALK;
  return [first, second];
}

/** Set the side colours used by probability bars, charts and labels inside `el`. */
export function applySides(el, team1, team2) {
  const [c1, c2] = matchColors(team1, team2);
  el.style.setProperty("--side-1", c1);
  el.style.setProperty("--side-2", c2);
  el.style.setProperty("--side-1-soft", `color-mix(in oklab, ${c1} 15%, transparent)`);
  el.style.setProperty("--side-2-soft", `color-mix(in oklab, ${c2} 15%, transparent)`);
  return [c1, c2];
}

/* ---------- Team logos ---------- */

/** The key logos are stored under, matching oracle.logos.slug for names already normalised at ingest. */
export const teamSlug = (team) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

let logoRequest = null;

/** Logo links by team slug, fetched once per page. Resolves to {} when logos are unavailable. */
export function teamLogos() {
  logoRequest ??= api("/api/logos").then((body) => body.logos ?? {}).catch(() => ({}));
  return logoRequest;
}

/**
 * The mark shown before a team's name: its logo, or a monogram in the team colour (--team-color)
 * when there is no logo or the image fails to load.
 */
export function teamMark(team, { logo, short, className = "" } = {}) {
  const monogram = () =>
    h("span", { class: `team-mark monogram ${className}`.trim(), "aria-hidden": "true", text: (short || abbr(team)).slice(0, 4) });
  if (!logo) return monogram();
  const img = h("img", { class: `team-mark team-logo ${className}`.trim(), src: logo, alt: "", decoding: "async", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(monogram()), { once: true });
  return img;
}

/* ---------- Model confidence ---------- */

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

/* ---------- Motion helpers (motion.css holds the animations themselves) ---------- */

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const tweens = new WeakMap();
const flashTimers = new WeakMap();

/**
 * Count a percentage shown in `el` up or down to `to`. It starts from the value the element last showed,
 * or from `initial` if it has shown none; with neither, it jumps straight to `to`. The text always ends on pct(to).
 */
export function tweenPercent(el, to, { initial, duration = 450, format = pct } = {}) {
  const previous = tweens.get(el);
  if (previous) cancelAnimationFrame(previous.frame);
  const start = previous?.value ?? initial ?? to;
  const entry = { value: to, frame: 0 };
  tweens.set(el, entry);
  if (start === to || reducedMotion() || document.hidden) {
    el.textContent = format(to);
    return;
  }
  entry.value = start;
  el.textContent = format(start);
  const began = performance.now();
  const tick = (now) => {
    const t = Math.min((now - began) / duration, 1);
    entry.value = t < 1 ? start + (to - start) * (1 - (1 - t) ** 3) : to;
    el.textContent = format(entry.value);
    if (t < 1) entry.frame = requestAnimationFrame(tick);
  };
  entry.frame = requestAnimationFrame(tick);
}

/** Stop any count running in `el` and forget its value, so the next count starts afresh. */
export function stopTween(el) {
  const entry = tweens.get(el);
  if (entry) cancelAnimationFrame(entry.frame);
  tweens.delete(el);
}

/** Replay a one-shot animation class on `el` (for example a wicket flash). */
export function flash(el, className, duration = 900) {
  if (reducedMotion()) return;
  el.classList.remove(className);
  void el.offsetWidth; // restart the animation if the class was still on
  el.classList.add(className);
  clearTimeout(flashTimers.get(el));
  flashTimers.set(el, setTimeout(() => el.classList.remove(className), duration));
}

/** Run `callback` once, the first time `el` is at least `threshold` visible. */
export function whenVisible(el, callback, threshold = 0.35) {
  if (!("IntersectionObserver" in window)) return callback();
  const observer = new IntersectionObserver((records) => {
    if (!records.some((r) => r.isIntersecting)) return;
    observer.disconnect();
    callback();
  }, { threshold });
  observer.observe(el);
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
  const settle = () =>
    el.querySelectorAll(".digit-strip").forEach((strip, i) => {
      strip.style.transitionDelay = `${i * 60}ms`;
      strip.style.transform = `translateY(-${strip.dataset.target}em)`;
    });
  whenVisible(el, settle, 0.4);
}

/* ---------- Chrome ---------- */

function markCurrentNav() {
  const page = document.body.dataset.page;
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === page) link.setAttribute("aria-current", "page");
  }
}

/** The header pill that points to live matches, when there are any. */
async function initLivePill() {
  const pill = document.getElementById("live-pill");
  if (!pill) return;
  const upcoming = await api("/api/upcoming").catch(() => null);
  const live = upcoming?.status === "ok" ? upcoming.matches.filter((m) => m.state === "live") : [];
  if (!live.length) return;
  const text = live.length === 1 ? `Live · ${abbr(live[0].team1)} v ${abbr(live[0].team2)}` : `${live.length} matches live`;
  pill.replaceChildren(h("span", { class: "live-dot", "aria-hidden": "true" }), h("span", { text }));
  pill.hidden = false;
}

// Photo slots take files by name: the first prefix that matches wins, and each file is used once.
const PHOTO_PREFIXES = {
  hero: ["hero-action", "hero"],
  stadium: ["stadium", "spotlight"],
  history: ["history"],
  upcoming: ["upcoming"],
  calculator: ["calculator"],
};

async function fillPhotos() {
  const slots = [...document.querySelectorAll("[data-photo]")];
  if (!slots.length) return;
  let images = [];
  let videos = [];
  let notes = {};
  try {
    // photos.json holds optional per-file focal points, e.g. {"hero-1.jpg": {"focus": "50% 0%"}}.
    [{ images = [], videos = [] }, notes] = await Promise.all([api("/api/images"), api("/images/photos.json").catch(() => ({}))]);
  } catch {
    return;
  }
  const used = new Set();
  for (const slot of slots) {
    const loop = slot.dataset.video && !reducedMotion() && videos.find((v) => v.name.toLowerCase().startsWith(slot.dataset.video));
    if (loop) {
      placeVideo(slot, loop);
      continue;
    }
    const prefixes = PHOTO_PREFIXES[slot.dataset.photo] ?? [slot.dataset.photo];
    let file = null;
    for (const prefix of prefixes) {
      file = images.find((f) => !used.has(f.name) && f.name.toLowerCase().startsWith(prefix));
      if (file) break;
    }
    if (!file) continue;
    used.add(file.name);
    placePhoto(slot, file, notes[file.name]);
  }
}

function placePhoto(slot, file, note = {}) {
  const img = new Image();
  img.alt = slot.dataset.alt ?? "";
  img.decoding = "async";
  img.loading = slot.hasAttribute("data-eager") ? "eager" : "lazy";
  if (note.focus) img.style.objectPosition = note.focus;
  img.addEventListener("load", () => slot.classList.add("has-photo"), { once: true });
  img.src = file.url;
  slot.prepend(img);
}

function placeVideo(slot, file) {
  const video = h("video", { muted: true, loop: true, autoplay: true, playsInline: true, preload: "auto", "aria-hidden": "true" });
  video.addEventListener("loadeddata", () => slot.classList.add("has-photo"), { once: true });
  video.src = file.url;
  slot.prepend(video);
}

/** Fade sections in as they scroll into view; everything shows at once for reduced motion. */
function initReveal() {
  document.querySelectorAll("[data-stagger]").forEach((list) =>
    [...list.children].forEach((child, i) => child.style.setProperty("--i", i)),
  );
  const items = document.querySelectorAll("[data-reveal]");
  if (!items.length) return;
  if (!("IntersectionObserver" in window) || reducedMotion()) {
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
  initLivePill();
  fillPhotos();
  initReveal();
}
