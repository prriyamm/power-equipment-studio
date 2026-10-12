/* ============================================================================
 * Equipment design checks driven by the system study.
 *
 * The System view knows each piece of equipment's operating current and fault
 * level; the pecalc product modules know how to verify the equipment itself.
 * This module joins them: every cable bus run gets the full cable bus check at
 * its load-flow current and bus fault level, every switchgear bus gets the bus
 * thermal + bracing check at its rating and fault level, and every transformer
 * gets the preliminary design check at its rating.
 * ========================================================================== */
import { EQUIPMENT, CONNECTORS, NODE_KINDS } from "./system.js";
import { cableBusInput, analyse as analyseCableBus } from "./pecalc/cablebus.js";
import { busInput, analyseBus } from "./pecalc/switchgear.js";
import { transformerInput, design_for_impedance } from "./pecalc/transformer.js";

// Typical MV cable insulation walls (mm) by system voltage, 100 % level (ICEA S-93-639 class values,
// typical — not a specific cable). Used only when the run has no cable construction of its own.
const MV_INSULATION_MM = [[5, 2.29], [8, 2.92], [15, 4.45], [25, 6.6], [35, 8.76]];
const mvInsulation = (kv) => (MV_INSULATION_MM.find(([v]) => kv <= v) || MV_INSULATION_MM.at(-1))[1];

// Candidate copper laminations (6.35 mm thick bars), smallest copper first. When the gear has no bus
// geometry of its own, the check picks the first candidate whose rated current at the rise limit
// covers the bus rating, i.e. it sizes the bus.
const BUS_CANDIDATES = [[1, 101.6], [1, 152.4], [2, 101.6], [2, 152.4], [3, 152.4], [4, 152.4], [5, 152.4], [6, 152.4], [5, 203.2], [6, 203.2], [8, 203.2]];

export function cableBusCheck(c, current_a, kv, fault_ka, xr) {
  const sets = c.sets ?? 1;
  const inp = {
    voltage_v: kv * 1000, current_a: Math.max(current_a, 1), length_m: (c.length_ft ?? 100) * 0.3048,
    material: c.material ?? "Cu", size: String(c.size ?? "750"), conductors_per_phase: sets, tiers: 1,
    insulation_temp_c: c.insulation_c ?? 90, terminal_temp_c: Math.min(c.insulation_c ?? 90, 90),
    fault_ka: fault_ka ?? null, x_over_r: Math.min(Math.max(xr ?? 15, 2), 60),
  };
  if (kv > 2) Object.assign(inp, { insulation: "EPR", insulation_mm: mvInsulation(kv), shield_mm: 0.13, jacket_mm: 2.0, shield_bonding: "single_point" });
  return analyseCableBus(cableBusInput(inp));
}

export function gearBusCheck(e, fault_ka, xr) {
  const base = {
    current_a: e.bus_a, voltage_v: e.kv * 1000, material: "Cu", bar_thickness_mm: e.bar_thickness_mm ?? 6.35,
    phase_spacing_mm: e.phase_spacing_mm ?? (e.kv > 1 ? 250 : 150), orientation: "edge_to_edge", standard: e.kv > 1 ? "C37.20.2" : "UL 891",
    fault_ka: fault_ka ?? null, x_over_r: Math.min(Math.max(xr ?? 15, 2), 60), support_span_m: e.support_span_m ?? 0.6,
    filaments_thickness: 2, filaments_width: 6, // coarse mesh: interactive speed inside the system study
  };
  if (e.bars_per_phase && e.bar_width_mm) return { ...analyseBus(busInput({ ...base, bars_per_phase: e.bars_per_phase, bar_width_mm: e.bar_width_mm })), sized: false };
  let res = null;
  for (const [n, w] of BUS_CANDIDATES) {
    res = analyseBus(busInput({ ...base, bars_per_phase: n, bar_width_mm: w }));
    if (res.rated_current_at_limit_a >= e.bus_a) break;
  }
  return { ...res, sized: true };
}

export function transformerCheck(e, source_mva) {
  return design_for_impedance(transformerInput({ kva: e.kva, hv_v: e.hv_kv * 1000, lv_v: e.lv_kv * 1000, target_z_pct: e.z_pct, source_mva: source_mva ?? null }));
}

/** Runs every applicable check; failures in one check never stop the others. */
export function designChecks(sys, analysis) {
  const out = {};
  if (!analysis?.ok) return out;
  const eqById = Object.fromEntries(sys.equipment.map((e) => [e.id, { ...EQUIPMENT[e.type].defaults, ...e }]));
  const scAt = (bus) => analysis.sc?.buses?.[bus - 1];
  const util = Object.values(eqById).find((e) => e.type === "utility");
  for (const c0 of sys.connectors) {
    if (c0.kind !== "cablebus" || c0.closed === false) continue;
    const c = { ...CONNECTORS.cablebus.defaults, ...c0 };
    const r = analysis.connectors[c.id]; if (!r || r.open) continue;
    const kv = analysis.equipment[c.from.split(".")[0]]?.kv ?? analysis.equipment[c.to.split(".")[0]]?.kv;
    const sc = [scAt(r.from_bus), scAt(r.to_bus)].filter(Boolean).sort((a, b) => b.ik_ka - a.ik_ka)[0];
    try {
      const res = cableBusCheck(c, r.i_a, kv, sc ? sc.ik_ka / sc.c : null, sc?.xr);
      out[c.id] = { kind: "cablebus", passed: res.passed, checks: res.checks, summary: `worst cable ${Math.round(res.max_loading_pct)} % · VD ${res.vd_pct} %${res.fault_force_lbf_per_ft ? ` · ${Math.round(res.fault_force_lbf_per_ft)} lbf/ft` : ""}`, result: res };
    } catch (err) { out[c.id] = { kind: "cablebus", passed: false, error: err.message, checks: [] }; }
  }
  for (const e of Object.values(eqById)) {
    const r = analysis.equipment[e.id]; if (!r || r.deenergized) continue;
    if (NODE_KINDS.has(e.type) && e.type === "switchgear") {
      const sc = scAt(r.bus);
      try {
        const res = gearBusCheck(e, sc ? sc.ik_ka / sc.c : null, sc?.xr);
        out[e.id] = { kind: "bus", passed: res.passed, checks: res.checks, summary: `${res.input.bars_per_phase} × ${res.input.bar_thickness_mm} × ${res.input.bar_width_mm} mm Cu/phase${res.sized ? " (sized)" : ""} · rise ${res.rise_c} °C`, result: res };
      } catch (err) { out[e.id] = { kind: "bus", passed: false, error: err.message, checks: [] }; }
    } else if (e.type === "transformer") {
      try {
        const res = transformerCheck(e, util?.mva_sc);
        out[e.id] = { kind: "transformer", passed: res.passed, checks: res.checks, summary: `${res.impedance.z_pct} %Z · η ${res.performance.efficiency_pct["100%"]} % · ${((res.losses.no_load_w + res.losses.load_loss_w) / 1000).toFixed(1)} kW losses`, result: res };
      } catch (err) { out[e.id] = { kind: "transformer", passed: false, error: err.message, checks: [] }; }
    }
  }
  return out;
}
