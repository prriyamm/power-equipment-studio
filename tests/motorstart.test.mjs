import { test } from "node:test";
import assert from "node:assert/strict";
import { motorStartStudy, largestMotor, STARTERS } from "../src/engine/motorstart.js";
import { LIBRARY } from "../src/engine/systemLibrary.js";
import { motorKva } from "../src/engine/system.js";

const simple = (extra = {}) => ({
  base_mva: 10,
  equipment: [
    { id: "U", type: "utility", kv: 13.8, mva_sc: 1e6, xr: 15 },
    { id: "T", type: "transformer", kva: 2000, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7 },
    { id: "M", type: "motor", hp: 500, eff: 0.95, pf: 0.88, load_factor: 0, lrc: 6, ...extra },
  ],
  connectors: [
    { id: "C1", kind: "direct", from: "U.out", to: "T.hv" },
    { id: "C2", kind: "direct", from: "T.lv", to: "M.in" },
  ],
});

test("hand check: dip follows the transformer / locked-rotor impedance divider", () => {
  const r = motorStartStudy(simple(), "M");
  assert.ok(r.ok, r.message);
  // complex divider on the 10 MVA base
  const zx = (0.0575 * 10) / 2, rx = zx / Math.sqrt(50), xx = rx * 7;
  const yMag = (6 * motorKva({ hp: 500, eff: 0.95, pf: 0.88 })) / 10000;
  const zlr = [0.2 / yMag, Math.sqrt(1 - 0.04) / yMag];
  const num = Math.hypot(...zlr), den = Math.hypot(zlr[0] + rx, zlr[1] + xx);
  assert.ok(Math.abs(r.motor_terminal_pu - num / den) < 1e-3);
  // scalar approximation Z_x / (Z_x + Z_LR) within 1 %
  const approx = 1 - zx / (zx + 1 / yMag);
  assert.ok(Math.abs(r.motor_terminal_pu - approx) < 0.01, `${r.motor_terminal_pu} vs ${approx}`);
  assert.ok(Math.abs(r.start.multiple_fla - 6) < 1e-12);
  assert.equal(r.criteria.status, "typical criteria");
});

test("starter types reduce the dip monotonically", () => {
  const dip = (s) => motorStartStudy(simple(), "M", { starter: s }).rows.find((x) => x.is_motor).dip_pct;
  const d = Object.fromEntries(Object.keys(STARTERS).map((k) => [k, dip(k)]));
  assert.ok(d.dol > d.autotransformer_80 && d.autotransformer_80 > d.autotransformer_65);
  assert.ok(d.dol > d.soft_starter_3x && d.soft_starter_3x > d.vfd);
});

test("pass/fail follows the criteria options", () => {
  assert.equal(motorStartStudy(simple(), "M", { criteria: { motor_min_pu: 0.5 } }).pass.motor, true);
  assert.equal(motorStartStudy(simple(), "M", { criteria: { motor_min_pu: 0.999 } }).pass.motor, false);
});

test("errors are reported, not thrown", () => {
  assert.equal(motorStartStudy(simple(), "U").ok, false);
  assert.equal(motorStartStudy(simple(), "M", { starter: "nope" }).ok, false);
});

for (const { key, system } of LIBRARY) {
  test(`${key}: largest motor start runs`, () => {
    const m = largestMotor(system);
    if (!m) return;
    const r = motorStartStudy(system, m.id);
    assert.ok(r.ok, r.message);
    assert.ok(r.rows.every((x) => x.v_start <= x.v_pre + 1e-9));
    assert.ok(r.start.i_ka > 0);
  });
}
