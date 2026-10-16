/* Pure scale and tick helpers for the chart kit. No DOM, no React: unit-tested in tests/charts.test.mjs. */

const EPS = 1e-9;

/* A "nice" step (1, 2, 2.5 or 5 times a power of ten) close to span / count. */
export function niceStep(span, count = 5) {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}

/* Decimal places needed to print every multiple of `step` without noise. */
export function stepDecimals(step) {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let d = 0; d <= 10; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 10;
}

/* Ticks covering [min, max]. With nice = true the domain is widened to whole steps (axes that start at a step);
   otherwise only the ticks that fall inside [min, max] are returned. */
export function niceTicks(min, max, count = 5, { nice = true } = {}) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1], decimals: 0 };
  if (max < min) [min, max] = [max, min];
  if (max - min < EPS) { const pad = Math.abs(min) > EPS ? Math.abs(min) * 0.1 : 1; min -= pad; max += pad; }
  const step = niceStep(max - min, count);
  const lo = nice ? Math.floor(min / step + EPS) * step : min;
  const hi = nice ? Math.ceil(max / step - EPS) * step : max;
  const ticks = [];
  for (let k = Math.ceil(lo / step - EPS); k * step <= hi + step * EPS; k++) ticks.push(clean(k * step));
  return { min: nice ? clean(lo) : min, max: nice ? clean(hi) : max, step, ticks, decimals: stepDecimals(step) };
}

/* Strip float noise from a tick value (0.30000000000000004 -> 0.3). */
const clean = (v) => (Math.abs(v) < EPS ? 0 : +v.toPrecision(12));

/* Linear scale domain -> range with invert and ticks. */
export function linearScale([d0, d1], [r0, r1]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = (v) => r0 + (v - d0) * k;
  f.invert = (px) => (k === 0 ? d0 : d0 + (px - r0) / k);
  f.domain = [d0, d1]; f.range = [r0, r1]; f.type = "linear";
  f.ticks = (n = 5) => niceTicks(d0, d1, n, { nice: false }).ticks;
  return f;
}

/* Log10 scale. Ticks: every decade, plus 2 and 5 when there are few decades. */
export function logScale([d0, d1], [r0, r1]) {
  const l0 = Math.log10(d0), l1 = Math.log10(d1);
  const k = l1 === l0 ? 0 : (r1 - r0) / (l1 - l0);
  const f = (v) => r0 + (Math.log10(Math.max(v, Number.MIN_VALUE)) - l0) * k;
  f.invert = (px) => 10 ** (k === 0 ? l0 : l0 + (px - r0) / k);
  f.domain = [d0, d1]; f.range = [r0, r1]; f.type = "log";
  f.ticks = () => logTicks(d0, d1);
  return f;
}

export function logTicks(d0, d1) {
  if (!(d0 > 0 && d1 > 0)) return [];
  const lo = Math.min(d0, d1), hi = Math.max(d0, d1);
  const e0 = Math.floor(Math.log10(lo) + EPS), e1 = Math.ceil(Math.log10(hi) - EPS);
  const decades = e1 - e0;
  const mults = decades <= 2 ? [1, 2, 5] : [1];
  const every = decades > 8 ? Math.ceil(decades / 6) : 1;
  const out = [];
  for (let e = e0; e <= e1; e += mults.length > 1 ? 1 : every) for (const m of mults) {
    const v = clean(m * 10 ** e);
    if (v >= lo * (1 - EPS) && v <= hi * (1 + EPS)) out.push(v);
  }
  return out;
}

/* Categorical band scale: n equal bands across the range; bar width capped (dataviz mark spec: <= 24 px). */
export function bandScale(n, [r0, r1], { inner = 0.28, maxBar = 24 } = {}) {
  const band = n > 0 ? (r1 - r0) / n : 0;
  const bar = Math.max(1, Math.min(maxBar, band * (1 - inner)));
  const center = (i) => r0 + band * (i + 0.5);
  return { band, bar, center, start: (i) => center(i) - bar / 2, index: (px) => Math.max(0, Math.min(n - 1, Math.floor((px - r0) / (band || 1)))) };
}

/* Index of the value in a sorted array closest to x. */
export function nearestIndex(xs, x) {
  if (!xs.length) return -1;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  return Math.abs(xs[hi] - x) < Math.abs(xs[lo] - x) ? hi : lo;
}

/* Tick label: fixed decimals from the tick step, compact thousands (1.2k) from 10 000 up. */
export function formatTick(v, decimals = 0) {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e4 && decimals === 0) {
    const [div, suf] = a >= 1e6 ? [1e6, "M"] : [1e3, "k"];
    const s = (v / div).toFixed(a / div >= 100 ? 0 : 1).replace(/\.0$/, "");
    return s + suf;
  }
  const s = v.toFixed(decimals);
  return s === "-0" || /^-0\.0+$/.test(s) ? s.slice(1) : s;
}

/* Format 10^n as "1e-8" style labels for log axes. */
export function formatPow10(v) {
  const e = Math.round(Math.log10(v));
  return Math.abs(10 ** e - v) / v < 1e-9 ? `1e${e}` : formatTick(v, v < 1 ? stepDecimals(v) : 0);
}

/* Thin out category labels so at most one label per `minPx` pixels is drawn. Returns a predicate on index. */
export function labelEvery(n, widthPx, minPx = 28) {
  const k = Math.max(1, Math.ceil((n * minPx) / Math.max(1, widthPx)));
  return (i) => i % k === 0;
}
