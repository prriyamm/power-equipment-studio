/* ============================================================================
 * Design push: module workspaces → System model.
 *
 * Data normally flows System → modules (a run or a piece of gear is opened in
 * the Feeder, Cable bus, Switchgear or Transformer workspace). This module is the
 * reverse direction: a finished module design is mapped onto the System element
 * it belongs to, as a field patch with a reviewable old → new diff.
 *
 * A design is a plain object { module, ...fields }. Every dimensioned field is a
 * quantity { value, unit } so a design carries its own units; the mapping
 * converts to the System's units (ft, kV, kVA, A, kA, %, mm, m) and rejects any
 * unit it does not know. Builders (feederDesign, cableBusDesign, switchgearDesign,
 * transformerDesign) turn the pecalc results each workspace already has into a
 * design. Pure: no DOM, no React, no globals.
 * ========================================================================== */
import { EQUIPMENT, CONNECTORS, CONDUCTOR_SIZES, compileSystem } from "./system.js";
import { normalizeSize, sizeLabel } from "./pecalc/conductors.js";
import { isDerivedReactance } from "./reactanceDerived.js";
import AMPACITY from "./pecalc/data/ampacity_nec.json" with { type: "json" };

/** Which System elements each module can write to. */
export const PUSH_MODULES = {
  feeder: { label: "Feeder", element: "con", kinds: ["cable"] },
  cablebus: { label: "Cable bus", element: "con", kinds: ["cablebus"] },
  switchgear: { label: "Switchgear bus", element: "eq", kinds: ["switchgear", "mcc", "panel"] },
  transformer: { label: "Transformer", element: "eq", kinds: ["transformer"] },
};
/** Studies whose results no longer describe the model after a push. */
export const STALE_STUDIES = ["loadflow", "shortcircuit", "designchecks"];
export const STUDY_LABELS = { loadflow: "Load flow", shortcircuit: "Short circuit", designchecks: "Design checks" };

/* ------------------------------------------------------------------- units */
// factor to the System unit, per dimension
const UNITS = {
  length: { to: "ft", f: { ft: 1, m: 1 / 0.3048, in: 1 / 12, mm: 1 / 304.8 } },
  voltage: { to: "kV", f: { kV: 1, V: 1e-3 } },
  power: { to: "kVA", f: { kVA: 1, MVA: 1000, VA: 1e-3 } },
  current: { to: "A", f: { A: 1, kA: 1000 } },
  fault: { to: "kA", f: { kA: 1, A: 1e-3 } },
  percent: { to: "%", f: { "%": 1, pu: 100 } },
  ratio: { to: "", f: { "": 1 } },
  temperature: { to: "°C", f: { "°C": 1, C: 1 } },
  busdim: { to: "mm", f: { mm: 1, in: 25.4, m: 1000 } },
  span: { to: "m", f: { m: 1, mm: 1e-3, ft: 0.3048, in: 0.0254 } },
};
/** Converts a quantity {value, unit} to the System unit of a dimension; throws a readable error. */
export function convert(q, dim, what) {
  const d = UNITS[dim];
  if (q === null || q === undefined) throw new Error(`${what} is missing.`);
  if (typeof q !== "object" || !("value" in q)) throw new Error(`${what} must carry its unit ({ value, unit }).`);
  const unit = q.unit ?? "";
  if (!(unit in d.f)) throw new Error(`${what} is in "${unit}", which is not a ${dim} unit (expected ${Object.keys(d.f).filter(Boolean).join(", ") || "a plain ratio"}).`);
  const v = Number(q.value);
  if (!isFinite(v)) throw new Error(`${what} is not a number.`);
  return v * d.f[unit];
}
const q = (value, unit) => ({ value, unit });
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const same = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const fmtKv = (kv) => (kv < 1 ? `${round(kv * 1000, 1)} V` : `${round(kv, 4)} kV`);

/* ---------------------------------------------------------------- System side */
/** Nominal kV seen by every connector and every equipment terminal, with all feeder breakers closed. */
export function systemKv(sys) {
  const closed = { ...sys, connectors: (sys.connectors || []).map((c) => ({ ...c, closed: true })) };
  const c = compileSystem(closed);
  const kvAt = (end) => { const b = c.busOf(end); return b == null ? null : c.busMeta[b - 1]?.kv ?? null; };
  const out = { con: {}, eq: {} };
  for (const cn of sys.connectors || []) out.con[cn.id] = kvAt(cn.from) ?? kvAt(cn.to);
  for (const e of sys.equipment || []) out.eq[e.id] = kvAt(`${e.id}.${EQUIPMENT[e.type]?.terminals[0]}`);
  return out;
}

function findElement(sys, target) {
  if (!target || !target.id) return null;
  if (target.kind === "con") { const c = (sys.connectors || []).find((x) => x.id === target.id); return c && { kind: "con", type: c.kind, raw: c, full: { ...(CONNECTORS[c.kind]?.defaults || {}), ...c } }; }
  if (target.kind === "eq") { const e = (sys.equipment || []).find((x) => x.id === target.id); return e && { kind: "eq", type: e.type, raw: e, full: { ...(EQUIPMENT[e.type]?.defaults || {}), ...e } }; }
  return null;
}
const typeLabel = (el) => (el.kind === "con" ? CONNECTORS[el.type]?.label : EQUIPMENT[el.type]?.label) || el.type;

/** System elements a module can push to, for the target picker. */
export function pushTargets(sys, module) {
  const m = PUSH_MODULES[module]; if (!m || !sys) return [];
  const kv = systemKv(sys);
  const list = m.element === "con" ? (sys.connectors || []).filter((c) => m.kinds.includes(c.kind)).map((c) => ({ kind: "con", id: c.id, type: c.kind, label: `${c.id} · ${c.from} → ${c.to}`, kv: kv.con[c.id] }))
    : (sys.equipment || []).filter((e) => m.kinds.includes(e.type)).map((e) => ({ kind: "eq", id: e.id, type: e.type, label: `${e.id}${e.name && e.name !== e.id ? ` · ${e.name}` : ""}`, kv: e.type === "transformer" ? null : kv.eq[e.id] }));
  return list;
}

/* ------------------------------------------------------------- per-module maps */
const LABELS = {
  size: ["Conductor size", "AWG/kcmil"], sets: ["Sets per phase", ""], material: ["Material", ""], insulation_c: ["Conductor temp", "°C"],
  length_ft: ["Length", "ft"], raceway: ["Raceway", ""], ampacity_a: ["Ampacity / set", "A"],
  bus_a: ["Bus rating", "A"], sc_ka: ["SC rating", "kA"], bars_per_phase: ["Bars per phase", ""], bar_width_mm: ["Bar width", "mm"],
  bar_thickness_mm: ["Bar thickness", "mm"], phase_spacing_mm: ["Phase spacing", "mm"], support_span_m: ["Support span", "m"],
  bus_material: ["Bus material", ""], bus_orientation: ["Bar orientation", ""],
  kva: ["Rating", "kVA"], hv_kv: ["HV", "kV"], lv_kv: ["LV", "kV"], z_pct: ["Impedance", "%Z"], xr: ["X/R", ""],
};

// A size is accepted only when the System has resistance (pecalc conductor model), ampacity (NEC table data)
// and reactance for it. Reactance for sizes without an NEC Table 9 row is derived, which the preview flags.
function checkSize(size, errors, warnings, material = "Cu") {
  let k; try { k = normalizeSize(size); } catch (e) { errors.push(e.message); return null; }
  if (!CONDUCTOR_SIZES.includes(k)) { errors.push(`The System has no impedance data for ${sizeLabel(k)}; it models ${CONDUCTOR_SIZES.join(", ")}.`); return null; }
  if (AMPACITY.raceway?.[material]?.[k] == null || AMPACITY.free_air?.[material]?.[k] == null) { errors.push(`The System has no ${material} ampacity data for ${sizeLabel(k)}.`); return null; }
  if (isDerivedReactance(k)) warnings.push(`Reactance for ${sizeLabel(k)} is ${["700", "800", "900"].includes(k) ? "interpolated" : "extrapolated"}, not from NEC Table 9 (DERIVED — UNVERIFIED).`);
  return k;
}
function checkVoltage(designKv, systemKvValue, id, errors, warnings, { rated = false } = {}) {
  if (systemKvValue == null) { warnings.push(`No voltage reaches ${id} in the System, so the design voltage (${fmtKv(designKv)}) could not be checked.`); return; }
  if (rated) {
    if (designKv < systemKvValue * 0.99) errors.push(`The design is rated ${fmtKv(designKv)} but ${id} runs at ${fmtKv(systemKvValue)}.`);
    else if ((designKv > 1) !== (systemKvValue > 1)) warnings.push(`The design is rated ${fmtKv(designKv)} for ${fmtKv(systemKvValue)} equipment (different voltage class).`);
    return;
  }
  if (Math.abs(designKv - systemKvValue) > 0.01 * systemKvValue) errors.push(`The design is for ${fmtKv(designKv)} but ${id} runs at ${fmtKv(systemKvValue)}.`);
}
function failedChecks(design, warnings) {
  if (design.passed === false) warnings.push(`The design fails ${design.failed_checks?.length ? design.failed_checks.join("; ") : "one or more of its checks"}.`);
}

const MAPPERS = {
  feeder(d, el, ctx, errors, warnings, notes) {
    if (d.phases !== 3) errors.push(`System runs are three-phase; this feeder is ${d.phases}-phase.`);
    checkVoltage(convert(d.voltage, "voltage", "Feeder voltage"), ctx.kv, el.raw.id, errors, warnings);
    const size = checkSize(d.size, errors, warnings, d.material);
    if (!["Cu", "Al"].includes(d.material)) errors.push(`Unknown conductor material "${d.material}".`);
    const ins = convert(d.insulation, "temperature", "Insulation rating");
    if (![60, 75, 90].includes(ins)) errors.push(`The System models 60, 75 and 90 °C conductors, not ${ins} °C.`);
    if (!["steel", "aluminum", "pvc"].includes(d.conduit)) errors.push(`Unknown conduit type "${d.conduit}".`);
    if (d.installation && d.installation !== "raceway") warnings.push("The feeder is sized in free air; the System models cable runs in raceway (reactance from the conduit type). The free-air ampacity is carried over.");
    if (!(Number.isInteger(d.sets) && d.sets >= 1)) errors.push(`Sets per phase must be a whole number ≥ 1 (got ${d.sets}).`);
    const len = convert(d.length, "length", "Feeder length");
    if (!(len > 0)) errors.push("Feeder length must be positive.");
    const amp = d.ampacity_per_set == null ? null : convert(d.ampacity_per_set, "current", "Ampacity per set");
    failedChecks(d, warnings);
    const patch = { size, sets: d.sets, material: d.material, insulation_c: ins, length_ft: round(len, 3), raceway: d.conduit };
    if (amp != null) patch.ampacity_a = round(amp, 1);
    return patch;
  },
  cablebus(d, el, ctx, errors, warnings, notes) {
    checkVoltage(convert(d.voltage, "voltage", "Cable bus voltage"), ctx.kv, el.raw.id, errors, warnings);
    const size = checkSize(d.size, errors, warnings, d.material);
    if (!["Cu", "Al"].includes(d.material)) errors.push(`Unknown conductor material "${d.material}".`);
    const ins = convert(d.insulation, "temperature", "Insulation rating");
    if (![60, 75, 90].includes(ins)) errors.push(`The System models 60, 75 and 90 °C conductors, not ${ins} °C.`);
    if (!(Number.isInteger(d.sets) && d.sets >= 1)) errors.push(`Conductors per phase must be a whole number ≥ 1 (got ${d.sets}).`);
    const len = convert(d.length, "length", "Cable bus length");
    if (!(len > 0)) errors.push("Cable bus length must be positive.");
    const rating = convert(d.rating, "current", "Cable bus rating");
    if (!(rating > 0)) errors.push("Cable bus rating must be positive.");
    failedChecks(d, warnings);
    return { size, sets: d.sets, material: d.material, insulation_c: ins, length_ft: round(len, 3), ampacity_a: round(rating / Math.max(d.sets, 1), 1) };
  },
  switchgear(d, el, ctx, errors, warnings, notes) {
    checkVoltage(convert(d.voltage, "voltage", "Bus rated voltage"), ctx.kv, el.raw.id, errors, warnings, { rated: true });
    const busA = convert(d.current, "current", "Bus rating");
    if (!(busA > 0)) errors.push("Bus rating must be positive.");
    // The System bus rating is the lower of the design current and what the bars carry at the
    // temperature-rise limit: a bus rated above its thermal capability would understate loading.
    let rating = busA;
    if (d.rated_current == null) warnings.push(`The bus design has no temperature-rise rating to compare against, so the design current (${round(busA, 0)} A) is sent as the bus rating.`);
    else {
      const ra = convert(d.rated_current, "current", "Rating at the rise limit");
      if (!(ra > 0)) errors.push("Rating at the rise limit must be positive.");
      else if (ra < busA) { rating = ra; notes.push(`Bus rating limited to ${round(ra, 0)} A by temperature rise (design current ${round(busA, 0)} A).`); }
    }
    const patch = { bus_a: round(rating, 1) };
    if (d.fault == null) warnings.push("The bus design has no fault level, so the short-circuit rating is left as it is.");
    else { const ka = convert(d.fault, "fault", "Short-circuit withstand"); if (!(ka > 0)) errors.push("Short-circuit withstand must be positive."); patch.sc_ka = round(ka, 3); }
    if (d.bars_per_phase != null) {
      if (!(Number.isInteger(d.bars_per_phase) && d.bars_per_phase >= 1)) errors.push(`Bars per phase must be a whole number ≥ 1 (got ${d.bars_per_phase}).`);
      Object.assign(patch, {
        bars_per_phase: d.bars_per_phase,
        bar_width_mm: round(convert(d.bar_width, "busdim", "Bar width"), 3),
        bar_thickness_mm: round(convert(d.bar_thickness, "busdim", "Bar thickness"), 3),
        phase_spacing_mm: round(convert(d.phase_spacing, "busdim", "Phase spacing"), 3),
        support_span_m: round(convert(d.support_span, "span", "Support span"), 4),
      });
      if (d.material) { if (!["Cu", "Al"].includes(d.material)) errors.push(`Unknown bus material "${d.material}".`); else patch.bus_material = d.material; }
      if (d.orientation) patch.bus_orientation = d.orientation;
    }
    failedChecks(d, warnings);
    return patch;
  },
  transformer(d, el, ctx, errors, warnings, notes) {
    const kva = convert(d.power, "power", "Transformer rating");
    const hv = convert(d.hv, "voltage", "HV voltage"), lv = convert(d.lv, "voltage", "LV voltage");
    const z = convert(d.z, "percent", "Impedance"), xr = convert(d.xr, "ratio", "X/R");
    if (!(kva > 0)) errors.push("Transformer rating must be positive.");
    if (!(hv > lv && lv > 0)) errors.push(`The System transformer steps down from its HV to its LV terminal; got HV ${fmtKv(hv)}, LV ${fmtKv(lv)}.`);
    if (!(z > 0 && z < 100)) errors.push(`Impedance must be between 0 and 100 %Z (got ${z}).`);
    if (!(xr > 0)) errors.push("X/R must be positive.");
    failedChecks(d, warnings);
    // Connection and cooling stay as they are in the System: the workspace's delta/wye and liquid/dry do not
    // determine the System's vector group (which carries a phase shift, e.g. Dyn1) or its cooling class (ONAN, ONAF, …).
    notes.push("Connection and cooling are not changed by this push.");
    return { kva: round(kva, 3), hv_kv: round(hv, 6), lv_kv: round(lv, 6), z_pct: round(z, 3), xr: round(xr, 3) };
  },
};

/* --------------------------------------------------------------------- plan */
/**
 * Maps a design onto a System element. Returns
 *   { ok, module, target: {kind, id, type}, patch, diff: [{field, label, unit, old, new, changed}],
 *     changed, warnings, notes, errors, stale }   (notes: informational lines for the preview)
 * ok is false (and patch null) when the element is missing, of the wrong type, the units or voltage
 * do not match, or applying the patch would add an error to the System model.
 */
export function planPush(sys, target, design) {
  const errors = [], warnings = [], notes = [];
  const fail = (msg) => ({ ok: false, module: design?.module, target: target ? { ...target } : null, patch: null, diff: [], changed: 0, warnings, notes, errors: [...errors, ...(msg ? [msg] : [])], stale: [] });
  const m = PUSH_MODULES[design?.module];
  if (!m) return fail(`Unknown design module "${design?.module}".`);
  if (!sys) return fail("No System model is open.");
  if (!target?.id) return fail(`Pick the System ${m.element === "con" ? "run" : "equipment"} this ${m.label.toLowerCase()} design belongs to.`);
  const el = findElement(sys, target);
  if (!el) return fail(`${target.id} no longer exists in the System.`);
  if (el.kind !== m.element || !m.kinds.includes(el.type)) {
    const want = m.kinds.map((k) => (m.element === "con" ? CONNECTORS[k] : EQUIPMENT[k]).label.toLowerCase()).join(" / ");
    return fail(`${m.label} designs go to a ${want}; ${target.id} is a ${typeLabel(el).toLowerCase()}.`);
  }
  const kvs = systemKv(sys);
  const ctx = { kv: el.kind === "con" ? kvs.con[el.raw.id] : kvs.eq[el.raw.id] };
  let patch;
  try { patch = MAPPERS[design.module](design, el, ctx, errors, warnings, notes); }
  catch (e) { return fail(e.message); }
  if (errors.length) return fail();

  // the patched model must not gain an error the current one does not have
  const next = applyPatch(sys, el.kind, el.raw.id, patch);
  const before = new Set(compileSystem(sys).issues.filter((x) => x.level === "error").map((x) => x.msg));
  const added = compileSystem(next).issues.filter((x) => x.level === "error" && !before.has(x.msg));
  if (added.length) return fail(`Applying this design would break the System model: ${added.map((x) => x.msg).join(" ")}`);

  const diff = Object.entries(patch).map(([field, nv]) => {
    const [label, unit] = LABELS[field] || [field, ""];
    const old = el.full[field];
    return { field, label, unit, old: old === undefined ? null : old, new: nv, changed: !same(old, nv) };
  });
  const changed = diff.filter((r) => r.changed).length;
  return { ok: true, module: design.module, target: { kind: el.kind, id: el.raw.id, type: el.type }, patch, diff, changed, warnings, notes, errors: [], stale: changed ? [...STALE_STUDIES] : [] };
}

function applyPatch(sys, kind, id, patch) {
  if (kind === "con") return { ...sys, connectors: sys.connectors.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
  return { ...sys, equipment: sys.equipment.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

/** Returns a new System with the plan's patch applied (the input is not changed). Throws on a rejected plan. */
export function applyPush(sys, plan) {
  if (!plan?.ok) throw new Error(plan?.errors?.[0] || "The push was rejected.");
  if (!findElement(sys, plan.target)) throw new Error(`${plan.target.id} no longer exists in the System.`);
  return applyPatch(sys, plan.target.kind, plan.target.id, plan.patch);
}

/* ---------------------------------------------------------------- builders */
const failedNames = (checks) => (checks || []).filter((c) => !c.passed).map((c) => c.name);

/** From a pecalc sizeFeeder result: the recommended option (or a chosen one). */
export function feederDesign(result, option = result?.recommended) {
  if (!option) throw new Error("No conductor passes every check, so there is no feeder design to apply.");
  const i = result.input;
  return {
    module: "feeder", phases: i.phases, voltage: q(i.voltage_v, "V"), size: option.size, sets: option.sets, material: i.material,
    insulation: q(i.insulation_temp_c, "°C"), length: q(i.length_m, "m"), conduit: i.conduit, installation: i.installation,
    ampacity_per_set: q(option.ampacity_per_set_a, "A"), passed: option.passed, failed_checks: failedNames(option.checks),
  };
}

/** From a pecalc cable bus analyse() result. The rating is the phase current at which the most heavily
 *  loaded cable reaches its ampacity, so it includes the current-sharing imbalance.
 *  This is deliberately the conservative figure (decided on PR #19): parallel cables in a cable bus do not
 *  share current equally (proximity and position in the layout), so "lowest cable ampacity × sets" — what the
 *  Cable bus tile shows — overstates what the run can carry; the worst cable reaches 100 % first. Sharing is
 *  linear in the phase current, so current_a / (max_loading_pct / 100) is the load at which that happens. */
export function cableBusDesign(res) {
  const i = res.input;
  return {
    module: "cablebus", voltage: q(i.voltage_v, "V"), size: i.size, sets: i.conductors_per_phase, material: i.material,
    insulation: q(i.insulation_temp_c, "°C"), length: q(i.length_m, "m"),
    rating: q(res.max_loading_pct > 0 ? (i.current_a * 100) / res.max_loading_pct : 0, "A"),
    passed: res.passed, failed_checks: failedNames(res.checks),
  };
}

/** From a pecalc switchgear analyseBus() result. */
export function switchgearDesign(res) {
  const i = res.input;
  return {
    module: "switchgear", voltage: q(i.voltage_v, "V"), current: q(i.current_a, "A"), fault: i.fault_ka ? q(i.fault_ka, "kA") : null,
    rated_current: q(res.rated_current_at_limit_a, "A"), bars_per_phase: i.bars_per_phase, bar_width: q(i.bar_width_mm, "mm"),
    bar_thickness: q(i.bar_thickness_mm, "mm"), phase_spacing: q(i.phase_spacing_mm, "mm"), support_span: q(i.support_span_m, "m"),
    material: i.material, orientation: i.orientation, passed: res.passed, failed_checks: failedNames(res.checks),
  };
}

/** From a pecalc transformer design()/design_for_impedance() result: the achieved %Z and X/R, not the target. */
export function transformerDesign(res) {
  const i = res.input;
  return {
    module: "transformer", power: q(i.kva, "kVA"), hv: q(i.hv_v, "V"), lv: q(i.lv_v, "V"),
    z: q(res.impedance.z_pct, "%"), xr: q(res.impedance.x_over_r, ""), passed: res.passed, failed_checks: failedNames(res.checks),
  };
}
