// IEEE 1584-2018 arc-flash engine tests.
// STRUCTURAL tests only. The Annex D worked examples could NOT be reproduced from memory (expected values not
// recalled reliably), so none is asserted. The coefficient data is UNVERIFIED (entered from memory, some sets
// are placeholders); these tests check model behaviour, not agreement with the published standard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { arcFlash, arcFlashStudy, CLASS_DEFAULTS, classFor, ppeLevel, DATA_STATUS } from "../src/engine/arcflash.js";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";

const base = (voc, over = {}) => {
  const d = CLASS_DEFAULTS[voc > 5 ? "mv15" : voc > 1 ? "mv5" : "lv_swgr"];
  return { voc_kv: voc, ibf_ka: 25, gap_mm: d.gap_mm, working_mm: d.working_mm, config: "VCB", enclosure: d.enclosure, clearing_ms: 200, ...over };
};

test("data status is surfaced and unverified", () => {
  assert.equal(DATA_STATUS, "PLACEHOLDER");
  assert.equal(arcFlash(base(0.48)).data_status, "PLACEHOLDER");
});

test("energy is linear in clearing time and monotone in Ibf", () => {
  for (const v of [0.48, 4.16, 13.8]) {
    const a = arcFlash(base(v, { clearing_ms: 100, clearing_reduced_ms: 100 })), b = arcFlash(base(v, { clearing_ms: 200, clearing_reduced_ms: 200 }));
    assert.ok(Math.abs(b.e_cal_cm2 / a.e_cal_cm2 - 2) < 1e-9);
    const lo = arcFlash(base(v, { ibf_ka: 15 })), hi = arcFlash(base(v, { ibf_ka: 30 }));
    assert.ok(hi.e_cal_cm2 > lo.e_cal_cm2 && hi.iarc_ka > lo.iarc_ka);
  }
});

test("energy decreases with working distance, AFB is where E = 1.2 cal/cm2", () => {
  const near = arcFlash(base(0.48, { working_mm: 455 })), far = arcFlash(base(0.48, { working_mm: 910 }));
  assert.ok(near.e_cal_cm2 > far.e_cal_cm2);
  for (const v of [0.48, 4.16, 13.8]) {
    const r = arcFlash(base(v));
    const g = r.scenarios[r.governing];
    const at = arcFlash(base(v, { working_mm: r.afb_mm, clearing_ms: g.clearing_ms }));
    assert.ok(Math.abs(at.e_cal_cm2 - 1.2) < 0.01, `E at AFB ${at.e_cal_cm2}`);
  }
});

test("VCB exceeds VOA at 480 V (enclosure focuses the arc)", () => {
  assert.ok(arcFlash(base(0.48)).e_cal_cm2 > arcFlash(base(0.48, { config: "VOA" })).e_cal_cm2);
});

test("reduced arcing current is below full and reduced scenario can govern", () => {
  const r = arcFlash(base(0.48));
  assert.ok(r.iarc_min_ka < r.iarc_ka && r.var_cf > 0);
  const longer = arcFlash(base(0.48, { clearing_reduced_ms: 2000 }));
  assert.equal(longer.governing, "reduced");
  assert.ok(longer.e_cal_cm2 > r.e_cal_cm2);
});

test("continuous across the 600 V and 2.7 kV interpolation breakpoints", () => {
  for (const v of [0.6, 2.7]) {
    const enc = { enclosure: { h: 914.4, w: 914.4, d: 914.4 }, gap_mm: 104 }; // box above the 660.4 mm typical minimum: CF limits step at 600 V by design
    const lo = arcFlash(base(v - 1e-6, enc)), hi = arcFlash(base(v + 1e-6, enc));
    assert.ok(Math.abs(hi.iarc_ka / lo.iarc_ka - 1) < 1e-4, `Iarc at ${v}`);
    assert.ok(Math.abs(hi.e_cal_cm2 / lo.e_cal_cm2 - 1) < 1e-4, `E at ${v}`);
  }
});

test("lower voltage gives lower arcing current than bolted fault", () => {
  const r = arcFlash(base(0.208, { ibf_ka: 10 }));
  assert.ok(r.iarc_ka < 10 && r.iarc_ka > 0);
});

test("PPE thresholds and class selection", () => {
  assert.equal(ppeLevel(1).level, 0); assert.equal(ppeLevel(3.9).level, 1); assert.equal(ppeLevel(8).level, 2);
  assert.equal(ppeLevel(25).level, 3); assert.equal(ppeLevel(40).level, 4); assert.equal(ppeLevel(41).level, 5);
  assert.equal(classFor("switchgear", 13.8), "mv15"); assert.equal(classFor("switchgear", 4.16), "mv5");
  assert.equal(classFor("switchgear", 0.48), "lv_swgr"); assert.equal(classFor("mcc", 0.48), "lv_mcc");
});

test("system study: Ibf is Ik divided by c, defaults assumed and flagged, overrides honoured", () => {
  const an = analyseSystem(EXAMPLE_SYSTEM);
  const rows = arcFlashStudy(an, EXAMPLE_SYSTEM);
  assert.equal(rows.length, 4);
  const lv = rows.find((r) => r.id === "SWGR-LV");
  assert.ok(Math.abs(lv.input.ibf_ka - an.equipment["SWGR-LV"].ik_ka / 1.05) < 1e-12);
  assert.equal(lv.input.clearing_ms, 300); assert.ok(lv.clearing_assumed); assert.match(lv.note, /assumed/);
  assert.equal(rows.find((r) => r.id === "SWGR-MV").input.clearing_ms, 200);
  const sys2 = { ...EXAMPLE_SYSTEM, equipment: EXAMPLE_SYSTEM.equipment.map((e) => (e.id === "SWGR-LV" ? { ...e, af_clearing_ms: 100, af_gap_mm: 25 } : e)) };
  const lv2 = arcFlashStudy(an, sys2).find((r) => r.id === "SWGR-LV");
  assert.equal(lv2.input.clearing_ms, 100); assert.equal(lv2.input.gap_mm, 25); assert.ok(!lv2.clearing_assumed);
});
