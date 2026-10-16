import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agingFactor, ultimateTopOilRise, ultimateHotSpotGradient, simulateLoading, validateParams, exponentsFor, coolingModeOf,
  loadingFromProfile, loadableTransformers, transformerLoadingStudy, THERMAL_DATA, COOLING_MODES,
} from "../src/engine/transformerLoading.js";
import { profileStudy, PROFILES } from "../src/engine/loadprofile.js";
import { EXAMPLE_SYSTEM } from "../src/engine/system.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
// Analytic parameter set (not a product rating): 50 + 30 = 80 °C hot-spot rise at rated load, so 30 °C ambient
// gives the 110 °C aging reference of 65 °C-rise insulation.
const P = { d_to_r: 50, d_h_r: 30, r: 4.5, tau_to_min: 120, tau_w_min: 10, n: 0.8, m: 0.8 };

test("data file carries _meta and statuses, nothing VERIFIED", () => {
  assert.equal(THERMAL_DATA._meta.status, "UNVERIFIED");
  assert.equal(THERMAL_DATA.aging.b_constant, 15000);
  assert.equal(THERMAL_DATA.aging.reference_hot_spot_c, 110);
  assert.equal(THERMAL_DATA.normal_life_h.value, 180000);
  for (const k of COOLING_MODES) { const e = exponentsFor(k); assert.equal(e.status, "UNVERIFIED"); assert.ok(e.n >= 0.8 && e.n <= 1 && e.m >= 0.8 && e.m <= 1); assert.ok(e.source); }
  const g = THERMAL_DATA.presets.gouda_2012_onaf_25mva;
  assert.deepEqual([g.d_to_r, g.d_h_r, g.r, g.tau_to_min, g.tau_w_min, g.n, g.m], [38.3, 23.5, 5, 114, 7, 0.9, 0.8]);
});

test("aging acceleration factor: analytic values", () => {
  near(agingFactor(110), 1, 1e-12, "reference");
  // 15000/383 - 15000/393 = 39.164491 - 38.167939 = 0.996552 -> e^0.996552 = 2.70893
  near(agingFactor(120), 2.70893, 1e-5, "120 C");
  // 15000/383 - 15000/371 = 39.164491 - 40.431267 = -1.266776 -> e^-1.266776 = 0.281738
  near(agingFactor(98), 0.281738, 1e-6, "98 C");
});

test("ultimate rises: rated load returns rated rises for any R, n, m", () => {
  for (const r of [0, 2, 4.5, 12]) for (const n of [0.8, 0.9, 1]) {
    near(ultimateTopOilRise(1, { ...P, r, n }), 50, 1e-12);
    near(ultimateHotSpotGradient(1, { ...P, m: n }), 30, 1e-12);
  }
  // K = 0.5, R = 4.5, n = 0.8: (0.25*4.5 + 1)/5.5 = 0.386364; ^0.8 = 0.467301 -> 50 * 0.467301 = 23.3651
  near(ultimateTopOilRise(0.5, P), 23.3651, 1e-4);
  // K = 0.5, m = 0.8: 30 * 0.5^1.6 = 30 * 0.329877 = 9.8963
  near(ultimateHotSpotGradient(0.5, P), 9.8963, 1e-4);
  assert.equal(ultimateHotSpotGradient(0, P), 0);
});

test("constant rated load at 30 °C ambient: hot spot 110 °C, F_EQA = 1, LOL = one normal day", () => {
  const r = simulateLoading({ K: Array(24).fill(1), ambient: 30, params: P });
  assert.ok(r.ok, r.message);
  for (const s of r.steps) near(s.theta_h, 110, 1e-9);
  near(r.feqa, 1, 1e-12);
  // 1 x 24 h x 100 / 180000 h = 0.013333 %
  near(r.lol_pct, 0.0133333, 1e-7);
  near(r.lol_pct, r.normal_lol_pct, 1e-15);
  assert.equal(r.steps.length, 24 * 60 + 1);
});

test("step load: top oil reaches 63.2 % of the change after one oil time constant, hot spot after one winding constant", () => {
  // steady state at K = 0.5 for hour 0, then K = 1. max_cycles 0 keeps the steady start (no periodic warm-up).
  const K = [0.5, ...Array(23).fill(1)];
  const r = simulateLoading({ K, ambient: 30, params: P, max_cycles: 0 });
  assert.ok(r.ok, r.message);
  const u0 = ultimateTopOilRise(0.5, P), g0 = ultimateHotSpotGradient(0.5, P);
  near(r.steps[60].d_to, u0, 1e-9, "still steady at end of hour 0");
  // t = 60 + 120 min: 50 - (50 - 23.3651) e^-1 = 50 - 9.7984 = 40.2016
  near(r.steps[180].d_to, 40.2016, 1e-3, "one tauTO after the step");
  near(r.steps[180].d_to, 50 - (50 - u0) * Math.exp(-1), 1e-9);
  // t = 60 + 10 min: 30 - (30 - 9.8963) e^-1 = 30 - 7.3957 = 22.6043
  near(r.steps[70].d_h, 22.6043, 1e-3, "one tauW after the step");
  // five oil time constants later the top-oil rise is within 1 % of ultimate
  assert.ok(Math.abs(r.steps[60 + 600].d_to - 50) < 0.01 * (50 - u0));
});

test("exact exponential stepping: the time step does not change temperatures at step boundaries", () => {
  const K = PROFILES.industrial_two_shift.hours.map((f) => 1.1 * f);
  const a = simulateLoading({ K, ambient: 25, params: P, dt_min: 1 });
  for (const dt of [0.5, 3, 15, 60]) {
    const b = simulateLoading({ K, ambient: 25, params: P, dt_min: dt });
    assert.ok(b.ok, b.message);
    for (let h = 0; h < 24; h++) near(b.hourly[h].theta_h_end, a.hourly[h].theta_h_end, 1e-6, `dt ${dt} hour ${h}`);
  }
  assert.equal(simulateLoading({ K, ambient: 25, params: P, dt_min: 7 }).ok, false);
});

test("periodic steady state, ambient superposition and F_EQA / LOL bookkeeping", () => {
  const K = PROFILES.industrial_two_shift.hours.map((f) => 1.2 * f);
  const r = simulateLoading({ K, ambient: 30, params: P });
  assert.ok(r.converged);
  const first = r.steps[0], last = r.steps[r.steps.length - 1];
  near(last.d_to, first.d_to, 0.01); near(last.d_h, first.d_h, 0.01);
  // a uniform +5 °C ambient shifts every temperature by exactly 5 °C
  const r5 = simulateLoading({ K, ambient: Array(24).fill(35), params: P });
  for (let i = 0; i < r.steps.length; i += 37) near(r5.steps[i].theta_h - r.steps[i].theta_h, 5, 1e-6);
  assert.ok(r5.feqa > r.feqa);
  near(r.lol_pct, (r.feqa * 24 * 100) / 180000, 1e-15);
  near(r.hourly.reduce((s, h) => s + h.faa_mean, 0) / 24, r.feqa, 1e-12, "hourly F_AA averages to F_EQA");
  assert.ok(r.peak_theta_h >= Math.max(...r.hourly.map((h) => h.theta_h_end)) - 1e-9);
});

test("missing thermal inputs are refused (no hidden defaults)", () => {
  const r = simulateLoading({ K: Array(24).fill(1), ambient: 30, params: { d_to_r: 50 } });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 6);
  assert.equal(validateParams(P).length, 0);
  assert.equal(validateParams({ ...P, n: 3 }).length, 1);
  assert.equal(simulateLoading({ K: [1, 2], ambient: 30, params: P }).ok, false);
  assert.equal(simulateLoading({ K: Array(24).fill(1), ambient: [30], params: P }).ok, false);
});

test("cooling mode from the System cooling string", () => {
  assert.equal(coolingModeOf("ONAN"), "ONAN");
  assert.equal(coolingModeOf("ONAN/ONAF"), "ONAN");
  assert.equal(coolingModeOf("odaf"), "ODAF");
  assert.equal(coolingModeOf(undefined), "ONAN");
});

test("integration: example system T1 over the industrial two-shift profile", () => {
  const prof = profileStudy(EXAMPLE_SYSTEM, "industrial_two_shift");
  assert.ok(prof.ok, prof.message);
  const K = loadingFromProfile(prof, "T1");
  assert.equal(K.length, 24);
  for (let h = 0; h < 24; h++) near(K[h], prof.loading.T1[h] / 100, 1e-15);
  assert.deepEqual(loadableTransformers(EXAMPLE_SYSTEM, prof).map((e) => e.id).sort(), ["T1", "T2"]);

  const g = THERMAL_DATA.presets.gouda_2012_onaf_25mva;
  const r = transformerLoadingStudy(EXAMPLE_SYSTEM, "T1", prof, { params: g, ambient: 30, limits: { hot_spot_c: 120 } });
  assert.ok(r.ok, r.message);
  assert.equal(r.kva, 2500);
  // the hot spot peaks while T1 is most loaded (or just after, by the oil lag)
  const kPeak = Math.max(...K), hPeak = K.indexOf(kPeak);
  assert.ok(r.peak_t_min / 60 >= hPeak && r.peak_t_min / 60 <= 24, `peak at ${r.peak_t_min} min, load peak hour ${hPeak}`);
  // ceiling: steady state at the peak load is never exceeded
  const ceiling = 30 + ultimateTopOilRise(kPeak, g) + ultimateHotSpotGradient(kPeak, g);
  assert.ok(r.peak_theta_h <= ceiling + 1e-9);
  // floor: never below steady state at the lightest load
  const kMin = Math.min(...K);
  assert.ok(Math.min(...r.steps.map((s) => s.theta_h)) >= 30 + ultimateTopOilRise(kMin, g) + ultimateHotSpotGradient(kMin, g) - 1e-9);
  near(r.lol_pct, (r.feqa * 24 * 100) / 180000, 1e-15);
  assert.equal(r.checks.length, 3);
  assert.ok(r.checks.every((c) => c.name && c.clause && c.status && typeof c.passed === "boolean"));
  // missing transformer / missing inputs
  assert.equal(transformerLoadingStudy(EXAMPLE_SYSTEM, "M1", prof, { params: g, ambient: 30 }).ok, false);
  assert.equal(transformerLoadingStudy(EXAMPLE_SYSTEM, "T1", prof, { params: {}, ambient: 30 }).ok, false);
});

test("integration: overloading T1 raises the hot spot and loss of life", () => {
  const prof = profileStudy(EXAMPLE_SYSTEM, "industrial_two_shift");
  const small = { ...EXAMPLE_SYSTEM, equipment: EXAMPLE_SYSTEM.equipment.map((e) => (e.id === "T1" ? { ...e, kva: 1500 } : e)) };
  const prof2 = profileStudy(small, "industrial_two_shift");
  const g = THERMAL_DATA.presets.gouda_2012_onaf_25mva;
  const a = transformerLoadingStudy(EXAMPLE_SYSTEM, "T1", prof, { params: g, ambient: 30 });
  const b = transformerLoadingStudy(small, "T1", prof2, { params: g, ambient: 30 });
  assert.ok(b.peak_theta_h > a.peak_theta_h && b.lol_pct > a.lol_pct);
});
