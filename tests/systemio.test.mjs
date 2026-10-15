import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSystem, parseSystem, toProject } from "../src/engine/systemio.js";
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

test("terminal_c (NEC 110.14(C) terminal marking) round-trips and is omitted when unset", () => {
  const sys = JSON.parse(JSON.stringify(EXAMPLE_SYSTEM));
  sys.connectors.find((c) => c.kind === "cable").terminal_c = 90;
  const back = parseSystem(serializeSystem(sys));
  assert.equal(back.connectors.find((c) => c.kind === "cable").terminal_c, 90);
  assert.ok(!serializeSystem(EXAMPLE_SYSTEM).includes("terminal_c"));
});
