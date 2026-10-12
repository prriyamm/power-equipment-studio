import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as LF from "../src/engine/loadflow.js";

const gold = JSON.parse(readFileSync(new URL("./golden/qlimits_case14.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
function withLimits(limits) {
  const d = clone(LF.CASES.ieee14.data);
  for (const b of d.buses) { const l = limits[String(b.id)]; if (l && b.type !== "slack") { b.q_min = l[0]; b.q_max = l[1]; } }
  return d;
}

for (const [key, label] of [["case14_limits", "MATPOWER case14 limits"], ["stressed", "stressed limits"]]) {
  test(`Q-limits ${label} match PYPOWER runpf(ENFORCE_Q_LIMS=1) to 1e-4`, () => {
    const ref = gold[key];
    const r = LF.runLoadFlow(withLimits(ref.q_limits), { enforceQLimits: true });
    assert.ok(r.converged);
    ref.v.forEach((v, i) => {
      assert.ok(Math.abs(r.buses[i].v - v) < 1e-4, `V bus ${i + 1}`);
      assert.ok(Math.abs(r.buses[i].angle_deg - ref.angle_deg[i]) < 1e-4, `angle bus ${i + 1}`);
    });
    const sw = r.buses.filter((b) => b.switched).map((b) => b.id).sort((a, b) => a - b);
    assert.deepEqual(sw, ref.switched_to_pq);
  });
}

test("Q-limits: case14 limits switch nothing; stressed limits switch buses 2 and 3 at q_max", () => {
  const a = LF.runLoadFlow(withLimits(gold.case14_limits.q_limits), { enforceQLimits: true });
  assert.equal(a.switching.length, 0);
  const b = LF.runLoadFlow(withLimits(gold.stressed.q_limits), { enforceQLimits: true });
  assert.deepEqual(b.switching.map((e) => [e.bus, e.from, e.to, e.limit, e.q_mvar]),
    [[2, "PV", "PQ", "q_max", 30], [3, "PV", "PQ", "q_max", 15]]);
});

test("Q-limits: PV Q within limits after enforcement, balance holds, option off unchanged", () => {
  const d = withLimits({ 2: [-40, 20], 3: [0, 10], 6: [-6, 8], 8: [-6, 24] });
  const r = LF.runLoadFlow(d, { enforceQLimits: true });
  assert.ok(r.converged && r.switching.length > 0);
  assert.ok(r.balance_residual_pu < 1e-8);
  for (const b of r.buses) {
    const src = d.buses.find((x) => x.id === b.id);
    if (b.type === "PV" && !b.switched) assert.ok(b.q_gen_mvar <= src.q_max + 1e-4 && b.q_gen_mvar >= src.q_min - 1e-4);
    if (b.switched) assert.ok(Math.abs(b.q_gen_mvar - (b.switched_limit === "q_max" ? src.q_max : src.q_min)) < 1e-6);
  }
  const off = LF.runLoadFlow(d), plain = LF.runLoadFlow(LF.CASES.ieee14.data);
  assert.equal(off.switching, undefined);
  off.buses.forEach((b, i) => assert.equal(b.v, plain.buses[i].v));
});

test("Q-limits: a bus switched at q_max sags below its setpoint", () => {
  const r = LF.runLoadFlow(withLimits({ 2: [-40, 30] }), { enforceQLimits: true });
  assert.deepEqual(r.switching.map((e) => e.bus), [2]);
  assert.ok(r.buses[1].v < 1.045);
});
