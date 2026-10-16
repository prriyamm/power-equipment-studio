import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as T from "../src/engine/pecalc/transformer.js";

const G = JSON.parse(readFileSync(new URL("./golden/transformer.json", import.meta.url), "utf8"));

const REL = 1e-9;       // closed-form designs
const REL_ITER = 1e-6;  // design_for_impedance (bisection)
const num = (v) => (v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v === "NaN" ? NaN : v);

function close(a, b, rel, path) {
  b = num(b);
  if (typeof b === "number") {
    assert.equal(typeof a, "number", `${path}: expected a number, got ${a}`);
    if (!isFinite(b) || Number.isNaN(b)) return assert.ok(Object.is(a, b), `${path}: ${a} vs ${b}`);
    assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-12) + 1e-12,
      `${path}: JS ${a} vs Python ${b}`);
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
  const inp = T.transformerInput(v.inputs);
  return v.kind === "tuned" ? T.design_for_impedance(inp) : T.design(inp);
}

// Fields whose 3-decimal/1-decimal rounding can legitimately flip by one unit in the last digit when the
// unrounded value sits on a rounding boundary: not expected here, so every field is compared strictly.
function checkVector(v, i) {
  const label = `vector ${i} (${v.kind} ${JSON.stringify(v.inputs)})`;
  if (v.error !== undefined) {
    assert.throws(() => runVector(v), (e) => e instanceof Error && e.message === v.error, `${label}: expected error "${v.error}"`);
    return;
  }
  const rel = v.kind === "tuned" ? REL_ITER : REL;
  close(runVector(v), v.result, rel, label);
}

test(`golden: ${G.vectors.length} Python vectors match field by field`, () => {
  G.vectors.forEach(checkVector);
});

test("golden: shipped 1500 kVA example (impedance tuned) matches", () => {
  checkVector(G.example, "example");
  assert.equal(G.example.kind, "tuned");
});

test("golden: vector set covers the required ranges", () => {
  const ok = G.vectors.filter((v) => v.result);
  const kvas = new Set(ok.map((v) => v.inputs.kva));
  assert.ok(Math.min(...kvas) <= 75 && Math.max(...kvas) >= 10000);
  for (const hv of [4160, 13800, 25000, 34500]) assert.ok(ok.some((v) => v.inputs.hv_v === hv), `HV ${hv}`);
  for (const lv of [208, 480, 600, 4160]) assert.ok(ok.some((v) => v.inputs.lv_v === lv), `LV ${lv}`);
  assert.ok(ok.some((v) => v.inputs.conductor === "Al") && ok.some((v) => v.inputs.kind === "dry"));
  assert.ok(ok.some((v) => v.inputs.doe_min_efficiency_pct) && ok.some((v) => v.kind === "tuned"));
});

test(`golden: ${G.doe_direct.length} direct DOE 10 CFR 431.196 checks match Python`, () => {
  G.doe_direct.forEach((v, i) => {
    const call = () => T.doe_efficiency_check(...v.args, v.kwargs);
    const label = `doe_direct ${i} ${JSON.stringify(v.args)} ${JSON.stringify(v.kwargs)}`;
    if (v.error !== undefined) assert.throws(call, (e) => e.message === v.error, `${label}: expected "${v.error}"`);
    else close(call(), v.result, REL, label);
  });
});

test("golden: DOE vectors cover every status, category and window", () => {
  const docs = G.vectors.filter((v) => v.result).map((v) => v.result.doe).concat(G.doe_direct.filter((v) => v.result).map((v) => v.result));
  for (const st of ["pass", "fail", "not_in_table", "needs_input", "not_covered"]) assert.ok(docs.some((d) => d.status === st), st);
  for (const id of ["(a)(1)", "(a)(2)", "(a)(3)", "(b)(1)", "(b)(2)", "(b)(3)", "(b)(4)", "(c)(1)", "(c)(2)", "(c)(3)"]) {
    assert.ok(docs.some((d) => d.window && d.window.id === id), id);
  }
});

test("golden: helper functions match Python", () => {
  for (const [h, w, kr] of G.helpers.rogowski) close(T.rogowski_factor(h, w), kr, REL, `rogowski(${h},${w})`);
  for (const [b, wkg] of G.helpers.core_loss) close(T.specific_core_loss(b), wkg, REL, `core_loss(${b})`);
  for (const [k, g, std] of G.helpers.next_standard_kva) assert.equal(T.next_standard_kva(k, g), std);
  const [k, msg] = G.helpers.next_standard_kva_error;
  assert.throws(() => T.next_standard_kva(k), { message: msg });
});

/* ---- ported from calculations/tests/test_engine.py (class Transformer) ---- */
const R = (kw) => T.design(T.transformerInput(kw));
const near = (a, b, delta, msg) => assert.ok(Math.abs(a - b) <= delta, `${msg ?? ""} ${a} vs ${b} (delta ${delta})`);

test("EMF equation and turns ratio", () => {
  const d = R({ kva: 1500, hv_v: 13800, lv_v: 480 }).design;
  // E = 4.44 f N Bm Ai
  const et = 4.44 * 60 * d.b_max_t * d.core_area_net_cm2 / 1e4;
  near(et / d.volts_per_turn, 1, 0.005);
  // Delta HV / wye LV phase-voltage ratio within one turn
  const ratio = 13800 / (480 / Math.sqrt(3));
  assert.ok(Math.abs(d.turns_hv - d.turns_lv * ratio) <= 1);
});

test("Rogowski factor", () => {
  near(T.rogowski_factor(10, 1), 1 - 1 / (10 * Math.PI), 5e-7);
  assert.ok(T.rogowski_factor(1, 1) < T.rogowski_factor(5, 1));
});

test("efficiency and fault current identities", () => {
  const r = R({ kva: 1500, hv_v: 13800, lv_v: 480, power_factor: 1.0 });
  const nll = r.losses.no_load_w, ll = r.losses.load_loss_w;
  near(r.performance.efficiency_pct["100%"], 1.5e6 / (1.5e6 + nll + ll) * 100, 0.005);
  near(r.performance.max_efficiency_load_pct, Math.sqrt(nll / ll) * 100, 0.1);
  const i_fl = 1.5e6 / (Math.sqrt(3) * 480);
  near(r.short_circuit.lv_fault_ka_rms, i_fl / (r.impedance.z_pct / 100) / 1000, 0.05);
});

test("typical 1500 kVA liquid losses in industry range", () => {
  // Typical 1500 kVA, 15 kV class liquid-filled distribution transformer (industry practice,
  // UNVERIFIED band): no-load 1-3 kW, load loss 8-20 kW, %Z 4-7.
  const r = R({ kva: 1500, hv_v: 13800, lv_v: 480 });
  assert.ok(r.losses.no_load_w >= 1000 && r.losses.no_load_w <= 3000);
  assert.ok(r.losses.load_loss_w >= 8000 && r.losses.load_loss_w <= 20000);
  assert.ok(r.impedance.z_pct >= 4 && r.impedance.z_pct <= 7);
});

test("impedance tuning hits target", () => {
  const r = T.design_for_impedance(T.transformerInput({ kva: 1500, hv_v: 13800, lv_v: 480, target_z_pct: 5.75 }));
  near(r.impedance.z_pct, 5.75, 0.05);
  assert.match(r.notes[0], /^Window height\/width ratio tuned to /);
});

test("standard kVA selection", () => {
  assert.equal(T.next_standard_kva(1180, 1.25), 1500);
  assert.equal(T.next_standard_kva(300), 300);
  assert.throws(() => T.next_standard_kva(20000), /exceeds the standard list/);
});

test("error messages match the Python module", () => {
  assert.throws(() => R({ kind: "x" }), { message: "kind must be liquid or dry" });
  assert.throws(() => R({ conductor: "Fe" }), { message: "conductor must be Cu or Al" });
  assert.throws(() => T.design_for_impedance(T.transformerInput()), { message: "target_z_pct is required to tune impedance" });
  assert.throws(() => T.transformerInput({ nope: 1 }), TypeError);
});

/* ---- DOE 10 CFR 431.196 hand checks (ported from calculations/tests/test_doe.py) ----
   eta = L S / (L S + P0 + L^2 Pk) x 100, unity pf output basis (App. A 5.1-5.3), compared with the table minimum. */
const eta = (kva, L, p0, pk) => (L * kva * 1000) / (L * kva * 1000 + p0 + L * L * pk) * 100;

test("DOE hand check: liquid 3-ph 1000 kVA (Table 5 99.43 %)", () => {
  // 500,000 / (500,000 + 1000 + 0.25 x 8000) = 99.40358 % -> fail by 0.0264
  const e = eta(1000, 0.5, 1000, 8000);
  near(e, 99.40358, 1e-4);
  const r = T.doe_efficiency_check("liquid", 3, 1000, null, e, "2020-06-01");
  assert.equal(r.required_pct, 99.43);
  assert.equal(r.status, "fail");
  near(r.margin_pct, -0.02642, 1e-4);
});

test("DOE hand check: LV dry 3-ph 75 kVA at 35 % (Table 2 98.60 %, (a)(1) 98.0 %)", () => {
  // 26,250 / (26,250 + 250 + 0.1225 x 2000) = 98.14919 %
  const e = eta(75, 0.35, 250, 2000);
  near(e, 98.14919, 1e-4);
  assert.equal(T.doe_efficiency_check("lv_dry", 3, 75, null, e, "2020-01-01").status, "fail");
  assert.equal(T.doe_efficiency_check("lv_dry", 3, 75, null, e, "2012-01-01").status, "pass");
});

test("DOE hand check: MV dry 3-ph 1000 kVA BIL 95 kV (Table 10 99.28 %)", () => {
  // 500,000 / (500,000 + 1500 + 0.25 x 7000) = 99.35420 %
  const e = eta(1000, 0.5, 1500, 7000);
  near(e, 99.3542, 1e-4);
  const r = T.doe_efficiency_check("mv_dry", 3, 1000, 95, e, "2029-04-23");
  assert.deepEqual([r.window.id, r.bil_band, r.required_pct, r.status], ["(c)(3)", "46-95 kV", 99.28, "pass"]);
});

test("DOE interpolation and not-in-table", () => {
  // Table 6: 300 kVA 99.42, 500 kVA 99.38 -> 400 kVA 99.40 (the law's step, interpolated as written)
  near(T.doe_efficiency_check("liquid", 3, 400, null, 99.5, "2029-04-23").required_pct, 99.40, 1e-9);
  const r = T.doe_efficiency_check("lv_dry", 3, 1500, null, 99.5, "2020-01-01");
  assert.equal(r.status, "not_in_table");
  assert.deepEqual(r.nearest_rows, [[1000, 99.28]]);
});

test("DOE check is in the design checks with the design's own losses", () => {
  const r = R({ kva: 1500, hv_v: 13800, lv_v: 480, doe_date: "2020-01-01" });
  const c = r.checks.find((x) => x.name === T.DOE_CHECK_NAME);
  near(c.value, eta(1500, 0.5, r.doe.losses.no_load_w, r.doe.losses.load_loss_w), 5e-4);
  assert.equal(c.limit, 99.48);
});
