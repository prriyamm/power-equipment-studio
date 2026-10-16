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
  return { voc_kv: voc, ibf_ka: 25, gap_mm: d.gap_mm, working_mm: d.working_mm, config: "VCB", enclosure: d.enclosure, clearing_ms: 200, allow_placeholder_data: true, ...over };
};

test("data status is surfaced and unverified", () => {
  assert.equal(DATA_STATUS, "PLACEHOLDER");
  assert.equal(arcFlash(base(0.48)).data_status, "PLACEHOLDER");
});

test("PLACEHOLDER coefficients are refused unless explicitly allowed", () => {
  assert.throws(() => arcFlash(base(0.48, { allow_placeholder_data: false })), { name: "DataStatusError", message: /PLACEHOLDER/ });
  assert.throws(() => arcFlash(base(13.8, { allow_placeholder_data: undefined })), { name: "DataStatusError" });
  const an = analyseSystem(EXAMPLE_SYSTEM);
  const refused = arcFlashStudy(an, EXAMPLE_SYSTEM);
  assert.ok(refused.length > 0 && refused.every((r) => r.placeholder && r.error && r.class_label));
  assert.ok(arcFlashStudy(an, EXAMPLE_SYSTEM, { allow_placeholder_data: true }).every((r) => !r.error));
});

test("Ibf validity range above 600 V is 0.2-65 kA at every voltage", () => {
  const ibfWarn = (r) => r.warnings.some((w) => w.startsWith("Ibf"));
  for (const v of [4.16, 13.8]) {
    assert.ok(!ibfWarn(arcFlash(base(v, { ibf_ka: 50 }))), `${v} kV at 50 kA`);
    assert.ok(ibfWarn(arcFlash(base(v, { ibf_ka: 70 }))), `${v} kV at 70 kA`);
  }
  assert.ok(!ibfWarn(arcFlash(base(0.48, { ibf_ka: 100 }))) && ibfWarn(arcFlash(base(0.48, { ibf_ka: 110 }))));
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
  const rows = arcFlashStudy(an, EXAMPLE_SYSTEM, { allow_placeholder_data: true });
  assert.equal(rows.length, 4);
  const lv = rows.find((r) => r.id === "SWGR-LV");
  assert.ok(Math.abs(lv.input.ibf_ka - an.equipment["SWGR-LV"].ik_ka / 1.05) < 1e-12);
  assert.equal(lv.input.clearing_ms, 300); assert.ok(lv.clearing_assumed); assert.match(lv.note, /assumed/);
  assert.equal(rows.find((r) => r.id === "SWGR-MV").input.clearing_ms, 200);
  const sys2 = { ...EXAMPLE_SYSTEM, equipment: EXAMPLE_SYSTEM.equipment.map((e) => (e.id === "SWGR-LV" ? { ...e, af_clearing_ms: 100, af_gap_mm: 25 } : e)) };
  const lv2 = arcFlashStudy(an, sys2, { allow_placeholder_data: true }).find((r) => r.id === "SWGR-LV");
  assert.equal(lv2.input.clearing_ms, 100); assert.equal(lv2.input.gap_mm, 25); assert.ok(!lv2.clearing_assumed);
});

test("regression: above 600 V the AFB is interpolated from per-level boundaries (1584-2018 AFB_600/2700/14300)", async () => {
  // Independent closed form, using whatever coefficients the data file holds (PLACEHOLDER; this checks how the
  // code applies them, not the coefficients). For one level with arcing current I:
  //   E(D) = 12.552/50 · T · 10^(A + k12·lg D), A = k1 + k2 lg G + k3 I/(Ibf·P(Ibf)) + k11 lg Ibf + k13 lg I + lg(1/CF)
  //   E(AFB) = 1.2 cal/cm² = 5.0208 J/cm²  ->  lg AFB = (lg(5.0208·50/(12.552·T)) − A)/k12
  // Then AFB1 = (AFB2700 − AFB600)/2.1·(V − 2.7) + AFB2700, AFB2 = (AFB14300 − AFB2700)/11.6·(V − 14.3) + AFB14300,
  //   AFB3 = AFB1·(2.7 − V)/2.1 + AFB2·(V − 0.6)/2.1; V ≤ 2.7 kV -> AFB3, else AFB2.
  const { default: DATA } = await import("../src/engine/data/ieee1584_2018.json", { with: { type: "json" } });
  const lg = Math.log10, poly = (c, x) => c.reduce((a, k) => a * x + k, 0);
  const iarc = (lvl, cfg, ibf, gap) => { const k = DATA.iarc[lvl][cfg]; return 10 ** (k[0] + k[1] * lg(ibf) + k[2] * lg(gap)) * poly(k.slice(3), ibf); };
  const afbLevel = (lvl, cfg, ibf, gap, T, I, cf) => {
    const k = DATA.energy[lvl][cfg];
    const A = k[0] + k[1] * lg(gap) + (k[2] * I) / (ibf * poly(k.slice(3, 10), ibf)) + k[10] * lg(ibf) + k[12] * lg(I) + lg(1 / cf);
    return 10 ** ((lg((1.2 * 4.184 * 50) / (12.552 * T)) - A) / k[11]);
  };
  for (const V of [4.16, 13.8]) {
    const inp = base(V, { ibf_ka: 20, clearing_ms: 200 });
    const r = arcFlash(inp);
    const a = [600, 2700, 14300].map((l) => afbLevel(String(l), "VCB", 20, inp.gap_mm, 200, iarc(String(l), "VCB", 20, inp.gap_mm), r.cf));
    const b1 = ((a[1] - a[0]) / 2.1) * (V - 2.7) + a[1], b2 = ((a[2] - a[1]) / 11.6) * (V - 14.3) + a[2];
    const want = V <= 2.7 ? (b1 * (2.7 - V)) / 2.1 + (b2 * (V - 0.6)) / 2.1 : b2;
    assert.ok(Math.abs(r.scenarios.full.afb_mm - want) < 1e-6 * want, `${V} kV: ${r.scenarios.full.afb_mm} vs ${want}`);
  }
});

test("utility sc_basis: ANSI E/Z quote gives Ibf = quoted current at the utility bus; IEC (default) gives quoted/c", () => {
  // Utility 500 MVA at 13.8 kV, switchgear on the utility bus. c_max = 1.10 above 1 kV.
  //   Quoted current S/(√3·U) = 500/(√3·13.8) = 20.9185 kA.
  //   ANSI: Z_Q = U²/S (no c). I″k = c·U/(√3·Z_Q) = 1.1 × 20.9185 = 23.0103 kA; Ibf = I″k/c = 20.9185 kA.
  //   IEC:  Z_Q = c·U²/S.     I″k = S/(√3·U) = 20.9185 kA;            Ibf = I″k/c = 20.9185/1.1 = 19.0168 kA.
  const mk = (sc_basis) => ({ base_mva: 10, equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 500, xr: 15, ...(sc_basis ? { sc_basis } : {}) },
    { id: "S", type: "switchgear", kv: 13.8 }, { id: "L", type: "load", kw: 100 }],
    connectors: [{ id: "a", kind: "direct", from: "U.out", to: "S.bus" }, { id: "b", kind: "direct", from: "S.bus", to: "L.in" }] });
  const quoted = 500 / (Math.sqrt(3) * 13.8); // 20.9185 kA
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9 * b, `${a} vs ${b}`);
  const study = (sys) => { const an = analyseSystem(sys); return { ik: an.equipment.S.ik_ka, ibf: arcFlashStudy(an, sys, { allow_placeholder_data: true }).find((r) => r.id === "S").input.ibf_ka }; };
  const ansi = study(mk("ANSI"));
  near(ansi.ibf, quoted); near(ansi.ik, 1.1 * quoted);
  const iec = study(mk("IEC"));
  near(iec.ibf, quoted / 1.1); near(iec.ik, quoted);
  const dflt = study(mk());
  near(dflt.ibf, iec.ibf); near(dflt.ik, iec.ik);
});
