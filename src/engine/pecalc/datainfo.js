// Version, fingerprint and status of the data tables in ./data/. Port of pecalc/datainfo.py.
//
// Python hashes the canonical JSON text of every data file (int and float serialise differently), which
// JavaScript cannot reproduce byte for byte, so the version and fingerprint below are constants copied from
// tests/golden/pecalc_data.json (written by scripts/gen_golden_datainfo.py). tests/datainfo.test.mjs checks that
// every JSON file copied into ./data/ deep-equals the data recorded next to that fingerprint, so the constant
// describes the tables actually shipped. After copying new pecalc data: regenerate the golden, update both here.
import AMPACITY_CEC from "./data/ampacity_cec.json" with { type: "json" };
import AMPACITY_NEC from "./data/ampacity_nec.json" with { type: "json" };
import CABLEBUS_SIM from "./data/cablebus_sim.json" with { type: "json" };
import DLO_CABLES from "./data/dlo_cables.json" with { type: "json" };
import DOE_EFFICIENCY from "./data/doe_10cfr431_efficiency.json" with { type: "json" };
import LUG_CATALOG from "./data/lug_catalog.json" with { type: "json" };
import NEC_240_4D from "./data/nec_240_4d_small_conductors.json" with { type: "json" };
import REACTANCE_TABLE9 from "./data/reactance_nec_table9.json" with { type: "json" };

export const PECALC_VERSION = "0.1.0";
export const PECALC_DATA_FINGERPRINT = "a9cbc961548d";

/** Every copied data file by name, parsed. Sorted by name, like Python's sorted(DATA_DIR.glob("*.json")). */
export const DATA_FILES = Object.freeze({
  "ampacity_cec.json": AMPACITY_CEC,
  "ampacity_nec.json": AMPACITY_NEC,
  "cablebus_sim.json": CABLEBUS_SIM,
  "dlo_cables.json": DLO_CABLES,
  "doe_10cfr431_efficiency.json": DOE_EFFICIENCY,
  "lug_catalog.json": LUG_CATALOG,
  "nec_240_4d_small_conductors.json": NEC_240_4D,
  "reactance_nec_table9.json": REACTANCE_TABLE9,
});

/** One row per data file: file, edition and status from its _meta (blank when not given). */
export function dataTables() {
  return Object.keys(DATA_FILES).sort().map((file) => {
    const meta = DATA_FILES[file]._meta ?? {};
    return { file, edition: meta.edition ?? "", status: meta.status ?? "" };
  });
}

/** What a saved project records about the engine that wrote it (Python engine_stamp()). */
export function engineStamp() {
  return { pecalc: PECALC_VERSION, data: PECALC_DATA_FINGERPRINT };
}

/**
 * Empty when the file has no stamp, or was saved by this engine version and table data (Python
 * Case.engine_mismatch()). A stamp that is not an object, or has a non-string entry, is treated as absent:
 * old or hand-edited files are never rejected for it. `what` names the file kind in the message.
 */
export function engineMismatch(saved, what = "Project file") {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return "";
  const now = engineStamp();
  const diff = ["pecalc", "data"]
    .filter((k) => typeof saved[k] === "string" && saved[k] && saved[k] !== now[k])
    .map((k) => `${k} ${saved[k]} (now ${now[k]})`);
  return diff.length ? `${what} saved with ${diff.join(", ")}. Results can differ from the saved run.` : "";
}
