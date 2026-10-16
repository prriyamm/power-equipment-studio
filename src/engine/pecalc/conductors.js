// Conductor sizes, geometry, resistance and reactance. Port of pecalc/conductors.py.
//
// DC resistance is computed from resistivity, stranding and temperature rather
// than looked up, and the tests check it against NEC Chapter 9 Table 8. AC
// resistance adds skin and proximity effect with the IEC 60287-1-1 formulas,
// the same basis Neher-McGrath (IEEE 835) uses. Reactance comes from the
// geometric-mean-distance formula, so it works for any spacing (cable bus).
import { pyRepr, lookup } from "./util.js";

export const SIZES = [
  "14", "12", "10", "8", "6", "4", "3", "2", "1",
  "1/0", "2/0", "3/0", "4/0",
  "250", "300", "350", "400", "500", "600", "700", "750", "800", "900",
  "1000", "1250", "1500", "1750", "2000",
];

// Conductor area in circular mils (AWG by definition, kcmil = 1000 cmil).
export const AREA_CMIL = {
  "14": 4110, "12": 6530, "10": 10380, "8": 16510, "6": 26240,
  "4": 41740, "3": 52620, "2": 66360, "1": 83690,
  "1/0": 105600, "2/0": 133100, "3/0": 167800, "4/0": 211600,
  ...Object.fromEntries(SIZES.slice(13).map((s) => [s, parseInt(s, 10) * 1000])),
};

// Bare Class B stranded conductor diameter, inches.
// Source: NEC Chapter 9 Table 8. [UNVERIFIED: entered from memory]
export const DIAMETER_IN = {
  "14": 0.073, "12": 0.092, "10": 0.116, "8": 0.146, "6": 0.184,
  "4": 0.232, "3": 0.260, "2": 0.292, "1": 0.332,
  "1/0": 0.372, "2/0": 0.418, "3/0": 0.470, "4/0": 0.528,
  "250": 0.575, "300": 0.630, "350": 0.681, "400": 0.728, "500": 0.813,
  "600": 0.893, "700": 0.964, "750": 0.998, "800": 1.030, "900": 1.094,
  "1000": 1.152, "1250": 1.289, "1500": 1.412, "1750": 1.526, "2000": 1.632,
};

// Typical 600 V XHHW-2 / RW90 insulation wall, inches, by size band.
// Used only when the caller gives no cable OD. [UNVERIFIED: typical values;
// use the manufacturer's datasheet OD for design work]
const _INSULATION_IN = [
  [["14", "12", "10"], 0.030],
  [["8", "6", "4", "3", "2"], 0.045],
  [["1", "1/0", "2/0", "3/0", "4/0"], 0.055],
  [["250", "300", "350", "400", "500"], 0.065],
  [["600", "700", "750", "800", "900", "1000"], 0.080],
  [["1250", "1500", "1750", "2000"], 0.095],
];

// Resistivity at 20 C in ohm-cmil/ft and the inferred zero-resistance
// temperature used for temperature correction.
export const MATERIALS = {
  Cu: { rho20: 10.371, t0: 234.5 }, // annealed copper, 100 % IACS
  Al: { rho20: 16.946, t0: 228.1 }, // 1350 aluminum, 61.2 % IACS
};
export const STRANDING_FACTOR = 1.02; // lay-length increase for concentric stranding

export const MU0 = 4e-7 * Math.PI;
export const FT = 0.3048;
export const INCH = 0.0254;
export const CMIL_TO_MM2 = 5.067075e-4;

/** Accept '500', '500 kcmil', '#2', '2 AWG', '4/0' and return the key. */
export function normalizeSize(size) {
  let s = String(size).trim().toLowerCase();
  for (const token of ["kcmil", "mcm", "awg", "#"]) s = s.split(token).join("");
  s = s.trim();
  if (!Object.prototype.hasOwnProperty.call(AREA_CMIL, s)) {
    throw new Error(`Unknown conductor size ${pyRepr(size)}; expected one of ${SIZES.join(", ")}`);
  }
  return s;
}

export function sizeLabel(size) {
  size = normalizeSize(size);
  return SIZES.indexOf(size) >= SIZES.indexOf("250") ? `${size} kcmil` : `${size} AWG`;
}

export function sizeIndex(size) { return SIZES.indexOf(normalizeSize(size)); }
export function areaMm2(size) { return AREA_CMIL[normalizeSize(size)] * CMIL_TO_MM2; }
export function diameterMm(size) { return DIAMETER_IN[normalizeSize(size)] * 25.4; }

export function insulationMm(size) {
  size = normalizeSize(size);
  for (const [sizes, wall] of _INSULATION_IN) if (sizes.includes(size)) return wall * 25.4;
  throw new Error(size); // AssertionError in Python; unreachable
}

/** Estimated single-conductor 600 V cable OD (conductor + insulation). */
export function cableOdMm(size) { return diameterMm(size) + 2 * insulationMm(size); }

export function rdcOhmPerM(size, material, temp_c = 75.0) {
  const m = lookup(MATERIALS, material);
  const r20_per_ft = (m.rho20 / AREA_CMIL[normalizeSize(size)]) * STRANDING_FACTOR;
  const r_per_ft = (r20_per_ft * (m.t0 + temp_c)) / (m.t0 + 20.0);
  return r_per_ft / FT;
}

const _f = (x4) => x4 / (192.0 + 0.8 * x4);

/**
 * Skin (ys) and proximity (yp) factors, IEC 60287-1-1 section 2.1.
 * Uses ks = 1 and kp = 0.8 (round stranded conductor). spacing_mm is the
 * centre-to-centre distance to the neighbouring phase; null skips yp.
 * Returns [ys, yp].
 */
export function acFactors(rdc, freq, d_mm, spacing_mm) {
  const xs4 = ((8 * Math.PI * freq * 1e-7 * 1.0) / rdc) ** 2;
  const ys = _f(xs4);
  let yp = 0.0;
  if (spacing_mm) {
    const xp4 = ((8 * Math.PI * freq * 1e-7 * 0.8) / rdc) ** 2;
    const ratio2 = (d_mm / spacing_mm) ** 2;
    const fp = _f(xp4);
    yp = fp * ratio2 * (0.312 * ratio2 + 1.18 / (fp + 0.27));
  }
  return [ys, yp];
}

export function racOhmPerM(size, material, temp_c = 75.0, freq = 60.0, spacing_mm = null) {
  const rdc = rdcOhmPerM(size, material, temp_c);
  const [ys, yp] = acFactors(rdc, freq, diameterMm(size), spacing_mm);
  return rdc * (1 + ys + yp);
}

// ICEA P-32-382 adiabatic constants: [K with A in cmil and I in A, T0 in C]. [UNVERIFIED]
export const ADIABATIC = { Cu: [0.0297, 234.0], Al: [0.0125, 228.0] };

/**
 * ICEA P-32-382 adiabatic short-circuit withstand current, A.
 * (I/A)^2 t = K log10((T2 + T0) / (T1 + T0)), so I = A sqrt(K log10((T2 + T0) / (T1 + T0)) / t), A in cmil, t in s.
 * [UNVERIFIED: K = 0.0297 Cu / 0.0125 Al with A in cmil, I in A; T0 = 234 Cu / 228 Al]
 */
export function adiabaticWithstandA(material, area_cmil, initial_c, final_c, time_s) {
  const [k, t0] = material === "Cu" ? ADIABATIC.Cu : ADIABATIC.Al;
  return area_cmil * Math.sqrt((k * Math.log10((final_c + t0) / (initial_c + t0))) / time_s);
}

/**
 * Conductor temperature after a fault with let-through energy i2t = integral of i^2 dt (A^2 s): the inverse
 * of adiabaticWithstandA with the same constants, T2 = (T1 + T0) 10^(i2t / (K A^2)) - T0.
 */
export function adiabaticTemperatureC(material, area_cmil, initial_c, i2t_a2s) {
  const [k, t0] = material === "Cu" ? ADIABATIC.Cu : ADIABATIC.Al;
  return (initial_c + t0) * 10 ** (i2t_a2s / (k * area_cmil ** 2)) - t0;
}

/** Geometric mean radius, approximated as 0.7788 r (solid-round value). */
export function gmrMm(size) { return (0.7788 * diameterMm(size)) / 2; }

/** Positive-sequence series reactance for a transposed/symmetric group. */
export function reactanceOhmPerM(size, gmd_mm, freq = 60.0) {
  return 2 * Math.PI * freq * (MU0 / (2 * Math.PI)) * Math.log(gmd_mm / gmrMm(size));
}
