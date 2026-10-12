/* Result overlays for the System 3D view: colour scales and per-element overlay data derived from the
   analysis object the System workspace already computes (analyseSystem). Pure: no DOM, no THREE, no React,
   so it is unit-tested in tests/systemoverlay.test.mjs. Colours are [r, g, b] arrays (0–255). */

export const OVERLAY_MODES = ["none", "loading", "voltage"];
export const V_BAND = [0.95, 1.05];
export const LOADING_WARN = 80, LOADING_CRIT = 100;

const GREEN = [76, 195, 138], AMBER = [232, 195, 90], ORANGE = [255, 139, 74], RED = [255, 95, 95], BLUE = [90, 160, 224], VIOLET = [170, 110, 230];
export const NEUTRAL = [147, 168, 184];
export const OFF_GREY = [92, 98, 104];

// loading %: green until 60 %, amber at 85 %, red at 100 % and above
export const LOADING_STOPS = [[0, GREEN], [60, GREEN], [85, AMBER], [100, RED]];
// per-unit voltage: diverging about 1.0 so low (orange/red) and high (blue/violet) read differently
export const VOLTAGE_STOPS = [[0.9, RED], [0.95, ORANGE], [0.98, GREEN], [1.02, GREEN], [1.05, BLUE], [1.1, VIOLET]];

/* Piecewise-linear interpolation through [value, rgb] stops, clamped at both ends. */
export function interpStops(stops, x) {
  if (!Number.isFinite(x)) return null;
  if (x <= stops[0][0]) return [...stops[0][1]];
  for (let k = 1; k < stops.length; k++) {
    const [b, cb] = stops[k];
    if (x <= b) {
      const [a, ca] = stops[k - 1], f = b === a ? 1 : (x - a) / (b - a);
      return ca.map((v, j) => Math.round(v + (cb[j] - v) * f));
    }
  }
  return [...stops[stops.length - 1][1]];
}

export const loadingColor = (pct) => (pct == null ? null : interpStops(LOADING_STOPS, pct));
export const voltageColor = (v) => (v == null ? null : interpStops(VOLTAGE_STOPS, v));
export function loadingState(pct) {
  if (pct == null || !Number.isFinite(pct)) return "na";
  return pct > LOADING_CRIT ? "crit" : pct >= LOADING_WARN ? "warn" : "ok";
}
/* Flag anything outside the band (inclusive limits pass). */
export function voltageState(v, band = V_BAND) {
  if (v == null || !Number.isFinite(v)) return { state: "na", flag: null };
  const eps = 1e-9;
  if (v < band[0] - eps) return { state: "crit", flag: "low" };
  if (v > band[1] + eps) return { state: "crit", flag: "high" };
  const margin = 0.2 * (band[1] - band[0]);
  return { state: v < band[0] + margin / 2 || v > band[1] - margin / 2 ? "warn" : "ok", flag: null };
}

export const toHex = (c) => (c ? (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]) : null);
export const fromHex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
export const toCss = (c) => (c ? `rgb(${c.map((v) => Math.round(v)).join(",")})` : null);
/* De-energized look: drop the hue, keep a little of the part's lightness so models stay readable. */
export function greyOut(hex) {
  const [r, g, b] = fromHex(hex);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const v = Math.round(OFF_GREY[0] * 0.65 + l * 0.35);
  return toHex([v, v, v]);
}
export const shadeHex = (hex, k) => toHex(fromHex(hex).map((v) => Math.min(255, v * k)));

const f = (x, d) => (x == null || !Number.isFinite(x) ? "–" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const GEAR = new Set(["switchgear", "mcc", "panel"]);

function eqLoading(e, r) {
  if (r.loading_pct != null) return { value: r.loading_pct, color: loadingColor(r.loading_pct), state: loadingState(r.loading_pct), text: `${f(r.loading_pct, 0)} % loaded` };
  // no rating to compare against: show what it carries, neutral colour
  const text = r.i_a != null ? `${f(r.i_a, 0)} A` : r.s_kva != null ? `${f(r.s_kva, 0)} kVA` : r.q_kvar != null ? `${f(r.q_kvar, 0)} kvar` : r.p_kw != null ? `${f(r.p_kw, 0)} kW` : "";
  return { value: null, color: NEUTRAL, state: "na", text };
}
function eqVoltage(e, r, band) {
  // transformers sit on two buses: report the worse end
  let v = r.v_pu, side = "";
  if (e.type === "transformer" && r.v_lv_pu != null && Math.abs(r.v_lv_pu - 1) > Math.abs(v - 1)) { v = r.v_lv_pu; side = " LV"; }
  else if (e.type === "transformer") side = " HV";
  const vs = voltageState(v, band);
  return { value: v, color: voltageColor(v), state: vs.state, flag: vs.flag, text: `${f(v, 3)} pu${side}${vs.flag ? (vs.flag === "low" ? " ▼ LOW" : " ▲ HIGH") : ""}` };
}
function eqFault(e, r) {
  const ik = e.type === "transformer" ? r.lv_ik_ka : GEAR.has(e.type) || e.type === "utility" ? r.ik_ka : null;
  if (ik == null) return null;
  const duty = GEAR.has(e.type) ? r.sc_duty_pct : null;
  const state = duty == null ? "na" : duty > 100 ? "crit" : duty > 90 ? "warn" : "ok";
  return { ik_ka: ik, duty_pct: duty, state, text: `I″k ${f(ik, 1)} kA${e.type === "transformer" ? " LV" : ""}${duty != null ? ` · ${f(duty, 0)} % of rating` : ""}` };
}

/**
 * Per-element overlay data.
 * @param sys       system model ({ equipment, connectors })
 * @param analysis  result of analyseSystem (already computed by the System workspace; not re-solved here)
 * @param opts      { mode: "none" | "loading" | "voltage", band: [lo, hi], fault: boolean }
 * @returns { mode, solved, equipment: {id: entry}, connectors: {id: entry}, summary }
 *          entry = { off, state, color, value, text, flag?, fault? }
 */
export function deriveOverlay(sys, analysis, opts = {}) {
  const mode = opts.mode ?? "none", band = opts.band ?? V_BAND;
  const solved = !!analysis?.ok;
  const out = { mode, band, solved, equipment: {}, connectors: {}, summary: { off: 0, flagged: 0, overloaded: 0 } };
  const res = (solved && analysis.equipment) || {}, cres = (solved && analysis.connectors) || {};
  const buses = analysis?.lf?.buses || [];
  for (const e of sys.equipment) {
    const r = res[e.id];
    if (!solved || !r) { out.equipment[e.id] = { off: false, state: "na", color: null, value: null, text: "" }; continue; }
    if (r.deenergized) { out.equipment[e.id] = { off: true, state: "off", color: OFF_GREY, value: null, text: "De-energized" }; out.summary.off++; continue; }
    const entry = mode === "loading" ? eqLoading(e, r) : mode === "voltage" ? eqVoltage(e, r, band) : { state: "na", color: null, value: null, text: "" };
    entry.off = false;
    if (opts.fault) entry.fault = eqFault(e, r);
    if (entry.flag) out.summary.flagged++;
    if (mode === "loading" && entry.state === "crit") out.summary.overloaded++;
    out.equipment[e.id] = entry;
  }
  const isOff = (end) => out.equipment[String(end).split(".")[0]]?.off;
  for (const c of sys.connectors) {
    const r = cres[c.id];
    if (!solved) { out.connectors[c.id] = { off: false, state: "na", color: null, value: null, text: "" }; continue; }
    // open breakers, and branches dropped from the solve because their island is dead
    if (!r || r.open || (isOff(c.from) && isOff(c.to))) { out.connectors[c.id] = { off: true, state: "off", color: OFF_GREY, value: null, text: r?.open ? "Open" : "De-energized" }; out.summary.off++; continue; }
    let entry;
    if (mode === "loading") {
      entry = r.loading_pct != null
        ? { value: r.loading_pct, color: loadingColor(r.loading_pct), state: loadingState(r.loading_pct), text: `${f(r.loading_pct, 0)} % · ${f(r.i_a, 0)} A` }
        : { value: null, color: NEUTRAL, state: "na", text: `${f(r.i_a, 0)} A` };
      if (entry.state === "crit") out.summary.overloaded++;
    } else if (mode === "voltage") {
      const vs = [buses[r.from_bus - 1]?.v, buses[r.to_bus - 1]?.v].filter((v) => v != null);
      const v = vs.length ? vs.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a)) : null;
      const st = voltageState(v, band);
      entry = { value: v, color: voltageColor(v), state: st.state, flag: st.flag, text: `ΔV ${f(r.vd_pct, 2)} %` };
    } else entry = { state: "na", color: null, value: null, text: "" };
    entry.off = false;
    out.connectors[c.id] = entry;
  }
  return out;
}

/* Legend for a mode: a CSS gradient plus tick labels positioned 0..1 along it. */
export function overlayLegend(mode, band = V_BAND) {
  if (mode === "loading") {
    const lo = 0, hi = 110, at = (x) => (x - lo) / (hi - lo);
    return {
      title: "Loading vs rating",
      gradient: `linear-gradient(90deg, ${[...LOADING_STOPS, [hi, RED]].map(([x, c]) => `${toCss(c)} ${(at(x) * 100).toFixed(1)}%`).join(", ")})`,
      ticks: [0, 50, 80, 100].map((x) => ({ at: at(x), label: x === 100 ? "100 %" : `${x}` })),
      notes: ["Unrated items (motors, loads, utility) show neutral."],
    };
  }
  if (mode === "voltage") {
    const lo = VOLTAGE_STOPS[0][0], hi = VOLTAGE_STOPS[VOLTAGE_STOPS.length - 1][0], at = (x) => (x - lo) / (hi - lo);
    return {
      title: "Bus voltage (pu)",
      gradient: `linear-gradient(90deg, ${VOLTAGE_STOPS.map(([x, c]) => `${toCss(c)} ${(at(x) * 100).toFixed(1)}%`).join(", ")})`,
      ticks: [lo, band[0], 1, band[1], hi].map((x) => ({ at: at(x), label: x.toFixed(2) })),
      band: [at(band[0]), at(band[1])],
      notes: [`Flagged outside ${band[0].toFixed(2)}–${band[1].toFixed(2)} pu.`],
    };
  }
  return null;
}
