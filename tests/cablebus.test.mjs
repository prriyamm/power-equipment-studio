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
  if (r.patterns_compared.some((c, k) => c.pattern !== expected.patterns_compared[k]?.pattern)) {
    // Mirror-image Figure 3 arrangements (e.g. ABC/CAB and ABC/BCA) tie exactly, so their order in the list is
    // floating-point noise too. Same set, and the JS order must still follow the ranking key.
    const sortP = (l) => [...l].sort((x, y) => (x.pattern < y.pattern ? -1 : 1));
    close(sortP(r.patterns_compared), sortP(expected.patterns_compared), 1e-2, `${label}.patterns_compared`);
    r.patterns_compared.slice(1).forEach((c, k) => {
      const p = r.patterns_compared[k];
      assert.ok(p.max_share_pct < c.max_share_pct || (p.max_share_pct === c.max_share_pct &&
        p.loss_w_per_m <= c.loss_w_per_m + 0.011), `${label}: patterns_compared out of order at ${k + 1}`);
    });
    r = { ...r, patterns_compared: expected.patterns_compared };
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
  for (const t of [1, 2, 3, 4]) assert.ok(ok.some((v) => v.result.input.tiers === t), `${t} tiers`);
  assert.ok(ok.some((v) => (v.result.pattern ?? "").includes("+")), "staggered tiers");
  const methods = new Set(ok.map((v) => v.result.input.ampacity_method));
  for (const m of ["auto", "table", "datasheet", "calculated"]) assert.ok(methods.has(m), `method ${m}`);
  for (const b of ["none", "single_point", "both_ends"]) {
    assert.ok(ok.some((v) => v.result.input.shield_bonding === b), `bonding ${b}`);
  }
  assert.ok(ok.some((v) => v.result.fault_force_n_per_m !== null) && ok.some((v) => v.result.enclosure_loss_w > 0));
  assert.ok(G.vectors.some((v) => v.error), "expected-error vectors present");
});

test(`golden: datasheet_shield_derating (${G.datasheet_shield_derating.length} cases, pecalc #9)`, () => {
  for (const d of G.datasheet_shield_derating) {
    const run = () => cb.datasheetShieldDerating(d.lambda1, d.lambda1_ref);
    if (d.error) assert.throws(run, (e) => e.message === d.error);
    else close(run(), d.factor, REL, `derating(${d.lambda1}, ${d.lambda1_ref})`);
  }
});

test(`golden: candidate_patterns (${G.patterns.length} cases)`, () => {
  for (const p of G.patterns) {
    if (p.error) assert.throws(() => cb.candidatePatterns(p.n, p.tiers), (e) => e.message === p.error);
    else assert.deepEqual(cb.candidatePatterns(p.n, p.tiers), p.patterns, `n=${p.n} tiers=${p.tiers}`);
  }
});

test(`golden: figure3_match and pattern_positions (${G.figure3.length} cases)`, () => {
  for (const f of G.figure3) {
    if (f.error) {
      assert.throws(() => cb.figure3Match(f.pattern, f.n), (e) => e.message === f.error);
      continue;
    }
    assert.equal(cb.figure3Match(f.pattern, f.n), f.match, `${f.pattern} n=${f.n}`);
    close(cb.patternPositions(f.pattern), f.positions, REL, `positions ${f.pattern}`);
  }
  // Every Figure 3 arrangement identifies as itself or an earlier, equivalent one.
  assert.ok(G.figure3.filter((f) => f.match).length >= 37);
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

test("CableBus: auto patterns are CSA 273 Figure 3", () => {
  assert.deepEqual(cb.candidatePatterns(2), ["ABC/CAB", "ABC/BCA", "ABC/CBA"]);
  assert.deepEqual(cb.candidatePatterns(3, 3), ["ACA/BBB/CAC", "+ABC/BCA./+ABC"]);
  assert.deepEqual(cb.candidatePatterns(1, 1), ["ABC"]);
  assert.throws(() => cb.candidatePatterns(2, 1), /no arrangement of 2 conductors per phase in 1 tier/);
  assert.throws(() => cb.candidatePatterns(11), /covers 1 to 10 conductors per phase/);
});

test("CableBus: Figure 3 data and matching", () => {
  for (let n = 1; n <= 10; n++) {
    const pats = cb.figure3Patterns(n);
    assert.ok(pats.length >= 2);
    for (const p of pats) {
      assert.ok(p.split("/").length <= 3, p);          // Clause 4.12.2: 3 layers maximum
      for (const ph of "ABC") assert.equal(cb.patternPositions(p).filter((q) => q[2] === ph).length, n, p);
      assert.ok(cb.figure3Match(p, n), p);
    }
  }
  assert.equal(cb.figure3Match("ABC/BCA", 2), "2-1");     // the figure lists both: mirrored and renamed
  assert.equal(cb.figure3Match("BCA", 1), "1-1");
  assert.equal(cb.figure3Match(".CABC/BACBA", 3), "3-3"); // mirror image of CBAC./ABCAB
  assert.equal(cb.figure3Match("ABCCBA", 2), null);
  assert.deepEqual(cb.patternPositions("+A/BC"), [[0.5, 0, "A", 0], [0, 1, "B", 0], [1, 1, "C", 1]]);
  assert.throws(() => cb.patternPositions("AB+C"), /optional leading/);
});

test("CableBus: a pattern outside Figure 3 fails the arrangement check; auto skips what does not fit", () => {
  const r = cb.analyse(LVBUS({ voltage_v: 600, current_a: 2000, conductors_per_phase: 4, size: "750",
    pattern: "ABC/ABC/ABC/ABC", enclosure_width_mm: 500, enclosure_height_mm: 500 }));
  const c = r.checks.find((k) => k.name.startsWith("Phase arrangement"));
  assert.equal(c.passed, false);
  assert.match(c.note, /4\.12\.4/);
  assert.equal(r.input.tiers, 4);
  const fit = cb.analyse(LVBUS({ voltage_v: 600, current_a: 3000, conductors_per_phase: 4, size: "750",
    enclosure_width_mm: 800, enclosure_height_mm: 120 }));
  assert.equal(fit.input.tiers, 2);
  assert.ok(fit.checks.find((k) => k.name.startsWith("Phase arrangement")).passed);
});

test("CableBus: reference concept 4000 A, 600 V, 6 x 750 kcmil Cu per phase", () => {
  const r = cb.analyse(LVBUS({ voltage_v: 600, current_a: 4000, conductors_per_phase: 6, tiers: 2, size: "750" }));
  // Changed by the pecalc cable bus review: the termination check now uses NEC Table 310.16 (raceway) at the
  // derived 75 C rating (475 A for 750 kcmil Cu), not the free-air table, so the 724 A worst conductor fails it.
  // Every other check (free-air ampacity, spacing, voltage drop) still passes.
  assert.deepEqual(r.checks.filter((c) => !c.passed).map((c) => c.name),
    ["Most heavily loaded conductor within termination rating"]);
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
    assert.ok(cb.figure3Match(o.pattern, o.per_phase), o.pattern);
    const span = Math.max(...cb.patternPositions(o.pattern).map((q) => q[0]));
    const needed_w = span * 2 * o.cable_od_mm + o.cable_od_mm + 2 * 25;
    assert.ok(o.inside_w_mm + 2.0 >= needed_w); // OD is reported rounded
  }
  const tags = new Set(r.options.flatMap((o) => o.tags));
  for (const t of ["least copper", "smallest enclosure", "most margin"]) assert.ok(tags.has(t), t);
});

test("CableBusDesigner: more tiers gives a narrower enclosure", () => {
  // 2000 A (was 4000 A): with the termination limit now taken from Table 310.16 (380 A per 500 kcmil conductor
  // at 75 C), 4000 A needs 11+ per phase, beyond Figure 3.
  const r = ds.designOptions(ds.designRequest({ voltage_v: 600, current_a: 2000, sizes: ["500"], top_n: 20 }));
  const widths = {};
  for (const o of r.options) (widths[o.per_phase] ??= {})[o.tiers] = o.inside_w_mm;
  const pairs = Object.values(widths).filter((w) => 2 in w && 3 in w);
  assert.ok(pairs.length, "expected a design available in 2 and in 3 tiers");
  for (const w of pairs) assert.ok(w[3] < w[2]);
});

test("CableBusDesigner: only Figure 3 tier counts; beyond 10 per phase the size is skipped", () => {
  const r = ds.designOptions(ds.designRequest({ voltage_v: 600, current_a: 4000, top_n: 30 }));
  assert.ok(r.options.length && r.options.every((o) => o.tiers === 2 || o.tiers === 3));
  const r3 = ds.designOptions(ds.designRequest({ voltage_v: 600, current_a: 4500, sizes: ["500"] }));
  assert.ok(r3.notes.some((n) => n.includes("Figure 3 covers 1 to 10")));
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

test("short-circuit withstand (pecalc #12): ICEA P-32-382 hand check, skipped without clearing time", () => {
  // A = 3 x 750 000 = 2 250 000 cmil; Cu: K = 0.0297, T0 = 234; 90 -> 250 C; t = 0.5 s.
  // 484 / 324 = 1.493827; log10 = 0.174300; 0.0297 x 0.174300 / 0.5 = 0.0103534; sqrt = 0.101752
  // I = 2 250 000 x 0.101752 = 228 942 A = 228.94 kA.
  const sc = (r) => r.checks.filter((c) => c.name === "Conductor short-circuit withstand");
  const [c] = sc(cb.analyse(cb.cableBusInput({ fault_ka: 50, fault_clearing_s: 0.5 })));
  assert.equal(c.clause, "ICEA P-32-382");
  assert.equal(c.value, 228.94);
  assert.ok(c.passed);
  // 1 x 4/0 Cu (211 600 cmil), 1 s: 211 600 x sqrt(0.0051767) = 15.22 kA < 20 kA.
  const r = cb.analyse(cb.cableBusInput({ size: "4/0", conductors_per_phase: 1, current_a: 300, fault_ka: 20,
    fault_clearing_s: 1.0 }));
  assert.equal(sc(r)[0].value, 15.22);
  assert.equal(r.passed, false);
  const skipped = cb.analyse(cb.cableBusInput({ fault_ka: 50 }));
  assert.equal(sc(skipped).length, 0);
  assert.ok(skipped.notes.includes("Conductor short-circuit withstand not checked: give fault_clearing_s."));
  assert.throws(() => cb.analyse(cb.cableBusInput({ fault_ka: 50, fault_clearing_s: 0 })),
    /fault_clearing_s must be greater than 0 s/);
});

test("drawing (Check tab path): one support block per tier and a tier-pitch dimension per tier gap", () => {
  const blockRects = (svg) => svg.split("\n").filter((l) => l.startsWith("<rect") && l.includes("fill='#e9b9a1'") && l.includes("rx='3'"));
  // Figure 3: one tier only for 1 per phase; 6 per phase in 2 or 3 tiers.
  for (const [n, tiers] of [[1, 1], [6, 2], [6, 3]]) {
    // enclosure sized as the Check form's auto-size does (src/ui/cablebus.jsx toInput)
    const base = { voltage_v: 600, current_a: 500 * n, conductors_per_phase: n, tiers, size: "750" };
    const r0 = cb.analyse(LVBUS(base)), od = r0.cable_od_mm, pitch = r0.pitch_mm;
    const span = Math.max(...cb.patternPositions(r0.pattern).map((q) => q[0]));
    const inp = LVBUS({ ...base, pattern: r0.pattern, enclosure_width_mm: Math.ceil((span * pitch + od + 50) / 10) * 10,
      enclosure_height_mm: Math.ceil(((tiers - 1) * pitch + od + 70) / 10) * 10 });
    const res = cb.analyse(inp);
    const plain = cablebusSvg(inp, res);
    const svg = cablebusSvg(inp, res, { tier_dims: true }); // as CrossSection / report figure call it
    const nTiers = new Set(res.conductors.map((c) => c.y_mm)).size;
    assert.equal(nTiers, tiers);
    assert.equal(blockRects(svg).length, tiers, `${tiers} tier(s): block rects`);
    assert.equal(blockRects(plain).length, tiers);
    assert.equal(svg.split("<circle").length - 1 - 3, 3 * n);
    const labels = [...svg.matchAll(/>(\d+) mm<\/text>/g)].map((m) => Number(m[1]));
    assert.equal((svg.match(/>tier pitch</g) || []).length, tiers - 1, `${tiers} tier(s): tier pitch labels`);
    assert.equal(labels.length, tiers - 1);
    for (const v of labels) assert.equal(v, Math.round(res.tier_pitch_mm));
    assert.ok(!plain.includes("tier pitch"));
    if (tiers === 1) assert.equal(svg, plain, "single tier: opt-in adds nothing");
    // each block is centred on its tier: block mid-height equals the cable centre line
    const cys = [...new Set([...svg.matchAll(/<circle cx='[\d.]+' cy='([\d.]+)' r='[\d.]+' fill='#(?:d64545|2f6fd6|2e9d5b)' stroke/g)].map((m) => m[1]))].map(Number).sort((a, b) => a - b);
    const mids = blockRects(svg).map((l) => { const y = Number(/ y='([\d.]+)'/.exec(l)[1]), h = Number(/ height='([\d.]+)'/.exec(l)[1]); return y + h / 2; }).sort((a, b) => a - b);
    mids.forEach((m, k) => assert.ok(Math.abs(m - cys[k]) < 0.2, `block ${k} centred on tier`));
  }
});

// Shield standing voltage with single-point bonding (port of calculations/tests/test_sheath.py).
// Flat ABC, 100 mm centres, shield mean radius 20 mm, 1000 A at unity pf, 60 Hz, 100 m.
// |E_B| = w 2e-7 I ln(s/r) = 7.539822e-5 x 1000 x ln 5 = 0.121349 V/m;
// |E_A| = 7.539822e-5 x |I_B ln(r/s) + I_C ln(r/2s)| = 7.539822e-5 x 2046.050 = 0.154269 V/m.
const SH = { voltage_v: 15000.0, current_a: 1000.0, power_factor: 1.0, conductors_per_phase: 1, pattern: "ABC",
  cable_od_mm: 40.0, spacing_mm: 100.0, cable_ampacity_a: 1200.0, shield_mean_diameter_mm: 40.0,
  shield_area_mm2: 16.0, length_m: 100.0 };
const runSh = (o) => cb.analyse(cb.cableBusInput({ ...SH, ...o }));

test("sheath: flat hand check, fault scaling, sections and limit", () => {
  const sh = runSh({ shield_bonding: "single_point" }).sheath;
  const e = Object.fromEntries(sh.shields.map((s) => [s.label, s.e_v_per_km]));
  assert.ok(Math.abs(e["S-A00"] - 154.269) < 0.002 && Math.abs(e["S-C02"] - 154.269) < 0.002);
  assert.ok(Math.abs(e["S-B01"] - 121.349) < 0.002);
  assert.equal(sh.standing_v, 15.43);
  assert.equal(sh.worst_shield, "S-A00");
  assert.equal(sh.passed, null);
  assert.equal(runSh({ shield_bonding: "single_point", fault_ka: 20.0 }).sheath.standing_v_fault, 308.54);
  const sec = runSh({ shield_bonding: "single_point", shield_section_length_m: 25.0 }).sheath;
  assert.equal(sec.standing_v, 3.86);
  assert.equal(sec.sections, 4);
  const fail = runSh({ shield_bonding: "single_point", shield_voltage_limit_v: 10.0 });
  assert.equal(fail.sheath.passed, false);
  assert.equal(fail.passed, false);
  assert.equal(fail.sheath.max_section_m_for_limit, 64.8);
  assert.throws(() => runSh({ shield_bonding: "single_point", shield_section_length_m: 150.0 }), /no longer than/);
});

test("sheath: both-ends results unchanged apart from the sheath field", () => {
  const o = { shield_bonding: "both_ends", fault_ka: 20.0 };
  const full = runSh(o);
  const bare = cb.analyse(cb.cableBusInput({ ...SH, ...o }), false);
  const strip = (r) => { const { sheath, ...rest } = r; return rest; };
  assert.deepEqual(strip(full), strip(bare));
  assert.equal(full.sheath.modes.both_ends.shield_loss_w, full.shield_loss_w);
  assert.equal(full.sheath.standing_v, 15.43);
  assert.ok(!full.checks.some((c) => /standing voltage/.test(c.name)));
  assert.equal(runSh({ shield_bonding: "none" }).sheath, null);
});
