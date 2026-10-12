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
