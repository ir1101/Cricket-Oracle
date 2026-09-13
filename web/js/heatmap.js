// Chase-difficulty heatmap: P(chase succeeds) over runs required x balls remaining, drawn on canvas.
import { clamp } from "./core.js";

const MARGIN = { l: 52, r: 14, t: 14, b: 44 };
// Dark theme: unreachable states sit at the panel colour and a 50-50 contest is a dim grey, so
// only decisive situations glow blue or orange.
const UNREACHABLE = [20, 20, 20];
const NEUTRAL = "#383838";

// Interpolating in OKLab keeps equal probability steps looking equal on both sides of 50%.
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

function buildRamp(low, high) {
  const stops = [low, NEUTRAL, high].map(hexToOklab);
  return Array.from({ length: 256 }, (_, i) => {
    const p = i / 255;
    const [from, to, f] = p <= 0.5 ? [stops[0], stops[1], p * 2] : [stops[1], stops[2], (p - 0.5) * 2];
    return oklabToRgb(from.map((c, k) => c + (to[k] - c) * f));
  });
}

function rasterize(grid, ramp) {
  const rows = grid.target;
  const cols = grid.max_balls;
  const image = document.createElement("canvas");
  image.width = cols;
  image.height = rows;
  const ctx = image.getContext("2d");
  const pixels = ctx.createImageData(cols, rows);
  // Pixel (0, 0) is the start of the chase: every run still required, every ball still to come.
  for (let py = 0; py < rows; py++) {
    const row = grid.p[rows - py - 1];
    for (let px = 0; px < cols; px++) {
      const p = row[cols - px - 1];
      const [r, g, b] = p === null ? UNREACHABLE : ramp[Math.round(clamp(p, 0, 1) * 255)];
      const o = (py * cols + px) * 4;
      pixels.data[o] = r;
      pixels.data[o + 1] = g;
      pixels.data[o + 2] = b;
      pixels.data[o + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);

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
  return { grid, image, boundary };
}

const niceStep = (range) => [10, 20, 25, 50, 100].find((s) => range / s <= 6) ?? 100;

/**
 * Attach a heatmap to a canvas. `onHover(cell)` receives {b, r, p} for the hovered cell, or null.
 * Returns setGrid(grid), setPath(points), setMarker(point) and draw().
 */
export function createHeatmap(canvas, { onHover } = {}) {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  const ramp = buildRamp(token("--team1-fill"), token("--team2-fill"));
  const state = { entry: null, path: [], marker: null, hover: null };

  function layout() {
    const rect = canvas.getBoundingClientRect();
    return { rect, w: rect.width - MARGIN.l - MARGIN.r, h: rect.height - MARGIN.t - MARGIN.b };
  }

  function draw() {
    const { rect, w, h } = layout();
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
    if (!state.entry || w <= 0 || h <= 0) return;

    const { grid, image, boundary } = state.entry;
    const cols = grid.max_balls;
    const rows = grid.target;
    const xOf = (b) => MARGIN.l + ((cols - clamp(b, 0, cols)) / cols) * w;
    const yOf = (r) => MARGIN.t + ((rows - clamp(r, 0, rows)) / rows) * h;
    const ink = token("--ink");
    const muted = token("--ink-2");
    const paper = token("--paper");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, MARGIN.l, MARGIN.t, w, h);
    ctx.strokeStyle = token("--rule-strong");
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN.l + 0.5, MARGIN.t + 0.5, w - 1, h - 1);

    ctx.save();
    ctx.beginPath();
    let penDown = false;
    boundary.forEach((edge, b) => {
      if (!edge) {
        penDown = false;
        return;
      }
      if (penDown) ctx.lineTo(xOf(b + 0.5), yOf(edge));
      else ctx.moveTo(xOf(b + 0.5), yOf(edge));
      penDown = true;
    });
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.restore();

    ctx.font = `11px ${token("--font-mono")}`;
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let b = cols; b >= 0; b -= 24) ctx.fillText(String(b), xOf(b), MARGIN.t + h + 6);
    ctx.fillText("BALLS REMAINING", MARGIN.l + w / 2, MARGIN.t + h + 24);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let r = 0; r <= rows; r += niceStep(rows)) ctx.fillText(String(r), MARGIN.l - 8, yOf(r));
    ctx.save();
    ctx.translate(14, MARGIN.t + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("RUNS REQUIRED", 0, 0);
    ctx.restore();

    if (state.path.length > 1) {
      ctx.beginPath();
      state.path.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, xOf(p.balls_remaining), yOf(p.runs_required)));
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = paper;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (state.marker && state.marker.runs_required <= rows) {
      ctx.beginPath();
      ctx.arc(xOf(state.marker.balls_remaining), yOf(state.marker.runs_required), 6, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = paper;
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
    if (!state.entry) return null;
    const { rect, w, h } = layout();
    const fx = (event.clientX - rect.left - MARGIN.l) / w;
    const fy = (event.clientY - rect.top - MARGIN.t) / h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    const { max_balls: cols, target: rows, p } = state.entry.grid;
    const b = clamp(Math.ceil(cols - fx * cols), 1, cols);
    const r = clamp(Math.ceil(rows - fy * rows), 1, rows);
    return { b, r, p: p[r - 1][b - 1] };
  }

  canvas.addEventListener("pointermove", (event) => {
    const cell = cellAt(event);
    if (cell?.b === state.hover?.b && cell?.r === state.hover?.r) return;
    state.hover = cell;
    draw();
    onHover?.(cell);
  });
  canvas.addEventListener("pointerleave", () => {
    state.hover = null;
    draw();
    onHover?.(null);
  });
  new ResizeObserver(draw).observe(canvas);

  return {
    setGrid(grid) {
      state.entry = rasterize(grid, ramp);
      state.hover = null;
      draw();
    },
    setPath(points) {
      state.path = points;
    },
    setMarker(point) {
      state.marker = point;
    },
    draw,
    get grid() {
      return state.entry?.grid ?? null;
    },
  };
}
