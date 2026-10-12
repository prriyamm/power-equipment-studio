/* ============================================================================
 * Time-current coordination (TCC).
 *
 * Builds the protective-device path from any load up to the utility, gives each
 * device a curve, plots equipment damage curves, and checks selectivity between
 * adjacent devices up to the available fault current.
 *
 *   LV breakers  LSIG electronic trip: long-time I²t, short-time definite or I²t,
 *                instantaneous; ±10 % current tolerance, clearing bands typical
 *   MV relays    IEEE C37.112-2018 inverse-time curves (51) + instantaneous (50)
 *   Cables       ICEA P-32-382 short-circuit damage: (I/A)²·t = k·log10((T2+λ)/(T1+λ))
 *   Transformers ANSI/IEEE C57.109 through-fault thermal limit (I²t = 1250 in pu²·s)
 *   Motors       starting (locked rotor for the acceleration time) and hot stall point
 *
 * Coordination intervals (CTI) are typical practice values (IEEE 242 / 3004.1):
 * 0.3 s relay–relay, 0.2 s relay–breaker; LV electronic breakers are selective
 * when the bands do not overlap.
 * ========================================================================== */
import { EQUIPMENT, CONNECTORS } from "./system.js";
import { AREA_CMIL } from "./pecalc/conductors.js";

export const IEEE_CURVES = {
  MI: { A: 0.0515, B: 0.114, p: 0.02, label: "IEEE moderately inverse" },
  VI: { A: 19.61, B: 0.491, p: 2, label: "IEEE very inverse" },
  EI: { A: 28.2, B: 0.1217, p: 2, label: "IEEE extremely inverse" },
};
const BRK_CLEAR = 0.05; // s, LV breaker instantaneous clearing (≈ 3 cycles)
const LOG = Math.log10;

/* ---------------------------------------------------------- device curves */
// Returns {min(I), max(I)} trip times in seconds (Infinity = no trip) for current I in device amperes.
export function lsigTimes(s, I) {
  const Ir = s.ltpu * s.sensor;
  const isd = s.stpu * Ir, ii = s.inst ? s.inst * s.sensor : Infinity;
  const band = (lo) => {
    const Ieff = lo ? I / 0.9 : I / 1.1; // ±10 % current tolerance (lo = fastest)
    if (Ieff >= ii) return lo ? 0.01 : BRK_CLEAR;
    let t = Infinity;
    if (Ieff > Ir * 1.0) t = s.ltd * Math.pow((6 * Ir) / Ieff, 2) * (lo ? 0.8 : 1.2);
    if (Ieff >= isd) {
      let tsd = s.std;
      if (s.st_i2t && Ieff < 10 * Ir) tsd = Math.max(s.std, s.std * Math.pow((10 * Ir) / Ieff, 2));
      tsd = lo ? tsd * 0.75 : tsd + 0.05;
      t = Math.min(t, tsd);
    }
    return t;
  };
  return { min: band(true), max: band(false) };
}

export function relayTimes(s, I) {
  const c = IEEE_CURVES[s.curve] || IEEE_CURVES.VI;
  const M = I / s.pickup;
  const inst = s.inst_a && I >= s.inst_a ? 0.05 : Infinity;
  const t51 = M > 1.05 ? s.td * (c.A / (Math.pow(M, c.p) - 1) + c.B) : Infinity;
  const t = Math.min(t51, inst);
  // relay curve plus breaker interrupting time (5 cycles) for the upper band
  return { min: t, max: t === Infinity ? Infinity : t + 0.083 };
}

export function deviceTimes(d, I) { return d.kind === "relay" ? relayTimes(d.settings, I) : lsigTimes(d.settings, I); }

/* --------------------------------------------------------- damage curves */
// ICEA P-32-382: (I/A)^2 t = k log10((T2 + λ)/(T1 + λ)), I amps, A circular mils; Cu k = 0.0297, λ = 234; Al k = 0.0125, λ = 228.
export function cableDamageTime(I, size, material = "Cu", sets = 1, t1 = 90, t2 = 250) {
  const A = AREA_CMIL[String(size)];
  if (!A) return null;
  const [k, lam] = material === "Al" ? [0.0125, 228] : [0.0297, 234];
  const Ic = I / sets;
  return (k * LOG((t2 + lam) / (t1 + lam)) * A * A) / (Ic * Ic);
}
// C57.109 through-fault thermal limit: t = 1250 / I_pu^2 (valid 2 s ≤ t ≤ 1800 s region in practice).
export function transformerDamageTime(I, fla) { const pu = I / fla; return 1250 / (pu * pu); }

/* ------------------------------------------------------------- the path */
const SQ3 = Math.sqrt(3);

export function defaultSettings(kind, rating_a, role, extra = {}) {
  if (kind === "relay") {
    // 51 pickup at 125 % of the protected transformer FLA (or circuit rating); 50 above the LV fault seen through it
    return { curve: "VI", pickup: Math.max(rating_a * 1.25, 10), td: role === "main" ? 4 : 2, inst_a: extra.inst_a ?? null };
  }
  const sensor = rating_a;
  return role === "main"
    ? { sensor, ltpu: 1.0, ltd: 12, stpu: 4, std: 0.3, st_i2t: false, inst: null }
    : { sensor, ltpu: 1.0, ltd: 4, stpu: 6, std: 0.1, st_i2t: false, inst: 12 };
}

/**
 * Protective path from a load (or any equipment) to the utility.
 * Devices: a breaker/relay at the source end of every connector on the way up.
 * All currents are referred to the voltage of the starting equipment (refKv).
 */
export function protectionPath(sys, analysis, startId, lineupTrips = {}) {
  const eqs = Object.fromEntries(sys.equipment.map((e) => [e.id, { ...EQUIPMENT[e.type].defaults, ...e }]));
  if (!eqs[startId]) throw new Error(`No equipment "${startId}"`);
  const res = analysis.equipment, cres = analysis.connectors;
  const refKv = res[startId]?.kv;
  const path = [], damage = [], faults = [];
  const seen = new Set();
  let cur = startId;
  // walk upstream: find the connector feeding `cur` (power flowing into it)
  for (let guard = 0; guard < 30; guard++) {
    seen.add(cur);
    const e = eqs[cur];
    if (e.type === "utility") break;
    if (e.type === "transformer") {
      const fla = e.kva / (SQ3 * e.lv_kv);
      damage.push({ kind: "transformer", id: e.id, label: `${e.id} damage (C57.109)`, fla_ref: fla * (e.lv_kv / refKv), kva: e.kva, inrush_ref: 12 * (e.kva / (SQ3 * e.hv_kv)) * (e.hv_kv / refKv) });
      cur = e.id; // continue from the HV side
    }
    const incoming = sys.connectors.filter((c) => {
      if (c.closed === false) return false;
      const r = cres[c.id]; if (!r || r.open) return false;
      const [fid] = c.from.split("."), [tid] = c.to.split(".");
      if (tid === cur && !seen.has(fid)) return r.dir > 0 || (e.type === "transformer" && c.to.endsWith(".hv"));
      if (fid === cur && !seen.has(tid)) return r.dir < 0 || (e.type === "transformer" && c.from.endsWith(".hv"));
      return false;
    }).filter((c) => !(e.type === "transformer" && (c.to === `${cur}.lv` || c.from === `${cur}.lv`)));
    if (!incoming.length) break;
    const c = { ...CONNECTORS[incoming[0].kind].defaults, ...incoming[0] };
    const srcEnd = c.to.split(".")[0] === cur ? c.from : c.to;
    const srcId = srcEnd.split(".")[0];
    const srcEq = eqs[srcId];
    // voltage at the device: the source terminal's rating (transformer secondary/primary), else the bus kV
    const kv = srcEq?.type === "transformer" ? (srcEnd.endsWith(".lv") ? srcEq.lv_kv : srcEq.hv_kv) : (res[srcId]?.kv ?? res[cur]?.kv);
    const ratio = kv / refKv;
    const r = cres[c.id];
    if (c.kind !== "direct") {
      damage.push({ kind: "cable", id: c.id, label: `${c.id} ${c.sets}×${c.size} ${c.material} damage (ICEA)`, size: c.size, material: c.material, sets: c.sets, ratio, insulation_c: c.insulation_c });
    }
    const isMain = srcEq?.type === "utility" || srcEq?.type === "transformer";
    const mv = kv > 1;
    const loadA = r?.i_a ?? 0;
    const fed = eqs[cur];
    // rating the device protects: transformer FLA it feeds or is fed from, kVA downstream of a utility main, else the circuit
    const xfmrKvaFrom = (gearId) => sys.connectors.filter((x) => x.closed !== false && [x.from, x.to].some((t) => t.startsWith(gearId + ".")))
      .map((x) => [x.from, x.to].find((t) => t.endsWith(".hv") && !t.startsWith(gearId + ".")))
      .filter(Boolean).reduce((a, t) => a + (eqs[t.split(".")[0]]?.kva ?? 0), 0);
    let base;
    if (srcEq?.type === "transformer") base = srcEq.kva / (SQ3 * kv);
    else if (fed?.type === "transformer") base = fed.kva / (SQ3 * kv);
    else if (srcEq?.type === "utility") base = Math.max(xfmrKvaFrom(cur) / (SQ3 * kv), loadA);
    else base = Math.max(loadA, 1);
    const trip = lineupTrips[c.id] ?? null;
    const kind = mv ? "relay" : "breaker";
    const rating = kind === "relay" ? base : (trip ?? Math.max((isMain ? base : loadA * 1.25), 15));
    const ikDown = res[cur]?.ik_ka;
    const extra = kind === "relay" && fed?.type === "transformer" ? { inst_a: Math.round((res[fed.id]?.lv_ik_ka ?? 0) * 1000 * (fed.lv_kv / fed.hv_kv) * 1.3) || null } : {};
    path.push({ id: `${c.id}@${srcId}`, connector: c.id, at: srcId, kind, kv, ratio, role: isMain ? "main" : "feeder", rating_a: rating, load_a: loadA,
      settings: { ...defaultSettings(kind, rating, isMain ? "main" : "feeder", extra) }, override: c.protection || null,
      label: `${kind === "relay" ? "51/50" : "Breaker"} ${c.id} at ${srcId}`, ik_ka_at_load_side: ikDown });
    faults.push({ id: cur, ka_ref: (res[cur]?.ik_ka ?? 0) * (res[cur]?.kv ?? refKv) / refKv, label: `I″k ${cur}` });
    cur = srcId;
  }
  autoCoordinate(path, faults);
  for (const d of path) if (d.override) Object.assign(d.settings, d.override);
  // starting equipment curves
  const st = eqs[startId];
  const start = {};
  if (st.type === "motor") {
    const fla = (st.hp * 0.746) / (st.eff * st.pf) / (SQ3 * refKv);
    Object.assign(start, { kind: "motor", fla, lrc_a: st.lrc * fla, accel_s: st.accel_s ?? 5, stall_s: st.stall_s ?? 20 });
  } else if (res[startId]?.i_a) start.kind = "load", start.fla = res[startId].i_a;
  return { refKv, devices: path, damage, faults, start };
}

// Auto-coordination: walk the path from the load upward and give each device the least delay that is
// still selective with the device below it, up to the fault current at the lower device.
// Breakers search short-time delay, short-time pickup and long-time band (instantaneous only on the
// most downstream breaker); relays search the time dial on an extremely inverse curve when the device
// below is a breaker (EI tracks the breaker I²t), very inverse otherwise.
export function autoCoordinate(path, faults = []) {
  path.forEach((d, i) => {
    if (i === 0) { if (d.kind === "breaker") d.settings.inst = d.role === "main" ? null : 12; return; }
    const down = path[i - 1], iMax = (faults[i - 1]?.ka_ref ?? 50) * 1000;
    const need = cti(down, d);
    const fits = () => pairMargin(down, d, iMax) >= need - 1e-9;
    if (d.kind === "breaker") {
      d.settings.inst = null;
      for (const std of [0.1, 0.2, 0.3, 0.4, 0.5]) for (const ltd of [4, 6, 12, 18, 24]) for (const stpu of [2, 3, 4, 5, 6, 8, 10]) {
        Object.assign(d.settings, { std, ltd, stpu });
        if (fits()) return;
      }
    } else {
      d.settings.curve = down.kind === "breaker" ? "EI" : "VI";
      if (down.kind === "breaker") d.settings.pickup = Math.max(d.settings.pickup, d.rating_a * 1.5);
      for (let td = 0.5; td <= 15; td += 0.5) { d.settings.td = td; if (fits()) return; }
    }
    d.uncoordinated = true;
  });
  return path;
}
const cti = (down, up) => (up.kind === "relay" && down.kind === "relay" ? 0.3 : up.kind === "relay" ? 0.2 : 0);
export function pairMargin(down, up, iMax) {
  let worst = Infinity;
  const lo = Math.max(down.rating_a, 10);
  for (let k = 0; k <= 120; k++) {
    const I = Math.pow(10, LOG(lo) + (k / 120) * (LOG(Math.max(iMax, lo * 1.01)) - LOG(lo)));
    const dd = deviceTimes(down, I / down.ratio), uu = deviceTimes(up, I / up.ratio);
    if (dd.max === Infinity || uu.min === Infinity) continue;
    worst = Math.min(worst, uu.min - dd.max);
  }
  return worst;
}

/* ------------------------------------------------------- selectivity check */
export function coordination(pathResult, opts = {}) {
  const { devices, faults } = pathResult;
  const out = [];
  for (let i = 0; i < devices.length - 1; i++) {
    const down = devices[i], up = devices[i + 1];
    const iMax = (faults[i]?.ka_ref ?? 50) * 1000; // fault at the downstream device's load side
    const need = up.kind === "relay" && down.kind === "relay" ? (opts.ctiRelay ?? 0.3) : up.kind === "relay" ? (opts.ctiRelayBrk ?? 0.2) : 0;
    let worst = Infinity, worstI = null, ok = true;
    for (let k = 0; k <= 120; k++) {
      const I = Math.pow(10, LOG(Math.max(down.rating_a, 10)) + (k / 120) * (LOG(iMax) - LOG(Math.max(down.rating_a, 10))));
      const d = deviceTimes(down, I / down.ratio), u = deviceTimes(up, I / up.ratio);
      if (d.max === Infinity) continue;
      if (u.min === Infinity) continue;
      const margin = u.min - d.max;
      if (margin < worst) { worst = margin; worstI = I; }
      if (margin < need - 1e-9) ok = false;
    }
    out.push({ down: down.id, up: up.id, required_s: need, worst_margin_s: worst === Infinity ? null : worst, at_a: worstI, ok });
  }
  return out;
}
