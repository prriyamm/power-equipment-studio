// Tests for the pecalc core port (conductors, ampacity, impedance, forces, field, thermal).
//
// Part 1 replays tests/golden/core.json, vectors generated from the Python pecalc package by
// scripts/gen_golden_core.py, through the JS port. Part 2 ports the named-reference tests of
// calculations/tests/test_engine.py that cover these modules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as cond from "../src/engine/pecalc/conductors.js";
import * as amp from "../src/engine/pecalc/ampacity.js";
import * as imp from "../src/engine/pecalc/impedance.js";
import * as frc from "../src/engine/pecalc/forces.js";
import * as fld from "../src/engine/pecalc/field.js";
import * as thm from "../src/engine/pecalc/thermal.js";
import * as validate from "../src/engine/pecalc/validate.js";
import * as rxd from "../src/engine/reactanceDerived.js";
import { cabs, cdiv } from "../src/engine/pecalc/util.js";

const golden = JSON.parse(readFileSync(new URL("./golden/core.json", import.meta.url), "utf8"));
const V = golden.vectors;

// ---------------------------------------------------------------- comparison
const TOL = 1e-9; // relative tolerance required by CLAUDE.md for direct (non-iterative) calculations
// The thermal T4 surface-temperature loop is iterative, so thermal results use 1e-6 instead.
const TOL_ITERATIVE = 1e-6;
// Absolute floor, used only when Python's value is exactly 0 (a cancelling sum may leave rounding dust in JS).
// Complex components are otherwise compared relative to the phasor magnitude.
const ATOL = 1e-12;

function dec(x) {
  if (Array.isArray(x)) return x.map(dec);
  if (x && typeof x === "object") {
    if ("__c" in x) return { re: dec(x.__c[0]), im: dec(x.__c[1]) };
    if ("__f" in x) return x.__f === "nan" ? NaN : x.__f === "inf" ? Infinity : -Infinity;
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, dec(v)]));
  }
  return x;
}

function near(a, e, tol, path, scale = 0, floor = 0) {
  if (Number.isNaN(e)) return assert.ok(Number.isNaN(a), `${path}: expected NaN, got ${a}`);
  if (!Number.isFinite(e)) return assert.equal(a, e, `${path}`);
  const diff = Math.abs(a - e);
  const lim = tol * Math.max(Math.abs(e), Math.abs(a), scale) + floor;
  const ok = diff <= lim || (e === 0 && Math.abs(a) < ATOL);
  assert.ok(ok, `${path}: got ${a}, expected ${e} (rel diff ${diff / Math.max(Math.abs(e), 1e-300)})`);
}

function cmp(a, e, tol, path = "$", floor = 0) {
  if (e === null) return assert.equal(a, null, `${path}: expected null`);
  if (typeof e === "number") {
    assert.equal(typeof a, "number", `${path}: expected number, got ${JSON.stringify(a)}`);
    return near(a, e, tol, path, 0, floor);
  }
  if (typeof e === "string" || typeof e === "boolean") return assert.equal(a, e, path);
  if (Array.isArray(e)) {
    assert.ok(Array.isArray(a), `${path}: expected array`);
    assert.equal(a.length, e.length, `${path}: length`);
    return e.forEach((v, i) => cmp(a[i], v, tol, `${path}[${i}]`, floor));
  }
  if ("re" in e && "im" in e && Object.keys(e).length === 2) {
    const z = typeof a === "number" ? { re: a, im: 0 } : a;
    const s = Math.hypot(e.re, e.im); // compare each component relative to the phasor magnitude
    near(z.re, e.re, tol, `${path}.re`, s, floor);
    return near(z.im, e.im, tol, `${path}.im`, s, floor);
  }
  assert.ok(a && typeof a === "object", `${path}: expected object`);
  for (const k of Object.keys(e)) cmp(a[k], e[k], tol, `${path}.${k}`, floor); // subset: golden lists the fields it checks
}

// ------------------------------------------------------------------ builders
const mkConds = (lst) => lst.map((d) => imp.conductor(d));
const mkGroups = (g) => Object.fromEntries(Object.entries(g).map(([n, v]) => [n, imp.group(n, v.kind, v.current)]));
const mkCable = (c) => { const { size, ...rest } = c; return thm.cableConstruction(size, rest); };

// Each entry maps a golden function name to (input) -> output, tolerance, and optional output reshaping.
const DISPATCH = {
  normalize_size: (i) => cond.normalizeSize(i.size),
  size_label: (i) => cond.sizeLabel(i.size),
  size_index: (i) => cond.sizeIndex(i.size),
  area_mm2: (i) => cond.areaMm2(i.size),
  diameter_mm: (i) => cond.diameterMm(i.size),
  insulation_mm: (i) => cond.insulationMm(i.size),
  cable_od_mm: (i) => cond.cableOdMm(i.size),
  gmr_mm: (i) => cond.gmrMm(i.size),
  rdc_ohm_per_m: (i) => cond.rdcOhmPerM(i.size, i.material, i.temp_c),
  rac_ohm_per_m: (i) => cond.racOhmPerM(i.size, i.material, i.temp_c, i.freq, i.spacing_mm),
  reactance_ohm_per_m: (i) => cond.reactanceOhmPerM(i.size, i.gmd_mm, i.freq),
  ac_factors: (i) => cond.acFactors(i.rdc, i.freq, i.d_mm, i.spacing_mm),

  table_ampacity: (i) => amp.tableAmpacity(i.code, i.installation, i.material, i.size, i.temp_col),
  table_info: (i) => amp.tableInfo(i.code, i.installation),
  check_status: (i) => amp.checkStatus(i.code, i.allow_placeholder_data),
  ambient_factor: (i) => amp.ambientFactor(i.ambient_c, i.conductor_temp_c, i.rated_ambient_c),
  ccc_factor: (i) => amp.cccFactor(i.code, i.current_carrying),

  solve_sharing: (i) => {
    const cs = mkConds(i.conductors);
    const r = imp.solveSharing(cs, mkGroups(i.groups), i.freq, i.soil_ohm_m);
    const n = cs.length;
    return {
      ...r,
      share_pct: Array.from({ length: n }, (_, k) => imp.sharePct(r, k)),
      group_loss_phase: imp.groupLossWPerM(r, "phase"),
      group_loss_bonded: imp.groupLossWPerM(r, "bonded"),
      members: Object.fromEntries(["A", "B", "C"].map((p) => [p, imp.groupMembers(r, p)])),
    };
  },
  impedance_matrix: (i) => imp.impedanceMatrix(mkConds(i.conductors), i.freq, i.soil_ohm_m),
  earth_depth_m: (i) => imp.earthDepthM(i.freq, i.soil_ohm_m),
  balanced_three_phase: (i) => imp.balancedThreePhase(i.i_rms, i.pf, i.lagging, i.names),
  solve_complex: (i) => imp.solveComplex(i.a, i.b),

  peak_factor: (i) => frc.peakFactor(i.x_over_r, i.freq),
  fault_forces: (i) => frc.faultForces(mkConds(i.conductors), i.share, i.fault_ka_rms, i.x_over_r, i.opts),

  b_rms_ut: (i) => fld.bRmsUt(mkConds(i.conductors), i.currents, i.x_mm, i.y_mm),
  profile: (i) => fld.profile(mkConds(i.conductors), i.currents, i.y_mm, i.x_from_mm, i.x_to_mm, i.steps),
  far_field_flat_ut: (i) => fld.farFieldFlatUt(i.i_rms, i.spacing_m, i.distance_m),

  cable_construction_dims: (i) => mkCable(i.cable),
  dielectric_loss: (i) => thm.dielectricLoss(mkCable(i.cable), i.freq),
  free_air_ampacity: (i) => {
    const r = thm.freeAirAmpacity(mkCable(i.cable), i.ambient_c,
      { installation: i.installation, lambda1: i.lambda1, freq: i.freq, spacing_mm: i.spacing_mm });
    return { ...r, summary: thm.ampacitySummary(r) };
  },
  insulation_resistivity: (i) => thm.insulationResistivity(i.insulation, i.rated_voltage_v),

  validate: (i) => ({ voltage: validate.voltage, power_factor: validate.powerFactor,
    clearing_time: validate.clearingTime, x_over_r: validate.xOverR })[i.fn](i.name, i.value),

  // pecalc reactance_derived.py is mirrored by src/engine/reactanceDerived.js (shared, not duplicated).
  reactance_derived_table: () => rxd.DERIVED_XL,
  reactance_floor_per_1000ft: (i) => rxd.reactanceFloorPer1000ft(i.size),
  reactance_per_1000ft: (i) => {
    const r = rxd.reactancePer1000ft(cond.normalizeSize(i.size), i.raceway);
    return r === null ? null : [r.xl, r.derived];
  },
};
const ITERATIVE = new Set(["free_air_ampacity"]);

// Golden fault_forces input for `bodies` has string keys; JS objects already key by string.
for (const [fn, entries] of Object.entries(V)) {
  if (!Array.isArray(entries)) continue;
  test(`golden ${fn} (${entries.length} vectors)`, () => {
    const run = DISPATCH[fn];
    assert.ok(run, `no JS dispatch for golden function ${fn}`);
    const tol = ITERATIVE.has(fn) ? TOL_ITERATIVE : TOL;
    entries.forEach((v, n) => {
      const input = dec(v.in);
      if (v.error) {
        assert.throws(() => run(input), (e) => {
          assert.equal(e.message, v.error.message, `vector ${n} ${JSON.stringify(v.in).slice(0, 120)}`);
          if (v.error.type === "DataStatusError") assert.ok(e instanceof amp.DataStatusError);
          return true;
        });
      } else {
        const out = run(input);
        const exp = dec(v.out);
        // fault_forces: per-body resultants of internal filament forces cancel to rounding dust (~1e-11 N/m)
        // that carries no meaning; allow 1e-9 of the worst force as an absolute floor.
        const floor = fn === "fault_forces" ? TOL * exp.worst_n_per_m : 0;
        cmp(out, exp, tol, `${fn}#${n}`, floor);
      }
    });
  });
}

test("golden constants match the JS tables", () => {
  cmp({ SIZES: cond.SIZES, AREA_CMIL: cond.AREA_CMIL, DIAMETER_IN: cond.DIAMETER_IN, MATERIALS: cond.MATERIALS,
    STRANDING_FACTOR: cond.STRANDING_FACTOR, MU0: cond.MU0, FT: cond.FT, INCH: cond.INCH, CMIL_TO_MM2: cond.CMIL_TO_MM2 },
  V.conductors_constants, 0);
  cmp({ COLUMNS: amp.COLUMNS, CODES: amp.CODES, INSTALLATIONS: amp.INSTALLATIONS, CLAUSES: amp.CLAUSES,
    PARALLEL_MIN: amp.PARALLEL_MIN }, V.ampacity_constants, 0);
  cmp({ MU0_2PI: imp.MU0_2PI }, V.impedance_constants, 0);
  cmp({ N_PER_M_TO_LBF_PER_FT: frc.N_PER_M_TO_LBF_PER_FT }, V.forces_constants, 0);
  cmp({ LIMITS_UT: fld.LIMITS_UT, MU0_2PI: fld.MU0_2PI }, V.field_constants, 0);
  cmp({ THERMAL_RESISTIVITY: thm.THERMAL_RESISTIVITY, DIELECTRIC: thm.DIELECTRIC, AIR_CONSTANTS: thm.AIR_CONSTANTS,
    EPR_LV_RESISTIVITY: thm.EPR_LV_RESISTIVITY, EPR_LV_MAX_KV: thm.EPR_LV_MAX_KV }, V.thermal_constants, 0);
  cmp({ DERIVED_STATUS: rxd.DERIVED_META.status, DERIVED_METHOD: rxd.DERIVED_META.method, RACEWAYS: rxd.RACEWAYS,
    DERIVED_SIZES: rxd.DERIVED_SIZES }, V.reactance_derived_constants, 0);
});

test("every golden vector function is exercised", () => {
  const n = Object.values(V).filter(Array.isArray).reduce((s, a) => s + a.length, 0);
  assert.equal(n, Object.values(golden._meta.counts).reduce((s, c) => s + c, 0));
  assert.ok(n > 2000);
});

// ------------------------------------------------- ported test_engine.py tests
// Each test states its reference, as in the Python suite. Values from code books were entered
// from memory in Python and are still to be checked against the licensed copy.
const OHM_KFT = 1000 * cond.FT; // ohm/m -> ohm/1000 ft
const rel = (a, b, delta) => assert.ok(Math.abs(a - b) <= delta, `${a} vs ${b} (delta ${delta})`);

test("ConductorPhysics: DC resistance matches NEC Chapter 9 Table 8 (75 C, ohm/kft, uncoated Cu/Al) within 1 %", () => {
  const TABLE8 = [["14", "Cu", 3.14], ["1/0", "Cu", 0.122], ["4/0", "Cu", 0.0608], ["500", "Cu", 0.0258],
    ["1000", "Cu", 0.0129], ["1/0", "Al", 0.201], ["500", "Al", 0.0424]];
  for (const [size, mat, ref] of TABLE8) rel((cond.rdcOhmPerM(size, mat) * OHM_KFT) / ref, 1, 0.01);
});

test("ConductorPhysics: AC resistance of 500 kcmil Cu close to NEC Ch. 9 Table 9 (PVC conduit, 0.027 ohm/kft)", () => {
  const rac = cond.racOhmPerM("500", "Cu", 75.0, 60.0, cond.cableOdMm("500")) * OHM_KFT;
  rel(rac, 0.027, 0.0015);
});

test("ConductorPhysics: size parsing", () => {
  assert.equal(cond.normalizeSize("500 kcmil"), "500");
  assert.equal(cond.normalizeSize("#2"), "2");
  assert.throws(() => cond.normalizeSize("123"), /Unknown conductor size '123'/);
});

test("CorrectionFactors: ambient equation matches NEC Table 310.15(B)(1) rounded factors (90 C @ 40 C = 0.91, 75 C @ 40 C = 0.88)", () => {
  rel(amp.ambientFactor(40, 90), 0.91, 0.005);
  rel(amp.ambientFactor(40, 75), 0.88, 0.005);
  assert.equal(amp.ambientFactor(95, 90), 0);
});

test("CorrectionFactors: grouping factors (NEC Table 310.15(C)(1), CEC Table 5C)", () => {
  assert.equal(amp.cccFactor("NEC", 3), 1.0);
  assert.equal(amp.cccFactor("NEC", 6), 0.8);
  assert.equal(amp.cccFactor("NEC", 9), 0.7);
  assert.equal(amp.cccFactor("CEC", 24), 0.7);
});

test("CorrectionFactors: CEC PLACEHOLDER data is refused unless explicitly allowed (size_feeder's guard is check_status)", () => {
  assert.throws(() => amp.checkStatus("CEC", false), amp.DataStatusError);
  assert.equal(amp.checkStatus("CEC", true), "PLACEHOLDER");
  assert.equal(amp.checkStatus("NEC", false), "UNVERIFIED");
});

// Flat layout helper from ImpedanceAndSharing._flat.
function flat(pattern, size = "750") {
  const r = cond.racOhmPerM(size, "Cu", 90);
  const g = cond.gmrMm(size);
  const p = 2 * cond.cableOdMm(size);
  return [...pattern].map((ph, i) => imp.conductor({ x_mm: i * p, y_mm: 0, group: ph, r_ohm_per_m: r, gmr_mm: g }));
}

test("ImpedanceAndSharing: trefoil reactance equals the GMD closed form", () => {
  const size = "500";
  const r = cond.racOhmPerM(size, "Cu", 90);
  const g = cond.gmrMm(size);
  const s = 60.0;
  const cs = [imp.conductor({ x_mm: 0, y_mm: 0, group: "A", r_ohm_per_m: r, gmr_mm: g }),
    imp.conductor({ x_mm: s, y_mm: 0, group: "B", r_ohm_per_m: r, gmr_mm: g }),
    imp.conductor({ x_mm: s / 2, y_mm: (s * Math.sqrt(3)) / 2, group: "C", r_ohm_per_m: r, gmr_mm: g })];
  const res = imp.solveSharing(cs, imp.balancedThreePhase(1000, 1.0));
  const z = cdiv(res.group_drop_v_per_m.A, res.groups.A.current);
  rel(z.im, cond.reactanceOhmPerM(size, s), 5e-10); // Python: assertAlmostEqual places=9
  rel(z.re, r, 5e-10);
});

test("ImpedanceAndSharing: mirrored arrangement ABCCBA shares equally", () => {
  const res = imp.solveSharing(flat("ABCCBA"), imp.balancedThreePhase(1500, 0.9));
  for (let i = 0; i < 6; i++) rel(imp.sharePct(res, i), 100, 0.1);
});

test("ImpedanceAndSharing: sequential arrangement ABCABC is unbalanced", () => {
  const res = imp.solveSharing(flat("ABCABC"), imp.balancedThreePhase(1500, 0.9));
  assert.ok(Math.max(...[0, 1, 2, 3, 4, 5].map((i) => imp.sharePct(res, i))) > 110);
});

test("ImpedanceAndSharing: member currents sum to the given phase total", () => {
  const groups = imp.balancedThreePhase(2000, 0.85);
  const res = imp.solveSharing(flat("ABCABCABC"), groups);
  for (const ph of "ABC") {
    let re = 0, im = 0;
    for (const i of imp.groupMembers(res, ph)) { re += res.currents[i].re; im += res.currents[i].im; }
    rel(Math.hypot(re - groups[ph].current.re, im - groups[ph].current.im), 0, 5e-7); // places=6
  }
});

test("Forces: middle conductor of a flat 3-phase bus F = 0.866 x 2e-7 x ip^2 / d (IEEE 605 / IEC 60865 basis)", () => {
  const cs = [0, 300, 600].map((x, k) => imp.conductor({ x_mm: x, y_mm: 0, group: "ABC"[k], r_ohm_per_m: 1e-4, gmr_mm: 5 }));
  const r = frc.faultForces(cs, { 0: 1, 1: 1, 2: 1 }, 50, 15);
  const ip = frc.peakFactor(15) * 50e3;
  assert.equal(r.worst_index, 1);
  rel(r.worst_n_per_m / (0.866 * 2e-7 * ip ** 2 / 0.3), 1, 0.02);
});

test("Forces: 100 kA rms, X/R 30 gives 255-270 kA first asymmetric peak (cable bus maker literature)", () => {
  const cs = [0, 300, 600].map((x, k) => imp.conductor({ x_mm: x, y_mm: 0, group: "ABC"[k], r_ohm_per_m: 1e-4, gmr_mm: 5 }));
  const r = frc.faultForces(cs, { 0: 1, 1: 1, 2: 1 }, 100, 30);
  assert.ok(r.peak_current_ka >= 255 && r.peak_current_ka <= 272, String(r.peak_current_ka));
});

// CalculatedAmpacity
const lv = (size) => thm.cableConstruction(size, { insulation: "XHHW", insulation_mm: cond.insulationMm(size) });

test("CalculatedAmpacity: LV calculated ampacity is 10-35 % above the NEC Table 310.17 free-air value at 30 C", () => {
  // NEC Table 310.17 is known to be conservative relative to IEC 60287 for an isolated cable.
  for (const size of ["1/0", "4/0", "500", "750", "1000"]) {
    const calc = thm.freeAirAmpacity(lv(size), 30).ampacity_a;
    const table = amp.tableAmpacity("NEC", "free_air", "Cu", size, 90);
    assert.ok(calc / table >= 1.10 && calc / table <= 1.35, `${size}: ${calc / table}`);
  }
});

test("CalculatedAmpacity: higher ambient and shield loss reduce ampacity; ambient above rating gives 0", () => {
  const c = lv("500");
  const a30 = thm.freeAirAmpacity(c, 30).ampacity_a;
  const a40 = thm.freeAirAmpacity(c, 40).ampacity_a;
  const a40l = thm.freeAirAmpacity(c, 40, { lambda1: 0.3 }).ampacity_a;
  assert.ok(a30 > a40);
  assert.ok(a40 > a40l);
  assert.equal(thm.freeAirAmpacity(c, 95).ampacity_a, 0);
});

test("CalculatedAmpacity: dielectric loss scales with voltage squared", () => {
  const mv = thm.cableConstruction("750", { insulation: "EPR", insulation_mm: 7.2, voltage_v: 15000 });
  const lo = thm.cableConstruction("750", { insulation: "EPR", insulation_mm: 7.2, voltage_v: 600 });
  rel(thm.dielectricLoss(mv) / thm.dielectricLoss(lo), (15000 / 600) ** 2, 5e-6); // places=6
});

test("MagneticField: single conductor obeys Ampere's law, B = mu0 I / (2 pi r): 1000 A at 1 m = 200 uT", () => {
  const c = [imp.conductor({ x_mm: 0, y_mm: 0, group: "A", r_ohm_per_m: 1e-4, gmr_mm: 5 })];
  rel(fld.bRmsUt(c, [1000], 0, 1000), 200.0, 5e-7);
});

test("MagneticField: flat three-phase field matches the closed-form far field within 1 %", () => {
  const g = imp.balancedThreePhase(1000, 1.0);
  const cs = [-100, 0, 100].map((x, k) => imp.conductor({ x_mm: x, y_mm: 0, group: "ABC"[k], r_ohm_per_m: 1e-4, gmr_mm: 5 }));
  const cur = ["A", "B", "C"].map((p) => g[p].current);
  rel(fld.bRmsUt(cs, cur, 0, 5000) / fld.farFieldFlatUt(1000, 0.1, 5), 1, 0.01);
});

// Extra behaviours that the Python tests exercise through other modules.
test("sanity: complex helpers", () => {
  assert.equal(cabs({ re: 3, im: 4 }), 5);
});

test("regression: X/R <= 0 raises like the Python (validate.x_over_r), instead of returning NaN-tainted forces", () => {
  // Python (pecalc #10): peak_factor and fault_forces validate X/R > 0 before dividing by it.
  // The JS once returned peakFactor(0) = √2·1.02 = 1.4425 and a NaN first peak with finite forces.
  assert.throws(() => frc.peakFactor(0), { message: "x_over_r must be greater than 0, got 0.0" });
  assert.throws(() => frc.peakFactor(-3), { message: "x_over_r must be greater than 0, got -3.0" });
  const c = [{ group: "A", x_mm: 0, y_mm: 0 }, { group: "B", x_mm: 100, y_mm: 0 }];
  assert.throws(() => frc.faultForces(c, [1, 1], 10, 0), /x_over_r must be greater than 0/);
  // Sanity: a normal X/R still matches IEC 60909 κ·√2: X/R 15 -> √2·(1.02 + 0.98·e^-0.2) = 2.57716
  assert.ok(Math.abs(frc.peakFactor(15) - Math.SQRT2 * (1.02 + 0.98 * Math.exp(-0.2))) < 1e-12);
});
