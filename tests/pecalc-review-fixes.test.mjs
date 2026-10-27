// Ports of calculations/tests/test_review_fixes.py (pecalc PR #10) and the pecalc PR #9 cable bus tests
// (CableBusVoltageDrop, DatasheetShieldDerating in test_engine.py). Each expected value is derived by hand in
// the comment next to it, as in the Python suite. Code-table values are the repository's UNVERIFIED data.
import test from "node:test";
import assert from "node:assert/strict";

import * as amp from "../src/engine/pecalc/ampacity.js";
import * as cb from "../src/engine/pecalc/cablebus.js";
import * as frc from "../src/engine/pecalc/forces.js";
import * as imp from "../src/engine/pecalc/impedance.js";
import * as sw from "../src/engine/pecalc/switchgear.js";
import * as thm from "../src/engine/pecalc/thermal.js";
import * as T from "../src/engine/pecalc/transformer.js";
import * as validate from "../src/engine/pecalc/validate.js";
import * as rxd from "../src/engine/reactanceDerived.js";
import { feederInput, sizeFeeder, evaluate, smallConductorLimitA } from "../src/engine/pecalc/sizing.js";
import SMALL from "../src/engine/pecalc/data/nec_240_4d_small_conductors.json" with { type: "json" };

const near = (a, b, delta, msg = "") => assert.ok(Math.abs(a - b) <= delta, `${msg} ${a} vs ${b} (delta ${delta})`);
const feeder = (kw) => sizeFeeder(feederInput(kw));

// ------------------------------------------------------------------ Fix 1: NEC 240.4(D)
test("240.4(D): data is UNVERIFIED with the expected limits", () => {
  assert.equal(SMALL._meta.status, "UNVERIFIED");
  assert.match(SMALL._meta.note, /memory/);
  assert.deepEqual(SMALL.Cu, { 18: 7, 16: 10, 14: 15, 12: 20, 10: 30 });
  assert.deepEqual(SMALL.Al, { 12: 15, 10: 25 });
  assert.equal(smallConductorLimitA("Al", "8"), null);
  assert.equal(smallConductorLimitA("Cu", "8"), null);
  assert.equal(smallConductorLimitA("Cu", "#14"), 15);
});

test("240.4(D): 20 A at a 75 C terminal needs 12 AWG Cu, not 14", () => {
  // 14 Cu 75 C column = 20 A passes 110.14(C), but its 240.4(D) limit is 15 A < 20 A minimum device.
  const r = feeder({ noncontinuous_a: 20, terminal_temp_c: 75, length_m: 5 });
  assert.deepEqual([r.recommended.sets, r.recommended.size], [1, "12"]);
  const d = evaluate(r.input, "14", 1).checks.find((c) => c.clause === "NEC 240.4(D) [data UNVERIFIED]");
  assert.equal(d.passed, false);
  assert.deepEqual([d.value, d.limit], [20.0, 15.0]);
});

test("240.4(D): 16 A continuous needs 12 AWG Cu; 20 A Al needs 10 AWG Al", () => {
  // 16 A continuous: minimum device 1.25 x 16 = 20 A > 14 Cu limit 15 A.
  assert.equal(feeder({ continuous_a: 16, terminal_temp_c: 75, length_m: 5 }).recommended.size, "12");
  // 12 Al 75 C column 20 A passes, but 240.4(D) 12 Al = 15 A < 20 A; 10 Al limit 25 A.
  assert.equal(feeder({ noncontinuous_a: 20, terminal_temp_c: 75, length_m: 5, material: "Al" }).recommended.size, "10");
});

// ------------------------------------------------------------------ Fix 2: 110.14(C) in free air
test("110.14(C): 400 A continuous in free air uses Table 310.16 at the terminal", () => {
  // 1.25 x 400 = 500 A at the 75 C column of Table 310.16: 2 sets -> 250 A/set, 2/0 (175 A) fails, 250 kcmil passes;
  // 3 sets -> 166.7 A/set, 2/0 passes with the least total area. (Table 310.17 2/0 = 265 A gave 2 x 2/0 before.)
  const r = feeder({ continuous_a: 400, installation: "free_air", length_m: 5 });
  assert.deepEqual([r.recommended.sets, r.recommended.size], [3, "2/0"]);
  const bySets = Object.fromEntries([r.recommended, ...r.alternatives].map((o) => [o.sets, o.size]));
  assert.equal(bySets[2], "250");
  const term = evaluate(r.input, "2/0", 2).checks[1];
  assert.match(term.note, /Table 310\.16/);
  assert.deepEqual([term.value, term.limit, term.passed], [175.0, 250.0, false]);
  // Conductor ampacity still from Table 310.17: 2/0 Cu 90 C free air, allowable = min(300, 175) = 175 A.
  const derated = r.recommended.checks.find((c) => c.name === "Derated ampacity >= load");
  assert.equal(derated.value, amp.tableAmpacity("NEC", "free_air", "Cu", "2/0", 90));
  assert.equal(r.recommended.ampacity_per_set_a, 175.0);
});

// ------------------------------------------------------------------ Fix 3: DOE test point
function checkDoe(r, load, temp) {
  // eff = S L / (S L + NLL + LL_T L^2), LL_T = LL (234.5 + T) / (234.5 + Tref) (Cu windings).
  const s = r.input.kva * 1000;
  const { no_load_w: nll, load_loss_w: ll, reference_temp_c: tref } = r.losses;
  const llT = (ll * (234.5 + temp)) / (234.5 + tref);
  assert.equal(r.performance.doe_point.load, load);
  near(r.performance.doe_point.efficiency_pct, ((s * load) / (s * load + nll + llT * load ** 2)) * 100, 0.002);
}

test("DOE: class and test load from the primary (HV) voltage", () => {
  checkDoe(T.design(T.transformerInput({ kind: "liquid", hv_v: 13800, lv_v: 480, kva: 1500 })), 0.5, 55.0);
  // 13.8 kV primary > 600 V -> medium-voltage dry-type, 50 % (old code: 35 % from the 480 V LV side).
  checkDoe(T.design(T.transformerInput({ kind: "dry", hv_v: 13800, lv_v: 480, kva: 1500 })), 0.5, 75.0);
  checkDoe(T.design(T.transformerInput({ kind: "dry", hv_v: 480, lv_v: 208, kva: 75 })), 0.35, 75.0);
  assert.deepEqual(T.doeTestPoint("dry", 600), ["low-voltage dry-type", 0.35]);
  assert.deepEqual(T.doeTestPoint("dry", 601), ["medium-voltage dry-type", 0.5]);
  assert.deepEqual(T.doeTestPoint("liquid", 480), ["liquid-immersed", 0.5]);
});

// ------------------------------------------------------------------ Fix 4: phasor source impedance
test("transformer: source and transformer impedance added as phasors", () => {
  // 1500 kVA on a 50 MVA source: |Zs| = 0.03 pu; X/R = 1 -> 0.03 / sqrt(2) (1 + j).
  const z = T.sourceImpedancePu(1500, 50, 1.0);
  near(z.re, 0.03 / Math.SQRT2, 1e-12);
  near(z.im, 0.03 / Math.SQRT2, 1e-12);
  assert.deepEqual(T.sourceImpedancePu(1500, null, 10.0), { re: 0, im: 0 });

  const r = T.design(T.transformerInput({ kva: 1500, hv_v: 13800, lv_v: 480, source_mva: 50, source_x_over_r: 1.0 }));
  const rp = r.impedance.r_pct / 100, xp = r.impedance.x_pct / 100, zs = 0.03 / Math.SQRT2;
  const iFl = 1.5e6 / (Math.sqrt(3) * 480);
  const phasor = iFl / Math.hypot(rp + zs, xp + zs) / 1000;
  const magnitude = iFl / (Math.hypot(rp, xp) + 0.03) / 1000; // old magnitude sum, ~4 % low
  near(r.short_circuit.lv_fault_ka_rms, phasor, 0.03);
  assert.ok(r.short_circuit.lv_fault_ka_rms - magnitude > 0.8);
  near(r.short_circuit.total_x_over_r, (xp + zs) / (rp + zs), 0.02);

  const inf = T.design(T.transformerInput({ kva: 1500, hv_v: 13800, lv_v: 480 }));
  near(inf.short_circuit.lv_fault_ka_rms, iFl / (inf.impedance.z_pct / 100) / 1000, 0.05);
});

// ------------------------------------------------------------------ Fix 5: derived Table 9 (shared module)
test("derived Table 9: values match pecalc reactance_derived (hand values)", () => {
  // PVC 900 = 0.038 - 0.6338 x 0.001 = 0.0374; PVC 2000 = 0.038 - 3.4094 x 0.001 = 0.0346;
  // steel 900 = 0.048 - 0.6338 x 0.002 = 0.0467; steel 2000 = 0.0412; PVC 700 = 0.039 - 0.6908 x 0.001 = 0.0383.
  const expect = [["pvc", "900", 0.0374], ["pvc", "2000", 0.0346], ["steel", "900", 0.0467], ["steel", "2000", 0.0412],
    ["pvc", "700", 0.0383], ["aluminum", "900", 0.0374]];
  for (const [rw, s, x] of expect) assert.deepEqual(rxd.reactancePer1000ft(s, rw), { xl: x, derived: true }, `${rw} ${s}`);
  assert.deepEqual(rxd.reactancePer1000ft("750", "pvc"), { xl: 0.038, derived: false });
  // Floor at 2000 kcmil (touching trefoil) = 0.0242 ohm/1000 ft, below 0.0346, so not binding.
  near(rxd.reactanceFloorPer1000ft("2000"), 0.0242, 0.00005);
});

test("derived Table 9: feeder sizing uses the derived value and warns", () => {
  // 900 kcmil in steel: X = 0.0467 / 0.3048 = 0.1532 ohm/km (old fallback 0.0814 ohm/km, 47 % low).
  const inp = feederInput({ continuous_a: 400, length_m: 100, conduit: "steel", terminal_temp_c: 75, sets: 1 });
  const o = evaluate(inp, "900", 1);
  near(o.x_ohm_per_km, 0.0467 / 0.3048, 0.0005);
  assert.match(o.checks.at(-1).note, /DERIVED/);
  // 1.25 x 330 = 412.5 A: 600 kcmil (420 A), in Table 9 -> no warning.
  let r = feeder({ continuous_a: 330, length_m: 10, conduit: "pvc", sets: 1, terminal_temp_c: 75 });
  assert.equal(r.recommended.size, "600");
  assert.ok(!r.notes.some((n) => n.includes("DERIVED")));
  // 1.25 x 360 = 450 A: 600 kcmil fails, 700 kcmil (460 A) passes -> derived reactance warning.
  r = feeder({ continuous_a: 360, length_m: 10, conduit: "pvc", sets: 1, terminal_temp_c: 75 });
  assert.equal(r.recommended.size, "700");
  assert.ok(r.notes.some((n) => n.includes("DERIVED")));
});

// ------------------------------------------------------------------ Fix 6: input validation
test("validation: feeder, transformer, bus, forces, sharing and thermal reject bad inputs", () => {
  for (const bad of [{ voltage_v: 0 }, { voltage_v: -480 }, { power_factor: 0 }, { power_factor: 1.2 },
    { power_factor: -0.9 }, { fault_ka: 30, fault_clearing_s: -0.1 }, { fault_ka: 30, fault_clearing_s: 0 }]) {
    assert.throws(() => feeder({ continuous_a: 100, ...bad }), Error, JSON.stringify(bad));
  }
  for (const bad of [{ hv_v: 0 }, { lv_v: -480 }, { power_factor: 0 }, { power_factor: 1.5 }, { fault_duration_s: -1 },
    { source_x_over_r: 0 }, { source_mva: 50, source_x_over_r: -3 }]) {
    assert.throws(() => T.design(T.transformerInput(bad)), Error, JSON.stringify(bad));
  }
  const cases = [
    () => sw.analyseBus(sw.busInput({ voltage_v: 0 })),
    () => sw.analyseBus(sw.busInput({ fault_ka: 50, x_over_r: 0 })),
    () => frc.peakFactor(-1),
    () => imp.balancedThreePhase(100, 0),
    () => imp.balancedThreePhase(100, 1.01),
    () => thm.freeAirAmpacity(thm.cableConstruction("500", { voltage_v: 0 })),
  ];
  cases.forEach((f, i) => assert.throws(f, Error, `case ${i}`));
  assert.throws(() => feeder({ continuous_a: 100, power_factor: 1.2 }), /power_factor must be in the range \(0, 1\]/);
  assert.throws(() => feeder({ continuous_a: 100, voltage_v: 0 }), { message: "voltage_v must be greater than 0 V, got 0.0" });
});

test("validation: messages quote the value as Python repr of a float", () => {
  assert.equal(validate.reprValue(0), "0.0");
  assert.equal(validate.reprValue(-480), "-480.0");
  assert.equal(validate.reprValue(1.2), "1.2");
  assert.equal(validate.reprValue(Infinity), "inf");
  assert.equal(validate.reprValue(NaN), "nan");
  assert.equal(validate.reprValue("abc"), "'abc'");
  assert.equal(validate.reprValue(null), "None");
  assert.throws(() => validate.voltage("v", NaN), { message: "v must be finite, got nan" });
  assert.throws(() => validate.voltage("v", "abc"), { message: "v must be a number, got 'abc'" });
  assert.equal(validate.voltage("v", "480"), 480);
});

// ------------------------------------------------------------------ Fix 7: 8 AWG Al 60 C
// Changed with the pecalc data check: the printed NFPA 70-2023 Table 310.16 (p. 70-187) gives 8 AWG Al
// 60 / 75 / 90 C = 35 / 40 / 45 A. The earlier 30 A came from secondary sources that follow older editions.
// Status stays UNVERIFIED (the check is not an engineer verification).
test("Table 310.16: 8 AWG Al row 35 / 40 / 45 A (printed NFPA 70-2023 p. 70-187); 33 A Al at 60 C keeps 8 AWG, 36 A needs 6 AWG", () => {
  assert.deepEqual([60, 75, 90].map((t) => amp.tableAmpacity("NEC", "raceway", "Al", "8", t)), [35.0, 40.0, 45.0]);
  assert.equal(amp.tableInfo("NEC", "raceway").status, "UNVERIFIED");
  assert.equal(feeder({ noncontinuous_a: 33, material: "Al", terminal_temp_c: 60, length_m: 5 }).recommended.size, "8");
  assert.equal(feeder({ noncontinuous_a: 36, material: "Al", terminal_temp_c: 60, length_m: 5 }).recommended.size, "6");
});

// ------------------------------------------------------------------ Fix 8: EPR resistivity by rated voltage
test("EPR thermal resistivity follows the cable's rated voltage", () => {
  assert.equal(thm.insulationResistivity("EPR", 600), 3.5);
  assert.equal(thm.insulationResistivity("EPR", 3000), 3.5);
  assert.equal(thm.insulationResistivity("EPR", 15000), 5.0);
  assert.equal(thm.insulationResistivity("XLPE", 15000), 3.5);
  // 500 kcmil, 1.65 mm wall: T1 = 3.5 / (2 pi) x ln(1 + 3.30 / 20.650) = 0.08258 K m/W at 0.6 kV (was 0.11797);
  // 15 kV, 4.45 mm wall: T1 = 5.0 / (2 pi) x ln(1 + 8.90 / 20.650) = 0.28518 (unchanged).
  const lv = thm.freeAirAmpacity(thm.cableConstruction("500", { insulation: "EPR", insulation_mm: 1.65, voltage_v: 600 }),
    40, { installation: "trefoil_touching" });
  const mv = thm.freeAirAmpacity(thm.cableConstruction("500", { insulation: "EPR", insulation_mm: 4.45, voltage_v: 15000,
    jacket_mm: 2.0 }), 40, { installation: "trefoil_touching" });
  near(lv.t1, 0.08258, 5e-6);
  near(mv.t1, 0.28518, 5e-6);
  const old = thm.freeAirAmpacity(thm.cableConstruction("500", { insulation: "EPR", insulation_mm: 1.65, voltage_v: 600,
    rated_voltage_v: 15000 }), 40, { installation: "trefoil_touching" });
  assert.ok(lv.ampacity_a > old.ampacity_a);
  near(old.t1, 0.11797, 5e-6);
});

// ------------------------------------------------------------------ pecalc #9: phase-invariant voltage drop
test("cable bus VD: hand check, balanced trefoil", () => {
  // Trefoil s = 100 mm, GMR 10 mm, R = 0.05 ohm/km, 480 V, 1000 A at pf 0.8 lagging, 60 m:
  //   X = 2 pi 60 x 2e-7 x ln(10) = 1.73611e-4 ohm/m; dV = (800 - j600)(5e-5 + j1.73611e-4) x 60 = 8.6500 + j6.5333 V
  //   Vs = 277.128 V; |Vs - dV| = 268.558 V -> exact 3.0926 %; approx 8.6500 / 277.128 = 3.1213 %. Same on every phase.
  const h = (100 * Math.sqrt(3)) / 2;
  const cs = [[0, 0, "A"], [100, 0, "B"], [50, h, "C"]].map(([x_mm, y_mm, group]) =>
    imp.conductor({ x_mm, y_mm, group, r_ohm_per_m: 5e-5, gmr_mm: 10 }));
  const res = imp.solveSharing(cs, imp.balancedThreePhase(1000, 0.8));
  const vd = cb.phaseVoltageDrops(res, 480, 0.8, 60);
  for (const p of ["A", "B", "C"]) {
    near(vd[p][0], 3.0926, 5e-4, `${p} exact`);
    near(vd[p][1], 3.1213, 5e-4, `${p} approx`);
  }
});

test("cable bus VD: invariant to phase labelling (also with shields bonded both ends)", () => {
  // Before the fix, flat ABC / BCA / CAB gave 4.29 / 2.14 / 2.94 %.
  for (const [kw, patterns] of [[{ current_a: 600, conductors_per_phase: 1, length_m: 150 }, ["ABC", "BCA", "CAB"]],
    [{ current_a: 1200, conductors_per_phase: 2, length_m: 100 }, ["ABCCBA", "BCAACB", "CABBAC"]]]) {
    const vds = patterns.map((pattern) => cb.analyse(cb.cableBusInput({ voltage_v: 600, size: "750", pattern, ...kw })).vd_pct);
    for (const v of vds.slice(1)) near(v, vds[0], 1e-6);
  }
  near(cb.analyse(cb.cableBusInput({ voltage_v: 600, size: "750", pattern: "BCA", current_a: 600, conductors_per_phase: 1,
    length_m: 150 })).vd_pct, 4.292, 0.005);
  const base = { voltage_v: 15000, current_a: 2000, conductors_per_phase: 2, size: "750", cable_od_mm: 45,
    cable_ampacity_a: 900, shield_area_mm2: 16, shield_mean_diameter_mm: 38, shield_bonding: "both_ends" };
  const vds = ["ABCCBA", "BCAACB", "CABBAC"].map((pattern) => cb.analyse(cb.cableBusInput({ ...base, pattern })).vd_pct);
  near(vds[1], vds[0], 1e-6);
  near(vds[2], vds[0], 1e-6);
  const r = cb.analyse(cb.cableBusInput({ ...base, pattern: "ABCCBA" }));
  assert.match(r.checks.find((c) => c.name === "Voltage drop (worst phase)").note, /^phase [ABC], each phase against/);
  assert.ok(r.notes.some((n) => n.startsWith("Voltage drop by phase, exact / approximate")));
});

// ------------------------------------------------------------------ pecalc #9: datasheet shield derating
const DS = { voltage_v: 15000, current_a: 2000, conductors_per_phase: 3, size: "750", cable_od_mm: 45,
  cable_ampacity_a: 900, shield_area_mm2: 16, shield_mean_diameter_mm: 38 };

test("datasheet shield derating: factor hand values", () => {
  const k = cb.datasheetShieldDerating;
  assert.equal(k(0.0, 0.0), 1.0);
  near(k(0.21, 0.0), 1 / 1.1, 1e-9);                  // sqrt(1 / 1.21)
  near(k(0.21, 0.1), Math.sqrt(1.1 / 1.21), 1e-9);    // 0.95346
  assert.equal(k(0.0, 0.2), 1.0);                     // never raises a datasheet rating
  assert.throws(() => k(-0.1), { message: "Shield loss factors lambda1 must be >= 0" });
});

test("datasheet shield derating: single-point not derated; both ends derated by own lambda1", () => {
  const sp = cb.analyse(cb.cableBusInput({ ...DS, shield_bonding: "single_point" }));
  assert.ok(sp.conductors.every((c) => c.ampacity_a === 900.0));
  assert.ok(!sp.ampacity_basis.includes("shield derating"));
  // The PR #9 table was solved for the flat row ABCCBAABC (the old auto pick; not a CSA 273 Figure 3 arrangement).
  const r = cb.analyse(cb.cableBusInput({ ...DS, shield_bonding: "both_ends", pattern: "ABCCBAABC" }));
  assert.ok(Math.max(...r.conductors.map((c) => c.ampacity_a)) < 900.0);
  const lam = Number(r.ampacity_basis.split("lambda1 ")[1].split(" ")[0]);
  const worst = r.conductors.reduce((m, c) => (c.loading_pct > m.loading_pct ? c : m));
  near(worst.ampacity_a, 900 * cb.datasheetShieldDerating(lam), 0.2);
  assert.ok(r.notes.some((n) => n.startsWith("WARNING: shield circulating current")));
  // PR #9 table: 749.9 A / 92.1 % with both ends bonded.
  near(Math.min(...r.conductors.map((c) => c.ampacity_a)), 749.9, 0.05);
  near(r.max_loading_pct, 92.1, 0.05);
  const same = cb.analyse(cb.cableBusInput({ ...DS, shield_bonding: "both_ends", cable_ampacity_lambda1_ref: 10.0 }));
  assert.ok(same.conductors.every((c) => c.ampacity_a === 900.0));
});

// ------------------------------------------------------------------ cable bus voltage validation (pecalc PR #11)
test("cable bus: analyse rejects voltage <= 0 or non-finite (validate.voltage)", () => {
  for (const v of [0, -600, NaN, Infinity]) {
    assert.throws(() => cb.analyse(cb.cableBusInput({ voltage_v: v })), /voltage_v must be/, `voltage_v=${v}`);
  }
  assert.throws(() => cb.analyse(cb.cableBusInput({ voltage_v: 0 })), { message: "voltage_v must be greater than 0 V, got 0.0" });
  assert.throws(() => cb.analyse(cb.cableBusInput({ voltage_v: NaN })), { message: "voltage_v must be finite, got nan" });
});
