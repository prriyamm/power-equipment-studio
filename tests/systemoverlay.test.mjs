import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem, EXAMPLE_SYSTEM } from "../src/engine/system.js";
import {
  interpStops, loadingColor, voltageColor, loadingState, voltageState, toHex, fromHex, greyOut, shadeHex,
  deriveOverlay, overlayLegend, LOADING_STOPS, VOLTAGE_STOPS, NEUTRAL, OFF_GREY,
} from "../src/ui/systemOverlay.js";

const clone = (x) => JSON.parse(JSON.stringify(x));

test("interpStops clamps, hits stops exactly and interpolates linearly", () => {
  const S = [[0, [0, 0, 0]], [10, [100, 200, 50]]];
  assert.deepEqual(interpStops(S, -5), [0, 0, 0]);
  assert.deepEqual(interpStops(S, 10), [100, 200, 50]);
  assert.deepEqual(interpStops(S, 99), [100, 200, 50]);
  assert.deepEqual(interpStops(S, 5), [50, 100, 25]);
  assert.equal(interpStops(S, NaN), null);
});

test("loading scale runs green to amber to red and saturates above 100 %", () => {
  const green = LOADING_STOPS[0][1], red = LOADING_STOPS.at(-1)[1];
  assert.deepEqual(loadingColor(0), green);
  assert.deepEqual(loadingColor(45), green);
  assert.deepEqual(loadingColor(100), red);
  assert.deepEqual(loadingColor(180), red);
  const amber = loadingColor(85);
  assert.ok(amber[0] > green[0] && amber[1] >= amber[2], "85 % is amber");
  assert.equal(loadingColor(null), null);
  // red channel never decreases as loading rises
  let prev = -1;
  for (let p = 0; p <= 120; p += 5) { const r = loadingColor(p)[0]; assert.ok(r >= prev); prev = r; }
  assert.equal(loadingState(79.9), "ok"); assert.equal(loadingState(80), "warn"); assert.equal(loadingState(100), "warn");
  assert.equal(loadingState(100.1), "crit"); assert.equal(loadingState(null), "na");
});

test("voltage scale is diverging and flags outside 0.95–1.05 pu (limits inclusive)", () => {
  assert.deepEqual(voltageColor(1.0), VOLTAGE_STOPS.find(([v]) => v === 1.02)[1]);
  const lo = voltageColor(0.93), hi = voltageColor(1.07);
  assert.ok(lo[0] > lo[2], "low side is warm"); assert.ok(hi[2] > hi[0], "high side is cool");
  assert.deepEqual(voltageState(0.95), { state: "warn", flag: null });
  assert.deepEqual(voltageState(1.05), { state: "warn", flag: null });
  assert.deepEqual(voltageState(1.0), { state: "ok", flag: null });
  assert.deepEqual(voltageState(0.9499), { state: "crit", flag: "low" });
  assert.deepEqual(voltageState(1.0501), { state: "crit", flag: "high" });
  assert.deepEqual(voltageState(0.97, [0.98, 1.02]), { state: "crit", flag: "low" });
  assert.equal(voltageState(undefined).state, "na");
});

test("hex helpers round-trip, grey-out drops hue, shade scales and clips", () => {
  assert.equal(toHex([255, 128, 1]), 0xff8001);
  assert.deepEqual(fromHex(0xff8001), [255, 128, 1]);
  const g = fromHex(greyOut(0xe05a4f));
  assert.ok(g[0] === g[1] && g[1] === g[2]);
  assert.equal(shadeHex(0x808080, 0.5), 0x404040);
  assert.equal(shadeHex(0xc0c0c0, 2), 0xffffff);
});

test("deriveOverlay (loading) reuses analysis results and colours by loading vs rating", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const ov = deriveOverlay(EXAMPLE_SYSTEM, a, { mode: "loading" });
  assert.ok(ov.solved);
  const t1 = ov.equipment.T1;
  assert.equal(t1.value, a.equipment.T1.loading_pct);
  assert.deepEqual(t1.color, loadingColor(a.equipment.T1.loading_pct));
  assert.match(t1.text, /% loaded/);
  // unrated items stay neutral
  assert.deepEqual(ov.equipment.M1.color, NEUTRAL); assert.equal(ov.equipment.M1.state, "na");
  assert.deepEqual(ov.equipment.UTIL.color, NEUTRAL);
  const cb = ov.connectors["CB-1"];
  assert.equal(cb.value, a.connectors["CB-1"].loading_pct);
  assert.equal(ov.summary.off, 0);
  for (const id of Object.keys(ov.equipment)) assert.equal(ov.equipment[id].off, false);
});

test("deriveOverlay (voltage) flags buses outside the band and picks the worse transformer end", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const ov = deriveOverlay(EXAMPLE_SYSTEM, a, { mode: "voltage" });
  for (const e of EXAMPLE_SYSTEM.equipment) {
    const r = a.equipment[e.id], o = ov.equipment[e.id];
    if (e.type === "transformer") { const worst = Math.abs(r.v_lv_pu - 1) > Math.abs(r.v_pu - 1) ? r.v_lv_pu : r.v_pu; assert.equal(o.value, worst); continue; }
    assert.equal(o.value, r.v_pu);
    assert.equal(o.flag, r.v_pu < 0.95 ? "low" : r.v_pu > 1.05 ? "high" : null);
  }
  // a tight band forces flags on the low-voltage buses
  const tight = deriveOverlay(EXAMPLE_SYSTEM, a, { mode: "voltage", band: [0.995, 1.005] });
  const lowIds = EXAMPLE_SYSTEM.equipment.filter((e) => e.type !== "transformer" && a.equipment[e.id].v_pu < 0.995).map((e) => e.id);
  assert.ok(lowIds.length > 0);
  for (const id of lowIds) { assert.equal(tight.equipment[id].flag, "low"); assert.match(tight.equipment[id].text, /LOW/); }
  assert.ok(tight.summary.flagged >= lowIds.length);
  // connectors report voltage drop text
  assert.match(ov.connectors["C-MCC"].text, /ΔV/);
});

test("deriveOverlay marks open breakers and de-energized islands as off", () => {
  const sys = clone(EXAMPLE_SYSTEM);
  sys.connectors.find((c) => c.id === "C-MCC").closed = false;
  const a = analyseSystem(sys);
  assert.ok(a.ok);
  const ov = deriveOverlay(sys, a, { mode: "loading" });
  for (const id of ["MCC-1", "M1", "M2"]) { assert.equal(ov.equipment[id].off, true, id); assert.deepEqual(ov.equipment[id].color, OFF_GREY); }
  assert.equal(ov.connectors["C-MCC"].off, true); assert.equal(ov.connectors["C-MCC"].text, "Open");
  for (const id of ["C-M1", "C-M2"]) assert.equal(ov.connectors[id].off, true, id);
  assert.equal(ov.equipment["SWGR-LV"].off, false);
  assert.equal(ov.summary.off, 6);
});

test("fault labels come from the existing short-circuit results; nothing when unsolved", () => {
  const a = analyseSystem(EXAMPLE_SYSTEM);
  const ov = deriveOverlay(EXAMPLE_SYSTEM, a, { mode: "none", fault: true });
  const sw = ov.equipment["SWGR-LV"].fault;
  assert.equal(sw.ik_ka, a.equipment["SWGR-LV"].ik_ka);
  assert.equal(sw.duty_pct, a.equipment["SWGR-LV"].sc_duty_pct);
  assert.match(sw.text, /kA · \d+ % of rating/);
  assert.equal(ov.equipment.T1.fault.ik_ka, a.equipment.T1.lv_ik_ka);
  assert.equal(ov.equipment.M1.fault, null);
  const none = deriveOverlay(EXAMPLE_SYSTEM, { ok: false }, { mode: "loading", fault: true });
  assert.equal(none.solved, false);
  assert.equal(none.equipment.T1.color, null);
  assert.equal(none.connectors["CB-1"].state, "na");
});

test("legends describe the scales and mark the voltage band", () => {
  const L = overlayLegend("loading");
  assert.match(L.gradient, /^linear-gradient\(90deg, /);
  assert.equal(L.ticks[0].at, 0); assert.ok(L.ticks.at(-1).at < 1 && L.ticks.at(-1).label === "100 %");
  const V = overlayLegend("voltage", [0.95, 1.05]);
  assert.ok(V.band[0] > 0 && V.band[1] < 1 && V.band[0] < V.band[1]);
  assert.ok(Math.abs(V.ticks.find((t) => t.label === "1.00").at - 0.5) < 1e-12);
  assert.equal(overlayLegend("none"), null);
});
