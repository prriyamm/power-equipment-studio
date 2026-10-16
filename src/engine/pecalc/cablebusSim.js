/* Cable bus short-circuit and temperature-rise simulation. Port of pecalc/cablebus_sim.py (golden-tested).
   Pure module: no DOM, no React.

   Framing: IEEE Std C37.23 (metal-enclosed bus, includes cable bus) and CSA C22.2 No. 273 (cablebus) rate a
   product by type tests: momentary (peak) withstand, short-time (rms, stated duration) withstand and a
   temperature-rise test. Both texts are licensed and were not read; test durations, rise limits and pass
   criteria are therefore NOT taken from them. The ratings and limits are user inputs from the product's own
   test report (no defaults). This module computes the physics from public methods and compares it with them.

   Short circuit (time domain): asymmetrical phase currents, Ampere-law force per metre on each conductor (the
   same internals as forces.faultForces, so the peaks match it exactly), support block load = force x span,
   adiabatic conductor temperature from the ICEA P-32-382 relation inverted in closed form, short-time rating
   compared on I^2 t.
   Temperature rise: free-air thermal circuit (thermal.js) solved forward per cable at its own current,
   enclosure surface estimate from convection + radiation, one-node warm-up.

   [UNVERIFIED: all physics constants are listed with status and citation in data/cablebus_sim.json.]
   Input and result objects use the same snake_case field names as the Python code. */
import * as cond from "./conductors.js";
import { PHASES, cableBusInput, analyse, buildLayout, cableBusGroups, construction } from "./cablebus.js";
import { BLOCK_MATERIALS } from "./cablebus_design.js";
import { forceGeometry, instCurrents, forcesAt, faultForces, peakFactor, N_PER_M_TO_LBF_PER_FT } from "./forces.js";
import { solveSharing } from "./impedance.js";
import { AIR_CONSTANTS, THERMAL_RESISTIVITY, cableConstruction, dielectricLoss, freeAirAmpacity,
  insulationResistivity } from "./thermal.js";
import { pyRound, pyFixed, cabs, cdiv, toC } from "./util.js";
import { pyG } from "./cablebus.js";
import * as validate from "./validate.js";
import DATA from "./data/cablebus_sim.json" with { type: "json" };

export { DATA as SIM_DATA };
export const NOT_SET = "NOT SET";
export const ENTER = "enter from test report";
const N_PER_M_TO_LBF = 1 / 4.44822;
export const CLAUSE_SC = "IEEE C37.23 / CSA C22.2 No. 273 short-circuit rating [clause text NOT read]";
export const CLAUSE_TR = "IEEE C37.23 / CSA C22.2 No. 273 temperature rise [clause text NOT read]";
const DEG = Math.PI / 180, RAD = 180 / Math.PI;

const _DEFAULTS = {
  closing_angle_deg: null, cycles: 5.0, steps_per_cycle: 96, initial_temp_c: null,
  tested_momentary_peak_ka: null, tested_short_time_ka: null, tested_short_time_s: null,
  tested_block_load_n: null, tested_force_n_per_m: null,
  block_material: "GPO-3", block_thickness_mm: 25.4, block_safety_factor: 2.0,
  load_scale: 1.0, enclosure_emissivity: null,
  rise_limit_conductor_k: null, rise_limit_enclosure_k: null, rise_limit_termination_k: null,
  termination_rise_k: null,
};

/** SimInput: {bus: CableBusInput overrides or full input, ...fields}; unknown keys are rejected. */
export function simInput(overrides = {}) {
  const { bus = {}, ...rest } = overrides;
  for (const k of Object.keys(rest)) {
    if (!Object.prototype.hasOwnProperty.call(_DEFAULTS, k)) throw new TypeError(`SimInput() got an unexpected keyword argument '${k}'`);
  }
  return { bus: cableBusInput(bus), ..._DEFAULTS, ...rest };
}

const isNull = (v) => v === null || v === undefined;

// --- context ------------------------------------------------------------------

/** Solve the bus once: analyse (pattern), then rebuild the layout and sharing for that pattern. */
export function buildContext(bus) {
  const inp = { ...bus, field_distances_m: [...bus.field_distances_m] };
  const result = analyse(inp, false);
  const od = result.cable_od_mm;
  const cs = buildLayout(inp, result.pattern, od);
  const with_shields = inp.shield_bonding === "both_ends";
  const res = solveSharing(cs, cableBusGroups(inp, with_shields), inp.frequency_hz);
  const phase_idx = [];
  cs.forEach((c, i) => { if (PHASES.includes(c.group)) phase_idx.push(i); });
  const share = {};
  for (const i of phase_idx) share[i] = cdiv(res.currents[i], res.groups[cs[i].group].current);
  return { inp, result, cs, res, od, phase_idx, share };
}

// --- short circuit: waveforms ---------------------------------------------------

const angleGrid = (n) => Array.from({ length: n }, (_, a) => (Math.PI * a) / n);
const toShare = (share, idx) => { const sh = {}; for (const i of idx) sh[i] = toC(share[i]); return sh; };
const phaseIdx = (conductors, phases) => {
  const idx = [];
  conductors.forEach((c, i) => { if (phases.includes(c.group)) idx.push(i); });
  return idx;
};

/** [grid index, radians] of the closing angle at which faultForces finds its worst force (first maximum). */
export function worstClosingAngle(conductors, share, fault_ka_rms, x_over_r, freq = 60.0, opts = {}) {
  const { phases = PHASES, steps_per_cycle = 96, angle_steps = 24 } = opts;
  validate.xOverR("x_over_r", x_over_r);
  const w = 2 * Math.PI * freq, tau = x_over_r / w, phi = Math.atan(x_over_r);
  const amp = Math.sqrt(2) * fault_ka_rms * 1000;
  const idx = phaseIdx(conductors, phases);
  const geo = forceGeometry(conductors, idx);
  const sh = toShare(share, idx);
  let best = -1.0, best_a = 0;
  angleGrid(angle_steps).forEach((alpha, a_step) => {
    let m = 0.0;
    for (let t_step = 0; t_step <= steps_per_cycle; t_step++) {
      const t = t_step / (steps_per_cycle * freq);
      const inst = instCurrents(conductors, sh, idx, phases, amp, w, t, Math.exp(-t / tau), alpha, phi);
      const fxy = forcesAt(idx, geo, inst);
      for (const i of idx) m = Math.max(m, Math.hypot(fxy[i][0], fxy[i][1]));
    }
    if (m > best) { best = m; best_a = a_step; }
  });
  return [best_a, angleGrid(angle_steps)[best_a]];
}

/**
 * Time-domain currents and forces for one closing angle (default: the worst one faultForces finds).
 * Returns t_s, phase_current_a {A,B,C} (unit share), conductor_current_a and force_n_per_m keyed by
 * conductor index, the worst conductor's force, the envelope max_i |F_i(t)| and the peaks.
 * peak_first_cycle_n_per_m at the worst angle equals faultForces(...).worst_n_per_m exactly.
 */
export function faultForceWaveforms(conductors, share, fault_ka_rms, x_over_r, freq = 60.0, opts = {}) {
  const { phases = PHASES, closing_angle_rad = null, cycles = 5.0, steps_per_cycle = 96, angle_steps = 24 } = opts;
  validate.xOverR("x_over_r", x_over_r);
  const w = 2 * Math.PI * freq, tau = x_over_r / w, phi = Math.atan(x_over_r);
  const amp = Math.sqrt(2) * fault_ka_rms * 1000;
  const idx = phaseIdx(conductors, phases);
  const geo = forceGeometry(conductors, idx);
  const sh = toShare(share, idx);
  const alpha = closing_angle_rad === null ? worstClosingAngle(conductors, share, fault_ka_rms, x_over_r, freq,
    { phases, steps_per_cycle, angle_steps })[1] : closing_angle_rad;
  const n_t = Math.trunc(cycles * steps_per_cycle) + 1;
  const n_first = steps_per_cycle + 1;
  const ts = [], ph = {}, dc = {}, cur = {}, frc = {};
  for (const p of phases) { ph[p] = []; dc[p] = []; }
  for (const i of idx) { cur[i] = []; frc[i] = []; }
  for (let t_step = 0; t_step < n_t; t_step++) {
    const t = t_step / (steps_per_cycle * freq);
    const decay = Math.exp(-t / tau);
    ts.push(t);
    phases.forEach((p, k) => {
      const th = alpha - phi - (2 * Math.PI * k) / 3;
      ph[p].push(amp * (Math.sin(w * t + th) - Math.sin(th) * decay));
      dc[p].push(-amp * Math.sin(th) * decay);
    });
    const inst = instCurrents(conductors, sh, idx, phases, amp, w, t, decay, alpha, phi);
    const fxy = forcesAt(idx, geo, inst);
    for (const i of idx) { cur[i].push(inst[i]); frc[i].push(Math.hypot(fxy[i][0], fxy[i][1])); }
  }
  const peaks = {};
  for (const i of idx) peaks[i] = Math.max(...frc[i]);
  const worst = firstMax(idx, (i) => peaks[i]);
  const envelope = ts.map((_, k) => { let m = -Infinity; for (const i of idx) m = Math.max(m, frc[i][k]); return m; });
  return {
    t_s: ts, closing_angle_rad: alpha, phase_current_a: ph, dc_component_a: dc, conductor_current_a: cur,
    force_n_per_m: frc, worst_index: worst, force_worst_n_per_m: frc[worst], force_envelope_n_per_m: envelope,
    peak_n_per_m: Math.max(...envelope), peak_first_cycle_n_per_m: Math.max(...envelope.slice(0, n_first)),
    peak_per_conductor_n_per_m: peaks,
  };
}

/** Largest first-cycle instantaneous phase current over every closing angle (unit share), A. */
export function firstPeakCurrent(fault_ka_rms, x_over_r, freq = 60.0, steps_per_cycle = 480, angle_step_deg = 1.0) {
  validate.xOverR("x_over_r", x_over_r);
  const w = 2 * Math.PI * freq, tau = x_over_r / w, phi = Math.atan(x_over_r);
  const amp = Math.sqrt(2) * fault_ka_rms * 1000;
  let best = 0.0, best_ang = 0.0, best_ph = "A", best_t = 0.0;
  const n_ang = Math.round(180.0 / angle_step_deg);
  for (let a = 0; a < n_ang; a++) {
    const alpha = a * angle_step_deg * DEG;
    PHASES.forEach((p, k) => {
      const th = alpha - phi - (2 * Math.PI * k) / 3;
      for (let t_step = 0; t_step <= steps_per_cycle; t_step++) {
        const t = t_step / (steps_per_cycle * freq);
        const v = Math.abs(amp * (Math.sin(w * t + th) - Math.sin(th) * Math.exp(-t / tau)));
        if (v > best) { best = v; best_ang = a * angle_step_deg; best_ph = p; best_t = t; }
      }
    });
  }
  return { peak_a: best, angle_deg: best_ang, phase: best_ph, time_s: best_t };
}

/** Integral from 0 to t of i^2 dt, A^2 s, for i = amp [sin(wu + th) - sin(th) e^(-u/tau)] (exact). */
export function i2tClosedForm(amp_a, th, t, freq, x_over_r) {
  const w = 2 * Math.PI * freq;
  const p = w / x_over_r; // 1 / tau
  const s_t = Math.sin(w * t + th), c_t = Math.cos(w * t + th);
  const i_sin2 = t / 2 - (Math.sin(2 * (w * t + th)) - Math.sin(2 * th)) / (4 * w);
  const e1 = Math.exp(-p * t);
  const i_cross = (e1 * (-p * s_t - w * c_t) + (p * Math.sin(th) + w * Math.cos(th))) / (p * p + w * w);
  const i_dc2 = (1 - Math.exp(-2 * p * t)) / (2 * p);
  return amp_a ** 2 * (i_sin2 - 2 * Math.sin(th) * i_cross + Math.sin(th) ** 2 * i_dc2);
}

export const i2tKa2s = (ka, seconds) => ka * ka * seconds;

/** Short-time current with the same I^2 t at another duration (heating equivalence). */
export function equivalentShortTimeKa(rated_ka, rated_s, duration_s) {
  if (rated_ka <= 0 || rated_s <= 0 || duration_s <= 0) throw new Error("rated_ka, rated_s and duration_s must be > 0");
  return Math.sqrt((rated_ka ** 2 * rated_s) / duration_s);
}

/** First item whose key is within 1e-9 (relative) of the maximum: mirror-image ties resolve the same way in every port. */
function firstMax(items, key) {
  let m = -Infinity;
  for (const x of items) m = Math.max(m, key(x));
  return items.find((x) => key(x) >= m * (1 - 1e-9));
}

// --- result helpers -------------------------------------------------------------

function mkCheck(name, clause, value, limit, unit, passed, note = "", status = null) {
  const st = status || (passed === null ? NOT_SET : passed ? "PASS" : "FAIL");
  return {
    name, clause, value: value === null ? null : pyRound(value, 3), limit: limit === null ? null : pyRound(limit, 3),
    unit, passed: passed === null ? null : !!passed, status: st, note,
  };
}

function verdict(checks) {
  const set = checks.filter((c) => c.passed !== null);
  const complete = set.length === checks.length;
  if (set.some((c) => !c.passed)) return [false, complete];
  return [set.length ? true : null, complete];
}

const statusRow = (name, value, status, source) => ({ name, value, status, source });
const userRow = (name, value, unit) => statusRow(name, isNull(value) ? NOT_SET : `${pyG(value)} ${unit}`,
  isNull(value) ? NOT_SET : "USER (test report)", isNull(value) ? ENTER : "entered");

// --- short circuit --------------------------------------------------------------

export function simulateShortCircuit(sim, ctx = null) {
  const bus = sim.bus;
  if (!bus.fault_ka) throw new Error("fault_ka is required for the short-circuit simulation");
  validate.xOverR("x_over_r", bus.x_over_r);
  if (sim.cycles <= 0 || sim.steps_per_cycle < 8) throw new Error("cycles must be > 0 and steps_per_cycle >= 8");
  for (const nm of ["tested_momentary_peak_ka", "tested_short_time_ka", "tested_short_time_s", "tested_block_load_n",
    "tested_force_n_per_m"]) {
    if (!isNull(sim[nm]) && sim[nm] <= 0) throw new Error(`${nm} must be > 0`);
  }
  if (!isNull(bus.fault_clearing_s)) validate.clearingTime("fault_clearing_s", bus.fault_clearing_s);
  ctx = ctx || buildContext(bus);
  const { inp, cs, share, phase_idx } = ctx;
  const f = inp.frequency_hz, xr = inp.x_over_r, ka = inp.fault_ka;
  const span = inp.support_span_m;

  const fr = faultForces(cs, share, ka, xr, { freq: f });
  const [, a_worst] = worstClosingAngle(cs, share, ka, xr, f);
  const alpha = isNull(sim.closing_angle_deg) ? a_worst : sim.closing_angle_deg * DEG;
  const wf = faultForceWaveforms(cs, share, ka, xr, f,
    { closing_angle_rad: alpha, cycles: sim.cycles, steps_per_cycle: sim.steps_per_cycle });
  const t_s = wf.t_s;
  const envelope = wf.force_envelope_n_per_m;
  const block = envelope.map((e) => e * span);
  const wi = wf.worst_index;
  const w_c = cs[wi];

  const pk = firstPeakCurrent(ka, xr, f);
  const n1 = sim.steps_per_cycle + 1;
  let sel_peak = 0.0;
  for (const p of PHASES) for (let k = 0; k < n1; k++) sel_peak = Math.max(sel_peak, Math.abs(wf.phase_current_a[p][k]));
  let sel_i = 0, sel_v = -Infinity;
  for (let k = 0; k < n1; k++) {
    const v = Math.max(...PHASES.map((p) => Math.abs(wf.phase_current_a[p][k])));
    if (v > sel_v) { sel_v = v; sel_i = k; }
  }
  const phi = Math.atan(xr);
  const amp = Math.sqrt(2) * ka * 1000;
  const env_k = firstMax([0, 1, 2], (k) => Math.abs(Math.sin(alpha - phi - (2 * Math.PI * k) / 3)));
  const env_ph = PHASES[env_k];
  const upper = wf.dc_component_a[env_ph].map((d) => d + amp);
  const lower = wf.dc_component_a[env_ph].map((d) => d - amp);

  const t_clear = bus.fault_clearing_s;
  const t_end = t_clear || sim.cycles / f;
  const t0 = !isNull(sim.initial_temp_c) ? sim.initial_temp_c : Number(inp.insulation_temp_c);
  const area = cond.AREA_CMIL[inp.size];
  const hot = firstMax(phase_idx, (i) => cabs(share[i]));
  const s_hot = toC(share[hot]);
  const k_hot = PHASES.indexOf(cs[hot].group);
  const tempAt = (alpha_, t_) => {
    const th = alpha_ - phi - (2 * Math.PI * k_hot) / 3 + Math.atan2(s_hot.im, s_hot.re);
    const e = i2tClosedForm(cabs(s_hot) * amp, th, t_, f, xr);
    return [cond.adiabaticTemperatureC(inp.material, area, t0, e), e];
  };
  const n_th = 200;
  const th_t = Array.from({ length: n_th + 1 }, (_, k) => (t_end * k) / n_th);
  const th_c = th_t.map((t) => tempAt(alpha, t)[0]);
  const [final_sel, e_sel] = tempAt(alpha, t_end);
  let worst_heat = null;
  for (const a of angleGrid(24)) {
    const v = tempAt(a, t_end)[0];
    if (worst_heat === null || v > worst_heat[0]) worst_heat = [v, a];
  }
  const final_worst = Math.max(worst_heat[0], final_sel);

  const i2t_sym = i2tKa2s(ka, t_end);
  let i2t_asym = -Infinity;
  for (const a of angleGrid(24)) {
    for (let k = 0; k < 3; k++) {
      i2t_asym = Math.max(i2t_asym, i2tClosedForm(amp, a - phi - (2 * Math.PI * k) / 3, t_end, f, xr));
    }
  }
  i2t_asym /= 1e6;

  const checks = [];
  const peak_ka = pk.peak_a / 1000;
  const t_peak = sim.tested_momentary_peak_ka;
  checks.push(mkCheck("Momentary: first-cycle asymmetrical peak current within the tested peak", CLAUSE_SC,
    peak_ka, isNull(t_peak) ? null : t_peak, "kA", isNull(t_peak) ? null : peak_ka <= t_peak,
    `worst closing angle ${pyFixed(pk.angle_deg, 0)} deg, X/R ${pyG(xr)}; ` +
    (isNull(t_peak) ? ENTER : "tested peak from the test report")));
  const t_st = sim.tested_short_time_ka, t_ds = sim.tested_short_time_s;
  const SHORT_NAME = "Short-time: fault current within the tested rating at the clearing time (I2t basis)";
  if (!isNull(t_st) && !isNull(t_ds) && t_clear) {
    const eq = equivalentShortTimeKa(t_st, t_ds, t_clear);
    checks.push(mkCheck(SHORT_NAME, CLAUSE_SC, ka, eq, "kA", ka <= eq,
      `tested ${pyG(t_st)} kA for ${pyG(t_ds)} s = ${pyFixed(i2tKa2s(t_st, t_ds), 0)} kA2s; required ` +
      `${pyFixed(i2tKa2s(ka, t_clear), 0)} kA2s at ${pyG(t_clear)} s`));
  } else {
    checks.push(mkCheck(SHORT_NAME, CLAUSE_SC, ka, null, "kA", null, !t_clear ? "enter fault_clearing_s" : ENTER));
  }
  if (!isNull(sim.tested_force_n_per_m)) {
    const v = fr.worst_n_per_m;
    checks.push(mkCheck("Peak force per metre within the tested force", CLAUSE_SC, v, sim.tested_force_n_per_m, "N/m",
      v <= sim.tested_force_n_per_m, "worst conductor, worst closing angle"));
  } else {
    checks.push(mkCheck("Peak force per metre within the tested force", CLAUSE_SC, fr.worst_n_per_m, null, "N/m",
      null, `optional; ${ENTER}`));
  }
  const worst_block = fr.worst_n_per_m * span;
  if (!isNull(sim.tested_block_load_n)) {
    checks.push(mkCheck("Support block load within the tested block rating", CLAUSE_SC, worst_block,
      sim.tested_block_load_n, "N", worst_block <= sim.tested_block_load_n,
      `force x ${pyG(span)} m span, worst closing angle`));
  } else {
    checks.push(mkCheck("Support block load within the tested block rating", CLAUSE_SC, worst_block, null, "N", null,
      `force x ${pyG(span)} m span; ${ENTER}`));
  }
  const mat = sim.block_material ? BLOCK_MATERIALS[sim.block_material] : undefined;
  if (mat) {
    const ligament = Math.min(ctx.result.pitch_mm - ctx.od, ctx.od);
    const stress = worst_block / (sim.block_thickness_mm * ligament);
    const allow = mat.tensile / sim.block_safety_factor;
    checks.push(mkCheck(`Block web stress screening (${sim.block_material})`, "cable bus designer screening",
      stress, allow, "MPa", stress <= allow,
      "load / (thickness x ligament); allowable = tensile / safety factor; material values UNVERIFIED; the tested " +
      "block rating governs"));
  }
  const TEMP_NAME = "Conductor temperature at clearing within the insulation short-circuit limit";
  if (t_clear) {
    const lim = inp.insulation_sc_limit_c;
    checks.push(mkCheck(TEMP_NAME, "ICEA P-32-382 (adiabatic)", final_worst, lim, "C", final_worst <= lim,
      `worst conductor, worst closing angle, from ${pyG(t0)} C, own current share`));
  } else {
    checks.push(mkCheck(TEMP_NAME, "ICEA P-32-382 (adiabatic)", final_worst, null, "C", null, "enter fault_clearing_s"));
  }
  const [passed, complete] = verdict(checks);

  const notes = [
    "Ratings and limits are the product's own CSA C22.2 No. 273 / IEEE C37.23 test-report values; the standards' " +
    "test durations and pass criteria were not available (licensed) and are not used.",
    "Short-time equivalence uses I2t = constant (conductor heating), so it does not capture duration-dependent " +
    "mechanical effects; the standard test remains the basis of the rating.",
    `Peak current ${pyFixed(peak_ka, 2)} kA = ${pyFixed(peak_ka / ka, 3)} x rms sym at X/R ${pyG(xr)} (IEC 60909 ` +
    `approximation ${pyFixed(peakFactor(xr, f), 3)}); the force model is the time-domain Ampere law with the ` +
    "solved current sharing.",
    "Block load is the static force x span on one block (same basis as the designer screening); it is not an " +
    "IEEE 605 bending analysis.",
  ];
  const ref = {};
  for (const [k, v] of Object.entries(DATA.peak_factors)) ref[k] = v.value;
  const dataStatus = [
    userRow("Tested momentary peak", sim.tested_momentary_peak_ka, "kA"),
    userRow("Tested short-time current (rms sym)", sim.tested_short_time_ka, "kA"),
    userRow("Tested short-time duration", sim.tested_short_time_s, "s"),
    userRow("Tested block load", sim.tested_block_load_n, "N"),
    userRow("Tested force per metre", sim.tested_force_n_per_m, "N/m"),
    statusRow("ICEA P-32-382 constants K, T0", "Cu 0.0297 / 234, Al 0.0125 / 228", "UNVERIFIED",
      "conductors.ADIABATIC, from memory"),
    statusRow("Block material strength", sim.block_material || "none", "UNVERIFIED", "typical NEMA LI 1 / supplier values"),
    statusRow("Force model", "2e-7 i1 i2 / d, time domain", "UNVERIFIED", "IEEE 605 / IEC 60865 physics; no standard text read"),
    statusRow("Peak-factor reference rows", "ANSI 2.7, IEC 2.6 (60 Hz), asym rms 1.6", "UNVERIFIED",
      "secondary sources, LOW confidence, informational only"),
  ];
  return {
    x_over_r: xr, frequency_hz: f, fault_ka: ka, clearing_s: isNull(t_clear) ? null : t_clear, span_m: span,
    closing_angle_deg: alpha * RAD, worst_angle_deg: a_worst * RAD,
    t_s, phase_current_a: wf.phase_current_a, envelope_phase: env_ph, envelope_upper_a: upper, envelope_lower_a: lower,
    peak_current_ka: peak_ka, peak_current_angle_deg: pk.angle_deg, peak_current_phase: pk.phase,
    peak_at_selected_ka: sel_peak / 1000, peak_at_selected_time_s: t_s[sel_i],
    peak_factor_computed: peak_ka / ka, peak_factor_iec60909: peakFactor(xr, f), reference_peak_factors: ref,
    worst_conductor: { index: wi, phase: w_c.group, x_mm: pyRound(w_c.x_mm, 1), y_mm: pyRound(w_c.y_mm, 1) },
    force_worst_n_per_m: wf.force_worst_n_per_m, force_envelope_n_per_m: envelope, block_load_n: block,
    peak_force_n_per_m: wf.peak_n_per_m, peak_force_first_cycle_n_per_m: wf.peak_first_cycle_n_per_m,
    worst_force_n_per_m: fr.worst_n_per_m, worst_force_lbf_per_ft: fr.worst_n_per_m * N_PER_M_TO_LBF_PER_FT,
    peak_block_load_n: Math.max(...block), worst_block_load_n: worst_block, worst_block_load_lbf: worst_block * N_PER_M_TO_LBF,
    thermal: {
      t_s: th_t, temp_c: th_c, initial_c: t0, t_end_s: t_end, final_c: final_sel, final_c_worst_angle: final_worst,
      worst_heating_angle_deg: worst_heat[1] * RAD, conductor_index: hot, share_abs: cabs(s_hot), i2t_a2s: e_sel,
    },
    i2t_sym_ka2s: i2t_sym, i2t_asym_ka2s: i2t_asym,
    equivalent_rating_ka: (t_st && t_ds && t_clear) ? equivalentShortTimeKa(t_st, t_ds, t_clear) : null,
    checks, passed, complete, notes, data_status: dataStatus,
  };
}

// --- temperature rise -----------------------------------------------------------

/** Cable construction for the thermal model; builds an LV cable from the OD when none is given. */
export function simConstruction(inp, od) {
  const cons = construction(inp);
  if (cons !== null) return cons;
  const dc = cond.diameterMm(inp.size);
  return cableConstruction(inp.size, {
    material: inp.material, insulation: inp.insulation, insulation_mm: Math.max((od - dc) / 2, 0.1),
    shield_mm: inp.shield_mm, jacket_mm: inp.jacket_mm, jacket: inp.jacket, voltage_v: inp.voltage_v,
    max_temp_c: inp.insulation_temp_c,
  });
}

export const installationFor = (pitch_mm, od_mm) => (pitch_mm - od_mm >= 0.75 * od_mm ? "isolated" : "flat_touching");

/**
 * Conductor and surface temperature of one cable in free air at a given current (forward solution of the
 * circuit used by freeAirAmpacity):
 *   dtheta_c = I^2 R [T1 + (1 + l1)(T3 + T4)] + Wd (0.5 T1 + T3 + T4),  T4 = u / Ws,
 *   u = (Ws / (pi De h))^(1/(1 + 1/4)),  Ws = I^2 R (1 + l1) + Wd, with R = R_ac(theta_c) iterated.
 */
export function steadyStateCable(c, current_a, ambient_c = 40.0, opts = {}) {
  const { installation = "isolated", lambda1 = 0.0, freq = 60.0, spacing_mm = null } = opts;
  validate.voltage("voltage_v", c.voltage_v);
  const rated_v = !isNull(c.rated_voltage_v) ? c.rated_voltage_v : c.voltage_v;
  const rho_i = insulationResistivity(c.insulation, rated_v);
  const t1 = (rho_i / (2 * Math.PI)) * Math.log(1 + (2 * c.insulation_mm) / c.dc_mm);
  const t3 = c.jacket_mm ? (THERMAL_RESISTIVITY[c.jacket] / (2 * Math.PI)) * Math.log(1 + (2 * c.jacket_mm) / c.da_mm) : 0.0;
  const wd = dielectricLoss(c, freq);
  const [z, e, g] = AIR_CONSTANTS[installation];
  const de_m = c.de_mm / 1000;
  const h = z / de_m ** g + e;
  let theta = ambient_c;
  let r = cond.racOhmPerM(c.size, c.material, theta, freq, spacing_mm);
  let u = 0.0, ws = 0.0;
  for (let it = 0; it < 500; it++) {
    r = cond.racOhmPerM(c.size, c.material, theta, freq, spacing_mm);
    const x = current_a ** 2 * r;
    ws = x * (1 + lambda1) + wd;
    u = (ws / (Math.PI * de_m * h)) ** 0.8;
    const nxt = ambient_c + x * t1 + 0.5 * wd * t1 + ws * t3 + u;
    if (Math.abs(nxt - theta) < 1e-10) { theta = nxt; break; }
    theta = nxt;
  }
  const x = current_a ** 2 * r;
  ws = x * (1 + lambda1) + wd;
  return {
    theta_c: theta, surface_c: ambient_c + u, shield_c: ambient_c + u + ws * t3, r_ohm_per_m: r,
    conductor_loss_w_per_m: x, heat_w_per_m: ws, dielectric_w_per_m: wd, t1, t3,
    t4: ws > 0 ? u / ws : Infinity, lambda1, surface_rise_c: u,
  };
}

/** Thermal capacitance per metre of one cable (conductor, insulation, shield tape, jacket), J/(m K). */
export function heatCapacityJPerMK(c) {
  const hc = DATA.volumetric_heat_capacity_j_per_m3_k;
  const dc = c.dc_mm / 1000, di = c.di_mm / 1000, da = c.da_mm / 1000, de = c.de_mm / 1000;
  const a_cond = cond.areaMm2(c.size) * 1e-6;
  const q_cond = a_cond * hc[c.material];
  const q_ins = (Math.PI / 4) * (di ** 2 - dc ** 2) * hc[c.insulation];
  const q_shield = c.shield_mm ? Math.PI * (c.shield_mean_diameter_mm / 1000) * (c.shield_mm / 1000) * hc.Cu : 0.0;
  const q_jacket = c.jacket_mm ? (Math.PI / 4) * (de ** 2 - da ** 2) * hc[c.jacket] : 0.0;
  return { conductor: q_cond, insulation: q_ins, shield: q_shield, jacket: q_jacket, total: q_cond + q_ins + q_shield + q_jacket };
}

/**
 * Outer surface temperature of the enclosure that rejects q W per metre of run (an estimate): two vertical
 * sides (height H), top and bottom (width W); simplified laminar free convection h = C (dT / L)^0.25
 * (C = 1.42 vertical, 1.32 top, 0.59 bottom) plus grey-body radiation to ambient; uniform surface temperature,
 * no ventilation or solar credit; bisection on the surface rise.
 */
export function enclosureSurfaceTemperature(q_w_per_m, w_out_mm, h_out_mm, ambient_c, emissivity) {
  const cv = DATA.enclosure_convection;
  const sigma = cv.stefan_boltzmann;
  const w_m = w_out_mm / 1000, h_m = h_out_mm / 1000;
  const ta = ambient_c + 273.15;
  const parts = (rise) => {
    const ts = ta + rise;
    const conv_v = cv.c_vertical * (rise / h_m) ** 0.25 * (2 * h_m) * rise;
    const conv_t = cv.c_top * (rise / w_m) ** 0.25 * w_m * rise;
    const conv_b = cv.c_bottom * (rise / w_m) ** 0.25 * w_m * rise;
    const rad = emissivity * sigma * (ts ** 4 - ta ** 4) * (2 * h_m + 2 * w_m);
    return [conv_v + conv_t + conv_b, rad];
  };
  let lo = 0.0, hi = 400.0;
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2;
    const [c_, r_] = parts(mid);
    if (c_ + r_ < q_w_per_m) lo = mid; else hi = mid;
  }
  const rise = (lo + hi) / 2;
  const [c_, r_] = parts(rise);
  const area = 2 * h_m + 2 * w_m;
  return {
    rise_k: rise, surface_c: ambient_c + rise, q_convection_w_per_m: c_, q_radiation_w_per_m: r_,
    h_rad_w_per_m2_k: rise > 0 ? r_ / area / rise : 0.0, h_conv_avg_w_per_m2_k: rise > 0 ? c_ / area / rise : 0.0,
    perimeter_m: area,
  };
}

export function simulateTemperatureRise(sim, ctx = null) {
  const bus = sim.bus;
  if (sim.load_scale <= 0) throw new Error("load_scale must be > 0");
  for (const nm of ["rise_limit_conductor_k", "rise_limit_enclosure_k", "rise_limit_termination_k"]) {
    if (!isNull(sim[nm]) && sim[nm] <= 0) throw new Error(`${nm} must be > 0`);
  }
  if (!isNull(sim.enclosure_emissivity) && !(sim.enclosure_emissivity > 0 && sim.enclosure_emissivity <= 1)) {
    throw new Error("enclosure_emissivity must be in (0, 1]");
  }
  ctx = ctx || buildContext(bus);
  const { inp, cs, res, od, phase_idx } = ctx;
  const cons = simConstruction(inp, od);
  const pitch = ctx.result.pitch_mm;
  const installation = installationFor(pitch, od);
  const ambient = inp.ambient_c;
  const labels = {};
  cs.forEach((c, i) => { labels[c.label] = i; });
  const shieldLambda1 = (i) => {
    const core_loss = res.losses_w_per_m[i];
    const s = labels[`S-${cs[i].label}`];
    return s !== undefined && core_loss ? pyRound(res.losses_w_per_m[s] / core_loss, 4) : 0.0;
  };
  const ampCache = new Map();
  const cables = [];
  let heat_cables = 0.0;
  for (const i of phase_idx) {
    const lam = shieldLambda1(i);
    const cur = cabs(res.currents[i]) * sim.load_scale;
    const ss = steadyStateCable(cons, cur, ambient, { installation, lambda1: lam, freq: inp.frequency_hz, spacing_mm: pitch });
    if (!ampCache.has(lam)) {
      ampCache.set(lam, freeAirAmpacity(cons, ambient,
        { installation, lambda1: lam, freq: inp.frequency_hz, spacing_mm: pitch }).ampacity_a);
    }
    heat_cables += ss.heat_w_per_m;
    cables.push({
      index: i, phase: cs[i].group, x_mm: pyRound(cs[i].x_mm, 1), y_mm: pyRound(cs[i].y_mm, 1), current_a: cur,
      lambda1: lam, ampacity_a: ampCache.get(lam), theta_c: ss.theta_c, rise_k: ss.theta_c - ambient,
      surface_c: ss.surface_c, shield_c: ss.shield_c, r_ohm_per_m: ss.r_ohm_per_m, heat_w_per_m: ss.heat_w_per_m,
      conductor_loss_w_per_m: ss.conductor_loss_w_per_m, t4: ss.t4,
    });
  }
  const hot = firstMax(cables.map((_, k) => k), (k) => cables[k].theta_c);
  const hc = cables[hot];

  let encl = null;
  const q_encl_induced = (ctx.result.enclosure_loss_w / inp.length_m) * sim.load_scale ** 2;
  const emis = !isNull(sim.enclosure_emissivity) ? sim.enclosure_emissivity : DATA.enclosure_convection.default_emissivity;
  const notes = [];
  if (inp.enclosure_width_mm) {
    const ys = phase_idx.map((i) => cs[i].y_mm);
    const h_in = inp.enclosure_height_mm || (Math.max(...ys) - Math.min(...ys) + 2 * od);
    const w_out = inp.enclosure_width_mm + 2 * inp.side_thickness_mm;
    const h_out = h_in + 2 * inp.cover_thickness_mm;
    const q_total = heat_cables + q_encl_induced;
    encl = enclosureSurfaceTemperature(q_total, w_out, h_out, ambient, emis);
    Object.assign(encl, { q_total_w_per_m: q_total, q_induced_w_per_m: q_encl_induced, emissivity: emis,
      width_out_mm: w_out, height_out_mm: h_out });
  } else {
    notes.push("Enclosure estimate skipped: give enclosure_width_mm (and height) to include it.");
  }

  const caps = heatCapacityJPerMK(cons);
  const r_th = hc.heat_w_per_m > 0 ? (hc.theta_c - ambient) / hc.heat_w_per_m : 0.0;
  const tau = caps.total * r_th;
  const rise_inf = hc.theta_c - ambient;
  const n_w = 100;
  const t_w = Array.from({ length: n_w + 1 }, (_, k) => (5 * tau * k) / n_w);
  const th_w = t_w.map((t) => (tau > 0 ? ambient + rise_inf * (1 - Math.exp(-t / tau)) : hc.theta_c));
  const warm = {
    t_s: t_w, temp_c: th_w, tau_s: tau, r_th_k_m_per_w: r_th, capacity_j_per_m_k: caps,
    t95_s: tau > 0 ? -tau * Math.log(0.05) : 0.0, rise_inf_k: rise_inf,
  };

  const checks = [mkCheck("Hottest conductor within the insulation temperature rating", "insulation rating",
    hc.theta_c, Number(inp.insulation_temp_c), "C", hc.theta_c <= inp.insulation_temp_c,
    `at ${pyFixed(sim.load_scale * 100, 0)} % of design current, ambient ${pyG(ambient)} C, free-air thermal model ` +
    "[UNVERIFIED constants]")];
  const lc = sim.rise_limit_conductor_k;
  checks.push(mkCheck("Hottest conductor rise within the test-report conductor rise limit", CLAUSE_TR, hc.rise_k,
    isNull(lc) ? null : lc, "K", isNull(lc) ? null : hc.rise_k <= lc,
    `rise above ${pyG(ambient)} C ambient; ` + (isNull(lc) ? ENTER : "limit from test report")));
  const le = sim.rise_limit_enclosure_k;
  const ENCL_NAME = "Accessible enclosure surface rise within the test-report limit";
  if (encl === null) {
    checks.push(mkCheck(ENCL_NAME, CLAUSE_TR, null, isNull(le) ? null : le, "K", null,
      "enclosure not modelled (give enclosure_width_mm)"));
  } else {
    checks.push(mkCheck(ENCL_NAME, CLAUSE_TR, encl.rise_k, isNull(le) ? null : le, "K",
      isNull(le) ? null : encl.rise_k <= le,
      "estimate (convection + radiation, no ventilation credit); " + (isNull(le) ? ENTER : "limit from test report")));
  }
  const lt = sim.rise_limit_termination_k, rt = sim.termination_rise_k;
  checks.push(mkCheck("Termination rise within the test-report limit", CLAUSE_TR, isNull(rt) ? null : rt,
    isNull(lt) ? null : lt, "K", (isNull(lt) || isNull(rt)) ? null : rt <= lt,
    "termination rise is not simulated; enter an estimate or the tested rise" + (!isNull(lt) ? "" : " and the limit")));
  const [passed, complete] = verdict(checks);
  notes.push(
    "Steady state: IEC 60287 / Neher-McGrath free-air circuit solved forward at each cable's own current " +
    "(current sharing from the impedance solve); mutual heating between cables and tiers is not included.",
    "Enclosure surface temperature is an estimate from a lumped heat balance; the temperature-rise type test is " +
    "the certification basis.",
    "Warm-up is a simplified one-node model: tau = C x R, C = conductor + insulation + shield + jacket thermal " +
    "capacitance, R = conductor-to-ambient resistance at the operating point; the enclosure's own thermal mass is " +
    "ignored, so real warm-up of the enclosure is slower.",
    "Rise limits are user inputs from the test report; C37.23 / CSA 273 limit values were not available.",
  );
  const dataStatus = [
    userRow("Conductor rise limit", sim.rise_limit_conductor_k, "K"),
    userRow("Enclosure (accessible surface) rise limit", sim.rise_limit_enclosure_k, "K"),
    userRow("Termination rise limit", sim.rise_limit_termination_k, "K"),
    userRow("Termination rise estimate", sim.termination_rise_k, "K"),
    statusRow("IEC 60287 thermal constants (T1, T4 air, dielectric)", "thermal.py tables", "UNVERIFIED",
      "IEC 60287-1-1 / -2-1 from memory"),
    statusRow("Volumetric heat capacities", "Cu 3.45, Al 2.5, XLPE/EPR 2.4, PVC 1.7 MJ/m3K", "UNVERIFIED",
      DATA.volumetric_heat_capacity_j_per_m3_k._meta.url),
    statusRow("Enclosure convection correlations", "C = 1.42 / 1.32 / 0.59", "UNVERIFIED", DATA.enclosure_convection._meta.url),
    statusRow("Enclosure emissivity", pyG(emis), !isNull(sim.enclosure_emissivity) ? "USER" : "FLAGGED DEFAULT",
      isNull(sim.enclosure_emissivity) ? "set the enclosure finish" : "entered"),
  ];
  return {
    ambient_c: ambient, load_scale: sim.load_scale, installation, cables, hottest_index: hot, hottest: hc,
    enclosure: encl, warmup: warm, checks, passed, complete, notes, data_status: dataStatus,
    max_theta_c: hc.theta_c, min_theta_c: Math.min(...cables.map((c) => c.theta_c)),
  };
}

/** Both simulations on one solve. The short circuit part needs bus.fault_ka. */
export function simulate(sim) {
  const ctx = buildContext(sim.bus);
  const out = { temperature: simulateTemperatureRise(sim, ctx) };
  out.short_circuit = sim.bus.fault_ka ? simulateShortCircuit(sim, ctx) : null;
  return out;
}
