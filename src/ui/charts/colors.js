/* Colour ramps and series palette for charts and heatmaps: the one place JS code gets chart colours from.
   Pure (no DOM): unit-tested in tests/charts.test.mjs. CSS-side twins live in src/head.html :root as
   --series-*, --seq-*, --div-*; keep the hex values here and there identical.

   Series palette: six hues validated (dataviz validate_palette.js, dark mode, against --panel #0f161d and
   --bg #0a0f14) for lightness band, chroma, adjacent-pair colour-blind separation (worst CVD dE 8.4) and
   contrast. Assign in this fixed order; never cycle. Phase identity (A/B/C) always uses the phase colours,
   status (pass/warn/fail) always uses the status colours; neither is a series slot. */

export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
export const SERIES_VAR = SERIES.map((_, k) => `var(--series-${k + 1})`);
export const PHASE = { A: "#e05a4f", B: "#e8c35a", C: "#5aa0e0" };
export const PHASE_VAR = { A: "var(--ph-a)", B: "var(--ph-b)", C: "var(--ph-c)" };
export const STATUS = { ok: "#4cc38a", warn: "#ff8b4a", crit: "#ff5f5f", low: "#7b93ff", info: "#63b6d6" };

/* Sequential (magnitude) ramp for the dark surface: one hue (blue), dark near the surface -> light for high. */
export const SEQ_STOPS = [[0, "#0f2336"], [0.25, "#174a78"], [0.5, "#256abf"], [0.75, "#5598e7"], [1, "#b7d3f6"]];
/* Diverging (polarity) ramp: blue <-> neutral grey <-> red, equal arms. */
export const DIV_STOPS = [[0, "#3987e5"], [0.25, "#2c5a8c"], [0.5, "#2f3a44"], [0.75, "#9a4848"], [1, "#e66767"]];

/* Existing domain ramps, re-exported unchanged so new code imports every ramp from here. */
export { STOPS as TEMP_STOPS, scale as tempScale } from "../three/parts.js";
export { LOADING_STOPS, VOLTAGE_STOPS, interpStops } from "../systemOverlay.js";

export function hexToRgb(h) {
  const s = h.replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export const rgbCss = (c) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;

/* Colour at t in [0, 1] through [t, hex] stops (clamped), linear in sRGB. Returns [r, g, b]. */
export function rampAt(stops, t) {
  if (!Number.isFinite(t)) return null;
  const x = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], t));
  for (let k = 1; k < stops.length; k++) {
    const [b, cb] = stops[k];
    if (x <= b) {
      const [a, ca] = stops[k - 1], f = b === a ? 1 : (x - a) / (b - a);
      const A = hexToRgb(ca), B = hexToRgb(cb);
      return A.map((v, j) => Math.round(v + (B[j] - v) * f));
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

/* CSS linear-gradient for a [t, hex] ramp (colour bars, legends). */
export const rampCss = (stops, dir = "90deg") => `linear-gradient(${dir}, ${stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(", ")})`;

/* Binned scale: steps = [{ max, color }] sorted ascending; returns the colour of the first bin with v < max. */
export function stepColor(steps, v) {
  if (!Number.isFinite(v)) return null;
  return (steps.find((s) => v < s.max) || steps[steps.length - 1]).color;
}

/* Map a value to [0, 1] on a linear or log domain (for continuous ramps). */
export function normalize(v, [lo, hi], log = false) {
  if (!Number.isFinite(v)) return NaN;
  if (log) { const a = Math.log10(lo), b = Math.log10(hi); return b === a ? 0 : (Math.log10(Math.max(v, lo)) - a) / (b - a); }
  return hi === lo ? 0 : (v - lo) / (hi - lo);
}
