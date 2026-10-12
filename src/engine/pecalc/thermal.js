// Calculated cable ampacity: IEC 60287 thermal model for cables in free air. Port of pecalc/thermal.py.
//
// IEC 60287 and Neher-McGrath (IEEE 835 / NEC 310.14(B) and 315.60(B)
// "engineering supervision") use the same steady-state thermal circuit:
//
//     I = sqrt( (dT - Wd [0.5 T1 + T2 + T3 + T4])
//               / (R T1 + R (1 + l1) T2 + R (1 + l1 + l2) (T3 + T4)) )
//
// R: AC resistance at max conductor temperature (ohm/m); Wd: dielectric loss
// (W/m); l1, l2: shield and armour loss factors; T1..T4: thermal resistances of
// insulation, bedding, jacket and the surrounding air (K m/W). Single-core
// cables (n = 1). T4 for cables in free air comes from IEC 60287-2-1 clause
// 2.2.1 with the surface-temperature iteration.
//
// The shield loss factor l1 for bonded shields comes from the multi-conductor
// impedance solver, so it reflects the actual layout and bonding.
//
// [UNVERIFIED: constants below are from memory of IEC 60287-1-1 / -2-1 and must
// be checked against the standard; results are validated against NEC free-air
// tables in the tests]
import * as cond from "./conductors.js";
import { lookup, pyFixed } from "./util.js";

// Thermal resistivity K m/W (IEC 60287-2-1 Table 1).
export const THERMAL_RESISTIVITY = { XLPE: 3.5, EPR: 5.0, PVC: 5.0, PE: 3.5, XHHW: 3.5, RW90: 3.5 };
// Relative permittivity and loss tangent (IEC 60287-1-1 Table 3).
export const DIELECTRIC = {
  XLPE: [2.5, 0.001], EPR: [3.0, 0.005], PVC: [8.0, 0.1], XHHW: [2.5, 0.001], RW90: [2.5, 0.001],
};
// Free-air constants Z, E, g (IEC 60287-2-1 Table 2) for the installation.
export const AIR_CONSTANTS = {
  isolated: [0.21, 3.94, 0.60], // single cable, or cables spaced > 0.75 De apart
  two_touching: [0.29, 2.35, 0.50],
  trefoil_touching: [0.96, 1.25, 0.20],
  flat_touching: [0.62, 1.95, 0.25],
};

/**
 * CableConstruction (Python dataclass). Derived dimensions are getters, as the
 * Python properties are: dc_mm, di_mm, da_mm, de_mm, shield_mean_diameter_mm.
 * insulation_mm includes conductor and insulation screens for MV.
 */
export function cableConstruction(size, opts = {}) {
  const {
    material = "Cu", insulation = "XLPE", insulation_mm = 1.65, shield_mm = 0.0, jacket_mm = 0.0,
    jacket = "PVC", voltage_v = 600.0, max_temp_c = 90.0,
  } = opts;
  return {
    size, material, insulation, insulation_mm, shield_mm, jacket_mm, jacket, voltage_v, max_temp_c,
    get dc_mm() { return cond.diameterMm(this.size); },
    get di_mm() { return this.dc_mm + 2 * this.insulation_mm; },
    get da_mm() { return this.di_mm + 2 * this.shield_mm; },
    get de_mm() { return this.da_mm + 2 * this.jacket_mm; },
    get shield_mean_diameter_mm() { return this.di_mm + this.shield_mm; },
  };
}

export function ampacitySummary(r) {
  const f = pyFixed;
  return `IEC 60287 calculated ${f(r.ampacity_a, 0)} A (${r.installation}, ${f(r.ambient_c, 0)} C ambient; ` +
    `T1 ${f(r.t1, 3)}, T3 ${f(r.t3, 3)}, T4 ${f(r.t4, 3)} K.m/W, lambda1 ${f(r.lambda1, 3)}) [UNVERIFIED]`;
}

export function dielectricLoss(c, freq = 60.0) {
  const [eps, tan_d] = Object.prototype.hasOwnProperty.call(DIELECTRIC, c.insulation)
    ? DIELECTRIC[c.insulation] : [2.5, 0.001];
  const cap = (eps / (18 * Math.log(c.di_mm / c.dc_mm))) * 1e-9; // F/m
  const u0 = c.voltage_v / Math.sqrt(3);
  return 2 * Math.PI * freq * cap * u0 ** 2 * tan_d;
}

/**
 * Free-air ampacity of a single-core cable. opts: installation ("isolated"), lambda1 (0),
 * freq (60), spacing_mm (null). Returns the AmpacityResult fields: ampacity_a, r_ac_ohm_per_m,
 * wd_w_per_m, t1, t3, t4, lambda1, surface_rise_c, installation, ambient_c.
 */
export function freeAirAmpacity(c, ambient_c = 40.0, opts = {}) {
  const { installation = "isolated", lambda1 = 0.0, freq = 60.0, spacing_mm = null } = opts;
  const rho_i = lookup(THERMAL_RESISTIVITY, c.insulation);
  const t1 = (rho_i / (2 * Math.PI)) * Math.log(1 + (2 * c.insulation_mm) / c.dc_mm);
  const t2 = 0.0;
  const t3 = c.jacket_mm
    ? (lookup(THERMAL_RESISTIVITY, c.jacket) / (2 * Math.PI)) * Math.log(1 + (2 * c.jacket_mm) / c.da_mm)
    : 0.0;
  const r = cond.racOhmPerM(c.size, c.material, c.max_temp_c, freq, spacing_mm);
  const wd = dielectricLoss(c, freq);
  const lambda2 = 0.0;
  const d_theta = c.max_temp_c - ambient_c;
  if (d_theta <= 0) {
    return {
      ampacity_a: 0.0, r_ac_ohm_per_m: r, wd_w_per_m: wd, t1, t3, t4: Infinity, lambda1,
      surface_rise_c: 0.0, installation, ambient_c,
    };
  }

  const [z, e, g] = lookup(AIR_CONSTANTS, installation);
  const de_m = c.de_mm / 1000;
  const h = z / de_m ** g + e;
  const k_a = ((Math.PI * de_m * h) / (1 + lambda1 + lambda2)) *
    (t1 + t2 * (1 + lambda1) + t3 * (1 + lambda1 + lambda2));
  const d_theta_d = wd * ((1 / (1 + lambda1 + lambda2) - 0.5) * t1 - (t2 * lambda1) / (1 + lambda1 + lambda2));
  let s = 2.0; // (surface rise)^(1/4) starting value
  for (let it = 0; it < 200; it++) {
    const nxt = ((d_theta + d_theta_d) / (1 + k_a * s)) ** 0.25;
    if (Math.abs(nxt - s) < 1e-9) break;
    s = nxt;
  }
  const t4 = 1 / (Math.PI * de_m * h * s);

  const num = d_theta - wd * (0.5 * t1 + t2 + t3 + t4);
  const den = r * t1 + r * (1 + lambda1) * t2 + r * (1 + lambda1 + lambda2) * (t3 + t4);
  const amp = Math.sqrt(Math.max(num, 0) / den);
  return {
    ampacity_a: amp, r_ac_ohm_per_m: r, wd_w_per_m: wd, t1, t3, t4, lambda1,
    surface_rise_c: s ** 4, installation, ambient_c,
  };
}
