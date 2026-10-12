import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_SYSTEM, analyseSystem } from "../src/engine/system.js";
import { parseSystem, serializeSystem } from "../src/engine/systemio.js";
import { designChecks } from "../src/engine/designchecks.js";
import {
  planPush, applyPush, pushTargets, systemKv, convert, STALE_STUDIES, PUSH_MODULES,
  feederDesign, cableBusDesign, switchgearDesign, transformerDesign,
} from "../src/engine/designPush.js";
import { feederInput, sizeFeeder } from "../src/engine/pecalc/sizing.js";
import { cableBusInput, analyse as analyseCableBus } from "../src/engine/pecalc/cablebus.js";
import { busInput, analyseBus } from "../src/engine/pecalc/switchgear.js";
import { transformerInput, design_for_impedance } from "../src/engine/pecalc/transformer.js";

const sys0 = () => JSON.parse(JSON.stringify(EXAMPLE_SYSTEM));
const con = (s, id) => s.connectors.find((c) => c.id === id);
const eq = (s, id) => s.equipment.find((e) => e.id === id);
const row = (plan, f) => plan.diff.find((r) => r.field === f);
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

/* a hand-written feeder design (what feederDesign builds), so each test can vary one field */
const feeder = (o = {}) => ({
  module: "feeder", phases: 3, voltage: { value: 480, unit: "V" }, size: "500", sets: 3, material: "Cu",
  insulation: { value: 90, unit: "°C" }, length: { value: 60, unit: "m" }, conduit: "pvc", installation: "raceway",
  ampacity_per_set: { value: 380, unit: "A" }, passed: true, failed_checks: [], ...o,
});

/* ------------------------------------------------------------------ units */
test("convert handles each dimension and rejects foreign units", () => {
  close(convert({ value: 30.48, unit: "m" }, "length", "L"), 100);
  close(convert({ value: 1200, unit: "in" }, "length", "L"), 100);
  close(convert({ value: 480, unit: "V" }, "voltage", "V"), 0.48);
  close(convert({ value: 2.5, unit: "MVA" }, "power", "S"), 2500);
  close(convert({ value: 0.0575, unit: "pu" }, "percent", "Z"), 5.75);
  close(convert({ value: 65000, unit: "A" }, "fault", "Ik"), 65);
  close(convert({ value: 0.25, unit: "in" }, "busdim", "t"), 6.35);
  assert.throws(() => convert({ value: 100, unit: "kV" }, "length", "Feeder length"), /not a length unit/);
  assert.throws(() => convert(100, "length", "Feeder length"), /must carry its unit/);
  assert.throws(() => convert(null, "voltage", "HV voltage"), /missing/);
});

/* ---------------------------------------------------------------- targets */
test("pushTargets lists only compatible elements with their System kV", () => {
  const s = sys0();
  const cables = pushTargets(s, "feeder");
  assert.ok(cables.every((t) => t.type === "cable" && t.kind === "con"));
  assert.ok(cables.some((t) => t.id === "C-MCC" && Math.abs(t.kv - 0.48) < 1e-12));
  assert.deepEqual(pushTargets(s, "cablebus").map((t) => t.id), ["CB-1", "CB-2"]);
  assert.deepEqual(pushTargets(s, "switchgear").map((t) => t.id), ["SWGR-MV", "SWGR-LV", "MCC-1", "SWGR-5"]);
  assert.deepEqual(pushTargets(s, "transformer").map((t) => t.id), ["T1", "T2"]);
  assert.deepEqual(pushTargets(s, "nope"), []);
});

test("systemKv sees through open feeder breakers", () => {
  const s = sys0(); con(s, "C-MCC").closed = false;
  assert.equal(systemKv(s).con["C-MCC"], 0.48);
});

/* ----------------------------------------------------------------- feeder */
test("feeder: writes size, sets, material, insulation, length (m → ft), conduit and ampacity", () => {
  const s = sys0();
  const plan = planPush(s, { kind: "con", id: "C-MCC" }, feeder());
  assert.equal(plan.ok, true, plan.errors.join());
  assert.deepEqual(plan.target, { kind: "con", id: "C-MCC", type: "cable" });
  close(plan.patch.length_ft, 196.85, 1e-5);
  assert.equal(plan.patch.raceway, "pvc");
  assert.equal(plan.patch.insulation_c, 90);
  assert.equal(plan.patch.ampacity_a, 380);
  assert.deepEqual(row(plan, "sets"), { field: "sets", label: "Sets per phase", unit: "", old: 2, new: 3, changed: true });
  assert.equal(row(plan, "size").changed, false);              // already 500 kcmil
  assert.equal(row(plan, "raceway").old, "steel");             // catalogue default shows as the old value
  assert.deepEqual(plan.stale, STALE_STUDIES);

  const next = applyPush(s, plan);
  assert.notEqual(next, s);
  assert.equal(con(s, "C-MCC").sets, 2, "input system is not mutated");
  assert.equal(con(next, "C-MCC").sets, 3);
  // impedance is recomputed from the new conductors
  const zOld = analyseSystem(s).connectors["C-MCC"].ohms, zNew = analyseSystem(next).connectors["C-MCC"].ohms;
  assert.ok(zNew.r < zOld.r && zNew.x < zOld.x);
  // the pushed fields survive a project save/load
  const back = parseSystem(serializeSystem(next));
  assert.deepEqual({ ...con(back, "C-MCC") }, { ...con(next, "C-MCC"), closed: true });
});

test("feeder: a length entered in ft round-trips exactly", () => {
  const plan = planPush(sys0(), { kind: "con", id: "C-MCC" }, feeder({ length: { value: 220 * 0.3048, unit: "m" } }));
  assert.equal(plan.patch.length_ft, 220);
  assert.equal(row(plan, "length_ft").changed, false);
});

test("feeder: built from a real sizeFeeder result", () => {
  const r = sizeFeeder(feederInput({ voltage_v: 480, continuous_a: 400, length_m: 67, conduit: "steel", insulation_temp_c: 75 }));
  const d = feederDesign(r);
  const plan = planPush(sys0(), { kind: "con", id: "C-MCC" }, d);
  assert.equal(plan.ok, true, plan.errors.join());
  assert.equal(plan.patch.size, r.recommended.size);
  assert.equal(plan.patch.sets, r.recommended.sets);
  assert.equal(plan.patch.ampacity_a, r.recommended.ampacity_per_set_a);
  close(plan.patch.length_ft, 67 / 0.3048, 1e-5);
});

test("feeder: rejections", () => {
  const s = sys0(), T = { kind: "con", id: "C-MCC" };
  const why = (d, t = T) => { const p = planPush(s, t, d); assert.equal(p.ok, false); assert.equal(p.patch, null); return p.errors.join(" "); };
  assert.match(why(feeder(), { kind: "con", id: "CB-1" }), /Feeder designs go to a cable; CB-1 is a cable bus/);
  assert.match(why(feeder(), { kind: "eq", id: "SWGR-LV" }), /SWGR-LV is a switchgear/);
  assert.match(why(feeder(), { kind: "con", id: "C-NOPE" }), /no longer exists/);
  assert.match(why(feeder(), null), /Pick the System run/);
  assert.match(why(feeder({ voltage: { value: 4160, unit: "V" } })), /4\.16 kV but C-MCC runs at 480 V/);
  assert.match(why(feeder({ voltage: { value: 480, unit: "ft" } })), /not a voltage unit/);
  assert.match(why(feeder({ length: { value: 60, unit: "kA" } })), /not a length unit/);
  assert.match(why(feeder({ phases: 1 })), /three-phase/);
  assert.match(why(feeder({ size: "700" })), /no impedance data for 700 kcmil/);
  assert.match(why(feeder({ size: "13" })), /Unknown conductor size/);
  assert.match(why(feeder({ insulation: { value: 105, unit: "°C" } })), /60, 75 and 90/);
  assert.match(why(feeder({ sets: 1.5 })), /whole number/);
  assert.match(why({ module: "lighting" }), /Unknown design module/);
});

test("feeder: a design that fails its own checks is allowed with a warning", () => {
  const p = planPush(sys0(), { kind: "con", id: "C-MCC" }, feeder({ passed: false, failed_checks: ["Voltage drop"] }));
  assert.equal(p.ok, true);
  assert.match(p.warnings.join(), /fails Voltage drop/);
});

test("feeder: no recommended conductor means no design", () => {
  assert.throws(() => feederDesign({ input: {}, recommended: null }), /No conductor passes/);
});

/* --------------------------------------------------------------- cable bus */
test("cable bus: writes conductors, sets, length and a sharing-aware rating per set", () => {
  const res = analyseCableBus(cableBusInput({ voltage_v: 480, current_a: 3000, size: "750", material: "Cu", conductors_per_phase: 5, tiers: 1, length_m: 25, insulation_temp_c: 90, terminal_temp_c: 90 }));
  const d = cableBusDesign(res);
  close(d.rating.value, (3000 * 100) / res.max_loading_pct);
  const s = sys0();
  const plan = planPush(s, { kind: "con", id: "CB-1" }, d);
  assert.equal(plan.ok, true, plan.errors.join());
  assert.equal(plan.patch.sets, 5);
  assert.equal(plan.patch.size, "750");
  close(plan.patch.length_ft, 25 / 0.3048, 1e-5);
  close(plan.patch.ampacity_a, Math.round((d.rating.value / 5) * 10) / 10);
  assert.deepEqual(row(plan, "sets"), { field: "sets", label: "Sets per phase", unit: "", old: 4, new: 5, changed: true });
  const next = applyPush(s, plan);
  const a = analyseSystem(next).connectors["CB-1"];
  close(a.ampacity_a, plan.patch.ampacity_a * 5);
});

test("cable bus: rejections", () => {
  const s = sys0();
  const d = { module: "cablebus", voltage: { value: 480, unit: "V" }, size: "750", sets: 4, material: "Cu", insulation: { value: 90, unit: "°C" }, length: { value: 60, unit: "ft" }, rating: { value: 2400, unit: "A" } };
  assert.equal(planPush(s, { kind: "con", id: "CB-1" }, d).ok, true);
  assert.match(planPush(s, { kind: "con", id: "C-MCC" }, d).errors.join(), /Cable bus designs go to a cable bus; C-MCC is a cable/);
  assert.match(planPush(s, { kind: "con", id: "CB-2" }, d).errors.join(), /480 V but CB-2 runs at 4\.16 kV/);
  assert.match(planPush(s, { kind: "con", id: "CB-1" }, { ...d, size: "1250" }).errors.join(), /no impedance data for 1250 kcmil/);
  assert.match(planPush(s, { kind: "con", id: "CB-1" }, { ...d, rating: { value: 2.4, unit: "MVA" } }).errors.join(), /not a current unit/);
  assert.equal(planPush(s, { kind: "con", id: "CB-1" }, { ...d, rating: { value: 2.4, unit: "kA" } }).patch.ampacity_a, 600);
});

/* -------------------------------------------------------------- switchgear */
const bus = (o = {}) => ({
  module: "switchgear", voltage: { value: 600, unit: "V" }, current: { value: 5000, unit: "A" }, fault: { value: 85, unit: "kA" },
  rated_current: { value: 5200, unit: "A" }, bars_per_phase: 4, bar_width: { value: 6, unit: "in" }, bar_thickness: { value: 0.25, unit: "in" },
  phase_spacing: { value: 200, unit: "mm" }, support_span: { value: 600, unit: "mm" }, material: "Cu", orientation: "edge_to_edge", ...o,
});

test("switchgear: writes bus rating, SC withstand and bus geometry (in → mm)", () => {
  const s = sys0();
  const plan = planPush(s, { kind: "eq", id: "SWGR-LV" }, bus());
  assert.equal(plan.ok, true, plan.errors.join());
  assert.deepEqual(row(plan, "bus_a"), { field: "bus_a", label: "Bus rating", unit: "A", old: 4000, new: 5000, changed: true });
  assert.deepEqual(row(plan, "sc_ka"), { field: "sc_ka", label: "SC rating", unit: "kA", old: 65, new: 85, changed: true });
  assert.equal(plan.patch.bar_width_mm, 152.4);
  assert.equal(plan.patch.bar_thickness_mm, 6.35);
  assert.equal(plan.patch.support_span_m, 0.6);
  assert.equal(row(plan, "bar_width_mm").old, null);
  const next = applyPush(s, plan);
  const r = analyseSystem(next).equipment["SWGR-LV"];
  close(r.sc_duty_pct, (100 * r.ik_ka) / 85);
  // the System design check now uses the pushed bars instead of sizing its own
  const dc = designChecks(next, analyseSystem(next))["SWGR-LV"];
  assert.equal(dc.result.sized, false);
  assert.equal(dc.result.input.bars_per_phase, 4);
});

test("switchgear: works for MCCs and from a real analyseBus result; fault kA given in A", () => {
  const res = analyseBus(busInput({ current_a: 800, voltage_v: 600, bars_per_phase: 1, bar_width_mm: 101.6, fault_ka: 42, filaments_thickness: 2, filaments_width: 6 }));
  const d = switchgearDesign(res);
  const plan = planPush(sys0(), { kind: "eq", id: "MCC-1" }, { ...d, fault: { value: 50000, unit: "A" } });
  assert.equal(plan.ok, true, plan.errors.join());
  assert.equal(plan.patch.sc_ka, 50);
  assert.equal(row(plan, "bus_a").changed, false);
});

test("switchgear: warnings and rejections", () => {
  const s = sys0(), T = { kind: "eq", id: "SWGR-LV" };
  const p1 = planPush(s, T, bus({ fault: null, rated_current: { value: 4200, unit: "A" } }));
  assert.equal(p1.ok, true);
  assert.equal("sc_ka" in p1.patch, false);
  assert.match(p1.warnings.join(" "), /no fault level/);
  assert.match(p1.warnings.join(" "), /4200 A at the temperature-rise limit, below the 5000 A/);
  assert.match(planPush(s, { kind: "eq", id: "SWGR-5" }, bus()).errors.join(), /rated 600 V but SWGR-5 runs at 4\.16 kV/);
  assert.match(planPush(s, { kind: "eq", id: "T1" }, bus()).errors.join(), /Switchgear bus designs go to a switchgear \/ motor control center \/ panelboard; T1 is a transformer/);
  assert.match(planPush(s, T, bus({ current: { value: 5, unit: "kV" } })).errors.join(), /not a current unit/);
  assert.match(planPush(s, T, bus({ bar_width: { value: 6, unit: "kg" } })).errors.join(), /not a busdim unit/);
  // a 15 kV-class bus on 480 V gear is allowed but flagged
  assert.match(planPush(s, T, bus({ voltage: { value: 15, unit: "kV" } })).warnings.join(), /different voltage class/);
});

/* ------------------------------------------------------------- transformer */
test("transformer: writes kVA, voltages (V → kV), %Z and X/R from the achieved design", () => {
  const res = design_for_impedance(transformerInput({ kva: 3000, hv_v: 13800, lv_v: 480, target_z_pct: 6.0 }));
  const d = transformerDesign(res);
  const s = sys0();
  const plan = planPush(s, { kind: "eq", id: "T1" }, d);
  assert.equal(plan.ok, true, plan.errors.join());
  assert.equal(plan.patch.kva, 3000);
  assert.equal(plan.patch.hv_kv, 13.8);
  assert.equal(plan.patch.lv_kv, 0.48);
  assert.equal(plan.patch.z_pct, res.impedance.z_pct);
  assert.equal(plan.patch.xr, res.impedance.x_over_r);
  assert.equal(row(plan, "hv_kv").changed, false);
  assert.deepEqual(row(plan, "kva"), { field: "kva", label: "Rating", unit: "kVA", old: 2500, new: 3000, changed: true });
  const next = applyPush(s, plan);
  assert.ok(analyseSystem(next).equipment["SWGR-LV"].ik_ka !== analyseSystem(s).equipment["SWGR-LV"].ik_ka);
});

test("transformer: MVA and per-unit impedance are converted", () => {
  const d = { module: "transformer", power: { value: 2.5, unit: "MVA" }, hv: { value: 13.8, unit: "kV" }, lv: { value: 480, unit: "V" }, z: { value: 0.0575, unit: "pu" }, xr: { value: 7, unit: "" } };
  const plan = planPush(sys0(), { kind: "eq", id: "T1" }, d);
  assert.equal(plan.ok, true, plan.errors.join());
  assert.equal(plan.changed, 0, "identical to the example T1");
  assert.deepEqual(plan.stale, []);
});

test("transformer: rejects voltages that do not fit the System and wrong element types", () => {
  const s = sys0();
  const d = (o = {}) => ({ module: "transformer", power: { value: 2500, unit: "kVA" }, hv: { value: 13800, unit: "V" }, lv: { value: 480, unit: "V" }, z: { value: 5.75, unit: "%" }, xr: { value: 7, unit: "" }, ...o });
  assert.match(planPush(s, { kind: "eq", id: "T1" }, d({ hv: { value: 12470, unit: "V" } })).errors.join(), /would break the System model: .*12\.47 kV/);
  assert.match(planPush(s, { kind: "eq", id: "T1" }, d({ lv: { value: 600, unit: "V" } })).errors.join(), /would break the System model/);
  assert.match(planPush(s, { kind: "eq", id: "T1" }, d({ hv: { value: 480, unit: "V" }, lv: { value: 13800, unit: "V" } })).errors.join(), /steps down/);
  assert.match(planPush(s, { kind: "eq", id: "T1" }, d({ power: { value: 2500, unit: "kW" } })).errors.join(), /not a power unit/);
  assert.match(planPush(s, { kind: "con", id: "CB-1" }, d()).errors.join(), /Transformer designs go to a transformer; CB-1 is a cable bus/);
  assert.match(planPush(s, { kind: "eq", id: "MCC-1" }, d()).errors.join(), /MCC-1 is a motor control center/);
});

/* ------------------------------------------------------------------ apply */
test("applyPush refuses rejected plans and vanished targets", () => {
  const s = sys0();
  assert.throws(() => applyPush(s, planPush(s, { kind: "con", id: "CB-1" }, feeder())), /Feeder designs go to a cable/);
  const plan = planPush(s, { kind: "con", id: "C-MCC" }, feeder());
  const gone = { ...s, connectors: s.connectors.filter((c) => c.id !== "C-MCC") };
  assert.throws(() => applyPush(gone, plan), /no longer exists/);
});

test("every module has a mapper and a target kind", () => {
  for (const [k, m] of Object.entries(PUSH_MODULES)) {
    assert.ok(["con", "eq"].includes(m.element), k);
    assert.ok(pushTargets(sys0(), k).length > 0, k);
  }
});
