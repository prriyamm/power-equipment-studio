import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { designChecks, gearBusCheck } from "../src/engine/designchecks.js";

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
