/* Virtual short-circuit lab test for a cable bus: pass/fail criteria evaluated per time step on top of the
   existing simulation functions (cablebusSim.js, forces.js, conductors.js). Pure module, no DOM, no React.

   Criteria (each checked at every sample, the first crossing sets the failure time):
     block     support block load / strength >= 1. Strength is the user's tested block load when entered,
               otherwise the designer's web-stress screening allowable (tensile / safety factor x thickness x
               ligament, BLOCK_MATERIALS, UNVERIFIED).
     force     conductor force per metre / tested force per metre >= 1 (only when entered).
     thermal   adiabatic conductor temperature (ICEA P-32-382 closed form, conductors.adiabaticTemperatureC)
               reaches the damage temperature (default: the insulation short-circuit limit of the design).
   Force and block load scale with I^2 at fixed X/R and closing angle, so the block / force failure current is
   I_test / sqrt(peak ratio); the thermal failure current is found by bisection on current.

   SCREENING LEVEL ONLY: block strength is screening data (status UNVERIFIED), the loads are static force x span,
   and no value comes from CSA C22.2 No. 273 or IEEE C37.23 (licensed, not read). It is not a substitute for a
   type test. */
import * as cond from "./pecalc/conductors.js";
import { cableBusInput, PHASES } from "./pecalc/cablebus.js";
import { buildContext, worstClosingAngle, faultForceWaveforms, i2tClosedForm } from "./pecalc/cablebusSim.js";
import { BLOCK_MATERIALS } from "./pecalc/cablebus_design.js";
import { forceGeometry, forcesAt } from "./pecalc/forces.js";
import { cabs, toC } from "./pecalc/util.js";
import * as validate from "./pecalc/validate.js";
import DATA from "./data/sc_lab_test.json" with { type: "json" };

export { DATA as LAB_DATA, buildContext };
export const LAB_STATUS = "UNVERIFIED";
export const SCREENING_NOTE = "Screening level: block strength comes from the designer's screening data (status UNVERIFIED) or the tested rating you enter; loads are static force x span. Not a substitute for a CSA C22.2 No. 273 / IEEE C37.23 type test.";
export const MODE_LABEL = { block: "block web stress", force: "conductor force", thermal: "conductor temperature" };
const MAX_STEPS = 12000;
const isNull = (v) => v === null || v === undefined;

const _DEFAULTS = {
  test_ka: null, x_over_r: null, duration_s: 0.5, closing_angle_deg: null,
  block_material: "GPO-3", block_thickness_mm: 25.4, block_safety_factor: 2.0,
  tested_block_load_n: null, tested_force_n_per_m: null,
  damage_temp_c: null, initial_temp_c: null, n_spans: 3, steps_per_cycle: 96,
};

export function labInput(overrides = {}) {
  const { bus = {}, ...rest } = overrides;
  for (const k of Object.keys(rest)) {
    if (!Object.prototype.hasOwnProperty.call(_DEFAULTS, k)) throw new TypeError(`labInput() got an unexpected keyword argument '${k}'`);
  }
  return { bus: cableBusInput(bus), ..._DEFAULTS, ...rest };
}

function check(L) {
  if (!(L.test_ka > 0)) throw new Error("test current must be > 0 kA");
  if (!(L.duration_s > 0)) throw new Error("test duration must be > 0 s");
  if (!(L.n_spans >= 1)) throw new Error("n_spans must be >= 1");
  if (!(L.block_safety_factor > 0) || !(L.block_thickness_mm > 0)) throw new Error("block thickness and safety factor must be > 0");
  for (const k of ["tested_block_load_n", "tested_force_n_per_m"]) if (!isNull(L[k]) && !(L[k] > 0)) throw new Error(`${k} must be > 0`);
  if (L.block_material && !BLOCK_MATERIALS[L.block_material]) throw new Error(`unknown block material ${L.block_material}`);
}

/** Sample grid for a duration: steps per cycle is reduced for very long tests so the grid stays under MAX_STEPS. */
export function gridInfo(duration_s, f, steps_per_cycle = 96) {
  const cycles = duration_s * f;
  let spc = Math.max(8, Math.trunc(steps_per_cycle));
  if (cycles * spc > MAX_STEPS) spc = Math.max(24, Math.floor(MAX_STEPS / cycles));
  const n_t = Math.trunc(cycles * spc) + 1;
  return { cycles, steps_per_cycle: spc, n_t, t_last_s: (n_t - 1) / (spc * f) };
}

function limits(ctx, L) {
  const lig = Math.min(ctx.result.pitch_mm - ctx.od, ctx.od);
  const mat = L.block_material ? BLOCK_MATERIALS[L.block_material] : null;
  const allow_mpa = mat ? mat.tensile / L.block_safety_factor : null;
  const screening_n = allow_mpa === null ? null : allow_mpa * L.block_thickness_mm * lig;
  const tested = L.tested_block_load_n;
  const block_limit_n = !isNull(tested) ? tested : screening_n;
  const t0 = !isNull(L.initial_temp_c) ? L.initial_temp_c : Number(ctx.inp.insulation_temp_c);
  const damage_c = !isNull(L.damage_temp_c) ? L.damage_temp_c : ctx.inp.insulation_sc_limit_c;
  return {
    ligament_mm: lig, allow_mpa, screening_limit_n: screening_n, block_limit_n,
    block_basis: block_limit_n === null ? "none" : !isNull(tested) ? "tested block rating" : `${L.block_material} web-stress screening`,
    t0, damage_c,
  };
}

const xrOf = (ctx, L) => (isNull(L.x_over_r) ? ctx.inp.x_over_r : L.x_over_r);

/** Peak mechanical ratios over the test window at a given current. */
function mechPeaks(ctx, L, ka, alpha, lim) {
  const g = gridInfo(L.duration_s, ctx.inp.frequency_hz, L.steps_per_cycle);
  const wf = faultForceWaveforms(ctx.cs, ctx.share, ka, xrOf(ctx, L), ctx.inp.frequency_hz,
    { closing_angle_rad: alpha, cycles: g.cycles, steps_per_cycle: g.steps_per_cycle });
  const span = ctx.inp.support_span_m;
  const peak_force = Math.max(...wf.force_envelope_n_per_m);
  return {
    wf, grid: g, peak_force_n_per_m: peak_force,
    block_ratio: lim.block_limit_n === null ? null : (peak_force * span) / lim.block_limit_n,
    force_ratio: isNull(L.tested_force_n_per_m) ? null : peak_force / L.tested_force_n_per_m,
  };
}

function thermalSetup(ctx, L, alpha) {
  const f = ctx.inp.frequency_hz, x = xrOf(ctx, L), phi = Math.atan(x);
  const area = cond.AREA_CMIL[ctx.inp.size];
  return ctx.phase_idx.map((i) => {
    const s = toC(ctx.share[i]);
    const k = PHASES.indexOf(ctx.cs[i].group);
    return { i, th: alpha - phi - (2 * Math.PI * k) / 3 + Math.atan2(s.im, s.re), mag: cabs(s), area, f, x };
  });
}
const tempOf = (ctx, c, ka, t0, t) => {
  const amp = Math.sqrt(2) * ka * 1000;
  return cond.adiabaticTemperatureC(ctx.inp.material, c.area, t0, i2tClosedForm(c.mag * amp, c.th, t, c.f, c.x));
};
/** Hottest conductor temperature at the end of the sample grid for a test current, C. */
export function thermalPeakC(ctx, L, ka, alpha, t0) {
  const t = gridInfo(L.duration_s, ctx.inp.frequency_hz, L.steps_per_cycle).t_last_s;
  let m = -Infinity;
  for (const c of thermalSetup(ctx, L, alpha)) m = Math.max(m, tempOf(ctx, c, ka, t0, t));
  return m;
}

/** Indicative static deflection of a fixed-fixed beam of the solid-equivalent conductor, mm (label scale only). */
export function staticDeflectionMm(force_n_per_m, span_m, size, material) {
  const e = DATA.youngs_modulus_gpa[material === "Cu" ? "Cu" : "Al"].value * 1e9;
  const d = cond.diameterMm(size) / 1000;
  const i = (Math.PI * d ** 4) / 64;
  return ((force_n_per_m * span_m ** 4) / (384 * e * i)) * 1000;
}

function crossing(r, t) {
  for (let k = 0; k < r.length; k++) {
    if (r[k] >= 1) {
      if (k === 0) return { k, t: t[0] };
      return { k, t: t[k - 1] + ((1 - r[k - 1]) / (r[k] - r[k - 1])) * (t[k] - t[k - 1]) };
    }
  }
  return null;
}

/** Run the virtual test. Returns series, per-step ratios, failure (or null), verdict and notes. */
export function runLabTest(L, ctx = null) {
  check(L);
  ctx = ctx || buildContext(L.bus);
  const f = ctx.inp.frequency_hz, x = xrOf(ctx, L);
  validate.xOverR("x_over_r", x);
  const lim = limits(ctx, L);
  if (!(lim.damage_c > lim.t0)) throw new Error("damage temperature must be above the initial conductor temperature");
  const span = ctx.inp.support_span_m;
  const worst = worstClosingAngle(ctx.cs, ctx.share, L.test_ka, x, f);
  const alpha = isNull(L.closing_angle_deg) ? worst[1] : (L.closing_angle_deg * Math.PI) / 180;
  const mp = mechPeaks(ctx, L, L.test_ka, alpha, lim);
  const { wf, grid } = mp;
  const t = wf.t_s, n = t.length;
  const env = wf.force_envelope_n_per_m;

  const block_ratio = lim.block_limit_n === null ? null : env.map((e) => (e * span) / lim.block_limit_n);
  const force_ratio = isNull(L.tested_force_n_per_m) ? null : env.map((e) => e / L.tested_force_n_per_m);

  const setup = thermalSetup(ctx, L, alpha);
  const temp_c = {};
  const span_k = lim.damage_c - lim.t0;
  for (const c of setup) temp_c[c.i] = t.map((tt) => tempOf(ctx, c, L.test_ka, lim.t0, tt));
  const heat_ratio = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    let m = -Infinity;
    for (const c of setup) m = Math.max(m, temp_c[c.i][k]);
    heat_ratio[k] = (m - lim.t0) / span_k;
  }
  const geo = forceGeometry(ctx.cs, ctx.phase_idx);
  const fx = {}, fy = {};
  for (const i of ctx.phase_idx) { fx[i] = new Float64Array(n); fy[i] = new Float64Array(n); }
  for (let k = 0; k < n; k++) {
    const inst = {};
    for (const i of ctx.phase_idx) inst[i] = wf.conductor_current_a[i][k];
    const fxy = forcesAt(ctx.phase_idx, geo, inst);
    for (const i of ctx.phase_idx) { fx[i][k] = fxy[i][0]; fy[i][k] = fxy[i][1]; }
  }

  const n_blocks = L.n_spans + 1;
  const block_index = Math.max(1, Math.floor((n_blocks - 1) / 2));
  const cands = [];
  const bc = block_ratio && crossing(block_ratio, t);
  if (bc) cands.push({ mode: "block", ...bc, conductor: wf.worst_index });
  const fc = force_ratio && crossing(force_ratio, t);
  if (fc) cands.push({ mode: "force", ...fc, conductor: wf.worst_index });
  const hot = setup.map((c) => ({ i: c.i, c: crossing(temp_c[c.i].map((v) => (v - lim.t0) / span_k), t) })).filter((h) => h.c);
  if (hot.length) {
    hot.sort((a, b) => a.c.t - b.c.t || a.i - b.i);
    cands.push({ mode: "thermal", ...hot[0].c, conductor: hot[0].i });
  }
  const order = { block: 0, force: 1, thermal: 2 };
  cands.sort((a, b) => a.t - b.t || order[a.mode] - order[b.mode]);
  const c0 = cands[0];
  const failure = c0 ? {
    mode: c0.mode, mode_label: MODE_LABEL[c0.mode], t_s: c0.t, t_ms: c0.t * 1000, sample_index: c0.k,
    conductor_index: c0.conductor, conductor_phase: ctx.cs[c0.conductor].group, block_index, n_blocks,
    basis: c0.mode === "block" ? lim.block_basis : c0.mode === "force" ? "tested force per metre" : `damage temperature ${lim.damage_c} C`,
  } : null;

  const peaks = {
    block: block_ratio ? Math.max(...block_ratio) : null,
    force: force_ratio ? Math.max(...force_ratio) : null,
    thermal: Math.max(...heat_ratio),
  };
  let gov = "thermal", gv = peaks.thermal;
  for (const m of ["block", "force"]) if (peaks[m] !== null && peaks[m] >= gv) { gov = m; gv = peaks[m]; }
  const util = env.map((_, k) => Math.max(block_ratio ? block_ratio[k] : 0, force_ratio ? force_ratio[k] : 0, heat_ratio[k]));
  const peakK = peaks.thermal;

  const notes = [SCREENING_NOTE,
    `Block criterion basis: ${lim.block_basis}${lim.block_limit_n === null ? " (no block material or tested rating: block mode not evaluated)" : ` = ${lim.block_limit_n.toFixed(0)} N per block`}.`,
    "Temperature is adiabatic (no heat loss) from the initial temperature with each conductor's own current share and the DC offset of the closing angle.",
    "Failure time is the first sample crossing, linearly interpolated between samples. Block load is the static force per metre times the support span; there is no dynamic response of the block or conductor in this model.",
    "Animation effects (deflection, fragments, arc flash) are illustrative; the failure time and mode come from the calculation."];
  const dataStatus = [
    { name: "Block strength", value: `${lim.block_basis}${lim.allow_mpa === null ? "" : `, allowable ${lim.allow_mpa.toFixed(1)} MPa at ${lim.ligament_mm.toFixed(1)} mm ligament`}`,
      status: !isNull(L.tested_block_load_n) ? "USER (test report)" : LAB_STATUS, source: "cablebus_design BLOCK_MATERIALS, typical NEMA LI 1 / supplier values" },
    { name: "Conductor damage temperature", value: `${lim.damage_c} C`, status: !isNull(L.damage_temp_c) ? "USER" : LAB_STATUS, source: "insulation short-circuit limit of the design (input); ICEA P-32-382 constants UNVERIFIED" },
    { name: "Force model", value: "2e-7 i1 i2 / d, time domain, solved current sharing", status: LAB_STATUS, source: "IEEE 605 / IEC 60865 physics; no standard text read" },
    { name: "Deflection scale (Young's modulus)", value: `${DATA.youngs_modulus_gpa[ctx.inp.material === "Cu" ? "Cu" : "Al"].value} GPa`, status: LAB_STATUS, source: "handbook value recalled; labels the animation exaggeration only" },
    { name: "Tested force per metre", value: isNull(L.tested_force_n_per_m) ? "NOT SET" : `${L.tested_force_n_per_m} N/m`, status: isNull(L.tested_force_n_per_m) ? "NOT SET" : "USER (test report)", source: "optional criterion" },
  ];
  const phys = staticDeflectionMm(mp.peak_force_n_per_m, span, ctx.inp.size, ctx.inp.material);
  const vis_mm = Math.min(60, 0.35 * ctx.od);
  return {
    test_ka: L.test_ka, x_over_r: x, frequency_hz: f, duration_s: L.duration_s, closing_angle_deg: (alpha * 180) / Math.PI,
    worst_angle_deg: (worst[1] * 180) / Math.PI, span_m: span, n_spans: L.n_spans, n_blocks, block_index,
    grid, t_s: t, phase_current_a: wf.phase_current_a, force_envelope_n_per_m: env, block_load_n: env.map((e) => e * span),
    block_ratio, force_ratio, heat_ratio, utilisation: util, temp_c, fx, fy, phase_idx: ctx.phase_idx,
    worst_index: wf.worst_index, limits: lim, peaks, peak_force_n_per_m: mp.peak_force_n_per_m,
    passed: !failure, failure,
    peak_utilisation: gv, governing_mode: gov, margin_pct: (1 - gv) * 100,
    thermal_margin_k: (1 - peakK) * span_k, peak_temp_c: lim.t0 + peakK * span_k,
    deflection: { physical_mm: phys, visual_mm: vis_mm, exaggeration: phys > 0 ? vis_mm / phys : 1 },
    status: LAB_STATUS, notes, data_status: dataStatus,
  };
}

/** Lowest current at which each criterion is reached within the test duration, same X/R and closing angle. */
export function findFailureCurrent(L, ctx = null) {
  check(L);
  ctx = ctx || buildContext(L.bus);
  const f = ctx.inp.frequency_hz, x = xrOf(ctx, L);
  const lim = limits(ctx, L);
  if (!(lim.damage_c > lim.t0)) throw new Error("damage temperature must be above the initial conductor temperature");
  const alpha = isNull(L.closing_angle_deg) ? worstClosingAngle(ctx.cs, ctx.share, L.test_ka, x, f)[1] : (L.closing_angle_deg * Math.PI) / 180;
  const mp = mechPeaks(ctx, L, L.test_ka, alpha, lim);
  const modes = [];
  if (mp.block_ratio !== null) modes.push({ mode: "block", current_ka: L.test_ka / Math.sqrt(mp.block_ratio), method: "I^2 scaling", basis: lim.block_basis });
  if (mp.force_ratio !== null) modes.push({ mode: "force", current_ka: L.test_ka / Math.sqrt(mp.force_ratio), method: "I^2 scaling", basis: "tested force per metre" });
  let hi = Math.max(L.test_ka, 1e-3), n = 0;
  while (thermalPeakC(ctx, L, hi, alpha, lim.t0) < lim.damage_c && n++ < 80) hi *= 2;
  let lo = 0;
  for (let it = 0; it < 200 && hi - lo > 1e-12 * hi; it++) {
    const mid = (lo + hi) / 2;
    if (thermalPeakC(ctx, L, mid, alpha, lim.t0) >= lim.damage_c) hi = mid; else lo = mid;
  }
  modes.push({ mode: "thermal", current_ka: hi, method: "bisection", basis: `damage ${lim.damage_c} C in ${L.duration_s} s` });
  modes.sort((a, b) => a.current_ka - b.current_ka);
  return { modes, lowest: modes[0], ratio_to_test: modes[0].current_ka / L.test_ka, closing_angle_deg: (alpha * 180) / Math.PI, status: LAB_STATUS, note: SCREENING_NOTE };
}
