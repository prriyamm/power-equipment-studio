// Smoke tests for the pure lab animation state (src/ui/labAnim.js): geometry and effects are functions of the run and t.
import test from "node:test";
import assert from "node:assert/strict";
import { labInput, runLabTest, findFailureCurrent, buildContext } from "../src/engine/scLabTest.js";
import { labLayout, labState, fragmentCells, fragmentPose, fillSparks, smokePuffs, flashAt, shakeAt, whipAt, shapeWeight, utilColor,
  playEnd, stillTime, budgetFor, TIER_BUDGET } from "../src/ui/labAnim.js";

const BUS = {
  voltage_v: 15000, current_a: 2000, size: "750", material: "Cu", conductors_per_phase: 3, tiers: 1,
  insulation: "EPR", insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2, shield_bonding: "both_ends", length_m: 60,
  fault_ka: 40, x_over_r: 15, enclosure_width_mm: 800, enclosure_height_mm: 150,
};
const L0 = labInput({ bus: BUS, test_ka: 40, duration_s: 0.1 });
const ctx = buildContext(L0.bus);
const layout = labLayout(ctx, 3);
const ka = findFailureCurrent(L0, ctx).modes.find((m) => m.mode === "block").current_ka;
const pass = runLabTest(L0, ctx);
const fail = runLabTest({ ...L0, test_ka: ka * 1.1 }, ctx);

test("layout: 9 cables, 4 blocks at the span, plates per tier", () => {
  assert.equal(layout.cables.length, 9);
  assert.equal(layout.zs.length, 4);
  assert.ok(Math.abs(layout.zs[3] - 3 * ctx.inp.support_span_m) < 1e-12);
  assert.equal(layout.plates.length, 1);
});

test("labState: no fragments, flash or particles before the failure instant", () => {
  const tf = fail.failure.t_s;
  for (const t of [0, tf * 0.5, tf - 1e-6]) {
    const s = labState(fail, layout, t, { scale: 100, tier: "high" });
    assert.equal(s.failed, false);
    assert.equal(s.fragments.length, 0);
    assert.equal(s.flash.i, 0);
    assert.deepEqual(s.shake, [0, 0, 0]);
    assert.equal(s.failed_block, null);
  }
});

test("labState: fragments, flash and shake appear after the failure; failed block is broken", () => {
  const tf = fail.failure.t_s;
  const s = labState(fail, layout, tf + 0.002, { scale: 100, tier: "high" });
  assert.equal(s.failed, true);
  assert.ok(s.fragments.length >= 10);
  assert.ok(s.flash.i > 0.2);
  assert.ok(Math.abs(s.shake[0]) + Math.abs(s.shake[1]) > 0);
  assert.equal(s.blocks[fail.failure.block_index].broken, true);
  assert.equal(s.blocks.filter((b) => b.broken).length, 1);
  assert.equal(s.failed_block, fail.failure.block_index);
});

test("pass case never produces effects, even at the end of the test", () => {
  const s = labState(pass, layout, pass.t_s[pass.t_s.length - 1], { scale: 100, tier: "high" });
  assert.equal(s.failed, false);
  assert.equal(s.fragments.length, 0);
  assert.equal(s.flash.i, 0);
});

test("tier budgets: low has no particles/shake and fewer fragments; medium sparks <= 300", () => {
  assert.equal(budgetFor("low").sparks, 0);
  assert.equal(budgetFor("low").shake, false);
  assert.ok(budgetFor("low").fragments < budgetFor("medium").fragments && budgetFor("medium").fragments < budgetFor("high").fragments);
  assert.ok(TIER_BUDGET.medium.sparks <= 300);
  const t = fail.failure.t_s + 0.002;
  const lo = labState(fail, layout, t, { tier: "low" }), hi = labState(fail, layout, t, { tier: "high" });
  assert.ok(lo.fragments.length < hi.fragments.length);
  assert.deepEqual(lo.shake, [0, 0, 0]);
});

test("deflection is zero at no force, grows with force and is bounded by the visual amplitude", () => {
  const s0 = labState(fail, layout, 0, { tier: "medium" });
  assert.ok(s0.conductors.every((c) => Math.abs(c.dx) + Math.abs(c.dy) < 1e-9));
  const vis = fail.deflection.visual_mm / 1000;
  const tp = fail.t_s[fail.force_envelope_n_per_m.indexOf(Math.max(...fail.force_envelope_n_per_m))];
  const s1 = labState(fail, layout, Math.min(tp, fail.failure.t_s - 1e-5), { tier: "medium" });
  const m = Math.max(...s1.conductors.map((c) => Math.hypot(c.dx, c.dy)));
  assert.ok(m > 0 && m <= vis * 1.0001);
});

test("pure effect functions: ballistic fragments land, sparks capped, smoke fades, flash decays", () => {
  const cells = fragmentCells(layout.plates[0], 1, 6, 2);
  assert.equal(cells.length, 12);
  const area = cells.reduce((a, c) => a + c.size[0] * c.size[1], 0);
  const pl = layout.plates[0];
  assert.ok(Math.abs(area - (pl.x1 - pl.x0) * (pl.y1 - pl.y0)) < 1e-9, "cells tile the plate");
  const p0 = fragmentPose(cells[0], 0);
  assert.deepEqual(p0.pos, cells[0].p0);
  const late = fragmentPose(cells[0], 6);
  assert.equal(late.landed, true);
  assert.ok(late.pos[1] <= 0.05);
  const pos = new Float32Array(900), col = new Float32Array(900);
  assert.equal(fillSparks(pos, col, 300, -0.1, [0, 1, 0]), 0);
  const alive = fillSparks(pos, col, 300, 0.4, [0, 1, 0]);
  assert.ok(alive > 100 && alive <= 300);
  assert.equal(fillSparks(pos, col, 300, 5, [0, 1, 0]), 0);
  const sm = smokePuffs(1, [0, 1, 0], 4);
  assert.equal(sm.length, 4);
  assert.ok(smokePuffs(10, [0, 1, 0], 4).every((p) => p.opacity === 0));
  assert.equal(flashAt(-1).i, 0);
  assert.ok(flashAt(0.015).i > flashAt(1).i);
  assert.ok(flashAt(0.5).mix > flashAt(0.01).mix);
  assert.deepEqual(shakeAt(2), [0, 0, 0]);
  assert.equal(whipAt(0), 0);
  assert.ok(whipAt(0.5) > 1);
});

test("shape weights: zero at blocks, one at mid span; merged span after failure", () => {
  const zs = layout.zs;
  assert.equal(shapeWeight(zs[1], zs, null), 0);
  assert.ok(Math.abs(shapeWeight((zs[0] + zs[1]) / 2, zs, null) - 1) < 1e-12);
  assert.ok(shapeWeight(zs[1], zs, 1) > 0.99); // failed block 1: mid of merged span 0..2
  assert.equal(shapeWeight(zs[3] + 1, zs, 1), 0);
});

test("colour scale, playback window and still image time", () => {
  assert.deepEqual(utilColor(0).map(Math.round), [63, 174, 90]);
  assert.deepEqual(utilColor(1).map(Math.round), [224, 69, 58]);
  assert.ok(playEnd(fail, 100) <= fail.t_s[fail.t_s.length - 1]);
  assert.ok(playEnd(fail, 100) >= fail.failure.t_s);
  assert.equal(playEnd(pass, 100), pass.t_s[pass.t_s.length - 1]);
  assert.ok(stillTime(fail, 100) > fail.failure.t_s);
  assert.ok(stillTime(pass, 100) >= 0);
});

test("4-tier specimen builds a layout with 4 plates", () => {
  const bus = { ...BUS, conductors_per_phase: 4, tiers: 4, enclosure_width_mm: null, enclosure_height_mm: null };
  const L = labInput({ bus, test_ka: 40, duration_s: 0.05 });
  const c = buildContext(L.bus);
  const ly = labLayout(c, 2);
  assert.equal(ly.plates.length, 4);
  const r = runLabTest(L, c);
  const s = labState(r, ly, 0.01, { tier: "medium" });
  assert.equal(s.conductors.length, c.phase_idx.length);
});
