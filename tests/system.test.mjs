import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, compileSystem, EXAMPLE_SYSTEM, rdcPer1000ft, racPer1000ft, tableAmpacity } from "../src/engine/system.js";
import { shortCircuit, kappa } from "../src/engine/shortcircuit.js";

test("example package compiles, solves and stays in a sane operating range", () => {
  const r = analyseSystem(EXAMPLE_SYSTEM);
  assert.ok(r.ok, r.message);
  assert.equal(r.issues.filter((x) => x.level === "error").length, 0);
  assert.ok(r.totals.min_v > 0.9 && r.totals.max_v <= 1.0001);
  assert.ok(r.lf.balance_residual_pu < 1e-8);
  const t1 = r.equipment.T1;
  assert.ok(t1.loading_pct > 20 && t1.loading_pct < 100, `T1 loading ${t1.loading_pct}`);
});

test("infinite-bus transformer fault matches the hand formula I = Ifl / Z", () => {
  // 2500 kVA, 5.75 %, 480 V, utility 1e9 MVA: Ik = c * Ifl / z = 1.05 * 3007 A / 0.0575
  const sys = { base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 1e9, xr: 15 },
    { id: "T", type: "transformer", kva: 2500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7 },
    { id: "S", type: "switchgear", kv: 0.48 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "T.hv" }, { id: "b", kind: "direct", from: "T.lv", to: "S.bus" }] };
  const r = analyseSystem(sys);
  const ifl = 2500 / (Math.sqrt(3) * 0.48) / 1000;
  assert.ok(Math.abs(r.equipment.S.ik_ka - (1.05 * ifl) / 0.0575) < 1e-3 * r.equipment.S.ik_ka);
});

test("close-coupled voltage mismatch and cable across voltages are rejected", () => {
  const bad = { equipment: [{ id: "U", type: "utility", kv: 13.8 }, { id: "S", type: "switchgear", kv: 0.48 }], connectors: [{ id: "x", kind: "cable", from: "U.out", to: "S.bus" }] };
  assert.match(compileSystem(bad).issues.map((i) => i.msg).join("|"), /Cables cannot change voltage/);
});

test("conductor data", () => {
  // 750 kcmil Cu at 75 °C: about 0.0171 Ω/1000 ft DC (NEC Ch. 9 Table 8 lists 0.0171 uncoated)
  assert.ok(Math.abs(rdcPer1000ft("750", "Cu", 75) - 0.0171) < 0.0006);
  assert.equal(tableAmpacity("cable", "500", "Cu", 75), 380);
  // Rac adds skin + proximity: NEC Ch. 9 Table 9 lists 0.018 (PVC) to 0.019 (steel) Ω/1000 ft for 750 kcmil Cu
  const rac = racPer1000ft("750", "Cu", 75);
  assert.ok(rac > rdcPer1000ft("750", "Cu", 75) && rac > 0.0175 && rac < 0.0200, `Rac ${rac}`);
});

test("kappa and a single-source fault", () => {
  assert.ok(Math.abs(kappa(0) - 2.0) < 1e-12);
  const sc = shortCircuit({ base_mva: 100, buses: [{ id: 1 }], branches: [] }, [13.8], [{ bus: 1, r: 0, x: 0.2, kind: "utility" }]);
  const ibase = 100 / (Math.sqrt(3) * 13.8);
  assert.ok(Math.abs(sc.buses[0].ik_ka - (1.1 * ibase) / 0.2) < 1e-9);
});

test("opening a feeder breaker de-energizes everything downstream", () => {
  const sys = JSON.parse(JSON.stringify(EXAMPLE_SYSTEM));
  sys.connectors.find((c) => c.id === "C-MCC").closed = false;
  const r = analyseSystem(sys);
  assert.ok(r.ok, r.message);
  for (const id of ["MCC-1", "M1", "M2"]) assert.ok(r.equipment[id].deenergized, id);
  assert.ok(!r.equipment["SWGR-LV"].deenergized);
  assert.ok(r.connectors["C-MCC"].open);
  const base = analyseSystem(EXAMPLE_SYSTEM);
  assert.ok(r.totals.load_kw < base.totals.load_kw - 100);
});

test("regression: utility-bus fault reproduces the stated S″k (IEC 60909-0 Z_Q = c·Un²/S″kQ)", () => {
  // Utility 500 MVA at 13.8 kV, fault at the utility's own bus.
  //   IEC 60909-0: Z_Q = c_Q·Un²/S″kQ, I″k = c·Un/(√3·|Z_Q|) = S″kQ/(√3·Un) = 500/(√3·13.8) = 20.9185 kA.
  //   Before the fix Z_Q = Un²/S″kQ (no c_Q), giving 1.1 × 20.9185 = 23.0103 kA.
  const sys = { base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 500, xr: 15 },
    { id: "S", type: "switchgear", kv: 13.8 }, { id: "L", type: "load", kw: 100 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "S.bus" }, { id: "b", kind: "direct", from: "S.bus", to: "L.in" }] };
  const r = analyseSystem(sys);
  const expected = 500 / (Math.sqrt(3) * 13.8); // 20.9185 kA
  assert.ok(Math.abs(r.equipment.S.ik_ka - expected) < 1e-9 * expected, `${r.equipment.S.ik_ka} vs ${expected}`);
  assert.ok(Math.abs(r.sc.buses[0].xr - 15) < 1e-9); // feeder X/R preserved
});

test("regression: finite utility + transformer LV fault by hand (IEC 60909 c_max, no K_T)", () => {
  // Base 10 MVA. Utility 500 MVA, X/R 15 at 13.8 kV: |Z_Q| = 1.1·10/500 = 0.022 pu.
  //   R_Q = 0.022/√(1+225) = 0.00146342, X_Q = 15·R_Q = 0.0219513.
  // Transformer 2500 kVA, 5.75 %, X/R 7: |Z_T| = 0.0575·10/2.5 = 0.23 pu.
  //   R_T = 0.23/√50 = 0.0325269, X_T = 0.227688.
  // Z = 0.0339903 + j0.249640, |Z| = 0.251943 pu. Ibase(0.48 kV) = 10/(√3·0.48) = 12.0281 kA.
  // I″k = 1.05·12.0281/0.251943 = 50.128 kA.
  const sys = { base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 500, xr: 15 },
    { id: "T", type: "transformer", kva: 2500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7 },
    { id: "S", type: "switchgear", kv: 0.48 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "T.hv" }, { id: "b", kind: "direct", from: "T.lv", to: "S.bus" }] };
  const r = analyseSystem(sys);
  const zq = (1.1 * 10) / 500, rq = zq / Math.sqrt(226), zt = (0.0575 * 10) / 2.5, rt = zt / Math.sqrt(50);
  const z = Math.hypot(rq + rt, 15 * rq + 7 * rt);
  const expected = (1.05 * 10) / (Math.sqrt(3) * 0.48) / z;
  assert.ok(Math.abs(expected - 50.128) < 0.01, `hand value ${expected}`);
  assert.ok(Math.abs(r.equipment.S.ik_ka - expected) < 1e-9 * expected, `${r.equipment.S.ik_ka} vs ${expected}`);
});
