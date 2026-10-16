import { test } from "node:test";
import assert from "node:assert/strict";
import { niceStep, niceTicks, stepDecimals, linearScale, logScale, logTicks, bandScale, nearestIndex, formatTick, formatPow10, labelEvery } from "../src/ui/charts/scale.js";
import { SERIES, SEQ_STOPS, DIV_STOPS, rampAt, rampCss, stepColor, normalize, hexToRgb, rgbToHex, TEMP_STOPS, tempScale, LOADING_STOPS } from "../src/ui/charts/colors.js";
import { STOPS, scale } from "../src/ui/three/parts.js";

test("niceStep picks 1 / 2 / 2.5 / 5 x 10^n", () => {
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(1, 4), 0.25);
  assert.equal(niceStep(0.2, 4), 0.05);
  assert.equal(niceStep(700, 4), 200);
  assert.equal(niceStep(3000, 3), 1000);
  assert.equal(niceStep(0, 5), 1);
  assert.equal(niceStep(NaN, 5), 1);
});

test("niceTicks widens to whole steps and has no float noise", () => {
  const t = niceTicks(0.93, 1.07, 5);
  assert.ok(t.min <= 0.93 && t.max >= 1.07);
  for (let k = 1; k < t.ticks.length; k++) assert.ok(Math.abs(t.ticks[k] - t.ticks[k - 1] - t.step) < 1e-9);
  assert.equal(t.min, t.ticks[0]);
  assert.equal(t.max, t.ticks[t.ticks.length - 1]);
  assert.ok(t.ticks.every((v) => String(v).length <= 5));
  const z = niceTicks(0, 678, 4);
  assert.deepEqual(z.ticks, [0, 200, 400, 600, 800]);
  assert.equal(z.decimals, 0);
});

test("niceTicks without nice keeps the domain and returns interior ticks only", () => {
  const t = niceTicks(0.3, 2.9, 5, { nice: false });
  assert.equal(t.min, 0.3); assert.equal(t.max, 2.9);
  assert.deepEqual(t.ticks, [0.5, 1, 1.5, 2, 2.5]);
});

test("niceTicks handles a flat or reversed domain", () => {
  const f = niceTicks(5, 5, 4);
  assert.ok(f.min < 5 && f.max > 5);
  const r = niceTicks(10, 0, 5);
  assert.equal(r.min, 0); assert.equal(r.max, 10);
});

test("stepDecimals", () => {
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(0.5), 1);
  assert.equal(stepDecimals(0.25), 2);
  assert.equal(stepDecimals(0.02), 2);
  assert.equal(stepDecimals(200), 0);
});

test("linearScale maps, inverts and handles a degenerate domain", () => {
  const s = linearScale([0, 10], [100, 0]);
  assert.equal(s(0), 100); assert.equal(s(10), 0); assert.equal(s(2.5), 75);
  assert.equal(s.invert(75), 2.5);
  const d = linearScale([3, 3], [0, 50]);
  assert.equal(d(3), 0); assert.equal(d.invert(20), 3);
});

test("logScale maps decades evenly and inverts", () => {
  const s = logScale([1e-16, 1], [200, 0]);
  assert.equal(s(1), 0); assert.equal(s(1e-16), 200);
  assert.ok(Math.abs(s(1e-8) - 100) < 1e-9);
  assert.ok(Math.abs(s.invert(100) / 1e-8 - 1) < 1e-9);
});

test("logTicks: decades, with 2 and 5 subdivisions over a short range", () => {
  assert.deepEqual(logTicks(1, 100), [1, 2, 5, 10, 20, 50, 100]);
  const wide = logTicks(1e-16, 10);
  assert.ok(wide.includes(1e-16) || wide[0] >= 1e-16);
  assert.ok(wide.length <= 9);
  assert.deepEqual(logTicks(0, 10), []);
});

test("bandScale caps bar thickness and finds the band under a pixel", () => {
  const b = bandScale(4, [0, 400]);
  assert.equal(b.band, 100); assert.equal(b.bar, 24); assert.equal(b.center(0), 50);
  assert.equal(b.start(1), 150 - 12);
  assert.equal(b.index(399), 3); assert.equal(b.index(-5), 0);
  const narrow = bandScale(20, [0, 200]);
  assert.ok(narrow.bar < narrow.band);
});

test("nearestIndex on sorted values", () => {
  const xs = [0, 1, 2, 5, 10];
  assert.equal(nearestIndex(xs, -3), 0);
  assert.equal(nearestIndex(xs, 3.4), 2);
  assert.equal(nearestIndex(xs, 3.6), 3);
  assert.equal(nearestIndex(xs, 7.4), 3);
  assert.equal(nearestIndex(xs, 7.6), 4);
  assert.equal(nearestIndex([], 1), -1);
});

test("formatTick and formatPow10", () => {
  assert.equal(formatTick(0.95, 2), "0.95");
  assert.equal(formatTick(-0.0001, 2), "0.00");
  assert.equal(formatTick(12000, 0), "12k");
  assert.equal(formatTick(1500000, 0), "1.5M");
  assert.equal(formatTick(2500, 0), "2500");
  assert.equal(formatPow10(1e-8), "1e-8");
  assert.equal(formatPow10(1), "1e0");
});

test("labelEvery thins dense category labels", () => {
  const all = labelEvery(10, 1000);
  assert.ok([...Array(10).keys()].every(all));
  const some = labelEvery(100, 700, 28);
  assert.equal([...Array(100).keys()].filter(some).length, 25);
});

test("rampAt interpolates hex stops linearly and clamps", () => {
  const S = [[0, "#000000"], [1, "#ff8000"]];
  assert.deepEqual(rampAt(S, 0), [0, 0, 0]);
  assert.deepEqual(rampAt(S, 1), [255, 128, 0]);
  assert.deepEqual(rampAt(S, 0.5), [128, 64, 0]);
  assert.deepEqual(rampAt(S, 7), [255, 128, 0]);
  assert.deepEqual(rampAt(S, -1), [0, 0, 0]);
  assert.equal(rampAt(S, NaN), null);
  assert.deepEqual(rampAt(SEQ_STOPS, 0.5), hexToRgb("#256abf"));
});

test("sequential ramp gets lighter monotonically; diverging midpoint is a neutral grey", () => {
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) { const l = lum(rampAt(SEQ_STOPS, t)); assert.ok(l >= prev - 1e-9); prev = l; }
  const mid = rampAt(DIV_STOPS, 0.5);
  assert.ok(Math.max(...mid) - Math.min(...mid) < 30, "midpoint near-grey");
});

test("stepColor, normalize, rampCss, hex helpers", () => {
  const steps = [{ max: 1, color: "a" }, { max: 10, color: "b" }, { max: Infinity, color: "c" }];
  assert.equal(stepColor(steps, 0.5), "a"); assert.equal(stepColor(steps, 1), "b"); assert.equal(stepColor(steps, 1e9), "c");
  assert.equal(stepColor(steps, NaN), null);
  assert.equal(normalize(5, [0, 10]), 0.5);
  assert.ok(Math.abs(normalize(10, [1, 100], true) - 0.5) < 1e-12);
  assert.match(rampCss([[0, "#000000"], [1, "#ffffff"]]), /^linear-gradient\(90deg, #000000 0\.0%, #ffffff 100\.0%\)$/);
  assert.equal(rgbToHex(hexToRgb("#3987e5")), "#3987e5");
  assert.deepEqual(hexToRgb("#fff"), [255, 255, 255]);
});

test("series palette is six fixed hues; domain ramps are re-exported unchanged", () => {
  assert.equal(SERIES.length, 6);
  assert.equal(new Set(SERIES).size, 6);
  assert.equal(TEMP_STOPS, STOPS);
  assert.equal(tempScale, scale);
  assert.ok(Array.isArray(LOADING_STOPS));
});

import { checkDirection, checkUtilization, meterFill, utilTone } from "../src/ui/checks.js";

test("check direction and utilisation from value, limit and pass flag", () => {
  const vd = { value: 2.1, limit: 3, passed: true };
  assert.equal(checkDirection(vd), "max");
  assert.ok(Math.abs(checkUtilization(vd) - 0.7) < 1e-12);
  const amp = { value: 2543, limit: 2000, passed: true };            // capacity >= demand
  assert.equal(checkDirection(amp), "min");
  assert.ok(Math.abs(checkUtilization(amp) - 2000 / 2543) < 1e-12);
  const failMax = { value: 4, limit: 3, passed: false };
  assert.equal(checkDirection(failMax), "max");
  assert.ok(checkUtilization(failMax) > 1);
  const failMin = { value: 50, limit: 65, passed: false };
  assert.equal(checkDirection(failMin), "min");
  assert.ok(checkUtilization(failMin) > 1);
  assert.equal(checkDirection({ value: 1, limit: 2, passed: true, direction: "min" }), "min");
  assert.equal(checkUtilization({ value: Infinity, limit: 3, passed: true }), null);
  assert.equal(checkUtilization({ value: "n/a", limit: 3 }), null);
  assert.equal(checkUtilization({ value: true, limit: 1 }), null);
});

test("meterFill and utilTone", () => {
  assert.equal(meterFill(null), 0);
  assert.equal(meterFill(1.25), 1);
  assert.equal(meterFill(5), 1);
  assert.ok(Math.abs(meterFill(1) - 0.8) < 1e-12);
  assert.equal(utilTone(0.5, true), "pass");
  assert.equal(utilTone(0.95, true), "warn");
  assert.equal(utilTone(1.2, true), "fail");
  assert.equal(utilTone(0.2, false), "fail");
  assert.equal(utilTone(null, true), "pass");
});
