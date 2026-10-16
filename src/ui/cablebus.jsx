/* Cable bus workspace: Check (analyse a given design) and Designer (enumerate + rank options).
   Engine: src/engine/pecalc/cablebus.js, cablebus_design.js, drawing.js (ports of pecalc). */
const { useState, useMemo, useEffect, useRef } = React;
import { Btn, Field, NumField, Pill, Section, cx, fmt, WsHeader, KpiStrip, ChecksTable, StateMsg, checkMeter, checkStatus } from "./common.jsx";
import { Chart, Bars, RefLine, Heatmap, PHASE_VAR } from "./charts/index.js";
import { bus } from "./bus.js";
import * as cond from "../engine/pecalc/conductors.js";
import { analyse, cableBusInput, cableBusGroups, buildLayout, construction } from "../engine/pecalc/cablebus.js";
import { designOptions, designRequest, designOptionLabel, BLOCK_MATERIALS } from "../engine/pecalc/cablebus_design.js";
import { CableBus3D } from "./cablebus3d.jsx";
import { cablebusSvg } from "../engine/pecalc/drawing.js";
import { solveSharing } from "../engine/pecalc/impedance.js";
import { bRmsUt, LIMITS_UT } from "../engine/pecalc/field.js";
import { kvRows, checkRows } from "../engine/report.js";
import { tableInfo } from "../engine/pecalc/ampacity.js";
import { ReportButton, reportFigures } from "./reportButton.jsx";
import { PushToSystem } from "./systemPush.jsx";
import { cableBusDesign } from "../engine/designPush.js";
import { connectorTerminalC } from "../engine/system.js";

const CSS = `
.cb-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; padding: 12px 16px; align-items: start; }
.cb-form, .cb-results { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.cb-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.cb-fields .cb-wide { grid-column: 1 / -1; }
.cb-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.cb-wrap { white-space: normal !important; min-width: 150px; font-family: var(--font-ui) !important; }
.cb-note { font-size: 11px; color: var(--faint); margin-top: 2px; }
.cb-clause { color: var(--muted); font-size: 12px !important; }
.cb-unit { font-style: normal; color: var(--faint); font-size: 11px; }
.cb-notes { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); list-style: disc; padding-left: 18px; }
.cb-svgbox { width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.cb-svgbox > svg { display: block; width: 100%; height: auto; }
.cb-svg text { font-family: var(--font-data); fill: var(--fg); }
.cb-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-family: var(--font-data); font-size: 11.5px; color: var(--muted); margin-top: 8px; }
.cb-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; vertical-align: -2px; }
.cb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cb-chip { font-family: var(--font-data); font-size: 12px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); }
.cb-chip.is-on { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); font-weight: 500; }
.cb-from { display: inline-flex; align-items: center; gap: 4px; }
.cb-from button { color: inherit; padding: 0 2px; }
.cb-opt-row { cursor: pointer; }
.cb-pick { color: var(--accent); }
@media (max-width: 1100px) { .cb-two { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 899px) { .cb-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .cb-xs { overflow-x: auto; } .cb-xs > svg { min-width: 760px; } }
@media (max-width: 640px) { .cb-chip { min-height: 40px; min-width: 48px; padding: 6px 12px; } }
@media (max-width: 420px) { .cb-fields { grid-template-columns: minmax(0, 1fr); } .cb-grid { padding: 10px 16px; } }
`;

/* Starting state: the 15 kV, 2000 A, 3 x 750 kcmil Cu EPR per phase example. */
const EXAMPLE = {
  voltage_v: 15000, current_a: 2000, size: "750", material: "Cu", conductors_per_phase: 3, tiers: 1,
  insulation: "EPR", insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2.0, shield_bonding: "both_ends",
  length_ft: 200, ambient_c: 40, insulation_temp_c: 90, terminal_temp_c: 90, ampacity_method: "auto",
  cable_ampacity_a: undefined, cable_od_mm: undefined, fault_ka: 40, fault_clearing_s: undefined, x_over_r: 15,
  enclosure_on: true, enc_w: 800, enc_h: 150, covers_continuous: false, max_vd_pct: 3,
};
const DESIGN_EXAMPLE = {
  voltage_v: 15000, current_a: 2000, material: "Cu", length_ft: 200, ambient_c: 40, insulation: "EPR",
  insulation_mm: 7.2, shield_mm: 0.13, jacket_mm: 2.0, fault_ka: 40, x_over_r: 15, max_loading_pct: 95,
  sizes: ["500", "750", "1000"], tiers: [1, 2, 3], block_material: "GPO-3", ampacity_method: "auto",
};
const FT = 0.3048;
const SIZE_CHOICES = cond.SIZES.slice(cond.SIZES.indexOf("1/0"));
const PH_COLOR = { A: "var(--ph-a)", B: "var(--ph-b)", C: "var(--ph-c)" };

/* ------------------------------------------------------------ form -> engine input */
function autoOd(f) {
  try {
    const base = cableBusInput({ size: f.size, voltage_v: f.voltage_v, material: f.material, insulation: f.insulation,
      insulation_mm: f.voltage_v > 2000 || f.ampacity_method === "calculated" ? f.insulation_mm ?? null : null,
      shield_mm: f.shield_mm, jacket_mm: f.jacket_mm, insulation_temp_c: f.insulation_temp_c });
    const cons = construction(base);
    return f.cable_od_mm || (cons ? cons.de_mm : null) || (f.voltage_v <= 2000 ? cond.cableOdMm(f.size) : null);
  } catch { return null; }
}

function toInput(f) {
  const mv = f.voltage_v > 2000;
  const calc = f.ampacity_method === "calculated";
  const o = {
    voltage_v: f.voltage_v, current_a: f.current_a, size: f.size, material: f.material,
    conductors_per_phase: f.conductors_per_phase, tiers: f.tiers, length_m: f.length_ft * FT,
    ambient_c: f.ambient_c, ampacity_method: f.ampacity_method, insulation_temp_c: f.insulation_temp_c,
    terminal_temp_c: f.terminal_temp_c, max_vd_pct: f.max_vd_pct, x_over_r: f.x_over_r,
    shield_bonding: mv ? f.shield_bonding : "none", covers_continuous: f.covers_continuous,
  };
  if (f.cable_ampacity_a) o.cable_ampacity_a = f.cable_ampacity_a;
  if (f.cable_ampacity_lambda1_ref) o.cable_ampacity_lambda1_ref = f.cable_ampacity_lambda1_ref;
  if (f.cable_od_mm) o.cable_od_mm = f.cable_od_mm;
  if (f.fault_ka) o.fault_ka = f.fault_ka;
  if (f.fault_clearing_s) o.fault_clearing_s = f.fault_clearing_s;
  if (mv || calc) {
    o.insulation = f.insulation; o.insulation_mm = f.insulation_mm ?? cond.insulationMm(f.size);
    o.shield_mm = f.shield_mm; o.jacket_mm = f.jacket_mm;
  }
  if (f.enclosure_on) {
    const od = autoOd(f);
    const pitch = 2 * (od || 0);
    const per_tier = (3 * f.conductors_per_phase) / f.tiers;
    const w = f.enc_w ?? Math.ceil(((per_tier - 1) * pitch + (od || 0) + 50) / 10) * 10;
    const h = f.enc_h ?? Math.ceil(((f.tiers - 1) * pitch + (od || 0) + 70) / 10) * 10;
    o.enclosure_width_mm = w; o.enclosure_height_mm = h;
  }
  return o;
}

function solve(f) {
  try {
    const inp = cableBusInput(toInput(f));
    const res = analyse(inp);
    return { inp, res };
  } catch (e) {
    return { error: e.message };
  }
}

/* Calculation package for the Check tab (see engine/report.js). */
function cableBusReport(f, host) {
  const { inp, res } = solve(f);
  if (!res) return null;
  const i = res.input, info = tableInfo(i.code, "free_air");
  return {
    title: "Cable bus check", module: "cablebus", subtitle: `${i.voltage_v} V, ${i.current_a} A, ${i.conductors_per_phase} x ${i.size} ${i.material} per phase`,
    inputs: kvRows(i, { voltage_v: "V", current_a: "A", length_m: "m", ambient_c: "C", fault_ka: "kA", fault_clearing_s: "s", max_vd_pct: "%", x_over_r: "" }),
    results: [
      { label: "Phase pattern", value: res.pattern }, { label: "Worst conductor loading", value: res.max_loading_pct, unit: "%" },
      { label: "Voltage drop", value: res.vd_pct, unit: "%" }, { label: "Conductor loss", value: res.conductor_loss_w, unit: "W" },
      { label: "Shield loss", value: res.shield_loss_w, unit: "W" }, { label: "Enclosure loss", value: res.enclosure_loss_w, unit: "W" },
      { label: "Fault force", value: res.fault_force_lbf_per_ft, unit: "lbf/ft" }, { label: "Support load", value: res.support_load_lbf, unit: "lbf" },
    ],
    checks: checkRows(res.checks),
    tables: [{ title: "Conductor currents", columns: ["Phase", "Tier", "x (mm)", "Current (A)", "% of equal share", "Ampacity (A)", "Loading %"],
      rows: res.conductors.map((c) => [c.phase, c.tier, c.x_mm, c.current_a, c.share_pct, c.ampacity_a, c.loading_pct]) }],
    figures: [...(i.enclosure_width_mm ? [{ title: "Cross-section", svg: cablebusSvg(inp, res, { tier_dims: true }) }] : []), ...reportFigures(host)],
    notes: res.notes,
    dataStatus: [{ table: `${i.code} ${info.table_name} (${info.edition})`, status: info.status, source: info.source }],
  };
}

/* ------------------------------------------------------------ small charts */
function SharingChart({ res }) {
  const rows = res.conductors;
  const n = rows.length;
  const equal = res.input.current_a / res.input.conductors_per_phase;
  const maxV = Math.max(...rows.map((r) => r.current_a), equal) * 1.12;
  return (
    <Chart height={240} minWidth={n > 24 ? n * 22 : 0} ariaLabel="Current per conductor" reportTitle="Current sharing per conductor"
      x={{ type: "band", n, labels: rows.map((r) => `${r.phase}${n <= 18 ? r.tier + 1 : ""}`), label: "Conductor (phase and tier)", maxBar: 28, inner: 0.25 }}
      y={{ domain: [0, maxV], label: "Current", unit: "A rms" }}
      legend={[{ name: "Phase A", color: PHASE_VAR.A, kind: "bar" }, { name: "Phase B", color: PHASE_VAR.B, kind: "bar" }, { name: "Phase C", color: PHASE_VAR.C, kind: "bar" }, { name: `Equal share ${fmt(equal, 0)} A`, color: "var(--accent)", kind: "ref" }]}
      hover={{ render: (i) => { const r = rows[i]; return { title: `Phase ${r.phase}, tier ${r.tier + 1}`, rows: [
        { label: "current", value: `${fmt(r.current_a, 0)} A`, color: PHASE_VAR[r.phase] },
        { label: "of equal share", value: `${fmt(r.share_pct, 1)} %` },
        { label: "loading", value: `${fmt(r.loading_pct, 1)} %` },
        { label: "x position", value: `${fmt(r.x_mm, 0)} mm` }] }; } }}>
      <RefLine y={equal} tone="accent" />
      <Bars values={rows.map((r) => r.current_a)} color={(v, i) => PHASE_VAR[rows[i].phase]} labels={() => n <= 12} />
    </Chart>
  );
}

function CrossSection({ inp, res }) {
  const html = useMemo(() => {
    let s = cablebusSvg(inp, res, { tier_dims: true }); // support blocks per tier + tier pitch dimension
    // restyle the white-paper drawing for the dark theme, and phase colours A red / B yellow / C blue
    s = s.replace("fill='#ffffff'", "fill='#0a0f14'").replace("font-size='12'>", "font-size='12' fill='#d6dfe6'>")
      .replace(/stroke='#333'/g, "stroke='#8a9aa7'").replace(/fill='#333'/g, "fill='#8a9aa7'")
      .replace(/#d64545/g, "#e05a4f").replace(/#2f6fd6/g, "#e8c35a").replace(/#2e9d5b/g, "#5aa0e0")
      .replace("fill='#fff' font-weight='bold'>B<", "fill='#1c1606' font-weight='bold'>B<")
      .replace(/stroke='#222'/g, "stroke='#0a0f14'");
    return s;
  }, [inp, res]);
  return <div className="cb-svgbox cb-svg cb-xs" dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ------------------------------------------------------------ magnetic field map */
/* Binned scale: sequential blues below the ICNIRP 1998 public reference level, status colours above it. */
const LIM_UT = LIMITS_UT["ICNIRP 1998 public"];
const FIELD_STEPS = [
  { max: 1, color: "#0f2336", label: "< 1" },
  { max: 3, color: "#174a78", label: "1–3" },
  { max: 10, color: "#256abf", label: "3–10" },
  { max: 30, color: "#5598e7", label: "10–30" },
  { max: LIM_UT, color: "#b7d3f6", label: `30–${LIM_UT}` },
  { max: 200, color: "#ff8b4a", label: `${LIM_UT}–200` },
  { max: Infinity, color: "#ff5f5f", label: "> 200" },
];
const stepOf = (b) => FIELD_STEPS.find((s) => b < s.max);
const fieldColor = (b) => stepOf(b).color;
const FIELD_LEGEND = { steps: FIELD_STEPS, unit: "µT" };

function FieldMap({ inp: liveInp, res: liveRes }) {
  // the grid solve is heavy: defer it so typing in the inputs stays responsive (React renders the
  // urgent update first, then this map with the latest values)
  const inp = React.useDeferredValue(liveInp), res = React.useDeferredValue(liveRes);
  const data = useMemo(() => {
    const od = res.cable_od_mm;
    const cs = buildLayout(inp, res.pattern, od);
    const sol = solveSharing(cs, cableBusGroups(inp, inp.shield_bonding === "both_ends"), inp.frequency_hz);
    const xs = res.conductors.map((c) => c.x_mm), ys = res.conductors.map((c) => c.y_mm);
    const xc = (Math.min(...xs) + Math.max(...xs)) / 2, yc = (Math.min(...ys) + Math.max(...ys)) / 2;
    const encW = inp.enclosure_width_mm || Math.max(...xs) - Math.min(...xs) + 2 * od;
    const encH = inp.enclosure_height_mm || Math.max(...ys) - Math.min(...ys) + 2 * od;
    const halfW = encW / 2 + 1500, halfH = encH / 2 + 1000;
    const nx = 64, cell = (2 * halfW) / nx, ny = Math.ceil((2 * halfH) / cell);
    const cells = [];
    let peak = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xc - halfW + (i + 0.5) * cell, y = yc + halfH - (j + 0.5) * cell;
        const b = bRmsUt(cs, sol.currents, x, y);
        cells.push([i, j, b]);
        const outside = Math.abs(x - xc) > encW / 2 + 40 || Math.abs(y - yc) > encH / 2 + 40;
        if (outside && b > peak) peak = b;
      }
    }
    return { cells, nx, ny, cell, xc, yc, halfW, halfH, encW, encH, od, peak, rows: res.conductors };
  }, [inp, res]);
  const { cells, nx, ny, cell, xc, yc, halfW, halfH, encW, encH, od, rows } = data;
  const values = useMemo(() => cells.map((c) => c[2]), [cells]);
  const X = (x) => x - (xc - halfW), Y = (y) => yc + halfH - y;
  const Wd = 2 * halfW, Ht = ny * cell;
  const readout = (i, j, b) => `x ${fmt((-halfW + (i + 0.5) * cell) / 1000, 2)} m, y ${fmt((halfH - (j + 0.5) * cell) / 1000, 2)} m: ${fmt(b, b < 10 ? 2 : 1)} µT`;
  return (
    <div>
      <Heatmap nx={nx} ny={ny} values={values} color={fieldColor} legend={FIELD_LEGEND}
        ariaLabel="Magnetic flux density around the enclosure" reportTitle="Magnetic field around the enclosure" readout={readout}
        overlay={{ viewBox: `0 0 ${Wd} ${Ht}`, children: (k) => (<>
          <rect x={X(xc - encW / 2)} y={Y(yc + encH / 2)} width={encW} height={encH} fill="none" stroke="#c3ced7" strokeWidth={1.5 / k} strokeDasharray={`${6 / k} ${4 / k}`} />
          {rows.map((r) => <circle key={r.index} cx={X(r.x_mm)} cy={Y(r.y_mm)} r={Math.max(od / 2, 3 / k)} fill={PHASE_VAR[r.phase]} stroke="#0a0f14" strokeWidth={1 / k} />)}
          {[-1, 0, 1].map((m) => <g key={m}>
            <line x1={X(xc + m * 1000)} x2={X(xc + m * 1000)} y1={Ht - 12 / k} y2={Ht - 4 / k} stroke="#d6dfe6" strokeWidth={1.5 / k} />
            <text x={X(xc + m * 1000)} y={Ht - 16 / k} textAnchor="middle" fontSize={11 / k} fill="#d6dfe6" fontFamily="IBM Plex Mono, monospace" paintOrder="stroke" stroke="#0a0f14" strokeWidth={3 / k}>{m} m</text>
          </g>)}
        </>) }} />
      <div className="ck-caption">RMS resultant at the cross-section plane (all conductors, shields and enclosure walls). Beyond the enclosure the peak is <b>{fmt(data.peak, 1)} µT</b>; ICNIRP 1998 public reference level {LIM_UT} µT. Hover or tap for the value at a point.</div>
    </div>
  );
}

/* ------------------------------------------------------------ isometric 3/4 cutaway */
const C30 = Math.cos(Math.PI / 6), S30 = 0.5;
const BLOCK_T = "#c98f74", BLOCK_L = "#a8664a", BLOCK_R = "#b5785d";

function IsoBus({ inp, res }) {
  const g = useMemo(() => {
    const od = res.cable_od_mm, rows = res.conductors;
    const xs = rows.map((r) => r.x_mm), ys = rows.map((r) => r.y_mm);
    const xc = (Math.min(...xs) + Math.max(...xs)) / 2, yc = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w_in = inp.enclosure_width_mm || Math.max(...xs) - Math.min(...xs) + 2 * od + 50;
    const h_in = inp.enclosure_height_mm || Math.max(...ys) - Math.min(...ys) + 2 * od + 70;
    const ts = inp.side_thickness_mm, tc = inp.cover_thickness_mm;
    const W = w_in + 2 * ts, H = h_in + 2 * tc;
    const span = inp.support_span_m * 1000;
    const L = 2 * span + 300, Lc = 0.4 * L;
    const raw = (x, y, z) => [(x - y) * C30, (x + y) * S30 - z];
    const corners = [[0, 0, 0], [W + 60, 0, 0], [0, L, 0], [W + 60, L, 0], [0, 0, H], [W, 0, H], [0, L, H], [W, L, H]].map((c) => raw(...c));
    const minX = Math.min(...corners.map((c) => c[0])), maxX = Math.max(...corners.map((c) => c[0]));
    const minY = Math.min(...corners.map((c) => c[1])), maxY = Math.max(...corners.map((c) => c[1]));
    const VW = 900, pad = 24, s = (VW - 2 * pad) / (maxX - minX);
    const pr = (x, y, z) => { const [a, b] = raw(x, y, z); return [pad + (a - minX) * s, pad + 14 + (b - minY) * s]; };
    const VH = Math.ceil((maxY - minY) * s + 2 * pad + 28);
    return { od, rows, xc, yc, w_in, h_in, ts, tc, W, H, span, L, Lc, pr, s, VW, VH };
  }, [inp, res]);
  const { od, rows, xc, yc, w_in, h_in, ts, tc, W, H, span, L, Lc, pr, s, VW, VH } = g;
  const P = (pts) => pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const quad = (a, b, c, d) => P([pr(...a), pr(...b), pr(...c), pr(...d)]);
  const bx = (r) => ts + w_in / 2 + (r.x_mm - xc);
  const bz = (r) => tc + h_in / 2 + (r.y_mm - yc);
  const tiers = [...new Set(rows.map((r) => r.y_mm))].sort((a, b) => a - b);
  const lip = 10, tb = 25.4;
  const blockYs = [150, 150 + span, 150 + 2 * span];
  const cableRows = [...rows].sort((a, b) => bx(a) + bz(a) - (bx(b) + bz(b)));
  const dc = cond.diameterMm(res.input.size);

  const cable = (r) => {
    const x = bx(r), z = bz(r);
    const a = pr(x, 0, z), b = pr(x, L, z);
    const w = od * s, dxp = S30, dyp = C30; // unit perpendicular in screen space (pointing down-right)
    const off = (m) => [dxp * m * w, dyp * m * w];
    const seg = (m, wm, stroke, op) => { const [ox, oy] = off(m); return <line x1={a[0] + ox} y1={a[1] + oy} x2={b[0] + ox} y2={b[1] + oy} stroke={stroke} strokeWidth={w * wm} opacity={op} />; };
    const ring = [], core = [];
    for (let i = 0; i < 28; i++) {
      const t = (2 * Math.PI * i) / 28;
      ring.push(pr(x + (od / 2) * Math.cos(t), L, z + (od / 2) * Math.sin(t)));
      core.push(pr(x + (dc / 2) * Math.cos(t), L, z + (dc / 2) * Math.sin(t)));
    }
    return (
      <g key={r.index}>
        {seg(0, 1, PH_COLOR[r.phase], 1)}
        {seg(0.26, 0.46, "#000", 0.22)}
        {seg(-0.24, 0.2, "#fff", 0.28)}
        <polygon points={P(ring)} fill={PH_COLOR[r.phase]} stroke="rgba(0,0,0,.45)" strokeWidth="1" />
        <polygon points={P(ring)} fill="#000" opacity="0.12" />
        <polygon points={P(core)} fill="var(--brass)" stroke="rgba(0,0,0,.4)" strokeWidth="0.8" />
      </g>
    );
  };

  const block = (tierY, yb) => {
    const z0 = tc + h_in / 2 + (tierY - yc) - od / 2 - lip, z1 = z0 + od + 2 * lip;
    const x0 = ts, x1 = W - ts, y1 = yb + tb;
    return (
      <g key={`${tierY}-${yb}`}>
        <polygon points={quad([x0, yb, z1], [x1, yb, z1], [x1, y1, z1], [x0, y1, z1])} fill={BLOCK_T} stroke="#7a4631" strokeWidth="0.7" />
        <polygon points={quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1])} fill={BLOCK_L} stroke="#7a4631" strokeWidth="0.7" />
        <polygon points={quad([x1, y1, z0], [x1, yb, z0], [x1, yb, z1], [x1, y1, z1])} fill={BLOCK_R} stroke="#7a4631" strokeWidth="0.7" />
      </g>
    );
  };

  // ventilation slots in the cover (top face z = H), over the covered rear length
  const slots = [];
  const cols = Math.max(2, Math.floor(w_in / 110));
  const colW = w_in / cols;
  for (let y = 40; y + 40 < Lc - 20; y += 70) {
    for (let c = 0; c < cols; c++) {
      const x0 = ts + c * colW + colW * 0.2, x1 = ts + c * colW + colW * 0.8;
      slots.push(<polygon key={`${y}-${c}`} points={quad([x0, y, H], [x1, y, H], [x1, y + 38, H], [x0, y + 38, H])} fill="#0b1117" opacity="0.85" />);
    }
  }
  const dimA = pr(W + 40, blockYs[1], 0), dimB = pr(W + 40, blockYs[2], 0);
  return (
    <div>
      <div className="cb-svgbox">
        <svg viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Isometric cutaway of the cable bus" className="cb-svg">
          {/* far side rail (inner face), bottom plate */}
          <polygon points={quad([ts, 0, 0], [ts, L, 0], [ts, L, H], [ts, 0, H])} fill="var(--tray-r)" opacity="0.9" />
          <polygon points={quad([0, L, 0], [ts, L, 0], [ts, L, H], [0, L, H])} fill="var(--tray-l)" />
          <polygon points={quad([0, 0, H], [ts, 0, H], [ts, L, H], [0, L, H])} fill="var(--tray-t)" />
          <polygon points={quad([ts, 0, tc], [W - ts, 0, tc], [W - ts, L, tc], [ts, L, tc])} fill="#2c3640" />
          <polygon points={quad([ts, L, 0], [W - ts, L, 0], [W - ts, L, tc], [ts, L, tc])} fill="var(--tray-l)" />
          {/* support blocks, one per tier at each support */}
          {blockYs.map((yb) => tiers.map((ty) => block(ty, yb)))}
          {/* cables */}
          {cableRows.map(cable)}
          {/* ventilated cover over the rear length, cut away in front */}
          <g>
            <polygon points={quad([0, 0, H - tc], [W, 0, H - tc], [W, Lc, H - tc], [0, Lc, H - tc])} fill="#5f6d79" opacity="0" />
            <polygon points={quad([W, 0, H - tc], [W, Lc, H - tc], [W, Lc, H], [W, 0, H])} fill="var(--tray-r)" />
            <polygon points={quad([0, Lc, H - tc], [W, Lc, H - tc], [W, Lc, H], [0, Lc, H])} fill="var(--tray-l)" />
            <polygon points={quad([0, 0, H], [W, 0, H], [W, Lc, H], [0, Lc, H])} fill="var(--tray-t)" stroke="#44515c" strokeWidth="0.8" />
            {slots}
          </g>
          {/* near side rail: translucent plate plus the rail channels at top and bottom */}
          <polygon points={quad([W, 0, 0], [W, L, 0], [W, L, H], [W, 0, H])} fill="var(--tray-r)" opacity="0.16" stroke="var(--tray-r)" strokeWidth="1" />
          <polygon points={quad([W, 0, 0], [W, L, 0], [W, L, 55], [W, 0, 55])} fill="var(--tray-r)" />
          <polygon points={quad([W, Lc, H - 55], [W, L, H - 55], [W, L, H], [W, Lc, H])} fill="var(--tray-r)" />
          <polygon points={quad([W - ts, L, 0], [W, L, 0], [W, L, H], [W - ts, L, H])} fill="var(--tray-l)" />
          <polygon points={quad([W - ts, Lc, H], [W, Lc, H], [W, L, H], [W - ts, L, H])} fill="var(--tray-t)" />
          {/* support spacing dimension */}
          <g stroke="var(--muted)" fill="none"><line x1={dimA[0]} y1={dimA[1]} x2={dimB[0]} y2={dimB[1]} /></g>
          <text x={(dimA[0] + dimB[0]) / 2 + 10} y={(dimA[1] + dimB[1]) / 2 + 16} fontSize="12" fill="var(--muted)">{`supports every ${fmt(span, 0)} mm (${fmt(span / 25.4, 0)} in)`}</text>
          <text x="24" y="22" fontSize="12" fill="var(--muted)">{`${res.input.conductors_per_phase} x ${cond.sizeLabel(res.input.size)} ${res.input.material} per phase, ${res.input.tiers} tier(s), ${fmt(W, 0)} x ${fmt(H, 0)} mm ventilated Al enclosure, cover cut away`}</text>
        </svg>
      </div>
      <div className="cb-legend">
        {["A", "B", "C"].map((p) => <span key={p}><i style={{ background: PH_COLOR[p], borderRadius: 6 }} />Phase {p}</span>)}
        <span><i style={{ background: BLOCK_L }} />Support block (laminate)</span>
        <span><i style={{ background: "var(--tray-t)" }} />Aluminium rails and cover</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Check tab */
function Results({ inp, res }) {
  const n = res.input.conductors_per_phase;
  const minAmp = Math.min(...res.conductors.map((c) => c.ampacity_a));
  const ampPhase = minAmp * n;
  const margin = (ampPhase / res.input.current_a - 1) * 100;
  const shares = res.conductors.map((c) => c.share_pct);
  const lenFt = res.input.length_m / FT;
  const lossW = res.conductor_loss_w + res.shield_loss_w + res.enclosure_loss_w;
  const std = (v) => (Number.isFinite(v) ? fmt(v, Math.abs(v) < 10 ? 2 : 1) : "∞");
  const worstCheck = res.checks.find((c) => c.name.startsWith("Most heavily loaded conductor within its"));
  return (
    <>
      <KpiStrip items={[
        { label: "Ampacity vs load", value: fmt(ampPhase, 0), unit: "A / phase", status: checkStatus(worstCheck), meter: checkMeter(worstCheck, `worst cable ${fmt(res.max_loading_pct, 1)} % loaded`),
          sub: `load ${fmt(res.input.current_a, 0)} A · margin ${margin >= 0 ? "+" : "−"}${fmt(Math.abs(margin), 1)} %` },
        { label: "Current imbalance", value: fmt(Math.max(...shares), 1), unit: "%",
          sub: `of equal share · min ${fmt(Math.min(...shares), 1)} % · spread ${fmt(Math.max(...shares) - Math.min(...shares), 1)} pts · pattern ${res.pattern}` },
        { label: "Voltage drop", value: fmt(res.vd_pct, 2), unit: "%", status: res.vd_pct <= res.input.max_vd_pct ? "pass" : "fail", meter: { u: res.vd_pct / res.input.max_vd_pct },
          sub: `limit ${fmt(res.input.max_vd_pct, 1)} % · ${fmt(lenFt, 0)} ft` },
        { label: "Losses", value: fmt(lossW / lenFt, 1), unit: "W/ft", sub: `${fmt(lossW / 1000, 2)} kW total · shield ${fmt(res.shield_loss_w / 1000, 2)} · enclosure ${fmt(res.enclosure_loss_w / 1000, 2)} kW` },
        { label: "Max fault force", value: res.fault_force_lbf_per_ft === null ? "—" : fmt(res.fault_force_lbf_per_ft, 0), unit: res.fault_force_lbf_per_ft === null ? "" : "lbf/ft",
          sub: res.support_load_lbf === null ? "no fault current given" : `${fmt(res.support_load_lbf, 0)} lbf on one support (${fmt(res.input.support_span_m * 1000, 0)} mm span)` },
      ]} />

      <Section title="Current sharing" aside="per conductor, coloured by phase">
        <SharingChart res={res} />
      </Section>

      <Section title="Checks" aside={<Pill tone={res.passed ? "ok" : "crit"}>{res.passed ? "Pass" : "Fail"}</Pill>}>
        <ChecksTable checks={res.checks} format={std} />
      </Section>

      <div className="cb-two">
        <Section title="Cross-section" aside={<span className="text-faint text-[12px]">to scale · pitch {fmt(res.pitch_mm, 0)} mm{res.input.tiers > 1 ? ` · tier pitch ${fmt(res.tier_pitch_mm, 0)} mm` : ""} · OD {fmt(res.cable_od_mm, 1)} mm</span>}>
          <CrossSection inp={inp} res={res} />
        </Section>
        <Section title="Magnetic field" aside="µT, RMS">
          <FieldMap inp={inp} res={res} />
        </Section>
      </div>

      <Section title="Enclosure, 3D view" aside={<span className="text-faint text-[12px]">to scale, cover cut away</span>}>
        <CableBus3D input={inp} result={res} fallback={<IsoBus inp={inp} res={res} />} />
      </Section>

      <Section title="Notes">
        <ul className="cb-notes">{res.notes.map((t, k) => <li key={k}>{t}</li>)}</ul>
      </Section>
    </>
  );
}

function CheckTab({ f, setF, fromSystem, clearFrom }) {
  const { inp, res, error } = useMemo(() => solve(f), [f]);
  const set = (k, optional) => (v) => setF((s) => (v === undefined && !optional ? s : { ...s, [k]: v }));
  const num = (k, label, unit, o = {}) => (
    <Field label={label} unit={unit} hint={o.hint}>
      <NumField id={`cb-${k}`} value={f[k]} placeholder={o.ph} disabled={o.disabled} onCommit={set(k, o.optional)} />
    </Field>
  );
  const pick = (k, label, opts, conv) => (
    <Field label={label}>
      <select id={`cb-${k}`} className="num-input" value={f[k]} onChange={(e) => setF((s) => ({ ...s, [k]: conv ? conv(e.target.value) : e.target.value }))}>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </Field>
  );
  const mv = f.voltage_v > 2000;
  const calc = f.ampacity_method === "calculated";
  return (
    <div className="cb-grid">
      <div className="cb-form">
        <Section title="System" aside={fromSystem && <Pill tone="accent"><span className="cb-from">From System: {fromSystem}<button type="button" aria-label="Clear" onClick={clearFrom}>×</button></span></Pill>}>
          <div className="cb-fields">
            {num("voltage_v", "Voltage, line-line", "V")}
            {num("current_a", "Current per phase", "A")}
            {num("length_ft", "Length", "ft", { hint: `${fmt(f.length_ft * FT, 1)} m` })}
            {num("ambient_c", "Ambient", "°C")}
            {num("fault_ka", "Fault current", "kA rms", { optional: true, ph: "none" })}
            {num("fault_clearing_s", "Fault clearing time", "s", { optional: true, ph: "none", hint: "enables conductor withstand check" })}
            {num("x_over_r", "Fault X/R", "")}
          </div>
        </Section>
        <Section title="Conductors">
          <div className="cb-fields">
            {pick("size", "Size", SIZE_CHOICES.map((s) => [s, cond.sizeLabel(s)]))}
            {pick("material", "Material", [["Cu", "Copper"], ["Al", "Aluminium"]])}
            {pick("conductors_per_phase", "Conductors / phase", [1, 2, 3, 4, 5, 6, 8, 9, 10, 12].map((n) => [n, String(n)]), Number)}
            {pick("tiers", "Tiers", [[1, "1"], [2, "2"], [3, "3"]], Number)}
            {pick("insulation_temp_c", "Insulation rating", [[60, "60 °C"], [75, "75 °C"], [90, "90 °C"]], Number)}
            {pick("terminal_temp_c", "Termination rating", [[60, "60 °C"], [75, "75 °C"], [90, "90 °C"]], Number)}
            {num("cable_od_mm", "Cable OD", "mm", { optional: true, ph: "from construction" })}
          </div>
        </Section>
        <Section title="Insulation, shield, jacket" aside={<span className="text-faint text-[12px]">{mv || calc ? "used" : "MV / calculated only"}</span>}>
          <div className="cb-fields">
            {pick("insulation", "Insulation", [["XLPE", "XLPE"], ["EPR", "EPR"], ["PVC", "PVC"], ["XHHW", "XHHW"], ["RW90", "RW90"]])}
            {num("insulation_mm", "Insulation wall", "mm", { optional: true, ph: "typical", disabled: !(mv || calc) })}
            {num("shield_mm", "Shield thickness", "mm", { disabled: !(mv || calc) })}
            {num("jacket_mm", "Jacket thickness", "mm", { disabled: !(mv || calc) })}
            <div className="cb-wide">
              {pick("shield_bonding", "Shield bonding", [["none", "None stated"], ["single_point", "Single point"], ["both_ends", "Both ends (circulating current)"]])}
            </div>
          </div>
        </Section>
        <Section title="Ampacity">
          <div className="cb-fields">
            {pick("ampacity_method", "Method", [["auto", "Auto"], ["table", "Code table (LV)"], ["datasheet", "Datasheet rating"], ["calculated", "Calculated (IEC 60287)"]])}
            {num("cable_ampacity_a", "Datasheet rating", "A / cable", { optional: true, ph: "none", hint: "free air, 40 °C" })}
            {num("cable_ampacity_lambda1_ref", "Datasheet shield λ1", "", { optional: true, ph: "0", disabled: !f.cable_ampacity_a || f.shield_bonding !== "both_ends", hint: "shield loss factor the rating already includes (0 = single-point / cross-bonded)" })}
            {num("max_vd_pct", "Voltage drop limit", "%")}
          </div>
        </Section>
        <Section title="Enclosure" aside={
          <label className="live-toggle"><input id="cb-enclosure_on" type="checkbox" checked={f.enclosure_on} onChange={(e) => setF((s) => ({ ...s, enclosure_on: e.target.checked }))} /><span>Model enclosure</span></label>}>
          <div className="cb-fields">
            {num("enc_w", "Inside width", "mm", { optional: true, ph: "auto-fit", disabled: !f.enclosure_on })}
            {num("enc_h", "Inside height", "mm", { optional: true, ph: "auto-fit", disabled: !f.enclosure_on })}
            <label className="live-toggle cb-wide"><input id="cb-covers" type="checkbox" checked={f.covers_continuous} disabled={!f.enclosure_on} onChange={(e) => setF((s) => ({ ...s, covers_continuous: e.target.checked }))} /><span>Covers electrically continuous (solid, not ventilated)</span></label>
          </div>
        </Section>
      </div>
      <div className="cb-results">
        {error && <StateMsg kind="error" title="Cannot analyse this cable bus">{error}. Correct the input on the left; results update as you type.</StateMsg>}
        {res && <Results inp={inp} res={res} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Designer tab */
function DesignerTab({ d, setD, onPick }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);
  const run = (dd = d) => {
    setBusy(true);
    setTimeout(() => {
      try {
        const mv = dd.voltage_v > 2000;
        const req = designRequest({
          voltage_v: dd.voltage_v, current_a: dd.current_a, material: dd.material, length_m: dd.length_ft * FT,
          ambient_c: dd.ambient_c, sizes: dd.sizes, tier_options: dd.tiers, ampacity_method: dd.ampacity_method,
          insulation: dd.insulation, insulation_mm: mv || dd.ampacity_method === "calculated" ? dd.insulation_mm : null,
          shield_mm: dd.shield_mm, jacket_mm: dd.jacket_mm, fault_ka: dd.fault_ka || null, x_over_r: dd.x_over_r,
          max_loading_pct: dd.max_loading_pct, block_material: dd.block_material, top_n: 8,
        });
        setOut({ result: designOptions(req), req });
      } catch (e) { setOut({ error: e.message }); }
      setBusy(false);
    }, 30);
  };
  useEffect(() => { if (!ran.current) { ran.current = true; run(); } }, []);
  const set = (k, optional) => (v) => setD((s) => (v === undefined && !optional ? s : { ...s, [k]: v }));
  const num = (k, label, unit, o = {}) => (
    <Field label={label} unit={unit} hint={o.hint}>
      <NumField id={`cbd-${k}`} value={d[k]} placeholder={o.ph} onCommit={set(k, o.optional)} />
    </Field>
  );
  const toggle = (k, v) => setD((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));
  const r = out?.result;
  return (
    <div className="cb-grid">
      <div className="cb-form">
        <Section title="Requirement">
          <div className="cb-fields">
            {num("voltage_v", "Voltage, line-line", "V")}
            {num("current_a", "Current per phase", "A")}
            {num("length_ft", "Length", "ft")}
            {num("ambient_c", "Ambient", "°C")}
            <Field label="Material">
              <select id="cbd-material" className="num-input" value={d.material} onChange={(e) => setD((s) => ({ ...s, material: e.target.value }))}>
                <option value="Cu">Copper</option><option value="Al">Aluminium</option>
              </select>
            </Field>
            <Field label="Ampacity method">
              <select id="cbd-method" className="num-input" value={d.ampacity_method} onChange={(e) => setD((s) => ({ ...s, ampacity_method: e.target.value }))}>
                <option value="auto">Auto</option><option value="table">Code table (LV)</option><option value="calculated">Calculated (IEC 60287)</option>
              </select>
            </Field>
            {num("fault_ka", "Fault current", "kA rms", { optional: true, ph: "none" })}
            {num("x_over_r", "Fault X/R", "")}
            {num("max_loading_pct", "Max loading", "%")}
            <Field label="Block material">
              <select id="cbd-block" className="num-input" value={d.block_material} onChange={(e) => setD((s) => ({ ...s, block_material: e.target.value }))}>
                {Object.keys(BLOCK_MATERIALS).map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
          </div>
        </Section>
        <Section title="Sizes and tiers">
          <div className="label mb-1">Conductor sizes</div>
          <div className="cb-chips mb-3">
            {["250", "350", "500", "600", "750", "1000", "1250", "1500"].map((s) => (
              <button key={s} type="button" className={cx("cb-chip", d.sizes.includes(s) && "is-on")} onClick={() => toggle("sizes", s)}>{s}</button>
            ))}
          </div>
          <div className="label mb-1">Tiers</div>
          <div className="cb-chips">
            {[1, 2, 3].map((t) => <button key={t} type="button" className={cx("cb-chip", d.tiers.includes(t) && "is-on")} onClick={() => toggle("tiers", t)}>{t}</button>)}
          </div>
        </Section>
        <Section title="Cable construction" aside={<span className="text-faint text-[12px]">{d.voltage_v > 2000 ? "required above 2000 V" : "MV / calculated only"}</span>}>
          <div className="cb-fields">
            <Field label="Insulation">
              <select id="cbd-ins" className="num-input" value={d.insulation} onChange={(e) => setD((s) => ({ ...s, insulation: e.target.value }))}>
                {["XLPE", "EPR", "PVC", "XHHW"].map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            {num("insulation_mm", "Insulation wall", "mm")}
            {num("shield_mm", "Shield", "mm")}
            {num("jacket_mm", "Jacket", "mm")}
          </div>
        </Section>
        <Btn kind="primary" onClick={() => run()} disabled={busy || !d.sizes.length || !d.tiers.length}>{busy ? "Running…" : "Run designer"}</Btn>
      </div>
      <div className="cb-results">
        {out?.error && <StateMsg kind="error" title="Cannot design">{out.error}</StateMsg>}
        {(!out || busy) && <StateMsg kind="loading" title="Running the designer">Enumerating layouts and analysing each one.</StateMsg>}
        {r && (
          <>
            <Section title="Ranked options" aside={<span className="text-faint text-[12px]">{r.considered} layouts analysed · {r.options.filter((o) => o.passed).length} pass</span>}>
              {r.options.length === 0 && <StateMsg title="No layout fits the enclosure catalogue">Try more tiers or larger sizes, then run the designer again.</StateMsg>}
              <div className="table-wrap">
                <table className="grid-table">
                  <thead><tr><th>#</th><th>Option</th><th className="r">Loading</th><th className="r">Vdrop</th><th className="r">Loss</th><th className="r">Cu / phase</th>{out.req.fault_ka ? <th className="r">Block stress</th> : null}<th>Result</th><th /></tr></thead>
                  <tbody>
                    {r.options.map((o) => (
                      <tr key={o.rank} className="cb-opt-row" onClick={() => onPick(o, out.req)} title={o.failed_checks.join("; ") || "Open in Check"}>
                        <td>{o.rank}</td>
                        <td className="cb-wrap">{designOptionLabel(o)}<div className="cb-note">pattern {o.pattern} · OD {o.cable_od_mm} mm · {o.tags.map((t) => <Pill key={t} tone="accent">{t}</Pill>)}</div></td>
                        <td className="r">{fmt(o.max_loading_pct, 1)} %</td>
                        <td className="r">{fmt(o.vd_pct, 2)} %</td>
                        <td className="r">{fmt(o.loss_kw, 2)} kW</td>
                        <td className="r">{fmt(o.copper_mm2_per_phase, 0)} mm²</td>
                        {out.req.fault_ka ? <td className="r">{o.block_stress_mpa === null ? "—" : `${fmt(o.block_stress_mpa, 1)} / ${fmt(o.block_allowable_mpa, 1)} MPa`}</td> : null}
                        <td><Pill tone={o.passed ? "ok" : "crit"}>{o.passed ? "Pass" : "Fail"}</Pill></td>
                        <td><span className="cb-pick">Open in Check</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section title="Notes"><ul className="cb-notes">{r.notes.map((t, k) => <li key={k}>{t}</li>)}</ul></Section>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ workspace */
function sizeKey(s) { try { return cond.normalizeSize(String(s)); } catch { return null; } }

export function CableBusWorkspace({ goTo }) {
  const [tab, setTab] = useState("check");
  const [f, setF] = useState(EXAMPLE);
  const [d, setD] = useState(DESIGN_EXAMPLE);
  const [fromSystem, setFromSystem] = useState(null);
  const [link, setLink] = useState(null);            // System cable bus run this design is for
  const hostRef = useRef(null);

  useEffect(() => bus.on("cablebus:open", ({ connector, current_a, kv }) => {
    const c = connector || {};
    setF((s) => {
      const n = { ...s };
      const k = sizeKey(c.size);
      if (k) n.size = k;
      if (c.material) n.material = c.material;
      if (c.sets) { n.conductors_per_phase = c.sets; n.tiers = c.sets <= 3 ? 1 : c.sets % 2 === 0 ? 2 : c.sets % 3 === 0 ? 3 : 1; }
      if (c.length_ft) n.length_ft = c.length_ft;
      if (c.insulation_c && [60, 75, 90].includes(c.insulation_c)) { n.insulation_temp_c = c.insulation_c; n.terminal_temp_c = c.insulation_c; }
      // LV: terminal rating per NEC 110.14(C) (marking, else 60/75 °C default), as the System design check uses
      if (c.kind === "cablebus" && c.size && kv && kv <= 2) n.terminal_temp_c = connectorTerminalC(c)[0];
      if (current_a) n.current_a = Math.round(current_a);
      if (kv) n.voltage_v = Math.round(kv * 1000);
      n.enc_w = undefined; n.enc_h = undefined; n.enclosure_on = true;
      n.ampacity_method = "auto"; n.cable_ampacity_a = undefined;
      if (n.voltage_v <= 2000) { n.shield_bonding = "none"; n.fault_ka = undefined; }
      return n;
    });
    setFromSystem(c.id || "connector");
    if (c.id) setLink({ kind: "con", id: c.id });
    setTab("check");
  }), []);

  const pick = (o, req) => {
    const ci = o.case_inputs;
    setF((s) => ({
      ...s, voltage_v: req.voltage_v, current_a: req.current_a, material: req.material, size: o.size,
      conductors_per_phase: o.per_phase, tiers: o.tiers, enclosure_on: true, enc_w: o.inside_w_mm, enc_h: o.inside_h_mm,
      cable_od_mm: Math.round(ci.cable_od_mm * 100) / 100, insulation: req.insulation, insulation_mm: req.insulation_mm ?? s.insulation_mm,
      shield_mm: req.shield_mm, jacket_mm: req.jacket_mm, shield_bonding: ci.shield_bonding, ampacity_method: req.ampacity_method,
      length_ft: req.length_m / FT, ambient_c: req.ambient_c, fault_ka: req.fault_ka ?? undefined, x_over_r: req.x_over_r,
    }));
    setFromSystem(null);
    setTab("check");
  };

  const { res, error: solveError } = useMemo(() => (tab === "check" ? solve(f) : {}), [f, tab]);
  const push = useMemo(() => (res ? { design: cableBusDesign(res) } : { error: tab === "check" ? solveError : "Open a design on the Check tab to apply it" }), [res, solveError, tab]);
  return (
    <div className="ws" ref={hostRef}>
      <style>{CSS}</style>
      <WsHeader title="Cable bus" context={tab === "check" ? "Analyse a given design" : "Enumerate and rank options"}
        status={<>
          {tab === "check" && res && <Pill tone={res.passed ? "ok" : "crit"}>{res.passed ? "All checks pass" : `${res.checks.filter((c) => !c.passed).length} check(s) fail`}</Pill>}
          {tab === "check" && solveError && <Pill tone="crit">Input error</Pill>}
        </>}
        actions={<>
          <PushToSystem module="cablebus" design={push.design || null} designError={push.error} link={link} setLink={setLink} goTo={goTo} />
          {tab === "check" && res && <ReportButton filename="cable-bus-calc" getReport={() => cableBusReport(f, hostRef.current)} />}
          {tab === "check" && <Btn onClick={() => { setF(EXAMPLE); setFromSystem(null); }} title="Restore the 15 kV 2000 A example">Reset to example</Btn>}
        </>}>
        <div className="seg" role="tablist" aria-label="Mode">
          <Btn active={tab === "check"} onClick={() => setTab("check")}>Check</Btn>
          <Btn active={tab === "designer"} onClick={() => setTab("designer")}>Designer</Btn>
        </div>
      </WsHeader>
      <div className="main">
        {tab === "check"
          ? <CheckTab f={f} setF={setF} fromSystem={fromSystem} clearFrom={() => setFromSystem(null)} />
          : <DesignerTab d={d} setD={setD} onPick={pick} />}
      </div>
    </div>
  );
}
