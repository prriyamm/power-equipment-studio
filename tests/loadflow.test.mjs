import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as LF from "../src/engine/loadflow.js";

test("IEEE 14-bus matches the PYPOWER/MATPOWER reference table to 1e-4", () => {
  const v = LF.verifySolver();
  assert.ok(v.pass, "verifySolver reports FAIL");
  assert.ok(v.maxDv < 1e-6 && v.maxDa < 1e-6);
  assert.ok(Math.abs(v.loss - 13.393) < 5e-4);
  assert.ok(v.iterations <= 6, `quadratic convergence expected, got ${v.iterations} iterations`);
});

test("bus 9 shunt is modelled: dropping it moves voltages by ~0.02 pu", () => {
  assert.ok(LF.verifySolver().shuntShift > 0.015);
});

test("3-bus export is byte-identical to the Python CLI case file", () => {
  const expected = readFileSync(new URL("./fixtures/three_bus.json", import.meta.url), "utf8");
  assert.equal(LF.serializeCase(LF.CASES.demo3.data), expected);
});

test("pyFloat reproduces Python float repr", () => {
  assert.deepEqual([1e-7, 1e16, 0.0001, 123.456, 100, 0, 0.034].map(LF.pyFloat),
    ["1e-07", "1e+16", "0.0001", "123.456", "100.0", "0.0", "0.034"]);
});

test("validation catches missing slack, bad refs, islands", () => {
  const bad = { base_mva: 100, buses: [{ id: 1, type: "PQ" }, { id: 2, type: "PQ" }, { id: 3, type: "PQ" }], branches: [{ from: 1, to: 9, r: 0, x: 0 }] };
  const msgs = LF.validateCase(bad).map((x) => x.msg).join("|");
  assert.match(msgs, /No slack bus/);
  assert.match(msgs, /does not exist/);
  assert.match(msgs, /both zero/);
  const island = { base_mva: 100, buses: [{ id: 1, type: "slack" }, { id: 2 }, { id: 3 }], branches: [{ from: 1, to: 2, x: 0.1 }] };
  assert.match(LF.validateCase(island).map((x) => x.msg).join("|"), /islands/);
});

test("power balance holds on every built-in case", () => {
  for (const c of Object.values(LF.CASES)) {
    const r = LF.runLoadFlow(c.data);
    assert.ok(r.converged);
    assert.ok(r.balance_residual_pu < 1e-8);
  }
});

test("2-bus lossless line matches the closed-form solution", () => {
  // Slack V1 = 1∠0, line x = 0.1 pu (r = 0), PQ load P = 0.5 pu, Q = 0.
  // Q2 = (V2² − V1·V2·cosδ)/x = 0 -> V2 = cosδ; P2 = −V1·V2·sinδ/x = −0.5 -> sinδ·cosδ = 0.05 -> sin2δ = 0.1.
  // δ = −asin(0.1)/2 = −2.86959°, V2 = cos(2.86959°) = 0.998746 pu.
  const r = LF.runLoadFlow({ base_mva: 100, buses: [{ id: 1, type: "slack", v: 1 }, { id: 2, type: "PQ", p_load: 50 }], branches: [{ from: 1, to: 2, r: 0, x: 0.1 }] });
  const d = Math.asin(0.1) / 2;
  assert.ok(Math.abs(r.buses[1].v - Math.cos(d)) < 1e-8);
  assert.ok(Math.abs(r.buses[1].angle_deg + (d * 180) / Math.PI) < 1e-6);
  assert.ok(Math.abs(r.total_p_loss_mw) < 1e-6);
});
