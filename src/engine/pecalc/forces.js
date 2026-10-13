// Short-circuit electromagnetic forces on parallel conductors. Port of pecalc/forces.py.
//
// Time-domain method: the asymmetrical fault current of each phase is
//
//     i_p(t) = sqrt(2) I [sin(wt + a - phi - 120 deg k) - sin(a - phi - 120 deg k) e^(-t/tau)]
//
// with tau = (X/R) / w. Each conductor carries its share of its phase (ratio from
// the impedance solver) and the force per metre on conductor i is the vector sum
// of 2e-7 i_i i_j / d_ij over all other conductors (Ampere's force law, the basis
// of IEEE 605 and IEC 60865). The worst case over fault inception angle and the
// first cycles is reported. For two-conductor or three-phase flat layouts this
// reproduces the classic 2e-7 i^2 / d and 0.866 peak factor results.
import { toC, cabs } from "./util.js";
import * as validate from "./validate.js";

export const N_PER_M_TO_LBF_PER_FT = 0.0685218;

/**
 * Ratio of first asymmetrical peak to RMS symmetrical current.
 *
 * Approximation k = sqrt(2) (1.02 + 0.98 e^(-3 R/X)) (IEC 60909-0 eq. 55),
 * used for reporting; the force calculation itself is time-domain.
 */
export function peakFactor(x_over_r, freq = 60.0) {
  validate.xOverR("x_over_r", x_over_r);
  return Math.sqrt(2) * (1.02 + 0.98 * Math.exp(-3 / x_over_r));
}

/**
 * share[i] = conductor i's complex fraction of its phase current (from solveSharing);
 * an array or an object keyed by conductor index, values {re, im} or numbers.
 *
 * Conductors whose group is not in `phases` (e.g. shields) are ignored.
 * opts.bodies maps conductor index -> body name (e.g. filaments of one bar); the
 * vector sum per body is tracked, so a bar split into filaments gets its
 * true resultant (internal filament forces cancel in pairs).
 *
 * Returns {peak_n_per_m, worst_index, worst_n_per_m, peak_current_ka, x_over_r,
 * body_peak_n_per_m, body_peak_xy, worst_lbf_per_ft}; body_* are null without bodies.
 */
export function faultForces(conductors, share, fault_ka_rms, x_over_r, opts = {}) {
  const {
    freq = 60.0, phases = ["A", "B", "C"], cycles = 1.0, steps_per_cycle = 96, angle_steps = 24,
    bodies = null,
  } = opts;
  validate.xOverR("x_over_r", x_over_r);
  const w = 2 * Math.PI * freq;
  const tau = x_over_r / w;
  const phi = Math.atan(x_over_r);
  const amp = Math.sqrt(2) * fault_ka_rms * 1000;
  const idx = [];
  conductors.forEach((c, i) => { if (phases.includes(c.group)) idx.push(i); });
  const pos = {};
  for (const i of idx) pos[i] = [conductors[i].x_mm / 1000, conductors[i].y_mm / 1000];
  // Pre-compute geometry: unit vectors and 2e-7/d.
  const geo = {};
  for (const i of idx) {
    for (const j of idx) {
      if (i !== j) {
        const dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1];
        const d = Math.hypot(dx, dy);
        geo[`${i},${j}`] = [2e-7 / d, dx / d, dy / d];
      }
    }
  }
  const sh = {};
  for (const i of idx) sh[i] = toC(share[i]);

  const worst = new Array(conductors.length).fill(0.0);
  const hasBodies = !!bodies && Object.keys(bodies).length > 0;
  const body_names = hasBodies ? [...new Set(Object.values(bodies))].sort() : [];
  const body_worst = {};
  const body_xy = {};
  for (const b of body_names) { body_worst[b] = 0.0; body_xy[b] = [0.0, 0.0]; }
  let i_peak = 0.0;
  const n_t = Math.trunc(cycles * steps_per_cycle) + 1;
  for (let a_step = 0; a_step < angle_steps; a_step++) {
    const alpha = (Math.PI * a_step) / angle_steps;
    for (let t_step = 0; t_step < n_t; t_step++) {
      const t = t_step / (steps_per_cycle * freq);
      const decay = Math.exp(-t / tau);
      // Instantaneous phase currents; conductor share applied via magnitude/angle.
      const inst = {};
      for (const i of idx) {
        const k = phases.indexOf(conductors[i].group);
        const s = sh[i];
        const th = alpha - phi - (2 * Math.PI * k) / 3 + Math.atan2(s.im, s.re);
        const as = cabs(s);
        inst[i] = as * amp * (Math.sin(w * t + th) - Math.sin(th) * decay);
        i_peak = Math.max(i_peak, as > 1e-12 ? Math.abs(inst[i]) / as : 0);
      }
      const acc = {};
      for (const b of body_names) acc[b] = [0.0, 0.0];
      for (const i of idx) {
        let fx = 0.0, fy = 0.0;
        for (const j of idx) {
          if (i !== j) {
            const [k_d, ux, uy] = geo[`${i},${j}`];
            const f = k_d * inst[i] * inst[j]; // attractive if same sign
            fx -= f * ux;
            fy -= f * uy;
          }
        }
        const mag = Math.hypot(fx, fy);
        if (mag > worst[i]) worst[i] = mag;
        if (hasBodies && bodies[i] !== undefined) {
          const a = acc[bodies[i]];
          a[0] += fx;
          a[1] += fy;
        }
      }
      for (const b of body_names) {
        const [fx, fy] = acc[b];
        body_worst[b] = Math.max(body_worst[b], Math.hypot(fx, fy));
        body_xy[b][0] = Math.max(body_xy[b][0], Math.abs(fx));
        body_xy[b][1] = Math.max(body_xy[b][1], Math.abs(fy));
      }
    }
  }
  let w_i = 0;
  for (let i = 1; i < worst.length; i++) if (worst[i] > worst[w_i]) w_i = i;
  return {
    peak_n_per_m: worst,
    worst_index: w_i,
    worst_n_per_m: worst[w_i],
    peak_current_ka: i_peak / 1000,
    x_over_r,
    body_peak_n_per_m: hasBodies ? body_worst : null,
    body_peak_xy: hasBodies ? body_xy : null,
    worst_lbf_per_ft: worst[w_i] * N_PER_M_TO_LBF_PER_FT,
  };
}
