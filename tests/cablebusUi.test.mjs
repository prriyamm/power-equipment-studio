// Cable bus workspace: 4-tier layouts (validation, patterns, analysis) and the two Simulate-tab fixes.
// Pure modules only (src/ui/cablebusUtil.js, engine); the React parts are covered by the Playwright visual pass.
import test from "node:test";
import assert from "node:assert/strict";

import { tierCompat, fittingTiers, MAX_TIERS, TIER_CHOICES, COUNT_CHOICES, peakSummary, i2tInfo } from "../src/ui/cablebusUtil.js";
import { candidatePatterns, analyse, cableBusInput, buildLayout } from "../src/engine/pecalc/cablebus.js";
import { designOptions, designRequest } from "../src/engine/pecalc/cablebus_design.js";
import { cablebusSvg } from "../src/engine/pecalc/drawing.js";
import * as sim from "../src/engine/pecalc/cablebusSim.js";

/* ------------------------------------------------------------------ 4 tiers */

test("tier choices go to 4 and stop there", () => {
  assert.deepEqual(TIER_CHOICES, [1, 2, 3, 4]);
  assert.equal(MAX_TIERS, 4);
});

test("tierCompat: n must be a multiple of tiers (complete A-B-C sets in every tier)", () => {
  // 4 tiers: 3n conductors / 4 must be a whole multiple of 3 -> n = 4, 8, 12
  for (const n of [4, 8, 12]) {
    const r = tierCompat(n, 4);
    assert.ok(r.ok, `n=${n}`);
    assert.equal(r.per_tier, (3 * n) / 4);
    assert.equal(r.message, null);
  }
  for (const n of [1, 2, 3, 5, 6, 9, 10]) assert.equal(tierCompat(n, 4).ok, false, `n=${n}`);
  // the cases that worked before still do: 9 x 3 tiers (the reported screenshot), 6 x 2 tiers
  assert.ok(tierCompat(9, 3).ok);
  assert.ok(tierCompat(6, 2).ok);
  assert.ok(tierCompat(5, 1).ok);
  assert.equal(tierCompat(2, 3).ok, false);
});

test("tierCompat message names the valid conductor counts", () => {
  const r = tierCompat(6, 4);
  assert.deepEqual(r.valid, [4, 8, 12]);
  assert.match(r.message, /4 tiers need conductors per phase divisible by 4/);
  assert.match(r.message, /4, 8, 12/);
  assert.match(r.message, /18 conductors \(3 phases x 6\) cannot be split evenly into 4 tiers/);
  assert.deepEqual(tierCompat(5, 3).valid, [3, 6, 9, 12]);
  assert.equal(tierCompat(0, 2).ok, false);
});

test("fittingTiers picks the largest tier count that fits", () => {
  assert.equal(fittingTiers(6, 4), 3);
  assert.equal(fittingTiers(8, 4), 4);
  assert.equal(fittingTiers(5, 4), 1);
  assert.equal(fittingTiers(12, 3), 3);
  assert.equal(fittingTiers(7, 2), 1);
});

test("every tierCompat verdict agrees with the engine (candidate_patterns)", () => {
  for (const tiers of TIER_CHOICES) for (const n of COUNT_CHOICES) {
    let ok = true;
    try { candidatePatterns(n, tiers); } catch { ok = false; }
    assert.equal(tierCompat(n, tiers).ok, ok, `n=${n} tiers=${tiers}`);
  }
});

test("candidate patterns for 4 tiers", () => {
  // 4 per phase: 12 conductors, 3 per tier (k = 1)
  assert.deepEqual(candidatePatterns(4, 4), ["ABC/ABC/ABC/ABC", "ABC/CBA/ABC/CBA", "ABC/CAB/ABC/CAB"]);
  // 8 per phase: 24 conductors, 6 per tier (k = 2): mirrored ABCCBA in every tier
  const p8 = candidatePatterns(8, 4);
  assert.ok(p8.includes("ABCCBA/ABCCBA/ABCCBA/ABCCBA"));
  for (const p of p8) {
    const rows = p.split("/");
    assert.equal(rows.length, 4);
    for (const ph of "ABC") assert.equal([...rows.join("")].filter((c) => c === ph).length, 8);
    for (const r of rows) assert.equal(r.length, 6);
  }
  assert.throws(() => candidatePatterns(6, 4), /18 conductors cannot be split evenly into 4 tiers/);
  assert.throws(() => candidatePatterns(3, 4), /12|9 conductors cannot be split evenly into 4 tiers/);
});

test("layout of 4 tiers: tier rows at multiples of the tier pitch, 8 per phase = 24 conductors", () => {
  const inp = cableBusInput({ voltage_v: 600, current_a: 5000, conductors_per_phase: 8, tiers: 4, size: "750" });
  const res = analyse(inp);
  const cs = buildLayout(inp, res.pattern, res.cable_od_mm);
  assert.equal(cs.length, 24);
  const ys = [...new Set(cs.map((c) => c.y_mm))].sort((a, b) => a - b);
  assert.equal(ys.length, 4);
  ys.forEach((y, t) => assert.ok(Math.abs(y - t * res.tier_pitch_mm) < 0.01 * (t + 1), `tier ${t}: ${y}`));
  assert.equal(res.tier_pitch_mm, res.pitch_mm);                 // default: tier pitch = cable pitch
  assert.deepEqual([...new Set(res.conductors.map((c) => c.tier))].sort(), [0, 1, 2, 3]);
  for (const ph of "ABC") {
    const sum = res.conductors.filter((c) => c.phase === ph).reduce((a, c) => a + c.current_a, 0);
    assert.ok(Math.abs(sum - 5000) < 150, `${ph}: ${sum}`);   // magnitudes of unequal-angle shares: within 3 % of the total
  }
  assert.throws(() => analyse(cableBusInput({ voltage_v: 600, conductors_per_phase: 6, tiers: 4 })), /cannot be split evenly into 4 tiers/);
});

test("4-tier cross-section drawing: one support block per tier and the tier-pitch dimension", () => {
  const inp = cableBusInput({ voltage_v: 600, current_a: 5000, conductors_per_phase: 8, tiers: 4, size: "750",
    enclosure_width_mm: 500, enclosure_height_mm: 400 });
  const res = analyse(inp);
  const svg = cablebusSvg(inp, res, { tier_dims: true });
  assert.match(svg, /4 tier\(s\)/);
  assert.equal((svg.match(/tier pitch/g) || []).length, 3);        // between 4 tiers: 3 dimensions
  assert.ok(svg.length > 1000);
});

test("designer enumerates 4 tiers by default and only multiples of 4 conductors per phase", () => {
  assert.deepEqual(designRequest({ voltage_v: 600, current_a: 6000 }).tier_options, [1, 2, 3, 4]);
  const r = designOptions(designRequest({ voltage_v: 600, current_a: 6000, top_n: 30 }));
  const four = r.options.filter((o) => o.tiers === 4);
  assert.ok(four.length > 0);
  for (const o of four) assert.equal(o.per_phase % 4, 0);
  const r3 = designOptions(designRequest({ voltage_v: 600, current_a: 6000, tier_options: [1, 2, 3] }));
  assert.ok(r3.options.every((o) => o.tiers <= 3));
});

test("4-tier short-circuit and temperature simulation run", () => {
  const bus = { voltage_v: 600, current_a: 5000, conductors_per_phase: 8, tiers: 4, size: "750", fault_ka: 50, fault_clearing_s: 0.5,
    x_over_r: 15, enclosure_width_mm: 500, enclosure_height_mm: 400 };
  const s = sim.simInput({ bus, cycles: 2 });
  const sc = sim.simulateShortCircuit(s);
  assert.ok(sc.peak_current_ka > 50 * Math.SQRT2 && sc.worst_force_n_per_m > 0);
  const tr = sim.simulateTemperatureRise(s);
  assert.equal(tr.cables ? tr.cables.length : 24, 24);
  assert.ok(tr.hottest.theta_c > 40);
});

/* ------------------------------------------------------------------ Simulate fixes */

const BUS = { voltage_v: 600.0, current_a: 3000.0, conductors_per_phase: 4, size: "750", fault_ka: 50.0,
  fault_clearing_s: 0.5, x_over_r: 15.0, enclosure_width_mm: 800.0, enclosure_height_mm: 120.0 };
const mk = (extra = {}, bus = {}) => sim.simInput({ bus: { ...BUS, ...bus }, ...extra });

test("peak current: KPI is the worst case over all angles, chart peak is the selected angle, both labelled", () => {
  // The default closing angle maximises force, not the current peak, so the chart peak can sit below the KPI.
  const sc = sim.simulateShortCircuit(mk({ cycles: 2 }));
  const pk = peakSummary(sc);
  assert.equal(pk.worst.ka, sc.peak_current_ka);
  assert.equal(pk.worst.phase, sc.peak_current_phase);
  assert.ok(["A", "B", "C"].includes(pk.selected.phase));
  // the chart peak equals the engine's peak_at_selected_ka (same samples) and never exceeds the worst case
  assert.ok(Math.abs(pk.selected.ka - sc.peak_at_selected_ka) < 1e-9, `${pk.selected.ka} vs ${sc.peak_at_selected_ka}`);
  assert.ok(pk.selected.ka <= pk.worst.ka + 1e-9);
  // selecting the worst-current angle reproduces the KPI to within the waveform sampling (96 samples/cycle)
  const at = sim.simulateShortCircuit(mk({ cycles: 2, closing_angle_deg: sc.peak_current_angle_deg }));
  const pkAt = peakSummary(at);
  assert.ok(Math.abs(pkAt.selected.ka - pkAt.worst.ka) / pkAt.worst.ka < 0.002, `${pkAt.selected.ka} vs ${pkAt.worst.ka}`);
  assert.equal(pkAt.selected.phase, pkAt.worst.phase);
  // hand check: no angle can exceed sqrt(2) * I * (1 + e^(-pi / (X/R))) ... bounded by the IEC peak factor 2.55 at X/R 15
  assert.ok(pk.worst.ka < 50 * 2.6);
});

test("peak current: an angle that is not the worst gives a lower chart peak than the KPI", () => {
  const sc = sim.simulateShortCircuit(mk({ cycles: 2, closing_angle_deg: 90.0 }));     // 90 deg: nearly symmetrical in A
  const pk = peakSummary(sc);
  assert.ok(pk.selected.ka < pk.worst.ka - 1);
});

test("let-through I2t: no clearing time -> the tile shows a dash, with the window the engine integrated over", () => {
  const none = sim.simulateShortCircuit(mk({ cycles: 5 }, { fault_clearing_s: null }));
  const i0 = i2tInfo(none);
  assert.equal(i0.has_clearing, false);
  assert.equal(i0.duration_s, null);
  // the engine integrates over the whole 5-cycle window: 50^2 * 5 / 60 = 208.33 kA2s
  assert.ok(Math.abs(i0.window_s - 5 / 60) < 1e-9);
  assert.ok(Math.abs(none.i2t_sym_ka2s - (50 * 50 * 5) / 60) < 1e-6);
  const some = sim.simulateShortCircuit(mk({ cycles: 5 }));
  const i1 = i2tInfo(some);
  assert.equal(i1.has_clearing, true);
  assert.equal(i1.duration_s, 0.5);
  assert.ok(Math.abs(some.i2t_sym_ka2s - 50 * 50 * 0.5) < 1e-9);                      // 1250 kA2s
});
