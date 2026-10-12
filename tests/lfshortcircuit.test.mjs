import { test } from "node:test";
import assert from "node:assert/strict";
import * as LF from "../src/engine/loadflow.js";
import { lfShortCircuit, lfSources } from "../src/engine/lfshortcircuit.js";

const clone = (x) => JSON.parse(JSON.stringify(x));

test("short circuit for load-flow cases: sources, x_source_pu, kv scaling", () => {
  const d = clone(LF.CASES.ieee14.data);
  assert.deepEqual(lfSources(d).map((s) => s.bus), [1, 2, 3, 6, 8]);
  const r = lfShortCircuit(d);
  assert.equal(r.buses.length, 14);
  assert.ok(r.buses.every((b) => b.ik_ka > 0 && !b.kv_given));
  assert.ok(Math.abs(r.buses[0].ik_pu - r.buses[0].ik_ka / (100 / Math.sqrt(3))) < 1e-12);
  d.buses.forEach((b) => { if (b.type !== "PQ") b.x_source_pu = 0.2; });
  assert.ok(lfShortCircuit(d).buses[0].ik_pu < r.buses[0].ik_pu);
  const d2 = clone(LF.CASES.ieee14.data); d2.buses.forEach((b) => { b.kv = 13.8; });
  const r2 = lfShortCircuit(d2);
  assert.ok(r2.buses.every((b) => b.kv_given));
  assert.ok(Math.abs(r2.buses[3].ik_pu / r.buses[3].ik_pu - 1.1 / 1.05) < 1e-9); // c_max: 1.1 above 1 kV, 1.05 at 1 kV
  assert.ok(Math.abs(r2.buses[3].ik_ka - (r2.buses[3].ik_pu * 100) / (Math.sqrt(3) * 13.8)) < 1e-9);
});

test("short circuit: single source on a 2-bus case matches c/(x_source + x_line)", () => {
  const d = { base_mva: 100, buses: [{ id: 1, type: "slack", x_source_pu: 0.1 }, { id: 2, type: "PQ" }], branches: [{ from: 1, to: 2, r: 0, x: 0.1 }] };
  const r = lfShortCircuit(d);
  assert.ok(Math.abs(r.buses[1].ik_pu - 1.05 / 0.2) < 1e-9);
  assert.ok(Math.abs(r.buses[0].ik_pu - 1.05 / 0.1) < 1e-9);
});
