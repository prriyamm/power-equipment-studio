import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { buildLineup, nextStandard } from "../src/engine/gear.js";

test("NEC 240.6(A) next standard rating", () => {
  assert.equal(nextStandard(237), 250);
  assert.equal(nextStandard(1600), 1600);
  assert.equal(nextStandard(1601), 2000);
});

test("LV lineup: transformer secondary main, feeders sized at 125 % and conductor protected", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const L = buildLineup(EXAMPLE_SYSTEM, a, "SWGR-LV");
  const main = L.circuits.find((c) => c.kind === "main");
  assert.equal(main.tag, "CB-1");
  assert.ok(main.trip >= 2500 / (Math.sqrt(3) * 0.48));
  for (const f of L.circuits.filter((c) => c.kind === "feeder")) {
    assert.ok(f.trip >= 1.25 * f.load_a - 1e-9, f.tag);
    assert.ok(f.ok, `${f.tag}: ${f.checks.filter((k) => !k.ok).map((k) => k.name)}`);
  }
  assert.ok(L.sections.length >= 6);
  assert.ok(L.ok);
});

test("undersized conductor under a > 800 A trip fails 240.4(C)", () => {
  const sys = JSON.parse(JSON.stringify(EXAMPLE_SYSTEM));
  sys.connectors.find((c) => c.id === "C-LOAD").sets = 5;
  const L = buildLineup(sys, analyseSystem(sys), "SWGR-LV");
  const f = L.circuits.find((c) => c.tag === "C-LOAD");
  assert.ok(!f.ok && f.checks.some((k) => /240\.4\(C\)/.test(k.name) && !k.ok));
});

test("regression: 215.3 check limit is 125 % continuous + 100 % non-continuous", () => {
  // continuous = 0.5: limit = I·(0.5·1.25 + 0.5·1.0) = 1.125·I. The check used I·1.25·0.5 = 0.625·I,
  // which let a trip below the load current pass.
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const L = buildLineup(EXAMPLE_SYSTEM, a, "SWGR-LV", { continuous: 0.5 });
  for (const f of L.circuits.filter((c) => c.kind === "feeder")) {
    const k = f.checks.find((x) => /215\.3/.test(x.name));
    assert.ok(Math.abs(k.limit - 1.125 * f.load_a) < 1e-9 * f.load_a, `${f.tag} limit ${k.limit}`);
  }
});

test("regression: 240.4(D) caps the OCPD on 12 AWG Cu at 20 A even with 90 °C ampacity", () => {
  // 12 AWG Cu, 90 °C column of 310.16 = 30 A (now limited to the 60 °C terminal column, 20 A, by 110.14(C));
  // 240.4(D) caps the trip whatever the ampacity.
  // Load 15 kW at 0.9 pf, 480 V: I ≈ 15/(√3·0.48·0.9) = 20.0 A; 1.25·I ≈ 25 A -> next standard 25 or 30 A.
  // 240.4(D): 12 AWG Cu max 20 A -> must fail.
  const sys = { base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 500, xr: 15 },
    { id: "T", type: "transformer", kva: 500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5, xr: 5 },
    { id: "S", type: "switchgear", kv: 0.48 }, { id: "L", type: "load", kw: 15, pf: 0.9 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "T.hv" }, { id: "b", kind: "direct", from: "T.lv", to: "S.bus" },
      { id: "F", kind: "cable", from: "S.bus", to: "L.in", size: "12", material: "Cu", sets: 1, length_ft: 50, insulation_c: 90 }] };
  const L = buildLineup(sys, analyseSystem(sys), "S");
  const f = L.circuits.find((c) => c.tag === "F");
  assert.ok(f.trip > 20, `trip ${f.trip}`);
  const k = f.checks.find((x) => /240\.4\(D\)/.test(x.name));
  assert.ok(k && !k.ok && k.limit === 20);
  assert.ok(!f.ok);
});

test("O10: 240.4(B) uses the 75 °C terminal-limited ampacity of 500 kcmil Cu 90 °C (380 A, not 430 A)", () => {
  // 250 kW at 0.9 pf, 480 V: I ≈ 334 A; 125 % ≈ 418 A -> 450 A trip. With 90 °C ampacity (430 A) the next size
  // up is 450 A and the check would pass; with the 75 °C terminal limit (380 A) the next size up is 400 A < 450 A.
  const mk = (extra = {}) => ({ base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 500, xr: 15 },
    { id: "T", type: "transformer", kva: 1500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7 },
    { id: "S", type: "switchgear", kv: 0.48 }, { id: "L", type: "load", kw: 250, pf: 0.9 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "T.hv" }, { id: "b", kind: "direct", from: "T.lv", to: "S.bus" },
      { id: "F", kind: "cable", from: "S.bus", to: "L.in", size: "500", material: "Cu", sets: 1, length_ft: 50, insulation_c: 90, ...extra }] });
  const f = buildLineup(mk(), analyseSystem(mk()), "S").circuits.find((c) => c.tag === "F");
  assert.equal(f.trip, 450);
  assert.equal(f.ampacity_a, 380);
  const k = f.checks.find((x) => /240\.4\(B\)/.test(x.name));
  assert.ok(k && !k.ok && k.value === 380 && k.limit === 450);
  // equipment marked for 90 °C terminations: the 90 °C column applies and the check passes
  const sys90 = mk({ terminal_c: 90 });
  const f90 = buildLineup(sys90, analyseSystem(sys90), "S").circuits.find((c) => c.tag === "F");
  assert.equal(f90.ampacity_a, 430);
  assert.ok(f90.checks.find((x) => /240\.4\(B\)/.test(x.name)).ok);
});
