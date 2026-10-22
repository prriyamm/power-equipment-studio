import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSystem, parseSystem, parseSystemWithWarning, toProject, VERSION } from "../src/engine/systemio.js";
import { PECALC_VERSION, PECALC_DATA_FINGERPRINT } from "../src/engine/pecalc/datainfo.js";
import { EXAMPLE_SYSTEM, EQUIPMENT, CONNECTORS, analyseSystem } from "../src/engine/system.js";

const full = (s) => ({
  ...s, base_mva: s.base_mva ?? 10,
  equipment: s.equipment.map((e) => ({ ...EQUIPMENT[e.type].defaults, ...e })),
  connectors: s.connectors.map((c) => ({ ...CONNECTORS[c.kind].defaults, ...c })),
});
const err = (obj, re) => assert.throws(() => parseSystem(typeof obj === "string" ? obj : JSON.stringify(obj)), re);
const base = () => JSON.parse(serializeSystem(EXAMPLE_SYSTEM));

test("round trip of EXAMPLE_SYSTEM keeps every value and still solves", () => {
  const back = parseSystem(serializeSystem(EXAMPLE_SYSTEM));
  assert.deepEqual(back, full(EXAMPLE_SYSTEM));
  assert.equal(analyseSystem(back).ok, true);
  assert.equal(serializeSystem(back), serializeSystem(EXAMPLE_SYSTEM));
});

test("defaults are stripped on save and restored on load", () => {
  const p = toProject({ name: "x", equipment: [{ id: "T", type: "transformer", name: "T", gx: 1, gy: 2, kva: 1000, z_pct: 5.75, xr: 7 }], connectors: [{ id: "c", kind: "cable", from: "T.hv", to: "T.lv", length_ft: 150, size: "2/0" }] });
  assert.deepEqual(p.equipment[0], { id: "T", type: "transformer", name: "T", gx: 1, gy: 2, kva: 1000 });
  assert.deepEqual(p.connectors[0], { id: "c", kind: "cable", from: "T.hv", to: "T.lv", size: "2/0" });
  assert.equal(p.format, "power-studio-system");
  const back = parseSystem(JSON.stringify(p));
  assert.equal(back.equipment[0].z_pct, 5.75);
  assert.equal(back.equipment[0].conn, "Dyn1");
  assert.equal(back.connectors[0].raceway, "steel");
});

test("parse errors are clear", () => {
  err("{nope", /Not valid JSON/);
  err([], /JSON object/);
  err({ format: "other", version: 1 }, /Not a Power Studio system file/);
  err({ ...base(), version: 2 }, /Unsupported system file version 2/);
  let b = base(); b.equipment[1].type = "flux-capacitor"; err(b, /Unknown equipment type "flux-capacitor"/);
  b = base(); b.equipment[2].id = b.equipment[1].id; err(b, /Duplicate equipment id/);
  b = base(); b.connectors[0].to = "NOPE.bus"; err(b, /equipment "NOPE" does not exist/);
  b = base(); b.connectors[0].to = "SWGR-MV.out"; err(b, /no terminal "out"/);
  b = base(); b.connectors[0].to = "garbage"; err(b, /EQUIPMENT-ID\.terminal/);
  b = base(); b.connectors[1].id = b.connectors[0].id; err(b, /Duplicate connector id/);
  b = base(); b.connectors[0].kind = "wire"; err(b, /Unknown connector kind "wire"/);
  b = base(); b.connectors[0].terminal_c = 85; err(b, /"terminal_c" must be 60, 75, 90 or null/);
  b = base(); b.equipment[0].gx = "3"; err(b, /"gx" must be a number/);
  b = base(); b.equipment[0].mva_sc = "big"; err(b, /"mva_sc" must be a number/);
  b = base(); delete b.equipment; err(b, /"equipment" must be an array/);
});

test("utility sc_basis: default IEC is omitted on save, ANSI round-trips, other values are rejected", () => {
  assert.equal(EQUIPMENT.utility.defaults.sc_basis, "IEC");
  assert.equal(base().equipment.find((e) => e.type === "utility").sc_basis, undefined);
  const sys = { ...EXAMPLE_SYSTEM, equipment: EXAMPLE_SYSTEM.equipment.map((e) => (e.type === "utility" ? { ...e, sc_basis: "ANSI" } : e)) };
  const text = serializeSystem(sys);
  assert.equal(JSON.parse(text).equipment.find((e) => e.type === "utility").sc_basis, "ANSI");
  const back = parseSystem(text);
  assert.equal(back.equipment.find((e) => e.type === "utility").sc_basis, "ANSI");
  assert.equal(serializeSystem(back), text);
  const b = base(); const u = b.equipment.find((e) => e.type === "utility");
  u.sc_basis = "NEMA"; err(b, /"sc_basis" must be one of "IEC", "ANSI"/);
  u.sc_basis = 1; err(b, /"sc_basis" must be a string/);
});

test("terminal_c (NEC 110.14(C) terminal marking) round-trips and is omitted when unset", () => {
  const sys = JSON.parse(JSON.stringify(EXAMPLE_SYSTEM));
  sys.connectors.find((c) => c.kind === "cable").terminal_c = 90;
  const back = parseSystem(serializeSystem(sys));
  assert.equal(back.connectors.find((c) => c.kind === "cable").terminal_c, 90);
  assert.ok(!serializeSystem(EXAMPLE_SYSTEM).includes("terminal_c"));
});

test("engine stamp: written on save, matching or missing stamp loads without a warning, a different one warns", () => {
  const p = base();
  assert.deepEqual(p.engine, { pecalc: PECALC_VERSION, data: PECALC_DATA_FINGERPRINT });
  assert.equal(p.version, VERSION);          // the file format is unchanged: older builds ignore the extra key
  assert.equal(parseSystemWithWarning(JSON.stringify(p)).warning, "");
  const { engine, ...old } = p;               // a file saved before the stamp existed still opens
  assert.equal(parseSystemWithWarning(JSON.stringify(old)).warning, "");
  assert.deepEqual(parseSystemWithWarning(JSON.stringify(old)).system, parseSystem(JSON.stringify(p)));
  const other = parseSystemWithWarning(JSON.stringify({ ...p, engine: { pecalc: "0.0.1", data: "deadbeef0000" } }));
  assert.equal(other.warning, `Project file saved with pecalc 0.0.1 (now ${PECALC_VERSION}), data deadbeef0000 (now ${PECALC_DATA_FINGERPRINT}). Results can differ from the saved run.`);
  assert.deepEqual(other.system, parseSystem(JSON.stringify(p)));   // the system itself loads unchanged
  assert.match(parseSystemWithWarning(JSON.stringify({ ...p, engine: { pecalc: PECALC_VERSION, data: "deadbeef0000" } })).warning, /^Project file saved with data deadbeef0000/);
  // A malformed stamp is ignored rather than rejected.
  for (const bad of ["x", 5, [], { pecalc: 7 }, null]) assert.equal(parseSystemWithWarning(JSON.stringify({ ...p, engine: bad })).warning, "");
});
