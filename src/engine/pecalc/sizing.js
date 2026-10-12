// Feeder conductor sizing: ampacity, parallel sets, voltage drop, losses. Port of pecalc/sizing.py.
//
// For each number of parallel sets the smallest conductor passing every check
// is found; the option with the least total conductor area is recommended and
// the alternatives are kept so the engineer can choose.
import * as amp from "./ampacity.js";
import * as cond from "./conductors.js";
import { selectLugs, lugInput } from "./lugs.js";
import { pyRound, pyFixed, lookup } from "./util.js";
import REACTANCE from "./data/reactance_nec_table9.json" with { type: "json" };
import NEC from "./data/ampacity_nec.json" with { type: "json" };
import CEC from "./data/ampacity_cec.json" with { type: "json" };

const TABLES = { NEC, CEC };
export const FT_PER_M = 1 / cond.FT;

/** Python str(float): integers keep a trailing ".0". */
const pyFloat = (x) => (Number.isInteger(x) && Math.abs(x) < 1e16 ? x.toFixed(1) : String(x));

export function feederInput(overrides = {}) {
  const inp = {
    code: "NEC",                    // "NEC" or "CEC"
    voltage_v: 480.0,              // line-to-line for 3-phase
    phases: 3,
    continuous_a: 0.0,             // continuous part of the load current
    noncontinuous_a: 0.0,
    length_m: 30.0,                // one-way length
    material: "Cu",
    insulation_temp_c: 90,
    terminal_temp_c: null,         // null: NEC 110.14(C)(1) / CEC 4-006 default by current
    installation: "raceway",       // "raceway" or "free_air"
    ambient_c: 30.0,
    current_carrying_per_raceway: 3,
    conduit: "pvc",                // "pvc", "aluminum" or "steel" (raceway reactance)
    power_factor: 0.85,
    max_vd_pct: 3.0,
    hundred_percent_rated: false,  // OCPD/equipment listed for 100 % continuous
    sets: null,                    // force a number of parallel sets
    max_sets: 8,
    frequency_hz: 60.0,
    conductor_temp_for_vd_c: 75.0,
    fault_ka: null,                // optional conductor short-circuit check
    fault_clearing_s: null,
    insulation_sc_limit_c: 250.0,  // XLPE/EPR; use 150 for thermoplastic
    allow_placeholder_data: false,
  };
  for (const k of Object.keys(overrides)) {
    if (!(k in inp)) throw new TypeError(`FeederInput got an unexpected field '${k}'`);
  }
  return { ...inp, ...overrides };
}

/** Total load current: continuous plus non-continuous. */
export const loadA = (inp) => inp.continuous_a + inp.noncontinuous_a;

const mkCheck = (name, clause, value, limit, unit, passed, note = "") =>
  ({ name, clause, value, limit, unit, passed, note });

/** Returns [ohm per metre, basis]. */
function _reactanceOhmPerM(inp, size) {
  if (inp.installation === "raceway") {
    const x_kft = lookup(REACTANCE, inp.conduit)[size];
    if (x_kft !== undefined && x_kft !== null) return [x_kft / 1000 / cond.FT, "NEC Ch. 9 Table 9"];
  }
  // Cables touching in trefoil (tray / free air) or sizes beyond Table 9.
  return [cond.reactanceOhmPerM(size, cond.cableOdMm(size), inp.frequency_hz), "geometric (trefoil, touching)"];
}

/** ICEA P-32-382 adiabatic withstand: (I/A)^2 t = K log10((T2+T0)/(T1+T0)).
 * [UNVERIFIED: K = 0.0297 Cu / 0.0125 Al with A in cmil, I in A] */
function _shortCircuitCheck(inp, size, sets) {
  if (!(inp.fault_ka && inp.fault_clearing_s)) return null;
  const [k, t0] = inp.material === "Cu" ? [0.0297, 234.0] : [0.0125, 228.0];
  const area = cond.AREA_CMIL[size] * sets;
  const withstand_a = area * Math.sqrt(
    (k * Math.log10((inp.insulation_sc_limit_c + t0) / (inp.insulation_temp_c + t0))) / inp.fault_clearing_s);
  return mkCheck("Short-circuit withstand (all sets)", "ICEA P-32-382", pyRound(withstand_a / 1000, 1),
    inp.fault_ka, "kA", withstand_a / 1000 >= inp.fault_ka,
    `${pyFloat(inp.fault_clearing_s)} s clearing, ${inp.insulation_temp_c}->${pyFloat(inp.insulation_sc_limit_c)} C`);
}

export function evaluate(inp, size, sets) {
  const code = inp.code, mat = inp.material;
  const clauses = lookup(amp.CLAUSES, code);
  const checks = [];

  if (sets > 1) {
    const min_size = lookup(lookup(amp.PARALLEL_MIN, code), mat);
    checks.push(mkCheck("Minimum size for parallel sets", clauses.parallel,
      cond.sizeIndex(size), cond.sizeIndex(min_size), "size index",
      cond.sizeIndex(size) >= cond.sizeIndex(min_size), `min ${cond.sizeLabel(min_size)}`));
  }

  const a_ins = amp.tableAmpacity(code, inp.installation, mat, size, inp.insulation_temp_c);
  const a_term = amp.tableAmpacity(code, inp.installation, mat, size, inp.terminal_temp_c);
  if (a_ins === null || a_term === null) throw new Error(`No ${code} ${inp.installation} ampacity for ${mat} ${size}`);

  const f_amb = amp.ambientFactor(inp.ambient_c, inp.insulation_temp_c);
  const f_ccc = inp.installation === "raceway" ? amp.cccFactor(code, inp.current_carrying_per_raceway) : 1.0;
  const derated = a_ins * f_amb * f_ccc;
  const allowable = Math.min(derated, a_term);
  const load = loadA(inp);
  const per_set_load = load / sets;

  if (code === "NEC") {
    const cont_mult = inp.hundred_percent_rated ? 1.0 : 1.25;
    const required_term = (cont_mult * inp.continuous_a + inp.noncontinuous_a) / sets;
    checks.push(mkCheck("Terminal-column ampacity >= 125 % continuous + non-continuous",
      `${clauses.continuous}(a), ${clauses.terminal}`,
      a_term, pyRound(required_term, 1), "A", a_term >= required_term,
      `${inp.terminal_temp_c} C column, no derating`));
    checks.push(mkCheck("Derated ampacity >= load", `${clauses.continuous}(b)`,
      pyRound(derated, 1), pyRound(per_set_load, 1), "A", derated >= per_set_load,
      `${pyFixed(a_ins, 0)} A x ${pyFixed(f_amb, 3)} ambient x ${pyFixed(f_ccc, 2)} grouping`));
  } else { // CEC: continuous load limited to 80 % (100 % rated: 100 %) of conductor ampacity
    const cont_div = inp.hundred_percent_rated ? 1.0 : 0.80;
    const required = (inp.continuous_a / cont_div + inp.noncontinuous_a) / sets;
    checks.push(mkCheck("Allowable ampacity >= continuous / 0.8 + non-continuous",
      `${clauses.continuous}, ${clauses.terminal}`,
      pyRound(allowable, 1), pyRound(required, 1), "A", allowable >= required,
      `min(${pyFixed(a_ins, 0)} A x ${pyFixed(f_amb, 3)} x ${pyFixed(f_ccc, 2)}, ${inp.terminal_temp_c} C column ${pyFixed(a_term, 0)} A)`));
  }
  checks.push(mkCheck("Allowable ampacity (lesser of derated and terminal column) >= load",
    clauses.terminal, pyRound(allowable, 1), pyRound(per_set_load, 1), "A", allowable >= per_set_load));

  // Voltage drop and losses at the actual load current.
  const od = cond.cableOdMm(size);
  const r = cond.racOhmPerM(size, mat, inp.conductor_temp_for_vd_c, inp.frequency_hz, od);
  const [x, x_basis] = _reactanceOhmPerM(inp, size);
  const pf = inp.power_factor;
  const z_eff = r * pf + x * Math.sqrt(1 - pf * pf);
  const k = inp.phases === 3 ? Math.sqrt(3) : 2.0;
  const vd_v = (k * load * inp.length_m * z_eff) / sets;
  const vd_pct = (vd_v / inp.voltage_v) * 100;
  const n_cond = inp.phases === 3 ? 3 : 2;
  const loss_w = (n_cond * load ** 2 * r * inp.length_m) / sets;
  checks.push(mkCheck("Voltage drop", clauses.vd, pyRound(vd_pct, 2), inp.max_vd_pct, "%",
    vd_pct <= inp.max_vd_pct,
    `R ${pyFixed(r * 1000, 4)} ohm/km at ${pyFixed(inp.conductor_temp_for_vd_c, 0)} C, `
    + `X ${pyFixed(x * 1000, 4)} ohm/km (${x_basis}), pf ${pyFloat(pf)}`));

  const sc = _shortCircuitCheck(inp, size, sets);
  if (sc) checks.push(sc);

  return {
    sets, size, size_label: cond.sizeLabel(size), total_area_mm2: pyRound(cond.areaMm2(size) * sets, 1),
    ampacity_per_set_a: pyRound(allowable, 1), vd_pct: pyRound(vd_pct, 2), vd_v: pyRound(vd_v, 2),
    loss_w: pyRound(loss_w, 1), r_ohm_per_km: pyRound(r * 1000, 4), x_ohm_per_km: pyRound(x * 1000, 4),
    checks, passed: checks.every((c) => c.passed),
  };
}

/** Size the feeder. Unlike the Python, the input object is not mutated: result.input carries the
 * resolved terminal_temp_c. `considered` (every option evaluated, in search order) is an addition
 * for the UI and is not part of the Python result. */
export function sizeFeeder(input) {
  const inp = { ...input };
  if (!amp.CODES.includes(inp.code)) throw new Error(`code must be one of (${amp.CODES.map((c) => `'${c}'`).join(", ")})`);
  if (!Object.prototype.hasOwnProperty.call(cond.MATERIALS, inp.material)) throw new Error("material must be 'Cu' or 'Al'");
  const load = loadA(inp);
  if (load <= 0) throw new Error("load current must be positive");
  if (inp.voltage_v > 2000) {
    throw new Error("This module covers 0-2000 V conductors; medium-voltage tables are not loaded yet");
  }
  if (inp.terminal_temp_c === null || inp.terminal_temp_c === undefined) inp.terminal_temp_c = load <= 100 ? 60 : 75;
  const status = amp.checkStatus(inp.code, inp.allow_placeholder_data);
  const info = amp.tableInfo(inp.code, inp.installation);

  const rows = lookup(lookup(TABLES[inp.code], inp.installation), inp.material);
  const sizes = cond.SIZES.filter((s) => Object.prototype.hasOwnProperty.call(rows, s));
  const set_range = [];
  if (inp.sets) set_range.push(inp.sets);
  else for (let n = 1; n <= inp.max_sets; n++) set_range.push(n);

  const options = [];
  const considered = [];
  for (const n of set_range) {
    for (const size of sizes) {
      const opt = evaluate(inp, size, n);
      considered.push(opt);
      if (opt.passed) { options.push(opt); break; }
    }
  }
  options.sort((a, b) => a.total_area_mm2 - b.total_area_mm2 || a.sets - b.sets);

  const notes = [`Ampacity table: ${inp.code} ${info.table_name} (${info.edition}) - data status ${status}.`];
  if (status !== "VERIFIED") notes.push(`WARNING: ${info.source}`);
  notes.push("Overcurrent device selection and protection (NEC 240.4 / CEC 14-104) are not checked here.");
  if (!options.length) notes.push("No conductor size passes every check within the allowed number of sets.");
  let lugs = null;
  if (options.length) {
    const best = options[0];
    lugs = selectLugs(lugInput({
      code: inp.code, size: best.size, material: inp.material, sets_per_phase: best.sets,
      phases: inp.phases, circuit_current_a: load, equipment_terminal_temp_c: inp.terminal_temp_c,
    }));
  }
  return {
    input: inp, data_status: status, table: info.table_name, recommended: options[0] ?? null,
    alternatives: options.slice(1, 6), notes, lugs, considered,
  };
}
