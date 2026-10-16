/* Cable bus Simulate tab: short-circuit (time-domain currents, force, block load, conductor temperature) and
   temperature-rise (steady state per cable, enclosure estimate, warm-up) simulation, framed by IEEE C37.23 and
   CSA C22.2 No. 273. Ratings and limits are user inputs from the product's test report (no defaults).
   Engine: src/engine/pecalc/cablebusSim.js (port of pecalc/cablebus_sim.py). */
const { useState, useMemo, useEffect, useRef } = React;
import { Btn, Field, NumField, Pill, Section, cx, fmt, KpiStrip, ChecksTable, StateMsg, StatusBadge } from "./common.jsx";
import { Chart, Line, RefLine, Dot, PHASE_VAR, TEMP_STOPS, rampAt, rgbCss, rgbToHex, normalize, rampCss } from "./charts/index.js";
import { useQuality } from "./quality.js";
import { BLOCK_MATERIALS } from "../engine/pecalc/cablebus_design.js";
import { simInput, buildContext, simulateShortCircuit, simulateTemperatureRise, SIM_DATA } from "../engine/pecalc/cablebusSim.js";
import { checkRows } from "../engine/report.js";
import { reportFigures } from "./reportButton.jsx";

const FT = 0.3048;
const TEMP_HEX = TEMP_STOPS.map(([t, c]) => [t, rgbToHex(c)]);
export const SIM_STATE = {
  sub: "sc", angle: undefined, load_pct: 100, emis: undefined, block_material: "GPO-3",
  pk: undefined, st_ka: undefined, st_s: undefined, blk: undefined, frc: undefined,
  rise_c: undefined, rise_e: undefined, rise_t: undefined, term: undefined,
};

const CSS = `
.sim-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; padding: 12px 16px; align-items: start; }
.sim-form, .sim-results { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sim-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.sim-fields .sim-wide { grid-column: 1 / -1; }
.sim-cursor { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 8px 0 2px; }
.sim-cursor input[type=range] { flex: 1 1 220px; min-width: 160px; accent-color: var(--accent); }
.sim-read { font-family: var(--font-data); font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 2px 16px; }
.sim-read b { color: var(--fg); font-weight: 500; }
.sim-note { font-size: 12px; color: var(--faint); margin-top: 4px; }
.sim-kv { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; font-size: 13px; }
.sim-kv span:nth-child(odd) { color: var(--muted); }
.sim-kv span:nth-child(even) { font-family: var(--font-data); text-align: right; }
.sim-two { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 12px; }
.sim-ds td, .sim-ds th { font-size: 12.5px; vertical-align: top; }
.sim-st-USER, .sim-st-NOTSET { color: var(--muted); }
.sim-st-UNVERIFIED, .sim-st-FLAGGEDDEFAULT { color: var(--st-warn); }
@media (max-width: 1100px) { .sim-two { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 899px) { .sim-grid { grid-template-columns: minmax(0, 1fr); } }
`;

const stat = (c) => (!c || c.passed === null ? undefined : c.passed ? "pass" : "fail");
const meter = (c, label) => (c && c.passed !== null && c.limit ? { u: c.value / c.limit, label } : undefined);
const num = (v, d = 1) => (v === null || v === undefined ? "—" : fmt(v, d));
const std = (v) => (Number.isFinite(v) ? fmt(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) < 10 ? 2 : 1) : "∞");

function mkSim(inp, ss) {
  return simInput({
    bus: inp, closing_angle_deg: ss.angle ?? null,
    tested_momentary_peak_ka: ss.pk ?? null, tested_short_time_ka: ss.st_ka ?? null, tested_short_time_s: ss.st_s ?? null,
    tested_block_load_n: ss.blk ?? null, tested_force_n_per_m: ss.frc ?? null, block_material: ss.block_material || null,
    load_scale: (ss.load_pct ?? 100) / 100, enclosure_emissivity: ss.emis ?? null,
    rise_limit_conductor_k: ss.rise_c ?? null, rise_limit_enclosure_k: ss.rise_e ?? null,
    rise_limit_termination_k: ss.rise_t ?? null, termination_rise_k: ss.term ?? null,
  });
}

/* ------------------------------------------------------------ data status table */
function DataStatus({ rows }) {
  const flagged = rows.filter((r) => r.status !== "USER (test report)" && r.status !== "USER" && r.status !== "VERIFIED").length;
  return (
    <Section title="Data status" aside={flagged ? <Pill tone="warn">{flagged} item(s) not VERIFIED or not set</Pill> : <Pill tone="ok">all verified</Pill>}>
      <div className="table-wrap">
        <table className="grid-table sim-ds">
          <thead><tr><th>Value</th><th>Used</th><th>Status</th><th>Source / action</th></tr></thead>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k}>
                <td className="cb-wrap">{r.name}</td><td className="cb-wrap">{r.value}</td>
                <td className={`sim-st-${String(r.status).split(" ")[0].replace(/[^A-Z]/g, "")}`}><b>{r.status}</b></td>
                <td className="cb-wrap">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sim-note">VERIFIED is reserved for primary text that was read. IEEE C37.23 and CSA C22.2 No. 273 are licensed and were not read: their test durations, rise limits and pass criteria are not in this tool, so every rating and limit is an input from the product&apos;s test report and shows NOT SET until entered.</p>
    </Section>
  );
}

/* ------------------------------------------------------------ short circuit */
function ScInputs({ f, setF, ss, setSs, sc }) {
  const setFo = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const setS = (k) => (v) => setSs((s) => ({ ...s, [k]: v }));
  const fld = (label, unit, k, ph, o = {}) => (
    <Field label={label} unit={unit} hint={o.hint}><NumField id={`sim-${k}`} value={ss[k]} placeholder={ph || ENTER} onCommit={setS(k)} /></Field>
  );
  const auto = ss.angle === undefined;
  const worst = sc?.worst_angle_deg ?? 0;
  const ang = auto ? worst : ss.angle;
  return (
    <>
      <Section title="Fault" aside={<span className="text-faint text-[12px]">shared with Check</span>}>
        <div className="sim-fields">
          <Field label="Fault current" unit="kA rms"><NumField id="sim-fault_ka" value={f.fault_ka} placeholder="required" onCommit={setFo("fault_ka")} /></Field>
          <Field label="Fault X/R"><NumField id="sim-x_over_r" value={f.x_over_r} onCommit={(v) => v !== undefined && setFo("x_over_r")(v)} /></Field>
          <Field label="Clearing time" unit="s" hint="needed for I2t, temperature"><NumField id="sim-fault_clearing_s" value={f.fault_clearing_s} placeholder="required" onCommit={setFo("fault_clearing_s")} /></Field>
          <div className="sim-wide">
            <span className="field-label">Closing angle <em>{fmt(ang, 0)}°{auto ? " (worst case)" : ""}</em></span>
            <div className="sim-cursor" style={{ margin: "4px 0 0" }}>
              <input id="sim-angle" type="range" min="0" max="180" step="1" value={Math.round(ang)} aria-label="Closing angle in degrees"
                onChange={(e) => setSs((s) => ({ ...s, angle: Number(e.target.value) }))} />
              <Btn onClick={() => setSs((s) => ({ ...s, angle: undefined }))} active={auto} title="Use the angle at which the force is greatest">Worst</Btn>
            </div>
            <div className="field-hint">Point on the voltage wave at fault inception. 0° and 180° start the phase A current at zero; the DC offset is greatest near the worst angle.</div>
          </div>
        </div>
      </Section>
      <Section title="Tested ratings" aside={<span className="text-faint text-[12px]">from the CSA 273 / C37.23 test report</span>}>
        <div className="sim-fields">
          {fld("Momentary peak", "kA", "pk")}
          {fld("Short-time current", "kA rms", "st_ka")}
          {fld("Short-time duration", "s", "st_s")}
          {fld("Block load", "N", "blk", "optional", { hint: "tested load per block" })}
          {fld("Force per metre", "N/m", "frc", "optional")}
          <Field label="Block material (screening)">
            <select id="sim-block" className="num-input" value={ss.block_material || ""} onChange={(e) => setSs((s) => ({ ...s, block_material: e.target.value }))}>
              <option value="">none</option>
              {Object.keys(BLOCK_MATERIALS).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <p className="sim-note">No defaults: the standards&apos; test values were not available. Empty fields show NOT SET in the checks.</p>
      </Section>
    </>
  );
}
const ENTER = "test report";

function ScCharts({ sc, ss }) {
  const q = useQuality();
  const n = sc.t_s.length;
  const [tc, setTc] = useState(Math.min(n - 1, 12));
  const [playing, setPlaying] = useState(false);
  const idx = Math.min(tc, n - 1);
  const anim = q.animations;
  useEffect(() => { if (!anim) setPlaying(false); }, [anim]);
  useEffect(() => {
    if (!playing || !anim) return undefined;
    let raf = 0;
    const t0 = performance.now(), start = idx, dur = 5000;   // slow motion: the window plays over 5 s
    const step = (now) => { setTc(Math.floor((start + ((now - t0) / dur) * (n - 1)) % (n - 1))); raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, anim, n]);

  const tms = useMemo(() => sc.t_s.map((t) => t * 1000), [sc]);
  const winMs = tms[n - 1];
  const kA = (arr) => arr.map((v, k) => ({ x: tms[k], y: v / 1000 }));
  const lines = useMemo(() => ({ A: kA(sc.phase_current_a.A), B: kA(sc.phase_current_a.B), C: kA(sc.phase_current_a.C),
    up: kA(sc.envelope_upper_a), lo: kA(sc.envelope_lower_a) }), [sc]);
  const peak = useMemo(() => {
    let best = { v: 0, k: 0, p: "A" };
    const n1 = Math.min(n, 97);
    for (const p of ["A", "B", "C"]) for (let k = 0; k < n1; k++) { const v = sc.phase_current_a[p][k]; if (Math.abs(v) > Math.abs(best.v)) best = { v, k, p }; }
    return best;
  }, [sc]);
  const ymax = Math.max(sc.envelope_upper_a[0], -sc.envelope_lower_a[0], Math.abs(peak.v)) / 1000 * 1.12;
  const span = sc.span_m;
  const fdata = useMemo(() => ({ env: sc.force_envelope_n_per_m.map((v, k) => ({ x: tms[k], y: v })),
    wc: sc.force_worst_n_per_m.map((v, k) => ({ x: tms[k], y: v })) }), [sc]);
  const fmax = Math.max(sc.peak_force_n_per_m, ss.frc || 0, (ss.blk || 0) / span) * 1.12 || 1;
  const th = sc.thermal;
  const thMs = th.t_s.map((t) => t * 1000);
  const tdata = th.t_s.map((t, k) => ({ x: thMs[k], y: th.temp_c[k] }));
  const limitC = sc.sc_limit_c;
  const tmax = Math.max(th.final_c_worst_angle, limitC || 0) * 1.05;
  const tmin = Math.floor(Math.min(th.initial_c, th.temp_c[0]) - 10);
  const cur = (p) => sc.phase_current_a[p][idx] / 1000;
  return (
    <>
      <Section title="Phase currents" aside={<span className="text-faint text-[12px]">closing angle {fmt(sc.closing_angle_deg, 0)}° · X/R {fmt(sc.x_over_r, 1)} · {fmt(sc.fault_ka, 1)} kA rms symmetrical</span>}>
        <Chart height={280} ariaLabel="Short-circuit phase currents versus time" reportTitle="Short-circuit phase currents and DC offset envelope"
          x={{ domain: [0, winMs], nice: false, label: "Time", unit: "ms", grid: true }}
          y={{ domain: [-ymax, ymax], label: "Phase current", unit: "kA" }}
          legend={[{ name: "A", color: PHASE_VAR.A }, { name: "B", color: PHASE_VAR.B }, { name: "C", color: PHASE_VAR.C }, { name: `DC envelope (${sc.envelope_phase})`, color: "var(--faint)", kind: "ref" }]}
          hover={{ xs: tms, render: (i) => ({ title: `${fmt(tms[i], 1)} ms`, rows: ["A", "B", "C"].map((p) => ({ label: `i${p}`, value: `${fmt(sc.phase_current_a[p][i] / 1000, 1)} kA`, color: PHASE_VAR[p] })) }),
            points: (i) => ["A", "B", "C"].map((p) => ({ y: sc.phase_current_a[p][i] / 1000, color: PHASE_VAR[p] })) }}>
          <Line data={lines.up} color="var(--faint)" width={1.25} dash="5 4" />
          <Line data={lines.lo} color="var(--faint)" width={1.25} dash="5 4" />
          <Line data={lines.A} color={PHASE_VAR.A} /><Line data={lines.B} color={PHASE_VAR.B} /><Line data={lines.C} color={PHASE_VAR.C} />
          <Dot x={tms[peak.k]} y={peak.v / 1000} color={PHASE_VAR[peak.p]} label={`peak ${fmt(Math.abs(peak.v) / 1000, 1)} kA`} />
          <RefLine x={tms[idx]} tone="accent" label={`${fmt(tms[idx], 1)} ms`} dash="2 3" />
        </Chart>
        <div className="sim-cursor">
          {anim
            ? <Btn onClick={() => setPlaying((p) => !p)} active={playing} title="Play the waveform in slow motion">{playing ? "Pause" : "Play"}</Btn>
            : <span className="text-faint text-[12px]" title="Animations are off in the graphics menu or by the system motion setting">Animation off</span>}
          <input type="range" min="0" max={n - 1} step="1" value={idx} aria-label="Time cursor" onChange={(e) => { setPlaying(false); setTc(Number(e.target.value)); }} />
          <span className="sim-read"><span>t <b>{fmt(tms[idx], 1)} ms</b></span><span>iA <b>{fmt(cur("A"), 1)}</b></span><span>iB <b>{fmt(cur("B"), 1)}</b></span><span>iC <b>{fmt(cur("C"), 1)} kA</b></span></span>
        </div>
      </Section>

      <Section title="Force and support block load" aside={<span className="text-faint text-[12px]">worst conductor {sc.worst_conductor.phase} at x {fmt(sc.worst_conductor.x_mm, 0)} mm · span {fmt(span * 1000, 0)} mm</span>}>
        <Chart height={250} ariaLabel="Worst-conductor force per metre and block load versus time" reportTitle="Worst-conductor force per metre and support block load"
          x={{ domain: [0, winMs], nice: false, label: "Time", unit: "ms", grid: true }}
          y={{ domain: [0, fmax], label: "Force per metre", unit: "N/m" }}
          legend={[{ name: "Envelope of all conductors", color: "var(--accent)" }, { name: "Worst conductor", color: "var(--series-2)", kind: "ref" }]}
          hover={{ xs: tms, render: (i) => ({ title: `${fmt(tms[i], 1)} ms`, rows: [
            { label: "force (envelope)", value: `${fmt(sc.force_envelope_n_per_m[i], 0)} N/m`, color: "var(--accent)" },
            { label: "worst conductor", value: `${fmt(sc.force_worst_n_per_m[i], 0)} N/m`, color: "var(--series-2)" },
            { label: "block load", value: `${fmt(sc.block_load_n[i], 0)} N (${fmt(sc.block_load_n[i] * 0.224809, 0)} lbf)` }] }),
            points: (i) => [{ y: sc.force_envelope_n_per_m[i], color: "var(--accent)" }] }}>
          {ss.frc ? <RefLine y={ss.frc} tone="crit" label={`tested ${fmt(ss.frc, 0)} N/m`} align="start" /> : null}
          {ss.blk ? <RefLine y={ss.blk / span} tone="crit" label={`block rating ÷ span ${fmt(ss.blk / span, 0)} N/m`} align="start" dash="2 3" /> : null}
          <Line data={fdata.env} color="var(--accent)" />
          <Line data={fdata.wc} color="var(--series-2)" width={1.5} dash="4 3" />
          <Dot x={tms[idx]} y={sc.force_envelope_n_per_m[idx]} color="var(--accent)" />
          <RefLine x={tms[idx]} tone="accent" dash="2 3" />
        </Chart>
        <div className="sim-read mt-2"><span>at cursor: force <b>{fmt(sc.force_envelope_n_per_m[idx], 0)} N/m</b></span><span>block load <b>{fmt(sc.block_load_n[idx], 0)} N</b></span><span>peak block load <b>{fmt(sc.peak_block_load_n, 0)} N</b></span></div>
        <p className="sim-note">Block load is the static force per metre times the support span on one block, the same basis as the designer screening. Force is the Ampere-law resultant on the most loaded conductor; the dashed line marks the cursor time.</p>
      </Section>

      <Section title="Conductor temperature during the fault" aside={<span className="text-faint text-[12px]">adiabatic, ICEA P-32-382 · starts at {fmt(th.initial_c, 0)} °C · {fmt(th.t_end_s * 1000, 0)} ms</span>}>
        <Chart height={220} ariaLabel="Conductor temperature during the fault" reportTitle="Conductor temperature during the fault (adiabatic)"
          x={{ domain: [0, thMs[thMs.length - 1]], nice: false, label: "Time", unit: "ms" }}
          y={{ domain: [tmin, tmax], label: "Conductor temperature", unit: "°C" }}
          hover={{ xs: thMs, render: (i) => ({ title: `${fmt(thMs[i], 0)} ms`, rows: [{ label: "conductor", value: `${fmt(th.temp_c[i], 1)} °C`, color: "var(--series-2)" }] }), points: (i) => [{ y: th.temp_c[i], color: "var(--series-2)" }] }}>
          {limitC ? <RefLine y={limitC} tone="crit" label={`insulation limit ${fmt(limitC, 0)} °C`} align="start" /> : null}
          <Line data={tdata} color="var(--series-2)" />
          <Dot x={thMs[thMs.length - 1]} y={th.final_c} color="var(--series-2)" label={`${fmt(th.final_c, 1)} °C`} />
        </Chart>
        <p className="sim-note">Conductor with the largest current share (own share of the phase current, with the DC offset of the chosen closing angle). The check uses the worst heating angle ({fmt(th.final_c_worst_angle, 1)} °C at {fmt(th.worst_heating_angle_deg, 0)}°).</p>
      </Section>
    </>
  );
}

function ShortCircuit({ f, setF, ss, setSs, inp, ctx }) {
  const sim = useMemo(() => {
    try { const r = simulateShortCircuit(mkSim(inp, ss), ctx); r.sc_limit_c = inp.insulation_sc_limit_c; return { r }; } catch (e) { return { error: e.message }; }
  }, [inp, ctx, ss]);
  const sc = sim.r;
  const k = (name) => sc?.checks.find((c) => c.name.startsWith(name));
  const cMom = k("Momentary"), cSt = k("Short-time"), cBlk = k("Support block"), cTmp = k("Conductor temperature");
  return (
    <div className="sim-grid">
      <div className="sim-form"><ScInputs f={f} setF={setF} ss={ss} setSs={setSs} sc={sc} /></div>
      <div className="sim-results">
        {sim.error && <StateMsg kind="error" title="Cannot simulate the short circuit">{sim.error}. Enter the fault current and clearing time on the left (shared with the Check tab).</StateMsg>}
        {sc && <>
          <KpiStrip items={[
            { label: "Peak current", value: fmt(sc.peak_current_ka, 1), unit: "kA", status: stat(cMom), meter: meter(cMom, `${fmt(sc.peak_current_ka / (ss.pk || 1) * 100, 0)} % of tested peak`),
              sub: `${fmt(sc.peak_factor_computed, 2)} × rms sym (IEC 60909 ${fmt(sc.peak_factor_iec60909, 2)}) · ${ss.pk ? `tested ${fmt(ss.pk, 0)} kA` : "tested peak NOT SET"}` },
            { label: "Peak force", value: fmt(sc.worst_force_n_per_m, 0), unit: "N/m", status: stat(k("Peak force")),
              sub: `${fmt(sc.worst_force_lbf_per_ft, 0)} lbf/ft · worst closing angle ${fmt(sc.worst_angle_deg, 0)}°${ss.frc ? "" : " · tested NOT SET"}` },
            { label: "Block load", value: fmt(sc.worst_block_load_n, 0), unit: "N", status: stat(cBlk), meter: meter(cBlk, `${fmt(sc.worst_block_load_n / (ss.blk || 1) * 100, 0)} % of tested block`),
              sub: `${fmt(sc.worst_block_load_lbf, 0)} lbf over ${fmt(sc.span_m * 1000, 0)} mm${ss.blk ? "" : " · rating NOT SET"}` },
            { label: "Conductor temp. at clearing", value: sc.clearing_s ? fmt(sc.thermal.final_c_worst_angle, 0) : "—", unit: sc.clearing_s ? "°C" : "", status: stat(cTmp), meter: meter(cTmp, `limit ${fmt(sc.sc_limit_c, 0)} °C`),
              sub: sc.clearing_s ? `from ${fmt(sc.thermal.initial_c, 0)} °C over ${fmt(sc.clearing_s * 1000, 0)} ms` : "give a clearing time" },
            { label: "Let-through I²t", value: fmt(sc.i2t_sym_ka2s, 0), unit: "kA²s", status: stat(cSt), meter: meter(cSt, `${cSt && cSt.limit ? fmt(cSt.value / cSt.limit * 100, 0) : "—"} % of equivalent rating`),
              sub: sc.equivalent_rating_ka ? `rating equivalent ${fmt(sc.equivalent_rating_ka, 1)} kA at ${fmt(sc.clearing_s, 2)} s · asymmetric ${fmt(sc.i2t_asym_ka2s, 0)} kA²s` : "short-time rating NOT SET" },
          ]} />
          <ScCharts sc={sc} ss={ss} />
          <Section title="Rating checks" aside={<Pill tone={sc.passed === false ? "crit" : sc.complete ? "ok" : "warn"}>{sc.passed === false ? "Fail" : sc.complete ? "Pass" : "incomplete: ratings not set"}</Pill>}>
            <ChecksTable checks={sc.checks} format={std} />
          </Section>
          <DataStatus rows={sc.data_status} />
          <Section title="Notes"><ul className="cb-notes">{sc.notes.map((t, i) => <li key={i}>{t}</li>)}</ul></Section>
        </>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ temperature rise */
function TempCrossSection({ tr, ctx, inp }) {
  const rows = tr.cables, od = ctx.od;
  const lo = tr.ambient_c, hi = Math.max(inp.insulation_temp_c, tr.max_theta_c, lo + 1);
  const xs = rows.map((c) => c.x_mm), ys = rows.map((c) => c.y_mm);
  const xc = (Math.min(...xs) + Math.max(...xs)) / 2, yc = (Math.min(...ys) + Math.max(...ys)) / 2;
  const encW = inp.enclosure_width_mm || null;
  const encH = encW ? (inp.enclosure_height_mm || Math.max(...ys) - Math.min(...ys) + 2 * od) : null;
  const bw = Math.max(encW || 0, Math.max(...xs) - Math.min(...xs) + 2 * od) + 40;
  const bh = Math.max(encH || 0, Math.max(...ys) - Math.min(...ys) + 2 * od) + 40;
  const W = 560, padL = 16, barH = 54;
  const s = Math.min((W - 2 * padL) / bw, 200 / bh);
  const H = bh * s + barH + 38;
  const X = (x) => W / 2 + (x - xc) * s, Y = (y) => 12 + (bh * s) / 2 - (y - yc) * s;
  const color = (t) => rgbCss(rampAt(TEMP_HEX, normalize(t, [lo, hi])));
  const bx0 = 40, bwid = W - 80, by = bh * s + 34;
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  return (
    <svg className="ck-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cable cross-section coloured by steady-state conductor temperature"
      data-report-fig="Cable cross-section coloured by steady-state conductor temperature" style={{ maxHeight: 420 }}>
      <defs><linearGradient id="simTempGrad" x1="0" x2="1" y1="0" y2="0">{TEMP_HEX.map(([t, c]) => <stop key={t} offset={t} stopColor={c} />)}</linearGradient></defs>
      <rect x="0" y="0" width={W} height={H} style={{ fill: "var(--bg)" }} />
      {encW && <rect x={X(xc - encW / 2)} y={Y(yc + encH / 2)} width={encW * s} height={encH * s} fill="none" style={{ stroke: "var(--muted)" }} strokeWidth="1.5" strokeDasharray="6 4" />}
      {rows.map((c) => {
        const hot = c.index === tr.hottest.index, r = Math.max(od / 2 * s, 13);
        return (
          <g key={c.index}>
            <title>{`Phase ${c.phase}: ${fmt(c.current_a, 0)} A, conductor ${fmt(c.theta_c, 1)} °C (rise ${fmt(c.rise_k, 1)} K), surface ${fmt(c.surface_c, 1)} °C, ampacity ${fmt(c.ampacity_a, 0)} A`}</title>
            <circle cx={X(c.x_mm)} cy={Y(c.y_mm)} r={r} style={{ fill: color(c.theta_c), stroke: PHASE_VAR[c.phase] }} strokeWidth={hot ? 4 : 2.5} />
            <text x={X(c.x_mm)} y={Y(c.y_mm) + 4} textAnchor="middle" fontSize={r > 15 ? 13 : 11} fontWeight="600"
              style={{ fill: "#fff", stroke: "#0a0f14", strokeWidth: 2.5, paintOrder: "stroke", fontFamily: "var(--font-data)" }}>{fmt(c.theta_c, 0)}</text>
          </g>
        );
      })}
      <rect x={bx0} y={by} width={bwid} height="9" rx="2" fill="url(#simTempGrad)" />
      {ticks.map((t, k) => <text key={k} x={bx0 + (bwid * k) / 2} y={by + 24} textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"} fontSize="11" style={{ fill: "var(--muted)", fontFamily: "var(--font-data)" }}>{fmt(t, 0)}</text>)}
      <text x={bx0} y={by + 42} fontSize="11" style={{ fill: "var(--faint)", fontFamily: "var(--font-data)" }}>conductor temperature, °C (ambient to insulation rating)</text>
      <text x={bx0} y={by + 56} fontSize="11" style={{ fill: "var(--faint)", fontFamily: "var(--font-data)" }}>ring colour = phase, thick ring = hottest cable</text>
    </svg>
  );
}

function TrInputs({ f, setF, ss, setSs }) {
  const setS = (k) => (v) => setSs((s) => ({ ...s, [k]: v }));
  const fld = (label, unit, k, ph, hint) => (<Field label={label} unit={unit} hint={hint}><NumField id={`sim-${k}`} value={ss[k]} placeholder={ph || ENTER} onCommit={setS(k)} /></Field>);
  return (
    <>
      <Section title="Operating point">
        <div className="sim-fields">
          <Field label="Current" unit="% of design"><NumField id="sim-load" value={ss.load_pct} onCommit={(v) => v !== undefined && v > 0 && setS("load_pct")(v)} /></Field>
          <Field label="Ambient" unit="°C"><NumField id="sim-ambient" value={f.ambient_c} onCommit={(v) => v !== undefined && setF((s) => ({ ...s, ambient_c: v }))} /></Field>
          <Field label="Enclosure emissivity" hint={`default ${SIM_DATA.enclosure_convection.default_emissivity} is a flagged placeholder`}>
            <NumField id="sim-emis" value={ss.emis} placeholder={`${SIM_DATA.enclosure_convection.default_emissivity} (flagged)`} onCommit={setS("emis")} /></Field>
        </div>
        <p className="sim-note">Each cable carries its own current from the current-sharing solve. The enclosure is the one set on the Check tab.</p>
      </Section>
      <Section title="Rise limits" aside={<span className="text-faint text-[12px]">above ambient, from the test report</span>}>
        <div className="sim-fields">
          {fld("Conductor", "K", "rise_c")}
          {fld("Enclosure surface", "K", "rise_e", "", "accessible parts")}
          {fld("Termination limit", "K", "rise_t")}
          {fld("Termination rise", "K", "term", "estimate", "not simulated")}
        </div>
        <p className="sim-note">No defaults: C37.23 and CSA 273 limits are not in this tool.</p>
      </Section>
    </>
  );
}

function ThermalCharts({ tr }) {
  const w = tr.warmup, hc = tr.hottest;
  const tmin = w.t_s.map((t) => t / 60);
  const data = w.temp_c.map((v, k) => ({ x: tmin[k], y: v }));
  const rating = tr.rating_c;
  const ymax = Math.max(hc.theta_c, rating || 0) * 1.06, ymin = Math.floor(tr.ambient_c - 4);
  const iTau = 20, i95 = 60;
  return (
    <Chart height={250} ariaLabel="Warm-up of the hottest cable after a load step" reportTitle="Warm-up of the hottest cable (one-node model)"
      x={{ domain: [0, tmin[tmin.length - 1]], nice: false, label: "Time after the load step", unit: "min" }}
      y={{ domain: [ymin, ymax], label: "Conductor temperature", unit: "°C" }}
      legend={[{ name: `Hottest cable (phase ${hc.phase})`, color: "var(--series-2)" }, ...(rating ? [{ name: "Insulation rating", color: "var(--crit)", kind: "ref" }] : [])]}
      hover={{ xs: tmin, render: (i) => ({ title: `${fmt(tmin[i], 1)} min`, rows: [{ label: "conductor", value: `${fmt(w.temp_c[i], 1)} °C`, color: "var(--series-2)" }, { label: "of final rise", value: `${fmt((w.temp_c[i] - tr.ambient_c) / w.rise_inf_k * 100, 0)} %` }] }), points: (i) => [{ y: w.temp_c[i], color: "var(--series-2)" }] }}>
      {rating ? <RefLine y={rating} tone="crit" label={`${fmt(rating, 0)} °C`} align="start" /> : null}
      <RefLine y={hc.theta_c} tone="accent" label={`steady ${fmt(hc.theta_c, 1)} °C`} />
      <Line data={data} color="var(--series-2)" />
      <Dot x={tmin[iTau]} y={w.temp_c[iTau]} color="var(--series-2)" label={`τ ${fmt(w.tau_s / 60, 1)} min (63 %)`} />
      <Dot x={tmin[i95]} y={w.temp_c[i95]} color="var(--series-2)" label="3τ (95 %)" />
    </Chart>
  );
}

function TempRise({ f, setF, ss, setSs, inp, ctx }) {
  const sim = useMemo(() => {
    try { const r = simulateTemperatureRise(mkSim(inp, ss), ctx); r.rating_c = inp.insulation_temp_c; return { r }; } catch (e) { return { error: e.message }; }
  }, [inp, ctx, ss]);
  const tr = sim.r;
  const cCond = tr?.checks[1], cEnc = tr?.checks[2], cIns = tr?.checks[0];
  const hc = tr?.hottest, en = tr?.enclosure;
  return (
    <div className="sim-grid">
      <div className="sim-form"><TrInputs f={f} setF={setF} ss={ss} setSs={setSs} /></div>
      <div className="sim-results">
        {sim.error && <StateMsg kind="error" title="Cannot simulate the temperature rise">{sim.error}.</StateMsg>}
        {tr && <>
          <KpiStrip items={[
            { label: "Hottest conductor", value: fmt(hc.theta_c, 1), unit: "°C", status: stat(cIns), meter: { u: hc.theta_c / inp.insulation_temp_c, label: `rating ${fmt(inp.insulation_temp_c, 0)} °C` },
              sub: `rise ${fmt(hc.rise_k, 1)} K over ${fmt(tr.ambient_c, 0)} °C · phase ${hc.phase} at ${fmt(hc.current_a, 0)} A (${fmt(hc.current_a / hc.ampacity_a * 100, 0)} % of its ${fmt(hc.ampacity_a, 0)} A)` },
            { label: "Conductor rise vs limit", value: fmt(hc.rise_k, 1), unit: "K", status: stat(cCond), meter: meter(cCond, `limit ${ss.rise_c ? `${fmt(ss.rise_c, 0)} K` : ""}`), sub: ss.rise_c ? `limit ${fmt(ss.rise_c, 0)} K from the test report` : "limit NOT SET" },
            { label: "Enclosure surface (estimate)", value: en ? fmt(en.surface_c, 1) : "—", unit: en ? "°C" : "", status: stat(cEnc), meter: meter(cEnc, `limit ${ss.rise_e ? `${fmt(ss.rise_e, 0)} K` : ""}`),
              sub: en ? `rise ${fmt(en.rise_k, 1)} K · ${fmt(en.q_total_w_per_m, 0)} W/m rejected · estimate` : "model the enclosure on the Check tab" },
            { label: "Warm-up time constant", value: fmt(tr.warmup.tau_s / 60, 1), unit: "min", sub: `95 % of the rise in ${fmt(tr.warmup.t95_s / 60, 0)} min · one-node model` },
          ]} />
          <div className="sim-two">
            <Section title="Cross-section" aside={<span className="text-faint text-[12px]">steady state at {fmt(tr.load_scale * 100, 0)} % of design current</span>}>
              <TempCrossSection tr={tr} ctx={ctx} inp={inp} />
            </Section>
            <Section title="Enclosure estimate" aside={<Pill tone="warn">estimate</Pill>}>
              {en ? (
                <div className="sim-kv">
                  <span>Surface temperature</span><span>{fmt(en.surface_c, 1)} °C</span>
                  <span>Surface rise over ambient</span><span>{fmt(en.rise_k, 1)} K</span>
                  <span>Heat rejected, per metre</span><span>{fmt(en.q_total_w_per_m, 1)} W/m</span>
                  <span>… of which induced in the enclosure</span><span>{fmt(en.q_induced_w_per_m, 1)} W/m</span>
                  <span>By convection / radiation</span><span>{fmt(en.q_convection_w_per_m, 0)} / {fmt(en.q_radiation_w_per_m, 0)} W/m</span>
                  <span>Mean h, convection / radiation</span><span>{fmt(en.h_conv_avg_w_per_m2_k, 2)} / {fmt(en.h_rad_w_per_m2_k, 2)} W/m²K</span>
                  <span>Emissivity</span><span>{fmt(en.emissivity, 2)}{ss.emis === undefined ? " (flagged default)" : ""}</span>
                  <span>Outside size</span><span>{fmt(en.width_out_mm, 0)} × {fmt(en.height_out_mm, 0)} mm</span>
                </div>
              ) : <StateMsg title="No enclosure modelled">Tick &quot;Model enclosure&quot; on the Check tab to estimate the enclosure surface temperature.</StateMsg>}
              <p className="sim-note">Lumped heat balance of all losses inside the enclosure against natural convection and radiation from its outer surface, with no credit for ventilation. Use it to compare designs; the temperature-rise type test is the basis of the rating.</p>
            </Section>
          </div>
          <Section title="Warm-up after a load step" aside={<span className="text-faint text-[12px]">0 → {fmt(tr.load_scale * 100, 0)} % of design current · simplified one-node model</span>}>
            <ThermalCharts tr={tr} />
            <p className="sim-note">First-order response with τ = C × R: C = {fmt(tr.warmup.capacity_j_per_m_k.total, 0)} J/(m·K) (conductor {fmt(tr.warmup.capacity_j_per_m_k.conductor, 0)}, insulation {fmt(tr.warmup.capacity_j_per_m_k.insulation, 0)}, shield {fmt(tr.warmup.capacity_j_per_m_k.shield, 0)}, jacket {fmt(tr.warmup.capacity_j_per_m_k.jacket, 0)}) and R = {fmt(tr.warmup.r_th_k_m_per_w, 3)} K·m/W conductor to ambient. The enclosure&apos;s own thermal mass is ignored.</p>
          </Section>
          <Section title="Temperature checks" aside={<Pill tone={tr.passed === false ? "crit" : tr.complete ? "ok" : "warn"}>{tr.passed === false ? "Fail" : tr.complete ? "Pass" : "incomplete: limits not set"}</Pill>}>
            <ChecksTable checks={tr.checks} format={std} />
          </Section>
          <Section title="Cables" aside={<span className="text-faint text-[12px]">each at its own current</span>}>
            <div className="table-wrap">
              <table className="grid-table">
                <thead><tr><th>Phase</th><th className="r">x (mm)</th><th className="r">Current (A)</th><th className="r">Ampacity (A)</th><th className="r">λ1</th><th className="r">Conductor °C</th><th className="r">Rise K</th><th className="r">Surface °C</th><th className="r">Heat W/m</th></tr></thead>
                <tbody>{tr.cables.map((c) => (
                  <tr key={c.index} className={c.index === hc.index ? "is-sel" : undefined}>
                    <td>{c.phase}{c.index === hc.index ? " (hottest)" : ""}</td><td className="r">{fmt(c.x_mm, 0)}</td><td className="r">{fmt(c.current_a, 0)}</td><td className="r">{fmt(c.ampacity_a, 0)}</td>
                    <td className="r">{fmt(c.lambda1, 3)}</td><td className="r">{fmt(c.theta_c, 1)}</td><td className="r">{fmt(c.rise_k, 1)}</td><td className="r">{fmt(c.surface_c, 1)}</td><td className="r">{fmt(c.heat_w_per_m, 1)}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          </Section>
          <DataStatus rows={tr.data_status} />
          <Section title="Notes"><ul className="cb-notes">{tr.notes.map((t, i) => <li key={i}>{t}</li>)}</ul></Section>
        </>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ tab */
export function SimulateTab({ f, setF, ss, setSs, inp, error, hostRef }) {
  const ctxRes = useMemo(() => {
    if (!inp) return { error };
    try { return { ctx: buildContext(inp) }; } catch (e) { return { error: e.message }; }
  }, [inp]);
  return (
    <div className="main-inner">
      <style>{CSS}</style>
      <div className="px-4 pt-3 flex items-center gap-3 flex-wrap">
        <div className="seg" role="tablist" aria-label="Simulation">
          <Btn active={ss.sub === "sc"} onClick={() => setSs((s) => ({ ...s, sub: "sc" }))}>Short circuit</Btn>
          <Btn active={ss.sub === "tr"} onClick={() => setSs((s) => ({ ...s, sub: "tr" }))}>Temperature rise</Btn>
        </div>
        <span className="text-faint text-[12px]">Framed by IEEE C37.23 and CSA C22.2 No. 273; ratings and limits come from your test report.</span>
      </div>
      {ctxRes.error && <div className="p-4"><StateMsg kind="error" title="Cannot simulate this cable bus">{ctxRes.error}. Correct the design on the Check tab.</StateMsg></div>}
      {/* both views stay mounted so every chart is captured in the calculation package */}
      {ctxRes.ctx && <div style={ss.sub === "sc" ? undefined : { display: "none" }}><ShortCircuit f={f} setF={setF} ss={ss} setSs={setSs} inp={inp} ctx={ctxRes.ctx} /></div>}
      {ctxRes.ctx && <div style={ss.sub === "tr" ? undefined : { display: "none" }}><TempRise f={f} setF={setF} ss={ss} setSs={setSs} inp={inp} ctx={ctxRes.ctx} /></div>}
    </div>
  );
}

/* Calculation package for the Simulate tab: both simulations with their charts. */
export function simReport(inp, ss, host) {
  const sim = mkSim(inp, ss);
  const ctx = buildContext(inp);
  let sc = null, tr = null;
  try { sc = simulateShortCircuit(sim, ctx); } catch (e) { sc = null; }
  tr = simulateTemperatureRise(sim, ctx);
  const rows = [];
  if (sc) {
    rows.push({ label: "Peak current (worst closing angle)", value: sc.peak_current_ka, unit: "kA" }, { label: "Peak factor", value: sc.peak_factor_computed, unit: "" },
      { label: "Peak force per metre (worst conductor)", value: sc.worst_force_n_per_m, unit: "N/m" }, { label: "Peak support block load", value: sc.worst_block_load_n, unit: "N" },
      { label: "Conductor temperature at clearing (worst angle)", value: sc.thermal.final_c_worst_angle, unit: "C" }, { label: "Let-through I2t (rms symmetrical)", value: sc.i2t_sym_ka2s, unit: "kA2s" });
  }
  rows.push({ label: "Hottest conductor", value: tr.hottest.theta_c, unit: "C" }, { label: "Hottest conductor rise", value: tr.hottest.rise_k, unit: "K" },
    { label: "Enclosure surface temperature (estimate)", value: tr.enclosure ? tr.enclosure.surface_c : "not modelled", unit: tr.enclosure ? "C" : "" },
    { label: "Warm-up time constant", value: tr.warmup.tau_s / 60, unit: "min" });
  const checks = [...(sc ? sc.checks : []), ...tr.checks];
  return {
    title: "Cable bus short-circuit and temperature-rise simulation", module: "cablebus-sim",
    subtitle: `${inp.voltage_v} V, ${inp.current_a} A, ${inp.conductors_per_phase} x ${inp.size} ${inp.material} per phase; framed by IEEE C37.23 / CSA C22.2 No. 273`,
    inputs: [
      { label: "Fault current", value: inp.fault_ka ?? "not set", unit: "kA rms" }, { label: "Fault X/R", value: inp.x_over_r, unit: "" },
      { label: "Clearing time", value: inp.fault_clearing_s ?? "not set", unit: "s" }, { label: "Closing angle", value: ss.angle ?? "worst case", unit: ss.angle === undefined ? "" : "deg" },
      { label: "Support span", value: inp.support_span_m, unit: "m" }, { label: "Load", value: ss.load_pct ?? 100, unit: "% of design current" },
      { label: "Ambient", value: inp.ambient_c, unit: "C" },
      ...[["Tested momentary peak", ss.pk, "kA"], ["Tested short-time current", ss.st_ka, "kA rms"], ["Tested short-time duration", ss.st_s, "s"], ["Tested block load", ss.blk, "N"],
        ["Tested force per metre", ss.frc, "N/m"], ["Conductor rise limit", ss.rise_c, "K"], ["Enclosure rise limit", ss.rise_e, "K"], ["Termination rise limit", ss.rise_t, "K"],
        ["Termination rise estimate", ss.term, "K"]].map(([label, v, unit]) => ({ label, value: v ?? "NOT SET (enter from test report)", unit: v === undefined ? "" : unit })),
    ],
    results: rows, checks: checkRows(checks),
    tables: [{ title: "Steady-state cable temperatures", columns: ["Phase", "x (mm)", "Current (A)", "Ampacity (A)", "lambda1", "Conductor (C)", "Rise (K)", "Surface (C)", "Heat (W/m)"],
      rows: tr.cables.map((c) => [c.phase, c.x_mm, c.current_a, c.ampacity_a, c.lambda1, c.theta_c, c.rise_k, c.surface_c, c.heat_w_per_m]) }],
    figures: reportFigures(host),
    notes: [...(sc ? sc.notes : []), ...tr.notes],
    dataStatus: [...(sc ? sc.data_status : []), ...tr.data_status].map((d) => ({ table: `${d.name}: ${d.value}`, status: d.status, source: d.source })),
  };
}
