import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { designChecks, gearBusCheck, cableBusCheck } from "../src/engine/designchecks.js";

test("every cable bus run, switchgear bus and transformer in the example gets a passing design check", () => {
  const d = designChecks(EXAMPLE_SYSTEM, analyseSystem(EXAMPLE_SYSTEM));
  for (const id of ["CB-1", "CB-2", "SWGR-LV", "SWGR-MV", "SWGR-5", "T1", "T2"]) {
    assert.ok(d[id], id);
    assert.ok(d[id].passed, `${id}: ${d[id].error || d[id].checks.filter((k) => !k.passed).map((k) => k.name)}`);
  }
});

test("bus sizing picks more copper for a larger rating and meets the rise limit", () => {
  const a = gearBusCheck({ bus_a: 2000, kv: 0.48 }, 50, 6), b = gearBusCheck({ bus_a: 4000, kv: 0.48 }, 50, 6);
  const cu = (r) => r.input.bars_per_phase * r.input.bar_width_mm;
  assert.ok(cu(b) > cu(a));
  assert.ok(b.rated_current_at_limit_a >= 4000 && b.sized);
});

test("an undersized cable bus run fails its check", () => {
  const sys = JSON.parse(JSON.stringify(EXAMPLE_SYSTEM));
  Object.assign(sys.connectors.find((c) => c.id === "CB-1"), { sets: 1, size: "500" });
  const d = designChecks(sys, analyseSystem(sys));
  assert.equal(d["CB-1"].passed, false);
});

test("regression: a cable bus fed from a transformer secondary is checked at the secondary voltage", () => {
  // CB-1 runs T1.lv (480 V) -> SWGR-LV; CB-2 runs T2.lv (4.16 kV) -> SWGR-5. analysis.equipment.T1.kv is the
  // HV-side 13.8 kV (a transformer's first terminal), which the check used: 13 800 V for a 480 V run.
  const d = designChecks(EXAMPLE_SYSTEM, analyseSystem(EXAMPLE_SYSTEM));
  assert.equal(d["CB-1"].result.input.voltage_v, 480);
  assert.equal(d["CB-2"].result.input.voltage_v, 4160);
});

test("O10: LV cable bus check uses the NEC 110.14(C) terminal rating, MV keeps the insulation rating", () => {
  const c = { kind: "cablebus", size: "750", material: "Cu", sets: 4, insulation_c: 90, length_ft: 100 };
  assert.equal(cableBusCheck(c, 1500, 0.48, 30, 10).input.terminal_temp_c, 75);
  assert.equal(cableBusCheck({ ...c, terminal_c: 90 }, 1500, 0.48, 30, 10).input.terminal_temp_c, 90);
  assert.equal(cableBusCheck(c, 300, 4.16, 30, 10).input.terminal_temp_c, 90);
});
