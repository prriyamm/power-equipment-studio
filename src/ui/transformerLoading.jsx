// Transformer loading over the daily profile (IEEE C57.91 Clause 7 model): System workspace, Schedules & studies view.
// Thermal inputs come from the unit's test report; nothing transformer-specific is defaulted (see engine/data/c57_91_thermal.json).
const { useState, useMemo, useEffect, useRef } = React;
import { Btn, Pill, Section, Field, NumField, fmt, cx, StateMsg, KpiStrip, ChecksTable } from "./common.jsx";
import { Chart, Line, Area, RefLine, useChart } from "./charts/index.js";
import { useQuality } from "./quality.js";
import { svgToString } from "./reportButton.jsx";
import { profileStudy, PROFILES } from "../engine/loadprofile.js";
import {
  transformerLoadingStudy, loadableTransformers, exponentsFor, coolingModeOf, agingFactor,
  COOLING_MODES, PARAM_KEYS, PARAM_INFO, THERMAL_DATA,
} from "../engine/transformerLoading.js";

const CSS = `
.tl-row { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; margin-bottom:12px; }
.tl-row .field { min-width:130px; flex: 0 1 160px; }
.tl-params { display:grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap:10px 12px; margin-bottom:10px; }
.tl-sub { font-size:12px; color: var(--muted); font-weight:600; margin: 4px 0 8px; }
.tl-play { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin: 10px 0 6px; }
.tl-play input[type=range] { flex: 1 1 220px; min-width: 160px; accent-color: var(--accent); }
.tl-clock { font-family: var(--font-data); font-variant-numeric: tabular-nums; font-size: 13px; min-width: 52px; }
.tl-read { display:grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap:6px 14px; font-size:12px; margin: 6px 0 12px;
  padding: 8px 12px; border:1px solid var(--line); border-radius: var(--r-lg, 8px); background: var(--bg); }
.tl-read span { color: var(--faint); display:block; font-size:11px; }
.tl-read b { font-family: var(--font-data); font-variant-numeric: tabular-nums; font-weight:600; color: var(--fg); }
.tl-note { color: var(--faint); font-size:12px; line-height:1.5; margin-top:8px; }
.tl-chart { background: var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; min-width:0; }
.tl-cursor line { stroke: var(--fg); stroke-width: 1.2; opacity: .55; }
.tl-cursor circle { stroke: var(--bg); stroke-width: 1.5; }
.tl-details summary { cursor:pointer; color: var(--muted); font-size:12.5px; margin: 10px 0 6px; }
`;

const hhmm = (min) => { const m = Math.round(min); return `${String(Math.floor(m / 60) % 25).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const COLORS = { load: "var(--accent)", amb: "var(--info)", to: "var(--high)", hs: "var(--crit)" };

/* Last successful result, read by the System calc package (systemReport in system.jsx). */
let lastForReport = null;
export function transformerLoadingReport() {
  const s = lastForReport;
  if (!s || !s.res?.ok) return null;
  const r = s.res, el = s.host?.querySelector?.("[data-report-fig] svg");
  return {
    results: [
      { label: `${r.id} peak hot spot (C57.91)`, value: r.peak_theta_h, unit: "°C" },
      { label: `${r.id} equivalent aging F_EQA (24 h)`, value: r.feqa, unit: "x" },
      { label: `${r.id} loss of life (24 h)`, value: r.lol_pct, unit: "%" },
    ],
    checks: r.checks.map((c) => ({ name: c.name, value: c.value, limit: c.limit, unit: c.unit, pass: c.passed, clause: `${c.clause} [${c.status}]` })),
    tables: [
      { title: `${r.id} thermal inputs (IEEE C57.91 Clause 7)`, columns: ["Input", "Value", "Source"],
        rows: [["Profile", s.profileLabel, "Load-profile study (hourly load flow)"], ["Cooling mode", s.cooling, "User / System cooling field"],
          ["Ambient", s.ambientText, "User input"],
          ...PARAM_KEYS.map((k) => [PARAM_INFO[k].label + (PARAM_INFO[k].unit ? ` (${PARAM_INFO[k].unit})` : ""), r.params[k], s.sources[k] || "User input (test report)"]),
          ["Normal insulation life (h)", r.normal_life_h, `${THERMAL_DATA.normal_life_h.source} [${THERMAL_DATA.normal_life_h.status}]`],
          ["Time step (min)", r.dt_min, `exact exponential update; periodic steady state after ${r.cycles} warm-up day(s)`]] },
      { title: `${r.id} hourly loading, top-oil and hot-spot temperature, aging (IEEE C57.91)`,
        columns: ["Hour", "Load (pu)", "Ambient (°C)", "Top oil end (°C)", "Hot spot max (°C)", "Hot spot end (°C)", "F_AA mean"],
        rows: r.hourly.map((h) => [String(h.hour).padStart(2, "0") + ":00", h.K.toFixed(3), fmt(h.amb, 1), fmt(h.theta_to_end, 1), fmt(h.theta_h_max, 1), fmt(h.theta_h_end, 1), h.faa_mean < 0.001 ? h.faa_mean.toExponential(2) : h.faa_mean.toFixed(4)]) },
    ],
    figures: el ? [{ title: `${r.id} 24 h loading: load, ambient, top oil and hot spot`, svg: svgToString(el), dark: true }] : [],
    notes: [
      `${r.id} thermal study: IEEE C57.91 Clause 7 exponential model (equations from a secondary transcription, arXiv:1703.01397). Load held per hour from the load-profile study; exact exponential update every ${r.dt_min} min; periodic steady state. F_AA = exp(15000/383 - 15000/(theta_H + 273)); F_EQA is its time average; loss of life % = F_EQA x 24 h x 100 / ${r.normal_life_h} h.`,
      "Not modelled: top-oil time-constant correction at non-rated load, loss and viscosity change with temperature, duct-oil (Annex G) model, revised C57.91-2025 model, harmonics, cooling-stage switching.",
      ...(s.illustrative ? ["Thermal inputs are the ILLUSTRATIVE published values of a 25 MVA ONAF unit (Gouda et al. 2012), not this transformer's test report. Replace before relying on the result."] : []),
    ],
    dataStatus: [
      { table: "IEEE C57.91 aging constants (B = 15000, 110 °C reference)", status: THERMAL_DATA.aging.status, source: THERMAL_DATA.aging.source },
      { table: "IEEE C57.91 normal insulation life 180 000 h", status: THERMAL_DATA.normal_life_h.status, source: THERMAL_DATA.normal_life_h.source },
      { table: `IEEE C57.91 exponents n, m (${s.cooling})`, status: s.expEdited ? "USER" : exponentsFor(s.cooling).status, source: s.expEdited ? "User input" : exponentsFor(s.cooling).source },
      ...(s.illustrative ? [{ table: "Illustrative thermal parameters (Gouda et al. 2012, Table 2)", status: "UNVERIFIED", source: THERMAL_DATA.presets.gouda_2012_onaf_25mva.source }] : []),
    ],
  };
}

/* Append the transformer loading study (if one has run in this session) to a calc-package object. */
export function withTransformerLoading(base) {
  const x = transformerLoadingReport();
  if (!x) return base;
  return { ...base, results: [...(base.results || []), ...x.results], checks: [...(base.checks || []), ...x.checks],
    tables: [...(base.tables || []), ...x.tables], figures: [...(base.figures || []), ...x.figures],
    notes: [...(base.notes || []), ...x.notes], dataStatus: [...(base.dataStatus || []), ...x.dataStatus] };
}

/* Playback cursor drawn inside the chart (left out of the calc package). */
function Cursor({ t, pts }) {
  const { X, Y, m, ih } = useChart();
  const px = X(t);
  if (!Number.isFinite(px)) return null;
  return (
    <g className="tl-cursor" data-noexport="1" pointerEvents="none">
      <line x1={px} x2={px} y1={m.t} y2={m.t + ih} />
      {pts.map((p, k) => Number.isFinite(p.y) && <circle key={k} cx={px} cy={Y(p.y)} r="4.5" style={{ fill: p.color }} />)}
    </g>
  );
}

const ILL = THERMAL_DATA.presets.gouda_2012_onaf_25mva;

export function TransformerLoadingSection({ sys }) {
  const [profileName, setProfileName] = useState("industrial_two_shift");
  const prof = useMemo(() => profileStudy(sys, profileName), [sys, profileName]);
  const xfmrs = useMemo(() => loadableTransformers(sys, prof), [sys, prof]);
  const [sel, setSel] = useState(null);
  const cur = xfmrs.find((e) => e.id === sel) || xfmrs[0];
  // per-transformer inputs: { cooling, params: {...}, illustrative, expEdited }
  const [byId, setById] = useState({});
  const [ambMode, setAmbMode] = useState("const");
  const [amb, setAmb] = useState(30);
  const [ambText, setAmbText] = useState("");
  const [limHs, setLimHs] = useState(null);
  const [limTo, setLimTo] = useState(null);
  const q = useQuality();

  const cfg = cur ? byId[cur.id] || {} : {};
  const cooling = cfg.cooling || coolingModeOf(cur?.cooling);
  const exps = exponentsFor(cooling);
  const params = { n: exps.n, m: exps.m, ...(cfg.params || {}) };
  const setCfg = (patch) => cur && setById((b) => ({ ...b, [cur.id]: { ...(b[cur.id] || {}), ...patch } }));
  const setParam = (k, v) => setCfg({ params: { ...(cfg.params || {}), [k]: v }, illustrative: false, ...(k === "n" || k === "m" ? { expEdited: true } : {}) });

  const ambient = useMemo(() => {
    if (ambMode === "const") return Number.isFinite(amb) ? amb : null;
    const a = ambText.split(/[\s,;]+/).filter(Boolean).map(Number);
    return a.length === 24 && a.every(Number.isFinite) ? a : null;
  }, [ambMode, amb, ambText]);

  const res = useMemo(() => (cur && ambient != null
    ? transformerLoadingStudy(sys, cur.id, prof, { params, ambient, limits: { hot_spot_c: limHs ?? NaN, top_oil_c: limTo ?? NaN } })
    : null), [sys, cur?.id, prof, JSON.stringify(params), JSON.stringify(ambient), limHs, limTo]);

  // playback
  const [t, setT] = useState(24 * 60);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2); // hours of model time per second
  const raf = useRef(0), last = useRef(0);
  useEffect(() => {
    if (!playing || !q.animations) return;
    const tick = (now) => {
      const dtS = last.current ? Math.min(0.1, (now - last.current) / 1000) : 0;
      last.current = now;
      setT((v) => { const nv = v + dtS * speed * 60; if (nv >= 24 * 60) { setPlaying(false); return 24 * 60; } return nv; });
      raf.current = requestAnimationFrame(tick);
    };
    last.current = 0;
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, q.animations]);
  useEffect(() => { if (!q.animations) setPlaying(false); }, [q.animations]);

  const host = useRef(null);
  useEffect(() => {
    lastForReport = res?.ok ? {
      res, host: host.current, cooling, illustrative: !!cfg.illustrative, expEdited: !!cfg.expEdited,
      profileLabel: PROFILES[profileName]?.label || profileName,
      ambientText: ambMode === "const" ? `${amb} °C constant` : `24 hourly values: ${ambient?.join(", ")} °C`,
      sources: cfg.illustrative ? Object.fromEntries(PARAM_KEYS.map((k) => [k, "Illustrative: Gouda et al. 2012 Table 2 (UNVERIFIED)"])) :
        { n: cfg.expEdited ? "User input" : `C57.91 Table 4 as cited (${exps.status}, ${exps.confidence})`, m: cfg.expEdited ? "User input" : `C57.91 Table 4 as cited (${exps.status}, ${exps.confidence})` },
    } : null;
  });
  useEffect(() => () => { lastForReport = null; }, []);

  const missing = PARAM_KEYS.filter((k) => !Number.isFinite(params[k]));

  // chart data (5-minute decimation of the 1-minute trace)
  const chart = useMemo(() => {
    if (!res?.ok) return null;
    const st = res.steps.filter((s, i) => i % 5 === 0 || i === res.steps.length - 1);
    const ser = (f) => st.map((s) => ({ x: s.t_min / 60, y: f(s) }));
    const ymax = Math.max(res.peak_theta_h, limHs ?? 0, limTo ?? 0, 110, res.peak_k * 100) * 1.08;
    const hoverIdx = res.steps.filter((s, i) => i % 15 === 0);
    return { load: ser((s) => s.K * 100), amb: ser((s) => s.amb), to: ser((s) => s.theta_to), hs: ser((s) => s.theta_h), ymax, hoverIdx };
  }, [res, limHs, limTo]);

  // readout at cursor
  const at = res?.ok ? res.steps[Math.max(0, Math.min(res.steps.length - 1, Math.round(t / res.dt_min)))] : null;
  const agedH = useMemo(() => {
    if (!res?.ok) return 0;
    const n = Math.round(t / res.dt_min);
    let s = 0;
    for (let i = 1; i <= n && i < res.steps.length; i++) s += 0.5 * (agingFactor(res.steps[i - 1].theta_h) + agingFactor(res.steps[i].theta_h)) * res.dt_min;
    return s / 60;
  }, [res, Math.round(t)]);

  const lolCheck = res?.ok ? res.checks[1] : null;
  if (!xfmrs.length) return null;
  return (
    <Section title="Transformer loading · IEEE C57.91 hot spot and aging" aside={<Pill tone="warn" title="Equations and constants from public secondary sources; not checked against the licensed IEEE C57.91 text.">UNVERIFIED data</Pill>}>
      <style>{CSS}</style>
      <div ref={host}>
        <div className="tl-row">
          <Field label="Transformer"><select className="num-input" value={cur.id} onChange={(e) => setSel(e.target.value)}>
            {xfmrs.map((e) => <option key={e.id} value={e.id}>{e.id} · {e.kva} kVA</option>)}</select></Field>
          <Field label="Load profile"><select className="num-input" value={profileName} onChange={(e) => setProfileName(e.target.value)}>
            {Object.entries(PROFILES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          <Field label="Cooling mode"><select className="num-input" value={cooling} onChange={(e) => setCfg({ cooling: e.target.value, params: Object.fromEntries(Object.entries(cfg.params || {}).filter(([k]) => k !== "n" && k !== "m")), expEdited: false, illustrative: false })}>
            {COOLING_MODES.map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
          <Field label="Ambient input"><select className="num-input" value={ambMode} onChange={(e) => setAmbMode(e.target.value)}>
            <option value="const">Constant</option><option value="hourly">24 hourly values</option></select></Field>
          {ambMode === "const"
            ? <Field label="Ambient" unit="°C" hint="site value; 30 °C is only a starting point"><NumField value={amb} onCommit={(v) => Number.isFinite(v) && v > -50 && v < 60 && setAmb(v)} /></Field>
            : <Field label="Hourly ambient" unit="°C" hint={ambient ? "24 values read" : "enter 24 numbers, comma separated"}>
                <input className={cx("num-input", !ambient && "is-bad")} value={ambText} placeholder="25, 24, 24, …" onChange={(e) => setAmbText(e.target.value)} /></Field>}
          <Field label="Hot-spot limit" unit="°C" hint="optional, project / loading category"><NumField value={limHs ?? ""} placeholder="none" onCommit={(v) => setLimHs(Number.isFinite(v) && v > 0 ? v : null)} /></Field>
          <Field label="Top-oil limit" unit="°C" hint="optional"><NumField value={limTo ?? ""} placeholder="none" onCommit={(v) => setLimTo(Number.isFinite(v) && v > 0 ? v : null)} /></Field>
        </div>

        <div className="tl-sub">{cur.id} thermal data · from the unit's test report</div>
        <div className="tl-params">
          {PARAM_KEYS.map((k) => (
            <Field key={k} label={PARAM_INFO[k].label} unit={PARAM_INFO[k].unit || undefined}
              hint={(k === "n" || k === "m") && !cfg.expEdited && !cfg.illustrative ? `${cooling} table value (${exps.confidence}, UNVERIFIED)` : undefined}>
              <NumField value={params[k] ?? ""} placeholder="required" invalid={Number.isFinite(params[k]) ? undefined : "Required: from the test report"} onCommit={(v) => setParam(k, Number.isFinite(v) ? v : undefined)} />
            </Field>))}
        </div>
        <div className="tl-row">
          <Btn onClick={() => setCfg({ cooling: ILL.cooling, params: Object.fromEntries(PARAM_KEYS.map((k) => [k, ILL[k]])), illustrative: true, expEdited: false })}
            title={ILL.source}>Load illustrative values (published 25 MVA ONAF unit)</Btn>
          {cfg.illustrative && <Pill tone="warn" title={ILL.source}>illustrative inputs, not {cur.id}'s test report</Pill>}
        </div>

        {missing.length > 0 && (
          <StateMsg kind="empty" title="Enter the thermal data to run the 24 h simulation">
            Needed: {missing.map((k) => PARAM_INFO[k].label).join(", ")}. These come from the transformer's heat-run test report (rated rises, losses) or the manufacturer (time constants).
            No typical defaults are given because none were found in a public, citable source; the illustrative button loads the published values of one 25 MVA ONAF unit for a look at the method.
          </StateMsg>)}
        {missing.length === 0 && ambient == null && <StateMsg kind="empty" title="Enter the ambient temperature">One value, or 24 hourly values separated by commas.</StateMsg>}
        {res && !res.ok && missing.length === 0 && <StateMsg kind="error" title="Thermal study did not run">{res.message}</StateMsg>}

        {res?.ok && chart && (<>
          <KpiStrip items={[
            { label: "Peak hot spot", value: fmt(res.peak_theta_h, 1), unit: "°C", sub: `at ${hhmm(res.peak_t_min)} · 110 °C aging reference`, status: res.checks.find((c) => /hot spot/.test(c.name)) ? (res.checks.find((c) => /hot spot/.test(c.name)).passed ? "pass" : "fail") : undefined },
            { label: "Peak top oil", value: fmt(res.peak_theta_to, 1), unit: "°C", sub: `peak load ${fmt(res.peak_k, 2)} pu`, status: res.checks.find((c) => /top oil/.test(c.name)) ? (res.checks.find((c) => /top oil/.test(c.name)).passed ? "pass" : "fail") : undefined },
            { label: "Equivalent aging", value: res.feqa < 0.01 ? res.feqa.toExponential(2) : fmt(res.feqa, 3), unit: "x", sub: `${fmt(res.eq_aging_h, 3)} h of normal life per day`, status: res.feqa <= 1 ? "pass" : "fail" },
            { label: "Loss of life, 24 h", value: res.lol_pct < 0.001 ? res.lol_pct.toExponential(2) : fmt(res.lol_pct, 4), unit: "%", sub: `normal day ${fmt(res.normal_lol_pct, 4)} % (${res.normal_life_h.toLocaleString("en-US")} h life)`, status: lolCheck.passed ? "pass" : "fail" },
          ]} />

          <div className="tl-play">
            <Btn kind="primary" disabled={!q.animations} onClick={() => { if (!playing && t >= 24 * 60 - 0.5) setT(0); setPlaying(!playing); }}
              title={q.animations ? undefined : "Animations are off in the graphics menu; use the timeline slider"}>{playing ? "Pause" : "Play 24 h"}</Btn>
            <span className="tl-clock">{hhmm(t)}</span>
            <input type="range" min="0" max={24 * 60} step="1" value={Math.round(t)} aria-label="Time of day"
              onChange={(e) => { setPlaying(false); setT(+e.target.value); }} />
            <select className="num-input" value={speed} onChange={(e) => setSpeed(+e.target.value)} aria-label="Playback speed" style={{ width: "auto" }}>
              <option value={1}>1 h/s</option><option value={2}>2 h/s</option><option value={4}>4 h/s</option></select>
          </div>
          {at && (
            <div className="tl-read" aria-live="off">
              <div><span>Load</span><b>{fmt(at.K, 2)} pu</b></div>
              <div><span>Ambient</span><b>{fmt(at.amb, 1)} °C</b></div>
              <div><span>Top oil</span><b style={{ color: COLORS.to }}>{fmt(at.theta_to, 1)} °C</b></div>
              <div><span>Hot spot</span><b style={{ color: COLORS.hs }}>{fmt(at.theta_h, 1)} °C</b></div>
              <div><span>Aging factor F_AA</span><b>{at.faa < 0.01 ? at.faa.toExponential(2) : fmt(at.faa, 3)}</b></div>
              <div><span>Aged so far</span><b>{fmt(agedH, 3)} h</b></div>
              <div><span>Loss of life so far</span><b>{(agedH * 100 / res.normal_life_h).toExponential(2)} %</b></div>
            </div>)}
          <div className="tl-chart">
            <Chart x={{ domain: [0, 24], label: "Hour of day", unit: "h", ticks: [0, 3, 6, 9, 12, 15, 18, 21, 24], nice: false }}
              y={{ domain: [0, chart.ymax], label: "Temperature °C · load %" }} height={260}
              ariaLabel={`${cur.id} 24 hour load, ambient, top-oil and hot-spot temperature`} reportTitle={`${cur.id} 24 h thermal playback`}
              legend={[{ name: "load", color: COLORS.load, kind: "area" }, { name: "ambient", color: COLORS.amb }, { name: "top oil", color: COLORS.to }, { name: "hot spot", color: COLORS.hs }]}
              hover={{ xs: chart.hoverIdx.map((s) => s.t_min / 60), render: (i) => { const s = chart.hoverIdx[i]; return { title: hhmm(s.t_min), rows: [
                { label: "load", value: `${fmt(s.K * 100, 0)} %`, color: COLORS.load }, { label: "ambient", value: `${fmt(s.amb, 1)} °C`, color: COLORS.amb },
                { label: "top oil", value: `${fmt(s.theta_to, 1)} °C`, color: COLORS.to }, { label: "hot spot", value: `${fmt(s.theta_h, 1)} °C`, color: COLORS.hs }] }; },
                points: (i) => { const s = chart.hoverIdx[i]; return [{ y: s.theta_to, color: COLORS.to }, { y: s.theta_h, color: COLORS.hs }]; } }}>
              <Area data={chart.load} color={COLORS.load} opacity={0.1} />
              <RefLine y={110} label="110 °C aging reference" tone="high" />
              {limHs != null && <RefLine y={limHs} label={`hot-spot limit ${limHs} °C`} tone="crit" align="start" />}
              {limTo != null && <RefLine y={limTo} label={`top-oil limit ${limTo} °C`} tone="high" align="start" dash="2 3" />}
              <Line data={chart.amb} color={COLORS.amb} width={1.5} />
              <Line data={chart.to} color={COLORS.to} />
              <Line data={chart.hs} color={COLORS.hs} />
              {at && <Cursor t={t / 60} pts={[{ y: at.theta_to, color: COLORS.to }, { y: at.theta_h, color: COLORS.hs }]} />}
            </Chart>
          </div>
          {!q.animations && <p className="tl-note">Animations are off (graphics menu or reduced-motion setting): drag the timeline to move the cursor.</p>}

          <div style={{ marginTop: 12 }}><ChecksTable checks={res.checks} format={(v) => (Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(2) : fmt(v, 3))} /></div>
          <details className="tl-details">
            <summary>Hourly table · load, top oil, hot spot, aging factor</summary>
            <div className="table-wrap"><table className="grid-table">
              <thead><tr><th>Hour</th><th className="r">Load<em>pu</em></th><th className="r">Ambient<em>°C</em></th><th className="r">Top oil end<em>°C</em></th><th className="r">Hot spot max<em>°C</em></th><th className="r">F_AA mean</th></tr></thead>
              <tbody>{res.hourly.map((h) => (
                <tr key={h.hour}><td className="font-mono">{String(h.hour).padStart(2, "0")}:00</td><td className="r">{h.K.toFixed(3)}</td><td className="r">{fmt(h.amb, 1)}</td>
                  <td className="r">{fmt(h.theta_to_end, 1)}</td><td className={cx("r", limHs != null && h.theta_h_max > limHs && "text-crit")}>{fmt(h.theta_h_max, 1)}</td>
                  <td className="r">{h.faa_mean < 0.001 ? h.faa_mean.toExponential(2) : h.faa_mean.toFixed(4)}</td></tr>))}</tbody>
            </table></div>
          </details>
        </>)}
        <p className="tl-note">
          Method: IEEE C57.91 Clause 7 exponential model. Top-oil rise moves toward rated rise × [(K²R+1)/(R+1)]^n with the oil time constant; hot-spot gradient toward rated gradient × K^2m with the winding time constant;
          hot spot = ambient + top-oil rise + gradient. Load K is {cur.id}'s hourly kVA loading from the profile load flow, held per hour; exact exponential update every minute; periodic steady state (the day repeats).
          Aging F_AA = exp(15000/383 − 15000/(θH+273)) for 65 °C-rise insulation (1.0 at 110 °C); loss of life % = F_EQA × 24 h × 100 / {THERMAL_DATA.normal_life_h.value.toLocaleString("en-US")} h.
          Equations, aging constants, normal life and exponents are from public secondary sources citing C57.91 (status UNVERIFIED; see the calc package data-status table). Not modelled: top-oil time-constant correction at non-rated load, loss and viscosity change with temperature, the duct-oil and C57.91-2025 models, harmonics and cooling-stage switching.
        </p>
      </div>
    </Section>
  );
}
