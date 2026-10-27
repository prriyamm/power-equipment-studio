// Cable bus workspace: CSA 273 Figure 3 tier and arrangement choices, multi-tier and staggered layouts, and the two
// Simulate-tab fixes. Pure modules only (src/ui/cablebusUtil.js, engine); the React parts are covered by the
// Playwright visual pass.
import test from "node:test";
import assert from "node:assert/strict";

import { tierCompat, fittingTiers, figure3Tiers, arrangementChoices, layoutEnvelope, MAX_TIERS, TIER_CHOICES,
  COUNT_CHOICES, peakSummary, i2tInfo } from "../src/ui/cablebusUtil.js";
import { candidatePatterns, analyse, cableBusInput, buildLayout } from "../src/engine/pecalc/cablebus.js";
import { designOptions, designRequest } from "../src/engine/pecalc/cablebus_design.js";
import { cablebusSvg } from "../src/engine/pecalc/drawing.js";
import * as sim from "../src/engine/pecalc/cablebusSim.js";

/* ------------------------------------------------------------------ Figure 3 tiers */

test("tier and count choices follow Figure 3: 1 to 10 per phase, at most 3 tiers", () => {
  assert.deepEqual(TIER_CHOICES, [1, 2, 3]);
  assert.equal(MAX_TIERS, 3);
  assert.deepEqual(COUNT_CHOICES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(figure3Tiers(1), [1, 2]);
  assert.deepEqual(figure3Tiers(2), [2]);
  assert.deepEqual(figure3Tiers(3), [2, 3]);
  assert.deepEqual(figure3Tiers(11), []);
});

test("tierCompat: Figure 3 must have the tier count for n per phase", () => {
  assert.ok(tierCompat(3, null).ok);                 // any tier count
  assert.ok(tierCompat(9, 3).ok);
  assert.ok(tierCompat(6, 2).ok);
  assert.ok(tierCompat(1, 1).ok);
  assert.equal(tierCompat(3, 1).ok, false);
  assert.match(tierCompat(3, 1).message, /no 1-tier arrangement for 3 per phase \(it has 2 or 3 tiers\)/);
  assert.deepEqual(tierCompat(3, 1).valid, [1]);
  assert.deepEqual(tierCompat(5, 3).valid, [1, 3, 4, 5, 6, 7, 8, 9, 10].filter((n) => figure3Tiers(n).includes(3)));
  assert.equal(tierCompat(2, 3).ok, false);
  assert.equal(tierCompat(0, 2).ok, false);
  assert.equal(tierCompat(12, null).ok, false);
});

test("fittingTiers picks the largest Figure 3 tier count that fits, else any", () => {
  assert.equal(fittingTiers(6, 3), 3);
  assert.equal(fittingTiers(6, 2), 2);
  assert.equal(fittingTiers(3, 1), null);
  assert.equal(fittingTiers(1, 3), 2);
  assert.equal(fittingTiers(2, null), 2);
});

test("every tierCompat verdict agrees with the engine (candidate_patterns)", () => {
  for (const tiers of [null, ...TIER_CHOICES, 4]) for (const n of [...COUNT_CHOICES, 11]) {
    let ok = true;
    try { candidatePatterns(n, tiers); } catch { ok = false; }
    assert.equal(tierCompat(n, tiers).ok, ok, `n=${n} tiers=${tiers}`);
  }
});

test("arrangement choices: best first, then the Figure 3 arrangements in figure order", () => {
  const all = arrangementChoices(3, null);
  assert.deepEqual(all[0], ["auto", "Best (Figure 3)"]);
  assert.deepEqual(all.slice(1).map(([p]) => p), candidatePatterns(3));
  assert.equal(all[2][1], "3-2 · +ABCA/BCABC");
  assert.deepEqual(arrangementChoices(3, 3).slice(1).map(([p]) => p), ["ACA/BBB/CAC", "+ABC/BCA./+ABC"]);
});

test("layout envelope for the enclosure auto-size", () => {
  assert.deepEqual(layoutEnvelope(3, 3), { span: 2.5, tiers: 3 });       // ACA/BBB/CAC and +ABC/BCA./+ABC
  assert.deepEqual(layoutEnvelope(3, null, "ABCAB/CABC."), { span: 4, tiers: 2 });
  assert.deepEqual(layoutEnvelope(1, null), { span: 2, tiers: 2 });
});

/* ------------------------------------------------------------------ multi-tier layouts */

test("3-tier layout: tier rows at multiples of the tier pitch, staggered tiers half a pitch over", () => {
  const inp = cableBusInput({ voltage_v: 600, current_a: 4000, conductors_per_phase: 8, size: "750",
    pattern: "+.BCABCABC/.CABCABCA/+ABCABCAB." });
  const res = analyse(inp);
  const cs = buildLayout(inp, res.pattern, res.cable_od_mm);
  assert.equal(cs.length, 24);
  const ys = [...new Set(cs.map((c) => c.y_mm))].sort((a, b) => a - b);
  assert.equal(ys.length, 3);
  ys.forEach((y, t) => assert.ok(Math.abs(y - t * res.tier_pitch_mm) < 0.01 * (t + 1), `tier ${t}: ${y}`));
  assert.equal(res.tier_pitch_mm, res.pitch_mm);                 // default: tier pitch = cable pitch
  const minX = (t) => Math.min(...res.conductors.filter((c) => c.tier === t).map((c) => c.x_mm));
  // x starts at the bottom tier's A ('+', 0.5 pitch); the upper tiers each begin with an unused position.
  assert.ok(Math.abs(minX(0) - res.pitch_mm) < 0.1);             // '+' and '.': 1.5 - 0.5
  assert.ok(Math.abs(minX(1) - 0.5 * res.pitch_mm) < 0.1);       // '.': 1 - 0.5
  assert.ok(Math.abs(minX(2)) < 0.1);
  assert.ok(res.checks.find((c) => c.name.startsWith("Phase arrangement")).passed);
  for (const ph of "ABC") {
    const sum = res.conductors.filter((c) => c.phase === ph).reduce((a, c) => a + c.current_a, 0);
    assert.ok(Math.abs(sum - 4000) < 150, `${ph}: ${sum}`);   // magnitudes of unequal-angle shares: within 3 % of the total
  }
  assert.throws(() => analyse(cableBusInput({ voltage_v: 600, conductors_per_phase: 6, tiers: 4 })),
    /no arrangement of 6 conductors per phase in 4 tier/);
});

test("3-tier cross-section drawing: one support block per tier and the tier-pitch dimension", () => {
  const inp = cableBusInput({ voltage_v: 600, current_a: 4000, conductors_per_phase: 8, tiers: 3, size: "750",
    enclosure_width_mm: 700, enclosure_height_mm: 400 });
  const res = analyse(inp);
  const svg = cablebusSvg(inp, res, { tier_dims: true });
  assert.match(svg, /3 tier\(s\)/);
  assert.equal((svg.match(/tier pitch/g) || []).length, 2);        // between 3 tiers: 2 dimensions
  assert.ok(svg.length > 1000);
});

test("designer offers only Figure 3 tier counts", () => {
  assert.deepEqual(designRequest({ voltage_v: 600, current_a: 4000 }).tier_options, [1, 2, 3, 4]);
  const r = designOptions(designRequest({ voltage_v: 600, current_a: 4000, top_n: 30 }));
  assert.ok(r.options.length > 0);
  assert.ok(r.options.every((o) => o.tiers === 2 || o.tiers === 3));
  const r4 = designOptions(designRequest({ voltage_v: 600, current_a: 4000, tier_options: [4] }));
  assert.equal(r4.options.length, 0);
});

test("4-tier user pattern (outside Figure 3): short-circuit and temperature simulation still run", () => {
  const bus = { voltage_v: 600, current_a: 5000, conductors_per_phase: 8, size: "750", fault_ka: 50, fault_clearing_s: 0.5,
    x_over_r: 15, enclosure_width_mm: 500, enclosure_height_mm: 400, pattern: "ABCCBA/ABCCBA/ABCCBA/ABCCBA" };
  const s = sim.simInput({ bus, cycles: 2 });
  const sc = sim.simulateShortCircuit(s);
  assert.ok(sc.peak_current_ka > 50 * Math.SQRT2 && sc.worst_force_n_per_m > 0);
  const tr = sim.simulateTemperatureRise(s);
  assert.equal(tr.cables ? tr.cables.length : 24, 24);
  assert.ok(tr.hottest.theta_c > 40);
});
/* ------------------------------------------------------------------ Simulate fixes */

const BUS = { voltage_v: 600.0, current_a: 3000.0, conductors_per_phase: 4, size: "750", fault_ka: 50.0,
  fault_clearing_s: 0.5, x_over_r: 15.0, enclosure_width_mm: 800.0, enclosure_height_mm: 120.0,
  pattern: "ABCABC/CABCAB" }; // CSA 273 Figure 3 arrangement 4-1 (asymmetric: one worst cable)
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
