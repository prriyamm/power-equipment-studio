// The pecalc version and table-data fingerprint shown in reports and stored in project files are constants
// (JavaScript cannot reproduce Python's canonical JSON hash). These tests tie them to the data actually copied
// into src/engine/pecalc/data/: tests/golden/pecalc_data.json is written by scripts/gen_golden_datainfo.py from the
// Python data files, and every copied file must deep-equal its entry there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { PECALC_VERSION, PECALC_DATA_FINGERPRINT, DATA_FILES, dataTables, engineStamp } from "../src/engine/pecalc/datainfo.js";

const G = JSON.parse(readFileSync(new URL("./golden/pecalc_data.json", import.meta.url), "utf8"));
const DATA_DIR = new URL("../src/engine/pecalc/data/", import.meta.url);

test("constants equal the golden version and fingerprint", () => {
  assert.equal(PECALC_VERSION, G.pecalc_version);
  assert.equal(PECALC_DATA_FINGERPRINT, G.data_fingerprint);
  assert.match(PECALC_DATA_FINGERPRINT, /^[0-9a-f]{12}$/);
  assert.deepEqual(engineStamp(), { pecalc: G.pecalc_version, data: G.data_fingerprint });
});

test("every copied data file deep-equals the Python data the fingerprint was computed from", () => {
  const copied = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(copied, Object.keys(G.data).sort(), "copied files vs golden data entries");
  assert.deepEqual(Object.keys(DATA_FILES).sort(), copied, "datainfo.js lists every copied file");
  for (const file of copied) {
    const onDisk = JSON.parse(readFileSync(new URL(file, DATA_DIR), "utf8"));
    assert.deepEqual(onDisk, G.data[file], file);
    assert.deepEqual(DATA_FILES[file], G.data[file], `${file} as imported`);
  }
  assert.deepEqual(G._meta.not_copied, [], "no Python data file is missing from this repo");
});

test("dataTables() reads file, edition and status from _meta, like Python data_tables()", () => {
  assert.deepEqual(dataTables(), G.tables);
  const nec = dataTables().find((t) => t.file === "ampacity_nec.json");
  assert.equal(nec.status, "UNVERIFIED");
  assert.equal(nec.edition, "NFPA 70-2023");
});

test("data status is never upgraded by the copy: statuses match Python's", () => {
  for (const t of G.tables) assert.equal(DATA_FILES[t.file]._meta?.status ?? "", t.status, t.file);
});
