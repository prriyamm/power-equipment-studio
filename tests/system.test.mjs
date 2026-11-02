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

test("O10: NEC 110.14(C) terminal limit on LV connector ampacity", async () => {
  const { connectorAmpacity } = await import("../src/engine/system.js");
  const cab = { kind: "cable", size: "500", material: "Cu", sets: 1, insulation_c: 90 };
  // 500 kcmil Cu 90 °C insulation: 430 A in the 90 °C column, limited to the 75 °C column (380 A) at LV
  const a = connectorAmpacity(cab, 0.48);
  assert.equal(a.insulation_a, 430);
  assert.equal(a.terminal_c, 75);
  assert.equal(a.per_set_a, 380);
  // marked 90 °C terminals lift the limit; marked 60 °C lowers it
  assert.equal(connectorAmpacity({ ...cab, terminal_c: 90 }, 0.48).per_set_a, 430);
  assert.equal(connectorAmpacity({ ...cab, terminal_c: 60 }, 0.48).per_set_a, tableAmpacity("cable", "500", "Cu", 60));
  // 14-1 AWG defaults to 60 °C terminals
  const small = connectorAmpacity({ ...cab, size: "4" }, 0.48);
  assert.equal(small.terminal_c, 60);
  assert.equal(small.per_set_a, tableAmpacity("cable", "4", "Cu", 60));
  // 75 °C insulation is already the lesser column
  assert.equal(connectorAmpacity({ ...cab, insulation_c: 75 }, 0.48).per_set_a, 380);
  // cable bus: insulation column from the free-air table, terminal column from 310.16 (as pecalc cablebus.js
  // for NEC): 500 kcmil Cu 90 °C free air 620 A, limited to the 310.16 75 °C rating 380 A at the terminals
  const cb = connectorAmpacity({ kind: "cablebus", size: "500", material: "Cu", sets: 1, insulation_c: 90 }, 0.48);
  assert.equal(cb.insulation_a, tableAmpacity("cablebus", "500", "Cu", 90));
  assert.equal(cb.terminal_a, tableAmpacity("cable", "500", "Cu", 75));
  assert.equal(cb.per_set_a, 380);
  // MV (> 2 kV): unchanged, insulation column
  assert.equal(connectorAmpacity(cab, 13.8).per_set_a, 430);
  assert.equal(connectorAmpacity(cab, 13.8).terminal_c, null);
  // a user ampacity override wins
  assert.equal(connectorAmpacity({ ...cab, ampacity_a: 400 }, 0.48).per_set_a, 400);
});

test("O10: system loading uses the terminal-limited ampacity (500 kcmil Cu 90 °C, 2 sets = 760 A)", () => {
  const sys = { base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 500, xr: 15 },
    { id: "T", type: "transformer", kva: 1500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7 },
    { id: "S", type: "switchgear", kv: 0.48 }, { id: "L", type: "load", kw: 400, pf: 0.9 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "T.hv" }, { id: "b", kind: "direct", from: "T.lv", to: "S.bus" },
      { id: "F", kind: "cable", from: "S.bus", to: "L.in", size: "500", material: "Cu", sets: 2, length_ft: 100, insulation_c: 90 }] };
  const r = analyseSystem(sys);
  assert.ok(r.ok, r.message);
  assert.equal(r.connectors.F.ampacity_a, 760);
  assert.equal(r.connectors.F.terminal_c, 75);
  assert.ok(Math.abs(r.connectors.F.loading_pct - (100 * r.connectors.F.i_a) / 760) < 1e-9);
});

test("regression: a zero source parameter is an error, not NaN fault currents", () => {
  const motor = EXAMPLE_SYSTEM.equipment.find((e) => e.type === "motor");
  for (const patch of [{ hp: 0 }, { lrc: 0 }]) {
    const sys = { ...EXAMPLE_SYSTEM, equipment: EXAMPLE_SYSTEM.equipment.map((e) => (e.id === motor.id ? { ...e, ...patch } : e)) };
    const r = analyseSystem(sys);
    assert.equal(r.ok, false);
    assert.match(r.message, new RegExp(`${motor.id}: "${Object.keys(patch)[0]}" must be greater than 0`));
  }
  const gen = { id: "G", type: "generator", kv: 0.48, xr: 0, gx: 40, gy: 40 };
  const lv = EXAMPLE_SYSTEM.equipment.find((e) => e.id === "SWGR-LV");
  const sys = { ...EXAMPLE_SYSTEM, equipment: [...EXAMPLE_SYSTEM.equipment, gen], connectors: [...EXAMPLE_SYSTEM.connectors, { id: "C-G", kind: "direct", from: "G.out", to: `${lv.id}.bus` }] };
  assert.match(analyseSystem(sys).message, /G: "xr" must be greater than 0/);
});

test("regression: a generator on the utility (swing) bus warns and reports no output or loading", () => {
  const sys = { ...EXAMPLE_SYSTEM, equipment: [...EXAMPLE_SYSTEM.equipment, { id: "G", type: "generator", kv: 13.8, kva: 2000, p_kw: 1500, gx: 40, gy: 40 }],
    connectors: [...EXAMPLE_SYSTEM.connectors, { id: "C-G", kind: "direct", from: "G.out", to: "UTIL.out" }] };
  const r = analyseSystem(sys);
  assert.ok(r.ok, r.message);
  assert.ok(r.issues.some((i) => i.level === "warn" && i.ref === "G" && /swing/.test(i.msg)));
  assert.equal(r.equipment.G.loading_pct, null);
  assert.equal(r.equipment.G.p_kw, null);
});

test("regression: a closed close-coupled throat is reported, so the lineup and the TCC walk see it energized", async () => {
  const { buildLineup } = await import("../src/engine/gear.js");
  const { protectionPath } = await import("../src/engine/tcc.js");
  const sys = { ...EXAMPLE_SYSTEM, connectors: EXAMPLE_SYSTEM.connectors.map((c) => (c.id === "CB-1" ? { id: "THROAT", kind: "direct", from: "T1.lv", to: "SWGR-LV.bus" } : c)) };
  const a = analyseSystem(sys);
  assert.ok(a.ok, a.message);
  const r = a.connectors.THROAT;
  assert.ok(r && !r.open && r.direct);
  assert.equal(r.dir, 1);                                        // power flows from T1.lv into the gear
  assert.ok(Math.abs(r.i_a - a.equipment.T1.i_lv_a) < 1e-9);
  const main = buildLineup(sys, a, "SWGR-LV").circuits.find((c) => c.tag === "THROAT");
  assert.equal(main.kind, "main");
  assert.ok(main.load_a > 1000, `main load ${main.load_a}`);   // was 0 A when the throat had no result
  const path = protectionPath(sys, a, "M1").devices.map((d) => d.connector);
  assert.ok(path.includes("THROAT") && path.includes("C-UTIL"), path.join(" "));
});

// Large power transformer substation used by the regressions below: 2 x 200 MVA 230/69 kV in parallel, 300 MW.
const parallel200 = () => ({
  name: "2 x 200 MVA", base_mva: 100,
  equipment: [
    { id: "UTIL", type: "utility", kv: 230, mva_sc: 20000, xr: 30, gx: 0, gy: 0 },
    { id: "YARD", type: "switchgear", kv: 230, bus_a: 3000, sc_ka: 63, gx: 4, gy: 0 },
    { id: "TA", type: "transformer", kva: 200000, hv_kv: 230, lv_kv: 69, z_pct: 12, xr: 50, gx: 8, gy: 0 },
    { id: "TB", type: "transformer", kva: 200000, hv_kv: 230, lv_kv: 69, z_pct: 12, xr: 50, gx: 8, gy: 8 },
    { id: "BUS", type: "switchgear", kv: 69, bus_a: 4000, sc_ka: 40, gx: 14, gy: 4 },
    { id: "LOAD", type: "load", kw: 300000, pf: 0.95, gx: 20, gy: 4 },
  ],
  connectors: [
    { id: "D-U", kind: "direct", from: "UTIL.out", to: "YARD.bus" },
    { id: "D-AH", kind: "direct", from: "YARD.bus", to: "TA.hv" }, { id: "D-BH", kind: "direct", from: "YARD.bus", to: "TB.hv" },
    { id: "D-AL", kind: "direct", from: "TA.lv", to: "BUS.bus" }, { id: "D-BL", kind: "direct", from: "TB.lv", to: "BUS.bus" },
    { id: "D-L", kind: "direct", from: "BUS.bus", to: "LOAD.in" },
  ],
});

test("regression: compiled branches carry MVA ratings, so the N-1 screen sees a transformer overload", async () => {
  const { screenN1 } = await import("../src/engine/contingency.js");
  const a = analyseSystem(parallel200());
  assert.ok(a.ok, a.message);
  assert.deepEqual(a.compiled.lfCase.branches.map((b) => b.rate_a), [200, 200]);
  assert.ok(Math.abs(a.lf.branches[0].loading_pct - a.equipment.TA.loading_pct) < 1, "load-flow loading matches the System");
  // losing one unit puts about 316 MVA (plus reactive) on the other 200 MVA unit
  const n1 = screenN1(a.compiled.lfCase);
  for (const row of n1.rows) assert.ok(row.overloads.length === 1 && row.overloads[0].loading_pct > 150, JSON.stringify(row));
  // cables are rated from their ampacity at nominal voltage
  const ex = analyseSystem(EXAMPLE_SYSTEM);
  const k = ex.compiled.branchMeta.findIndex((m) => m.id === "C-MCC");
  assert.ok(Math.abs(ex.compiled.lfCase.branches[k].rate_a - (Math.sqrt(3) * 0.48 * ex.compiled.branchMeta[k].ampacity_a) / 1000) < 1e-12);
});

test("regression: gear fed by a close-coupled source counts the source in its bus current", () => {
  const a = analyseSystem(parallel200());
  const yard = a.equipment.YARD, u = a.equipment.UTIL;
  // the 230 kV yard carries the utility injection (was 0 A: only branch inflows were counted)
  assert.ok(Math.abs(yard.bus_i_a - u.s_kva / (Math.sqrt(3) * 230 * yard.v_pu)) < 1e-6, `${yard.bus_i_a}`);
  assert.ok(yard.bus_i_a > 700);
});
