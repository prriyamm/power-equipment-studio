// Multi-conductor series impedance and current sharing. Port of pecalc/impedance.py.
//
// Any 2-D arrangement of parallel straight conductors (cable bus, busbars,
// transformer leads, cable in tray) is modelled with Carson's simplified
// earth-return impedances:
//
//     z_ii = R_i + pi^2 f 1e-7 + j w 2e-7 ln(De / GMR_i)      ohm/m
//     z_ij =       pi^2 f 1e-7 + j w 2e-7 ln(De / d_ij)
//
//     De = 658.5 sqrt(rho / f)  (equivalent earth-return depth, m)
//
// When the phase currents sum to zero the earth terms cancel, so balanced
// results do not depend on soil resistivity. Each conductor belongs to a group:
//
// - "phase" groups: conductors paralleled at both ends; the group total
//   current is given, every member has the same voltage drop (unknown).
// - "bonded" groups: metallic shields or sheaths bonded to ground at both ends;
//   voltage drop is zero, currents are induced (circulating).
//
// Solving gives each conductor's current phasor, each phase group's voltage
// drop, and the losses. Reference: Carson (1926); Anderson, "Analysis of Faulted
// Power Systems", ch. 4; IEC 60287-1-1 section 2.3 for sheath circulating loss.
//
// Complex values are {re, im}. The Python numpy fast path (used only for more
// than 40 unknowns) is not ported: Gaussian elimination is used for every size.
import { pyRepr, toC, cabs, csub, cmul, cdiv, cpolar } from "./util.js";
import * as validate from "./validate.js";

export const MU0_2PI = 2e-7;

/** Conductor record (Python dataclass Conductor). */
export function conductor({ x_mm, y_mm, group, r_ohm_per_m, gmr_mm, label = "", tube_radius_mm = null }) {
  return { x_mm, y_mm, group, r_ohm_per_m, gmr_mm, label, tube_radius_mm };
}

/** Group record (Python dataclass Group). current is a complex {re, im} (or a number). */
export function group(name, kind, current = { re: 0, im: 0 }) {
  return { name, kind, current: toC(current) };
}

/** Indices of the conductors that belong to a group. */
export function groupMembers(result, name) {
  const out = [];
  result.conductors.forEach((c, i) => { if (c.group === name) out.push(i); });
  return out;
}

/** Conductor current as % of an equal share of its phase group. */
export function sharePct(result, i) {
  const c = result.conductors[i];
  const g = result.groups[c.group];
  const members = groupMembers(result, c.group);
  if (g.kind !== "phase" || !(g.current.re || g.current.im)) return NaN;
  return (cabs(result.currents[i]) / (cabs(g.current) / members.length)) * 100;
}

export function groupLossWPerM(result, kind) {
  let s = 0;
  result.losses_w_per_m.forEach((p, i) => { if (result.groups[result.conductors[i].group].kind === kind) s += p; });
  return s;
}

export function earthDepthM(freq, soil_ohm_m = 100.0) {
  return 658.5 * Math.sqrt(soil_ohm_m / freq);
}

export function impedanceMatrix(conductors, freq = 60.0, soil_ohm_m = 100.0) {
  const w = 2 * Math.PI * freq;
  const de = earthDepthM(freq, soil_ohm_m) * 1000; // mm
  const rg = Math.PI ** 2 * freq * 1e-7;
  const n = conductors.length;
  const z = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ re: 0, im: 0 })));
  conductors.forEach((a, i) => {
    conductors.forEach((b, j) => {
      if (i === j) {
        z[i][j] = { re: a.r_ohm_per_m + rg, im: w * MU0_2PI * Math.log(de / a.gmr_mm) };
      } else {
        let d = Math.hypot(a.x_mm - b.x_mm, a.y_mm - b.y_mm);
        if (d <= 0) {
          // Concentric pair (core and its shield): flux linking both
          // lies outside the tube, so use the tube's mean radius.
          const tube = Math.max(a.tube_radius_mm || 0, b.tube_radius_mm || 0);
          if (!tube) throw new Error(`Conductors ${i} and ${j} share a position`);
          d = tube;
        }
        z[i][j] = { re: rg, im: w * MU0_2PI * Math.log(de / d) };
      }
    });
  });
  return z;
}

/** Solve a dense complex system by Gaussian elimination with partial pivoting. */
export function solveComplex(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row.map(toC), toC(b[i])]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = cabs(m[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = cabs(m[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (cabs(m[piv][col]) < 1e-30) throw new Error("Singular system: check groups and constraints");
    [m[col], m[piv]] = [m[piv], m[col]];
    const prow = m[col];
    const pivot = prow[col];
    for (let r = col + 1; r < n; r++) {
      const row = m[r];
      const f = cdiv(row[col], pivot);
      if (f.re || f.im) {
        for (let k = col; k <= n; k++) row[k] = csub(row[k], cmul(f, prow[k]));
      }
    }
  }
  const x = new Array(n).fill(null).map(() => ({ re: 0, im: 0 }));
  for (let r = n - 1; r >= 0; r--) {
    const row = m[r];
    let s = { re: 0, im: 0 }; // Python sum() starts from int 0; adding 0 changes nothing
    for (let k = r + 1; k < n; k++) {
      const p = cmul(row[k], x[k]);
      s = { re: s.re + p.re, im: s.im + p.im };
    }
    x[r] = cdiv(csub(row[n], s), row[r]);
  }
  return x;
}

/**
 * Solve Z I = V with group constraints.
 *
 * Unknowns: every conductor current, plus one voltage drop per phase group.
 * Rows: one per conductor (Z_k . I - V_group = 0, or = 0 for bonded), plus
 * one current-sum row per phase group.
 * groups is an object keyed by group name. Returns {currents, group_drop_v_per_m,
 * losses_w_per_m, conductors, groups}.
 */
export function solveSharing(conductors, groups, freq = 60.0, soil_ohm_m = 100.0) {
  for (const c of conductors) {
    if (!Object.prototype.hasOwnProperty.call(groups, c.group)) {
      throw new Error(`Conductor group ${pyRepr(c.group)} is not defined`);
    }
  }
  const n = conductors.length;
  const phase_names = Object.keys(groups).filter((g) => groups[g].kind === "phase");
  const vidx = {};
  phase_names.forEach((g, k) => { vidx[g] = n + k; });
  const size = n + phase_names.length;
  const z = impedanceMatrix(conductors, freq, soil_ohm_m);

  const zero = () => ({ re: 0, im: 0 });
  const a = Array.from({ length: size }, () => Array.from({ length: size }, zero));
  const b = Array.from({ length: size }, zero);
  conductors.forEach((c, i) => {
    for (let j = 0; j < n; j++) a[i][j] = z[i][j];
    if (groups[c.group].kind === "phase") a[i][vidx[c.group]] = { re: -1, im: 0 };
  });
  phase_names.forEach((g, k) => {
    const row = n + k;
    conductors.forEach((c, i) => { if (c.group === g) a[row][i] = { re: 1, im: 0 }; });
    b[row] = toC(groups[g].current);
  });

  const x = solveComplex(a, b);
  const currents = x.slice(0, n);
  const group_drop_v_per_m = {};
  for (const g of phase_names) group_drop_v_per_m[g] = x[vidx[g]];
  const losses_w_per_m = currents.map((i, k) => cabs(i) ** 2 * conductors[k].r_ohm_per_m);
  return { currents, group_drop_v_per_m, losses_w_per_m, conductors, groups };
}

/** Three balanced phase groups; names default to A, B, C. Returns an object of groups. */
export function balancedThreePhase(i_rms, pf = 1.0, lagging = true, names = ["A", "B", "C"]) {
  validate.powerFactor("power_factor", pf);
  const phi = Math.acos(pf) * (lagging ? -1 : 1);
  const out = {};
  names.forEach((n, k) => { out[n] = group(n, "phase", cpolar(i_rms, phi + k * -2 * Math.PI / 3)); });
  return out;
}
