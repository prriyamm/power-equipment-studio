// Cable bus cable library (DLO 2000 V): hand checks that mirror calculations/tests/test_cablebus_dlo.py, the
// workspace state helpers, and the library values. Pure modules only (engine + src/ui/cablebusUtil.js).
// Python parity of every library vector is in tests/cablebus.test.mjs (golden replay).
import test from "node:test";
import assert from "node:assert/strict";

import * as cond from "../src/engine/pecalc/conductors.js";
import { analyse, cableBusInput, cableSpec, libraryEntries, resolveCable, DLO_DIAMETER_RATIO } from "../src/engine/pecalc/cablebus.js";
import { applyCableType, conductorLabel, conductorDiameterMm, libraryOptions, DLO_DEFAULT_ID, CABLE_TYPE_CHOICES,
  libraryErrorText } from "../src/ui/cablebusUtil.js";
import { cablebusSvg } from "../src/engine/pecalc/drawing.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b}`);
const dlo = (over) => cableBusInput({ voltage_v: 600, current_a: 1000, conductors_per_phase: 2, size: "444.4",
  cable_type: "dlo_2000v", cable_id: "southwire_dlo_2000v:444.4", ...over });

test("library rows: 17 Southwire rows and the AWC 1111 kcmil row, all MANUFACTURER", () => {
  const rows = libraryEntries();
  assert.equal(rows.length, 18);
  assert.ok(rows.every((r) => r.status === "MANUFACTURER"));
  assert.deepEqual(rows.map((r) => r.size).slice(0, 4), ["10", "8", "6", "4"]);
});

test("hand values for 444.4 kcmil (printed on the Southwire sheet)", () => {
  const s = cableSpec("southwire_dlo_2000v:444.4");
  assert.equal(s.area_cmil, 444400);
  near(s.area_cmil * cond.CMIL_TO_MM2, 225.18, 0.01, "area mm2");   // 444 400 x 5.067075e-4
  assert.equal(s.od_mm, 31.24);                                    // 1.23 in
  assert.equal(s.insulation_mm, 2.41);
  assert.equal(s.ampacity_free_air_a, 652);
  assert.equal(s.standard_nec_size, false);
  assert.equal(s.size_label, "444.4 kcmil");
});

test("proxy conductor diameter and layout pitch for 444.4 kcmil", () => {
  // sqrt(444 400) / 1000 x 1.173 = 0.66663 x 1.173 in = 19.86 mm; default pitch 2 x 31.24 mm = 62.48 mm.
  near(DLO_DIAMETER_RATIO, 1.173, 1e-3, "ratio");
  const s = cableSpec("southwire_dlo_2000v:444.4");
  assert.equal(s.diameter_source, "proxy");
  near(s.diameter_mm, 19.86, 0.01, "diameter");
  const r = analyse(dlo({ current_a: 1500 }));
  near(r.cable_od_mm, 31.24, 1e-9, "od");
  near(r.pitch_mm, 62.48, 1e-9, "pitch");
});

test("DC resistance at 90 C for 444.4 kcmil (calculated, no printed value)", () => {
  // 10.371 / 444 400 x 1.02 = 2.38038e-5 ohm/ft; x (234.5 + 90) / (234.5 + 20) = 3.03510e-5 ohm/ft; / 0.3048 = 9.9577e-5 ohm/m.
  near(cond.rdcFromAreaOhmPerM(444400, "Cu", 90, 1.02), 9.9577e-5, 1e-8, "rdc");
});

test("datasheet ampacity with ambient correction: 652 x sqrt((90-40)/(90-30)) = 595.19 A", () => {
  const r = analyse(dlo({ current_a: 1500, ambient_c: 40 }));
  assert.match(r.ampacity_basis, /652 A at 30 C/);
  const loading = r.checks.find((c) => c.name.startsWith("Most heavily loaded conductor within its"));
  near(loading.limit, 595.19, 0.06, "ampacity limit");
});

test("standard size on the table basis: 4/0 AWG, NEC 310.17 405 A", () => {
  const r = analyse(cableBusInput({ voltage_v: 600, current_a: 600, conductors_per_phase: 1, size: "4/0",
    cable_type: "dlo_2000v", cable_id: "southwire_dlo_2000v:4/0", ambient_c: 40 }));
  assert.match(r.ampacity_basis, /NEC Table 310\.17/);
  assert.match(r.ampacity_basis, /405 A/);
});

test("refusals: voltage over the 2000 V rating, copper only, 90 C only, unknown ids, calculated method", () => {
  assert.throws(() => analyse(dlo({ voltage_v: 2400 })), /rated 2000 V; voltage_v 2400 is above the cable rating/);
  assert.throws(() => analyse(dlo({ material: "Al" })), /tinned copper: set material 'Cu'/);
  assert.throws(() => analyse(dlo({ insulation_temp_c: 75 })), /rated 90 C: set insulation_temp_c to 90/);
  assert.throws(() => analyse(dlo({ cable_id: "southwire_dlo_2000v:9999" })), /size '9999' is not in series/);
  assert.throws(() => analyse(dlo({ ampacity_method: "calculated" })), /calculated method is not available/);
  assert.throws(() => resolveCable(cableBusInput({ size: "750", cable_type: "standard", cable_id: "southwire_dlo_2000v:444.4" })),
    /only used with cable_type 'dlo_2000v'/);
});

test("non-standard sizes stay out of the NEC size list", () => {
  assert.throws(() => cond.normalizeSize("444.4"), /Unknown conductor size/);
  assert.equal(cond.normalizeSize("4/0"), "4/0");
});

test("standard default is unchanged: no library data in the result", () => {
  const r = analyse(cableBusInput({ voltage_v: 600, current_a: 1000, size: "750" }));
  assert.equal(r.cable_data, null);
  assert.equal(r.input.cable_type, "standard");
});

test("1111 kcmil: basis not stated, warning in the notes", () => {
  const r = analyse(cableBusInput({ voltage_v: 600, current_a: 1500, conductors_per_phase: 1, size: "1111",
    cable_type: "dlo_2000v", cable_id: "awc_dlo_2000v:1111" }));
  assert.ok(r.notes.some((n) => n.startsWith("WARNING: the maker does not state")));
  assert.equal(r.cable_data.basis_stated, false);
});

test("UI helpers: cable type change, library options, labels", () => {
  assert.deepEqual(CABLE_TYPE_CHOICES.map(([v]) => v), ["standard", "dlo_2000v", "mv_construction"]);
  const opts = libraryOptions();
  assert.equal(opts.length, 18);
  assert.ok(opts.some((o) => o.id === DLO_DEFAULT_ID && /444\.4 kcmil/.test(o.label)));

  const base = { cable_type: "standard", cable_id: null, size: "750", material: "Al", insulation_temp_c: 75,
    ampacity_method: "calculated", voltage_v: 600 };
  const d = applyCableType(base, "dlo_2000v");
  assert.deepEqual([d.cable_type, d.cable_id, d.size, d.material, d.insulation_temp_c, d.ampacity_method],
    ["dlo_2000v", DLO_DEFAULT_ID, "444.4", "Cu", 90, "auto"]);
  const back = applyCableType(d, "standard");
  assert.deepEqual([back.cable_type, back.cable_id, back.size], ["standard", null, "750"]);
  assert.equal(applyCableType(back, "mv_construction").cable_type, "mv_construction");

  assert.equal(conductorLabel({ size: "444.4" }, cableSpec(DLO_DEFAULT_ID)), "444.4 kcmil");
  assert.equal(conductorLabel({ size: "750" }, null), "750 kcmil");
  near(conductorDiameterMm({ size: "444.4" }, cableSpec(DLO_DEFAULT_ID)), 19.86, 0.01, "diameter");
});

test("form error names the library cable and field the way the form shows them", () => {
  const f = { cable_type: "dlo_2000v", cable_id: "southwire_dlo_2000v:444.4" };
  let msg;
  try { analyse(dlo({ voltage_v: 2400 })); } catch (e) { msg = e.message; }
  const text = libraryErrorText(msg, f);
  assert.ok(!text.includes("southwire_dlo_2000v"), text);
  assert.ok(!text.includes("voltage_v"), text);
  assert.match(text, /^Southwire DLO 444\.4 kcmil is rated 2000 V; system voltage 2400 is above the cable rating$/);
  // building wire: engine text passes through unchanged
  assert.equal(libraryErrorText("voltage_v must be > 0", { cable_type: "standard", cable_id: null }), "voltage_v must be > 0");
});

test("cross-section title labels a library size with its unit", () => {
  const inp = dlo({ enclosure_width_mm: 400, enclosure_height_mm: 150 });
  const svg = cablebusSvg(inp, analyse(inp));
  assert.match(svg, />2 x 444\.4 kcmil Cu per phase, /);
});
