/* ============================================================================
 * Arc-flash incident energy, IEEE Std 1584-2018 empirical model (three-phase AC,
 * 208 V to 15 kV; VCB, VCBB, HCB, VOA, HOA electrode configurations).
 *
 * DATA STATUS: the coefficient tables in data/ieee1584_2018.json were entered from
 * memory and are UNVERIFIED; some sets are approximations (see _meta.placeholders).
 * Every result carries `data_status`. While the tables are PLACEHOLDER, arcFlash() refuses
 * to run unless the caller passes allow_placeholder_data: true (same rule as the pecalc
 * ampacity tables). Verify against a licensed copy of the standard before using any
 * number for labelling or PPE selection.
 * ========================================================================== */
import DATA from "./data/ieee1584_2018.json" with { type: "json" };
import { cMax } from "./shortcircuit.js";
import { NODE_KINDS } from "./system.js";
import { DataStatusError } from "./pecalc/ampacity.js";

export const DATA_STATUS = DATA._meta.status;
export const CONFIGS = ["VCB", "VCBB", "HCB", "VOA", "HOA"];
export const CAL_PER_J = 1 / 4.184;
const OPEN_AIR = new Set(["VOA", "HOA"]);
const log10 = Math.log10;
const poly = (c, x) => c.reduce((a, k) => a * x + k, 0); // Horner, highest power first

/* ------------------------------------------------------------ arcing current */
// Eq. 1: Iarc_V = 10^(k1 + k2 log Ibf + k3 log G) * (k4 Ibf^6 + ... + k10)
function iarcIntermediate(level, cfg, ibf, gap) {
  const k = DATA.iarc[level][cfg];
  return 10 ** (k[0] + k[1] * log10(ibf) + k[2] * log10(gap)) * poly(k.slice(3), ibf);
}
const varCf = (cfg, voc) => poly(DATA.varcf[cfg], voc);

// Intermediate arcing currents at 600 / 2700 / 14300 V, all scaled by `m` (1 for the full, 1 - 0.5 VarCf for the reduced scenario).
function arcingCurrent(voc, cfg, ibf, gap, m = 1) {
  const i600 = m * iarcIntermediate("600", cfg, ibf, gap);
  const i2700 = m * iarcIntermediate("2700", cfg, ibf, gap);
  const i14300 = m * iarcIntermediate("14300", cfg, ibf, gap);
  let iarc;
  if (voc <= 0.6) {
    // Voc <= 600 V: voltage-corrected form of the 600 V result
    const r = (0.6 * 0.6 - voc * voc) / (0.6 * 0.6 * (m * ibf) * (m * ibf));
    iarc = 1 / Math.sqrt((0.6 / voc) ** 2 * (1 / (i600 * i600) - r));
  } else {
    const i1 = ((i2700 - i600) / 2.1) * (voc - 2.7) + i2700;
    const i2 = ((i14300 - i2700) / 11.6) * (voc - 14.3) + i14300;
    const i3 = (i1 * (2.7 - voc)) / 2.1 + (i2 * (voc - 0.6)) / 2.1;
    iarc = voc <= 2.7 ? i3 : i2;
  }
  return { iarc, i600, i2700, i14300 };
}

/* ---------------------------------------------------- enclosure size correction */
// Typical-box limits (mm): 508..1244.4 below 600 V, 660.4..1244.4 above. Larger boxes are clipped
// to 1244.4 mm here (the standard's extended equivalent-size handling is not implemented).
export function enclosureCorrection(cfg, voc, enc) {
  if (OPEN_AIR.has(cfg) || !enc) return { cf: 1, ees_in: null, type: "open air" };
  const lo = voc <= 0.6 ? 508 : 660.4, hi = 1244.4;
  const clip = (x) => Math.min(hi, Math.max(lo, x));
  const ees = (clip(enc.h) + clip(enc.w)) / 2 / 25.4;
  const shallow = voc <= 0.6 && enc.d <= 203.2;
  const b = DATA.cf[cfg][shallow ? "shallow" : "typical"];
  const p = b[0] * ees * ees + b[1] * ees + b[2];
  return { cf: shallow ? 1 / p : p, ees_in: ees, type: shallow ? "shallow" : "typical" };
}

/* ----------------------------------------------------------- incident energy */
// E at one intermediate voltage level, J/cm^2. iarcLevel is that level's (scenario-scaled) arcing current.
function energyLevel(level, cfg, ibf, gap, dist, t_ms, iarcLevel, cf) {
  const k = DATA.energy[level][cfg];
  const den = ibf * poly(k.slice(3, 10), ibf); // k4 Ibf^7 + ... + k10 Ibf
  const ex = k[0] + k[1] * log10(gap) + (k[2] * iarcLevel) / den + k[10] * log10(ibf) + k[11] * log10(dist) + k[12] * log10(iarcLevel) + log10(1 / cf);
  return (12.552 / 50) * t_ms * 10 ** ex;
}

// Incident energy (J/cm^2) at distance `dist` for one scenario (arc currents already scaled).
function energyAt(voc, cfg, ibf, gap, dist, t_ms, cur, cf) {
  if (voc <= 0.6) return energyLevel("600", cfg, ibf, gap, dist, t_ms, cur.iarc, cf);
  const e600 = energyLevel("600", cfg, ibf, gap, dist, t_ms, cur.i600, cf);
  const e2700 = energyLevel("2700", cfg, ibf, gap, dist, t_ms, cur.i2700, cf);
  const e14300 = energyLevel("14300", cfg, ibf, gap, dist, t_ms, cur.i14300, cf);
  const e1 = ((e2700 - e600) / 2.1) * (voc - 2.7) + e2700;
  const e2 = ((e14300 - e2700) / 11.6) * (voc - 14.3) + e14300;
  const e3 = (e1 * (2.7 - voc)) / 2.1 + (e2 * (voc - 0.6)) / 2.1;
  return voc <= 2.7 ? e3 : e2;
}

// Arc-flash boundary: distance (mm) where E falls to 1.2 cal/cm^2 (bisection; E is monotone decreasing in D).
const AFB_J = 1.2 * 4.184;
function boundary(fn) {
  if (fn(1e5) >= AFB_J) return 1e5;
  let lo = 1, hi = 1e5;
  if (fn(lo) <= AFB_J) return lo;
  for (let i = 0; i < 100; i++) { const mid = Math.sqrt(lo * hi); if (fn(mid) > AFB_J) lo = mid; else hi = mid; }
  return Math.sqrt(lo * hi);
}
// IEEE 1584-2018 interpolates the boundary itself above 600 V: AFB_600/2700/14300 are each found from
// their own level's energy equation, then combined with the same three-point interpolation as Iarc and E.
// (Finding where the interpolated E crosses the threshold gives a different distance, because E is not
// linear in D.) At or below 600 V the boundary comes straight from the final-E equation.
export function arcFlashBoundary(voc, cfg, ibf, gap, t_ms, cur, cf) {
  if (voc <= 0.6) return boundary((d) => energyLevel("600", cfg, ibf, gap, d, t_ms, cur.iarc, cf));
  const a600 = boundary((d) => energyLevel("600", cfg, ibf, gap, d, t_ms, cur.i600, cf));
  const a2700 = boundary((d) => energyLevel("2700", cfg, ibf, gap, d, t_ms, cur.i2700, cf));
  const a14300 = boundary((d) => energyLevel("14300", cfg, ibf, gap, d, t_ms, cur.i14300, cf));
  const b1 = ((a2700 - a600) / 2.1) * (voc - 2.7) + a2700;
  const b2 = ((a14300 - a2700) / 11.6) * (voc - 14.3) + a14300;
  const b3 = (b1 * (2.7 - voc)) / 2.1 + (b2 * (voc - 0.6)) / 2.1;
  return voc <= 2.7 ? b3 : b2;
}

/* ------------------------------------------------------------- PPE (info) */
// NFPA 70E Table 130.5(G) style thresholds, informative only.
export const PPE_LEVELS = [
  { max: 1.2, level: 0, label: "Below 1.2 cal/cm²" },
  { max: 4, level: 1, label: "Category 1 (4 cal/cm²)" },
  { max: 8, level: 2, label: "Category 2 (8 cal/cm²)" },
  { max: 25, level: 3, label: "Category 3 (25 cal/cm²)" },
  { max: 40, level: 4, label: "Category 4 (40 cal/cm²)" },
  { max: Infinity, level: 5, label: "Above 40 cal/cm²: no PPE category" },
];
export const ppeLevel = (cal) => PPE_LEVELS.find((p) => cal <= p.max);

/* ------------------------------------------------------- defaults (Table 8) */
export const CLASS_DEFAULTS = {
  mv15: { label: "15 kV switchgear", config: "VCB", gap_mm: 152, working_mm: 914.4, enclosure: { h: 1143, w: 762, d: 762 } },
  mv5: { label: "5 kV switchgear", config: "VCB", gap_mm: 104, working_mm: 914.4, enclosure: { h: 914.4, w: 914.4, d: 914.4 } },
  lv_swgr: { label: "LV switchgear", config: "VCB", gap_mm: 32, working_mm: 609.6, enclosure: { h: 508, w: 508, d: 508 } },
  lv_mcc: { label: "LV MCC / panel", config: "VCB", gap_mm: 25, working_mm: 457.2, enclosure: { h: 355.6, w: 304.8, d: 203.2 } },
};
export function classFor(type, kv) {
  if (kv > 5) return "mv15";
  if (kv > 1) return "mv5";
  return type === "switchgear" ? "lv_swgr" : "lv_mcc";
}

/* ------------------------------------------------------------ main function */
export function arcFlash(inp) {
  const { voc_kv: voc, ibf_ka: ibf, gap_mm: gap, working_mm: dist, config: cfg } = inp;
  const enc = inp.enclosure, t1 = inp.clearing_ms, t2 = inp.clearing_reduced_ms ?? t1;
  if (!CONFIGS.includes(cfg)) throw new Error(`Unknown electrode configuration "${cfg}"`);
  for (const [n, v] of [["voc_kv", voc], ["ibf_ka", ibf], ["gap_mm", gap], ["working_mm", dist], ["clearing_ms", t1]]) if (!(v > 0)) throw new Error(`${n} must be positive`);
  if (DATA_STATUS === "PLACEHOLDER" && !inp.allow_placeholder_data) {
    throw new DataStatusError(
      "IEEE 1584-2018 coefficient tables are PLACEHOLDER data (see engine/data/ieee1584_2018.json). " +
      "Enter the real coefficients first, or pass allow_placeholder_data: true to run anyway for testing.");
  }
  const warnings = [];
  if (voc < 0.208 || voc > 15) warnings.push("Voc outside the 208 V to 15 kV model range.");
  // Model range: 208-600 V 0.5-106 kA, 601 V-15 kV 0.2-65 kA (IEEE 1584-2018 clause 4.2; from secondary sources, UNVERIFIED).
  if (ibf < (voc <= 0.6 ? 0.5 : 0.2) || ibf > (voc <= 0.6 ? 106 : 65)) warnings.push("Ibf outside the model validity range.");
  if (voc <= 0.6 ? gap < 6.35 || gap > 76.2 : gap < 19.05 || gap > 254) warnings.push("Gap outside the model validity range.");
  if (dist < 305) warnings.push("Working distance below 305 mm is outside the model range.");

  const full = arcingCurrent(voc, cfg, ibf, gap, 1);
  const vcf = varCf(cfg, voc), m = 1 - 0.5 * vcf;
  const red = arcingCurrent(voc, cfg, ibf, gap, m);
  const encl = enclosureCorrection(cfg, voc, enc);
  const scen = (cur, t) => {
    const e_j = energyAt(voc, cfg, ibf, gap, dist, t, cur, encl.cf);
    const afb = arcFlashBoundary(voc, cfg, ibf, gap, t, cur, encl.cf);
    return { iarc_ka: cur.iarc, clearing_ms: t, e_j_cm2: e_j, e_cal_cm2: e_j * CAL_PER_J, afb_mm: afb, afb_in: afb / 25.4 };
  };
  const s1 = scen(full, t1), s2 = scen(red, t2);
  const gov = s2.e_j_cm2 > s1.e_j_cm2 ? "reduced" : "full";
  const g = gov === "reduced" ? s2 : s1;
  return {
    iarc_ka: full.iarc, iarc_min_ka: red.iarc, var_cf: vcf, cf: encl.cf, enclosure_type: encl.type, ees_in: encl.ees_in,
    scenarios: { full: s1, reduced: s2 }, governing: gov,
    e_j_cm2: g.e_j_cm2, e_cal_cm2: g.e_cal_cm2,
    afb_mm: Math.max(s1.afb_mm, s2.afb_mm), afb_in: Math.max(s1.afb_in, s2.afb_in),
    ppe: ppeLevel(g.e_cal_cm2), ppe_title: "PPE level (informative)",
    warnings, data_status: DATA_STATUS, data_notes: DATA._meta.confidence,
  };
}

/* -------------------------------------------------------------- system study */
// For every switchgear / MCC / panel bus. IEEE 1584 wants the three-phase bolted fault current at the
// nominal system voltage. analyseSystem reports the IEC 60909 I"k with voltage factor c_max (1.05 at <= 1 kV,
// 1.10 above), which is deliberately a margin, so Ibf = ik_ka / c_max removes that margin. Motor contribution
// (analysis opts) is whatever the short-circuit run used. Upstream device clearing times are inputs: the
// defaults below are assumptions, not device data.
export const DEFAULT_CLEARING_MS = { mv: 200, lv: 300 };
export function arcFlashStudy(analysis, sys, opts = {}) {
  const rows = [];
  if (!analysis?.equipment) return rows;
  for (const raw of sys?.equipment || []) {
    if (!NODE_KINDS.has(raw.type)) continue;
    const r = analysis.equipment[raw.id];
    const kv = r?.kv ?? raw.kv;
    if (!r || r.ik_ka == null || !(kv > 0)) continue;
    const cls = classFor(raw.type, kv), d = CLASS_DEFAULTS[cls];
    const ibf = r.ik_ka / cMax(kv);
    const assumed = !(raw.af_clearing_ms > 0);
    const clearing = assumed ? (kv > 1 ? opts.mv_clearing_ms ?? DEFAULT_CLEARING_MS.mv : opts.lv_clearing_ms ?? DEFAULT_CLEARING_MS.lv) : raw.af_clearing_ms;
    const inp = { voc_kv: kv, ibf_ka: ibf, gap_mm: raw.af_gap_mm ?? d.gap_mm, working_mm: raw.af_working_mm ?? d.working_mm, config: raw.af_config ?? d.config,
      enclosure: d.enclosure, clearing_ms: clearing, clearing_reduced_ms: raw.af_clearing_reduced_ms ?? clearing, allow_placeholder_data: !!opts.allow_placeholder_data };
    try {
      // No incident energy outside the model voltage range: a number (and a printable label) at 34.5 kV or
      // 230 kV would look authoritative but IEEE 1584-2018 does not cover it. arcFlash() itself still runs
      // with a warning for callers that want the extrapolation.
      if (kv > 15) throw new Error(`${kv} kV is above the IEEE 1584-2018 range (208 V to 15 kV); use a method that covers this voltage.`);
      const res = arcFlash(inp);
      rows.push({ id: raw.id, name: raw.name, type: raw.type, class: cls, class_label: d.label, input: inp, clearing_assumed: assumed,
        note: assumed ? "assumed — set the upstream device clearing time" : null, ...res });
    } catch (err) {
      rows.push({ id: raw.id, name: raw.name, type: raw.type, class: cls, class_label: d.label, input: inp, error: err.message,
        placeholder: err.name === "DataStatusError", data_status: DATA_STATUS });
    }
  }
  return rows;
}
