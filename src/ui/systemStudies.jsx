// Motor starting and daily load profile studies for the System workspace (Schedule view).
const { useState, useMemo } = React;
import { Btn, Pill, Section, Field, NumField, Tile, cx, fmt, StateMsg } from "./common.jsx";
import { Chart, Bars, Line, Area, RefLine, Band } from "./charts/index.js";
import { motorStartStudy, startableMotors, largestMotor, STARTERS, DEFAULT_CRITERIA } from "../engine/motorstart.js";
import { profileStudy, PROFILES } from "../engine/loadprofile.js";

const CSS = `
.ss-row { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; margin-bottom:12px; }
.ss-row .field { min-width:140px; }
.ss-tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:12px; }
.ss-charts { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:14px; margin-bottom:12px; }
.ss-chart { background: var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; min-width:0; }
.ss-chart h4 { font-size:12.5px; color: var(--fg); margin:0 0 6px; font-weight:600; }
.ss-chart h4 span { color: var(--faint); font-weight:400; }
.ss-note { color: var(--faint); font-size:12px; line-height:1.5; margin-top:8px; }
.ss-bar { display:inline-block; height:8px; border-radius:2px; vertical-align:middle; min-width:1px; }
.ss-barcell { width:140px; }
.ss-num { font-variant-numeric: tabular-nums; }
.ss-heat { border-collapse:separate; border-spacing:1px; font-size:11px; width:100%; }
.ss-heat th { font-weight:500; color: var(--faint); text-align:center; padding:0 0 2px; font-variant-numeric: tabular-nums; }
.ss-heat td.ss-tag { font-family: var(--font-data); padding-right:8px; white-space:nowrap; color: var(--muted); text-align:left; }
.ss-heat td.ss-cell { height:18px; min-width:16px; text-align:center; font-size:9.5px; color:#0a0f14; font-variant-numeric: tabular-nums; border-radius:2px; }
.ss-legend { display:flex; align-items:center; gap:8px; font-size:11px; color: var(--faint); margin-top:6px; }
@media (max-width: 640px) {
  .ss-heat td.ss-cell { font-size: 11px; min-width: 24px; height: 22px; }
}
.ss-legend i { display:inline-block; width:140px; height:8px; border-radius:2px; background: linear-gradient(90deg, var(--ok), var(--high), var(--crit)); }
`;

const heat = (pct) => {
  if (pct == null) return "transparent";
  const p = Math.max(0, Math.min(100, pct));
  if (p <= 60) return `color-mix(in srgb, var(--ok) ${(100 - (p / 60) * 100).toFixed(0)}%, var(--high))`;
  return `color-mix(in srgb, var(--high) ${(100 - ((p - 60) / 40) * 100).toFixed(0)}%, var(--crit))`;
};
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

/* ------------------------------------------------------------ motor start */
function DipChart({ rows, crit }) {
  const ymax = Math.max(crit.bus_max_dip_pct * 1.2, ...rows.map((r) => r.dip_pct), 1);
  const color = (v, i) => (rows[i].pass ? "var(--ok)" : "var(--crit)");
  return (
    <Chart height={200} ariaLabel="Voltage dip per bus" reportTitle="Motor starting: voltage dip per bus"
      x={{ type: "band", n: rows.length, labels: rows.map((r) => String(r.bus)), label: "Bus" }}
      y={{ domain: [0, ymax], label: "Dip", unit: "%" }}
      hover={{ render: (i) => { const r = rows[i]; return { title: r.label, rows: [{ label: r.is_motor ? "motor bus dip" : "dip", value: `${r.dip_pct.toFixed(2)} %`, color: color(0, i) }, { label: "during start", value: `${fmt(r.v_start, 4)} pu` }, { label: "result", value: r.pass ? "pass" : "fail" }] }; } }}>
      <RefLine y={crit.bus_max_dip_pct} label={`limit ${crit.bus_max_dip_pct} %`} tone="warn" />
      <Bars values={rows.map((r) => Math.max(r.dip_pct, 0))} color={color} labels={() => rows.length <= 10} format={(v) => v.toFixed(1)} />
    </Chart>
  );
}

export function MotorStartSection({ sys }) {
  const motors = useMemo(() => startableMotors(sys), [sys]);
  const [sel, setSel] = useState(null);
  const [starter, setStarter] = useState(null);
  const [crit, setCrit] = useState({});
  const [ran, setRan] = useState(0);
  const cur = motors.find((m) => m.id === sel) || largestMotor(sys);
  const stk = starter ?? cur?.starter ?? "dol";
  const criteria = { ...DEFAULT_CRITERIA, ...crit };
  const res = useMemo(() => (cur && ran ? motorStartStudy(sys, cur.id, { starter: stk, criteria: crit }) : null), [sys, cur?.id, stk, crit, ran]);
  if (!motors.length) return null;
  return (
    <Section title="Motor starting · voltage dip" aside={<Pill tone="warn" title={`Typical criteria from ${DEFAULT_CRITERIA.refs}. The project specification governs.`}>typical criteria</Pill>}>
      <style>{CSS}</style>
      <div className="ss-row">
        <Field label="Motor"><select className="num-input" value={cur.id} onChange={(e) => { setSel(e.target.value); setStarter(null); }}>
          {motors.map((m) => <option key={m.id} value={m.id}>{m.id} · {m.hp} hp</option>)}</select></Field>
        <Field label="Starter"><select className="num-input" value={stk} onChange={(e) => setStarter(e.target.value)}>
          {Object.entries(STARTERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Motor min" unit="pu"><NumField value={criteria.motor_min_pu} onCommit={(v) => v > 0 && setCrit((c) => ({ ...c, motor_min_pu: v }))} /></Field>
        <Field label="Bus dip max" unit="%"><NumField value={criteria.bus_max_dip_pct} onCommit={(v) => v > 0 && setCrit((c) => ({ ...c, bus_max_dip_pct: v }))} /></Field>
        <Field label="Bus min" unit="pu"><NumField value={criteria.bus_min_pu} onCommit={(v) => v > 0 && setCrit((c) => ({ ...c, bus_min_pu: v }))} /></Field>
        <Btn kind="primary" onClick={() => setRan((n) => n + 1)}>Run start study</Btn>
      </div>
      {!res && <StateMsg title="No start study yet">Choose a motor and starter, then run. The motor's running load is replaced by its locked-rotor impedance (LRC {cur.lrc} x, start pf {cur.start_pf ?? 0.2}) and the load flow is re-solved.</StateMsg>}
      {res && !res.ok && <StateMsg kind="error" title="Start study did not solve">{res.message}</StateMsg>}
      {res?.ok && (<>
        <div className="ss-tiles">
          <Tile label="Motor terminal" value={fmt(res.motor_terminal_pu * 100, 1)} unit="%" tone={res.pass.motor ? "ok" : "crit"} sub={res.pass.motor ? "meets minimum" : `below ${(criteria.motor_min_pu * 100).toFixed(0)} %`} />
          <Tile label="Starting current" value={res.start.i_a >= 1000 ? fmt(res.start.i_ka, 2) : fmt(res.start.i_a, 0)} unit={res.start.i_a >= 1000 ? "kA" : "A"} sub={`${fmt(res.start.multiple_fla, 2)} x FLA (${fmt(res.motor.fla_a, 0)} A)`} />
          <Tile label="Starting kVA" value={fmt(res.start.kva, 0)} unit="kVA" sub={`pf ${fmt(res.motor.start_pf, 2)}`} />
          <Tile label="Worst other bus" value={fmt(res.worst_other?.dip_pct, 1)} unit="% dip" tone={res.pass.others ? "ok" : "crit"} sub={res.worst_other ? res.worst_other.label : "no other buses"} />
        </div>
        <div className="ss-charts">
          <div className="ss-chart"><h4>Voltage dip per bus <span>· dashed line is the {criteria.bus_max_dip_pct} % limit</span></h4><DipChart rows={res.rows} crit={criteria} /></div>
          <div className="table-wrap"><table className="grid-table">
            <thead><tr><th>Bus</th><th className="r">kV</th><th className="r">Pre<em>pu</em></th><th className="r">Start<em>pu</em></th><th className="r">Dip</th><th className="ss-barcell"></th><th>Result</th></tr></thead>
            <tbody>{res.rows.map((r) => (
              <tr key={r.bus}>
                <td><span className="font-mono">{r.label}</span>{r.is_motor && <span className="text-muted"> · motor {res.motor.id}</span>}</td>
                <td className="r">{r.kv}</td><td className="r">{fmt(r.v_pre, 4)}</td><td className="r">{fmt(r.v_start, 4)}</td><td className="r">{fmt(r.dip_pct, 2)} %</td>
                <td className="ss-barcell"><span className="ss-bar" style={{ width: `${Math.min(100, (r.dip_pct / Math.max(criteria.bus_max_dip_pct * 2, 1)) * 100)}%`, background: r.pass ? "var(--ok)" : "var(--crit)" }} /></td>
                <td><Pill tone={r.pass ? "ok" : "crit"} title={r.limit}>{r.pass ? "pass" : "fail"}</Pill></td>
              </tr>))}</tbody>
          </table></div>
        </div>
        <p className="ss-note">Static snapshot: constant-impedance locked rotor at the motor bus, other loads constant power. Criteria are typical ({DEFAULT_CRITERIA.refs}): motor terminal at least {(criteria.motor_min_pu * 100).toFixed(0)} % for DOL starting torque, other buses dip at most {criteria.bus_max_dip_pct} % and stay above {criteria.bus_min_pu} pu for contactor hold-in. Confirm against the project specification and the motor torque curve.</p>
      </>)}
    </Section>
  );
}

/* ------------------------------------------------------------ load profile */
/* Load and losses share the hour axis but not a scale, so they are two aligned charts rather than one dual-axis chart. */
function hourHover(hours, rows) {
  return { xs: HOURS, render: (i) => ({ title: hh(hours[i].hour), rows: rows(hours[i]) }) };
}
function LoadChart({ hours }) {
  const ymax = Math.max(...hours.map((h) => h.load_kw), 1) * 1.1;
  const data = hours.map((h) => ({ x: h.hour, y: h.load_kw }));
  return (
    <Chart height={170} ariaLabel="Load by hour" reportTitle="Load by hour"
      x={{ domain: [0, 23], nice: false, ticks: [0, 6, 12, 18, 23], format: (v) => String(v), label: "Hour" }}
      y={{ domain: [0, ymax], label: "Load", unit: "kW" }}
      hover={{ ...hourHover(hours, (h) => [{ label: "load", value: `${fmt(h.load_kw, 0)} kW`, color: "var(--accent)" }, { label: "losses", value: `${fmt(h.loss_kw, 1)} kW`, color: "var(--crit)" }]), points: (i) => [{ y: hours[i].load_kw, color: "var(--accent)" }] }}>
      <Area data={data} color="var(--accent)" opacity={0.14} />
    </Chart>
  );
}
function LossChart({ hours }) {
  const lmax = Math.max(...hours.map((h) => h.loss_kw), 1e-9) * 1.1;
  const data = hours.map((h) => ({ x: h.hour, y: h.loss_kw }));
  return (
    <Chart height={130} ariaLabel="Losses by hour" reportTitle="Losses by hour"
      x={{ domain: [0, 23], nice: false, ticks: [0, 6, 12, 18, 23], format: (v) => String(v), label: "Hour" }}
      y={{ domain: [0, lmax], count: 3, label: "Losses", unit: "kW" }}
      hover={{ ...hourHover(hours, (h) => [{ label: "losses", value: `${fmt(h.loss_kw, 2)} kW`, color: "var(--crit)" }]), points: (i) => [{ y: hours[i].loss_kw, color: "var(--crit)" }] }}>
      <Area data={data} color="var(--crit)" opacity={0.14} />
    </Chart>
  );
}
function VoltChart({ hours }) {
  const vmin = Math.min(0.94, ...hours.map((h) => h.min_v)) - 0.005, vmax = Math.max(1.0, ...hours.map((h) => h.min_v)) + 0.005;
  const data = hours.map((h) => ({ x: h.hour, y: h.min_v }));
  return (
    <Chart height={200} ariaLabel="Minimum bus voltage by hour" reportTitle="Minimum bus voltage by hour"
      x={{ domain: [0, 23], nice: false, ticks: [0, 6, 12, 18, 23], format: (v) => String(v), label: "Hour" }}
      y={{ domain: [vmin, vmax], nice: false, count: 4, label: "Lowest bus voltage", unit: "pu" }}
      hover={{ ...hourHover(hours, (h) => [{ label: "lowest bus", value: `${fmt(h.min_v, 4)} pu`, color: "var(--info)" }]), points: (i) => [{ y: hours[i].min_v, color: "var(--info)" }] }}>
      <Band y0={0.95} y1={1.05} tone="ok" />
      <RefLine y={0.95} label="0.95 pu" tone="warn" />
      <Line data={data} color="var(--info)" />
    </Chart>
  );
}
function DurationChart({ duration }) {
  const ymax = Math.max(...duration.map((d) => d.load_kw), 1) * 1.1;
  const pts = [{ x: 0, y: duration[0].load_kw }, ...duration.map((d) => ({ x: d.pct_time, y: d.load_kw }))];
  const xs = pts.map((p) => p.x);
  return (
    <Chart height={200} ariaLabel="Load duration curve" reportTitle="Load-duration curve"
      x={{ domain: [0, 100], nice: false, ticks: [0, 25, 50, 75, 100], format: (v) => String(v), label: "Share of hours", unit: "%" }}
      y={{ domain: [0, ymax], label: "Load", unit: "kW" }}
      hover={{ xs, render: (i) => ({ title: `${fmt(xs[i], 1)} % of hours`, rows: [{ label: "load at or above", value: `${fmt(pts[i].y, 0)} kW`, color: "var(--accent)" }] }), points: (i) => [{ x: xs[i], y: pts[i].y, color: "var(--accent)" }] }}>
      <Line data={pts} color="var(--accent)" />
    </Chart>
  );
}

export function ProfileSection({ sys }) {
  const [name, setName] = useState("industrial_two_shift");
  const res = useMemo(() => profileStudy(sys, name), [sys, name]);
  const rows = useMemo(() => (res.ok ? [...Object.entries(res.loading), ...Object.entries(res.connectors)].map(([id, a]) => ({ id, a, max: Math.max(...a.filter((v) => v != null)) })).sort((p, q) => q.max - p.max) : []), [res]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 12);
  return (
    <Section title="Daily load profile · energy and losses" aside={<span className="text-faint text-[12px]">24 hourly load flows</span>}>
      <style>{CSS}</style>
      <div className="ss-row">
        <Field label="Profile"><select className="num-input" value={name} onChange={(e) => setName(e.target.value)}>
          {Object.entries(PROFILES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      </div>
      {!res.ok && <StateMsg kind="error" title="Profile study did not solve">{res.message}</StateMsg>}
      {res.ok && (<>
        <div className="ss-tiles">
          <Tile label="Energy" value={fmt(res.energy.load_kwh, 0)} unit="kWh/day" sub={`load factor ${fmt(res.energy.load_factor * 100, 0)} %`} />
          <Tile label="Losses" value={fmt(res.energy.loss_kwh, 0)} unit="kWh/day" sub={`${fmt(res.energy.loss_pct, 2)} % of energy`} />
          <Tile label="Peak" value={fmt(res.peak_kw, 0)} unit="kW" sub={`hour ${String(res.peak_hour).padStart(2, "0")}:00`} />
          <Tile label="Min voltage" value={fmt(res.min_v, 4)} unit="pu" tone={res.min_v < 0.95 ? "crit" : "ok"} sub="lowest bus, any hour" />
        </div>
        <div className="ss-charts">
          <div className="ss-chart"><h4>Load and losses by hour <span>· each on its own scale</span></h4><LoadChart hours={res.hours} /><LossChart hours={res.hours} /></div>
          <div className="ss-chart"><h4>Minimum bus voltage <span>· band 0.95 pu and up</span></h4><VoltChart hours={res.hours} /></div>
          <div className="ss-chart"><h4>Load-duration curve</h4><DurationChart duration={res.duration} /></div>
        </div>
        <div className="table-wrap"><table className="ss-heat">
          <thead><tr><th></th>{res.hours.map((h) => <th key={h.hour}>{h.hour}</th>)}</tr></thead>
          <tbody>
            <tr><td className="ss-tag">worst</td>{res.hours.map((h) => <td key={h.hour} className="ss-cell" title={`${h.worst_id}: ${h.worst_loading_pct.toFixed(0)} %`} style={{ background: heat(h.worst_loading_pct) }}>{h.worst_loading_pct.toFixed(0)}</td>)}</tr>
            {shown.map((r) => <tr key={r.id}><td className="ss-tag">{r.id}</td>{r.a.map((v, h) => <td key={h} className="ss-cell" title={`${r.id} hour ${h}: ${v == null ? "n/a" : v.toFixed(1) + " %"}`} style={{ background: heat(v) }}>{v == null ? "" : v.toFixed(0)}</td>)}</tr>)}
          </tbody>
        </table></div>
        <div className="ss-legend">Loading % of rating <i /> 0 to 100+ {rows.length > 12 && <Btn onClick={() => setAll(!all)}>{all ? "Show top 12" : `Show all ${rows.length}`}</Btn>}</div>
        <p className="ss-note">Every static load and motor load factor is scaled by the hourly multiplier (override per item with a <span className="font-mono">profile</span> field). Capacitors and sources are unchanged. Heat strip lists equipment and cables with a rating, worst first.</p>
      </>)}
    </Section>
  );
}
