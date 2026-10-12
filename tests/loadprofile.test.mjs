import { test } from "node:test";
import assert from "node:assert/strict";
import { profileStudy, PROFILES } from "../src/engine/loadprofile.js";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { LIBRARY } from "../src/engine/systemLibrary.js";

test("flat profile at 1.0 equals the base analysis", () => {
  const base = analyseSystem(EXAMPLE_SYSTEM), r = profileStudy(EXAMPLE_SYSTEM, "datacenter_flat");
  assert.ok(r.ok, r.message);
  for (const h of r.hours) {
    assert.ok(Math.abs(h.load_kw - base.totals.load_kw) < 1e-6);
    assert.ok(Math.abs(h.loss_kw - base.totals.loss_kw) < 1e-6);
    assert.ok(Math.abs(h.min_v - base.totals.min_v) < 1e-9);
  }
  assert.ok(Math.abs(r.energy.load_kwh - 24 * base.totals.load_kw) < 1e-4);
  assert.ok(Math.abs(r.energy.load_factor - 1) < 1e-9);
});

test("energy sums, peak hour and load-duration curve", () => {
  const r = profileStudy(EXAMPLE_SYSTEM, "industrial_two_shift");
  assert.ok(r.ok, r.message);
  assert.ok(Math.abs(r.energy.load_kwh - r.hours.reduce((s, h) => s + h.load_kw, 0)) < 1e-9);
  assert.ok(Math.abs(r.energy.loss_kwh - r.hours.reduce((s, h) => s + h.loss_kw, 0)) < 1e-9);
  const f = PROFILES.industrial_two_shift.hours, top = Math.max(...f);
  assert.equal(f[r.peak_hour], top);
  assert.equal(r.duration.length, 24);
  assert.equal(r.duration[0].load_kw, r.peak_kw);
  for (let i = 1; i < 24; i++) assert.ok(r.duration[i - 1].load_kw >= r.duration[i].load_kw);
  assert.ok(r.energy.load_factor < 1 && r.energy.loss_pct > 0);
  for (const arr of Object.values(r.loading)) assert.equal(arr.length, 24);
});

test("per-equipment profile override and bad profile", () => {
  const sys = { ...EXAMPLE_SYSTEM, equipment: EXAMPLE_SYSTEM.equipment.map((e) => (e.id === "LOAD-1" ? { ...e, profile: "industrial_two_shift" } : e)) };
  const a = profileStudy(sys, "datacenter_flat"), b = profileStudy(EXAMPLE_SYSTEM, "datacenter_flat");
  assert.ok(a.hours[3].load_kw < b.hours[3].load_kw);
  assert.equal(profileStudy(EXAMPLE_SYSTEM, [1, 2]).ok, false);
});

for (const { key, system } of LIBRARY) test(`${key}: profile runs`, () => assert.ok(profileStudy(system, "industrial_two_shift").ok));
