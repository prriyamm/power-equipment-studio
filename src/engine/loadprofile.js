/* Daily load profile study: scale every static load and motor load factor by an hourly multiplier,
 * run the load flow for each hour, and total the energy. Capacitors, generators and the utility are unchanged. */
import { analyseSystem, EQUIPMENT } from "./system.js";

export const PROFILES = {
  industrial_two_shift: { label: "Industrial, two shift", hours: [0.35, 0.33, 0.32, 0.32, 0.35, 0.45, 0.7, 0.92, 1.0, 1.0, 0.98, 0.95, 0.85, 0.95, 1.0, 1.0, 0.97, 0.9, 0.75, 0.6, 0.5, 0.42, 0.38, 0.36] },
  datacenter_flat: { label: "Data centre, flat", hours: Array(24).fill(1.0) },
};

const resolve = (p, extra = {}) => {
  const hours = Array.isArray(p) ? p : (extra[p] ?? PROFILES[p])?.hours;
  if (!Array.isArray(hours) || hours.length !== 24 || hours.some((x) => !isFinite(x) || x < 0)) throw new Error(`Profile "${p}" must be 24 non-negative hourly multipliers.`);
  return hours;
};

export function profileStudy(sys, profile, opts = {}) {
  const extra = opts.profiles || {};
  let base;
  const hoursFor = new Map();
  try {
    base = resolve(profile ?? "industrial_two_shift", extra);
    for (const e of sys.equipment || []) if (e.type === "load" || e.type === "motor") hoursFor.set(e.id, e.profile ? resolve(e.profile, extra) : base);
  } catch (e) { return { ok: false, message: e.message }; }
  const hours = [], loading = {}, connectors = {};
  for (let h = 0; h < 24; h++) {
    const s = { ...sys, equipment: (sys.equipment || []).map((e) => {
      const f = hoursFor.get(e.id)?.[h];
      if (f == null) return e;
      const d = { ...EQUIPMENT[e.type].defaults, ...e };
      return e.type === "load" ? { ...e, kw: d.kw * f } : { ...e, load_factor: d.load_factor * f };
    }) };
    const a = analyseSystem(s, opts);
    if (!a.ok) return { ok: false, message: `Hour ${h}: ${a.message || "load flow did not converge"}`, hour: h };
    let worst = 0, worst_id = null;
    const rec = (store, id, pct) => {
      (store[id] ||= Array(24).fill(null))[h] = pct;
      if (pct > worst) { worst = pct; worst_id = id; }
    };
    for (const [id, r] of Object.entries(a.equipment)) if (r.loading_pct != null) rec(loading, id, r.loading_pct);
    for (const [id, r] of Object.entries(a.connectors)) if (r.loading_pct != null) rec(connectors, id, r.loading_pct);
    hours.push({ hour: h, factor: base[h], load_kw: a.totals.load_kw, loss_kw: a.totals.loss_kw, min_v: a.totals.min_v, worst_loading_pct: worst, worst_id });
  }
  const sum = (k) => hours.reduce((s, x) => s + x[k], 0);
  const peak = hours.reduce((p, x) => (x.load_kw > p.load_kw ? x : p), hours[0]);
  const energy = { load_kwh: sum("load_kw"), loss_kwh: sum("loss_kw") };
  energy.loss_pct = (100 * energy.loss_kwh) / energy.load_kwh;
  energy.load_factor = energy.load_kwh / (24 * peak.load_kw);
  return {
    ok: true, hours, loading, connectors, energy, peak_hour: peak.hour, peak_kw: peak.load_kw,
    min_v: Math.min(...hours.map((x) => x.min_v)),
    duration: hours.map((x) => ({ hour: x.hour, load_kw: x.load_kw })).sort((a, b) => b.load_kw - a.load_kw).map((x, i) => ({ ...x, rank: i + 1, pct_time: (100 * (i + 1)) / 24 })),
  };
}
