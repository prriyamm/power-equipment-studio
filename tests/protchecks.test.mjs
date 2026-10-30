// Protection code checks: NEC 450.3(A)/(B), CEC 26-250/26-254, NEC 240.87, NEC 110.16(B).
// Hand examples; all table values are UNVERIFIED (see src/engine/data/protection_code_checks.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineupTrips,
  ratedCurrent, allowedRating, nec4503, cec26, arcEnergyCheck, serviceLabelCheck, protectionCodeChecks, PROT_DATA, PROT_DATA_STATUS, complianceReportChecks,
} from "../src/engine/protchecks.js";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { parseSystem, serializeSystem } from "../src/engine/systemio.js";

const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const brk = (a) => ({ type: "breaker", setting_a: a, label: `${a} A breaker` });
const fuse = (a) => ({ type: "fuse", setting_a: a, label: `${a} A fuse` });
const clone = (x) => JSON.parse(JSON.stringify(x));

// 2500 kVA 13.8 kV / 480 V, Z 5.75 %
//   primary FLA   = 2500 / (√3 · 13.8)  = 2500 / 23.902 = 104.59 A
//   secondary FLA = 2500 / (√3 · 0.48)  = 2500 / 0.8314 = 3007.0 A
const T2500 = { kva: 2500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75 };

test("data file carries _meta with clause and status on every table, all UNVERIFIED", () => {
  assert.equal(PROT_DATA_STATUS, "UNVERIFIED");
  for (const [k, t] of Object.entries(PROT_DATA)) {
    if (k === "_meta") continue;
    assert.ok(t._meta?.clause, `${k} clause`);
    assert.equal(t._meta.status, "UNVERIFIED", k);
  }
});

test("rated currents of the 2500 kVA example", () => {
  near(ratedCurrent(2500, 13.8), 104.59, 0.01);
  near(ratedCurrent(2500, 0.48), 3007.0, 0.1);
});

test("next higher standard rating only applies with a ladder", () => {
  // 125 % of 3007.0 A = 3758.8 A → next 240.6(A) rating 4000 A
  const a = allowedRating(125, 3007.0, true, true);
  near(a.raw_a, 3758.8, 0.1); assert.equal(a.allowed_a, 4000); assert.equal(a.next_higher, true);
  assert.equal(allowedRating(125, 3007.0, true, false).allowed_a, a.raw_a);
  // beyond the 6000 A top of the list the exact value governs
  near(allowedRating(250, 3007.0, true, true).allowed_a, 7517.5, 0.01);
});

test("450.3(A) any location, Z ≤ 6 %: primary breaker 600 % (627.6 A), fuse 300 % (313.8 A), secondary 125 % → 4000 A", () => {
  let r = nec4503({ ...T2500, primary: brk(600), secondary: brk(4000) });
  assert.equal(r.table, "Table 450.3(A)"); assert.equal(r.pass, true);
  const [p, s] = r.chosen.items;
  near(p.allowed_a, 627.6, 0.1); assert.equal(s.allowed_a, 4000);
  // 700 A primary breaker > 627.6 A
  r = nec4503({ ...T2500, primary: brk(700), secondary: brk(4000) });
  assert.equal(r.pass, false); assert.equal(r.chosen.items[0].pass, false);
  // fuses: 300 A ≤ 313.8 A passes, 400 A fails (no MV fuse ladder: exact limit)
  assert.equal(nec4503({ ...T2500, primary: fuse(300), secondary: brk(4000) }).pass, true);
  assert.equal(nec4503({ ...T2500, primary: fuse(400), secondary: brk(4000) }).pass, false);
  // 5000 A secondary > 4000 A allowed
  assert.equal(nec4503({ ...T2500, primary: brk(600), secondary: brk(5000) }).pass, false);
});

test("450.3(A) unsupervised needs a secondary device; supervised allows primary only at 300 % (313.8 A)", () => {
  let r = nec4503({ ...T2500, primary: brk(300), secondary: null });
  assert.equal(r.pass, false);
  assert.match(r.chosen.items[1].note, /No secondary/);
  r = nec4503({ ...T2500, supervised: true, primary: brk(300), secondary: null });
  assert.equal(r.pass, true); assert.match(r.chosen.scheme, /primary only/);
  // 400 A > 313.8 A primary-only, and no secondary for the other supervised scheme
  assert.equal(nec4503({ ...T2500, supervised: true, primary: brk(400), secondary: null }).pass, false);
});

test("450.3(A) supervised secondary ≤ 1000 V at 250 % (7517.6 A): 6000 A passes supervised, fails unsupervised", () => {
  assert.equal(nec4503({ ...T2500, supervised: true, primary: brk(600), secondary: brk(6000) }).pass, true);
  assert.equal(nec4503({ ...T2500, supervised: false, primary: brk(600), secondary: brk(6000) }).pass, false);
});

test("450.3(A) 6 % < Z ≤ 10 %: primary breaker 400 % (418.4 A); Z > 10 % needs review", () => {
  const t = { ...T2500, z_pct: 8 };
  assert.equal(nec4503({ ...t, primary: brk(400), secondary: brk(4000) }).pass, true);
  assert.equal(nec4503({ ...t, primary: brk(450), secondary: brk(4000) }).pass, false);
  const r = nec4503({ ...T2500, z_pct: 12, primary: brk(300), secondary: brk(4000) });
  assert.equal(r.status, "warn"); assert.equal(r.chosen, null);
});

test("450.3(A) secondary over 1000 V: 1500 kVA 13.8/4.16 kV, secondary breaker 300 % of 208.2 A = 624.5 A", () => {
  const r = nec4503({ kva: 1500, hv_kv: 13.8, lv_kv: 4.16, z_pct: 5.5, primary: brk(300), secondary: brk(600) });
  near(r.fla_s, 208.18, 0.01); near(r.chosen.items[1].allowed_a, 624.5, 0.1); assert.equal(r.pass, true);
});

test("450.3(B) 75 kVA 480/208 V: primary-only 125 % → 125 A; primary + secondary 250 % / 125 %", () => {
  // primary FLA = 75 / (√3 · 0.48) = 90.21 A; 125 % = 112.8 A → next standard 125 A
  // secondary FLA = 75 / (√3 · 0.208) = 208.2 A; 125 % = 260.2 A → next standard 300 A; primary 250 % = 225.5 A
  const t = { kva: 75, hv_kv: 0.48, lv_kv: 0.208, z_pct: 3 };
  let r = nec4503({ ...t, primary: brk(125), secondary: null });
  assert.equal(r.table, "Table 450.3(B)"); assert.equal(r.pass, true); assert.equal(r.chosen.items[0].allowed_a, 125);
  assert.equal(nec4503({ ...t, primary: brk(150), secondary: null }).pass, false);
  r = nec4503({ ...t, primary: brk(150), secondary: brk(250) });
  assert.equal(r.pass, true); assert.match(r.chosen.scheme, /Primary and secondary/);
  near(r.chosen.items[0].allowed_a, 225.5, 0.1); assert.equal(r.chosen.items[1].allowed_a, 300);
  assert.equal(nec4503({ ...t, primary: brk(250), secondary: brk(250) }).pass, false);
});

test("450.3(B) small primary current row: 5 kVA 480 V, FLA 6.01 A → 167 % = 10.04 A, no next-higher", () => {
  const t = { kva: 5, hv_kv: 0.48, lv_kv: 0.208, z_pct: 3 };
  assert.equal(nec4503({ ...t, primary: brk(10), secondary: null }).pass, true);
  assert.equal(nec4503({ ...t, primary: brk(15), secondary: null }).pass, false);
});

test("CEC 26-250 over 750 V: breaker 300 % (313.8 A), fuse 150 % (156.9 A)", () => {
  let r = cec26({ ...T2500, primary: brk(300), secondary: null });
  assert.equal(r.clause, "CEC 26-250"); assert.equal(r.pass, true);
  assert.equal(cec26({ ...T2500, primary: brk(350), secondary: null }).pass, false);
  assert.equal(cec26({ ...T2500, primary: fuse(150), secondary: null }).pass, true);
  assert.equal(cec26({ ...T2500, primary: fuse(175), secondary: null }).pass, false);
  assert.match(r.notes.join(" "), /26-252/);
});

test("CEC 26-254 750 V or less: 125 % primary only, or 300 % with secondary ≤ 125 %", () => {
  const t = { kva: 75, hv_kv: 0.6, lv_kv: 0.208, z_pct: 3 };
  // primary FLA = 75 / (√3 · 0.6) = 72.17 A; 125 % = 90.2 A → next 100 A; 300 % = 216.5 A; secondary 125 % of 208.2 = 260.2 A (exact)
  assert.equal(cec26({ ...t, primary: brk(100), secondary: null }).pass, true);
  assert.equal(cec26({ ...t, primary: brk(200), secondary: null }).pass, false);
  assert.equal(cec26({ ...t, primary: brk(200), secondary: brk(250) }).pass, true);
  assert.equal(cec26({ ...t, primary: brk(200), secondary: brk(300) }).pass, false);
});

test("240.87 threshold, method selection and instantaneous vs arcing current", () => {
  assert.equal(arcEnergyCheck({ max_trip_a: 1000 }).applies, false);
  assert.equal(arcEnergyCheck({ max_trip_a: 1200 }).status, "fail");
  assert.equal(arcEnergyCheck({ max_trip_a: 1600, method: "zsi" }).status, "pass");
  // inst 10 × 1600 = 16000 A, +10 % = 17600 A < 20 kA arcing → pass; ≥ 15 kA → fail
  assert.equal(arcEnergyCheck({ max_trip_a: 1600, method: "inst", inst_pickup_a: 16000, iarc_ka: 20 }).status, "pass");
  assert.equal(arcEnergyCheck({ max_trip_a: 1600, method: "inst", inst_pickup_a: 16000, iarc_ka: 15 }).status, "fail");
  const nv = arcEnergyCheck({ max_trip_a: 1600, method: "inst", inst_pickup_a: 16000, iarc_ka: null, iarc_reason: "PLACEHOLDER-gated" });
  assert.equal(nv.status, "warn"); assert.match(nv.note, /cannot verify/i);
  assert.equal(arcEnergyCheck({ max_trip_a: 1600, method: "inst", inst_pickup_a: null, iarc_ka: 30 }).status, "fail");
});

test("110.16(B) service label at ≥ 1000 A with prefill", () => {
  const r = serviceLabelCheck({ rating_a: 1200, service: true, kv: 0.48, ik_ka: 42.1, clearing_s: 0.05 });
  assert.equal(r.status, "warn"); assert.equal(r.prefill[0].value, "480 V"); assert.equal(r.prefill[1].value, "42.10 kA"); assert.equal(r.prefill[2].value, "0.050 s");
  assert.equal(serviceLabelCheck({ rating_a: 1200, service: true, label_date: "2026-10-01" }).status, "pass");
  assert.equal(serviceLabelCheck({ rating_a: 800, service: true }).applies, false);
  assert.equal(serviceLabelCheck({ rating_a: 4000, service: false }).applies, false);
});

test("system: example package under NEC", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const r = protectionCodeChecks(EXAMPLE_SYSTEM, a);
  assert.equal(r.code, "NEC");
  const t1 = r.checks.filter((k) => k.group === "T1");
  assert.equal(t1.length, 2);
  // T1 secondary main from the lineup is 4000 A ≤ next standard above 125 % × 3007 A
  const sec = t1.find((k) => k.key === "T1:oc:secondary");
  assert.equal(sec.value, 4000); assert.equal(sec.limit, 4000); assert.equal(sec.status, "pass");
  near(t1.find((k) => k.key === "T1:oc:primary").limit, 627.6, 0.1);
  // CB-1 (4000 A main) and C-LOAD (2000 A feeder) need arc energy reduction
  const aer = r.checks.filter((k) => k.clause === "NEC 240.87").map((k) => k.target.id).sort();
  assert.deepEqual(aer, ["C-LOAD", "CB-1"]);
  assert.ok(r.checks.filter((k) => k.clause === "NEC 240.87").every((k) => k.status === "fail"));
  // SWGR-MV is fed from the utility (assumed service equipment), 1200 A ≥ 1000 A → label required
  const lab = r.checks.find((k) => k.key === "SWGR-MV:label");
  assert.equal(lab.status, "warn"); assert.ok(lab.prefill[1].value.endsWith("kA")); assert.ok(lab.prefill[2].value?.endsWith(" s"));
  assert.ok(complianceReportChecks(r).every((c) => c.clause.includes("UNVERIFIED")));
});

test("system: user inputs (method, supervised, service, label date, code)", () => {
  const s = clone(EXAMPLE_SYSTEM);
  s.connectors.find((c) => c.id === "C-LOAD").aer_method = "zsi";
  const cb1 = s.connectors.find((c) => c.id === "CB-1");
  cb1.aer_method = "inst";
  s.equipment.find((e) => e.id === "SWGR-MV").label_date = "2026-10-16";
  const a = analyseSystem(s);
  let r = protectionCodeChecks(s, a);
  const by = (key) => r.checks.find((k) => k.key === key);
  assert.equal(by("C-LOAD:aer").status, "pass");
  assert.equal(by("CB-1:aer").status, "fail"); // the main has no instantaneous element by default
  assert.equal(by("SWGR-MV:label").status, "pass");
  // manual instantaneous on the main: the arc-flash study is PLACEHOLDER-gated, so it cannot verify
  cb1.protection = { inst: 4 };
  r = protectionCodeChecks(s, analyseSystem(s));
  assert.equal(by("CB-1:aer").status, "warn");
  assert.match(by("CB-1:aer").note, /PLACEHOLDER/);
  // not service equipment
  s.equipment.find((e) => e.id === "SWGR-MV").service = false;
  r = protectionCodeChecks(s, analyseSystem(s));
  assert.equal(by("SWGR-MV:label").status, "pass");
  // CEC: only transformer checks
  s.code = "CEC";
  r = protectionCodeChecks(s, analyseSystem(s));
  assert.equal(r.code, "CEC");
  assert.ok(r.checks.every((k) => k.clause.startsWith("CEC")));
  assert.ok(r.notes.some((n) => /240\.87/.test(n)));
});

test("system: unsolved analysis gives no checks", () => {
  const r = protectionCodeChecks(EXAMPLE_SYSTEM, { ok: false });
  assert.equal(r.checks.length, 0);
});

test("project code and protection inputs survive save / load", () => {
  const s = clone(EXAMPLE_SYSTEM);
  s.code = "CEC";
  s.equipment.find((e) => e.id === "T1").oc_supervised = true;
  s.connectors.find((c) => c.id === "CB-1").aer_method = "zsi";
  const back = parseSystem(serializeSystem(s));
  assert.equal(back.code, "CEC");
  assert.equal(back.equipment.find((e) => e.id === "T1").oc_supervised, true);
  assert.equal(back.connectors.find((c) => c.id === "CB-1").aer_method, "zsi");
  assert.throws(() => parseSystem({ ...JSON.parse(serializeSystem(s)), code: "IEC" }), /code/);
  assert.equal(parseSystem(serializeSystem(EXAMPLE_SYSTEM)).code, undefined);
});

test("regression: lineupTrips keeps the source-end feeder trip whatever the equipment order", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const feeder = lineupTrips(EXAMPLE_SYSTEM, a)["C-MCC"];
  const mccFirst = { ...EXAMPLE_SYSTEM, equipment: [...EXAMPLE_SYSTEM.equipment].sort((x, y) => (y.id === "MCC-1") - (x.id === "MCC-1")) };
  assert.equal(mccFirst.equipment[0].id, "MCC-1");
  assert.equal(lineupTrips(mccFirst, analyseSystem(mccFirst))["C-MCC"], feeder);
  assert.ok(feeder < 800, `feeder trip ${feeder} should be the SWGR-LV feeder, not the MCC main`);
});
