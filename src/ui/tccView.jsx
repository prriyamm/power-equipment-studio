/* Coordination view: log-log time-current curves along the protective path from a chosen load to the utility. */
const { useMemo, useState } = React;
import { protectionPath, coordination, deviceTimes, cableDamageTime, IEEE_CURVES } from "../engine/tcc.js";
import { buildLineup } from "../engine/gear.js";
import { EQUIPMENT, NODE_KINDS } from "../engine/system.js";
import { Section, Pill, Btn, NumField, fmt, cx } from "./common.jsx";

const CSS = `
.tcc-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; }
@media (max-width: 1100px) { .tcc-grid { grid-template-columns: minmax(0, 1fr); } }
.tcc-svg { width: 100%; height: auto; display: block; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
.tcc-dec { stroke: var(--grid-major); stroke-width: 1; }
.tcc-sub { stroke: var(--grid); stroke-width: 0.6; }
.tcc-tick { font-family: var(--font-data); font-size: 10.5px; fill: var(--faint); }
.tcc-axis { font-family: var(--font-ui); font-size: 11.5px; fill: var(--muted); }
.tcc-lbl { font-family: var(--font-data); font-size: 10px; paint-order: stroke; stroke: var(--bg); stroke-width: 3px; }
.tcc-dev { border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.tcc-dev h4 { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.tcc-dev .sw { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.tcc-set { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.tcc-set label { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; color: var(--muted); }
`;
const PALETTE = ["#5aa0e0", "#e8c35a", "#c07ae0", "#4cc38a", "#ff8b4a", "#e05a8f", "#63d6d6"];

export function CoordinationView({ sys, analysis, updateCon }) {
  const starts = sys.equipment.filter((e) => ["motor", "load", "capacitor"].includes(e.type) || NODE_KINDS.has(e.type));
  const [startId, setStartId] = useState(() => (sys.equipment.find((e) => e.type === "motor") || starts[0])?.id);
  const valid = starts.some((e) => e.id === startId) ? startId : starts[0]?.id;

  const P = useMemo(() => {
    if (!analysis?.ok || !valid) return null;
    // feeder trip ratings from the gear lineups so the TCC matches the breaker schedule
    const trips = {};
    for (const g of sys.equipment.filter((e) => NODE_KINDS.has(e.type))) {
      try { for (const c of buildLineup(sys, analysis, g.id).circuits) if (!(g.kv > 1)) trips[c.tag] ??= c.trip; } catch (err) { /* gear without circuits */ }
    }
    try { return protectionPath(sys, analysis, valid, trips); } catch (err) { return { error: err.message }; }
  }, [sys, analysis, valid]);
  const coord = useMemo(() => (P && !P.error ? coordination(P) : []), [P]);

  if (!analysis?.ok) return <div className="p-6 text-muted">Solve the system first.</div>;
  if (!P || P.error) return <div className="p-6 text-crit">{P?.error || "No protective path."}</div>;

  // axes
  const ratings = P.devices.map((d) => d.rating_a * d.ratio);
  const maxF = Math.max(...P.faults.map((f) => f.ka_ref * 1000), 1000);
  const x0 = Math.pow(10, Math.floor(Math.log10(Math.max(1, Math.min(...ratings, P.start.fla ?? Infinity) * 0.5)))), x1 = Math.pow(10, Math.ceil(Math.log10(maxF * 1.5)));
  const y0 = 0.01, y1 = 1000;
  const W = 820, H = 620, L = 62, R = 16, T = 16, B = 46;
  const X = (i) => L + ((Math.log10(i) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0))) * (W - L - R);
  const Y = (t) => T + ((Math.log10(y1) - Math.log10(Math.min(Math.max(t, y0), y1))) / (Math.log10(y1) - Math.log10(y0))) * (H - T - B);
  const grid = [];
  for (let e = Math.log10(x0); e <= Math.log10(x1); e++) for (let m = 1; m < 10; m++) {
    const v = m * Math.pow(10, e); if (v > x1) break;
    grid.push(<line key={"x" + v} x1={X(v)} x2={X(v)} y1={T} y2={H - B} className={m === 1 ? "tcc-dec" : "tcc-sub"} />);
    if (m === 1) grid.push(<text key={"xt" + v} x={X(v)} y={H - B + 16} textAnchor="middle" className="tcc-tick">{v >= 1000 ? `${v / 1000}k` : v}</text>);
  }
  for (let e = -2; e <= 3; e++) for (let m = 1; m < 10; m++) {
    const v = m * Math.pow(10, e); if (v > y1) break;
    grid.push(<line key={"y" + v} x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className={m === 1 ? "tcc-dec" : "tcc-sub"} />);
    if (m === 1) grid.push(<text key={"yt" + v} x={L - 6} y={Y(v) + 3.5} textAnchor="end" className="tcc-tick">{v}</text>);
  }
  const N = 220, Is = Array.from({ length: N + 1 }, (_, k) => Math.pow(10, Math.log10(x0) + (k / N) * (Math.log10(x1) - Math.log10(x0))));
  const curves = [];
  P.devices.forEach((d, k) => {
    const col = PALETTE[k % PALETTE.length];
    const lo = [], hi = [];
    for (const I of Is) {
      const tt = deviceTimes(d, I / d.ratio);
      if (tt.min !== Infinity && tt.min <= y1) lo.push([X(I), Y(tt.min)]);
      if (tt.max !== Infinity && tt.max <= y1) hi.push([X(I), Y(tt.max)]);
    }
    if (!lo.length) return;
    const poly = [...hi, ...[...lo].reverse()].map((p) => p.join(",")).join(" ");
    curves.push(<g key={d.id}>
      <polygon points={poly} fill={col} fillOpacity="0.16" stroke="none" />
      <polyline points={lo.map((p) => p.join(",")).join(" ")} fill="none" stroke={col} strokeWidth="1.6" />
      <polyline points={hi.map((p) => p.join(",")).join(" ")} fill="none" stroke={col} strokeWidth="1.2" strokeOpacity="0.7" />
      <text x={hi[0]?.[0] + 4} y={Math.max(hi[0]?.[1] ?? T, T + 10) + 10} className="tcc-lbl" fill={col}>{d.connector}</text>
    </g>);
  });
  // damage curves
  P.damage.forEach((dm, k) => {
    const pts = [];
    if (dm.kind === "cable") {
      for (const I of Is) { const t = cableDamageTime(I / dm.ratio, dm.size, dm.material, dm.sets, dm.insulation_c >= 90 ? 90 : 75, dm.insulation_c >= 90 ? 250 : 200); if (t && t >= y0 && t <= 10) pts.push([X(I), Y(t)]); }
    } else if (dm.kind === "transformer") {
      for (const I of Is) { const pu = I / dm.fla_ref; const t = 1250 / (pu * pu); if (pu >= 1.2 && t >= 2 && t <= y1) pts.push([X(I), Y(t)]); }
    }
    if (pts.length > 1) curves.push(<g key={"dm" + k}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={dm.kind === "transformer" ? "var(--crit)" : "var(--high)"} strokeWidth="1.4" strokeDasharray="6 3" />
      <text x={pts[pts.length - 1][0] + 3} y={pts[pts.length - 1][1] - 3} className="tcc-lbl" fill={dm.kind === "transformer" ? "var(--crit)" : "var(--high)"}>{dm.id} damage</text>
    </g>);
    if (dm.kind === "transformer" && dm.inrush_ref >= x0 && dm.inrush_ref <= x1) curves.push(<g key={"in" + k}><circle cx={X(dm.inrush_ref)} cy={Y(0.1)} r="4" fill="none" stroke="var(--crit)" strokeWidth="1.4" /><text x={X(dm.inrush_ref) + 6} y={Y(0.1) + 4} className="tcc-lbl" fill="var(--crit)">{dm.id} inrush</text></g>);
  });
  // start equipment curve
  if (P.start.kind === "motor") {
    const s = P.start;
    const d = `M${X(s.lrc_a)},${Y(y0)} V${Y(s.accel_s)} H${X(s.fla)} V${Y(y1)}`;
    curves.push(<g key="motor"><path d={d} fill="none" stroke="var(--fg)" strokeWidth="1.6" /><circle cx={X(s.lrc_a)} cy={Y(s.stall_s)} r="4" fill="var(--fg)" />
      <text x={X(s.fla) + 4} y={Y(300)} className="tcc-lbl" fill="var(--fg)">{valid} start</text></g>);
  } else if (P.start.fla) curves.push(<line key="fla" x1={X(P.start.fla)} x2={X(P.start.fla)} y1={Y(y1)} y2={Y(10)} stroke="var(--fg)" strokeWidth="1.4" />);
  // fault markers
  P.faults.forEach((f, k) => {
    const I = f.ka_ref * 1000; if (I < x0 || I > x1) return;
    const ty = 0.025 * Math.pow(2.2, k % 4);
    curves.push(<g key={"f" + k}><line x1={X(I)} x2={X(I)} y1={Y(y0)} y2={Y(ty)} stroke="var(--accent)" strokeWidth="2" /><text x={X(I) - 3} y={Y(ty) - 4} textAnchor="end" className="tcc-lbl" fill="var(--accent)">{f.id} {fmt(f.ka_ref, 1)} kA</text></g>);
  });

  const setDev = (d, patch) => updateCon(d.connector, { protection: { ...(sys.connectors.find((c) => c.id === d.connector)?.protection || {}), ...patch } });
  const autoAll = () => P.devices.forEach((d) => updateCon(d.connector, { protection: undefined }));
  const allOk = coord.every((c) => c.ok);

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto">
      <style>{CSS}</style>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px]"><span className="text-muted">Path from</span>
          <select id="tcc-start" className="num-input" style={{ width: 220 }} value={valid} onChange={(e) => setStartId(e.target.value)}>{starts.map((e) => <option key={e.id} value={e.id}>{e.id} · {e.name || EQUIPMENT[e.type].label}</option>)}</select></label>
        <Pill tone={allOk ? "ok" : "crit"}>{allOk ? "Selective" : "Not selective"}</Pill>
        <span className="text-faint text-[12px]">Currents referred to {P.refKv < 1 ? `${Math.round(P.refKv * 1000)} V` : `${P.refKv} kV`}</span>
        <Btn className="ml-auto" onClick={autoAll}>Auto-coordinate</Btn>
      </div>
      <div className="tcc-grid">
        <div className="min-w-0">
          <svg viewBox={`0 0 ${W} ${H}`} className="tcc-svg" role="img" aria-label="Time-current coordination curves">
            {grid}
            <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="none" stroke="var(--line)" />
            {curves}
            <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" className="tcc-axis">Current (A) at {P.refKv < 1 ? `${Math.round(P.refKv * 1000)} V` : `${P.refKv} kV`}</text>
            <text x={14} y={(T + H - B) / 2} textAnchor="middle" className="tcc-axis" transform={`rotate(-90 14 ${(T + H - B) / 2})`}>Time (s)</text>
          </svg>
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          {P.devices.map((d, k) => (
            <div key={d.id} className="tcc-dev">
              <h4><span className="sw" style={{ background: PALETTE[k % PALETTE.length] }} />{d.label}{d.override && <Pill tone="accent">manual</Pill>}{d.uncoordinated && <Pill tone="crit">no selective setting</Pill>}</h4>
              <div className="text-faint text-[11.5px]">{d.kind === "relay" ? `${IEEE_CURVES[d.settings.curve]?.label} · base ${fmt(d.rating_a, 0)} A at ${d.kv} kV` : `sensor ${fmt(d.settings.sensor, 0)} A · ${d.role}`} · load {fmt(d.load_a, 0)} A</div>
              {d.kind === "relay" ? (
                <div className="tcc-set">
                  <label>Curve<select className="num-input" value={d.settings.curve} onChange={(e) => setDev(d, { curve: e.target.value })}>{Object.keys(IEEE_CURVES).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
                  <label>Pickup A<NumField value={+d.settings.pickup.toFixed(1)} onCommit={(v) => setDev(d, { pickup: v })} /></label>
                  <label>Time dial<NumField value={d.settings.td} onCommit={(v) => setDev(d, { td: v })} /></label>
                  <label>50 inst A<NumField value={d.settings.inst_a ?? undefined} placeholder="off" onCommit={(v) => setDev(d, { inst_a: v ?? null })} /></label>
                </div>
              ) : (
                <div className="tcc-set">
                  <label>LT pickup ×<NumField value={d.settings.ltpu} onCommit={(v) => setDev(d, { ltpu: v })} /></label>
                  <label>LT delay s<NumField value={d.settings.ltd} onCommit={(v) => setDev(d, { ltd: v })} /></label>
                  <label>ST pickup ×Ir<NumField value={d.settings.stpu} onCommit={(v) => setDev(d, { stpu: v })} /></label>
                  <label>ST delay s<NumField value={d.settings.std} onCommit={(v) => setDev(d, { std: v })} /></label>
                  <label>Inst ×In<NumField value={d.settings.inst ?? undefined} placeholder="off" onCommit={(v) => setDev(d, { inst: v ?? null })} /></label>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <Section title="Selectivity" aside={<span className="text-faint text-[12px]">CTI 0.3 s relay–relay, 0.2 s relay–breaker (typical, IEEE 242); LV breakers selective when bands do not overlap</span>}>
        <div className="table-wrap"><table className="grid-table">
          <thead><tr><th>Downstream</th><th>Upstream</th><th className="r">Required<em>s</em></th><th className="r">Worst margin<em>s</em></th><th className="r">At<em>A</em></th><th>Result</th></tr></thead>
          <tbody>{coord.map((c) => (
            <tr key={c.down + c.up}><td className="font-mono">{c.down}</td><td className="font-mono">{c.up}</td><td className="r">{c.required_s}</td>
              <td className={cx("r", !c.ok && "text-crit")}>{c.worst_margin_s == null ? "—" : c.worst_margin_s.toFixed(3)}</td><td className="r">{c.at_a ? fmt(c.at_a, 0) : "—"}</td>
              <td>{c.ok ? <Pill tone="ok">Selective</Pill> : <Pill tone="crit">Overlap</Pill>}</td></tr>
          ))}</tbody>
        </table></div>
        <p className="text-faint text-[12px] mt-2">Breaker bands are generic LSIG shapes (±10 % current, typical clearing). Relays use IEEE C37.112 curves plus 5-cycle breaker time. Damage curves: cables ICEA P-32-382, transformers C57.109 thermal limit. Replace with the manufacturer's published curves before issuing a coordination study.</p>
      </Section>
    </div>
  );
}
