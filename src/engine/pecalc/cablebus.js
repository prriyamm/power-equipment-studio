/* Cable bus design check, any voltage (600 V to 35 kV class) and rating. Port of pecalc/cablebus.py.
   Pure module: no DOM, no React.

   Builds the conductor layout (tiers, spacing, phase pattern), solves current sharing among paralleled
   conductors and induced shield / enclosure currents with the multi-conductor impedance model, then
   checks each conductor against its ampacity, and reports voltage drop, losses, magnetic field and
   short-circuit forces.

   Ampacity per conductor comes from the code free-air table (LV, <= 2000 V), a per-cable datasheet
   rating corrected to site ambient, or the IEC 60287 thermal model ("calculated").

   Input and result objects use the same snake_case field names as the Python dataclasses. */
import * as amp from "./ampacity.js";
import * as cond from "./conductors.js";
import { LIMITS_UT, bRmsUt } from "./field.js";
import { faultForces } from "./forces.js";
import { conductor, balancedThreePhase, group, solveSharing, sharePct, groupLossWPerM } from "./impedance.js";
import { cableConstruction, freeAirAmpacity, ampacitySummary } from "./thermal.js";
import { pyRound, pyFixed, pyRepr, lookup, cabs, cdiv } from "./util.js";
import NEC from "./data/ampacity_nec.json" with { type: "json" };
import CEC from "./data/ampacity_cec.json" with { type: "json" };

export const PHASES = ["A", "B", "C"];
export const CU_RHO20 = 1.7241e-8; // ohm m, annealed copper (shield tapes / wires)
// Aluminum alloy resistivity at 20 C, ohm m, and temperature coefficient.
// [UNVERIFIED: typical handbook values, 6063-T6 ~53 % IACS, 6061-T6 ~43 % IACS]
export const AL_ALLOYS = { "6063-T6": 3.25e-8, "6061-T6": 3.99e-8, "1350": 2.82e-8 };
export const AL_ALPHA = 0.0040;

const _AMP_TABLES = { NEC, CEC };

/* Python-style formatting helpers (shared with cablebus_design.js). */

/** repr() of a Python float: integers get a trailing ".0". */
export function pyFloat(x) {
  if (Number.isInteger(x)) return `${x}.0`;
  return String(x);
}

/** Python format(x, "g"): six significant digits, trailing zeros stripped. */
export function pyG(x) {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    const sign = e[0] === "-" ? "-" : "+";
    const digits = e.replace(/^[+-]/, "").padStart(2, "0");
    return `${m.replace(/0+$/, "").replace(/\.$/, "")}e${sign}${digits}`;
  }
  const s = x.toPrecision(6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

const _DEFAULTS = {
  code: "NEC",
  voltage_v: 600.0,           // line-to-line
  current_a: 2000.0,          // system rating per phase
  power_factor: 0.9,
  frequency_hz: 60.0,
  length_m: 60.0,
  material: "Cu",
  size: "750",
  conductors_per_phase: 3,
  tiers: 1,
  cable_od_mm: null,          // required above 2000 V; estimated for LV if omitted
  spacing_mm: null,           // centre-to-centre in a tier; default 2 x OD (1 OD clearance)
  tier_spacing_mm: null,      // centre-to-centre between tiers; default = spacing
  pattern: "auto",            // e.g. "ABCCBA" or "ABCCBA/CBAABC" for tiers, or "auto"
  insulation_temp_c: 90,
  terminal_temp_c: 90,        // equipment termination rating (NEC 110.14(C) / CEC 4-006)
  ambient_c: 40.0,
  ampacity_method: "auto",    // auto | table | datasheet | calculated
  cable_ampacity_a: null,     // datasheet free-air rating per cable
  cable_ampacity_ambient_c: 40.0,
  insulation: "XLPE",
  insulation_mm: null,        // incl. conductor/insulation screens for MV
  shield_mm: 0.0,
  jacket_mm: 0.0,
  jacket: "PVC",
  shield_bonding: "none",     // none | single_point | both_ends
  shield_area_mm2: null,
  shield_mean_diameter_mm: null,
  shield_temp_c: 80.0,
  fault_ka: null,
  x_over_r: 15.0,
  support_span_m: 0.9144,     // block / support spacing along the run (36 in)
  max_vd_pct: 3.0,
  enclosure_width_mm: null,
  enclosure_height_mm: null,
  side_thickness_mm: 6.35,
  cover_thickness_mm: 3.175,
  covers_continuous: false,
  enclosure_alloy: "6063-T6",
  enclosure_temp_c: 50.0,
  enclosure_filaments: 6,
  field_distances_m: [0.3, 1.0],
  allow_placeholder_data: false,
};

/** CableBusInput dataclass: defaults plus overrides; unknown keys are rejected like Python's TypeError. */
export function cableBusInput(overrides = {}) {
  for (const k of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(_DEFAULTS, k)) {
      throw new TypeError(`CableBusInput() got an unexpected keyword argument ${pyRepr(k)}`);
    }
  }
  const out = { ..._DEFAULTS, ...overrides };
  out.field_distances_m = [...out.field_distances_m];
  return out;
}

// --- layout -----------------------------------------------------------------

const _ROT = { A: "C", B: "A", C: "B" };
const _rev = (s) => [...s].reverse().join("");

export function candidatePatterns(n_per_phase, tiers) {
  const total = 3 * n_per_phase;
  if (total % tiers) throw new Error(`${total} conductors cannot be split evenly into ${tiers} tiers`);
  const per_tier = total / tiers;
  if (per_tier % 3) throw new Error(`Each tier needs a multiple of 3 conductors (got ${per_tier})`);
  const k = per_tier / 3;
  const seq = "ABC".repeat(k);
  let mirrored = "";
  for (let i = 0; i < k; i++) mirrored += i % 2 === 0 ? "ABC" : "CBA";
  const range = [...Array(tiers).keys()];
  const rows = [
    range.map(() => seq),
    range.map(() => mirrored),
    range.map((t) => (t % 2 === 0 ? mirrored : _rev(mirrored))),
    range.map((t) => (t % 2 === 0 ? mirrored : [...mirrored].map((ch) => _ROT[ch]).join(""))),
  ];
  const out = [];
  for (const r of rows) {
    const p = r.join("/");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function _checkPattern(pattern, n_per_phase, tiers) {
  const rows = pattern.toUpperCase().split("/");
  if (rows.length !== tiers) throw new Error(`Pattern ${pyRepr(pattern)} has ${rows.length} tiers, expected ${tiers}`);
  const flat = rows.join("");
  for (const p of PHASES) {
    const n = [...flat].filter((ch) => ch === p).length;
    if (n !== n_per_phase) throw new Error(`Pattern ${pyRepr(pattern)} must contain ${n_per_phase} x ${p}`);
  }
  if ([...flat].some((ch) => !PHASES.includes(ch))) throw new Error("Pattern may contain only A, B, C and '/'");
  return rows;
}

export function buildLayout(inp, pattern, od) {
  const rows = _checkPattern(pattern, inp.conductors_per_phase, inp.tiers);
  const pitch = inp.spacing_mm || 2 * od;
  const tier_pitch = inp.tier_spacing_mm || pitch;
  const r_core = cond.racOhmPerM(inp.size, inp.material, inp.insulation_temp_c, inp.frequency_hz, pitch);
  const gmr = cond.gmrMm(inp.size);
  const out = [];
  rows.forEach((row, t) => {
    [...row].forEach((ph, i) => {
      out.push(conductor({ x_mm: i * pitch, y_mm: t * tier_pitch, group: ph, r_ohm_per_m: r_core, gmr_mm: gmr,
        label: `${ph}${t}${i}` }));
    });
  });
  if (inp.shield_bonding === "both_ends") {
    if (!(inp.shield_area_mm2 && inp.shield_mean_diameter_mm)) {
      throw new Error("shield_area_mm2 and shield_mean_diameter_mm are required for both-ends bonding");
    }
    const rs = (CU_RHO20 * (1 + 0.00393 * (inp.shield_temp_c - 20))) / (inp.shield_area_mm2 * 1e-6);
    const rad = inp.shield_mean_diameter_mm / 2;
    for (const c of [...out]) {
      out.push(conductor({ x_mm: c.x_mm, y_mm: c.y_mm, group: "SHIELD", r_ohm_per_m: rs, gmr_mm: rad,
        label: `S-${c.label}`, tube_radius_mm: rad }));
    }
  }
  if (inp.enclosure_width_mm) out.push(...enclosureFilaments(inp, out, od));
  return out;
}

/**
 * Thin-plate enclosure walls as parallel strips (bonded at both ends).
 * Captures longitudinal induced current in the housing; transverse eddy currents within a strip are neglected.
 */
export function enclosureFilaments(inp, cores, od) {
  if (!Object.prototype.hasOwnProperty.call(AL_ALLOYS, inp.enclosure_alloy)) {
    throw new Error(`enclosure_alloy must be one of [${Object.keys(AL_ALLOYS).sort().map(pyRepr).join(", ")}]`);
  }
  const phases = cores.filter((c) => PHASES.includes(c.group));
  const xs = phases.map((c) => c.x_mm);
  const ys = phases.map((c) => c.y_mm);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const xc = (xmin + xmax) / 2, yc = (ymin + ymax) / 2;
  const w = inp.enclosure_width_mm;
  const h = inp.enclosure_height_mm || ymax - ymin + 2 * od;
  if (w < xmax - xmin + od || h < ymax - ymin + od) {
    throw new Error(`Enclosure ${pyFixed(w, 0)} x ${pyFixed(h, 0)} mm is smaller than the conductor group ` +
      `(${pyFixed(xmax - xmin + od, 0)} x ${pyFixed(ymax - ymin + od, 0)} mm)`);
  }
  const rho = AL_ALLOYS[inp.enclosure_alloy] * (1 + AL_ALPHA * (inp.enclosure_temp_c - 20));
  const n = inp.enclosure_filaments;
  const out = [];

  const strips = (x0, y0, x1, y1, t, tag) => {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const seg = length / n;
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      out.push(conductor({ x_mm: x0 + (x1 - x0) * f, y_mm: y0 + (y1 - y0) * f, group: "ENCLOSURE",
        r_ohm_per_m: rho / (seg * t * 1e-6), gmr_mm: 0.2235 * (seg + t), label: `${tag}${k}` }));
    }
  };

  const ts = inp.side_thickness_mm, tc = inp.cover_thickness_mm;
  const xl = xc - w / 2 - ts / 2, xr = xc + w / 2 + ts / 2;
  strips(xl, yc - h / 2, xl, yc + h / 2, ts, "EL");
  strips(xr, yc - h / 2, xr, yc + h / 2, ts, "ER");
  if (inp.covers_continuous) {
    const yb = yc - h / 2 - tc / 2, yt = yc + h / 2 + tc / 2;
    strips(xc - w / 2, yt, xc + w / 2, yt, tc, "ET");
    strips(xc - w / 2, yb, xc + w / 2, yb, tc, "EB");
  }
  return out;
}

/** Phase / shield / enclosure groups used by the sharing solve (private _groups in the Python). */
export function cableBusGroups(inp, with_shields) {
  const g = balancedThreePhase(inp.current_a, inp.power_factor);
  if (with_shields) g.SHIELD = group("SHIELD", "bonded");
  if (inp.enclosure_width_mm) g.ENCLOSURE = group("ENCLOSURE", "bonded");
  return g;
}

// --- ampacity ---------------------------------------------------------------

export function construction(inp) {
  if (inp.insulation_mm === null || inp.insulation_mm === undefined) return null;
  return cableConstruction(inp.size, {
    material: inp.material, insulation: inp.insulation, insulation_mm: inp.insulation_mm,
    shield_mm: inp.shield_mm, jacket_mm: inp.jacket_mm, jacket: inp.jacket, voltage_v: inp.voltage_v,
    max_temp_c: inp.insulation_temp_c,
  });
}

export function resolveMethod(inp) {
  const m = inp.ampacity_method;
  if (m === "auto") {
    if (inp.cable_ampacity_a) return "datasheet";
    if (inp.voltage_v <= 2000) return "table";
    return "calculated";
  }
  if (!["table", "datasheet", "calculated"].includes(m)) {
    throw new Error("ampacity_method must be auto, table, datasheet or calculated");
  }
  return m;
}

function _loadRatedAmbient(code) {
  return Number(_AMP_TABLES[code]._meta.rated_ambient_c);
}

/** Returns [ampacity_a, basis_text] for one cable (datasheet or code table methods). */
export function perCableAmpacity(inp) {
  if (resolveMethod(inp) === "datasheet") {
    if (!inp.cable_ampacity_a) throw new Error("ampacity_method 'datasheet' needs cable_ampacity_a");
    const f = amp.ambientFactor(inp.ambient_c, inp.insulation_temp_c, inp.cable_ampacity_ambient_c);
    return [inp.cable_ampacity_a * f,
      `Supplied rating ${pyFixed(inp.cable_ampacity_a, 0)} A at ${pyFixed(inp.cable_ampacity_ambient_c, 0)} C ` +
      `x ambient factor ${pyFixed(f, 3)} (${pyFixed(inp.ambient_c, 0)} C)`];
  }
  if (inp.voltage_v > 2000) {
    throw new Error("Code tables are loaded for <= 2000 V only; above that use the 'calculated' " +
      "method (give the cable construction) or 'datasheet' (give cable_ampacity_a)");
  }
  amp.checkStatus(inp.code, inp.allow_placeholder_data);
  const base = amp.tableAmpacity(inp.code, "free_air", inp.material, inp.size, inp.insulation_temp_c);
  if (base === null) throw new Error(`No free-air ampacity for ${inp.material} ${inp.size}`);
  const info = amp.tableInfo(inp.code, "free_air");
  const rated = _loadRatedAmbient(inp.code);
  const f = amp.ambientFactor(inp.ambient_c, inp.insulation_temp_c, rated);
  return [base * f, `${inp.code} ${info.table_name} ${pyFixed(base, 0)} A (${inp.insulation_temp_c} C column, ` +
    `data ${info.status}) x ambient factor ${pyFixed(f, 3)} (${pyFixed(inp.ambient_c, 0)} C)`];
}

// --- main -------------------------------------------------------------------

function _div(a, b) {
  if (b === 0) throw new Error("division by zero"); // Python ZeroDivisionError
  return a / b;
}

/**
 * Analyse a cable bus. inp comes from cableBusInput(); like the Python it normalises inp.size and may
 * fill in the shield geometry on it. Returns the CableBusResult fields plus `passed`.
 */
export function analyse(inp) {
  const size = cond.normalizeSize(inp.size);
  inp.size = size;
  const cons = construction(inp);
  const od = inp.cable_od_mm || (cons ? cons.de_mm : null) || (inp.voltage_v <= 2000 ? cond.cableOdMm(size) : null);
  if (!od) {
    throw new Error("Above 2000 V give cable_od_mm or the cable construction (insulation_mm, shield_mm, jacket_mm)");
  }
  const with_shields = inp.shield_bonding === "both_ends";
  if (with_shields && cons && cons.shield_mm) {
    inp.shield_mean_diameter_mm = inp.shield_mean_diameter_mm || cons.shield_mean_diameter_mm;
    inp.shield_area_mm2 = inp.shield_area_mm2 || Math.PI * cons.shield_mean_diameter_mm * cons.shield_mm;
  }
  const method = resolveMethod(inp);
  const notes = [];

  const patterns = inp.pattern === "auto" ? candidatePatterns(inp.conductors_per_phase, inp.tiers)
    : [inp.pattern.toUpperCase()];
  const scored = [];
  for (const p of patterns) {
    const cs = buildLayout(inp, p, od);
    const res = solveSharing(cs, cableBusGroups(inp, with_shields), inp.frequency_hz);
    const phase_idx = [];
    cs.forEach((c, i) => { if (PHASES.includes(c.group)) phase_idx.push(i); });
    let loss = 0;
    for (const l of res.losses_w_per_m) loss += l;
    scored.push([p, cs, res, Math.max(...phase_idx.map((i) => sharePct(res, i))), loss]);
  }
  scored.sort((a, b) => {
    const ra = pyRound(a[3], 1), rb = pyRound(b[3], 1);
    return ra !== rb ? ra - rb : a[4] - b[4];
  });
  const [pattern, cs, res] = scored[0];
  const compared = scored.map(([p, , , m, l]) => ({ pattern: p, max_share_pct: pyRound(m, 1), loss_w_per_m: pyRound(l, 2) }));

  const pitch = inp.spacing_mm || 2 * od;
  const labels = {};
  cs.forEach((c, i) => { labels[c.label] = i; });
  let a_term = null;
  let ampacityFor = null, a_cable = null, basis_fixed = null;
  if (method === "calculated") {
    if (cons === null) throw new Error("The calculated ampacity method needs the cable construction (insulation_mm etc.)");
    const installation = pitch - od >= 0.75 * od ? "isolated" : "flat_touching";
    const cache = new Map();
    ampacityFor = (i) => {
      const core_loss = res.losses_w_per_m[i];
      const s = labels[`S-${cs[i].label}`];
      const lam = s !== undefined && core_loss ? pyRound(res.losses_w_per_m[s] / core_loss, 4) : 0.0;
      if (!cache.has(lam)) {
        cache.set(lam, freeAirAmpacity(cons, inp.ambient_c,
          { installation, lambda1: lam, freq: inp.frequency_hz, spacing_mm: pitch }));
      }
      return cache.get(lam);
    };
    notes.push("Calculated ampacity (IEC 60287 / Neher-McGrath thermal model) is permitted by NEC 310.14(B) / " +
      "315.60(B) under engineering supervision; model constants are UNVERIFIED pending check against " +
      "IEC 60287. Each cable's own shield loss factor (lambda1) from the sharing solve is included.");
  } else {
    [a_cable, basis_fixed] = perCableAmpacity(inp);
    if (method === "table") a_term = amp.tableAmpacity(inp.code, "free_air", inp.material, size, inp.terminal_temp_c);
  }

  const rows = [];
  let worst = null;
  cs.forEach((c, i) => {
    if (!PHASES.includes(c.group)) return;
    const cur = cabs(res.currents[i]);
    let a_i, basis_i;
    if (method === "calculated") {
      const ar = ampacityFor(i);
      a_i = ar.ampacity_a;
      basis_i = ampacitySummary(ar);
    } else {
      a_i = a_cable;
      basis_i = basis_fixed;
    }
    const row = {
      index: i, phase: c.group, tier: pyRound(c.y_mm / (inp.tier_spacing_mm || pitch), 0),
      x_mm: pyRound(c.x_mm, 1), y_mm: pyRound(c.y_mm, 1), current_a: pyRound(cur, 1),
      share_pct: pyRound(sharePct(res, i), 1), ampacity_a: pyRound(a_i, 1),
      loading_pct: pyRound(_div(cur, a_i) * 100, 1),
    };
    rows.push(row);
    if (worst === null || row.loading_pct > worst[0].loading_pct) worst = [row, basis_i];
  });
  const max_cur = Math.max(...rows.map((r) => r.current_a));
  const max_loading = worst[0].loading_pct;
  const basis = worst[1];

  // Voltage drop: worst phase, sending-end phase voltage as reference.
  const v_ph = inp.voltage_v / Math.sqrt(3);
  let vd_pct = -Infinity;
  for (const d of Object.values(res.group_drop_v_per_m)) {
    const m = Math.hypot(v_ph - d.re * inp.length_m, -(d.im * inp.length_m));
    vd_pct = Math.max(vd_pct, ((v_ph - m) / v_ph) * 100);
  }
  const cond_loss = groupLossWPerM(res, "phase") * inp.length_m;
  let shield_loss = 0, encl_loss = 0;
  cs.forEach((c, i) => {
    if (c.group === "SHIELD") shield_loss += res.losses_w_per_m[i];
    if (c.group === "ENCLOSURE") encl_loss += res.losses_w_per_m[i];
  });
  shield_loss *= inp.length_m;
  encl_loss *= inp.length_m;
  let shield_i = 0.0;
  cs.forEach((c, i) => { if (c.group === "SHIELD") shield_i = Math.max(shield_i, cabs(res.currents[i])); });
  let encl_i = 0.0;
  if (inp.enclosure_width_mm) {
    for (const side of ["EL", "ER", "ET", "EB"]) {
      let re = 0, im = 0;
      cs.forEach((c, i) => { if (c.label.startsWith(side)) { re += res.currents[i].re; im += res.currents[i].im; } });
      encl_i = Math.max(encl_i, Math.hypot(re, im));
    }
  }

  // Magnetic field beside and above the group, measured from the outer surface.
  const xs = cs.map((c) => c.x_mm), ys = cs.map((c) => c.y_mm);
  const right = Math.max(...xs) + od / 2, top = Math.max(...ys) + od / 2;
  const xmid = (Math.min(...xs) + Math.max(...xs)) / 2, ymid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const field_ut = {};
  for (const d of inp.field_distances_m) {
    field_ut[`side ${pyG(d)} m`] = pyRound(bRmsUt(cs, res.currents, right + d * 1000, ymid), 2);
    field_ut[`top ${pyG(d)} m`] = pyRound(bRmsUt(cs, res.currents, xmid, top + d * 1000), 2);
  }

  const clauses = lookup(amp.CLAUSES, inp.code);
  const checks = [];
  const check = (name, clause, value, limit, unit, passed, note = "") => {
    checks.push({ name, clause, value: pyRound(value, 2), limit: pyRound(limit, 2), unit, passed: Boolean(passed), note });
  };

  const min_size = lookup(lookup(amp.PARALLEL_MIN, inp.code), inp.material);
  if (inp.conductors_per_phase > 1) {
    check("Minimum size for paralleled conductors", clauses.parallel, cond.sizeIndex(size),
      cond.sizeIndex(min_size), "size index", cond.sizeIndex(size) >= cond.sizeIndex(min_size),
      `min ${cond.sizeLabel(min_size)}`);
  }
  if (method === "table") {
    check("Spacing for free-air ampacity basis (>= 1 cable diameter clearance)",
      "NEC 370.80 / CEC 12-2252 [UNVERIFIED]", pitch - od, od, "mm", pitch - od >= od - 1e-6);
  }
  const w = worst[0];
  check("Most heavily loaded conductor within its ampacity", basis, w.current_a, w.ampacity_a, "A",
    w.current_a <= w.ampacity_a, `${w.phase} at x=${pyFloat(w.x_mm)} mm; current sharing solved for pattern ${pattern}`);
  if (a_term !== null) {
    check("Most heavily loaded conductor within termination rating", clauses.terminal, max_cur, a_term,
      "A", max_cur <= a_term, `${inp.terminal_temp_c} C column, no ambient correction`);
  }
  check("Voltage drop (worst phase)", clauses.vd, vd_pct, inp.max_vd_pct, "%", vd_pct <= inp.max_vd_pct);

  let f_nm = null, f_lbf = null, support = null;
  if (inp.fault_ka) {
    const share = {};
    cs.forEach((c, i) => {
      if (PHASES.includes(c.group)) share[i] = cdiv(res.currents[i], res.groups[c.group].current);
    });
    const fr = faultForces(cs, share, inp.fault_ka, inp.x_over_r, { freq: inp.frequency_hz });
    f_nm = fr.worst_n_per_m;
    f_lbf = fr.worst_lbf_per_ft;
    support = (fr.worst_n_per_m * inp.support_span_m) / 4.44822;
    notes.push(`Fault: ${pyFloat(inp.fault_ka)} kA rms sym, X/R ${pyFloat(inp.x_over_r)}, first peak ` +
      `${pyFixed(fr.peak_current_ka, 1)} kA; worst conductor force ${pyFixed(f_nm, 0)} N/m ` +
      `(${pyFixed(f_lbf, 0)} lbf/ft); load on one support over a ${pyFixed(inp.support_span_m, 3)} m span ~ ` +
      `${pyFixed(support, 0)} lbf (static; compare with tested block strength).`);
  }

  if (with_shields) {
    notes.push(`Shields bonded both ends: max circulating current ${pyFixed(shield_i, 0)} A, ` +
      `shield loss ${pyFixed(shield_loss / 1000, 2)} kW (${pyFixed((shield_loss / Math.max(cond_loss, 1e-9)) * 100, 1)} % of ` +
      "conductor loss). Single-point or cross bonding removes most of this.");
  }
  if (inp.voltage_v > 2000 && inp.shield_bonding === "none") {
    notes.push("MV cable selected with shield_bonding 'none': set 'single_point' or 'both_ends' to state the design.");
  }
  if (method === "table") notes.push(`${inp.code} table data status: ${amp.tableInfo(inp.code, "free_air").status}.`);
  if (inp.enclosure_width_mm) {
    notes.push(`Enclosure (${inp.enclosure_alloy}, sides${inp.covers_continuous ? " + covers" : " only"}): ` +
      `induced current up to ${pyFixed(encl_i, 0)} A per wall, loss ${pyFixed(encl_loss / 1000, 2)} kW ` +
      `(${pyFixed((encl_loss / Math.max(cond_loss, 1e-9)) * 100, 1)} % of conductor loss). Longitudinal circulating ` +
      "current only; transverse eddy and hysteresis (none in Al) not included.");
  } else {
    notes.push("Enclosure not modelled (give enclosure_width_mm to include induced housing currents).");
  }
  if (Object.keys(field_ut).length) {
    const worst_b = Math.max(...Object.values(field_ut));
    notes.push("Magnetic field (RMS resultant) " +
      Object.entries(field_ut).map(([k, v]) => `${k}: ${pyFloat(v)} uT`).join(", ") +
      `. Reference levels at 60 Hz: ICNIRP 1998 public ${pyFloat(LIMITS_UT["ICNIRP 1998 public"])} uT, ` +
      `occupational ${pyFloat(LIMITS_UT["ICNIRP 1998 occupational"])} uT` +
      `${worst_b > LIMITS_UT["ICNIRP 1998 public"] ? " - EXCEEDS public level" : ""}.`);
  }

  const width = Math.max(...rows.map((r) => r.x_mm)) + od;
  const height = Math.max(...rows.map((r) => r.y_mm)) + od;
  return {
    input: inp, pattern, patterns_compared: compared,
    layout_width_mm: pyRound(width, 1), layout_height_mm: pyRound(height, 1), conductors: rows,
    ampacity_basis: basis, max_loading_pct: pyRound(max_loading, 1), vd_pct: pyRound(vd_pct, 3),
    conductor_loss_w: pyRound(cond_loss, 1), shield_loss_w: pyRound(shield_loss, 1),
    shield_current_a: pyRound(shield_i, 1), enclosure_loss_w: pyRound(encl_loss, 1),
    enclosure_current_a: pyRound(encl_i, 1), field_ut,
    fault_force_n_per_m: f_nm === null ? null : pyRound(f_nm, 1),
    fault_force_lbf_per_ft: f_lbf === null ? null : pyRound(f_lbf, 1),
    support_load_lbf: support === null ? null : pyRound(support, 1),
    checks, notes, cable_od_mm: pyRound(od, 2), pitch_mm: pyRound(pitch, 2),
    tier_pitch_mm: pyRound(inp.tier_spacing_mm || pitch, 2),
    passed: checks.every((c) => c.passed),
  };
}
