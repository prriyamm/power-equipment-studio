// Tests for the cable bus port (cablebus, cablebus_design, drawing).
//
// Part 1 replays tests/golden/cablebus.json, vectors generated from the Python pecalc package by
// scripts/gen_golden_cablebus.py, through the JS port. Part 2 ports the cable bus, enclosure and
// designer tests of calculations/tests/test_engine.py with their reference comments.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import * as cb from "../src/engine/pecalc/cablebus.js";
import * as ds from "../src/engine/pecalc/cablebus_design.js";
import { cablebusSvg } from "../src/engine/pecalc/drawing.js";
import * as cond from "../src/engine/pecalc/conductors.js";
import * as thm from "../src/engine/pecalc/thermal.js";

const G = JSON.parse(readFileSync(new URL("./golden/cablebus.json", import.meta.url), "utf8"));

const REL = 1e-9;       // direct calculations
const REL_ITER = 1e-6;  // IEC 60287 surface-temperature iteration (calculated ampacity)
const num = (v) => (v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v === "NaN" ? NaN : v);

function close(a, b, rel, path) {
  b = num(b);
  if (typeof b === "number") {
    assert.equal(typeof a, "number", `${path}: expected a number, got ${a}`);
    if (!isFinite(b) || Number.isNaN(b)) return assert.ok(Object.is(a, b), `${path}: ${a} vs ${b}`);
    assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-12) + 1e-12,
      `${path}: JS ${a} vs Python ${b}`);
  } else if (Array.isArray(b)) {
    assert.ok(Array.isArray(a), `${path}: expected an array`);
    assert.equal(a.length, b.length, `${path}: length`);
    b.forEach((x, i) => close(a[i], x, rel, `${path}[${i}]`));
  } else if (b && typeof b === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(b)) close(a[k], b[k], rel, `${path}.${k}`);
  } else {
    assert.equal(a, b, path);
  }
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const usesIteration = (inputs) => inputs.insulation_mm != null || inputs.ampacity_method === "calculated";

function checkAnalyse(v, i) {
  const label = `vector ${i} ${JSON.stringify(v.inputs)}`;
  const run = () => cb.analyse(cb.cableBusInput(v.inputs));
  if (v.error !== undefined) {
    assert.throws(run, (e) => e instanceof Error && e.message === v.error, `${label}: expected error "${v.error}"`);
    return;
  }
  let inp = cb.cableBusInput(v.inputs);
  let r = cb.analyse(inp);
  const rel = usesIteration(v.inputs) ? REL_ITER : REL;
  let expected = v.result;
  if (r.pattern !== expected.pattern) {
    // Mathematically tied phase patterns (mirror images) are ordered by floating-point noise, which differs
    // between Python and JS. Accept only a genuine tie, then continue with the pattern Python picked.
    const tie = (list, p) => list.find((c) => c.pattern === p);
    const a = tie(r.patterns_compared, expected.pattern), b = tie(r.patterns_compared, r.pattern);
    assert.ok(a && b && a.max_share_pct === b.max_share_pct && Math.abs(a.loss_w_per_m - b.loss_w_per_m) < 0.011,
      `${label}: pattern ${r.pattern} vs Python ${expected.pattern} is not a tie`);
    inp = cb.cableBusInput({ ...v.inputs, pattern: expected.pattern });
    const forced = cb.analyse(inp);
    const sortP = (l) => [...l].sort((x, y) => (x.pattern < y.pattern ? -1 : 1));
    close(sortP(r.patterns_compared), sortP(expected.patterns_compared), 1e-2, `${label}.patterns_compared`);
    forced.patterns_compared = expected.patterns_compared;
    forced.input = { ...forced.input, pattern: "auto" };
    r = forced;
  }
  close(r, expected, rel, label);
  if (v.svg_sha256) {
    const svg = cablebusSvg(inp, r);
    assert.equal(svg.length, v.svg_len, `${label}: svg length`);
    if (v.svg !== undefined) assert.equal(svg, v.svg, `${label}: svg text`);
    // The hash is only exact when the rounded values did not flip; the lengths and the full examples guard that.
    assert.equal(sha(svg), v.svg_sha256, `${label}: svg hash`);
  }
}

test(`golden: ${G.vectors.length} Python analyse vectors match field by field`, () => {
  G.vectors.forEach(checkAnalyse);
});

test("golden: shipped 15 kV 2000 A example matches", () => {
  checkAnalyse(G.example, "example");
  assert.ok(G.example.svg);
});

test("golden: vector set covers the required ranges", () => {
  const ok = G.vectors.filter((v) => v.result);
  const volts = ok.map((v) => v.inputs.voltage_v ?? 600);
  assert.ok(Math.min(...volts) <= 600 && Math.max(...volts) >= 34500);
  const amps = ok.map((v) => v.inputs.current_a ?? 2000);
  assert.ok(Math.min(...amps) <= 600 && Math.max(...amps) >= 5000);
  assert.ok(ok.some((v) => v.inputs.material === "Al") && ok.some((v) => (v.inputs.material ?? "Cu") === "Cu"));
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(ok.some((v) => v.inputs.conductors_per_phase === n), `${n} per phase`);
  for (const t of [1, 2, 3]) assert.ok(ok.some((v) => (v.inputs.tiers ?? 1) === t), `${t} tiers`);
  const methods = new Set(ok.map((v) => v.result.input.ampacity_method));
  for (const m of ["auto", "table", "datasheet", "calculated"]) assert.ok(methods.has(m), `method ${m}`);
  for (const b of ["none", "single_point", "both_ends"]) {
    assert.ok(ok.some((v) => v.result.input.shield_bonding === b), `bonding ${b}`);
  }
  assert.ok(ok.some((v) => v.result.fault_force_n_per_m !== null) && ok.some((v) => v.result.enclosure_loss_w > 0));
  assert.ok(G.vectors.some((v) => v.error), "expected-error vectors present");
});

test(`golden: candidate_patterns (${G.patterns.length} cases)`, () => {
  for (const p of G.patterns) {
    if (p.error) assert.throws(() => cb.candidatePatterns(p.n, p.tiers), (e) => e.message === p.error);
    else assert.deepEqual(cb.candidatePatterns(p.n, p.tiers), p.patterns, `n=${p.n} tiers=${p.tiers}`);
  }
});

test(`golden: ${G.designs.length} design_options runs match`, () => {
  G.designs.forEach((d, i) => {
    const label = `design ${i} ${JSON.stringify(d.request)}`;
    const run = () => ds.designOptions(ds.designRequest(d.request));
    if (d.error !== undefined) {
      assert.throws(run, (e) => e instanceof Error && e.message === d.error, `${label}: expected error "${d.error}"`);
      return;
    }
    close(run(), d.result, d.request.voltage_v > 2000 ? REL_ITER : REL, label);
  });
  assert.ok(G.designs.some((d) => d.result && d.result.options.some((o) => o.block_stress_mpa !== null)));
});

// ------------------------------------------------------------ ported Python tests (test_engine.py)

const LVBUS = (o) => cb.cableBusInput(o);

test("CableBus: patterns generated", () => {
  assert.ok(cb.candidatePatterns(2, 1).includes("ABCCBA"));
  assert.throws(() => cb.candidatePatterns(2, 4));
});

test("CableBus: reference concept 4000 A, 600 V, 6 x 750 kcmil Cu per phase", () => {
  const r = cb.analyse(LVBUS({ voltage_v: 600, current_a: 4000, conductors_per_phase: 6, tiers: 2, size: "750" }));
  assert.equal(r.passed, true);
  // Unequal sharing makes the worst conductor carry more than the 666.7 A equal share.
  assert.ok(Math.max(...r.conductors.map((c) => c.current_a)) > 4000 / 6);
});

test("CableBus: MV requires datasheet inputs", () => {
  assert.throws(() => cb.analyse(LVBUS({ voltage_v: 15000, current_a: 2000, conductors_per_phase: 2 })));
});

test("CableBus: bonding both ends adds shield loss", () => {
  const base = { voltage_v: 15000, current_a: 2000, conductors_per_phase: 3, size: "750", cable_od_mm: 45,
    cable_ampacity_a: 900, shield_area_mm2: 16, shield_mean_diameter_mm: 38 };
  const single = cb.analyse(LVBUS({ ...base, shield_bonding: "single_point" }));
  const both = cb.analyse(LVBUS({ ...base, shield_bonding: "both_ends" }));
  assert.equal(single.shield_loss_w, 0);
  assert.ok(both.shield_loss_w > 0);
  assert.ok(both.shield_current_a > 0);
});

test("CableBusCalculatedMV: two per phase fails, three passes", () => {
  const BASE = { voltage_v: 15000, current_a: 2000, size: "750", insulation: "EPR", insulation_mm: 7.2,
    shield_mm: 0.13, jacket_mm: 2.0, length_m: 60 };
  const two = cb.analyse(LVBUS({ ...BASE, conductors_per_phase: 2, shield_bonding: "single_point" }));
  const three = cb.analyse(LVBUS({ ...BASE, conductors_per_phase: 3, shield_bonding: "single_point" }));
  assert.equal(two.passed, false);
  assert.equal(three.passed, true);
});

test("CableBusCalculatedMV: both-ends bonding derates each cable", () => {
  const BASE = { voltage_v: 15000, current_a: 2000, size: "750", insulation: "EPR", insulation_mm: 7.2,
    shield_mm: 0.13, jacket_mm: 2.0, length_m: 60, conductors_per_phase: 3 };
  const sp = cb.analyse(LVBUS({ ...BASE, shield_bonding: "single_point" }));
  const be = cb.analyse(LVBUS({ ...BASE, shield_bonding: "both_ends" }));
  assert.ok(Math.min(...be.conductors.map((c) => c.ampacity_a)) < Math.min(...sp.conductors.map((c) => c.ampacity_a)));
  assert.ok(be.max_loading_pct > sp.max_loading_pct);
});

test("CalculatedAmpacity: LV calculated is 10-35 % above the NEC free-air table at 30 C (IEC 60287 vs NEC 310.17)", async () => {
  const amp = await import("../src/engine/pecalc/ampacity.js");
  for (const size of ["1/0", "4/0", "500", "750", "1000"]) {
    const c = thm.cableConstruction(size, { insulation: "XHHW", insulation_mm: cond.insulationMm(size) });
    const calc = thm.freeAirAmpacity(c, 30).ampacity_a;
    const table = amp.tableAmpacity("NEC", "free_air", "Cu", size, 90);
    assert.ok(calc / table >= 1.10 && calc / table <= 1.35, `${size}: ${calc / table}`);
  }
});

test("Enclosure: carries induced current and loss; loss below 20 % of conductor loss", () => {
  const BASE = { voltage_v: 600, current_a: 4000, conductors_per_phase: 6, tiers: 2, size: "750", length_m: 61 };
  const r = cb.analyse(LVBUS({ ...BASE, enclosure_width_mm: 560, enclosure_height_mm: 200 }));
  assert.ok(r.enclosure_loss_w > 0);
  assert.ok(r.enclosure_current_a > 0);
  assert.ok(r.enclosure_loss_w < 0.2 * r.conductor_loss_w);
});

test("Enclosure: too small is rejected", () => {
  const BASE = { voltage_v: 600, current_a: 4000, conductors_per_phase: 6, tiers: 2, size: "750", length_m: 61 };
  assert.throws(() => cb.analyse(LVBUS({ ...BASE, enclosure_width_mm: 200, enclosure_height_mm: 200 })),
    /smaller than the conductor group/);
});

test("Enclosure: no enclosure reports zero", () => {
  const BASE = { voltage_v: 600, current_a: 4000, conductors_per_phase: 6, tiers: 2, size: "750", length_m: 61 };
  const r = cb.analyse(LVBUS(BASE));
  assert.equal(r.enclosure_loss_w, 0);
  assert.ok("side 1 m" in r.field_ut);
});

test("CableBusDesigner: LV options pass and fit enclosures", () => {
  const r = ds.designOptions(ds.designRequest({ voltage_v: 600, current_a: 4000 }));
  const passing = r.options.filter((o) => o.passed);
  assert.ok(passing.length >= 3);
  for (const o of passing) {
    assert.ok(o.max_loading_pct <= 95.0);
    const per_tier = (3 * o.per_phase) / o.tiers;
    const needed_w = (per_tier - 1) * 2 * o.cable_od_mm + o.cable_od_mm + 2 * 25;
    assert.ok(o.inside_w_mm + 2.0 >= needed_w); // OD is reported rounded
  }
  const tags = new Set(r.options.flatMap((o) => o.tags));
  for (const t of ["least copper", "smallest enclosure", "most margin"]) assert.ok(tags.has(t), t);
});

test("CableBusDesigner: more tiers gives a narrower enclosure", () => {
  const r = ds.designOptions(ds.designRequest({ voltage_v: 600, current_a: 4000, sizes: ["500"], top_n: 20 }));
  const widths = {};
  for (const o of r.options) (widths[o.per_phase] ??= {})[o.tiers] = o.inside_w_mm;
  const pairs = [];
  for (const w of Object.values(widths)) {
    const stacked = Object.keys(w).map(Number).filter((t) => t > 1);
    if (1 in w && Object.keys(w).length > 1) pairs.push([w[1], w[Math.max(...stacked)]]);
  }
  assert.ok(pairs.length, "expected a design available in 1 tier and in 2 or 3 tiers");
  for (const [one, stacked] of pairs) assert.ok(stacked < one);
});

test("CableBusDesigner: MV needs construction and checks blocks", () => {
  assert.throws(() => ds.designOptions(ds.designRequest({ voltage_v: 15000, current_a: 2000 })));
  const r = ds.designOptions(ds.designRequest({ voltage_v: 15000, current_a: 2000, insulation: "EPR",
    insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2.0, fault_ka: 40 }));
  assert.ok(r.options.some((o) => o.passed));
  assert.ok(r.options.every((o) => o.block_stress_mpa !== null));
});

test("CableBusDesigner: a tested block rating can fail a design", () => {
  const r = ds.designOptions(ds.designRequest({ voltage_v: 600, current_a: 4000, fault_ka: 100, x_over_r: 30,
    block_rated_load_n: 500 }));
  assert.ok(r.options.some((o) => o.failed_checks.join(" ").includes("rated")));
});

test("drawing: SVG has 12 cables + 3 legend dots and the block material", () => {
  const inp = LVBUS({ voltage_v: 600, current_a: 3000, conductors_per_phase: 4, tiers: 2, size: "750",
    enclosure_width_mm: 457.2, enclosure_height_mm: 203.2 });
  const svg = cablebusSvg(inp, cb.analyse(inp));
  assert.ok(svg.startsWith("<svg"));
  assert.equal(svg.split("<circle").length - 1 - 3, 12);
  assert.ok(svg.includes("GPO-3"));
});
