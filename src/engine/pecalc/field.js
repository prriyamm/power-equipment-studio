// Magnetic flux density around long parallel conductors (2-D Biot-Savart). Port of pecalc/field.py.
//
// For a straight filament carrying phasor current I at (xi, yi), the flux density
// at (x, y) is B = mu0 I / (2 pi r^2) * (-dy, dx). Phasor components are summed
// over all conductors (phases, shields, enclosure filaments) and the RMS
// resultant sqrt(|Bx|^2 + |By|^2) is reported, the quantity a 3-axis meter reads
// (IEEE 644 / IEEE 1308).
//
// Exposure reference levels at 60 Hz:
// - ICNIRP 1998: 83.3 uT general public, 416.7 uT occupational
//   [VERIFIED from the ICNIRP 1998 guideline tables, f = 60 Hz]
// - ICNIRP 2010: 200 uT public, 1000 uT occupational [UNVERIFIED]
import { toC, pyRound } from "./util.js";

export const MU0_2PI = 2e-7;

export const LIMITS_UT = {
  "ICNIRP 1998 public": 83.3,
  "ICNIRP 1998 occupational": 416.7,
  "ICNIRP 2010 public [UNVERIFIED]": 200.0,
  "ICNIRP 2010 occupational [UNVERIFIED]": 1000.0,
};

/** RMS flux density in uT at (x_mm, y_mm). currents: {re, im} phasors or numbers. */
export function bRmsUt(conductors, currents, x_mm, y_mm) {
  let bx = { re: 0, im: 0 }, by = { re: 0, im: 0 };
  const n = Math.min(conductors.length, currents.length); // Python zip() truncates
  for (let m = 0; m < n; m++) {
    const c = conductors[m];
    const i = toC(currents[m]);
    const dx = (x_mm - c.x_mm) / 1000;
    const dy = (y_mm - c.y_mm) / 1000;
    const r2 = dx * dx + dy * dy;
    if (r2 < 1e-12) continue;
    // k = MU0_2PI * i / r2 (complex / real)
    const k = { re: (MU0_2PI * i.re) / r2, im: (MU0_2PI * i.im) / r2 };
    bx = { re: bx.re + -k.re * dy, im: bx.im + -k.im * dy };
    by = { re: by.re + k.re * dx, im: by.im + k.im * dx };
  }
  return Math.sqrt(Math.hypot(bx.re, bx.im) ** 2 + Math.hypot(by.re, by.im) ** 2) * 1e6;
}

/** Field profile along x at height y_mm: array of {x_mm, y_mm, b_ut} (FieldPoint). */
export function profile(conductors, currents, y_mm, x_from_mm, x_to_mm, steps = 41) {
  const out = [];
  for (let k = 0; k < steps; k++) {
    const x = x_from_mm + ((x_to_mm - x_from_mm) * k) / (steps - 1);
    out.push({ x_mm: pyRound(x, 1), y_mm, b_ut: pyRound(bRmsUt(conductors, currents, x, y_mm), 2) });
  }
  return out;
}

/**
 * Closed form for a balanced flat 3-phase circuit at large distance:
 * B ~ (mu0 I / 2 pi) sqrt(3) s / d^2.
 */
export function farFieldFlatUt(i_rms, spacing_m, distance_m) {
  return ((MU0_2PI * i_rms * Math.sqrt(3) * spacing_m) / distance_m ** 2) * 1e6;
}
