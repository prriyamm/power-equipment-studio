// Ports of calculations/tests/test_feeder_review.py and test_cablebus_review.py (the pecalc feeder review and
// cable bus review PRs). Inputs are the reviewers' repro cases; ampacities are the repository's UNVERIFIED
// NEC Table 310.16 / 310.17 values. The golden vectors in tests/golden/ cover the same behaviour against the
// Python output; these tests state the intent of each fix.
import test from "node:test";
import assert from "node:assert/strict";

import * as amp from "../src/engine/pecalc/ampacity.js";
import * as cb from "../src/engine/pecalc/cablebus.js";
import * as ds from "../src/engine/pecalc/cablebus_design.js";
import { feederInput, sizeFeeder, evaluate } from "../src/engine/pecalc/sizing.js";
import { lugInput, selectLugs } from "../src/engine/pecalc/lugs.js";
import * as validate from "../src/engine/pecalc/validate.js";

const feeder = (kw) => feederInput(kw);
const TERM = "Terminal-column ampacity >= 125 % continuous + non-continuous";
const check = (opt, name) => opt.checks.find((c) => c.name === name);
const throwsWith = (fn, text) => assert.throws(fn, (e) => e instanceof Error && e.message.includes(text), text);

// ------------------------------------------------------------------ feeder review
test("terminal column: a 90 C terminal does not lift a 75 C insulation column", () => {
  // 400 A continuous x 1.25 = 500 A over 3 sets = 166.7 A per set. 3 x 1/0 Cu: 75 C column 150 A < 166.7,
  // although the 90 C terminal column (170 A) alone would pass. The conductor cannot use the 90 C column.
  const inp = feeder({ continuous_a: 400, insulation_temp_c: 75, terminal_temp_c: 90, sets: 3, length_m: 5 });
  const c = check(evaluate(inp, "1/0", 3), TERM);
  assert.equal(c.value, amp.tableAmpacity("NEC", "raceway", "Cu", "1/0", 75));
  assert.equal(c.passed, false);
  assert.ok(c.note.includes("110.14(C)"));
  assert.notEqual(sizeFeeder(inp).recommended.size, "1/0");
});

test("terminal column: 60 C insulation with a 75 C terminal", () => {
  // 200 A continuous x 1.25 = 250 A, one set. 250 kcmil Cu 60 C = 215 A < 250 A (75 C column 255 A is not usable).
  const inp = feeder({ continuous_a: 200, insulation_temp_c: 60, terminal_temp_c: 75, sets: 1, length_m: 5 });
  const c = check(evaluate(inp, "250", 1), TERM);
  assert.equal(c.passed, false);
  assert.equal(c.value, amp.tableAmpacity("NEC", "raceway", "Cu", "250", 60));
  assert.notEqual(sizeFeeder(inp).recommended.size, "250");
});

test("default terminal temperature follows the candidate size and is reported in the option notes", () => {
  // 105 A non-continuous: 2 AWG Cu at the 60 C default column is 95 A (< 105 A); 1 AWG is 110 A.
  let r = sizeFeeder(feeder({ noncontinuous_a: 105, length_m: 1 }));
  assert.equal(r.recommended.size, "1");
  assert.equal(r.recommended.sets, 1);
  assert.ok(r.recommended.notes.some((n) => n.includes("60 C") && n.includes("110.14(C)(1)")));
  r = sizeFeeder(feeder({ noncontinuous_a: 150, length_m: 1 }));
  assert.ok(r.recommended.notes.some((n) => n.includes("75 C") && n.includes("default")));
  r = sizeFeeder(feeder({ noncontinuous_a: 150, length_m: 1, terminal_temp_c: 75 }));
  assert.ok(r.recommended.notes.some((n) => n.includes("as given")));
});

test("lugs get no derived marking: the input stays null and lugs derive their own default", () => {
  const inp = feeder({ noncontinuous_a: 105, length_m: 1 });
  const r = sizeFeeder(inp);
  assert.equal(inp.terminal_temp_c, null);
  assert.equal(r.lugs.input.equipment_terminal_temp_c, null);
  assert.ok(r.lugs.terminal_temp_basis.includes("defaults"));
});

test("voltage scope: NEC stops at 1000 V (Article 215), CEC keeps 2000 V", () => {
  throwsWith(() => sizeFeeder(feeder({ voltage_v: 1500, continuous_a: 100 })), "1000 V");
  throwsWith(() => sizeFeeder(feeder({ voltage_v: 1500, continuous_a: 100 })), "Article 235");
  assert.notEqual(sizeFeeder(feeder({ voltage_v: 1000, continuous_a: 100 })).recommended, null);
  throwsWith(() => sizeFeeder(feeder({ code: "CEC", voltage_v: 2500, continuous_a: 100 })), "2000 V");
});

test("feeder input validation names the input", () => {
  const bad = (name, kw) => throwsWith(() => sizeFeeder(feeder({ continuous_a: 100, ...kw })), name);
  bad("continuous_a", { continuous_a: -10, noncontinuous_a: 50 });
  bad("noncontinuous_a", { noncontinuous_a: -10 });
  bad("load current", { continuous_a: 0 });
  bad("length_m", { length_m: 0 });
  bad("length_m", { length_m: -5 });
  bad("sets", { sets: 0 });
  bad("sets", { sets: -1 });
  bad("sets", { sets: 1.5 });
  bad("phases", { phases: 2 });
  bad("frequency_hz", { frequency_hz: 0 });
  bad("current_carrying_per_raceway", { current_carrying_per_raceway: 0 });
  bad("ambient_c", { ambient_c: 150 });
  bad("ambient_c", { ambient_c: -60 });
  bad("conductor_temp_for_vd_c", { conductor_temp_for_vd_c: 300 });
  for (const name of ["continuous_a", "noncontinuous_a", "length_m", "frequency_hz", "ambient_c",
    "conductor_temp_for_vd_c", "voltage_v", "max_vd_pct", "power_factor"]) {
    for (const v of [NaN, Infinity]) bad(name, { [name]: v });
  }
  // Exact messages (match Python's repr of the value).
  assert.throws(() => sizeFeeder(feeder({ continuous_a: 100, phases: 2 })), { message: "phases must be one of (1, 3), got 2" });
  assert.throws(() => sizeFeeder(feeder({ continuous_a: 100, sets: 0 })), { message: "sets must be 1 or greater, got 0" });
  assert.throws(() => sizeFeeder(feeder({ continuous_a: 100, ambient_c: 150 })),
    { message: "ambient_c must be in the range [-50, 100] C, got 150.0" });
});

test("short circuit: fault_ka and fault_clearing_s must come together; the note names the thermoset limit", () => {
  throwsWith(() => sizeFeeder(feeder({ continuous_a: 100, fault_ka: 20 })), "fault_ka");
  throwsWith(() => sizeFeeder(feeder({ continuous_a: 100, fault_clearing_s: 0.5 })), "fault_ka");
  const r = sizeFeeder(feeder({ continuous_a: 100, fault_ka: 10, fault_clearing_s: 0.5 }));
  const c = r.recommended.checks.find((k) => k.name.startsWith("Short-circuit"));
  for (const t of ["thermoset", "UNVERIFIED", "ICEA P-32-382"]) assert.ok(c.note.includes(t), t);
});

test("raceway grouping assumption notes", () => {
  let r = sizeFeeder(feeder({ continuous_a: 400, length_m: 5, sets: 3 }));
  assert.ok(r.notes.some((n) => n.includes("current_carrying_per_raceway") && n.includes("own raceway")));
  assert.ok(r.recommended.notes.some((n) => n.includes("separate raceways per set")));
  r = sizeFeeder(feeder({ continuous_a: 100, length_m: 5, sets: 1 }));
  assert.ok(!r.recommended.notes.some((n) => n.includes("separate raceways")));
  for (const code of ["NEC", "CEC"]) {
    r = sizeFeeder(feeder({ code, continuous_a: 100, length_m: 5, allow_placeholder_data: true }));
    assert.ok(r.notes.some((n) => n.includes("not checked here")), code);
  }
});

test("lug input validation", () => {
  const bad = (name, kw) => throwsWith(() => selectLugs(lugInput(kw)), name);
  bad("sets_per_phase", { sets_per_phase: 0 });
  bad("phases", { phases: 2 });
  bad("circuit_current_a", { circuit_current_a: 0 });
  bad("circuit_current_a", { circuit_current_a: NaN });
  bad("equipment_terminal_temp_c", { equipment_terminal_temp_c: 0 });
  bad("equipment_terminal_temp_c", { equipment_terminal_temp_c: 80 });
  bad("code", { code: "IEC" });
  bad("material", { material: "Fe" });
  assert.ok(selectLugs(lugInput({ equipment_terminal_temp_c: null })).terminal_temp_basis.includes("defaults"));
  assert.equal(selectLugs(lugInput({ equipment_terminal_temp_c: 90 })).terminal_temp_c, 90);
});

test("validate helpers quote values like Python", () => {
  assert.throws(() => validate.positive("x", 0, "m"), { message: "x must be greater than 0 m, got 0.0" });
  assert.throws(() => validate.nonNegative("x", -1), { message: "x must be 0 or greater, got -1.0" });
  assert.throws(() => validate.countAtLeast("tiers", 0), { message: "tiers must be a whole number of at least 1, got 0" });
  assert.throws(() => validate.integerAtLeast("n", 1.5, 1), { message: "n must be a whole number, got 1.5" });
  assert.throws(() => validate.oneOf("code", "IEC", ["NEC", "CEC"]), { message: "code must be one of ('NEC', 'CEC'), got 'IEC'" });
  assert.throws(() => validate.oneOf("phases", true, [1, 3]), { message: "phases must be one of (1, 3), got True" });
  assert.equal(validate.inRange("t", 100, -50, 100, "C"), 100);
});

// ------------------------------------------------------------------ cable bus review
const CB_TERM = "Most heavily loaded conductor within termination rating";
const WITHSTAND = "Conductor short-circuit withstand";
const LV = { voltage_v: 480, current_a: 2000, conductors_per_phase: 4, size: "500", material: "Cu" };
const MV = { voltage_v: 15000, current_a: 2000, conductors_per_phase: 3, size: "750", insulation: "EPR",
  insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2.0, shield_bonding: "single_point", length_m: 100 };
const cbCheck = (r, prefix) => r.checks.find((c) => c.name.startsWith(prefix)) ?? null;
const notesOf = (r) => r.notes.join(" | ");
const run = (kw) => cb.analyse(cb.cableBusInput(kw));

test("cable bus termination uses Table 310.16, not the free-air table", () => {
  const r = run({ ...LV, terminal_temp_c: 75 });
  const c = cbCheck(r, CB_TERM);
  // Table 310.16 (raceway), 500 kcmil Cu, 75 C = 380 A (free-air Table 310.17 would give 620 A).
  assert.equal(c.limit, 380);
  assert.ok(c.value > 380);
  assert.equal(c.passed, false);
  assert.equal(r.passed, false);
  assert.ok(c.note.includes("310.16"));
});

test("cable bus termination is checked for the datasheet method; notes when it cannot be", () => {
  let r = run({ ...LV, terminal_temp_c: 75, ampacity_method: "datasheet", cable_ampacity_a: 700 });
  assert.equal(cbCheck(r, CB_TERM).limit, 380);
  assert.equal(cbCheck(r, CB_TERM).passed, false);
  r = run(MV);
  assert.equal(cbCheck(r, CB_TERM), null);
  assert.ok(notesOf(r).includes("Termination temperature not checked"));
  // Library DLO sizes such as 444.4 kcmil have no Table 310.16 row.
  r = run({ voltage_v: 600, current_a: 500, conductors_per_phase: 1, cable_type: "dlo_2000v",
    cable_id: "southwire_dlo_2000v:444.4", insulation_temp_c: 90 });
  assert.equal(cbCheck(r, CB_TERM), null);
  assert.ok(notesOf(r).includes("Termination temperature not checked"));
});

test("default terminal temperature: null, 75 C up to 2000 V, 90 C above, explicit value wins", () => {
  assert.equal(cb.cableBusInput().terminal_temp_c, null);
  assert.equal(ds.designRequest().terminal_temp_c, null);
  let r = run(LV);
  assert.equal(r.input.terminal_temp_c, 75);
  assert.ok(notesOf(r).includes("110.14(C)(1)(b)"));
  assert.ok(notesOf(r).includes("370.20(A)"));
  r = run(MV);
  assert.equal(r.input.terminal_temp_c, 90);
  assert.ok(notesOf(r).includes("110.40"));
  r = run({ ...LV, terminal_temp_c: 90 });
  assert.equal(r.input.terminal_temp_c, 90);
  assert.equal(cbCheck(r, CB_TERM).limit, 430); // Table 310.16, 500 kcmil Cu, 90 C
  assert.ok(!notesOf(r).includes("defaulted"));
});

test("tier spacing check applies to the table method with more than one tier", () => {
  const base = { voltage_v: 600, current_a: 2000, conductors_per_phase: 6, tiers: 2, size: "500" };
  let r = run({ ...base, tier_spacing_mm: 40 });
  assert.equal(cbCheck(r, "Tier spacing").passed, false);
  assert.equal(r.passed, false);
  assert.equal(cbCheck(run(base), "Tier spacing").passed, true);
  assert.equal(cbCheck(run({ voltage_v: 600, current_a: 1000, conductors_per_phase: 3, size: "500" }), "Tier spacing"), null);
});

test("fault_ka without fault_clearing_s is a visible failed check", () => {
  const base = { voltage_v: 600, current_a: 1000, conductors_per_phase: 3, size: "500" };
  let r = run({ ...base, fault_ka: 50 });
  const c = cbCheck(r, WITHSTAND);
  assert.equal(c.passed, false);
  assert.ok((c.name + c.note).includes("fault_clearing_s"));
  assert.equal(r.passed, false);
  r = run({ ...base, fault_ka: 10, fault_clearing_s: 0.1 });
  assert.equal(cbCheck(r, WITHSTAND).passed, true);
  assert.ok(cbCheck(r, WITHSTAND).value > 10);
});

test("designer applies the withstand check and passes the shield limit through", () => {
  const base = { voltage_v: 600, current_a: 1000, fault_ka: 100, sizes: ["500"] };
  const short = ds.designOptions(ds.designRequest({ ...base, fault_clearing_s: 0.05 }));
  const long = ds.designOptions(ds.designRequest({ ...base, fault_clearing_s: 5.0 }));
  assert.ok(short.options.some((o) => o.passed));
  assert.ok(!long.options.some((o) => o.passed));
  assert.ok(long.options.every((o) => o.failed_checks.some((f) => f.includes(WITHSTAND))));
  assert.equal(short.options[0].case_inputs.fault_clearing_s, 0.05);
  const mv = ds.designOptions(ds.designRequest({ voltage_v: 15000, current_a: 2000, insulation: "EPR",
    insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2.0, shield_voltage_limit_v: 0.01 }));
  assert.equal(mv.options[0].case_inputs.shield_voltage_limit_v, 0.01);
  assert.ok(mv.options.every((o) => o.failed_checks.some((f) => f.includes("Shield standing voltage"))));
});

test("shield standing voltage note appears for single-point bonding without a limit", () => {
  assert.ok(notesOf(run(MV)).includes("standing voltage was not checked against a limit"));
  assert.ok(!notesOf(run({ ...MV, shield_voltage_limit_v: 1000 })).includes("not checked against a limit"));
});

test("cable bus input validation", () => {
  const raises = (text, kw) => assert.throws(() => run({ ...LV, ...kw }), (e) => new RegExp(text).test(e.message), text);
  raises("current_a must be greater than 0 A", { current_a: 0 });
  raises("current_a must be greater than 0 A", { current_a: -100 });
  raises("length_m must be greater than 0 m", { length_m: 0 });
  raises("frequency_hz must be greater than 0 Hz", { frequency_hz: -60 });
  raises("tiers must be a whole number of at least 1", { tiers: 0 });
  raises("conductors_per_phase must be a whole number of at least 1", { conductors_per_phase: 0 });
  raises("fault_ka must be 0( kA)? or greater", { fault_ka: -5 });
  raises("cable_od_mm .* must be greater than the conductor bare diameter", { cable_od_mm: 10 });
  const req = (kw) => () => ds.designOptions(ds.designRequest({ voltage_v: 480, current_a: 2000, ...kw }));
  assert.throws(req({ current_a: 0 }), /current_a must be greater than 0 A/);
  assert.throws(req({ length_m: -1 }), /length_m must be greater than 0 m/);
  assert.throws(req({ frequency_hz: 0 }), /frequency_hz must be greater than 0 Hz/);
  assert.throws(req({ tier_options: [0] }), /tiers/);
  assert.throws(req({ fault_ka: -1 }), /fault_ka must be 0( kA)? or greater/);
});

test("ambient at the conductor rating is rejected on every ampacity path", () => {
  const msg = /ambient_c \(90 C\) must be below the conductor temperature rating \(90 C\)/;
  assert.throws(() => run({ ...LV, ambient_c: 90 }), msg);
  assert.throws(() => run({ ...LV, ambient_c: 90, ampacity_method: "datasheet", cable_ampacity_a: 600 }), msg);
  assert.throws(() => ds.designOptions(ds.designRequest({ voltage_v: 480, current_a: 2000, ambient_c: 90 })), msg);
  assert.throws(() => run({ ...MV, ambient_c: 90 }), msg);
});

test("designer ranking: tagged and top-ranked options pass, passing options come first", () => {
  let r = ds.designOptions(ds.designRequest({ voltage_v: 480, current_a: 2000, fault_ka: 100, x_over_r: 20,
    fault_clearing_s: 0.5 }));
  assert.ok(r.options.length);
  for (const o of r.options) if (o.tags.length) assert.ok(o.passed, `tagged option failing: ${o.failed_checks}`);
  assert.ok(r.options[0].passed);
  let seenFail = false;
  for (const o of r.options) {
    seenFail = seenFail || !o.passed;
    if (seenFail) assert.equal(o.passed, false);
  }
  r = ds.designOptions(ds.designRequest({ voltage_v: 480, current_a: 2000, fault_ka: 100, x_over_r: 20,
    block_rated_load_n: 500 }));
  assert.ok(r.options.every((o) => o.passed || o.tags.length === 0));
});

test("600 V insulation wall note above 600 V without a cable OD", () => {
  let r = run({ voltage_v: 1000, current_a: 1000, conductors_per_phase: 2, size: "750" });
  assert.ok(notesOf(r).includes("estimated from a 600 V insulation wall"));
  assert.ok(notesOf(r).includes("cable_od_mm"));
  r = run({ voltage_v: 1000, current_a: 1000, conductors_per_phase: 2, size: "750", cable_od_mm: 40 });
  assert.ok(!notesOf(r).includes("600 V insulation wall"));
  r = run({ voltage_v: 600, current_a: 1000, conductors_per_phase: 2, size: "750" });
  assert.ok(!notesOf(r).includes("600 V insulation wall"));
  const d = ds.designOptions(ds.designRequest({ voltage_v: 1000, current_a: 1000, sizes: ["750"] }));
  assert.ok(d.notes.join(" ").includes("600 V insulation wall"));
});

test("calculated method cites NEC 310.14(B) and 315.60(B)", () => {
  const text = notesOf(run(MV));
  assert.ok(text.includes("310.14(B)"));
  assert.ok(text.includes("315.60(B)"));
});
