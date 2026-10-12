// Lug and termination selection. Port of pecalc/lugs.py.
//
// Rules-based selection of lug style, material, stud size, hole pattern and
// quantity for each termination, plus the termination temperature rule
// (NEC 110.14(C) / CEC Rule 4-006). Part numbers, die codes and torque come
// only from a catalogue file (data/lug_catalog.json) the user fills from the
// manufacturer's current catalogue and installation sheets; without it the
// result says "use the manufacturer's value" rather than inventing one.
import * as cond from "./conductors.js";
import CATALOG from "./data/lug_catalog.json" with { type: "json" };

// Typical stud size and 2-hole spacing by conductor size for NEMA-pattern
// compression lugs. [UNVERIFIED: industry practice from catalogue listings;
// 1/2 in stud on 1-3/4 in centres confirmed in product listings only]
const _STUD_RULES = [
  [["14", "12", "10", "8"], "1/4", "5/8"],
  [["6", "4", "3", "2"], "3/8", "1"],
  [["1", ...cond.SIZES.slice(cond.SIZES.indexOf("1/0"))], "1/2", "1-3/4"],
];

export function lugInput(overrides = {}) {
  const inp = {
    code: "NEC",
    size: "500",
    material: "Cu",
    sets_per_phase: 1,
    phases: 3,
    neutral: false,
    neutral_size: null,
    ground_size: null,
    circuit_current_a: 400.0,
    equipment_terminal_temp_c: null, // marked rating; null = code default
    termination: "bus",              // "bus" (NEMA pad), "stud", "breaker" (mechanical lug)
    pad_positions: null,             // 2-hole positions available per phase on the pad
    pad_two_sided: true,             // lugs may mount on both faces of the pad
  };
  for (const k of Object.keys(overrides)) {
    if (!(k in inp)) throw new TypeError(`LugInput got an unexpected field '${k}'`);
  }
  return { ...inp, ...overrides };
}

/** NEC 110.14(C)(1) / CEC 4-006(2): 60 C for <= 100 A or 14-1 AWG, else 75 C,
 * unless the equipment is marked otherwise. [UNVERIFIED wording; CEC 2018 text checked] Returns [temp, basis]. */
export function defaultTerminalTemp(code, circuit_a, size) {
  const small = circuit_a <= 100 || cond.sizeIndex(size) <= cond.sizeIndex("1");
  const clause = code === "NEC" ? "NEC 110.14(C)(1)" : "CEC Rule 4-006";
  if (small) return [60, `${clause}: 100 A or less, or 14-1 AWG, defaults to 60 C unless marked`];
  return [75, `${clause}: over 100 A or larger than 1 AWG defaults to 75 C unless marked`];
}

/** Returns [stud, spacing]. */
export function studFor(size) {
  size = cond.normalizeSize(size);
  for (const [sizes, stud, spacing] of _STUD_RULES) if (sizes.includes(size)) return [stud, spacing];
  throw new Error(size);
}

function _lookup(material, size, stud, holes) {
  for (const row of CATALOG.lugs) {
    if (row.conductor_material === material && cond.normalizeSize(row.size) === size
        && row.stud_in === stud && row.holes === holes) return row;
  }
  return null;
}

function _line(terminal, size, material, qty, termination) {
  size = cond.normalizeSize(size);
  let [stud, spacing] = studFor(size);
  let style, holes;
  if (termination === "breaker") {
    style = "mechanical (set-screw) lug supplied/listed with the device"; holes = 0; spacing = null;
    stud = "per device";
  } else if (termination === "bus" && cond.sizeIndex(size) >= cond.sizeIndex("1/0")) {
    style = "compression, 2-hole long barrel, NEMA spacing"; holes = 2;
  } else {
    style = "compression, 1-hole long barrel"; holes = 1; spacing = null;
  }
  const lug_material = material === "Cu" ? "tin-plated copper"
    : "tin-plated aluminum, dual-rated AL9CU; apply oxide inhibitor";
  const row = holes ? _lookup(material, size, stud, holes) : null;
  return {
    terminal, conductor: `${cond.sizeLabel(size)} ${material}`, quantity: qty, style, lug_material,
    stud_in: stud, hole_spacing_in: spacing,
    part_no: row ? (row.part_no ?? null) : null, die: row ? (row.die ?? null) : null,
    torque: row ? (row.torque ?? null) : null,
  };
}

export function selectLugs(inp) {
  const size = cond.normalizeSize(inp.size);
  let t_term, basis;
  if (inp.equipment_terminal_temp_c) { t_term = inp.equipment_terminal_temp_c; basis = "equipment marking"; }
  else [t_term, basis] = defaultTerminalTemp(inp.code, inp.circuit_current_a, size);

  const lines = [_line(`Phase (${inp.phases} x ${inp.sets_per_phase} per phase)`, size, inp.material,
    inp.phases * inp.sets_per_phase, inp.termination)];
  if (inp.neutral) {
    lines.push(_line(`Neutral (${inp.sets_per_phase})`, inp.neutral_size || size, inp.material,
      inp.sets_per_phase, inp.termination));
  }
  if (inp.ground_size) {
    lines.push(_line("Equipment ground", inp.ground_size, inp.material, inp.sets_per_phase, "bus"));
  }
  const total = lines.reduce((s, l) => s + l.quantity, 0);

  const checks = [], notes = [];
  if (inp.pad_positions !== null && inp.pad_positions !== undefined && inp.termination === "bus") {
    const capacity = inp.pad_positions * (inp.pad_two_sided ? 2 : 1);
    checks.push({
      name: "Lugs per phase fit the pad", clause: "equipment pad drawing",
      value: inp.sets_per_phase, limit: capacity, unit: "lugs", passed: inp.sets_per_phase <= capacity,
      note: `${inp.pad_positions} two-hole positions x ${inp.pad_two_sided ? "2 faces" : "1 face"}`,
    });
  }
  if (inp.sets_per_phase > 1 && cond.sizeIndex(size) < cond.sizeIndex("1/0")) {
    checks.push({
      name: "Paralleled conductors 1/0 AWG or larger", clause: "NEC 310.10(G) / CEC 12-108",
      value: cond.sizeIndex(size), limit: cond.sizeIndex("1/0"), unit: "size index", passed: false,
    });
  }
  const cat = CATALOG._meta.status ?? "EMPTY";
  if (lines.some((l) => l.torque === null)) {
    notes.push("Torque: use the value marked on the equipment or in the lug manufacturer's installation "
      + "sheet (UL 486A-B tables apply only when none is marked). Add parts to "
      + "data/lug_catalog.json to have part numbers, dies and torques filled in.");
  }
  notes.push(`Lug catalogue status: ${cat}. Stud/spacing defaults are typical practice [UNVERIFIED].`);
  notes.push("Wire bending space (NEC 312.6 / CEC Table 37, UL 891 / UL 1558) is not checked yet.");
  if (inp.material === "Al") {
    notes.push("Aluminum: use lugs marked AL9CU (or AL7CU) for the conductor, Belleville washers on bolted "
      + "joints, and oxide-inhibiting compound.");
  }
  return {
    input: inp, terminal_temp_c: t_term, terminal_temp_basis: basis, lines, total_lugs: total, checks, notes,
    passed: checks.every((c) => c.passed),
  };
}
