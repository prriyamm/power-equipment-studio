import { test } from "node:test";
import assert from "node:assert/strict";
import * as LF from "../src/engine/loadflow.js";
import { screenN1, outageCase } from "../src/engine/contingency.js";

const clone = (x) => JSON.parse(JSON.stringify(x));

test("N-1 on IEEE 14: 20 rows, branch 7-8 islands, all others converge", () => {
  const { rows, base } = screenN1(LF.CASES.ieee14.data);
  assert.ok(base.converged);
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.filter((r) => r.islanding).map((r) => [r.from, r.to]), [[7, 8]]);
  assert.ok(rows.filter((r) => !r.islanding).every((r) => r.converged));
  assert.equal(rows[rows.length - 1].islanding, true);
  for (let i = 1; i < rows.length - 1; i++) assert.ok(rows[i - 1].severity >= rows[i].severity);
  assert.deepEqual(rows[0].overloads, []);   // no rate_a -> no overloads
  assert.equal(rows[0].max_loading_pct, null);
});

test("N-1: overloads reported when rate_a is set; row matches a direct outage solve", () => {
  const d = clone(LF.CASES.ieee14.data);
  d.branches.forEach((b) => { b.rate_a = 60; });
  const { rows } = screenN1(d);
  assert.ok(rows.some((r) => r.overloads.length > 0));
  const row = rows.find((r) => r.from === 1 && r.to === 2);
  const direct = LF.runLoadFlow(outageCase(d, row.branch));
  assert.ok(Math.abs(Math.min(...direct.buses.map((b) => b.v)) - row.min_v) < 1e-7);
});
