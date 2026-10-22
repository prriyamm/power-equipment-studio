// Feeder conductor sizing: ampacity, parallel sets, voltage drop, losses. Port of pecalc/sizing.py.
//
// For each number of parallel sets the smallest conductor passing every check
// is found; the option with the least total conductor area is recommended and
// the alternatives are kept so the engineer can choose.
import * as amp from "./ampacity.js";
import * as cond from "./conductors.js";
import { selectLugs, lugInput, defaultTerminalTemp } from "./lugs.js";
import * as validate from "./validate.js";
import { pyRound, pyFixed, pyRepr, lookup } from "./util.js";
import { reactancePer1000ft, RACEWAYS, DERIVED_SIZES, DERIVED_META } from "../reactanceDerived.js";
import NEC from "./data/ampacity_nec.json" with { type: "json" };
import CEC from "./data/ampacity_cec.json" with { type: "json" };
import SMALL_CONDUCTORS from "./data/nec_240_4d_small_conductors.json" with { type: "json" };

const TABLES = { NEC, CEC };
export const FT_PER_M = 1 / cond.FT;

/** Python format(x, "g") for the whole-number limits printed in notes. */
const pyG = (x) => (Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6))));

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

const isNil = (x) => x === null || x === undefined;

/** Python tuple repr, e.g. ('pvc', 'aluminum', 'steel'). */
const pyTuple = (xs) => `(${xs.map(pyRepr).join(", ")})`;

/** Returns [ohm per metre, basis]. Raceway reactance: NEC Table 9, or a DERIVED value for the sizes
 * Table 9 does not list (pecalc reactance_derived.py = src/engine/reactanceDerived.js). */
function _reactanceOhmPerM(inp, size) {
  if (inp.installation === "raceway") {
    if (!RACEWAYS.includes(inp.conduit)) throw new Error(`conduit must be one of ${pyTuple(RACEWAYS)}`);
    const found = reactancePer1000ft(cond.normalizeSize(size), inp.conduit);
    if (found !== null) {
      const basis = found.derived ? `DERIVED from NEC Ch. 9 Table 9 [${DERIVED_META.status}]` : "NEC Ch. 9 Table 9";
      return [found.xl / 1000 / cond.FT, basis];
    }
  }
  // Cables touching in trefoil (tray / free air).
  return [cond.reactanceOhmPerM(size, cond.cableOdMm(size), inp.frequency_hz), "geometric (trefoil, touching)"];
}

/** NEC 240.4(D) limit in A, or null when 240.4(D) does not list the size (data/nec_240_4d_small_conductors.json).
 * [UNVERIFIED data] */
export function smallConductorLimitA(material, size) {
  const rows = material !== "_meta" && Object.prototype.hasOwnProperty.call(SMALL_CONDUCTORS, material)
    ? SMALL_CONDUCTORS[material] : {};
  const v = rows[cond.normalizeSize(size)];
  return v === undefined || v === null ? null : Number(v);
}

/** ICEA P-32-382 adiabatic withstand: (I/A)^2 t = K log10((T2+T0)/(T1+T0)).
 * [UNVERIFIED: K = 0.0297 Cu / 0.0125 Al with A in cmil, I in A] */
function _shortCircuitCheck(inp, size, sets) {
  if (isNil(inp.fault_ka) || isNil(inp.fault_clearing_s)) return null;
  const withstand_a = cond.adiabaticWithstandA(inp.material, cond.AREA_CMIL[size] * sets, inp.insulation_temp_c,
    inp.insulation_sc_limit_c, inp.fault_clearing_s);
  return mkCheck("Short-circuit withstand (all sets)", "ICEA P-32-382", pyRound(withstand_a / 1000, 1),
    inp.fault_ka, "kA", withstand_a / 1000 >= inp.fault_ka,
    `${pyFloat(inp.fault_clearing_s)} s clearing, ${inp.insulation_temp_c}->${pyFloat(inp.insulation_sc_limit_c)} C; `
    + "250 C is the thermoset (XLPE/EPR) limit, thermoplastic insulation has a lower limit "
    + "[UNVERIFIED, ICEA P-32-382]");
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
  // NEC 110.14(C): termination limits use the 60/75 C column of Table 310.16 whatever the
  // installation; free-air (Table 310.17) ampacity applies to the conductor only.
  // CEC Rule 4-006 is left on the installation's own table [UNVERIFIED which CEC table applies].
  const term_install = code === "NEC" ? "raceway" : inp.installation;
  // NEC 110.14(C)(1) / CEC 4-006: when no terminal rating is given, the default depends on the
  // candidate conductor size (60 C for 14-1 AWG or circuits of 100 A or less, else 75 C).
  const notes = [];
  let t_term;
  if (isNil(inp.terminal_temp_c)) {
    let t_basis;
    [t_term, t_basis] = defaultTerminalTemp(code, loadA(inp), size);
    notes.push(`Terminal temperature ${t_term} C by default: ${t_basis}`);
  } else {
    t_term = inp.terminal_temp_c;
    notes.push(`Terminal temperature ${t_term} C as given (equipment marking)`);
  }
  const a_term = amp.tableAmpacity(code, term_install, mat, size, t_term);
  if (a_ins === null || a_term === null) throw new Error(`No ${code} ${inp.installation} ampacity for ${mat} ${size}`);

  const f_amb = amp.ambientFactor(inp.ambient_c, inp.insulation_temp_c);
  const f_ccc = inp.installation === "raceway" ? amp.cccFactor(code, inp.current_carrying_per_raceway) : 1.0;
  const derated = a_ins * f_amb * f_ccc;
  const allowable = Math.min(derated, a_term);
  // NEC 110.14(C): the conductor cannot use a column above the lowest temperature rating of any
  // connected termination or conductor, so the termination check uses the lesser of the conductor's
  // own (undeflated) insulation-column ampacity and the terminal column.
  const a_cond = Math.min(a_ins, a_term);
  if (inp.installation === "raceway" && sets * inp.phases > inp.current_carrying_per_raceway) {
    notes.push(`${sets} sets x ${inp.phases} phase conductors exceed current_carrying_per_raceway=`
      + `${inp.current_carrying_per_raceway}: the grouping adjustment assumes separate raceways per set`);
  }
  const load = loadA(inp);
  const per_set_load = load / sets;

  if (code === "NEC") {
    const cont_mult = inp.hundred_percent_rated ? 1.0 : 1.25;
    const required_term = (cont_mult * inp.continuous_a + inp.noncontinuous_a) / sets;
    const term_table = amp.tableInfo(code, term_install).table_name;
    checks.push(mkCheck("Terminal-column ampacity >= 125 % continuous + non-continuous",
      `${clauses.continuous}, ${clauses.terminal}`,
      a_cond, pyRound(required_term, 1), "A", a_cond >= required_term,
      `lesser of ${term_table} ${inp.insulation_temp_c} C insulation column (${pyFixed(a_ins, 0)} A) and `
      + `${t_term} C terminal column (${pyFixed(a_term, 0)} A), no derating; the conductor cannot `
      + "use a column above its terminations' rating (NEC 110.14(C))"));
    // NEC 240.4(D): the overcurrent device for 18-10 AWG may not exceed the listed rating.
    // The device must be at least 125 % continuous + non-continuous (215.3; 100 % if listed),
    // so that minimum rating is checked against the limit. Small sizes cannot be paralleled.
    const limit = smallConductorLimitA(mat, size);
    if (limit !== null) {
      const ocpd_min = cont_mult * inp.continuous_a + inp.noncontinuous_a;
      checks.push(mkCheck("Minimum OCPD rating <= small-conductor limit", "NEC 240.4(D) [data UNVERIFIED]",
        pyRound(ocpd_min, 1), limit, "A", ocpd_min <= limit,
        `${cond.sizeLabel(size)} ${mat}: max overcurrent device ${pyG(limit)} A`));
    }
    checks.push(mkCheck("Derated ampacity >= load", `${clauses.continuous}(b)`,
      pyRound(derated, 1), pyRound(per_set_load, 1), "A", derated >= per_set_load,
      `${pyFixed(a_ins, 0)} A x ${pyFixed(f_amb, 3)} ambient x ${pyFixed(f_ccc, 2)} grouping`));
  } else { // CEC: continuous load limited to 80 % (100 % rated: 100 %) of conductor ampacity
    const cont_div = inp.hundred_percent_rated ? 1.0 : 0.80;
    const required = (inp.continuous_a / cont_div + inp.noncontinuous_a) / sets;
    checks.push(mkCheck("Allowable ampacity >= continuous / 0.8 + non-continuous",
      `${clauses.continuous}, ${clauses.terminal}`,
      pyRound(allowable, 1), pyRound(required, 1), "A", allowable >= required,
      `min(${pyFixed(a_ins, 0)} A x ${pyFixed(f_amb, 3)} x ${pyFixed(f_ccc, 2)}, ${t_term} C column ${pyFixed(a_term, 0)} A)`));
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
    checks, notes, passed: checks.every((c) => c.passed),
  };
}

function _validateInput(inp) {
  if (!amp.CODES.includes(inp.code)) throw new Error(`code must be one of ${pyTuple(amp.CODES)}`);
  if (!Object.prototype.hasOwnProperty.call(cond.MATERIALS, inp.material)) throw new Error("material must be 'Cu' or 'Al'");
  validate.nonNegative("continuous_a", inp.continuous_a, "A");
  validate.nonNegative("noncontinuous_a", inp.noncontinuous_a, "A");
  if (loadA(inp) <= 0) {
    throw new Error("load current must be positive (continuous_a + noncontinuous_a must be greater than 0 A)");
  }
  validate.voltage("voltage_v", inp.voltage_v);
  validate.oneOf("phases", inp.phases, [1, 3]);
  validate.positive("length_m", inp.length_m, "m");
  validate.powerFactor("power_factor", inp.power_factor);
  validate.positive("max_vd_pct", inp.max_vd_pct, "%");
  validate.positive("frequency_hz", inp.frequency_hz, "Hz");
  validate.integerAtLeast("current_carrying_per_raceway", inp.current_carrying_per_raceway, 1);
  validate.inRange("ambient_c", inp.ambient_c, -50, 100, "C");
  validate.inRange("conductor_temp_for_vd_c", inp.conductor_temp_for_vd_c, -50, 250, "C");
  validate.oneOf("insulation_temp_c", inp.insulation_temp_c, amp.COLUMNS);
  if (!isNil(inp.terminal_temp_c)) validate.oneOf("terminal_temp_c", inp.terminal_temp_c, amp.COLUMNS);
  if (!isNil(inp.sets)) validate.integerAtLeast("sets", inp.sets, 1);
  validate.integerAtLeast("max_sets", inp.max_sets, 1);
  validate.positive("insulation_sc_limit_c", inp.insulation_sc_limit_c, "C");
  if (isNil(inp.fault_ka) !== isNil(inp.fault_clearing_s)) {
    throw new Error("fault_ka and fault_clearing_s must be given together for the short-circuit check; "
      + "only one was given");
  }
  if (!isNil(inp.fault_clearing_s)) validate.clearingTime("fault_clearing_s", inp.fault_clearing_s);
  if (!isNil(inp.fault_ka)) validate.positive("fault_ka", inp.fault_ka, "kA");
  if (!amp.INSTALLATIONS.includes(inp.installation)) {
    throw new Error(`installation must be one of ${pyTuple(amp.INSTALLATIONS)}`);
  }
  if (inp.installation === "raceway" && !RACEWAYS.includes(inp.conduit)) {
    throw new Error(`conduit must be one of ${pyTuple(RACEWAYS)}`);
  }
  if (inp.code === "NEC" && inp.voltage_v > 1000) {
    throw new Error("voltage_v above 1000 V is outside NEC Article 215 (feeders not over 1000 V ac, "
      + "NFPA 70-2023 215.1); Part III of Article 235 applies above 1000 V and is not implemented");
  }
  if (inp.voltage_v > 2000) {
    throw new Error("This module covers 0-2000 V conductors; medium-voltage tables are not loaded yet");
  }
}

/** Size the feeder. Unlike the Python, the input object is not mutated. `considered` (every option
 * evaluated, in search order) is an addition for the UI and is not part of the Python result. */
export function sizeFeeder(input) {
  const inp = { ...input };
  _validateInput(inp);
  const load = loadA(inp);
  const status = amp.checkStatus(inp.code, inp.allow_placeholder_data);
  const info = amp.tableInfo(inp.code, inp.installation);

  const rows = lookup(lookup(TABLES[inp.code], inp.installation), inp.material);
  const sizes = cond.SIZES.filter((s) => Object.prototype.hasOwnProperty.call(rows, s));
  const set_range = [];
  if (!isNil(inp.sets)) set_range.push(inp.sets);
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
  if (inp.code === "NEC") {
    notes.push("NEC 240.4(D) small-conductor limits are checked against the minimum overcurrent device " +
      "rating (data UNVERIFIED); the rest of 240.4 and device selection are not checked here.");
    if (inp.installation === "free_air") {
      notes.push("Terminations checked against Table 310.16 at the terminal temperature (NEC 110.14(C)); " +
        "conductor ampacity from Table 310.17.");
    }
  } else {
    notes.push("Overcurrent device selection and protection (CEC 14-104) are not checked here.");
  }
  if (inp.installation === "raceway") {
    notes.push(`Grouping adjustment uses current_carrying_per_raceway=${inp.current_carrying_per_raceway} `
      + "current-carrying conductors per raceway (default 3: each parallel set in its own raceway).");
  }
  if (!options.length) notes.push("No conductor size passes every check within the allowed number of sets.");
  const best = options.length ? options[0] : null;
  if (best && inp.installation === "raceway" && DERIVED_SIZES.includes(best.size)) {
    notes.push(`WARNING: reactance for ${best.size_label} in ${inp.conduit} conduit is not in NEC Table 9; ` +
      `value used is ${DERIVED_META.status}. Method: ${DERIVED_META.method}`);
  }
  let lugs = null;
  if (best) {
    lugs = selectLugs(lugInput({
      code: inp.code, size: best.size, material: inp.material, sets_per_phase: best.sets,
      phases: inp.phases, circuit_current_a: load, equipment_terminal_temp_c: inp.terminal_temp_c ?? null, // null: lugs derives its own default
    }));
  }
  return {
    input: inp, data_status: status, table: info.table_name, recommended: options[0] ?? null,
    alternatives: options.slice(1, 6), notes, lugs, considered,
  };
}
