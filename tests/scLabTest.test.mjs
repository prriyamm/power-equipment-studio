// Tests for the virtual short-circuit lab test engine (src/engine/scLabTest.js).
import test from "node:test";
import assert from "node:assert/strict";
import { labInput, runLabTest, findFailureCurrent, buildContext, thermalPeakC, gridInfo, staticDeflectionMm } from "../src/engine/scLabTest.js";
import { faultForces } from "../src/engine/pecalc/forces.js";
import { BLOCK_MATERIALS } from "../src/engine/pecalc/cablebus_design.js";
import * as cond from "../src/engine/pecalc/conductors.js";

const BUS = {
  voltage_v: 15000, current_a: 2000, size: "750", material: "Cu", conductors_per_phase: 3, tiers: 2,
  insulation: "EPR", insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2, shield_bonding: "both_ends", length_m: 60,
  fault_ka: 40, x_over_r: 15, enclosure_width_mm: 800, enclosure_height_mm: 150,
};
const mk = (o = {}) => labInput({ bus: BUS, test_ka: 40, duration_s: 0.2, ...o });
const ctx = buildContext(mk().bus);

test("pass case: 40 kA on the example bus, no criterion reached", () => {
  const r = runLabTest(mk(), ctx);
  assert.equal(r.passed, true);
  assert.equal(r.failure, null);
  assert.ok(r.peak_utilisation < 0.2, `peak ${r.peak_utilisation}`);
  assert.equal(r.governing_mode, "block");
  assert.ok(r.margin_pct > 80 && r.margin_pct < 100);
  assert.equal(r.status, "UNVERIFIED");
  assert.match(r.notes[0], /Screening level/);
});

test("peak force equals faultForces worst force (existing physics reused)", () => {
  const r = runLabTest(mk({ closing_angle_deg: null }), ctx);
  const fr = faultForces(ctx.cs, ctx.share, 40, 15, { freq: 60 });
  assert.ok(Math.abs(r.peak_force_n_per_m - fr.worst_n_per_m) <= 1e-9 * fr.worst_n_per_m);
});

test("block ratio is load over the screening allowable load", () => {
  const r = runLabTest(mk(), ctx);
  const lig = Math.min(ctx.result.pitch_mm - ctx.od, ctx.od);
  const limit = (BLOCK_MATERIALS["GPO-3"].tensile / 2) * 25.4 * lig;
  assert.ok(Math.abs(r.limits.block_limit_n - limit) < 1e-9);
  const k = r.force_envelope_n_per_m.indexOf(Math.max(...r.force_envelope_n_per_m));
  assert.ok(Math.abs(r.block_ratio[k] - (r.force_envelope_n_per_m[k] * ctx.inp.support_span_m) / limit) < 1e-12);
});

test("I^2 scaling: failure current from the ratio re-simulates to utilisation 1.00 +/- 1e-6", () => {
  const L = mk({ duration_s: 0.1 });
  const r = runLabTest(L, ctx);
  const ff = findFailureCurrent(L, ctx);
  const blk = ff.modes.find((m) => m.mode === "block");
  assert.ok(Math.abs(blk.current_ka - 40 / Math.sqrt(r.peaks.block)) < 1e-9);
  const r2 = runLabTest({ ...L, test_ka: blk.current_ka }, ctx);
  assert.ok(Math.abs(r2.peaks.block - 1) < 1e-6, `ratio ${r2.peaks.block}`);
});

test("block failure: just above the failure current fails with mode block, at a finite time", () => {
  const L = mk({ duration_s: 0.1 });
  const ff = findFailureCurrent(L, ctx);
  const r = runLabTest({ ...L, test_ka: ff.modes.find((m) => m.mode === "block").current_ka * 1.02 }, ctx);
  assert.equal(r.passed, false);
  assert.equal(r.failure.mode, "block");
  assert.ok(r.failure.t_ms > 0 && r.failure.t_ms < 25, `t ${r.failure.t_ms} ms`);
  assert.equal(r.failure.block_index, 1);
  assert.ok(r.peak_utilisation > 1.03 && r.margin_pct < 0);
  // utilisation just below the crossing sample is < 1
  assert.ok(r.block_ratio[r.failure.sample_index - 1] < 1 && r.block_ratio[r.failure.sample_index] >= 1);
});

test("tested block rating replaces the screening limit and is reported", () => {
  const r0 = runLabTest(mk(), ctx);
  const peakLoad = r0.peaks.block * r0.limits.block_limit_n;
  const r = runLabTest(mk({ tested_block_load_n: peakLoad * 0.5 }), ctx);
  assert.equal(r.limits.block_basis, "tested block rating");
  assert.equal(r.failure.mode, "block");
  assert.equal(r.failure.basis, "tested block rating");
  assert.ok(r.data_status[0].status.startsWith("USER"));
});

test("tested force criterion triggers a force failure when entered", () => {
  const r0 = runLabTest(mk(), ctx);
  const r = runLabTest(mk({ tested_force_n_per_m: r0.peak_force_n_per_m * 0.8 }), ctx);
  assert.equal(r.passed, false);
  assert.equal(r.failure.mode, "force");
  assert.ok(r.peaks.force > 1.2);
  const ff = findFailureCurrent(mk({ tested_force_n_per_m: r0.peak_force_n_per_m * 0.8 }), ctx);
  assert.ok(Math.abs(ff.modes.find((m) => m.mode === "force").current_ka - 40 * Math.sqrt(0.8)) < 1e-9);
});

test("thermal failure: low damage temperature trips the hottest conductor; time is the first crossing", () => {
  const r = runLabTest(mk({ damage_temp_c: 92, duration_s: 0.5 }), ctx);
  assert.equal(r.passed, false);
  assert.equal(r.failure.mode, "thermal");
  const i = r.failure.conductor_index, k = r.failure.sample_index;
  assert.ok(r.temp_c[i][k] >= 92 && r.temp_c[i][k - 1] < 92);
  assert.ok(r.failure.t_s <= r.t_s[k] && r.failure.t_s >= r.t_s[k - 1]);
  // no other conductor crossed earlier
  for (const j of r.phase_idx) assert.ok(r.temp_c[j].findIndex((v) => v >= 92) >= k);
});

test("bisection finds the thermal failure current; the re-simulation sits at the damage temperature", () => {
  const L = mk({ damage_temp_c: 150, duration_s: 0.5 });
  const ff = findFailureCurrent(L, ctx);
  const th = ff.modes.find((m) => m.mode === "thermal");
  assert.equal(th.method, "bisection");
  const alpha = (ff.closing_angle_deg * Math.PI) / 180;
  const t = thermalPeakC(ctx, L, th.current_ka, alpha, 90);
  assert.ok(Math.abs(t - 150) < 1e-6, `T ${t}`);
  // analytic cross-check: T = (T0+t0)*10^(c I^2) - t0, so log10((T+t0)/(T0+t0)) scales with I^2
  const t1 = thermalPeakC(ctx, L, 10, alpha, 90), t2 = thermalPeakC(ctx, L, 20, alpha, 90);
  const e = (T) => Math.log10((T + 234) / (90 + 234));
  assert.ok(Math.abs(e(t2) / e(t1) - 4) < 1e-9);
  const lo = runLabTest({ ...L, test_ka: th.current_ka * 0.999 }, ctx), hi = runLabTest({ ...L, test_ka: th.current_ka * 1.001 }, ctx);
  assert.equal(lo.failure, null);
  assert.equal(hi.failure.mode, "thermal");
});

test("lowest failure current picks the smaller of block and thermal", () => {
  const ff = findFailureCurrent(mk({ damage_temp_c: 92, duration_s: 0.5 }), ctx);
  assert.equal(ff.lowest.mode, "thermal");
  assert.ok(ff.modes[0].current_ka <= ff.modes[1].current_ka);
  const ff2 = findFailureCurrent(mk({ duration_s: 0.1 }), ctx);
  assert.ok(ff2.lowest.current_ka > 100);
  assert.ok(Math.abs(ff2.ratio_to_test - ff2.lowest.current_ka / 40) < 1e-12);
});

test("explicit closing angle is honoured and force vectors give the force magnitude", () => {
  const r = runLabTest(mk({ closing_angle_deg: 30 }), ctx);
  assert.ok(Math.abs(r.closing_angle_deg - 30) < 1e-9);
  const k = 20;
  const best = Math.max(...r.phase_idx.map((i) => Math.hypot(r.fx[i][k], r.fy[i][k])));
  assert.ok(Math.abs(best - r.force_envelope_n_per_m[k]) < 1e-6 * Math.max(1, best));
});

test("validation and grid cap", () => {
  assert.throws(() => runLabTest(mk({ test_ka: 0 }), ctx), /test current/);
  assert.throws(() => runLabTest(mk({ damage_temp_c: 50 }), ctx), /damage temperature/);
  assert.throws(() => labInput({ nope: 1 }), /unexpected/);
  const g = gridInfo(3, 60, 96);
  assert.ok(g.n_t <= 12001 && g.steps_per_cycle >= 24);
  assert.ok(staticDeflectionMm(2000, 0.9144, "750", "Cu") > 0);
});

test("4-tier layouts run", () => {
  const bus = { ...BUS, conductors_per_phase: 4, tiers: 4, pattern: "ABC/CAB/BCA/ABC", enclosure_width_mm: null, enclosure_height_mm: null };
  const L = labInput({ bus, test_ka: 40, duration_s: 0.1 });
  const c = buildContext(L.bus);
  const ys = new Set(c.phase_idx.map((i) => c.cs[i].y_mm));
  assert.equal(ys.size, 4);
  const r = runLabTest(L, c);
  assert.ok(Number.isFinite(r.peak_utilisation));
});

test("cable DC data is consistent: area lookup exists", () => {
  assert.ok(cond.AREA_CMIL["750"] > 0);
});
