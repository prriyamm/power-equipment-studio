/* ============================================================================
 * Equipment-level system model.
 *
 * A system is equipment (utility, transformers, switchgear, MCCs, motors, loads,
 * capacitors, generators) joined by connectors (cable, cable bus, close-coupled
 * throat). Every equipment terminal is an electrical node; close-coupled
 * connectors merge nodes. The model compiles to a loadflow case (same JSON format
 * as the Python CLI) and to a short-circuit network, and results map back onto
 * each piece of equipment.
 * ========================================================================== */
import { runLoadFlow } from "./loadflow.js";
import { shortCircuit } from "./shortcircuit.js";
import AMPACITY from "./pecalc/data/ampacity_nec.json" with { type: "json" };
import TABLE9 from "./pecalc/data/reactance_nec_table9.json" with { type: "json" };
import { racOhmPerM, cableOdMm } from "./pecalc/conductors.js";

export const SQRT3 = Math.sqrt(3);

/* ---------------------------------------------------------------- catalogue */
// kv: nominal line-to-line kV. Ratings are inputs, never fixed products.
export const EQUIPMENT = {
  utility: { label: "Utility source", terminals: ["out"], defaults: { kv: 13.8, mva_sc: 500, xr: 15, v_pu: 1.0 } },
  generator: { label: "Generator", terminals: ["out"], defaults: { kv: 0.48, kva: 1000, pf: 0.8, p_kw: 600, v_pu: 1.0, xd2: 0.15, xr: 30 } },
  transformer: { label: "Transformer", terminals: ["hv", "lv"], defaults: { kva: 2500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, tap_pct: 0, conn: "Dyn1", cooling: "ONAN", style: "padmount" } },
  switchgear: { label: "Switchgear", terminals: ["bus"], defaults: { kv: 0.48, bus_a: 4000, sc_ka: 65, sections: 5 } },
  mcc: { label: "Motor control center", terminals: ["bus"], defaults: { kv: 0.48, bus_a: 800, sc_ka: 42, sections: 3 } },
  panel: { label: "Panelboard", terminals: ["bus"], defaults: { kv: 0.48, bus_a: 400, sc_ka: 35 } },
  motor: { label: "Motor", terminals: ["in"], defaults: { hp: 150, eff: 0.95, pf: 0.88, load_factor: 0.85, lrc: 6, xr: 10, contributes: true } },
  load: { label: "Static load", terminals: ["in"], defaults: { kw: 400, pf: 0.9 } },
  capacitor: { label: "Capacitor bank", terminals: ["in"], defaults: { kvar: 300 } },
};
export const CONNECTORS = {
  cable: { label: "Cable", defaults: { size: "500", material: "Cu", sets: 1, length_ft: 150, raceway: "steel", insulation_c: 75, closed: true } },
  cablebus: { label: "Cable bus", defaults: { size: "750", material: "Cu", sets: 4, length_ft: 100, insulation_c: 90, closed: true } },
  direct: { label: "Close-coupled", defaults: { closed: true } },
};
export const NODE_KINDS = new Set(["switchgear", "mcc", "panel"]);

/* --------------------------------------------------------------- conductors */
// Cross-section areas: AWG from the ASTM B258 formula, kcmil = 0.5067 mm² per kcmil.
const AWG = { "14": 2.08, "12": 3.31, "10": 5.26, "8": 8.37, "6": 13.3, "4": 21.2, "3": 26.7, "2": 33.6, "1": 42.4, "1/0": 53.5, "2/0": 67.4, "3/0": 85.0, "4/0": 107.2 };
export const CONDUCTOR_SIZES = [...Object.keys(AWG), "250", "300", "350", "400", "500", "600", "750", "1000"];
export function areaMm2(size) {
  if (AWG[size]) return AWG[size];
  const k = Number(size); if (!isFinite(k) || k <= 0) throw new Error(`Unknown conductor size "${size}"`);
  return k * 0.506707;
}
// AC resistance per conductor at operating temperature, ohm per 1000 ft: IEC 60287-1-1 skin and
// proximity factors from the ported pecalc conductor model, cables touching (spacing = cable OD).
export function racPer1000ft(size, material = "Cu", tempC = 75) {
  return racOhmPerM(size, material, tempC, 60, cableOdMm(size)) * 304.8;
}
// DC resistance at operating temperature, ohm per 1000 ft per conductor (IEC 60228 resistivities, α from IEC 60287).
export function rdcPer1000ft(size, material = "Cu", tempC = 75) {
  const rho20 = material === "Al" ? 2.8264e-8 : 1.7241e-8, alpha = material === "Al" ? 0.00403 : 0.00393;
  const r_per_m = (rho20 * (1 + alpha * (tempC - 20))) / (areaMm2(size) * 1e-6);
  return r_per_m * 304.8;
}
export function xlPer1000ft(size, raceway = "steel") {
  const col = TABLE9[raceway] || TABLE9.steel;
  return col[size] ?? col["1000"];
}
// Table ampacity per conductor: 310.16 for cable in raceway, 310.17 (free air) for cable bus.
export function tableAmpacity(kind, size, material = "Cu", tempC = 75) {
  const t = kind === "cablebus" ? AMPACITY.free_air : AMPACITY.raceway;
  const row = t?.[material]?.[size];
  if (!row) return null;
  const i = AMPACITY._meta.columns_c.indexOf(tempC);
  return row[i >= 0 ? i : 1];
}
export const AMPACITY_STATUS = AMPACITY._meta.status;

/* ------------------------------------------------------------------ helpers */
const withDefaults = (e) => ({ ...(EQUIPMENT[e.type]?.defaults || {}), ...e });
const conWithDefaults = (c) => ({ ...(CONNECTORS[c.kind]?.defaults || {}), ...c });
export const motorKw = (m) => (m.hp * 0.746) / m.eff;              // input power at full load
export const motorKva = (m) => motorKw(m) / m.pf;
const parseEnd = (s) => { const [id, term] = String(s).split("."); return { id, term }; };

/* ------------------------------------------------------------ compile model */
export function compileSystem(sys) {
  const issues = [];
  const add = (level, ref, msg) => issues.push({ level, ref, msg });
  const base_mva = sys.base_mva ?? 10;
  const eq = new Map();
  for (const raw of sys.equipment || []) {
    if (!EQUIPMENT[raw.type]) { add("error", raw.id, `Unknown equipment type "${raw.type}".`); continue; }
    if (eq.has(raw.id)) { add("error", raw.id, `Duplicate equipment id "${raw.id}".`); continue; }
    eq.set(raw.id, withDefaults(raw));
  }
  // union-find over terminals
  const parent = new Map();
  const term = (id, t) => `${id}.${t}`;
  for (const e of eq.values()) for (const t of EQUIPMENT[e.type].terminals) parent.set(term(e.id, t), term(e.id, t));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => parent.set(find(a), find(b));

  const cons = [];
  for (const raw of sys.connectors || []) {
    const c = conWithDefaults(raw);
    let ok = true;
    for (const endKey of ["from", "to"]) {
      const { id, term: t } = parseEnd(c[endKey]);
      const e = eq.get(id);
      if (!e) { add("error", c.id, `Connector ${c.id}: equipment "${id}" does not exist.`); ok = false; continue; }
      if (!EQUIPMENT[e.type].terminals.includes(t)) { add("error", c.id, `Connector ${c.id}: ${e.type} ${id} has no terminal "${t}".`); ok = false; }
    }
    if (c.from === c.to) { add("error", c.id, `Connector ${c.id} connects a terminal to itself.`); ok = false; }
    if (!ok) continue;
    // an open feeder breaker removes the connector from the network (it still carries nominal kV for labelling)
    if (c.kind === "direct" && c.closed !== false) union(c.from, c.to);
    cons.push(c);
  }

  // nominal kV per node group, from equipment ratings at that terminal
  const kvAt = (e, t) => e.type === "transformer" ? (t === "hv" ? e.hv_kv : e.lv_kv) : ["utility", "generator", "switchgear", "mcc", "panel"].includes(e.type) ? e.kv : null;
  const groups = new Map();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, { terms: [], kv: null, kvFrom: null });
    groups.get(root).terms.push(key);
  }
  for (const g of groups.values()) for (const k of g.terms) {
    const { id, term: t } = parseEnd(k); const kv = kvAt(eq.get(id), t);
    if (kv == null) continue;
    if (g.kv == null) { g.kv = kv; g.kvFrom = id; }
    else if (Math.abs(g.kv - kv) > 1e-9) add("error", id, `${id} is rated ${kv} kV but is close-coupled to ${g.kvFrom} at ${g.kv} kV.`);
  }
  // cables carry voltage across: propagate kv through cable/cablebus connectors to groups that have none
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of cons) {
      if (c.kind === "direct") continue;
      const a = groups.get(find(c.from)), b = groups.get(find(c.to));
      if (a.kv != null && b.kv == null) { b.kv = a.kv; b.kvFrom = a.kvFrom; changed = true; }
      else if (b.kv != null && a.kv == null) { a.kv = b.kv; a.kvFrom = b.kvFrom; changed = true; }
    }
  }
  for (const c of cons) {
    if (c.kind === "direct") continue;
    const a = groups.get(find(c.from)), b = groups.get(find(c.to));
    if (a.kv != null && b.kv != null && Math.abs(a.kv - b.kv) > 1e-9) add("error", c.id, `${c.id} joins ${a.kv} kV to ${b.kv} kV. Cables cannot change voltage; add a transformer.`);
  }

  // buses
  const busOfRoot = new Map(); const buses = []; const busMeta = [];
  let nextId = 1;
  for (const [root, g] of groups) {
    const id = nextId++;
    busOfRoot.set(root, id);
    const members = [...new Set(g.terms.map((k) => parseEnd(k).id))];
    const label = members.find((m) => NODE_KINDS.has(eq.get(m).type)) || g.terms[0];
    busMeta.push({ id, kv: g.kv, terms: g.terms, members, label });
    if (g.kv == null) add("error", label, `No voltage rating reaches ${label}. Connect it to rated equipment.`);
    buses.push({ id, type: "PQ" });
  }
  const busOf = (endKey) => busOfRoot.get(find(endKey));
  const B = (id) => buses[id - 1];
  const addLoad = (b, pMW, qMvar) => { b.p_load = (b.p_load ?? 0) + pMW; b.q_load = (b.q_load ?? 0) + qMvar; };

  let slackCount = 0;
  const scSources = [];
  for (const e of eq.values()) {
    const t0 = EQUIPMENT[e.type].terminals[0];
    const bid = busOf(term(e.id, t0)); const b = B(bid); const kv = busMeta[bid - 1].kv;
    if (e.type === "utility") {
      slackCount++;
      if (slackCount === 1) { b.type = "slack"; b.v = e.v_pu; b.angle = 0.0; }
      else add("error", e.id, `More than one utility source. Only one swing source is supported; use a generator for the others.`);
      const z = base_mva / e.mva_sc, r = z / Math.sqrt(1 + e.xr * e.xr);
      scSources.push({ bus: bid, r, x: r * e.xr, id: e.id, kind: "utility" });
    } else if (e.type === "generator") {
      if (b.type !== "slack") { b.type = "PV"; b.v = e.v_pu; b.p_gen = (b.p_gen ?? 0) + e.p_kw / 1000; }
      const x = e.xd2 * (base_mva / (e.kva / 1000));
      scSources.push({ bus: bid, r: x / e.xr, x, id: e.id, kind: "generator" });
    } else if (e.type === "motor") {
      const p = (motorKw(e) * e.load_factor) / 1000, q = p * Math.tan(Math.acos(e.pf));
      addLoad(b, p, q);
      if (e.contributes) {
        const z = (1 / e.lrc) * (base_mva / (motorKva(e) / 1000)), r = z / Math.sqrt(1 + e.xr * e.xr);
        scSources.push({ bus: bid, r, x: r * e.xr, id: e.id, kind: "motor" });
      }
    } else if (e.type === "load") {
      const p = e.kw / 1000; addLoad(b, p, p * Math.tan(Math.acos(e.pf)));
    } else if (e.type === "capacitor") {
      b.shunt_b = (b.shunt_b ?? 0) + e.kvar / 1000 / base_mva;
    }
  }
  if (slackCount === 0) add("error", null, "No utility source. Add a utility to set the swing bus.");

  // branches
  const branches = [], branchMeta = [];
  for (const e of eq.values()) {
    if (e.type !== "transformer") continue;
    const f = busOf(term(e.id, "hv")), t = busOf(term(e.id, "lv"));
    if (f === t) { add("error", e.id, `${e.id} HV and LV terminals are shorted together.`); continue; }
    const zpu = (e.z_pct / 100) * (base_mva / (e.kva / 1000)), r = zpu / Math.sqrt(1 + e.xr * e.xr);
    const br = { from: f, to: t, r, x: r * e.xr };
    if (e.tap_pct) br.tap = 1 + e.tap_pct / 100;
    branches.push(br); branchMeta.push({ kind: "transformer", id: e.id, rating_kva: e.kva });
  }
  for (const c of cons) {
    if (c.kind === "direct" || c.closed === false) continue;
    const f = busOf(c.from), t = busOf(c.to);
    if (f === t) { add("warn", c.id, `${c.id} runs between two terminals of the same bus.`); continue; }
    const kv = busMeta[f - 1].kv;
    let rOhm, xOhm;
    const L = Math.max(c.length_ft, 1); // a zero-length run would make the Y-bus singular
    try {
      rOhm = (racPer1000ft(c.size, c.material, c.insulation_c) * L) / 1000 / c.sets;
      xOhm = (xlPer1000ft(c.size, c.kind === "cablebus" ? "aluminum" : c.raceway) * L) / 1000 / c.sets;
    } catch (err) { add("error", c.id, err.message); continue; }
    if (!kv) continue;
    const zb = (kv * kv) / base_mva;
    branches.push({ from: f, to: t, r: rOhm / zb, x: xOhm / zb });
    const perSet = c.ampacity_a ?? tableAmpacity(c.kind, c.size, c.material, c.insulation_c);
    branchMeta.push({ kind: c.kind, id: c.id, ampacity_a: perSet != null ? perSet * c.sets : null, ohms: { r: rOhm, x: xOhm }, kv });
  }

  // Energization: keep only buses reachable from the swing source through closed branches.
  // Everything else is de-energized (e.g. downstream of an open breaker) and left out of the studies.
  const slackBus = buses.find((b) => b.type === "slack");
  let keep = new Set(buses.map((b) => b.id));
  if (slackBus) {
    keep = new Set([slackBus.id]); const stack = [slackBus.id];
    while (stack.length) { const u = stack.pop(); for (const br of branches) { const v = br.from === u ? br.to : br.to === u ? br.from : null; if (v != null && !keep.has(v)) { keep.add(v); stack.push(v); } } }
  }
  const remap = new Map(); let nid = 1;
  for (const b of buses) if (keep.has(b.id)) remap.set(b.id, nid++);
  const deenergized = busMeta.filter((m) => !keep.has(m.id)).flatMap((m) => m.members);
  const lfCase = {
    base_mva,
    buses: buses.filter((b) => keep.has(b.id)).map((b) => ({ ...b, id: remap.get(b.id) })),
    branches: branches.filter((br) => keep.has(br.from) && keep.has(br.to)).map((br) => ({ ...br, from: remap.get(br.from), to: remap.get(br.to) })),
  };
  const keptMeta = branchMeta.filter((_, i) => keep.has(branches[i].from) && keep.has(branches[i].to));
  const metaOut = busMeta.filter((m) => keep.has(m.id)).map((m) => ({ ...m, id: remap.get(m.id) }));
  const sources = scSources.filter((s) => keep.has(s.bus)).map((s) => ({ ...s, bus: remap.get(s.bus) }));
  const busOfLive = (endKey) => remap.get(busOf(endKey)) ?? null;
  return { lfCase, busMeta: metaOut, branchMeta: keptMeta, scSources: sources, issues, eq, cons, busOf: busOfLive, base_mva, deenergized: new Set(deenergized) };
}

/* ---------------------------------------------------------------- analysis */
export function analyseSystem(sys, opts = {}) {
  const c = compileSystem(sys);
  const errors = c.issues.filter((x) => x.level === "error");
  const out = { compiled: c, issues: c.issues, ok: false, lf: null, sc: null, equipment: {}, connectors: {} };
  if (errors.length) { out.message = errors[0].msg; return out; }
  const lf = runLoadFlow(c.lfCase, { vMin: opts.vMin ?? 0.95, vMax: opts.vMax ?? 1.05 });
  out.lf = lf;
  if (!lf.buses) { out.message = lf.message; out.issues = [...c.issues, ...(lf.issues || [])]; return out; }
  out.ok = lf.converged;
  const sc = shortCircuit(c.lfCase, c.busMeta.map((b) => b.kv), c.scSources, { motors: opts.motors ?? true });
  out.sc = sc;

  const kvOf = (bid) => c.busMeta[bid - 1].kv;
  const busRes = (bid) => lf.buses[bid - 1];
  // branch end currents (A) and power
  const brRes = lf.branches.map((b, i) => {
    const m = c.branchMeta[i];
    const vf = busRes(b.from).v, vt = busRes(b.to).v;
    const iF = (b.s_from_mva * 1000) / (SQRT3 * kvOf(b.from) * vf), iT = (b.s_to_mva * 1000) / (SQRT3 * kvOf(b.to) * vt);
    return { ...b, meta: m, i_from_a: iF, i_to_a: iT };
  });
  const connected = (bid) => brRes.filter((b) => b.from === bid || b.to === bid);

  for (const e of c.eq.values()) {
    const terms = EQUIPMENT[e.type].terminals;
    const bid = c.busOf(`${e.id}.${terms[0]}`);
    if (bid == null && (e.type !== "transformer" || c.busOf(`${e.id}.lv`) == null)) { out.equipment[e.id] = { deenergized: true }; continue; }
    if (bid == null) { out.equipment[e.id] = { deenergized: true }; continue; }
    const r = busRes(bid), kv = kvOf(bid);
    const info = { bus: bid, kv, v_pu: r.v, v_kv: r.v * kv, angle: r.angle_deg, vflag: r.vflag, ik_ka: sc?.buses[bid - 1]?.ik_ka, ip_ka: sc?.buses[bid - 1]?.ip_ka, xr_fault: sc?.buses[bid - 1]?.xr };
    if (NODE_KINDS.has(e.type)) {
      // bus throughput: power entering the bus from upstream branches
      let sIn = 0;
      for (const b of connected(bid)) { const pIn = b.to === bid ? -b.p_to_mw : -b.p_from_mw; if (pIn > 0) sIn += b.to === bid ? b.s_to_mva : b.s_from_mva; }
      const ia = (sIn * 1000) / (SQRT3 * kv * r.v);
      info.bus_i_a = ia; info.loading_pct = (100 * ia) / e.bus_a;
      info.sc_duty_pct = info.ik_ka != null ? (100 * info.ik_ka) / e.sc_ka : null;
    } else if (e.type === "transformer") {
      const k = brRes.findIndex((b) => b.meta.kind === "transformer" && b.meta.id === e.id);
      if (k >= 0) {
        const b = brRes[k];
        Object.assign(info, { s_kva: Math.max(b.s_from_mva, b.s_to_mva) * 1000, loading_pct: (100 * Math.max(b.s_from_mva, b.s_to_mva) * 1000) / e.kva,
          p_kw: b.p_from_mw * 1000, q_kvar: b.q_from_mvar * 1000, loss_kw: b.p_loss_mw * 1000, i_hv_a: b.i_from_a, i_lv_a: b.i_to_a,
          v_lv_pu: busRes(b.to).v, lv_ik_ka: sc?.buses[b.to - 1]?.ik_ka, hv_bus: b.from, lv_bus: b.to });
      }
    } else if (e.type === "utility") {
      const pg = r.p_gen_mw, qg = r.q_gen_mvar;
      Object.assign(info, { p_kw: pg * 1000, q_kvar: qg * 1000, s_kva: Math.hypot(pg, qg) * 1000, pf: pg / Math.max(Math.hypot(pg, qg), 1e-12) });
    } else if (e.type === "generator") {
      Object.assign(info, { p_kw: r.p_gen_mw * 1000, q_kvar: r.q_gen_mvar * 1000, loading_pct: (100 * Math.hypot(r.p_gen_mw, r.q_gen_mvar) * 1000) / e.kva });
    } else if (e.type === "motor") {
      const p = motorKw(e) * e.load_factor;
      Object.assign(info, { p_kw: p, i_a: (p / e.pf) / (SQRT3 * kv * r.v), contribution_ka: sc?.sources.find((s) => s.id === e.id)?.ka_at_bus });
    } else if (e.type === "load") {
      Object.assign(info, { p_kw: e.kw, i_a: (e.kw / e.pf) / (SQRT3 * kv * r.v) });
    } else if (e.type === "capacitor") {
      Object.assign(info, { q_kvar: e.kvar * r.v * r.v });
    }
    out.equipment[e.id] = info;
  }
  for (const cn of c.cons) if (cn.closed === false) out.connectors[cn.id] = { open: true };
  brRes.forEach((b) => {
    if (b.meta.kind === "transformer") return;
    const ia = Math.max(b.i_from_a, b.i_to_a);
    out.connectors[b.meta.id] = {
      i_a: ia, p_kw: b.p_from_mw * 1000, q_kvar: b.q_from_mvar * 1000, loss_kw: b.p_loss_mw * 1000,
      vd_pct: (100 * (busRes(b.from).v - busRes(b.to).v)) / busRes(b.from).v,
      ampacity_a: b.meta.ampacity_a, loading_pct: b.meta.ampacity_a ? (100 * ia) / b.meta.ampacity_a : null,
      dir: b.p_from_mw >= 0 ? 1 : -1, from_bus: b.from, to_bus: b.to, ohms: b.meta.ohms,
    };
  });
  out.totals = {
    load_kw: lf.total_load_mw * 1000, gen_kw: lf.total_gen_mw * 1000, loss_kw: lf.total_p_loss_mw * 1000,
    min_v: Math.min(...lf.buses.map((b) => b.v)), max_v: Math.max(...lf.buses.map((b) => b.v)),
    max_ik_ka: sc ? Math.max(...sc.buses.map((b) => b.ik_ka)) : null,
  };
  out.message = lf.message;
  return out;
}

/* ---------------------------------------------------------- example package */
// Gx/gy are isometric grid positions (one unit ≈ 3 ft) used by the System view.
export const EXAMPLE_SYSTEM = {
  name: "Unit substation package",
  base_mva: 10,
  equipment: [
    { id: "UTIL", type: "utility", name: "Utility 13.8 kV", kv: 13.8, mva_sc: 500, xr: 15, gx: 0, gy: 1 },
    { id: "SWGR-MV", type: "switchgear", name: "15 kV switchgear", kv: 13.8, bus_a: 1200, sc_ka: 40, sections: 3, gx: 3, gy: 0 },
    { id: "T1", type: "transformer", name: "T1 2500 kVA", kva: 2500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: 9, gy: 0 },
    { id: "SWGR-LV", type: "switchgear", name: "480 V switchgear", kv: 0.48, bus_a: 4000, sc_ka: 65, sections: 6, gx: 14, gy: 0 },
    { id: "MCC-1", type: "mcc", name: "MCC-1", kv: 0.48, bus_a: 800, sc_ka: 42, sections: 3, gx: 17, gy: 7 },
    { id: "M1", type: "motor", name: "Pump 150 hp", hp: 150, gx: 15, gy: 13 },
    { id: "M2", type: "motor", name: "Fan 100 hp", hp: 100, pf: 0.86, eff: 0.945, gx: 19.5, gy: 13 },
    { id: "LOAD-1", type: "load", name: "Process load", kw: 1100, pf: 0.9, gx: 24, gy: 5 },
    { id: "CAP-1", type: "capacitor", name: "300 kvar bank", kvar: 300, gx: 12, gy: 5.5 },
    { id: "T2", type: "transformer", name: "T2 1500 kVA", kva: 1500, hv_kv: 13.8, lv_kv: 4.16, z_pct: 5.5, xr: 8, gx: 4, gy: 6 },
    { id: "SWGR-5", type: "switchgear", name: "5 kV switchgear", kv: 4.16, bus_a: 1200, sc_ka: 40, sections: 2, gx: 4, gy: 11 },
    { id: "M3", type: "motor", name: "Compressor 1000 hp", hp: 1000, eff: 0.96, pf: 0.9, load_factor: 0.8, gx: 9, gy: 12 },
  ],
  connectors: [
    { id: "C-UTIL", kind: "cable", from: "UTIL.out", to: "SWGR-MV.bus", size: "4/0", sets: 1, length_ft: 120, raceway: "pvc", insulation_c: 90 },
    { id: "C-T1", kind: "cable", from: "SWGR-MV.bus", to: "T1.hv", size: "2/0", sets: 1, length_ft: 150, raceway: "pvc", insulation_c: 90 },
    { id: "CB-1", kind: "cablebus", from: "T1.lv", to: "SWGR-LV.bus", size: "750", sets: 4, length_ft: 60 },
    { id: "C-MCC", kind: "cable", from: "SWGR-LV.bus", to: "MCC-1.bus", size: "500", sets: 2, length_ft: 220 },
    { id: "C-M1", kind: "cable", from: "MCC-1.bus", to: "M1.in", size: "4/0", sets: 1, length_ft: 140 },
    { id: "C-M2", kind: "cable", from: "MCC-1.bus", to: "M2.in", size: "2/0", sets: 1, length_ft: 160 },
    { id: "C-LOAD", kind: "cable", from: "SWGR-LV.bus", to: "LOAD-1.in", size: "500", sets: 6, length_ft: 300 },
    { id: "C-CAP", kind: "cable", from: "SWGR-LV.bus", to: "CAP-1.in", size: "250", sets: 2, length_ft: 30 },
    { id: "C-T2", kind: "cable", from: "SWGR-MV.bus", to: "T2.hv", size: "2/0", sets: 1, length_ft: 200, raceway: "pvc", insulation_c: 90 },
    { id: "CB-2", kind: "cablebus", from: "T2.lv", to: "SWGR-5.bus", size: "500", sets: 1, length_ft: 80, insulation_c: 90 },
    { id: "C-M3", kind: "cable", from: "SWGR-5.bus", to: "M3.in", size: "4/0", sets: 1, length_ft: 250, insulation_c: 90 },
  ],
};
