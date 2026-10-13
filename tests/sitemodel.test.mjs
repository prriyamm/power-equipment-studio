import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { buildLineup } from "../src/engine/gear.js";
import { dims } from "../src/ui/systemGeometry.js";
import { buildSiteModel, lineupLayout, batchKeys, flowPath, midpoint, MAT_SPEC, GEOMETRIES, emitter } from "../src/ui/siteModel.js";

/* ~100-element package: utility, MV gear, then N transformer groups of 10 items each. */
function bigSystem(groups = 10) {
  const equipment = [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 1000, xr: 15, gx: 0, gy: 0 },
    { id: "MV", type: "switchgear", kv: 13.8, bus_a: 2000, sc_ka: 40, sections: 6, gx: 3, gy: 0 },
  ];
  const connectors = [{ id: "c-u", kind: "cable", from: "U.out", to: "MV.bus", size: "500", sets: 2, raceway: "pvc", insulation_c: 90 }];
  for (let g = 0; g < groups; g++) {
    const ox = g * 12, oz = 6;
    const T = `T${g}`, S = `S${g}`, M = `MCC${g}`, P = `P${g}`;
    equipment.push(
      { id: T, type: "transformer", kva: 2000, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: ox, gy: oz },
      { id: S, type: "switchgear", kv: 0.48, bus_a: 3000, sc_ka: 65, sections: 4, gx: ox + 4, gy: oz },
      { id: M, type: "mcc", kv: 0.48, bus_a: 800, sc_ka: 42, sections: 3, gx: ox, gy: oz + 5 },
      { id: P, type: "panel", kv: 0.48, bus_a: 225, sc_ka: 35, gx: ox + 5, gy: oz + 5 },
      { id: `L${g}`, type: "load", kw: 300, pf: 0.9, gx: ox + 7, gy: oz + 5 },
      { id: `C${g}`, type: "capacitor", kvar: 100, gx: ox + 9, gy: oz + 3 },
    );
    connectors.push(
      { id: `c-${T}`, kind: "cable", from: "MV.bus", to: `${T}.hv`, size: "2/0", raceway: "pvc", insulation_c: 90 },
      { id: `cb-${S}`, kind: "cablebus", from: `${T}.lv`, to: `${S}.bus`, size: "750", sets: 4 },
      { id: `c-${M}`, kind: "cable", from: `${S}.bus`, to: `${M}.bus`, size: "500", sets: 2 },
      { id: `c-${P}`, kind: "cable", from: `${S}.bus`, to: `${P}.bus`, size: "4/0", sets: 1 },
      { id: `c-L${g}`, kind: "cable", from: `${S}.bus`, to: `L${g}.in`, size: "500", sets: 2 },
      { id: `c-C${g}`, kind: "cable", from: `${S}.bus`, to: `C${g}.in`, size: "250", sets: 1 },
    );
    for (let k = 0; k < 4; k++) {
      const gen = k === 3 && g % 3 === 0;
      equipment.push({ id: `M${g}-${k}`, type: gen ? "generator" : "motor", hp: 50, kv: 0.48, kva: 300, p_kw: 150, gx: ox + k * 2.5, gy: oz + 9 });
      connectors.push({ id: `c-M${g}-${k}`, kind: "cable", from: `${M}.bus`, to: `M${g}-${k}.${gen ? "out" : "in"}`, size: "2/0", sets: 1 });
    }
  }
  return { name: "big", base_mva: 10, equipment, connectors };
}

test("every primitive is well formed and uses a known geometry and material", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const m = buildSiteModel(EXAMPLE_SYSTEM, a);
  assert.ok(m.prims.length > 300);
  for (const p of m.prims) {
    assert.ok(GEOMETRIES.includes(p.g), p.g);
    assert.ok(MAT_SPEC[p.m], p.m);
    assert.ok(p.p.every(Number.isFinite) && p.s.every(Number.isFinite), JSON.stringify(p));
    assert.ok(p.s.every((v) => v > 0), `non-positive scale on ${p.id} ${p.g}`);
    if (p.dir) assert.ok(Math.abs(Math.hypot(...p.dir) - 1) < 1e-9);
    assert.ok(p.kind === "eq" || p.kind === "con");
  }
  // every element gets parts and a label anchor; close-coupled links draw nothing
  for (const e of EXAMPLE_SYSTEM.equipment) { assert.ok(m.prims.some((p) => p.id === e.id), e.id); assert.equal(m.anchors.eq[e.id].length, 3); }
  for (const c of EXAMPLE_SYSTEM.connectors) assert.ok(m.prims.some((p) => p.id === c.id), c.id);
});

test("transformers have a tank, radiator fins on both faces and porcelain bushings", () => {
  const m = buildSiteModel(EXAMPLE_SYSTEM, analyseSystem(EXAMPLE_SYSTEM));
  const t = m.prims.filter((p) => p.id === "T1");
  const fins = t.filter((p) => p.m === "fin" && p.g === "box");
  assert.ok(fins.length >= 10);
  const zs = new Set(fins.map((p) => Math.round(p.p[2] * 100)));
  assert.equal(zs.size, 2, "two radiator banks");
  assert.ok(t.some((p) => p.m === "tank" && p.paint));
  assert.ok(t.filter((p) => p.m === "porcelain").length >= 12);
});

test("switchgear sections follow the lineup builder's section widths and cubicles", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const L = buildLineup(EXAMPLE_SYSTEM, a, "SWGR-LV");
  const e = { type: "switchgear", kv: 0.48, sections: 6 };
  const w = dims(e).w;
  const lay = lineupLayout(L, w);
  assert.equal(lay.sections.length, L.sections.length);
  assert.ok(Math.abs(lay.sections.reduce((s, x) => s + x.w, 0) - w) < 1e-9);
  lay.sections.forEach((s, i) => assert.ok(Math.abs(s.w / w - L.sections[i].width_in / L.geometry.width_in) < 1e-12));
  assert.equal(lay.per, L.geometry.perSection);
  assert.ok(lay.sections[0].main);
  // fallback without a lineup: equal sections
  const f = lineupLayout(null, 4, 4, 3);
  assert.deepEqual(f.sections.map((s) => s.w), [1, 1, 1, 1]);
  assert.equal(f.sections[0].cubicles.length, 3);
  // in the model: one breaker trip unit per non-spare cubicle
  const m = buildSiteModel(EXAMPLE_SYSTEM, a);
  const trips = m.prims.filter((p) => p.id === "SWGR-LV" && p.m === "trip").length;
  const live = L.sections.flatMap((s) => s.cubicles).filter((c) => c.kind !== "spare").length;
  assert.equal(trips, live);
});

test("cable bus draws phase conductors and a cover; cable runs draw duct and the cable", () => {
  const m = buildSiteModel(EXAMPLE_SYSTEM, analyseSystem(EXAMPLE_SYSTEM));
  const cb = m.prims.filter((p) => p.id === "CB-1");
  assert.ok(cb.some((p) => p.m === "cover"));
  assert.ok(["phA", "phB", "phC"].every((ph) => cb.some((p) => p.m === ph)));
  const c = m.prims.filter((p) => p.id === "C-MCC");
  assert.ok(c.some((p) => p.m === "duct") && c.some((p) => p.m === "line" && p.paint));
});

test("flow paths reverse with the power direction and skip open or unsolved branches", () => {
  const route = { pts: [[0, 0, 0], [4, 0, 0], [4, 3, 0]] };
  const f = flowPath({ id: "x", kind: "cable" }, route, { dir: 1, loading_pct: 50 });
  assert.equal(f.total, 7); assert.deepEqual(f.pts[0], [0, 0.12, 0]);
  const r = flowPath({ id: "x", kind: "cable" }, route, { dir: -1, loading_pct: 50 });
  assert.deepEqual(r.pts[0], [4, 0.12, 3]);
  assert.equal(flowPath({ id: "x", kind: "cable" }, route, { open: true }), null);
  assert.equal(flowPath({ id: "x", kind: "cable" }, route, null), null);
  assert.deepEqual(midpoint([[0, 0, 0], [4, 0, 0], [4, 0, 4]]), [4, 0, 0]);
});

test("emitter maps cylinders between points to centre, length and direction", () => {
  const out = []; const b = emitter(out, "X", "eq");
  b.cyl("tray", [0, 0, 0], [0, 0, 2], 0.1);
  b.cylY("tray", 1, 0, 1, 0.2, 3);
  assert.deepEqual(out[0].p, [0, 0, 1]); assert.deepEqual(out[0].s, [0.1, 2, 0.1]); assert.deepEqual(out[0].dir, [0, 0, 1]);
  assert.deepEqual(out[1].p, [1, 1.5, 1]); assert.equal(out[1].dir, undefined);
  assert.equal(b.cyl("tray", [1, 1, 1], [1, 1, 1], 0.1), null);
});

test("100-element package: solves, builds quickly, and batches stay flat (draw calls do not grow with size)", () => {
  const sys = bigSystem(10);
  assert.ok(sys.equipment.length >= 100, `${sys.equipment.length} elements`);
  const a = analyseSystem(sys);
  assert.ok(a.ok, a.message);
  const t0 = performance.now();
  const m = buildSiteModel(sys, a);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `model build took ${ms.toFixed(0)} ms`);
  const small = batchKeys(buildSiteModel(EXAMPLE_SYSTEM, analyseSystem(EXAMPLE_SYSTEM)).prims).size;
  const big = batchKeys(m.prims).size;
  assert.ok(big <= 60, `${big} batches`);
  assert.ok(big <= small + 12, `batches grew from ${small} to ${big}`);
  assert.ok(m.flows.length > 50);
});
