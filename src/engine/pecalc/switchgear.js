/* Switchgear / switchboard bus: current distribution, temperature rise, bracing.
   Port of pecalc/switchgear.py. Pure module: no DOM, no React.

   Rectangular bars (one or more laminations per phase) are split into filaments and solved with the
   multi-conductor impedance model, so skin and proximity effects and the current split between
   laminations come out of the same engine used for cable bus. Then:

   - Temperature rise: steady heat balance per phase pack, natural convection (simplified air
     correlations, Holman / McAdams: vertical 1.42 (dT/L)^0.25, heated face up 1.32 (dT/L)^0.25,
     heated face down 0.59 (dT/L)^0.25 W/m2K) plus radiation from the outer envelope. Inner lamination
     faces are counted at 50 % for convection and 0 % for radiation [UNVERIFIED approximation].
   - Short-circuit: time-domain forces on each phase pack (shared force solver), then beam bending of
     the bars between supports and the support reaction (3+ equal continuous spans: M = F L^2 / 10,
     R = 1.1 F L; single span pinned: F L^2 / 8, R = F L / 2; fixed-fixed: F L^2 / 12, R = F L / 2),
     the same structure as IEEE 605's span equation.

   Temperature-rise limits (UL 891, ANSI C37.20.1/.2/.3) were not verified during research, so the
   allowable rise is an input with a flagged default.

   Result objects use the same snake_case field names as the Python dataclasses. */
import { N_PER_M_TO_LBF_PER_FT, faultForces } from "./forces.js";
import { conductor, balancedThreePhase, solveSharing } from "./impedance.js";
import { pyRound, pyFixed, cdiv, lookup } from "./util.js";
import * as validate from "./validate.js";

export const SIGMA = 5.670e-8;
// Resistivity at 20 C (ohm m) and temperature coefficient. [UNVERIFIED: handbook
// values for C11000 (101 % IACS) and 6101-T61 (57 % IACS)]
export const BAR_MATERIALS = { Cu: [1.7241e-8 / 1.01, 0.00393], Al: [3.02e-8, 0.00403] };
// Typical yield strength, MPa [UNVERIFIED: supplier data varies by temper; give your own]
export const YIELD_MPA = { Cu: 200.0, Al: 165.0 };
// Surface emissivity by finish [UNVERIFIED typical values]
export const EMISSIVITY = { bare: 0.4, tin: 0.3, silver: 0.1, painted: 0.9 };
export const SPAN = { continuous: [10.0, 1.1], pinned: [8.0, 0.5], fixed: [12.0, 0.5] };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const truthy = (v) => v !== null && v !== undefined && v !== 0 && !Number.isNaN(v);
/** Python str(float): integers print with a trailing ".0" (the Python inputs are floats). */
const pyNum = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** BusInput defaults (Python dataclass BusInput); null stands for None. */
export function busInput(overrides = {}) {
  const inp = {
    current_a: 2000.0,
    voltage_v: 600.0,
    standard: "UL 891",
    material: "Cu",
    bar_thickness_mm: 6.35,
    bar_width_mm: 101.6,
    bars_per_phase: 2,
    bar_gap_mm: null,             // between laminations; default = thickness
    phase_spacing_mm: 150.0,      // centre-to-centre between phase packs
    orientation: "face_to_face",  // bar faces toward the next phase (weak axis loaded) or "edge_to_edge"
    finish: "tin",
    ambient_c: 40.0,
    internal_air_rise_c: 0.0,     // enclosure air above room ambient
    max_rise_c: 65.0,             // [UNVERIFIED default; confirm against UL 891 / C37.20.x]
    frequency_hz: 60.0,
    filaments_thickness: null,    // null: adapt to skin depth
    filaments_width: null,
    fault_ka: null,
    x_over_r: 15.0,
    support_span_m: 0.6,
    support_condition: "continuous",
    yield_mpa: null,
    support_rating_n: null,       // rated cantilever / working load of one support
  };
  for (const k of Object.keys(overrides)) {
    if (!(k in inp)) throw new TypeError(`BusInput got an unexpected field '${k}'`);
    if (overrides[k] !== undefined) inp[k] = overrides[k];
  }
  return inp;
}

export function skin_depth_mm(material, temp_c, freq) {
  const [rho20, alpha] = lookup(BAR_MATERIALS, material);
  const rho = rho20 * (1 + alpha * (temp_c - 20));
  return Math.sqrt(rho / (Math.PI * freq * 4e-7 * Math.PI)) * 1000;
}

/** Filaments per bar: about one skin depth across the width, >= 2 across thickness. Returns [nt, nw]. */
export function mesh(inp, temp_c) {
  const d = skin_depth_mm(inp.material, temp_c, inp.frequency_hz);
  const nt = truthy(inp.filaments_thickness) ? inp.filaments_thickness : Math.min(4, Math.max(2, Math.ceil(inp.bar_thickness_mm / d) + 1));
  const nw = truthy(inp.filaments_width) ? inp.filaments_width : Math.min(24, Math.max(4, Math.ceil(inp.bar_width_mm / d)));
  return [nt, nw];
}

/** Filament conductors for the three phase packs. Returns {cs, bodies} (bodies: index -> phase name). */
export function layout(inp, nt, nw, temp_c) {
  const [rho20, alpha] = BAR_MATERIALS[inp.material];
  const rho = rho20 * (1 + alpha * (temp_c - 20));
  const t = inp.bar_thickness_mm, w = inp.bar_width_mm;
  const gap = inp.bar_gap_mm !== null ? inp.bar_gap_mm : t;
  const n = inp.bars_per_phase;
  const dt = t / nt, dw = w / nw;
  const r_fil = rho / (dt * dw * 1e-6);
  const gmr = 0.2235 * (dt + dw);
  const cs = [], bodies = {};
  ["A", "B", "C"].forEach((ph, p) => {
    const xc = p * inp.phase_spacing_mm;
    const pack = n * t + (n - 1) * gap;
    for (let b = 0; b < n; b++) {
      const off = -pack / 2 + t / 2 + b * (t + gap);
      for (let i = 0; i < nt; i++) {
        for (let j = 0; j < nw; j++) {
          const u = -t / 2 + (i + 0.5) * dt;   // across thickness
          const v = -w / 2 + (j + 0.5) * dw;   // across width
          let x, y;
          if (inp.orientation === "face_to_face") { x = xc + off + u; y = v; }   // thickness along x, width along y
          else { x = xc + v; y = off + u; }                                       // width along x, laminations stacked in y
          bodies[cs.length] = ph;
          cs.push(conductor({ x_mm: x, y_mm: y, group: ph, r_ohm_per_m: r_fil, gmr_mm: gmr, label: `${ph}${b}.${i}.${j}` }));
        }
      }
    }
  });
  return { cs, bodies };
}

/** Heat a phase pack can shed (W/m) at a given surface rise above local air. */
export function dissipation_w_per_m(inp, rise) {
  const t = inp.bar_thickness_mm / 1000, w = inp.bar_width_mm / 1000, n = inp.bars_per_phase;
  const gap = (inp.bar_gap_mm !== null ? inp.bar_gap_mm : inp.bar_thickness_mm) / 1000;
  const pack = n * t + (n - 1) * gap;
  if (rise <= 0) return 0.0;
  const air = inp.ambient_c + inp.internal_air_rise_c + 273.15;
  const tb = air + rise;
  let conv, inner;
  const outer_perim = 2 * (w + pack);
  if (inp.orientation === "face_to_face") {   // big faces vertical (height w), pack thickness horizontal
    const h_v = 1.42 * (rise / w) ** 0.25;
    conv = 2 * w * h_v * rise + pack * (1.32 + 0.59) * (rise / pack) ** 0.25 * rise;
    inner = 2 * (n - 1) * w * h_v * rise * 0.5;
  } else {                                     // big faces horizontal (width w), pack height vertical
    conv = (w * 1.32 + w * 0.59) * (rise / w) ** 0.25 * rise + 2 * pack * 1.42 * (rise / pack) ** 0.25 * rise;
    inner = 2 * (n - 1) * w * 0.59 * (rise / w) ** 0.25 * rise * 0.5;
  }
  const rad = lookup(EMISSIVITY, inp.finish) * SIGMA * outer_perim * (tb ** 4 - air ** 4);
  return conv + inner + rad;
}

/** Solve loss(rise) = dissipation(rise) by bisection (loss depends on temperature). */
export function rise_for_loss(inp, loss_at) {
  let lo = 0.0, hi = 400.0;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (dissipation_w_per_m(inp, mid) < loss_at(mid)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function analyseBus(inp) {
  if (!has(BAR_MATERIALS, inp.material)) throw new Error("material must be Cu or Al");
  if (inp.orientation !== "face_to_face" && inp.orientation !== "edge_to_edge") throw new Error("orientation must be face_to_face or edge_to_edge");
  if (!has(EMISSIVITY, inp.finish)) throw new Error(`finish must be one of [${Object.keys(EMISSIVITY).sort().map((s) => `'${s}'`).join(", ")}]`);
  validate.voltage("voltage_v", inp.voltage_v);
  validate.xOverR("x_over_r", inp.x_over_r);
  if (inp.fault_ka !== null && inp.fault_ka !== undefined && inp.fault_ka <= 0) {
    throw new Error(`fault_ka must be greater than 0 kA, got ${validate.reprValue(inp.fault_ka)}`);
  }
  const [rho20, alpha] = BAR_MATERIALS[inp.material];
  const notes = [];
  const air0 = inp.ambient_c + inp.internal_air_rise_c;

  // Current distribution at an assumed temperature, then refine once.
  let temp = air0 + inp.max_rise_c;
  let nt, nw, cs, res, k_loss, t_solve, loss_at, rise;
  for (let it = 0; it < 2; it++) {
    [nt, nw] = mesh(inp, temp);
    ({ cs } = layout(inp, nt, nw, temp));
    res = solveSharing(cs, balancedThreePhase(1.0, 1.0), inp.frequency_hz);
    // Loss per phase pack per A^2, at this temperature (worst phase).
    const kl = Math.max(...["A", "B", "C"].map((ph) => {
      let s = 0;
      res.losses_w_per_m.forEach((p, i) => { if (cs[i].group === ph) s += p; });
      return s;
    }));
    const ts = temp;
    k_loss = kl; t_solve = ts;
    loss_at = (r) => {
      const t_b = air0 + r;
      return kl * inp.current_a ** 2 * (1 + alpha * (t_b - 20)) / (1 + alpha * (ts - 20));
    };
    rise = rise_for_loss(inp, loss_at);
    temp = air0 + rise;
  }

  const area = inp.bars_per_phase * inp.bar_thickness_mm * inp.bar_width_mm * 1e-6;
  const rdc = rho20 * (1 + alpha * (t_solve - 20)) / area;
  const rac_rdc = k_loss / rdc;
  const loss_pp = loss_at(rise);

  // Rated current at the rise limit: loss(limit) = dissipation(limit).
  const t_lim = air0 + inp.max_rise_c;
  const k_lim = k_loss * (1 + alpha * (t_lim - 20)) / (1 + alpha * (t_solve - 20));
  const i_rated = Math.sqrt(dissipation_w_per_m(inp, inp.max_rise_c) / k_lim);

  // Lamination share (phase A).
  const shares = [];
  for (let b = 0; b < inp.bars_per_phase; b++) {
    let re = 0, im = 0;
    cs.forEach((c, i) => { if (c.label.startsWith(`A${b}.`)) { re += res.currents[i].re; im += res.currents[i].im; } });
    shares.push(pyRound(Math.hypot(re, im) * inp.bars_per_phase * 100, 1));
  }

  const checks = [{
    name: "Temperature rise at rated current", clause: `${inp.standard} [limit UNVERIFIED]`,
    value: pyRound(rise, 1), limit: inp.max_rise_c, unit: "C", passed: rise <= inp.max_rise_c,
    note: `ambient ${pyNum(inp.ambient_c)} C + internal air ${pyNum(inp.internal_air_rise_c)} C, finish ${inp.finish}`,
  }];

  let force = null, stress = null, support = null, span_max = null;
  if (truthy(inp.fault_ka)) {
    const { cs: fcs, bodies: fb } = layout(inp, 1, Math.max(2, Math.floor(nw / 2)), temp);
    const fres = solveSharing(fcs, balancedThreePhase(1.0, 1.0), inp.frequency_hz);
    const share = {};
    fcs.forEach((c, i) => { share[i] = cdiv(fres.currents[i], fres.groups[c.group].current); });
    const fr = faultForces(fcs, share, inp.fault_ka, inp.x_over_r, {
      freq: inp.frequency_hz, steps_per_cycle: 48, angle_steps: 12, bodies: fb,
    });
    force = Math.max(...Object.values(fr.body_peak_n_per_m));
    const fx = Math.max(...Object.values(fr.body_peak_xy).map((v) => v[0]));
    const [k_m, k_r] = lookup(SPAN, inp.support_condition);
    const L = inp.support_span_m;
    const t = inp.bar_thickness_mm / 1000, w = inp.bar_width_mm / 1000, n = inp.bars_per_phase;
    // Force between phases acts along x. face_to_face loads the bar's weak axis.
    const s_mod = n * (inp.orientation === "face_to_face" ? w * t ** 2 / 6 : t * w ** 2 / 6);
    stress = fx * L ** 2 / k_m / s_mod / 1e6;
    support = force * L * k_r;
    const allow = truthy(inp.yield_mpa) ? inp.yield_mpa : YIELD_MPA[inp.material];
    span_max = Math.sqrt(k_m * s_mod * allow * 1e6 / fx);
    checks.push({
      name: "Bar bending stress between supports", clause: "beam theory / IEEE 605 span method",
      value: pyRound(stress, 1), limit: allow, unit: "MPa", passed: stress <= allow,
      note: `${inp.support_condition} spans of ${pyNum(L)} m; max span ${pyFixed(span_max, 3)} m; ` +
        `yield ${truthy(inp.yield_mpa) ? "given" : "typical [UNVERIFIED]"}`,
    });
    if (truthy(inp.support_rating_n)) {
      checks.push({
        name: "Support / insulator load", clause: "manufacturer rating",
        value: pyRound(support, 0), limit: inp.support_rating_n, unit: "N", passed: support <= inp.support_rating_n,
      });
    }
    notes.push(`Fault ${pyNum(inp.fault_ka)} kA rms sym, X/R ${pyNum(inp.x_over_r)}: first peak ${pyFixed(fr.peak_current_ka, 1)} kA; ` +
      `peak force on a phase pack ${pyFixed(force, 0)} N/m (${pyFixed(force * N_PER_M_TO_LBF_PER_FT, 0)} lbf/ft); ` +
      `support load ${pyFixed(support, 0)} N (${pyFixed(support / 4.448, 0)} lbf). Static method (no dynamic ` +
      "amplification); IEEE 605 / EPRI note static results are conservative for rigid bus.");
  }

  notes.push(`Rac/Rdc ${pyFixed(rac_rdc, 3)} from the filament model (${nt} x ${nw} filaments per bar, skin depth ` +
    `${pyFixed(skin_depth_mm(inp.material, temp, inp.frequency_hz), 1)} mm).`);
  notes.push("Temperature rise uses still-air natural convection and radiation; enclosure air rise must be given " +
    "(internal_air_rise_c). Confirm by test per the product standard.");
  return {
    input: inp,
    rac_over_rdc: pyRound(rac_rdc, 4),
    lamination_share_pct: shares,
    loss_w_per_m_per_phase: pyRound(loss_pp, 2),
    rise_c: pyRound(rise, 1),
    rated_current_at_limit_a: pyRound(i_rated, 0),
    peak_force_n_per_m: force === null ? null : pyRound(force, 1),
    bending_stress_mpa: stress === null ? null : pyRound(stress, 1),
    support_load_n: support === null ? null : pyRound(support, 1),
    max_span_m: span_max === null ? null : pyRound(span_max, 3),
    checks,
    notes,
    passed: checks.every((c) => c.passed),
  };
}
