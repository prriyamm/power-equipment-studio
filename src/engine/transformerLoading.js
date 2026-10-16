/* Liquid-immersed transformer loading over a daily cycle: IEEE C57.91 Clause 7 exponential thermal model
 * (top-oil rise and winding hot-spot gradient, each a first-order response with its own time constant),
 * insulation aging acceleration, equivalent aging and loss of life.
 *
 * Equations as transcribed from C57.91-2011 in arXiv:1703.01397 Section II (secondary source, see
 * data/c57_91_thermal.json for every value's citation and status):
 *   ultimate top-oil rise      dTO_U = dTO_R * ((K^2 R + 1) / (R + 1))^n
 *   top-oil response           dTO(t) = (dTO_U - dTO_i) (1 - exp(-t / tauTO)) + dTO_i
 *   ultimate hot-spot gradient dH_U = dH_R * K^(2m)
 *   hot-spot response          dH(t)  = (dH_U - dH_i) (1 - exp(-t / tauW)) + dH_i
 *   hot spot                   thetaH = thetaA + dTO + dH
 *   aging acceleration         F_AA = exp(B / (ref + 273) - B / (thetaH + 273)), B = 15000, ref = 110 C
 *   equivalent aging           F_EQA = sum(F_AA dt) / sum(dt)
 *   loss of life               LOL % = F_EQA * t * 100 / normal life (h)
 *
 * Time stepping: load K and ambient are held constant within each hour (the load profile is hourly). Within a
 * step of dt minutes each rise moves toward its ultimate value by the exact exponential factor exp(-dt / tau),
 * which is the closed-form solution for a piecewise-constant input. The update is therefore unconditionally
 * stable for any dt > 0 (no explicit-Euler dt < tau limit) and exact at every step boundary; dt only sets how
 * finely F_AA is integrated and how smooth the playback trace is. Default dt = 1 min.
 * Initial state: steady state at hour 0, then the 24 h cycle is repeated until the end-of-day state matches the
 * start (periodic steady state, within 0.01 C) so the result does not depend on an arbitrary start temperature.
 *
 * Not modelled (documented limitations): the C57.91 correction of tauTO at non-rated load for n != 1, the
 * variation of losses and oil viscosity with temperature, the duct-oil (Annex G) model and the revised
 * C57.91-2025 Clause 7 model, harmonic losses, cooling-stage switching (ONAN/ONAF changeover). */
import DATA from "./data/c57_91_thermal.json" with { type: "json" };

export const THERMAL_DATA = DATA;
export const COOLING_MODES = ["ONAN", "ONAF", "OFAF", "ODAF"];
export const PARAM_KEYS = ["d_to_r", "d_h_r", "r", "tau_to_min", "tau_w_min", "n", "m"];
export const PARAM_INFO = {
  d_to_r: { label: "Rated top-oil rise over ambient", unit: "°C", min: 1, max: 120 },
  d_h_r: { label: "Rated hot-spot rise over top oil", unit: "°C", min: 0, max: 100 },
  r: { label: "Load loss / no-load loss at rated load (R)", unit: "", min: 0, max: 100 },
  tau_to_min: { label: "Top-oil time constant (rated)", unit: "min", min: 1, max: 2000 },
  tau_w_min: { label: "Winding time constant", unit: "min", min: 0.1, max: 120 },
  n: { label: "Oil exponent n", unit: "", min: 0.5, max: 1.5 },
  m: { label: "Winding exponent m", unit: "", min: 0.5, max: 1.5 },
};

/** Cooling mode for the model from a System cooling string ("ONAN", "ONAN/ONAF", "OFAF" ...): first stage. */
export function coolingModeOf(s) {
  const first = String(s || "").toUpperCase().split(/[\/,\s]+/)[0];
  return COOLING_MODES.includes(first) ? first : "ONAN";
}

/** Exponents { n, m, status, source } for a cooling mode from the data table. */
export function exponentsFor(mode) {
  const e = DATA.exponents[mode] || DATA.exponents.ONAN;
  return { n: e.n, m: e.m, status: e.status, confidence: e.confidence, source: e.source };
}

/** Aging acceleration factor at hot spot thetaH (°C). 1.0 at the 110 °C reference. */
export function agingFactor(thetaH, aging = DATA.aging) {
  const B = aging.b_constant, ref = aging.reference_hot_spot_c + 273;
  return Math.exp(B / ref - B / (thetaH + 273));
}

/** Ultimate top-oil rise over ambient (°C) at load K (pu). */
export const ultimateTopOilRise = (K, p) => p.d_to_r * Math.pow((K * K * p.r + 1) / (p.r + 1), p.n);
/** Ultimate hot-spot rise over top oil (°C) at load K (pu). */
export const ultimateHotSpotGradient = (K, p) => p.d_h_r * Math.pow(K, 2 * p.m);

/** Missing or out-of-range thermal parameters: [{ key, label, message }]. Empty when all are usable. */
export function validateParams(p = {}) {
  const bad = [];
  for (const k of PARAM_KEYS) {
    const v = p[k], info = PARAM_INFO[k];
    if (v === null || v === undefined || v === "" || !Number.isFinite(+v)) bad.push({ key: k, label: info.label, message: "required" });
    else if (+v < info.min || +v > info.max) bad.push({ key: k, label: info.label, message: `outside ${info.min} to ${info.max}` });
  }
  return bad;
}

const hourly = (v, name) => {
  const a = Array.isArray(v) ? v : Array(24).fill(v);
  if (a.length !== 24 || a.some((x) => x === null || x === "" || !Number.isFinite(+x))) throw new Error(`${name} must be one number or 24 hourly numbers.`);
  return a.map(Number);
};

/**
 * Simulate the 24 h cycle.
 * @param {object} o { K: 24 loads in pu of rating, ambient: °C (number or 24 values), params: {d_to_r, d_h_r, r,
 *   tau_to_min, tau_w_min, n, m}, dt_min = 1, normal_life_h = 180000, max_cycles = 30, tol_c = 0.01 }
 * @returns {{ok, message?, steps, hourly, peak_theta_h, peak_t_min, peak_theta_to, feqa, eq_aging_h, lol_pct,
 *   cycles, converged, dt_min, normal_life_h, rated_theta_h_at_amb}}
 */
export function simulateLoading(o) {
  const p = o.params || {};
  const bad = validateParams(p);
  if (bad.length) return { ok: false, message: `Thermal inputs needed: ${bad.map((b) => `${b.label} (${b.message})`).join(", ")}.`, missing: bad };
  let K, A;
  try { K = hourly(o.K, "Load"); A = hourly(o.ambient, "Ambient"); } catch (e) { return { ok: false, message: e.message }; }
  if (K.some((k) => k < 0)) return { ok: false, message: "Load must be non-negative." };
  const P = Object.fromEntries(PARAM_KEYS.map((k) => [k, +p[k]]));
  const dt = o.dt_min ?? 1;
  if (!(dt > 0) || 60 % dt !== 0) return { ok: false, message: "Time step must divide 60 minutes." };
  const life = o.normal_life_h ?? DATA.normal_life_h.value;
  const perH = 60 / dt;
  const fTO = Math.exp(-dt / P.tau_to_min), fW = Math.exp(-dt / P.tau_w_min);

  // one day from state (dTO, dH); record=true keeps the per-step trace
  const day = (dTO, dH, record) => {
    const steps = record ? [{ t_min: 0, K: K[0], amb: A[0], d_to: dTO, d_h: dH, theta_to: A[0] + dTO, theta_h: A[0] + dTO + dH, faa: agingFactor(A[0] + dTO + dH) }] : null;
    let faaSum = 0;
    for (let h = 0; h < 24; h++) {
      const uTO = ultimateTopOilRise(K[h], P), uH = ultimateHotSpotGradient(K[h], P);
      for (let s = 0; s < perH; s++) {
        const th0 = A[h] + dTO + dH;
        dTO = uTO + (dTO - uTO) * fTO;
        dH = uH + (dH - uH) * fW;
        const th1 = A[h] + dTO + dH;
        // trapezoid of F_AA over the step (ambient is held for the hour, so both ends use A[h])
        faaSum += 0.5 * (agingFactor(th0) + agingFactor(th1)) * dt;
        if (record) steps.push({ t_min: h * 60 + (s + 1) * dt, K: K[h], amb: A[h], d_to: dTO, d_h: dH, theta_to: A[h] + dTO, theta_h: th1, faa: agingFactor(th1) });
      }
    }
    return { dTO, dH, faaSum, steps };
  };

  let dTO = ultimateTopOilRise(K[0], P), dH = ultimateHotSpotGradient(K[0], P);
  const maxCycles = o.max_cycles ?? 30, tol = o.tol_c ?? 0.01;
  let cycles = 0, converged = false;
  while (cycles < maxCycles) {
    const r = day(dTO, dH, false);
    cycles++;
    const done = Math.abs(r.dTO - dTO) < tol && Math.abs(r.dH - dH) < tol;
    dTO = r.dTO; dH = r.dH;
    if (done) { converged = true; break; }
  }
  const r = day(dTO, dH, true);
  const steps = r.steps;
  const feqa = r.faaSum / (24 * 60);
  const eq_aging_h = feqa * 24;
  const lol_pct = (eq_aging_h * 100) / life;

  const hourlyRows = [];
  for (let h = 0; h < 24; h++) {
    const seg = steps.slice(h * perH, (h + 1) * perH + 1);
    // the first point of each hour after hour 0 still carries the previous hour's ambient; use this hour's
    const thH = seg.map((s) => s.d_to + s.d_h + A[h]), thTO = seg.map((s) => s.d_to + A[h]);
    let faaH = 0;
    for (let i = 1; i < thH.length; i++) faaH += 0.5 * (agingFactor(thH[i - 1]) + agingFactor(thH[i])) * dt;
    hourlyRows.push({
      hour: h, K: K[h], amb: A[h],
      theta_to_end: thTO[thTO.length - 1], theta_h_end: thH[thH.length - 1],
      theta_to_max: Math.max(...thTO), theta_h_max: Math.max(...thH),
      faa_mean: faaH / 60,
    });
  }
  let pk = 0;
  for (let i = 1; i < steps.length; i++) if (steps[i].theta_h > steps[pk].theta_h) pk = i;
  return {
    ok: true, steps, hourly: hourlyRows, dt_min: dt, cycles, converged, normal_life_h: life,
    peak_theta_h: steps[pk].theta_h, peak_t_min: steps[pk].t_min, peak_theta_to: Math.max(...steps.map((s) => s.theta_to)),
    peak_k: Math.max(...K), feqa, eq_aging_h, lol_pct, normal_lol_pct: (24 * 100) / life,
    params: P,
  };
}

/** Hourly per-unit loading of one transformer from a load-profile study (src/engine/loadprofile.js profileStudy):
 *  profile.loading[id][h] is the apparent-power loading in % of nameplate kVA (larger of the HV and LV ends). */
export function loadingFromProfile(profile, id) {
  const a = profile?.loading?.[id];
  if (!profile?.ok || !Array.isArray(a) || a.length !== 24 || a.some((v) => v == null)) return null;
  return a.map((pct) => pct / 100);
}

/** Transformers in a system that a profile reports loading for. */
export const loadableTransformers = (sys, profile) =>
  (sys.equipment || []).filter((e) => e.type === "transformer" && loadingFromProfile(profile, e.id));

/**
 * One transformer's thermal study from a profileStudy result.
 * opts: { params, ambient, dt_min, normal_life_h, limits: { hot_spot_c, top_oil_c } (user-set; optional) }
 * Returns simulateLoading's result plus { id, kva, checks[] }.
 */
export function transformerLoadingStudy(sys, id, profile, opts = {}) {
  const e = (sys.equipment || []).find((x) => x.id === id && x.type === "transformer");
  if (!e) return { ok: false, message: `${id} is not a transformer in this system.` };
  const K = loadingFromProfile(profile, id);
  if (!K) return { ok: false, message: profile?.ok === false ? profile.message : `No hourly loading for ${id} (de-energized or not solved).` };
  const r = simulateLoading({ ...opts, K });
  if (!r.ok) return { ...r, id };
  const statusNote = "C57.91 equations and constants from secondary sources (UNVERIFIED).";
  const checks = [
    { name: `${id} equivalent aging over 24 h`, value: r.feqa, limit: 1, unit: "x normal", passed: r.feqa <= 1, direction: "max",
      clause: "IEEE C57.91 equivalent aging F_EQA (110 °C reference)", status: DATA.aging.status, note: `F_EQA <= 1 means the day uses no more than one day of normal life. ${statusNote}` },
    { name: `${id} loss of life in 24 h`, value: r.lol_pct, limit: r.normal_lol_pct, unit: "%", passed: r.lol_pct <= r.normal_lol_pct + 1e-12, direction: "max",
      clause: `IEEE C57.91 percent loss of life, normal life ${life(r)} h`, status: DATA.normal_life_h.status, note: `Limit is one normal day: 24 h x 100 / ${life(r)} h. ${statusNote}` },
  ];
  const lim = opts.limits || {};
  if (Number.isFinite(lim.hot_spot_c)) checks.push({ name: `${id} peak hot spot`, value: r.peak_theta_h, limit: lim.hot_spot_c, unit: "°C", passed: r.peak_theta_h <= lim.hot_spot_c, direction: "max", clause: "User-set hot-spot limit (project / C57.91 loading category)", status: "USER", note: "Limit entered by the user." });
  if (Number.isFinite(lim.top_oil_c)) checks.push({ name: `${id} peak top oil`, value: r.peak_theta_to, limit: lim.top_oil_c, unit: "°C", passed: r.peak_theta_to <= lim.top_oil_c, direction: "max", clause: "User-set top-oil limit (project / C57.91 loading category)", status: "USER", note: "Limit entered by the user." });
  return { ...r, id, kva: e.kva, checks };
}
const life = (r) => r.normal_life_h.toLocaleString("en-US");
