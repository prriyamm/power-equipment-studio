import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/engine/pecalc/switchgear.js";
import { peakFactor } from "../src/engine/pecalc/forces.js";

const G = JSON.parse(readFileSync(new URL("./golden/switchgear.json", import.meta.url), "utf8"));

// Python solves the heat balance by bisection (80 steps) and the force by time stepping: 1e-6.
const REL = 1e-6;

function close(a, b, rel, path) {
  if (typeof b === "number") {
    assert.equal(typeof a, "number", `${path}: expected a number, got ${a}`);
    assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-12) + 1e-12, `${path}: JS ${a} vs Python ${b}`);
  } else if (Array.isArray(b)) {
    assert.equal(a.length, b.length, `${path}: length`);
    b.forEach((x, i) => close(a[i], x, rel, `${path}[${i}]`));
  } else if (b && typeof b === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(b)) close(a[k], b[k], rel, `${path}.${k}`);
  } else {
    assert.equal(a, b, path);
  }
}

const run = (inputs) => S.analyseBus(S.busInput(inputs));

function checkVector(v, i) {
  const label = `vector ${i} (${JSON.stringify(v.inputs)})`;
  if (v.error !== undefined) {
    assert.throws(() => run(v.inputs), (e) => e instanceof Error && e.message === v.error, `${label}: expected error "${v.error}"`);
    return;
  }
  close(run(v.inputs), v.result, REL, label);
}

test(`golden: ${G.vectors.length} Python vectors match field by field`, () => {
  G.vectors.forEach(checkVector);
});

test("golden: shipped 3000 A switchboard example matches", () => {
  checkVector(G.example, "example");
  assert.equal(G.example.inputs.bars_per_phase, 3);
});

test("golden: vector set covers the required ranges", () => {
  const ok = G.vectors.filter((v) => v.result);
  const ins = ok.map((v) => ({ current_a: 2000, ...v.inputs }));
  assert.ok(Math.min(...ins.map((i) => i.current_a)) <= 600 && Math.max(...ins.map((i) => i.current_a)) >= 6000);
  for (const n of [1, 2, 3, 4, 6]) assert.ok(ins.some((i) => i.bars_per_phase === n), `${n} bars`);
  for (const t of [6.35, 9.53, 12.7]) assert.ok(ins.some((i) => i.bar_thickness_mm === t), `thickness ${t}`);
  assert.ok(ins.some((i) => i.bar_width_mm <= 50.8) && ins.some((i) => i.bar_width_mm >= 203.2));
  assert.ok(ins.some((i) => i.material === "Al") && ins.some((i) => i.material === "Cu"));
  assert.ok(ins.some((i) => i.orientation === "edge_to_edge") && ins.some((i) => i.orientation === "face_to_face"));
  assert.ok(ins.some((i) => i.fault_ka === 25) && ins.some((i) => i.fault_ka === 100));
  assert.ok(ok.some((v) => !v.result.passed) && ok.some((v) => v.result.passed));
  // 11 since pecalc #10: fault_ka <= 0, voltage_v <= 0 and X/R <= 0 are rejected by the input validation.
  assert.equal(G.vectors.filter((v) => v.error).length, 11);
});

test("golden: helpers match Python", () => {
  for (const [m, t, f, d] of G.helpers.skin_depth_mm) close(S.skin_depth_mm(m, t, f), d, 1e-9, `skin(${m},${t},${f})`);
  for (const [inp, t, nm] of G.helpers.mesh) assert.deepEqual(S.mesh(S.busInput(inp), t), nm);
});

/* ---- ported from calculations/tests/test_engine.py (class SwitchgearBus) ---- */
const near = (a, b, delta, msg) => assert.ok(Math.abs(a - b) <= delta, `${msg ?? ""} ${a} vs ${b} (delta ${delta})`);

test("single bar rating matches DIN 43671 order", () => {
  // DIN 43671 (memory, UNVERIFIED): 100 x 10 mm Cu, 35 C ambient, 30 K rise, AC:
  // bare ~1600-1700 A, painted ~1800-1900 A. Loose +/-15 % band.
  const base = { bar_thickness_mm: 10, bar_width_mm: 100, bars_per_phase: 1, phase_spacing_mm: 200, ambient_c: 35, max_rise_c: 30, current_a: 1500 };
  const bare = run({ ...base, finish: "bare" }).rated_current_at_limit_a;
  const painted = run({ ...base, finish: "painted" }).rated_current_at_limit_a;
  near(bare / 1650, 1, 0.15);
  near(painted / 1850, 1, 0.15);
  assert.ok(painted > bare);
});

test("fault force matches the classic phase-pack formula", () => {
  const r = run({ bars_per_phase: 1, phase_spacing_mm: 300, fault_ka: 50, x_over_r: 15 });
  const classic = 0.866 * 2e-7 * (peakFactor(15) * 50e3) ** 2 / 0.3;
  near(r.peak_force_n_per_m / classic, 1, 0.05);
});

test("edge-to-edge is stiffer against phase forces", () => {
  const f2f = run({ fault_ka: 65, support_span_m: 0.6 });
  const e2e = run({ fault_ka: 65, support_span_m: 0.6, orientation: "edge_to_edge" });
  assert.ok(f2f.bending_stress_mpa > 5 * e2e.bending_stress_mpa);
  assert.ok(e2e.max_span_m > f2f.max_span_m);
});

test("AC resistance ratio and lamination sharing", () => {
  const r = run({ bars_per_phase: 2 });
  assert.ok(r.rac_over_rdc > 1.0 && r.rac_over_rdc < 1.6);
  near(r.lamination_share_pct.reduce((a, b) => a + b, 0) / 2, 100, 3);
});

test("input validation", () => {
  assert.throws(() => S.busInput({ nope: 1 }), /unexpected field 'nope'/);
  assert.throws(() => run({ material: "Fe" }), /material must be Cu or Al/);
});
