// Tests for the cable bus short-circuit and temperature-rise simulation (cablebusSim.js).
//
// Part 1 replays tests/golden/cablebus_sim.json, generated from the Python pecalc package by
// scripts/gen_golden_cablebus_sim.py, through the JS port. Part 2 are the hand checks of
// calculations/tests/test_cablebus_sim.py with their arithmetic. Test-report ratings are user inputs, so the
// ratings used here are arbitrary numbers, not CSA C22.2 No. 273 / IEEE C37.23 values.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as sim from "../src/engine/pecalc/cablebusSim.js";
import * as cb from "../src/engine/pecalc/cablebus.js";
import * as cond from "../src/engine/pecalc/conductors.js";
import * as thm from "../src/engine/pecalc/thermal.js";
import { faultForces, peakFactor } from "../src/engine/pecalc/forces.js";

const G = JSON.parse(readFileSync(new URL("./golden/cablebus_sim.json", import.meta.url), "utf8"));
const REL = 1e-9;
const REL_ITER = 1e-6; // steady-state / ampacity iterations
const num = (v) => (v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v === "NaN" ? NaN : v);

function close(a, b, rel, path) {
  b = num(b);
  if (typeof b === "number") {
    assert.equal(typeof a, "number", `${path}: expected a number, got ${a}`);
    if (!isFinite(b) || Number.isNaN(b)) return assert.ok(Object.is(a, b), `${path}: ${a} vs ${b}`);
    assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-12) + 1e-9,
      `${path}: JS ${a} vs Python ${b}`);
  } else if (Array.isArray(b)) {
    assert.ok(Array.isArray(a), `${path}: expected an array`);
    assert.equal(a.length, b.length, `${path}: length`);
    b.forEach((x, i) => close(a[i], x, rel, `${path}[${i}]`));
  } else if (b && typeof b === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(b)) close(a[k], b[k], rel, `${path}.${k}`);
  } else {
    assert.equal(a, b, path);
  }
}

test("golden: simulate() matches Python for every vector", () => {
  G.vectors.forEach((v, i) => {
    const label = `vector ${i} ${JSON.stringify(v.inputs).slice(0, 160)}`;
    const run = () => sim.simulate(sim.simInput(v.inputs));
    if (v.error !== undefined) {
      assert.throws(run, (e) => e instanceof Error && e.message === v.error, `${label}: expected error "${v.error}"`);
      return;
    }
    close(run(), v.result, REL_ITER, label);
  });
});

test("golden: helpers (I2t, adiabatic, equivalence, first peak, enclosure, steady state)", () => {
  const H = G.helpers;
  for (const h of H.i2t) close(sim.i2tClosedForm(h.amp, h.th, h.t, h.f, h.xr), h.i2t, REL, "i2t");
  for (const h of H.adiabatic) close(cond.adiabaticTemperatureC(h.material, h.area_cmil, h.t1, h.i2t), h.t2, REL, "adiabatic");
  for (const h of H.equivalent) close(sim.equivalentShortTimeKa(h.ka, h.s, h.to), h.eq, REL, "equivalent");
  for (const h of H.first_peak) {
    const r = sim.firstPeakCurrent(h.ka, h.xr, h.f);
    close(r, { peak_a: h.peak_a, angle_deg: h.angle_deg, phase: h.phase, time_s: h.time_s }, REL, "first_peak");
  }
  for (const h of H.enclosure) {
    const { q, w, h: hh, ta, eps, ...exp } = h;
    close(sim.enclosureSurfaceTemperature(q, w, hh, ta, eps), exp, REL, "enclosure");
  }
  for (const h of H.steady) {
    const c = h.construction;
    const cons = thm.cableConstruction(c.size, { material: c.material, insulation: c.insulation, insulation_mm: c.insulation_mm,
      shield_mm: c.shield_mm, jacket_mm: c.jacket_mm, jacket: c.jacket, voltage_v: c.voltage_v, max_temp_c: c.max_temp_c });
    close(sim.steadyStateCable(cons, h.current_a, h.ambient_c, { installation: h.installation, lambda1: h.lambda1, freq: 60.0, spacing_mm: 90.0 }),
      h.result, REL_ITER, "steady");
    close(sim.heatCapacityJPerMK(cons), h.caps, REL, "caps");
  }
});

// --- hand checks ------------------------------------------------------------------

const BUS = { voltage_v: 600.0, current_a: 3000.0, conductors_per_phase: 4, size: "750", fault_ka: 50.0,
  fault_clearing_s: 0.5, x_over_r: 15.0, enclosure_width_mm: 800.0, enclosure_height_mm: 120.0 };
const mk = (extra = {}, bus = {}) => sim.simInput({ bus: { ...BUS, ...bus }, ...extra });

test("adiabatic temperature: 750 kcmil Cu, 50 kA, 0.5 s from 90 C", () => {
  // (I/A)^2 t / K = (50000/750000)^2 * 0.5 / 0.0297 = 0.074823; T2 = 324 * 10^0.074823 - 234 = 150.9 C
  assert.ok(Math.abs(cond.adiabaticTemperatureC("Cu", 750000, 90.0, 50000 ** 2 * 0.5) - 150.9) < 0.05);
  const i = cond.adiabaticWithstandA("Al", 500000, 90.0, 250.0, 0.5);
  assert.ok(Math.abs(cond.adiabaticTemperatureC("Al", 500000, 90.0, i * i * 0.5) - 250.0) < 1e-9);
});

test("I2t equivalence: 63 kA 2 s is 89 kA 1 s", () => {
  // 63^2 * 2 = 7938; 89^2 * 1 = 7921 kA2s; sqrt(7938) = 89.0955
  assert.equal(sim.i2tKa2s(63, 2), 7938);
  assert.ok(Math.abs(sim.equivalentShortTimeKa(63, 2, 1) - 89.0955) < 5e-4);
  assert.throws(() => sim.equivalentShortTimeKa(40, 0, 1));
});

test("force peak equals faultForces exactly at the worst closing angle", () => {
  const ctx = sim.buildContext(mk().bus);
  const { inp, cs, share } = ctx;
  const fr = faultForces(cs, share, inp.fault_ka, inp.x_over_r, { freq: inp.frequency_hz });
  const wf = sim.faultForceWaveforms(cs, share, inp.fault_ka, inp.x_over_r, inp.frequency_hz);
  assert.equal(wf.peak_first_cycle_n_per_m, fr.worst_n_per_m);
  assert.equal(wf.worst_index, fr.worst_index);
  for (let k = 0; k < wf.t_s.length; k++) {
    const s = wf.phase_current_a.A[k] + wf.phase_current_a.B[k] + wf.phase_current_a.C[k];
    assert.ok(Math.abs(s) < 1e-6);
  }
});

test("peak current: IEC 60909 close at X/R 15; sqrt(2) I with no DC", () => {
  const pk = sim.firstPeakCurrent(50, 15);
  assert.ok(Math.abs(pk.peak_a / 50000 / peakFactor(15) - 1) < 0.01);
  assert.ok(Math.abs(sim.firstPeakCurrent(50, 0.05).peak_a / 1000 - 70.71) < 0.5);
});

test("closed-form I2t: no DC over whole cycles is I^2 t", () => {
  assert.ok(Math.abs(sim.i2tClosedForm(Math.sqrt(2) * 50000, 0.0, 0.5, 60.0, 15.0) - 50000 ** 2 * 0.5) < 1e-3);
});

test("ratings checks: NOT SET without inputs, pass and fail with them", () => {
  const r0 = sim.simulateShortCircuit(mk());
  assert.equal(r0.checks[0].status, "NOT SET");
  assert.equal(r0.complete, false);
  assert.equal(r0.peak_force_n_per_m, r0.worst_force_n_per_m);
  const ok = sim.simulateShortCircuit(mk({ tested_momentary_peak_ka: 140, tested_short_time_ka: 63, tested_short_time_s: 2 }));
  assert.ok(Math.abs(ok.equivalent_rating_ka - 126) < 1e-9); // sqrt(63^2 * 2 / 0.5)
  assert.deepEqual(ok.checks.slice(0, 2).map((c) => c.status), ["PASS", "PASS"]);
  const bad = sim.simulateShortCircuit(mk({ tested_momentary_peak_ka: 100, tested_short_time_ka: 20, tested_short_time_s: 1 }));
  assert.deepEqual(bad.checks.slice(0, 2).map((c) => c.status), ["FAIL", "FAIL"]);
  assert.equal(bad.passed, false);
  assert.ok(Math.abs(r0.peak_block_load_n - r0.peak_force_n_per_m * 0.9144) < 1e-6);
});

test("steady state at the ampacity current returns the rated conductor temperature", () => {
  for (const kw of [{ insulation_mm: 2.03, insulation: "XHHW", voltage_v: 600.0 },
    { insulation_mm: 7.2, insulation: "EPR", shield_mm: 0.13, jacket_mm: 2.0, voltage_v: 15000.0 }]) {
    const c = thm.cableConstruction("750", { material: "Cu", max_temp_c: 90.0, ...kw });
    for (const lam of [0.0, 0.2]) {
      const a = thm.freeAirAmpacity(c, 40.0, { installation: "isolated", lambda1: lam, freq: 60.0, spacing_mm: 90.0 });
      const ss = sim.steadyStateCable(c, a.ampacity_a, 40.0, { installation: "isolated", lambda1: lam, freq: 60.0, spacing_mm: 90.0 });
      assert.ok(Math.abs(ss.theta_c - 90.0) < 1e-6, `${kw.insulation} lambda ${lam}: ${ss.theta_c}`);
      assert.ok(Math.abs(ss.surface_c - 40.0 - a.surface_rise_c) < 1e-6);
    }
  }
});

test("enclosure estimate closes its heat balance", () => {
  const e = sim.enclosureSurfaceTemperature(400.0, 800.0, 120.0, 40.0, 0.9);
  assert.ok(Math.abs(e.q_convection_w_per_m + e.q_radiation_w_per_m - 400.0) < 1e-6);
  // radiation by hand: eps sigma (Ts^4 - Ta^4) x perimeter, perimeter = 2 (0.8 + 0.12) = 1.84 m
  const ts = 313.15 + e.rise_k, ta = 313.15;
  assert.ok(Math.abs(0.9 * 5.670374419e-8 * (ts ** 4 - ta ** 4) * 1.84 - e.q_radiation_w_per_m) < 1e-6);
  assert.ok(sim.enclosureSurfaceTemperature(0, 800, 120, 40, 0.3).rise_k < 1e-6);
});

test("warm-up reaches 63.2 % of the rise at one time constant", () => {
  const r = sim.simulateTemperatureRise(mk());
  const w = r.warmup;
  assert.ok(Math.abs((w.temp_c[20] - r.ambient_c) / w.rise_inf_k - (1 - Math.exp(-1))) < 1e-9);
  assert.ok(Math.abs(w.t_s[20] - w.tau_s) < 1e-9);
  assert.ok(Math.abs(w.tau_s - w.capacity_j_per_m_k.total * w.r_th_k_m_per_w) < 1e-9);
  const caps = w.capacity_j_per_m_k;
  assert.ok(Math.abs(caps.conductor - cond.areaMm2("750") * 1e-6 * 3.45e6) < 1e-6);
});

test("temperature checks: limits are NOT SET until entered", () => {
  const r0 = sim.simulateTemperatureRise(mk());
  assert.deepEqual(r0.checks.map((c) => c.status), ["PASS", "NOT SET", "NOT SET", "NOT SET"]);
  const r1 = sim.simulateTemperatureRise(mk({ rise_limit_conductor_k: 10, rise_limit_enclosure_k: 100,
    rise_limit_termination_k: 50, termination_rise_k: 30 }));
  assert.deepEqual(r1.checks.map((c) => c.status), ["PASS", "FAIL", "PASS", "PASS"]);
  assert.equal(r1.passed, false);
  const lo = sim.simulateTemperatureRise(mk({ load_scale: 0.5 }));
  assert.ok(lo.max_theta_c < r0.max_theta_c);
  const cur = r0.cables.map((c) => c.current_a);
  assert.ok(Math.max(...cur) > Math.min(...cur));
  const noEnc = sim.simulateTemperatureRise(sim.simInput({ bus: { ...BUS, enclosure_width_mm: null, enclosure_height_mm: null } }));
  assert.equal(noEnc.enclosure, null);
});

test("simInput rejects unknown keys and errors propagate", () => {
  assert.throws(() => sim.simInput({ nope: 1 }), TypeError);
  assert.throws(() => sim.simulateShortCircuit(sim.simInput({ bus: { ...BUS, fault_ka: null } })));
});
