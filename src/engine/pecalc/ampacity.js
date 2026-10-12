// Code ampacity tables and correction factors (NEC and CEC). Port of pecalc/ampacity.py.
//
// Table values live in data/*.json, each with a status: VERIFIED (checked
// against the licensed code book), UNVERIFIED (entered from memory, likely
// right) or PLACEHOLDER (known not to be the right table). Calculations refuse
// PLACEHOLDER data unless the caller explicitly allows it.
import { normalizeSize } from "./conductors.js";
import { lookup } from "./util.js";
import NEC from "./data/ampacity_nec.json" with { type: "json" };
import CEC from "./data/ampacity_cec.json" with { type: "json" };

const TABLES = { NEC, CEC };
export const COLUMNS = [60, 75, 90];
export const CODES = ["NEC", "CEC"];
export const INSTALLATIONS = ["raceway", "free_air"];

// Clause references printed in reports. NEC: NFPA 70-2023. CEC: CSA C22.1.
// [UNVERIFIED: clause numbering to be confirmed against current editions]
export const CLAUSES = {
  NEC: {
    ambient: "NEC 310.15(B)(1) equation",
    ccc: "NEC Table 310.15(C)(1)",
    parallel: "NEC 310.10(G)",
    terminal: "NEC 110.14(C)",
    continuous: "NEC 215.2(A)(1)",
    vd: "NEC 215.2(A)(2) Informational Note (3 % feeder / 5 % total)",
  },
  CEC: {
    ambient: "CEC Table 5A (equation basis)",
    ccc: "CEC Table 5C",
    parallel: "CEC Rule 12-108",
    terminal: "CEC Rule 4-006",
    continuous: "CEC Rule 8-104",
    vd: "CEC Rule 8-102 (3 % feeder or branch / 5 % total)",
  },
};

// Number of current-carrying conductors in one raceway -> adjustment factor.
// [UNVERIFIED: values from memory; confirm against the tables cited above]
const _CCC = {
  NEC: [[3, 1.00], [6, 0.80], [9, 0.70], [20, 0.50], [30, 0.45], [40, 0.40], [1e9, 0.35]],
  CEC: [[3, 1.00], [6, 0.80], [24, 0.70], [42, 0.60], [1e9, 0.50]],
};

// Minimum size for paralleled conductors.
// NEC 310.10(G): 1/0 AWG. CEC 12-108: 1/0 AWG Cu, 2/0 AWG Al. [UNVERIFIED]
export const PARALLEL_MIN = { NEC: { Cu: "1/0", Al: "1/0" }, CEC: { Cu: "1/0", Al: "2/0" } };

export class DataStatusError extends Error {
  constructor(message) { super(message); this.name = "DataStatusError"; }
}

function _load(code) {
  if (!CODES.includes(code)) throw new Error(`code must be one of (${CODES.map((c) => `'${c}'`).join(", ")})`);
  return TABLES[code];
}

export function tableInfo(code, installation) {
  const meta = _load(code)._meta;
  return Object.freeze({
    code, edition: meta.edition, status: meta.status, source: meta.source,
    table_name: lookup(meta.tables, installation),
  });
}

export function checkStatus(code, allow_placeholder_data) {
  const status = _load(code)._meta.status;
  if (status === "PLACEHOLDER" && !allow_placeholder_data) {
    throw new DataStatusError(
      `${code} ampacity tables are PLACEHOLDER data (see pecalc/data/ampacity_${code.toLowerCase()}.json). ` +
      "Enter the real table values first, or pass allow_placeholder_data=True / --allow-placeholder-data " +
      "to run anyway for testing.");
  }
  return status;
}

/** Table ampacity in A, or null if the size is not in the table. */
export function tableAmpacity(code, installation, material, size, temp_col) {
  if (!INSTALLATIONS.includes(installation)) {
    throw new Error(`installation must be one of (${INSTALLATIONS.map((c) => `'${c}'`).join(", ")})`);
  }
  if (!COLUMNS.includes(temp_col)) throw new Error(`temperature column must be one of (${COLUMNS.join(", ")})`);
  const tbl = lookup(lookup(_load(code), installation), material);
  const key = normalizeSize(size);
  const row = Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key] : null;
  return row === null ? null : Number(row[COLUMNS.indexOf(temp_col)]);
}

/** sqrt((Tc - Ta) / (Tc - Tr)); 0 if the ambient reaches the rating. */
export function ambientFactor(ambient_c, conductor_temp_c, rated_ambient_c = 30.0) {
  if (ambient_c >= conductor_temp_c) return 0.0;
  return Math.sqrt((conductor_temp_c - ambient_c) / (conductor_temp_c - rated_ambient_c));
}

export function cccFactor(code, current_carrying) {
  for (const [limit, factor] of lookup(_CCC, code)) if (current_carrying <= limit) return factor;
  throw new Error("unreachable");
}
