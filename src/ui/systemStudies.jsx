// Motor starting and daily load profile studies for the System workspace (Schedule view).
const { useState, useMemo } = React;
import { Btn, Pill, Section, Field, NumField, Tile, cx, fmt } from "./common.jsx";
import { motorStartStudy, startableMotors, largestMotor, STARTERS, DEFAULT_CRITERIA } from "../engine/motorstart.js";
import { profileStudy, PROFILES } from "../engine/loadprofile.js";

const CSS = `
.ss-row { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; margin-bottom:12px; }
.ss-row .field { min-width:140px; }
.ss-tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:12px; }
.ss-charts { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:14px; margin-bottom:12px; }
.ss-chart { background: var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; min-width:0; }
.ss-chart h4 { font-size:11.5px; color: var(--muted); margin:0 0 4px; font-weight:500; }
.ss-svg { width:100%; height:auto; display:block; font-variant-numeric: tabular-nums; }
.ss-svg text { fill: var(--faint); font-size:10px; font-family: var(--font-data); }
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
  .ss-svg text { font-size: 11.5px; }
  .ss-heat td.ss-cell { font-size: 11px; min-width: 24px; height: 22px; }
}
.ss-legend i { display:inline-block; width:140px; height:8px; border-radius:2px; background: linear-gradient(90deg, var(--ok), var(--high), var(--crit)); }
`;

const W = 360, H = 170, M = { l: 38, r: 10, t: 8, b: 22 };
const heat = (pct) => {
  if (pct == null) return "transparent";
  const p = Math.max(0, Math.min(100, pct));
  if (p <= 60) return `color-mix(in srgb, var(--ok) ${(100 - (p / 60) * 100).toFixed(0)}%, var(--high))`;
  return `color-mix(in srgb, var(--high) ${(100 - ((p - 60) / 40) * 100).toFixed(0)}%, var(--crit))`;
};
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function Axes({ x, y, xt, yt, yfmt = (v) => v }) {
  return (<g>
    <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--line)" />
    {yt.map((v) => (<g key={v}><line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--grid-major)" /><text x={M.l - 4} y={y(v) + 3} textAnchor="end">{yfmt(v)}</text></g>))}
    {xt.map((v) => <text key={v} x={x(v)} y={H - 8} textAnchor="middle">{v}</text>)}
  </g>);
}

/* ------------------------------------------------------------ motor start */
function DipChart({ rows, crit }) {
  const n = rows.length, bw = (W - M.l - M.r) / Math.max(n, 1);
  const ymax = Math.max(crit.bus_max_dip_pct * 1.2, ...rows.map((r) => r.dip_pct), 1);
  const y = scale(0, ymax, H - M.b, M.t);
  const ticks = [0, 0.5, 1].map((f) => +(f * ymax).toFixed(0));
  return (
    <svg className="ss-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Voltage dip per bus">
      <Axes x={() => 0} y={y} xt={[]} yt={ticks} yfmt={(v) => v + "%"} />
      <line x1={M.l} x2={W - M.r} y1={y(crit.bus_max_dip_pct)} y2={y(crit.bus_max_dip_pct)} stroke="var(--high)" strokeDasharray="4 3" />
      {rows.map((r, i) => (
        <g key={r.bus}>
          <rect x={M.l + i * bw + bw * 0.15} width={bw * 0.7} y={y(Math.max(r.dip_pct, 0))} height={Math.max(0, H - M.b - y(Math.max(r.dip_pct, 0)))} fill={r.pass ? "var(--ok)" : "var(--crit)"} opacity={r.is_motor ? 1 : 0.8}>
            <title>{`${r.label}: ${r.dip_pct.toFixed(2)} %`}</title></rect>
          <text x={M.l + i * bw + bw / 2} y={H - 8} textAnchor="middle">{r.bus}</text>
        </g>))}
    </svg>
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
      {!res && <p className="ss-note">Choose a motor and starter, then run. The motor's running load is replaced by its locked-rotor impedance (LRC {cur.lrc} x, start pf {cur.start_pf ?? 0.2}) and the load flow is re-solved.</p>}
      {res && !res.ok && <div className="notice notice-crit">{res.message}</div>}
      {res?.ok && (<>
        <div className="ss-tiles">
          <Tile label="Motor terminal" value={fmt(res.motor_terminal_pu * 100, 1)} unit="%" tone={res.pass.motor ? "ok" : "crit"} sub={res.pass.motor ? "meets minimum" : `below ${(criteria.motor_min_pu * 100).toFixed(0)} %`} />
          <Tile label="Starting current" value={res.start.i_a >= 1000 ? fmt(res.start.i_ka, 2) : fmt(res.start.i_a, 0)} unit={res.start.i_a >= 1000 ? "kA" : "A"} sub={`${fmt(res.start.multiple_fla, 2)} x FLA (${fmt(res.motor.fla_a, 0)} A)`} />
          <Tile label="Starting kVA" value={fmt(res.start.kva, 0)} unit="kVA" sub={`pf ${fmt(res.motor.start_pf, 2)}`} />
          <Tile label="Worst other bus" value={fmt(res.worst_other?.dip_pct, 1)} unit="% dip" tone={res.pass.others ? "ok" : "crit"} sub={res.worst_other ? res.worst_other.label : "no other buses"} />
        </div>
        <div className="ss-charts">
          <div className="ss-chart"><h4>Voltage dip per bus (dashed: {criteria.bus_max_dip_pct} % limit)</h4><DipChart rows={res.rows} crit={criteria} /></div>
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
function AreaChart({ hours }) {
  const x = scale(0, 23, M.l, W - M.r);
  const ymax = Math.max(...hours.map((h) => h.load_kw), 1) * 1.1;
  const y = scale(0, ymax, H - M.b, M.t);
  const lmax = Math.max(...hours.map((h) => h.loss_kw), 1e-9) * 1.1;
  const yl = scale(0, lmax, H - M.b, M.t);
  const area = (k, ys) => `M${x(0)},${H - M.b} ` + hours.map((h) => `L${x(h.hour).toFixed(1)},${ys(h[k]).toFixed(1)}`).join(" ") + ` L${x(23)},${H - M.b} Z`;
  return (
    <svg className="ss-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Load and losses by hour">
      <Axes x={x} y={y} xt={[0, 6, 12, 18, 23]} yt={[0, 0.5, 1].map((f) => +(f * ymax).toFixed(0))} />
      <path d={area("load_kw", y)} fill="var(--accent)" opacity="0.28" stroke="var(--accent)" />
      <path d={area("loss_kw", yl)} fill="var(--crit)" opacity="0.28" stroke="var(--crit)" />
      <text x={W - M.r} y={M.t + 8} textAnchor="end" style={{ fill: "var(--accent)" }}>load kW</text>
      <text x={W - M.r} y={M.t + 20} textAnchor="end" style={{ fill: "var(--crit)" }}>losses (own scale, peak {fmt(lmax / 1.1, 1)} kW)</text>
    </svg>
  );
}
function VoltChart({ hours }) {
  const vmin = Math.min(0.94, ...hours.map((h) => h.min_v)) - 0.005, vmax = Math.max(1.0, ...hours.map((h) => h.min_v)) + 0.005;
  const x = scale(0, 23, M.l, W - M.r), y = scale(vmin, vmax, H - M.b, M.t);
  const band = [0.95, 1.05].map((v) => Math.min(Math.max(v, vmin), vmax));
  return (
    <svg className="ss-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Minimum bus voltage by hour">
      <Axes x={x} y={y} xt={[0, 6, 12, 18, 23]} yt={[vmin, (vmin + vmax) / 2, vmax].map((v) => +v.toFixed(3))} yfmt={(v) => v.toFixed(3)} />
      <rect x={M.l} width={W - M.l - M.r} y={y(band[1])} height={Math.max(0, y(band[0]) - y(band[1]))} fill="var(--ok)" opacity="0.1" />
      <line x1={M.l} x2={W - M.r} y1={y(0.95)} y2={y(0.95)} stroke="var(--high)" strokeDasharray="4 3" />
      <polyline fill="none" stroke="var(--info)" strokeWidth="1.6" points={hours.map((h) => `${x(h.hour).toFixed(1)},${y(h.min_v).toFixed(1)}`).join(" ")} />
    </svg>
  );
}
function DurationChart({ duration }) {
  const x = scale(0, 100, M.l, W - M.r);
  const ymax = Math.max(...duration.map((d) => d.load_kw), 1) * 1.1, y = scale(0, ymax, H - M.b, M.t);
  const pts = [[0, duration[0].load_kw], ...duration.map((d) => [d.pct_time, d.load_kw])];
  return (
    <svg className="ss-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Load duration curve">
      <Axes x={x} y={y} xt={[0, 25, 50, 75, 100]} yt={[0, 0.5, 1].map((f) => +(f * ymax).toFixed(0))} />
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.6" points={pts.map(([p, v]) => `${x(p).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} />
      <text x={W - M.r} y={M.t + 8} textAnchor="end">% of hours</text>
    </svg>
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
      {!res.ok && <div className="notice notice-crit">{res.message}</div>}
      {res.ok && (<>
        <div className="ss-tiles">
          <Tile label="Energy" value={fmt(res.energy.load_kwh, 0)} unit="kWh/day" sub={`load factor ${fmt(res.energy.load_factor * 100, 0)} %`} />
          <Tile label="Losses" value={fmt(res.energy.loss_kwh, 0)} unit="kWh/day" sub={`${fmt(res.energy.loss_pct, 2)} % of energy`} />
          <Tile label="Peak" value={fmt(res.peak_kw, 0)} unit="kW" sub={`hour ${String(res.peak_hour).padStart(2, "0")}:00`} />
          <Tile label="Min voltage" value={fmt(res.min_v, 4)} unit="pu" tone={res.min_v < 0.95 ? "crit" : "ok"} sub="lowest bus, any hour" />
        </div>
        <div className="ss-charts">
          <div className="ss-chart"><h4>Load and losses by hour</h4><AreaChart hours={res.hours} /></div>
          <div className="ss-chart"><h4>Minimum bus voltage (band 0.95 pu and up)</h4><VoltChart hours={res.hours} /></div>
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
