import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY } from "../src/engine/systemLibrary.js";
import { analyseSystem, EQUIPMENT, NODE_KINDS } from "../src/engine/system.js";
import { buildLineup } from "../src/engine/gear.js";
import { dims } from "../src/ui/systemGeometry.js";
import { parseSystem, serializeSystem } from "../src/engine/systemio.js";

test("library has at least four unique packages", () => {
  assert.ok(LIBRARY.length >= 4);
  assert.equal(new Set(LIBRARY.map((l) => l.key)).size, LIBRARY.length);
});

for (const { key, system } of LIBRARY) {
  test(`${key}: solves with nothing overloaded and fault duty within rating`, () => {
    const r = analyseSystem(system);
    assert.ok(r.ok, r.message);
    assert.equal(r.issues.filter((x) => x.level === "error").length, 0);
    for (const [id, e] of Object.entries(r.equipment)) {
      if (e.loading_pct != null) assert.ok(e.loading_pct <= 100, `${id} loaded ${e.loading_pct.toFixed(1)} %`);
      if (e.sc_duty_pct != null) assert.ok(e.sc_duty_pct <= 100, `${id} fault duty ${e.sc_duty_pct.toFixed(1)} %`);
    }
    for (const [id, c] of Object.entries(r.connectors)) if (c.loading_pct != null) assert.ok(c.loading_pct <= 100, `${id} loaded ${c.loading_pct.toFixed(1)} %`);
    assert.ok(r.totals.min_v > 0.95, `min V ${r.totals.min_v}`);
  });

  test(`${key}: every feeder passes its own lineup checks (240.4, 215.3)`, () => {
    const r = analyseSystem(system);
    for (const g of system.equipment.filter((e) => NODE_KINDS.has(e.type))) {
      for (const c of buildLineup(system, r, g.id).circuits.filter((c) => c.kind === "feeder")) {
        for (const k of c.checks) assert.ok(k.ok, `${g.id} ${c.tag}: ${k.name} (${k.value} vs ${k.limit})`);
      }
    }
  });

  test(`${key}: equipment does not overlap and keeps clearance`, () => {
    const boxes = system.equipment.map((e) => { const d = dims({ ...EQUIPMENT[e.type].defaults, ...e }); return { id: e.id, x0: e.gx, y0: e.gy, x1: e.gx + d.w, y1: e.gy + d.d }; });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const gap = Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
      assert.ok(gap >= 1.5 - 1e-9, `${a.id} and ${b.id} only ${gap.toFixed(2)} apart`);
    }
  });

  test(`${key}: survives a save/load round trip`, () => {
    assert.equal(analyseSystem(parseSystem(serializeSystem(system))).ok, true);
  });
}
