/* Transformer preliminary design and application checks (3-phase, core type).
   Port of pecalc/transformer.py. Pure module: no DOM, no React.

   Preliminary electromagnetic design from the classic design equations
   (Say, Sawhney, Kulkarni & Khaparde):

       E = 4.44 f N Bm Ai                (EMF equation)
       Et = K sqrt(kVA)                  (volts per turn, empirical start)
       kVA = 3.33 f Bm Kw J Aw Ai 1e-3   (3-phase output equation, SI units)
       %X = 2 pi f mu0 (N I / Et) Lmt (a + (b1 + b2) / 3) / (h / Kr) x 100   (Rogowski)
       Kr = 1 - (1 - exp(-pi h / W)) / (pi h / W),  W = a + b1 + b2

   then losses, efficiency (including the DOE test load point), regulation,
   secondary fault current, the 2 s short-circuit thermal withstand (IEC
   60076-5 adiabatic formula) and the mean hoop stress in the outer winding.

   Empirical constants are marked [UNVERIFIED] and every one is an input.
   The design is a starting point for detailed design and FEA, not a final one.

   Result objects use the same snake_case field names as the Python dataclasses. */
import * as validate from "./validate.js";

export const MU0 = 4e-7 * Math.PI;
export const STEEL_DENSITY = 7650.0; // kg/m3, grain-oriented electrical steel

// Conductor resistivity at 20 C and inferred zero-resistance temperature.
export const WINDING = { Cu: [1.7241e-8, 234.5], Al: [2.8264e-8, 225.0] };
// Typical CRGO (M4, 0.27 mm) specific core loss at 60 Hz, W/kg vs B (T). [UNVERIFIED]
export const CORE_LOSS_60HZ = [[1.0, 0.35], [1.2, 0.50], [1.3, 0.58], [1.4, 0.68], [1.5, 0.80], [1.6, 0.95],
  [1.7, 1.17], [1.8, 1.50]];
// ANSI standard 3-phase kVA ratings (IEEE C57.12.00 / C57.12.01 practice). [UNVERIFIED list]
export const STANDARD_KVA = [15, 30, 45, 75, 112.5, 150, 225, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 3750,
  5000, 7500, 10000];

/* Python round() semantics (round-half-to-even on the exact binary value). */
function pyRound(x, n = 0) {
  if (!isFinite(x)) return x;
  // toFixed rounds the exact binary value (like Python) but sends exact ties upward; detect a true tie from the
  // exact decimal expansion and round it to even instead.
  if (Math.abs(x) < 1e15) {
    const ex = Math.abs(x).toFixed(Math.min(100, n + 30));
    const tail = ex.slice(ex.indexOf(".") + 1 + n);
    if (/^50*$/.test(tail)) {
      const lo = Math.floor(Math.abs(x) * 10 ** n);
      const even = lo % 2 === 0 ? lo : lo + 1;
      return Math.sign(x) * (n === 0 ? even : Number((even / 10 ** n).toFixed(n)));
    }
  }
  return Number(x.toFixed(n));
}
// Python repr-style number for messages: whole numbers print as floats ("5.0").
const pyNum = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const pct0 = (x) => `${(x * 100).toFixed(0)}%`;
// Python format(x, "g") (six significant digits) and format(x, ".2f") (half-even on exact ties).
const pyG = (x) => {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exp = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    return `${m.replace(/0+$/, "").replace(/\.$/, "")}e${e[0] === "-" ? "-" : "+"}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  const t = x.toPrecision(6);
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
};
const pyFixed2 = (x) => pyRound(x, 2).toFixed(2);
const given = (v) => v !== null && v !== undefined;

export function transformerInput(overrides = {}) {
  const inp = {
    kva: 1500.0,
    hv_v: 13800.0,
    lv_v: 480.0,
    hv_connection: "delta",
    lv_connection: "wye",
    frequency_hz: 60.0,
    kind: "liquid",             // "liquid" or "dry"
    conductor: "Cu",            // winding material (both windings)
    b_max_t: 1.55,
    k_et: 0.45,                 // Et = K sqrt(kVA) [UNVERIFIED: 0.45 Cu / ~0.37 Al, distribution]
    j_lv_a_mm2: 3.0,
    j_hv_a_mm2: 3.0,
    window_ratio: 3.0,          // window height / width
    core_fill: 0.60,            // net iron area / circumscribing-circle d^2 (stepped core) [UNVERIFIED]
    kw: null,                   // window space factor; default 10 / (30 + kV_HV) [UNVERIFIED]
    lv_fill: 0.70,              // conductor fraction of LV winding cross-section (foil/strip)
    hv_fill: 0.45,              // conductor fraction of HV winding cross-section (round/rect wire)
    core_to_lv_mm: 8.0,
    lv_hv_duct_mm: null,        // default 8 + 0.9 kV_HV [UNVERIFIED]
    end_clearance_mm: null,     // winding to yoke; default 15 + 1.2 kV_HV
    phase_gap_mm: null,         // between HV windings of adjacent limbs; default 10 + 0.8 kV_HV
    stray_loss_frac: 0.10,      // stray + eddy as fraction of I2R
    building_factor: 1.25,      // core loss building factor [UNVERIFIED typical]
    reference_temp_c: null,     // load-loss reference; default 85 C liquid / 115 C dry (avg rise + 20)
    target_z_pct: null,
    z_tolerance_pct: 7.5,       // of the specified value [UNVERIFIED: C57.12.00 two-winding tolerance]
    power_factor: 0.9,
    source_mva: null,           // available fault MVA at HV terminals (null: infinite bus)
    source_x_over_r: 10.0,      // utility source X/R at the HV terminals [UNVERIFIED typical; enter the utility's value]
    fault_duration_s: 2.0,      // through-fault thermal duration
    conductor_proof_mpa: 100.0, // 0.2 % proof stress of winding conductor [UNVERIFIED: annealed Cu]
    doe_min_efficiency_pct: null, // from 10 CFR 431.196 for this kVA/BIL (enter from the rule)
  };
  for (const k of Object.keys(overrides)) {
    if (!(k in inp)) throw new TypeError(`TransformerInput got an unexpected field '${k}'`);
    if (overrides[k] !== undefined) inp[k] = overrides[k];
  }
  return inp;
}

// DOE test load point by equipment class. Efficiency standards: 10 CFR 431.196 (a) low-voltage dry-type,
// (b) liquid-immersed, (c) medium-voltage dry-type; class definitions in 10 CFR 431.192 (low-voltage
// dry-type: primary voltage <= 600 V). The per-unit test load (35 % LVDT, 50 % liquid and MVDT) is set by
// the test procedure, Appendix A to Subpart K of Part 431. [UNVERIFIED: paragraph numbers from memory]
export const DOE_TEST_POINT_CITATION = "10 CFR 431.192 / 431.196 / Part 431 Subpart K App. A [UNVERIFIED paragraph]";

/** [DOE equipment class, per-unit test load]. Classified by the primary (input) voltage. */
export function doe_test_point(kind, primary_v) {
  if (kind === "liquid") return ["liquid-immersed", 0.50];
  if (primary_v <= 600) return ["low-voltage dry-type", 0.35];
  return ["medium-voltage dry-type", 0.50];
}

/** Utility source impedance on the transformer base, {re, im} pu: |Z| = kVA/1000 / MVA_sc at angle atan(X/R). */
export function source_impedance_pu(kva, source_mva, x_over_r) {
  if (!source_mva) return { re: 0, im: 0 };
  const mag = kva / 1000 / source_mva;
  const r = mag / Math.hypot(1.0, x_over_r);
  return { re: r, im: r * x_over_r };
}

export function next_standard_kva(load_kva, growth = 1.0) {
  const need = load_kva * growth;
  for (const k of STANDARD_KVA) if (k >= need) return k;
  throw new Error(`${need.toFixed(0)} kVA exceeds the standard list`);
}

export function specific_core_loss(b) {
  const pts = CORE_LOSS_60HZ;
  if (b <= pts[0][0]) return pts[0][1] * (b / pts[0][0]) ** 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [b0, w0] = pts[i], [b1, w1] = pts[i + 1];
    if (b <= b1) return w0 + (w1 - w0) * (b - b0) / (b1 - b0);
  }
  const [b0, w0] = pts[pts.length - 2], [b1, w1] = pts[pts.length - 1];
  return w1 + (w1 - w0) * (b - b1) / (b1 - b0);
}

/* Rogowski factor Kr = 1 - (1 - exp(-x)) / x, x = pi h / W. */
export function rogowski_factor(h, w) {
  const x = Math.PI * h / w;
  return 1 - (1 - Math.exp(-x)) / x;
}

const _phase = (v_ll, conn) => (conn === "delta" ? v_ll : v_ll / Math.sqrt(3));

export function design(inp) {
  if (inp.kind !== "liquid" && inp.kind !== "dry") throw new Error("kind must be liquid or dry");
  if (!(inp.conductor in WINDING)) throw new Error("conductor must be Cu or Al");
  validate.voltage("hv_v", inp.hv_v);
  validate.voltage("lv_v", inp.lv_v);
  validate.powerFactor("power_factor", inp.power_factor);
  validate.clearingTime("fault_duration_s", inp.fault_duration_s);
  validate.xOverR("source_x_over_r", inp.source_x_over_r);
  if (given(inp.source_mva) && inp.source_mva <= 0) {
    throw new Error(`source_mva must be greater than 0 MVA (or None for an infinite bus), got ${validate.reprValue(inp.source_mva)}`);
  }
  if (inp.kva <= 0) throw new Error(`kva must be greater than 0, got ${validate.reprValue(inp.kva)}`);
  const f = inp.frequency_hz, s = inp.kva * 1000;
  const kv_hv = inp.hv_v / 1000;
  const vph_lv = _phase(inp.lv_v, inp.lv_connection), vph_hv = _phase(inp.hv_v, inp.hv_connection);
  const iph_lv = s / 3 / vph_lv, iph_hv = s / 3 / vph_hv;
  const i_line_lv = s / (Math.sqrt(3) * inp.lv_v);

  // Turns and core.
  const et0 = inp.k_et * Math.sqrt(inp.kva);
  const n_lv = Math.max(1, pyRound(vph_lv / et0));
  const et = vph_lv / n_lv;
  const n_hv = pyRound(n_lv * vph_hv / vph_lv);
  const ai = et0 / (4.44 * f * inp.b_max_t);          // net iron area for the target flux density
  const bm = et / (4.44 * f * ai);                    // actual flux density after rounding turns
  const d = Math.sqrt(ai / inp.core_fill);            // core circle diameter
  const kw = inp.kw || 10 / (30 + kv_hv);
  const j_avg = (inp.j_lv_a_mm2 + inp.j_hv_a_mm2) / 2 * 1e6;
  const aw = inp.kva / (3.33 * f * bm * kw * j_avg * ai * 1e-3);
  const hw = Math.sqrt(aw * inp.window_ratio);
  const ww = aw / hw;

  // Windings (LV inner, HV outer).
  const a_lv = iph_lv / inp.j_lv_a_mm2 * 1e-6, a_hv = iph_hv / inp.j_hv_a_mm2 * 1e-6;
  const end = (given(inp.end_clearance_mm) ? inp.end_clearance_mm : 15 + 1.2 * kv_hv) / 1000;
  const h = hw - 2 * end;
  if (h <= 0) throw new Error("Window too short for the end clearances; reduce window_ratio or clearances");
  const b_lv = n_lv * a_lv / (h * inp.lv_fill);
  const b_hv = n_hv * a_hv / (h * inp.hv_fill);
  const c1 = inp.core_to_lv_mm / 1000;
  const duct = (given(inp.lv_hv_duct_mm) ? inp.lv_hv_duct_mm : 8 + 0.9 * kv_hv) / 1000;
  const gap_pp = (given(inp.phase_gap_mm) ? inp.phase_gap_mm : 10 + 0.8 * kv_hv) / 1000;
  const lmt_lv = Math.PI * (d + 2 * c1 + b_lv);
  const lmt_hv = Math.PI * (d + 2 * c1 + 2 * b_lv + 2 * duct + b_hv);
  const lmt_duct = Math.PI * (d + 2 * c1 + 2 * b_lv + duct);
  const width_needed = 2 * (c1 + b_lv + duct + b_hv) + gap_pp;

  // Losses.
  const t_ref = inp.reference_temp_c || (inp.kind === "liquid" ? 85.0 : 115.0);
  const [rho20, t0] = WINDING[inp.conductor];
  const rho = rho20 * (t0 + t_ref) / (t0 + 20);
  const r_lv = rho * n_lv * lmt_lv / a_lv;
  const r_hv = rho * n_hv * lmt_hv / a_hv;
  const i2r = 3 * (iph_lv ** 2 * r_lv + iph_hv ** 2 * r_hv);
  const load_loss = i2r * (1 + inp.stray_loss_frac);
  const centre = ww + d;
  const core_vol = 3 * ai * hw + 2 * ai * (2 * centre + d);
  const core_mass = core_vol * STEEL_DENSITY;
  const nll = core_mass * specific_core_loss(bm) * inp.building_factor;

  // Impedance.
  const w_rad = duct + b_lv + b_hv;
  const kr = rogowski_factor(h, w_rad);
  const x_pct = 2 * Math.PI * f * MU0 * (n_lv * iph_lv / et) * lmt_duct * (duct + (b_lv + b_hv) / 3) / (h / kr) * 100;
  const r_pct = load_loss / s * 100;
  const z_pct = Math.hypot(x_pct, r_pct);
  const x_over_r = x_pct / r_pct;

  // Performance.
  const eff = (load) => {
    const out = s * load * inp.power_factor;
    return out / (out + nll + load_loss * load ** 2) * 100;
  };
  const [doe_class, doe_load] = doe_test_point(inp.kind, inp.hv_v);
  const doe_temp = inp.kind === "liquid" ? 55.0 : 75.0;
  const ll_doe = load_loss * (t0 + doe_temp) / (t0 + t_ref); // I2R-dominated correction [approximation]
  const eff_doe = s * doe_load / (s * doe_load + nll + ll_doe * doe_load ** 2) * 100;
  const sin_phi = Math.sqrt(1 - inp.power_factor ** 2);
  const reg = r_pct * inp.power_factor + x_pct * sin_phi + (x_pct * inp.power_factor - r_pct * sin_phi) ** 2 / 200;

  // Short circuit at LV terminals: source and transformer impedances added as phasors
  // (each with its own X/R), on the transformer kVA base.
  const z_src = source_impedance_pu(inp.kva, inp.source_mva, inp.source_x_over_r);
  const z_tot = { re: r_pct / 100 + z_src.re, im: x_pct / 100 + z_src.im };
  const z_pu = Math.hypot(z_tot.re, z_tot.im);
  const xr_tot = z_tot.im / z_tot.re;
  const isc_lv = i_line_lv / z_pu;
  const kappa = 1.02 + 0.98 * Math.exp(-3 / xr_tot);
  const i_peak = Math.sqrt(2) * kappa * isc_lv;
  // Thermal: IEC 60076-5 adiabatic winding temperature after the fault.
  const t1 = t_ref;
  const jsc = (iph_lv / z_pu) / (a_lv * 1e6);       // A/mm2 during fault (LV winding)
  const [k_mat, t_lim] = inp.conductor === "Cu" ? [106000.0, 250.0] : [45700.0, 200.0];
  const denom = k_mat / (jsc ** 2 * inp.fault_duration_s) - 1;
  const t_fault = denom > 0 ? t1 + 2 * (t1 + t0) / denom : Infinity;
  // Mechanical: mean hoop stress in the outer (HV) winding.
  const b_peak = MU0 * n_hv * Math.sqrt(2) * kappa * (iph_hv / z_pu) / (h / kr);
  const pressure = b_peak ** 2 / (2 * MU0);
  const r_hv_mean = lmt_hv / (2 * Math.PI);
  const hoop = pressure * r_hv_mean / (n_hv * a_hv / h) / 1e6;

  const checks = [];
  const check = (name, clause, value, limit, unit, passed, note = "") => {
    checks.push({ name, clause, value: pyRound(value, 3), limit: pyRound(limit, 3), unit, passed: Boolean(passed), note });
  };

  check("Peak flux density", "design practice (CRGO)", bm, 1.75, "T", bm <= 1.75, "keep margin for overexcitation");
  check("Windings fit the window width", "geometry", width_needed * 1000, ww * 1000, "mm",
    width_needed <= ww, "2 x (core-LV + LV + duct + HV) + phase gap");
  if (inp.target_z_pct) {
    const tol = inp.target_z_pct * inp.z_tolerance_pct / 100;
    check("Impedance within tolerance of target", "IEEE C57.12.00 [tolerance UNVERIFIED]", z_pct,
      inp.target_z_pct + tol, "%", Math.abs(z_pct - inp.target_z_pct) <= tol,
      `target ${pyNum(inp.target_z_pct)} % +/- ${pyNum(inp.z_tolerance_pct)} %`);
  }
  if (inp.doe_min_efficiency_pct) {
    check("Efficiency at DOE test point", `10 CFR 431.196 (value entered by user); ${DOE_TEST_POINT_CITATION}`,
      eff_doe, inp.doe_min_efficiency_pct, "%", eff_doe >= inp.doe_min_efficiency_pct,
      `${doe_class}, ${pct0(doe_load)} load, load loss at ${doe_temp.toFixed(0)} C`);
  }
  check(`Winding temperature after ${String(inp.fault_duration_s)} s through-fault`, "IEC 60076-5 method; " +
    "C57.12.00 limit [UNVERIFIED]", t_fault, t_lim, "C", t_fault <= t_lim,
    `LV current density ${jsc.toFixed(1)} A/mm2 during fault`);
  check("Mean hoop stress in outer (HV) winding", "Kulkarni & Khaparde method [UNVERIFIED]", hoop,
    inp.conductor_proof_mpa, "MPa", hoop <= inp.conductor_proof_mpa, "compare with conductor 0.2 % proof stress");

  const notes = [
    `Preliminary design only (empirical K = ${pyNum(inp.k_et)}, Kw = ${kw.toFixed(3)}, core fill ${pyNum(inp.core_fill)}); ` +
    "refine with detailed design and FEA, and confirm by test (IEEE C57.12.90 / C57.12.91).",
    `DOE test point: ${doe_class} (HV winding taken as the primary), ${pct0(doe_load)} load, load loss corrected to ${doe_temp.toFixed(0)} C; enter the 10 CFR 431.196 ` +
    "minimum efficiency for this kVA and BIL (tables not loaded).",
    "Inner (LV) winding radial buckling and axial forces are not checked yet.",
  ];
  if (!inp.source_mva) notes.push("Secondary fault current assumes an infinite source (no utility impedance).");
  else {
    notes.push(`Secondary fault current: source ${pyG(inp.source_mva)} MVA at X/R ${pyG(inp.source_x_over_r)} added to ` +
      `the transformer impedance as phasors; combined X/R ${pyFixed2(xr_tot)}.`);
  }

  const r = (v, n = 1) => pyRound(v, n);
  const effs = {};
  for (const l of [0.25, 0.5, 0.75, 1.0]) effs[`${Math.trunc(l * 100)}%`] = r(eff(l), 3);
  return {
    input: { ...inp },
    design: {
      volts_per_turn: r(et, 3), turns_lv: n_lv, turns_hv: n_hv, b_max_t: r(bm, 3),
      core_area_net_cm2: r(ai * 1e4), core_diameter_mm: r(d * 1000), window_h_mm: r(hw * 1000),
      window_w_mm: r(ww * 1000), winding_height_mm: r(h * 1000),
      lv_conductor_mm2: r(a_lv * 1e6), hv_conductor_mm2: r(a_hv * 1e6, 2),
      lv_radial_mm: r(b_lv * 1000), hv_radial_mm: r(b_hv * 1000), duct_mm: r(duct * 1000),
      core_mass_kg: r(core_mass), kw: r(kw, 3),
    },
    losses: {
      no_load_w: r(nll), load_loss_w: r(load_loss), reference_temp_c: t_ref,
      r_lv_mohm: r(r_lv * 1000, 3), r_hv_ohm: r(r_hv, 3),
    },
    impedance: { r_pct: r(r_pct, 2), x_pct: r(x_pct, 2), z_pct: r(z_pct, 2), x_over_r: r(x_over_r, 2), rogowski_kr: r(kr, 3) },
    performance: {
      efficiency_pct: effs,
      doe_point: { load: doe_load, efficiency_pct: r(eff_doe, 3) },
      regulation_pct: r(reg, 2),
      max_efficiency_load_pct: r(Math.sqrt(nll / load_loss) * 100),
    },
    short_circuit: {
      lv_fault_ka_rms: r(isc_lv / 1000, 2), lv_fault_peak_ka: r(i_peak / 1000, 2),
      total_z_pu: r(z_pu, 5), total_x_over_r: r(xr_tot, 2),
      winding_temp_after_fault_c: r(t_fault), hv_hoop_stress_mpa: r(hoop, 1),
    },
    checks,
    notes,
    passed: checks.every((c) => c.passed),
  };
}

/* Tune the window height/width ratio so %Z meets target_z_pct.
   A taller window gives taller windings and lower leakage reactance, so %Z
   falls monotonically with window_ratio; solved by bisection. */
export function design_for_impedance(inp, lo = 1.2, hi = 8.0) {
  if (!inp.target_z_pct) throw new Error("target_z_pct is required to tune impedance");
  const z = (ratio) => design({ ...inp, window_ratio: ratio }).impedance.z_pct;
  const z_lo = z(lo), z_hi = z(hi);
  if (!(z_hi <= inp.target_z_pct && inp.target_z_pct <= z_lo)) {
    throw new Error(`Target ${pyNum(inp.target_z_pct)} % Z is outside ${z_hi.toFixed(2)}-${z_lo.toFixed(2)} % reachable by window ` +
      "ratio alone; change the LV-HV duct, current density or volts per turn");
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (z(mid) > inp.target_z_pct) lo = mid; else hi = mid;
  }
  const result = design({ ...inp, window_ratio: (lo + hi) / 2 });
  result.notes.unshift(`Window height/width ratio tuned to ${((lo + hi) / 2).toFixed(2)} to meet ${pyNum(inp.target_z_pct)} % Z.`);
  return result;
}

// camelCase names (repo convention) alongside the Python-style names.
export const nextStandardKva = next_standard_kva;
export const doeTestPoint = doe_test_point;
export const sourceImpedancePu = source_impedance_pu;
export const specificCoreLoss = specific_core_loss;
export const rogowskiFactor = rogowski_factor;
export const designForImpedance = design_for_impedance;
