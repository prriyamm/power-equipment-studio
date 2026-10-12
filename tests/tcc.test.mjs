import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import { protectionPath, coordination, lsigTimes, relayTimes, cableDamageTime } from "../src/engine/tcc.js";

test("IEEE very-inverse relay: t = TD (19.61/(M²−1) + 0.491)", () => {
  const t = relayTimes({ curve: "VI", pickup: 100, td: 2 }, 500).min;
  assert.ok(Math.abs(t - 2 * (19.61 / 24 + 0.491)) < 1e-12);
});

test("LSIG long-time is I²t and instantaneous clears in ~3 cycles", () => {
  const s = { sensor: 1000, ltpu: 1, ltd: 10, stpu: 6, std: 0.2, inst: 12 };
  assert.ok(Math.abs(lsigTimes(s, 3000).min / lsigTimes(s, 4500).min - (4500 / 3000) ** 2) < 1e-9);
  assert.equal(lsigTimes(s, 20000).max, 0.05);
});

test("ICEA cable damage: 4/0 Cu 90→250 °C at 10 kA ≈ 2.3 s", () => {
  assert.ok(Math.abs(cableDamageTime(10000, "4/0", "Cu", 1) - 2.32) < 0.05);
});

test("auto-coordinated paths in the example are selective", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  for (const id of ["M1", "M2", "LOAD-1", "M3"]) {
    const p = protectionPath(EXAMPLE_SYSTEM, a, id);
    assert.ok(p.devices.length >= 3, id);
    for (const c of coordination(p)) assert.ok(c.ok, `${id}: ${c.down} → ${c.up} margin ${c.worst_margin_s}`);
  }
});
