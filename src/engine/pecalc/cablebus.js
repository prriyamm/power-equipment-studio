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
import { conductor, balancedThreePhase, group, solveSharing, sharePct, groupLossWPerM, openCircuitVoltages }
  from "./impedance.js";
import { cableConstruction, freeAirAmpacity, ampacitySummary } from "./thermal.js";
import { pyRound, pyFixed, pyRepr, pyG, lookup, KeyError, cabs, cdiv, cpolar, csub, cscale } from "./util.js";
import * as validate from "./validate.js";
import NEC from "./data/ampacity_nec.json" with { type: "json" };
import CEC from "./data/ampacity_cec.json" with { type: "json" };
import DLO from "./data/dlo_cables.json" with { type: "json" };

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

export { pyG };

const _DEFAULTS = {
  code: "NEC",
  voltage_v: 600.0,           // line-to-line
  current_a: 2000.0,          // system rating per phase
  power_factor: 0.9,
  frequency_hz: 60.0,
  length_m: 60.0,
  material: "Cu",
  size: "750",
  // Cable library: "standard" (default), "mv_construction" (same path) or "dlo_2000v" (manufacturer row, see cable_id).
  cable_type: "standard",
  cable_id: null,             // e.g. "southwire_dlo_2000v:444.4" (cable_type 'dlo_2000v' only)
  conductors_per_phase: 3,
  tiers: 1,
  cable_od_mm: null,          // required above 2000 V; estimated for LV if omitted
  spacing_mm: null,           // centre-to-centre in a tier; default 2 x OD (1 OD clearance)
  tier_spacing_mm: null,      // centre-to-centre between tiers; default = spacing
  pattern: "auto",            // e.g. "ABCCBA" or "ABCCBA/CBAABC" for tiers, or "auto"
  insulation_temp_c: 90,
  // Equipment termination rating (NEC 110.14(C) / CEC 4-006). null = derive from the voltage: 75 C up to
  // 2000 V (NEC 110.14(C)(1)(b)), 90 C above 2000 V (NEC 110.40). An explicit value always wins.
  terminal_temp_c: null,
  ambient_c: 40.0,
  ampacity_method: "auto",    // auto | table | datasheet | calculated
  cable_ampacity_a: null,     // datasheet free-air rating per cable
  cable_ampacity_ambient_c: 40.0,
  // Shield loss factor lambda1 already included in the datasheet rating. Datasheet ratings for
  // single-point or cross-bonded shields carry no circulating loss, so the default is 0.
  // Used to derate the datasheet rating when shields are bonded at both ends.
  cable_ampacity_lambda1_ref: 0.0,
  insulation: "XLPE",
  insulation_mm: null,        // incl. conductor/insulation screens for MV
  shield_mm: 0.0,
  jacket_mm: 0.0,
  jacket: "PVC",
  shield_bonding: "none",     // none | single_point | both_ends
  shield_area_mm2: null,
  shield_mean_diameter_mm: null,
  shield_temp_c: 80.0,
  // Single-point bonding: length of one bonded (minor) section; the shield is grounded at one end of
  // each section and the standing voltage builds up to the open end. null = the whole run.
  shield_section_length_m: null,
  // Owner / utility limit for the open-end standing voltage at normal load. No verified public value
  // exists (IEEE 575 practice ~25 V is a LOW-confidence secondary figure), so there is no default.
  shield_voltage_limit_v: null,
  fault_ka: null,
  fault_clearing_s: null,     // optional; enables the conductor short-circuit withstand check
  insulation_sc_limit_c: 250.0, // XLPE/EPR; use 150 for thermoplastic
  x_over_r: 15.0,
  support_span_m: 0.9144,     // block / support spacing along the run (36 in)
  // Reaction factor k_r on F*L: per_span 1.0 (flexible cable, default), continuous 1.1, pinned / fixed 0.5.
  support_condition: "per_span",
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

/** Default equipment termination temperature and its basis (used when terminal_temp_c is null). Returns [temp, basis]. */
export function defaultTerminalTempC(voltage_v) {
  if (voltage_v <= 2000) {
    return [75, "Termination temperature defaulted to 75 C: NEC 110.14(C)(1)(b) (circuits over 100 A or " +
      "conductors larger than 1 AWG; cable bus conductors are 1/0 minimum per NEC 370.20(A)(2)) " +
      "(NFPA 70-2023 pp. 70-65, 70-253). Set terminal_temp_c to 90 if the equipment is listed and " +
      "identified for 90 C conductors (110.14(C)(1)(b)(2)), or to the listed rating of separately " +
      "installed pressure connectors (110.14(C)(2))."];
  }
  return [90, "Termination temperature defaulted to 90 C above 2000 V: NEC 110.40, unless otherwise identified " +
    "(NFPA 70-2023 p. 70-73)."];
}

/**
 * Termination ampacity per conductor and the table used: [ampacity or null, table key, reason if null].
 *
 * NEC 110.14(C): the termination provisions are based on Table 310.16 (raceway) whatever the installation
 * (same rule as sizing.py); CEC 4-006 keeps the installation's table [UNVERIFIED which CEC table applies].
 * Only <= 2000 V tables are loaded.
 */
export function terminationAmpacity(inp, size, terminal_temp_c) {
  const table = inp.code === "NEC" ? "raceway" : "free_air";
  if (inp.voltage_v > 2000) {
    return [null, table, "code ampacity tables are loaded for <= 2000 V only (above that, check the " +
      "equipment termination rating, NEC 110.40)"];
  }
  let a;
  try {
    amp.checkStatus(inp.code, inp.allow_placeholder_data);
    a = amp.tableAmpacity(inp.code, table, inp.material, size, terminal_temp_c);
  } catch (e) {
    if (e instanceof KeyError) throw e; // Python catches (ValueError, DataStatusError) only
    return [null, table, e.message];
  }
  if (a === null) return [null, table, `no ${inp.code} ${table} table row for ${inp.material} ${size}`];
  return [a, table, ""];
}

/** A site ambient at or above the conductor rating gives zero ampacity (and later a zero-division). */
export function requireAmbientBelow(ambient_c, conductor_temp_c) {
  if (ambient_c >= conductor_temp_c) {
    throw new Error(`ambient_c (${pyG(ambient_c)} C) must be below the conductor temperature rating ` +
      `(${pyG(conductor_temp_c)} C)`);
  }
}

/** amp.ambientFactor for the cable bus paths: raises instead of returning 0. */
export function ambientFactorChecked(ambient_c, conductor_temp_c, rated_ambient_c = 30.0) {
  requireAmbientBelow(ambient_c, conductor_temp_c);
  return amp.ambientFactor(ambient_c, conductor_temp_c, rated_ambient_c);
}

/** Range checks on the numeric inputs, with messages that name the input. */
export const SUPPORT_REACTION = { per_span: 1.0, continuous: 1.1, pinned: 0.5, fixed: 0.5 };

export function validateInput(inp) {
  validate.voltage("voltage_v", inp.voltage_v);
  validate.positive("current_a", inp.current_a, "A");
  validate.positive("length_m", inp.length_m, "m");
  validate.positive("frequency_hz", inp.frequency_hz, "Hz");
  validate.countAtLeast("tiers", inp.tiers);
  validate.countAtLeast("conductors_per_phase", inp.conductors_per_phase);
  if (inp.fault_ka !== null && inp.fault_ka !== undefined) validate.nonNegative("fault_ka", inp.fault_ka, "kA");
  if (!Object.prototype.hasOwnProperty.call(SUPPORT_REACTION, inp.support_condition)) {
    throw new Error(`support_condition must be one of ${Object.keys(SUPPORT_REACTION).join(", ")}, ` +
      `got ${pyRepr(inp.support_condition)}`);
  }
}

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

// --- cable library (manufacturer rows) --------------------------------------
// Port of cablebus.py. Library cables are only reachable through cable_type "dlo_2000v", so the non-standard
// DLO sizes (262.6 ... 1111 kcmil) stay out of the NEC size list used by the code tables.

export const CABLE_TYPES = ["standard", "mv_construction", "dlo_2000v"];
export const DLO_STRANDING_FACTOR = cond.STRANDING_FACTOR; // 1.02, not verified for Class I stranding
// Conductor diameter / sqrt(area) for Class I stranding: 0.782 in / (sqrt(444 400 cmil) / 1000 in) = 1.173.
export const DLO_DIAMETER_RATIO = 0.782 / (Math.sqrt(444400) / 1000); // [UNVERIFIED proxy, used when not printed]

const _thousands = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function _librarySizeLabel(size) {
  if (size.includes("/") || Number(size) < 250) return `${size} AWG`;
  return `${size} kcmil`;
}

/** Library row as a plain object with the same fields as the Python CableSpec. */
export function cableSpec(cable_id) {
  const text = String(cable_id);
  const sep = text.indexOf(":");
  const key = sep >= 0 ? text.slice(0, sep) : "";
  const size = sep >= 0 ? text.slice(sep + 1) : "";
  const series = sep >= 0 && Object.prototype.hasOwnProperty.call(DLO.series, key) ? DLO.series[key] : null;
  if (series === null) {
    throw new Error(`Unknown cable_id ${pyRepr(cable_id)}; use '<series>:<size>', e.g. 'southwire_dlo_2000v:444.4'`);
  }
  const row = series.rows.find((r) => r.id === size);
  if (row === undefined) {
    throw new Error(`cable_id ${pyRepr(cable_id)}: size ${pyRepr(size)} is not in series ${pyRepr(key)}`);
  }
  const meta = DLO._meta.sources[row.source];
  const area = Number(row.area_cmil);
  let d_mm, d_src;
  if (row.conductor_diameter_in) {
    d_mm = Number(row.conductor_diameter_in) * 25.4;
    d_src = "printed";
  } else {
    d_mm = (Math.sqrt(area) / 1000) * DLO_DIAMETER_RATIO * 25.4;
    d_src = "proxy";
  }
  const rdc = row.dc_resistance_ohm_per_kft;
  const basis = row.ampacity_basis || (meta.ampacity_basis ? meta.ampacity_basis.free_air : "NOT STATED");
  return {
    cable_id: `${key}:${row.id}`, manufacturer: series.manufacturer, series: series.series,
    size: row.size, size_label: _librarySizeLabel(row.size), area_cmil: area,
    od_mm: Number(row.nominal_od_mm), insulation_mm: Number(row.insulation_mm),
    diameter_mm: d_mm, diameter_source: d_src,
    rdc_ref: rdc === null || rdc === undefined ? null : [Number(rdc.value), Number(rdc.temp_c)],
    rated_voltage_v: Number(series.voltage_v), temp_c: Number(series.temp_c),
    ampacity_free_air_a: Number(row.ampacity_free_air_90c_30c_a),
    ampacity_ref_ambient_c: Number(row.ampacity_ref_ambient_c), ampacity_basis: basis,
    basis_stated: !basis.includes("NOT STATED"), standard_nec_size: Boolean(row.standard_nec_size),
    listed_rhh: Boolean(row.listing_rhh_rhw), status: row.status,
    source_name: meta.title, source_url: meta.url, source_date: meta.date,
    flags: [...(row.flags || []), ...(d_src === "printed" ? [] : ["DIAMETER_PROXY"])],
  };
}

/** Every library row (for the UI select and the calc package). */
export function libraryEntries() {
  const out = [];
  for (const key of Object.keys(DLO.series)) {
    for (const r of DLO.series[key].rows) out.push(cableSpec(`${key}:${r.id}`));
  }
  return out;
}

export function resolveCable(inp) {
  if (!CABLE_TYPES.includes(inp.cable_type)) throw new Error(`cable_type must be one of ${CABLE_TYPES.join(", ")}`);
  if (inp.cable_type !== "dlo_2000v") {
    if (inp.cable_id) throw new Error("cable_id is only used with cable_type 'dlo_2000v'");
    return null;
  }
  if (!inp.cable_id) throw new Error("cable_type 'dlo_2000v' needs cable_id (see library_entries())");
  return cableSpec(inp.cable_id);
}

function _checkLibrary(inp, spec) {
  if (inp.material !== "Cu") throw new Error(`${spec.cable_id} is tinned copper: set material 'Cu'`);
  if (inp.voltage_v > spec.rated_voltage_v) {
    throw new Error(`${spec.cable_id} is rated ${pyFixed(spec.rated_voltage_v, 0)} V; voltage_v ${pyFixed(inp.voltage_v, 0)} ` +
      "is above the cable rating");
  }
  if (inp.insulation_temp_c !== spec.temp_c) {
    throw new Error(`${spec.cable_id} is rated ${spec.temp_c} C: set insulation_temp_c to ${spec.temp_c}`);
  }
  if (inp.insulation_mm !== null && inp.insulation_mm !== undefined) {
    throw new Error("insulation_mm is not used with a library cable (its insulation comes from the data file)");
  }
}

function _libraryRdc(spec, temp_c) {
  if (spec.rdc_ref === null) return cond.rdcFromAreaOhmPerM(spec.area_cmil, "Cu", temp_c, DLO_STRANDING_FACTOR);
  return cond.rdcDatasheetOhmPerM(spec.rdc_ref[0], spec.rdc_ref[1], "Cu", temp_c);
}

function _libraryMethod(inp, spec) {
  const m = inp.ampacity_method;
  if (m === "calculated") {
    throw new Error("The calculated method is not available for library cables: use 'table' (standard NEC sizes " +
      "listed RHH/RHW) or 'datasheet'");
  }
  if (!["auto", "table", "datasheet"].includes(m)) {
    throw new Error("ampacity_method must be auto, table or datasheet for library cables");
  }
  const table_ok = spec.standard_nec_size && spec.listed_rhh;
  if (m === "auto") return table_ok ? "table" : "datasheet";
  if (m === "table" && !table_ok) {
    throw new Error(`${spec.size_label} has no code-table basis (non-standard NEC size or not listed RHH/RHW): ` +
      "use 'datasheet'");
  }
  return m;
}

function _libraryAmpacity(inp, spec) {
  let base, ref, src;
  if (inp.cable_ampacity_a) {
    base = inp.cable_ampacity_a; ref = inp.cable_ampacity_ambient_c; src = "Supplied rating";
  } else {
    base = spec.ampacity_free_air_a; ref = spec.ampacity_ref_ambient_c; src = `${spec.manufacturer} printed rating`;
  }
  const f = ambientFactorChecked(inp.ambient_c, spec.temp_c, ref);
  return [base * f, `${src} ${pyFixed(base, 0)} A at ${pyFixed(ref, 0)} C (${spec.temp_c} C conductor, basis: ` +
    `${spec.ampacity_basis}) x ambient factor ${pyFixed(f, 3)} (${pyFixed(inp.ambient_c, 0)} C)`];
}

function _libraryNotes(inp, spec, method) {
  const out = [`Library cable ${spec.cable_id}: ${spec.manufacturer}, ${spec.series}; ${spec.size_label} ` +
    `${_thousands(pyFixed(spec.area_cmil, 0))} cmil; data status ${spec.status} (${spec.source_name}; ` +
    `${spec.source_date}). Rated ${pyFixed(spec.rated_voltage_v, 0)} V, ${spec.temp_c} C.`];
  if (spec.rdc_ref === null) {
    out.push(`DC resistance: no printed value for this cable; calculated from ${_thousands(pyFixed(spec.area_cmil, 0))} ` +
      `cmil, annealed copper, stranding factor ${DLO_STRANDING_FACTOR} (UNVERIFIED for Class I stranding; ` +
      "tinned-copper resistivity not applied).");
  } else {
    out.push(`DC resistance: printed ${spec.rdc_ref[0]} ohm per 1000 ft at ${pyFixed(spec.rdc_ref[1], 0)} C, ` +
      `corrected to ${inp.insulation_temp_c} C.`);
  }
  if (spec.diameter_source === "proxy") {
    out.push(`Conductor diameter not printed for this size: estimated ${pyFixed(spec.diameter_mm, 2)} mm ` +
      "(sqrt(area) x 1.173, UNVERIFIED); used for GMR and skin effect only.");
  }
  if (method === "table") {
    out.push(`Ampacity basis: ${inp.code} free-air table (90 C column), used because the size is a standard NEC size ` +
      "and the cable is listed RHH/RHW.");
  } else {
    out.push(`Ampacity basis: manufacturer free-air rating (${spec.ampacity_basis}), corrected from ` +
      `${pyFixed(spec.ampacity_ref_ambient_c, 0)} C to ${pyFixed(inp.ambient_c, 0)} C with the NEC 310.15(B)(1) ` +
      "ambient equation. Used because the size is non-standard or not listed RHH/RHW.");
  }
  if (!spec.basis_stated) {
    out.push("WARNING: the maker does not state the ampacity basis for this row. The 30 C free-air basis is an " +
      "assumption (UNVERIFIED); confirm with the manufacturer before using this rating.");
  }
  out.push("Termination: fine-stranded (Class I/K) conductors need lugs or connectors listed for that stranding " +
    "and this cable (NEC 110.14 / UL 486A-B, as attributed; UNVERIFIED here). Check the equipment listing and the " +
    "lug catalogue. The termination check applies to the table basis only.");
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

export function buildLayout(inp, pattern, od, spec = null) {
  const rows = _checkPattern(pattern, inp.conductors_per_phase, inp.tiers);
  const pitch = inp.spacing_mm || 2 * od;
  const tier_pitch = inp.tier_spacing_mm || pitch;
  let r_core, gmr;
  if (spec === null) {
    r_core = cond.racOhmPerM(inp.size, inp.material, inp.insulation_temp_c, inp.frequency_hz, pitch);
    gmr = cond.gmrMm(inp.size);
  } else {
    r_core = cond.racFromRdcOhmPerM(_libraryRdc(spec, inp.insulation_temp_c), spec.diameter_mm, inp.frequency_hz, pitch);
    gmr = cond.gmrFromDiameterMm(spec.diameter_mm);
  }
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

export function resolveMethod(inp, spec = null) {
  if (spec !== null) return _libraryMethod(inp, spec);
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
export function perCableAmpacity(inp, spec = null) {
  if (resolveMethod(inp, spec) === "datasheet") {
    if (spec !== null) return _libraryAmpacity(inp, spec);
    if (!inp.cable_ampacity_a) throw new Error("ampacity_method 'datasheet' needs cable_ampacity_a");
    const f = ambientFactorChecked(inp.ambient_c, inp.insulation_temp_c, inp.cable_ampacity_ambient_c);
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
  const f = ambientFactorChecked(inp.ambient_c, inp.insulation_temp_c, rated);
  return [base * f, `${inp.code} ${info.table_name} ${pyFixed(base, 0)} A (${inp.insulation_temp_c} C column, ` +
    `data ${info.status}) x ambient factor ${pyFixed(f, 3)} (${pyFixed(inp.ambient_c, 0)} C)`];
}

/**
 * Factor applied to a datasheet ampacity for shield circulating-current loss.
 *
 * Method: IEC 60287-1-1 section 2.3 (sheath/screen loss factor lambda1) applied
 * through the steady-state rating equation of IEC 60287-1-1 section 1.4.1.1,
 * which is the same heat balance as Neher-McGrath (AIEE 1957, "ycs" shield
 * loss term):
 *
 *     I = sqrt[(dtheta - Wd(...)) / (R T1 + n R (1 + lambda1) T2
 *                                     + n R (1 + lambda1 + lambda2)(T3 + T4))]
 *
 * For an unarmoured cable in air (lambda2 = 0, T2 = 0) with the external
 * thermal resistance T3 + T4 dominant, I is proportional to
 * 1 / sqrt(1 + lambda1), so a rating made with loss factor lambda1_ref
 * becomes, with the actual loss factor lambda1_actual:
 *
 *     I_derated = I_datasheet * sqrt((1 + lambda1_ref) / (1 + lambda1_actual))
 *
 * Assumptions:
 * - lambda1_actual is the circulating-current loss factor from the sharing
 *   solve (shield loss / core loss for the same cable); eddy loss lambda1''
 *   is neglected, as it is in IEC 60287 for both-ends-bonded single-core
 *   cables except large segmental conductors.
 * - Neglecting T1 (insulation) and the dielectric loss term overstates the
 *   reduction slightly, so the factor is conservative.
 * - The factor is capped at 1: a datasheet rating is never raised.
 * - lambda1_ref is the loss factor the datasheet already assumes: 0 for
 *   single-point or cross-bonded ratings (the usual basis), unless the
 *   manufacturer states otherwise.
 * [Equation form from memory; verify clause numbers against IEC 60287-1-1:2006.]
 */
export function datasheetShieldDerating(lambda1_actual, lambda1_ref = 0.0) {
  if (lambda1_actual < 0 || lambda1_ref < 0) throw new Error("Shield loss factors lambda1 must be >= 0");
  return Math.min(1.0, Math.sqrt((1 + lambda1_ref) / (1 + lambda1_actual)));
}

/**
 * Voltage drop per phase, in % of that phase's own sending-end voltage.
 *
 * Each phase group p carries I_p at power factor pf, so its sending-end
 * voltage is V_s,p = (V_LL / sqrt 3) at angle (arg I_p + phi), phi = acos(pf)
 * (current lagging). The drop phasor dV_p = (group drop per m) x length comes
 * from the sharing solve, which includes mutual coupling, unequal sharing and
 * induced shield / enclosure currents. Per phase:
 *
 *     exact  = (|V_s,p| - |V_s,p - dV_p|) / |V_s,p| x 100
 *     approx = Re(dV_p . conj(V_s,p)) / |V_s,p|^2 x 100
 *
 * The approximate form is the projection of the drop onto the source voltage,
 * i.e. the usual I (R cos phi + X sin phi) L estimate (IEEE Std 141 /
 * NEC Chapter 9 Table 9 Note 2 form) [from memory]. Measuring every phase
 * against its own source voltage makes the result independent of how the
 * phases are labelled.
 *
 * Returns {phase: [exact %, approx %]} in the solver's phase order.
 */
export function phaseVoltageDrops(res, voltage_v, power_factor, length_m, lagging = true) {
  const v_ph = voltage_v / Math.sqrt(3);
  const phi = Math.acos(Math.max(-1.0, Math.min(1.0, power_factor))) * (lagging ? 1 : -1);
  const out = {};
  for (const [p, d] of Object.entries(res.group_drop_v_per_m)) {
    const i_p = res.groups[p].current;
    if (!(i_p.re || i_p.im)) continue;
    const vs = cpolar(v_ph, Math.atan2(i_p.im, i_p.re) + phi);
    const dv = cscale(d, length_m);
    const avs = cabs(vs);
    const exact = ((avs - cabs(csub(vs, dv))) / avs) * 100;
    const approx = ((dv.re * vs.re + dv.im * vs.im) / avs ** 2) * 100; // Re(dv * conj(vs))
    out[p] = [exact, approx];
  }
  return out;
}

// --- shield standing voltage and bonding comparison --------------------------

export const SHEATH_LIMIT_NOTE = "No verified public limit is loaded: a secondary source attributes ~25 V at normal load to " +
  "IEEE 575 practice (LOW confidence, clause not found), so it is not used as a default. Set the " +
  "utility / owner limit (shield_voltage_limit_v) to get a pass/fail.";
const _SP_KEYS = ["e_v_per_km", "standing_v", "standing_v_fault", "worst_shield", "max_section_m_for_limit", "passed",
  "shields"];

/**
 * Induced voltage per metre on each open (single-point bonded) phase-cable shield.
 *
 * One current-free probe per phase conductor, concentric with it at the shield mean
 * radius. E_i = sum_k z(shield_i, k) I_k over every current-carrying conductor (cores
 * and, if modelled, enclosure filaments), using the impedance module's Carson mutual
 * impedances (openCircuitVoltages). Returns [[core index, E in V/m (complex)]].
 */
export function shieldStandingVoltages(cs, currents, shield_radius_mm, freq) {
  const cores = [];
  cs.forEach((c, i) => { if (PHASES.includes(c.group)) cores.push(i); });
  const probes = cores.map((i) => conductor({ x_mm: cs[i].x_mm, y_mm: cs[i].y_mm, group: "SHIELD", r_ohm_per_m: 0.0,
    gmr_mm: shield_radius_mm, label: `S-${cs[i].label}`, tube_radius_mm: shield_radius_mm }));
  const e = openCircuitVoltages(cs, currents, probes, freq);
  return cores.map((i, k) => [i, e[k]]);
}

function _shieldRadiusMm(inp, cons) {
  const d = inp.shield_mean_diameter_mm || (cons !== null && cons.shield_mm ? cons.shield_mean_diameter_mm : null);
  return d ? d / 2 : null;
}

/** Open-end standing voltage over one bonded section: normal load and balanced through-fault. */
function _standing(inp, cs, res, radius, section_m) {
  const k_fault = inp.fault_ka ? (inp.fault_ka * 1000) / inp.current_a : null;
  const shields = [], mags = [];
  for (const [i, e] of shieldStandingVoltages(cs, res.currents, radius, inp.frequency_hz)) {
    const m = cabs(e);
    const v = m * section_m;
    mags.push(m);
    shields.push({ label: `S-${cs[i].label}`, phase: cs[i].group, x_mm: pyRound(cs[i].x_mm, 1),
      y_mm: pyRound(cs[i].y_mm, 1), e_v_per_km: pyRound(m * 1000, 3), standing_v: pyRound(v, 2),
      standing_v_fault: k_fault === null ? null : pyRound(v * k_fault, 2) });
  }
  const e_max = Math.max(...mags);
  // First shield within 1e-9 of the maximum, so mirror-image ties resolve the same way in every port.
  const worst = shields[mags.findIndex((m) => m >= e_max * (1 - 1e-9))];
  const v_max = e_max * section_m;
  const lim = inp.shield_voltage_limit_v;
  const noLim = lim === null || lim === undefined;
  return {
    e_v_per_km: pyRound(e_max * 1000, 3), standing_v: pyRound(v_max, 2),
    standing_v_fault: k_fault === null ? null : pyRound(v_max * k_fault, 2),
    worst_shield: worst.label,
    max_section_m_for_limit: noLim ? null : pyRound(lim / e_max, 1),
    passed: noLim ? null : v_max <= lim, shields,
  };
}

function _modeSummary(rows, shield_i, shield_loss, lam_max, sp) {
  return {
    shield_current_a: pyRound(shield_i, 1), shield_loss_w: pyRound(shield_loss, 1),
    max_lambda1: pyRound(lam_max, 4), min_ampacity_a: Math.min(...rows.map((r) => r.ampacity_a)),
    max_loading_pct: Math.max(...rows.map((r) => r.loading_pct)),
    standing_v: sp ? sp.standing_v : null, standing_v_fault: sp ? sp.standing_v_fault : null,
  };
}

function _recommendation(sh, inp) {
  const sp = sh.modes.single_point, be = sh.modes.both_ends;
  if (sh.standing_v === null) {
    return "Single-point standing voltage not computed (give the shield mean diameter or the cable " +
      "construction with a shield thickness). Cross-bonding is not modelled.";
  }
  let txt = `Single-point bonding: ${pyFixed(sh.standing_v, 1)} V at the open end of a ${pyG(sh.section_length_m)} m ` +
    "bonded section at normal load";
  if (sh.standing_v_fault !== null) {
    txt += ` (${pyFixed(sh.standing_v_fault, 0)} V during a ${pyG(inp.fault_ka)} kA balanced through-fault)`;
  }
  txt += ", no circulating loss.";
  if (be) {
    txt += ` Both-ends bonding: ${pyFixed(be.shield_current_a, 0)} A circulating, ` +
      `${pyFixed(be.shield_loss_w / 1000, 2)} kW shield loss, worst lambda1 ${pyFixed(be.max_lambda1, 3)}, ` +
      `lowest cable ampacity ${pyFixed(sp.min_ampacity_a, 0)} -> ${pyFixed(be.min_ampacity_a, 0)} A, ` +
      `worst loading ${pyFixed(sp.max_loading_pct, 1)} -> ${pyFixed(be.max_loading_pct, 1)} %.`;
  }
  const lim = sh.voltage_limit_v;
  if (lim === null || lim === undefined) {
    txt += " Set your utility / owner standing-voltage limit to get a pass/fail and a recommendation.";
  } else if (sh.passed) {
    txt += ` Within the ${pyG(lim)} V limit, so single-point bonding is favoured (no circulating loss or ampacity ` +
      "derating); confirm the jacket and sheath voltage limiter (SVL) ratings against the fault voltage.";
  } else {
    txt += ` Exceeds the ${pyG(lim)} V limit: shorten the bonded section to <= ${pyG(sh.max_section_m_for_limit)} m ` +
      "(minor sections or mid-point bonding), or accept both-ends bonding with its loss and derating, " +
      "or use cross-bonding.";
  }
  return txt + " Cross-bonding is not modelled.";
}

/**
 * Shield standing voltage (single-point bonding) and comparison with both-ends bonding.
 *
 * Standing voltage: each shield open at one end of a bonded section,
 * E_i = |sum_k z(shield_i, k) I_k| (V/m) with the impedance module's mutual impedances,
 * V = E x section length. Through-fault: currents scaled by fault_ka / current_a
 * (balanced three-phase fault shared like load current). With compareBonding the other
 * bonding mode is solved for the same phase pattern.
 */
export function sheathStudy(inp, cons, cs, res, pattern, rows, shield_i, shield_loss, lam_max, compareBonding) {
  const section = inp.shield_section_length_m || inp.length_m;
  const mode = inp.shield_bonding;
  const other = mode === "single_point" ? "both_ends" : "single_point";
  const notes = [];
  let alt = null;
  if (compareBonding) {
    try {
      alt = analyse({ ...inp, shield_bonding: other, pattern, field_distances_m: [...inp.field_distances_m] }, false);
    } catch (e) {
      if (e instanceof TypeError || e instanceof RangeError) throw e;
      notes.push(`${other.replace("_", "-")} bonding not compared: ${e.message}`);
    }
  }
  let sp = null;
  if (mode === "single_point") {
    const radius = _shieldRadiusMm(inp, cons);
    if (radius) {
      sp = _standing(inp, cs, res, radius, section);
    } else {
      notes.push("Standing voltage needs the shield mean diameter (shield_mean_diameter_mm) or the cable " +
        "construction with a shield thickness.");
    }
  } else if (alt !== null && alt.sheath.standing_v !== null) {
    sp = {};
    for (const k of _SP_KEYS) sp[k] = alt.sheath[k];
  }
  const modes = { single_point: null, both_ends: null };
  modes[mode] = _modeSummary(rows, shield_i, shield_loss, lam_max, mode === "single_point" ? sp : null);
  if (alt !== null) modes[other] = alt.sheath.modes[other];
  const lim = inp.shield_voltage_limit_v;
  const sh = {
    bonding: mode, section_length_m: section, sections: Math.ceil(inp.length_m / section - 1e-9),
    voltage_limit_v: lim, fault_ka: inp.fault_ka,
  };
  for (const k of _SP_KEYS) sh[k] = sp ? sp[k] : (k === "shields" ? [] : null);
  sh.modes = modes;
  if (lim === null || lim === undefined) notes.push(SHEATH_LIMIT_NOTE);
  notes.push("Through-fault voltage assumes a balanced three-phase fault shared like load current; a " +
    "single-line-to-ground fault (earth / shield return) can give much higher shield voltages and is " +
    "not modelled. Compare the fault value with the jacket and sheath voltage limiter (SVL) ratings.");
  notes.push("Cross-bonding (three equal minor sections with transpositions) is not modelled.");
  sh.recommendation = _recommendation(sh, inp);
  sh.notes = notes;
  return sh;
}

// --- main -------------------------------------------------------------------

function _div(a, b) {
  if (b === 0) throw new Error("division by zero"); // Python ZeroDivisionError
  return a / b;
}

/**
 * Analyse a cable bus. inp comes from cableBusInput(); like the Python it normalises inp.size and may
 * fill in the shield geometry on it. Returns the CableBusResult fields plus `passed`. With shielded cable,
 * compareBonding also solves the other bonding mode (single-point vs both-ends) for the sheath comparison;
 * the designer turns it off for speed.
 */
export function analyse(inp, compareBonding = true) {
  validateInput(inp);
  const sec = inp.shield_section_length_m;
  if (sec !== null && sec !== undefined && !(0 < sec && sec <= inp.length_m)) {
    throw new Error("shield_section_length_m must be > 0 and no longer than length_m");
  }
  const vlim = inp.shield_voltage_limit_v;
  if (vlim !== null && vlim !== undefined && !(vlim > 0)) throw new Error("shield_voltage_limit_v must be > 0");
  if (inp.fault_clearing_s !== null && inp.fault_clearing_s !== undefined) {
    validate.clearingTime("fault_clearing_s", inp.fault_clearing_s);
  }
  const spec = resolveCable(inp);
  let size;
  if (spec === null) {
    size = cond.normalizeSize(inp.size);
  } else {
    _checkLibrary(inp, spec);
    size = spec.size;
  }
  inp.size = size;
  const notes = [];
  if (inp.terminal_temp_c === null || inp.terminal_temp_c === undefined) {
    let term_basis;
    [inp.terminal_temp_c, term_basis] = defaultTerminalTempC(inp.voltage_v);
    notes.push(term_basis);
  }
  const cons = spec === null ? construction(inp) : null;
  if (inp.cable_od_mm !== null && inp.cable_od_mm !== undefined) {
    const bare = spec ? spec.diameter_mm : cond.diameterMm(size);
    if (!(inp.cable_od_mm > bare)) {
      throw new Error(`cable_od_mm (${pyG(inp.cable_od_mm)} mm) must be greater than the conductor bare ` +
        `diameter (${pyFixed(bare, 2)} mm)`);
    }
  }
  const od = inp.cable_od_mm || (spec ? spec.od_mm : null) || (cons ? cons.de_mm : null) ||
    (inp.voltage_v <= 2000 ? cond.cableOdMm(size) : null);
  if (!od) {
    throw new Error("Above 2000 V give cable_od_mm or the cable construction (insulation_mm, shield_mm, jacket_mm)");
  }
  if (!inp.cable_od_mm && spec === null && cons === null && inp.voltage_v > 600) {
    notes.push(`Cable OD ${pyFixed(od, 1)} mm is estimated from a 600 V insulation wall, but voltage_v is ` +
      `${pyG(inp.voltage_v)} V: enter cable_od_mm for the real cable (the insulation wall, spacing and ` +
      "enclosure depend on it).");
  }
  const with_shields = inp.shield_bonding === "both_ends";
  if (with_shields && cons && cons.shield_mm) {
    inp.shield_mean_diameter_mm = inp.shield_mean_diameter_mm || cons.shield_mean_diameter_mm;
    inp.shield_area_mm2 = inp.shield_area_mm2 || Math.PI * cons.shield_mean_diameter_mm * cons.shield_mm;
  }
  const method = resolveMethod(inp, spec);
  if (spec) notes.push(..._libraryNotes(inp, spec, method));
  const size_text = spec ? spec.size_label : cond.sizeLabel(size);

  const patterns = inp.pattern === "auto" ? candidatePatterns(inp.conductors_per_phase, inp.tiers)
    : [inp.pattern.toUpperCase()];
  const scored = [];
  for (const p of patterns) {
    const cs = buildLayout(inp, p, od, spec);
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

  // Circulating-current shield loss factor of cable i (0 without both-ends bonding).
  const shieldLambda1 = (i) => {
    const core_loss = res.losses_w_per_m[i];
    const s = labels[`S-${cs[i].label}`];
    return s !== undefined && core_loss ? pyRound(res.losses_w_per_m[s] / core_loss, 4) : 0.0;
  };

  let ampacityFor = null, a_cable = null, basis_fixed = null;
  if (method === "calculated") {
    if (cons === null) throw new Error("The calculated ampacity method needs the cable construction (insulation_mm etc.)");
    requireAmbientBelow(inp.ambient_c, inp.insulation_temp_c);
    const installation = pitch - od >= 0.75 * od ? "isolated" : "flat_touching";
    const cache = new Map();
    ampacityFor = (i) => {
      const lam = shieldLambda1(i);
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
    [a_cable, basis_fixed] = perCableAmpacity(inp, spec);
  }
  // Termination limit, whatever the ampacity method (NEC 110.14(C), Table 310.16).
  const [a_term, term_table, why] = terminationAmpacity(inp, size, inp.terminal_temp_c);
  if (a_term === null) notes.push(`Termination temperature not checked: ${why}.`);

  const derate_ds = method === "datasheet" && with_shields;
  const ds_factors = [];
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
    } else if (derate_ds) {
      const lam = shieldLambda1(i);
      const k = datasheetShieldDerating(lam, inp.cable_ampacity_lambda1_ref);
      ds_factors.push([k, lam]);
      a_i = a_cable * k;
      basis_i = `${basis_fixed} x shield derating ${pyFixed(k, 3)} (lambda1 ${pyFixed(lam, 3)} vs datasheet ` +
        `${pyFixed(inp.cable_ampacity_lambda1_ref, 3)}, IEC 60287-1-1 2.3)`;
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

  // Voltage drop: each phase against its own sending-end voltage; the worst phase is checked.
  const vd_by_phase = phaseVoltageDrops(res, inp.voltage_v, inp.power_factor, inp.length_m);
  let vd_phase = null;
  for (const p of Object.keys(vd_by_phase)) {
    if (vd_phase === null || vd_by_phase[p][0] > vd_by_phase[vd_phase][0]) vd_phase = p;
  }
  if (vd_phase === null) throw new Error("max() arg is an empty sequence"); // Python ValueError
  const vd_pct = vd_by_phase[vd_phase][0];
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
  if (inp.conductors_per_phase > 1 && spec !== null) {
    check("Minimum size for paralleled conductors", clauses.parallel, spec.area_cmil,
      cond.AREA_CMIL[min_size], "cmil", spec.area_cmil >= cond.AREA_CMIL[min_size],
      `min ${cond.sizeLabel(min_size)} (area comparison for ${spec.size_label})`);
  } else if (inp.conductors_per_phase > 1) {
    check("Minimum size for paralleled conductors", clauses.parallel, cond.sizeIndex(size),
      cond.sizeIndex(min_size), "size index", cond.sizeIndex(size) >= cond.sizeIndex(min_size),
      `min ${cond.sizeLabel(min_size)}`);
  }
  if (method === "table") {
    check("Spacing for free-air ampacity basis (>= 1 cable diameter clearance)",
      "NEC 370.80 / CEC 12-2252 [UNVERIFIED]", pitch - od, od, "mm", pitch - od >= od - 1e-6);
    if (inp.tiers > 1) {
      const tier_pitch = inp.tier_spacing_mm || pitch; // centre-to-centre, same convention as spacing_mm
      check("Tier spacing for free-air ampacity basis (>= 1 cable diameter clearance between tiers)",
        "NEC 370.80 / CEC 12-2252 [UNVERIFIED]", tier_pitch - od, od, "mm", tier_pitch - od >= od - 1e-6);
    }
  }
  const w = worst[0];
  check("Most heavily loaded conductor within its ampacity", basis, w.current_a, w.ampacity_a, "A",
    w.current_a <= w.ampacity_a, `${w.phase} at x=${pyFloat(w.x_mm)} mm; current sharing solved for pattern ${pattern}`);
  if (a_term !== null) {
    check("Most heavily loaded conductor within termination rating", clauses.terminal, max_cur, a_term,
      "A", max_cur <= a_term,
      `${inp.terminal_temp_c} C column of ${amp.tableInfo(inp.code, term_table).table_name}, ` +
      "no ambient correction; 110.14(C)(2) permits separately installed pressure connectors at their " +
      "listed rating: set terminal_temp_c to it if used");
  }
  check("Voltage drop (worst phase)", clauses.vd, vd_pct, inp.max_vd_pct, "%", vd_pct <= inp.max_vd_pct,
    `phase ${vd_phase}, each phase against its own sending-end voltage`);

  let f_nm = null, f_lbf = null, support = null;
  if (inp.fault_ka) {
    const share = {};
    cs.forEach((c, i) => {
      if (PHASES.includes(c.group)) share[i] = cdiv(res.currents[i], res.groups[c.group].current);
    });
    const fr = faultForces(cs, share, inp.fault_ka, inp.x_over_r, { freq: inp.frequency_hz });
    f_nm = fr.worst_n_per_m;
    f_lbf = fr.worst_lbf_per_ft;
    const k_r = SUPPORT_REACTION[inp.support_condition];
    support = (fr.worst_n_per_m * inp.support_span_m * k_r) / 4.44822;
    notes.push(`Fault: ${pyFloat(inp.fault_ka)} kA rms sym, X/R ${pyFloat(inp.x_over_r)}, first peak ` +
      `${pyFixed(fr.peak_current_ka, 1)} kA; worst conductor force ${pyFixed(f_nm, 0)} N/m ` +
      `(${pyFixed(f_lbf, 0)} lbf/ft); load on one support over a ${pyFixed(inp.support_span_m, 3)} m span ` +
      `(${inp.support_condition}, k_r ${k_r}) ~ ${pyFixed(support, 0)} lbf (static; compare with tested block strength).`);
    if (inp.fault_clearing_s) {
      // ICEA P-32-382 adiabatic withstand of all paralleled conductors of one phase (equal fault sharing).
      const area = (spec !== null ? spec.area_cmil : cond.AREA_CMIL[size]) * inp.conductors_per_phase;
      const withstand_ka = cond.adiabaticWithstandA(inp.material, area, inp.insulation_temp_c,
        inp.insulation_sc_limit_c, inp.fault_clearing_s) / 1000;
      check("Conductor short-circuit withstand", "ICEA P-32-382", withstand_ka, inp.fault_ka, "kA",
        withstand_ka >= inp.fault_ka,
        `${inp.conductors_per_phase} x ${size_text} ${inp.material} per phase, ` +
        `${pyFloat(inp.fault_clearing_s)} s clearing, ${inp.insulation_temp_c}->${pyFloat(inp.insulation_sc_limit_c)} C, ` +
        "equal fault sharing among paralleled conductors assumed");
    } else {
      check("Conductor short-circuit withstand (NOT CHECKED: fault_clearing_s missing)", "ICEA P-32-382",
        0.0, inp.fault_ka, "kA", false,
        "fault_ka is given but fault_clearing_s is not, so the conductor withstand cannot be checked; " +
        "give fault_clearing_s");
      notes.push("Conductor short-circuit withstand not checked: give fault_clearing_s.");
    }
    notes.push("Not checked: shield short-circuit withstand; mutual heating between stacked tiers.");
  }

  if (with_shields) {
    notes.push(`Shields bonded both ends: max circulating current ${pyFixed(shield_i, 0)} A, ` +
      `shield loss ${pyFixed(shield_loss / 1000, 2)} kW (${pyFixed((shield_loss / Math.max(cond_loss, 1e-9)) * 100, 1)} % of ` +
      "conductor loss). Single-point or cross bonding removes most of this.");
  }
  if (derate_ds) {
    // Python min() over (factor, lambda1) tuples: smallest factor, then smallest lambda1.
    const [k_min, lam_max] = ds_factors.reduce((m, t) => (t[0] < m[0] || (t[0] === m[0] && t[1] < m[1]) ? t : m));
    const k_hi = Math.max(...ds_factors.map(([f]) => f));
    notes.push(
      "Datasheet ampacity derated for shield circulating current (shields bonded both ends): " +
      "I = I_datasheet x sqrt((1 + lambda1_ref) / (1 + lambda1)), IEC 60287-1-1 2.3 shield loss factor in " +
      "the IEC 60287 / Neher-McGrath rating equation. Assumes the datasheet rating already includes " +
      `lambda1_ref = ${pyFixed(inp.cable_ampacity_lambda1_ref, 3)} (0 = single-point or cross-bonded rating), ` +
      "external thermal resistance dominant, eddy loss and dielectric loss term neglected (conservative), " +
      `factor capped at 1. Per-cable lambda1 from the sharing solve; worst lambda1 ${pyFixed(lam_max, 3)}, ` +
      `factor ${pyFixed(k_min, 3)} (range ${pyFixed(k_min, 3)}-${pyFixed(k_hi, 3)}). [UNVERIFIED method ` +
      "simplification; check against the cable maker's both-ends-bonded rating where available.]");
    if (k_min < 0.9) {
      notes.push("WARNING: shield circulating current derates the datasheet ampacity by " +
        `${pyFixed((1 - k_min) * 100, 1)} % (> 10 %). Consider single-point or cross bonding, or a ` +
        "manufacturer rating for both-ends bonding.");
    }
  }
  if (inp.voltage_v > 2000 && inp.shield_bonding === "none") {
    notes.push("MV cable selected with shield_bonding 'none': set 'single_point' or 'both_ends' to state the design.");
  }
  notes.push("Voltage drop by phase, exact / approximate I(R cos phi + X sin phi) form, each against its own " +
    "sending-end phase voltage: " + Object.keys(vd_by_phase).sort()
    .map((p) => `${p} ${pyFixed(vd_by_phase[p][0], 2)} / ${pyFixed(vd_by_phase[p][1], 2)} %`).join(", ") + ".");
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

  let sheath = null;
  if (inp.shield_bonding === "single_point" || inp.shield_bonding === "both_ends") {
    const lam_max = Math.max(...rows.map((r) => shieldLambda1(r.index)));
    sheath = sheathStudy(inp, cons, cs, res, pattern, rows, shield_i, shield_loss, lam_max, compareBonding);
    if (inp.shield_bonding === "single_point" && (vlim === null || vlim === undefined)) {
      notes.push("Shield standing voltage was not checked against a limit: shield_voltage_limit_v is not " +
        "set (single-point bonding), so there is no pass/fail on the open-end voltage.");
    }
    if (inp.shield_bonding === "single_point" && vlim !== null && vlim !== undefined && sheath.standing_v !== null) {
      check("Shield standing voltage at open end (single-point bonding, normal load)",
        "Owner / utility limit (IEEE 575 practice) [user-set limit, UNVERIFIED]",
        sheath.standing_v, vlim, "V", sheath.passed,
        `${sheath.worst_shield}: ${pyFixed(sheath.e_v_per_km, 1)} V/km x ${pyG(sheath.section_length_m)} m ` +
        "bonded section");
    }
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
    sheath,
    cable_data: spec,
    passed: checks.every((c) => c.passed),
  };
}
