import { test } from "node:test";
import assert from "node:assert/strict";
import TABLE9 from "../src/engine/pecalc/data/reactance_nec_table9.json" with { type: "json" };
import { reactancePer1000ft, reactanceFloorPer1000ft, DERIVED_XL, DERIVED_SIZES, DERIVED_META, RACEWAYS } from "../src/engine/reactanceDerived.js";
import { CONDUCTOR_SIZES, xlPer1000ft, racPer1000ft, tableAmpacity } from "../src/engine/system.js";

test("Table 9 sizes come back exactly and are not flagged derived", () => {
  for (const rw of RACEWAYS) for (const [s, v] of Object.entries(TABLE9[rw])) {
    assert.deepEqual(reactancePer1000ft(s, rw), { xl: v, derived: false });
    assert.equal(xlPer1000ft(s, rw), v);
  }
});

test("derived sizes are flagged, labelled DERIVED and never part of Table 9", () => {
  assert.match(DERIVED_META.status, /^DERIVED — UNVERIFIED/);
  for (const rw of RACEWAYS) for (const s of DERIVED_SIZES) {
    assert.equal(TABLE9[rw][s], undefined, `${s} must not be a Table 9 row`);
    assert.equal(reactancePer1000ft(s, rw).derived, true);
    assert.equal(xlPer1000ft(s, rw), DERIVED_XL[rw][s]);
  }
  assert.equal(reactancePer1000ft("2500", "pvc"), null);
});

test("700/800/900 kcmil lie between their neighbours and keep the column monotonic", () => {
  for (const rw of RACEWAYS) {
    const t = TABLE9[rw], d = DERIVED_XL[rw];
    for (const [s, lo, hi] of [["700", "600", "750"], ["800", "750", "1000"], ["900", "750", "1000"]]) {
      const a = Math.min(t[lo], t[hi]), b = Math.max(t[lo], t[hi]);
      if (a === b) assert.equal(d[s], a, `${rw} ${s}: flat neighbours`);   // steel 600 and 750 are both 0.048
      else assert.ok(d[s] > a && d[s] < b, `${rw} ${s}=${d[s]} not strictly inside (${a}, ${b})`);
    }
    const seq = ["600", "700", "750", "800", "900", "1000"].map((s) => t[s] ?? d[s]);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1], `${rw}: ${seq}`);
    assert.ok(d["800"] > d["900"], `${rw}: 800 > 900`);
  }
});

test("1250–2000 kcmil decrease monotonically below 1000 kcmil and respect the touching-cable floor", () => {
  for (const rw of RACEWAYS) {
    const seq = ["1000", "1250", "1500", "1750", "2000"].map((s) => TABLE9[rw][s] ?? DERIVED_XL[rw][s]);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] < seq[i - 1], `${rw}: ${seq}`);
    for (const s of ["1250", "1500", "1750", "2000"]) assert.ok(DERIVED_XL[rw][s] >= Math.round(reactanceFloorPer1000ft(s) * 1e4) / 1e4, `${rw} ${s}`);
  }
  assert.ok(reactanceFloorPer1000ft("1000") < TABLE9.pvc["1000"], "the floor sits below Table 9 at the large end");
});

test("every System conductor size has resistance, ampacity and reactance data", () => {
  for (const s of CONDUCTOR_SIZES) {
    for (const mat of ["Cu", "Al"]) {
      assert.ok(racPer1000ft(s, mat, 75) > 0, `R ${mat} ${s}`);
      if (mat === "Al" && s === "14") continue;   // NEC lists no 14 AWG aluminum; designPush rejects it
      for (const kind of ["cable", "cablebus"]) assert.ok(tableAmpacity(kind, s, mat, 75) > 0, `ampacity ${kind} ${mat} ${s}`);
    }
    for (const rw of RACEWAYS) assert.ok(reactancePer1000ft(s, rw)?.xl > 0, `XL ${rw} ${s}`);
  }
});

test("designPush rejects sizes without ampacity data (14 AWG aluminum)", async () => {
  const { planPush } = await import("../src/engine/designPush.js");
  const { EXAMPLE_SYSTEM } = await import("../src/engine/system.js");
  const d = { module: "feeder", phases: 3, voltage: { value: 480, unit: "V" }, size: "14", sets: 1, material: "Al", insulation: { value: 75, unit: "°C" }, length: { value: 100, unit: "ft" }, conduit: "pvc", installation: "raceway" };
  assert.match(planPush(EXAMPLE_SYSTEM, { kind: "con", id: "C-MCC" }, d).errors.join(), /no Al ampacity data for 14 AWG/);
});
