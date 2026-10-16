/* Cable bus designer: generate, check and rank complete design options. Port of pecalc/cablebus_design.py.
   Pure module: no DOM, no React.

   For a required voltage and current, every practical combination of conductor size, conductors per phase
   and stacked tiers (1, 2 or 3) is laid out with the code spacing (one cable diameter clear between cables
   and between tiers, NEC 370 / CSA C22.2 No. 273 free-air basis), fitted into the smallest standard
   enclosure, and run through the full cable bus analysis. The best options are then checked for
   short-circuit forces on the support blocks.

   Enclosure sizes and clearances are catalogue/design inputs, not code values. */
import * as cond from "./conductors.js";
import { cableBusInput, analyse, construction, perCableAmpacity, resolveMethod, pyG } from "./cablebus.js";
import { freeAirAmpacity } from "./thermal.js";
import { pyRound, pyFixed } from "./util.js";

// Typical support-block laminate properties (MPa). [UNVERIFIED: typical NEMA LI 1 / supplier
// datasheet values; use the block supplier's tested rating when available]
export const BLOCK_MATERIALS = {
  "GPO-3": { tensile: 69.0, flexural: 165.0, compressive: 240.0 },
  "GPO-2": { tensile: 69.0, flexural: 150.0, compressive: 240.0 },
  "GPO-1": { tensile: 55.0, flexural: 125.0, compressive: 205.0 },
};
export const INCH = 25.4;

const _REQ_DEFAULTS = {
  code: "NEC", voltage_v: 600.0, current_a: 2000.0, power_factor: 0.9, frequency_hz: 60.0, length_m: 60.0,
  ambient_c: 40.0, material: "Cu",
  sizes: null,                    // default: 500, 600, 750, 1000 kcmil
  max_per_phase: 12,
  extra_per_phase: 2,             // also try this many more than the minimum
  tier_options: [1, 2, 3],
  ampacity_method: "auto", insulation_temp_c: 90, terminal_temp_c: 90,
  insulation: "XLPE", insulation_mm: null, shield_mm: 0.0, jacket_mm: 0.0, jacket: "PVC",
  shield_bonding: null,           // default: single_point above 2000 V, none below
  enclosure_widths_in: [12, 18, 24, 30, 36, 42, 48],
  enclosure_heights_in: [6, 8, 10, 12, 14, 16],
  edge_clearance_mm: 25.0, vertical_clearance_mm: 25.0, block_lip_mm: 10.0,
  enclosure_alloy: "6063-T6", side_thickness_mm: 6.35, covers_continuous: false,
  fault_ka: null, x_over_r: 15.0, support_span_m: 0.9144,
  block_material: "GPO-3", block_thickness_mm: 25.4, block_safety_factor: 2.0, block_rated_load_n: null,
  max_loading_pct: 95.0, max_vd_pct: 3.0, top_n: 8, allow_placeholder_data: false,
};

/** DesignRequest dataclass: defaults plus overrides. */
export function designRequest(overrides = {}) {
  for (const k of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(_REQ_DEFAULTS, k)) {
      throw new TypeError(`DesignRequest() got an unexpected keyword argument '${k}'`);
    }
  }
  return { ..._REQ_DEFAULTS, ...overrides };
}

export function designOptionLabel(o) {
  return `${o.per_phase} x ${cond.sizeLabel(o.size)} per phase, ${o.tiers} tier(s), ${o.enclosure_in} enclosure`;
}

function _baseInput(req, size) {
  const bonding = req.shield_bonding || (req.voltage_v > 2000 ? "single_point" : "none");
  return cableBusInput({
    code: req.code, voltage_v: req.voltage_v, current_a: req.current_a, power_factor: req.power_factor,
    frequency_hz: req.frequency_hz, length_m: req.length_m, material: req.material, size,
    insulation_temp_c: req.insulation_temp_c, terminal_temp_c: req.terminal_temp_c, ambient_c: req.ambient_c,
    ampacity_method: req.ampacity_method, insulation: req.insulation, insulation_mm: req.insulation_mm,
    shield_mm: req.shield_mm, jacket_mm: req.jacket_mm, jacket: req.jacket, shield_bonding: bonding,
    max_vd_pct: req.max_vd_pct, enclosure_alloy: req.enclosure_alloy, side_thickness_mm: req.side_thickness_mm,
    covers_continuous: req.covers_continuous, x_over_r: req.x_over_r, support_span_m: req.support_span_m,
    allow_placeholder_data: req.allow_placeholder_data, field_distances_m: [1.0],
  });
}

function _cableOd(req, base) {
  const cons = construction(base);
  if (cons) return cons.de_mm;
  if (req.voltage_v > 2000) {
    throw new Error("Above 2000 V give the cable construction (insulation_mm, shield_mm, jacket_mm)");
  }
  return cond.cableOdMm(base.size);
}

/** Per-cable ampacity ignoring sharing imbalance and shield loss (screening only). */
function _estimateAmpacity(base, od) {
  if (resolveMethod(base) === "calculated") {
    const cons = construction(base);
    if (cons === null) throw new Error("Calculated ampacity needs the cable construction");
    return freeAirAmpacity(cons, base.ambient_c,
      { installation: "isolated", lambda1: 0.0, freq: base.frequency_hz, spacing_mm: 2 * od }).ampacity_a;
  }
  return perCableAmpacity(base)[0];
}

function _fitEnclosure(req, per_tier, tiers, od) {
  const pitch = 2 * od;
  const need_w = (per_tier - 1) * pitch + od + 2 * req.edge_clearance_mm;
  const need_h = (tiers - 1) * pitch + od + 2 * req.block_lip_mm + 2 * req.vertical_clearance_mm;
  let best = null;
  for (const w of req.enclosure_widths_in) {
    for (const h of req.enclosure_heights_in) {
      if (w * INCH >= need_w && h * INCH >= need_h && (best === null || w * h < best[0] * best[1])) best = [w, h];
    }
  }
  return best;
}

// Tuple-key comparison (Python min/sort with tuple keys); first minimum wins.
const _cmpKey = (key) => (a, b) => {
  const ka = key(a), kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
};
function _minBy(list, key) {
  const cmp = _cmpKey(key);
  let best = list[0];
  for (const c of list) if (cmp(c, best) < 0) best = c;
  return best;
}

/** Returns {request, options, considered, notes}; each option has the DesignOption fields. */
export function designOptions(req) {
  const sizes = (req.sizes && req.sizes.length ? req.sizes : ["500", "600", "750", "1000"]).map(cond.normalizeSize);
  const notes = [];
  const candidates = [];
  let considered = 0;
  for (const size of sizes) {
    const base = _baseInput(req, size);
    const od = _cableOd(req, base);
    const a_est = _estimateAmpacity(base, od);
    if (a_est === 0) throw new Error("division by zero");
    const n_min = Math.max(1, Math.ceil(req.current_a / a_est));
    if (n_min > req.max_per_phase) {
      notes.push(`${cond.sizeLabel(size)}: needs ${n_min} per phase (> ${req.max_per_phase}); skipped.`);
      continue;
    }
    for (let n = n_min; n <= Math.min(req.max_per_phase, n_min + req.extra_per_phase); n++) {
      for (const tiers of req.tier_options) {
        if ((3 * n) % tiers || ((3 * n) / tiers) % 3) continue;
        const per_tier = (3 * n) / tiers;
        const fit = _fitEnclosure(req, per_tier, tiers, od);
        if (fit === null) continue;
        considered += 1;
        const inp = { ...base, field_distances_m: [...base.field_distances_m], conductors_per_phase: n, tiers,
          cable_od_mm: od, enclosure_width_mm: fit[0] * INCH, enclosure_height_mm: fit[1] * INCH };
        const r = analyse(inp, false);
        const case_inputs = { ...inp, field_distances_m: [...inp.field_distances_m] }; // asdict(inp), after analyse
        const failed = r.checks.filter((c) => !c.passed).map((c) => c.name);
        if (r.max_loading_pct > req.max_loading_pct) failed.push(`Loading above ${pyG(req.max_loading_pct)} %`);
        candidates.push({
          rank: 0, size, per_phase: n, tiers, pattern: r.pattern, enclosure_in: `${pyG(fit[0])} x ${pyG(fit[1])} in`,
          inside_w_mm: pyRound(fit[0] * INCH, 1), inside_h_mm: pyRound(fit[1] * INCH, 1), cable_od_mm: pyRound(od, 1),
          max_loading_pct: r.max_loading_pct, vd_pct: r.vd_pct,
          loss_kw: pyRound((r.conductor_loss_w + r.shield_loss_w + r.enclosure_loss_w) / 1000, 2),
          enclosure_loss_kw: pyRound(r.enclosure_loss_w / 1000, 2),
          copper_mm2_per_phase: pyRound(cond.areaMm2(size) * n, 0), passed: failed.length === 0,
          failed_checks: failed, block_load_n: null, block_stress_mpa: null, block_allowable_mpa: null, tags: [],
          case_inputs,
        });
      }
    }
  }

  const passing = candidates.filter((c) => c.passed);
  const failing = candidates.filter((c) => !c.passed);
  passing.sort(_cmpKey((c) => [c.copper_mm2_per_phase, c.inside_w_mm * c.inside_h_mm, c.max_loading_pct]));
  failing.sort(_cmpKey((c) => [c.max_loading_pct]));
  const ranked = passing.slice(0, req.top_n).concat(
    passing.length < 3 ? failing.slice(0, Math.max(0, req.top_n - passing.length)) : []);
  ranked.forEach((c, i) => { c.rank = i + 1; });

  if (passing.length) {
    const least_cu = _minBy(passing, (c) => [c.copper_mm2_per_phase, c.inside_w_mm * c.inside_h_mm]);
    const smallest = _minBy(passing, (c) => [c.inside_w_mm * c.inside_h_mm, c.copper_mm2_per_phase]);
    const margin = _minBy(passing, (c) => [c.max_loading_pct, c.copper_mm2_per_phase]);
    for (const [c, tag] of [[least_cu, "least copper"], [smallest, "smallest enclosure"], [margin, "most margin"]]) {
      c.tags.push(tag);
      if (!ranked.includes(c)) ranked.push(c);
    }
    ranked.forEach((c, i) => { c.rank = i + 1; });
  }

  if (req.fault_ka) {
    const mat = Object.prototype.hasOwnProperty.call(BLOCK_MATERIALS, req.block_material)
      ? BLOCK_MATERIALS[req.block_material] : null;
    const allow = mat ? mat.tensile / req.block_safety_factor : null;
    for (const c of ranked) {
      const r = analyse(cableBusInput({ ...c.case_inputs, fault_ka: req.fault_ka }), false);
      const load = r.fault_force_n_per_m * req.support_span_m; // N on one block at the worst cable
      const ligament = Math.min(r.pitch_mm - r.cable_od_mm, r.cable_od_mm);
      const stress = load / (req.block_thickness_mm * ligament); // N/mm2 = MPa
      c.block_load_n = pyRound(load, 0);
      c.block_stress_mpa = pyRound(stress, 1);
      c.block_allowable_mpa = allow === null ? null : pyRound(allow, 1);
      if (allow !== null && stress > allow) {
        c.passed = false;
        c.failed_checks.push(`${req.block_material} block web stress ${pyFixed(stress, 1)} > ${pyFixed(allow, 1)} MPa`);
      }
      if (req.block_rated_load_n && load > req.block_rated_load_n) {
        c.passed = false;
        c.failed_checks.push(`Block load ${pyFixed(load, 0)} N > rated ${pyFixed(req.block_rated_load_n, 0)} N`);
      }
    }
    notes.push(`Support blocks: ${req.block_material}, ${pyG(req.block_thickness_mm)} mm thick along the run, ` +
      `supports every ${pyG(req.support_span_m)} m. Web stress = peak cable force x span / ` +
      "(block thickness x ligament between cables), allowable = tensile strength / " +
      `${pyG(req.block_safety_factor)} [screening; material values UNVERIFIED]. A tested block ` +
      "rating (CSA C22.2 No. 273 / IEEE C37.23 short-circuit test) governs.");
  }
  notes.push("Enclosure sizes are a configurable catalogue (inside width x height, inches); clearances " +
    `${pyG(req.edge_clearance_mm)} mm to the side rails and ${pyG(req.vertical_clearance_mm)} mm to the covers ` +
    "are design defaults, not code values.");
  notes.push("Spacing basis: one cable diameter clear between cables and between tiers (free-air rating, " +
    "NEC 370 / CSA C22.2 No. 273) [clause text UNVERIFIED].");
  if (req.code === "CEC" && req.voltage_v <= 2000 && ["auto", "table"].includes(req.ampacity_method)) {
    notes.push("CEC low-voltage table method requires the CSA C22.1 tables to be entered first.");
  }
  return { request: req, options: ranked, considered, notes };
}
