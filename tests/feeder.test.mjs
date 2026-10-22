import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/engine/pecalc/sizing.js";
import * as L from "../src/engine/pecalc/lugs.js";
import * as A from "../src/engine/pecalc/ampacity.js";
import * as C from "../src/engine/pecalc/conductors.js";

const G = JSON.parse(readFileSync(new URL("./golden/feeder.json", import.meta.url), "utf8"));
const REL = 1e-9;

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

function runVector(v) {
  if (v.kind === "lug") return L.selectLugs(L.lugInput(v.inputs));
  const r = S.sizeFeeder(S.feederInput(v.inputs));
  delete r.considered; // UI-only addition, not in the Python result
  return r;
}

function checkVector(v, i) {
  const label = `vector ${i} (${v.kind} ${JSON.stringify(v.inputs)})`;
  if (v.error !== undefined) {
    assert.throws(() => runVector(v), (e) => e instanceof Error && e.message === v.error, `${label}: expected error "${v.error}"`);
    return;
  }
  close(runVector(v), v.result, REL, label);
}

test(`golden: ${G.vectors.length} Python feeder vectors match field by field`, () => {
  G.vectors.forEach(checkVector);
});

test(`golden: ${G.lug_vectors.length} Python lug vectors match field by field`, () => {
  G.lug_vectors.forEach(checkVector);
});

test("golden: shipped 480 V 400 A example matches", () => {
  checkVector(G.example, "example");
});

test("golden: helpers match", () => {
  for (const [c, a, s, exp] of G.helpers.default_terminal_temp) assert.deepEqual(L.defaultTerminalTemp(c, a, s), exp);
  for (const [s, exp] of G.helpers.stud_for) assert.deepEqual(L.studFor(s), exp);
});

test("golden: vector set covers the required ranges", () => {
  const ok = G.vectors.filter((v) => v.result);
  for (const volt of [120, 208, 240, 480, 600]) assert.ok(ok.some((v) => v.inputs.voltage_v === volt), `V ${volt}`);
  const amps = ok.map((v) => (v.inputs.continuous_a || 0) + (v.inputs.noncontinuous_a || 0));
  assert.ok(Math.min(...amps) <= 15 && Math.max(...amps) >= 4000);
  assert.ok(ok.some((v) => v.inputs.material === "Al") && ok.some((v) => v.inputs.material === "Cu"));
  assert.ok(ok.some((v) => v.inputs.ambient_c <= 20) && ok.some((v) => v.inputs.ambient_c >= 50));
  assert.ok(ok.some((v) => v.inputs.fault_ka));
  assert.ok(G.vectors.filter((v) => v.error).length >= 8);
  assert.ok(ok.some((v) => v.inputs.code === "CEC"));
});

// ---------------------------------------------------------------- ports of calculations/tests/test_engine.py

test("ampacity: ambient factor and grouping factors", () => {
  assert.ok(Math.abs(A.ambientFactor(40, 90) - 0.91) <= 0.005);
  assert.ok(Math.abs(A.ambientFactor(40, 75) - 0.88) <= 0.005);
  assert.equal(A.ambientFactor(95, 90), 0);
  assert.equal(A.cccFactor("NEC", 3), 1.0);
  assert.equal(A.cccFactor("NEC", 6), 0.8);
  assert.equal(A.cccFactor("NEC", 9), 0.7);
  assert.equal(A.cccFactor("CEC", 24), 0.7);
});

test("CEC placeholder is refused", () => {
  assert.throws(() => S.sizeFeeder(S.feederInput({ code: "CEC", continuous_a: 100 })), A.DataStatusError);
});

test("hand example single set", () => {
  // 400 A continuous -> 500 A at 75 C terminals. NEC 310.16 75 C: 900 kcmil = 520 A,
  // 800 kcmil = 490 A (too small). Hand calculation.
  const r = S.sizeFeeder(S.feederInput({ voltage_v: 480, continuous_a: 400, length_m: 30.48, sets: 1 }));
  assert.equal(r.recommended.size, "900");
});

test("hand example two sets", () => {
  // 2 sets: 250 A per set at 75 C -> 250 kcmil (255 A).
  const r = S.sizeFeeder(S.feederInput({ voltage_v: 480, continuous_a: 400, length_m: 30.48, sets: 2 }));
  assert.equal(r.recommended.size, "250");
});

test("parallel minimum enforced", () => {
  const r = S.sizeFeeder(S.feederInput({ voltage_v: 480, continuous_a: 100, length_m: 10, sets: 2 }));
  assert.ok(C.sizeIndex(r.recommended.size) >= C.sizeIndex("1/0"));
});

test("voltage drop simple formula", () => {
  // VD = sqrt(3) I L (R cos + X sin); compare with an independent re-computation.
  const r = S.sizeFeeder(S.feederInput({ voltage_v: 480, continuous_a: 200, length_m: 100, sets: 1, power_factor: 1.0 })).recommended;
  const expected = (Math.sqrt(3) * 200 * 100 * r.r_ohm_per_km / 1000 / 480) * 100;
  assert.ok(Math.abs(r.vd_pct - expected) <= 0.01);
});

test("lugs: default terminal temperature rule", () => {
  // NEC 110.14(C)(1) / CEC 4-006: <= 100 A or 14-1 AWG -> 60 C; otherwise 75 C.
  assert.equal(L.defaultTerminalTemp("NEC", 90, "4")[0], 60);
  assert.equal(L.defaultTerminalTemp("NEC", 400, "500")[0], 75);
  assert.equal(L.defaultTerminalTemp("CEC", 400, "1")[0], 60);
});

test("lugs: quantities and pad capacity", () => {
  let r = L.selectLugs(L.lugInput({ size: "500", sets_per_phase: 4, circuit_current_a: 1600, neutral: true, ground_size: "3/0", pad_positions: 2 }));
  assert.equal(r.total_lugs, 3 * 4 + 4 + 4);
  assert.equal(r.passed, true);
  r = L.selectLugs(L.lugInput({ size: "750", sets_per_phase: 6, circuit_current_a: 4000, pad_positions: 2 }));
  assert.equal(r.passed, false);
});

test("lugs: style by size and termination", () => {
  const big = L.selectLugs(L.lugInput({ size: "250", circuit_current_a: 255 })).lines[0];
  const small = L.selectLugs(L.lugInput({ size: "6", circuit_current_a: 65 })).lines[0];
  const brk = L.selectLugs(L.lugInput({ size: "250", circuit_current_a: 255, termination: "breaker" })).lines[0];
  assert.ok(big.style.includes("2-hole"));
  assert.equal(big.hole_spacing_in, "1-3/4");
  assert.ok(small.style.includes("1-hole"));
  assert.ok(brk.style.includes("mechanical"));
});

test("feeder includes lug schedule", () => {
  const r = S.sizeFeeder(S.feederInput({ voltage_v: 480, continuous_a: 400, length_m: 30.48 }));
  assert.equal(r.lugs.lines[0].quantity, 3 * r.recommended.sets);
});

test("sizeFeeder does not mutate its input and reports considered options", () => {
  const inp = S.feederInput({ continuous_a: 400, length_m: 30.48 });
  const r = S.sizeFeeder(inp);
  assert.equal(inp.terminal_temp_c, null);
  // The terminal default is now chosen per candidate size and reported in each option's notes; it is no
  // longer written back to the input (pecalc feeder review).
  assert.equal(r.input.terminal_temp_c, null);
  assert.ok(r.recommended.notes.some((n) => n.startsWith("Terminal temperature 75 C by default")));
  assert.ok(r.considered.length >= r.alternatives.length + 1);
});
