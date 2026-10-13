/* Switchgear lineup: to-scale front elevation with breaker cubicles assigned from the
   actual circuits, plus the breaker schedule. Opens from the System inspector. */
const { useMemo, useEffect } = React;
import { buildLineup } from "../engine/gear.js";
import { Btn, Pill, Icon, Tile, fmt, cx } from "./common.jsx";

const CSS = `
.gl-back { position: fixed; inset: 0; background: color-mix(in srgb, #000 64%, transparent); z-index: 50; display: grid; place-items: center; padding: 16px; }
.gl-modal { width: min(1180px, 100%); max-height: calc(100% - 16px); display: flex; flex-direction: column; overflow: hidden; }
.gl-body { overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.gl-body > * { flex-shrink: 0; }
.gl-elev-scroll { overflow-x: auto; max-width: 100%; }
.gl-elev { width: 100%; height: auto; display: block; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
@media (max-width: 640px) {
  .gl-back { padding: 0; }
  .gl-modal { height: 100%; max-height: 100%; border-radius: 0; border: 0; }
  .gl-elev { min-width: 620px; }
}
.gl-sec { fill: var(--eq-r); stroke: var(--eq-edge); stroke-width: 1.2; }
.gl-top { fill: var(--eq-l); stroke: var(--eq-edge); stroke-width: 1; }
.gl-door { fill: var(--door); stroke: var(--eq-edge); stroke-width: 1; }
.gl-door.is-spare { fill: var(--eq-l); }
.gl-door.is-fail { stroke: var(--crit); stroke-width: 2; }
.gl-brk { fill: #222b33; stroke: #11171c; stroke-width: 0.8; }
.gl-handle { fill: var(--brass); }
.gl-trip { fill: #0d2a1e; stroke: #1e5a40; stroke-width: 0.6; }
.gl-t1 { font-family: var(--font-ui); font-size: 3.3px; font-weight: 600; fill: var(--fg); }
.gl-t2 { font-family: var(--font-data); font-size: 2.6px; fill: var(--muted); }
.gl-t3 { font-family: var(--font-data); font-size: 2.3px; fill: #7fe0b0; }
.gl-dim { stroke: var(--faint); stroke-width: 0.35; fill: none; }
.gl-dimt { font-family: var(--font-data); font-size: 2.8px; fill: var(--muted); }
.gl-plate { fill: var(--panel-2); stroke: var(--line); stroke-width: 0.5; }
.gl-meter { fill: #0e151b; stroke: var(--info); stroke-width: 0.5; }
.gl-base { fill: #1a2128; }
`;

function Elevation({ L }) {
  const { sections, geometry: G, gear } = L;
  const H = G.h, top = gear.mv ? 22 : 18, cubH = (H - top - 4) / G.perSection;
  const pad = 14, W = G.width_in + pad * 2, VH = H + 40;
  let x = pad;
  const out = [];
  sections.forEach((s, si) => {
    const sx = x; x += s.width_in;
    out.push(<rect key={"s" + si} x={sx} y={20} width={s.width_in} height={H} className="gl-sec" />);
    out.push(<rect key={"t" + si} x={sx + 1} y={21} width={s.width_in - 2} height={top - 2} className="gl-top" />);
    if (s.main) [0.3, 0.7].forEach((f, k) => out.push(<g key={"m" + si + k}><circle cx={sx + s.width_in * f} cy={20 + top / 2} r={3.4} className="gl-meter" /><path d={`M${sx + s.width_in * f},${20 + top / 2} l2,-1.6`} stroke="var(--info)" strokeWidth="0.4" /></g>));
    out.push(<text key={"sn" + si} x={sx + 1.5} y={20 + top - 3} className="gl-t2">{`S${si + 1}${s.main ? " · MAIN" : ""}`}</text>);
    s.cubicles.forEach((c, ci) => {
      const cy = 20 + top + 1 + c.pos * cubH, ch = c.size * cubH - 2, cxp = sx + 1.5, cw = s.width_in - 3;
      const spare = c.kind === "spare";
      out.push(<rect key={`d${si}-${ci}`} x={cxp} y={cy} width={cw} height={ch} rx="0.6" className={cx("gl-door", spare && "is-spare", !spare && !c.ok && "is-fail")} />);
      if (spare) { out.push(<text key={`sp${si}-${ci}`} x={cxp + cw / 2} y={cy + ch / 2 + 1} textAnchor="middle" className="gl-t2">SPACE</text>); return; }
      const bw = cw * 0.55, bh = Math.min(ch * 0.42, 13), bx = cxp + cw - bw - 1.5, by = cy + ch * 0.4;
      out.push(<g key={`b${si}-${ci}`}>
        <rect x={bx} y={by} width={bw} height={bh} rx="0.5" className="gl-brk" />
        <rect x={bx + bw * 0.08} y={by + bh * 0.18} width={bw * 0.34} height={bh * 0.32} className="gl-trip" />
        <text x={bx + bw * 0.1} y={by + bh * 0.4} className="gl-t3">{c.open ? "OPEN" : `${fmt(c.load_a, 0)}A`}</text>
        <rect x={bx + bw * 0.62} y={by + bh * 0.2} width={bw * 0.28} height={bh * 0.12} rx="0.3" className="gl-handle" />
        <circle cx={bx + bw * 0.76} cy={by + bh * 0.7} r="1.1" fill={c.open ? "var(--ok)" : "var(--crit)"} />
      </g>);
      out.push(<text key={`l1${si}-${ci}`} x={cxp + 1.5} y={cy + 4.5} className="gl-t1">{c.tag}</text>);
      out.push(<text key={`l2${si}-${ci}`} x={cxp + 1.5} y={cy + 8} className="gl-t2">{`${c.frame ?? "—"}AF/${c.trip}${gear.mv ? "A PU" : "AT"}`}</text>);
      out.push(<text key={`l3${si}-${ci}`} x={cxp + 1.5} y={cy + 11.5} className="gl-t2">{`→ ${c.to}`.slice(0, Math.floor(cw / 1.6))}</text>);
    });
  });
  // base channel and dimensions
  out.push(<rect key="base" x={pad} y={20 + H} width={G.width_in} height="3" className="gl-base" />);
  out.push(<g key="dimw"><path d={`M${pad},${H + 30} H${pad + G.width_in} M${pad},${H + 27} v6 M${pad + G.width_in},${H + 27} v6`} className="gl-dim" /><text x={pad + G.width_in / 2} y={H + 36.5} textAnchor="middle" className="gl-dimt">{`${G.width_in}" (${(G.width_in / 12).toFixed(1)} ft) · ${sections.length} sections`}</text></g>);
  out.push(<g key="dimh"><path d={`M${pad - 6},20 V${20 + H} M${pad - 8},20 h4 M${pad - 8},${20 + H} h4`} className="gl-dim" /><text x={pad - 7} y={20 + H / 2} className="gl-dimt" transform={`rotate(-90 ${pad - 7} ${20 + H / 2})`} textAnchor="middle">{`${H}"`}</text></g>);
  out.push(<g key="plate"><rect x={pad} y="4" width={Math.min(110, G.width_in)} height="11" rx="1" className="gl-plate" /><text x={pad + 2} y="9" className="gl-t1">{gear.name}</text><text x={pad + 2} y="13" className="gl-t2">{`${gear.kv < 1 ? Math.round(gear.kv * 1000) + " V" : gear.kv + " kV"} · ${gear.bus_a} A bus · ${gear.sc_ka} kA`}</text></g>);
  return <svg viewBox={`0 0 ${W} ${VH}`} className="gl-elev" role="img" aria-label={`Front elevation of ${gear.name}`}>{out}</svg>;
}

export function GearLineupModal({ sys, analysis, gearId, onClose }) {
  const L = useMemo(() => buildLineup(sys, analysis, gearId), [sys, analysis, gearId]);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const r = L.result;
  return (
    <div className="gl-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <style>{CSS}</style>
      <div className="gl-modal panel" role="dialog" aria-label="Switchgear lineup">
        <header className="flex items-start justify-between gap-3 p-4 border-b border-line">
          <div>
            <div className="label">Lineup · front elevation</div>
            <div className="text-xl">{L.gear.name} <span className="text-muted font-mono text-[14px]">{L.gear.id}</span></div>
          </div>
          <div className="flex items-center gap-2"><Pill tone={L.ok ? "ok" : "crit"}>{L.ok ? "All checks pass" : "Check failures"}</Pill><button className="row-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        </header>
        <div className="gl-body">
          {r && !r.deenergized && (
            <div className="tiles">
              <Tile label="Bus loading" value={fmt(r.loading_pct, 0)} unit="%" sub={`${fmt(r.bus_i_a, 0)} A of ${L.gear.bus_a} A`} tone={r.loading_pct > 100 ? "crit" : r.loading_pct > 80 ? "warn" : "ok"} />
              <Tile label="Fault duty" value={fmt(r.sc_duty_pct, 0)} unit="%" sub={`I″k ${fmt(r.ik_ka, 1)} kA of ${L.gear.sc_ka} kA`} tone={r.sc_duty_pct > 100 ? "crit" : r.sc_duty_pct > 90 ? "warn" : "ok"} />
              <Tile label="Voltage" value={r.v_pu.toFixed(4)} unit="pu" sub={`${fmt(r.v_kv * (r.v_kv < 1 ? 1000 : 1), r.v_kv < 1 ? 0 : 3)} ${r.v_kv < 1 ? "V" : "kV"}`} />
              <Tile label="Footprint" value={`${L.geometry.width_in}"`} sub={`${L.geometry.sections} sections · ${L.geometry.h}" H × ${L.geometry.d}" D`} />
            </div>
          )}
          <div className="gl-elev-scroll"><Elevation L={L} /></div>
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Circuit</th><th>Role</th><th>To</th><th>Conductors</th><th className="r">Load<em>A</em></th><th className="r">Ampacity<em>A</em></th><th className="r">{L.gear.mv ? "Pickup" : "Trip"}<em>A</em></th><th className="r">Frame<em>A</em></th><th>Checks</th></tr></thead>
              <tbody>{L.circuits.map((c) => (
                <tr key={c.tag}>
                  <td className="font-mono">{c.tag}</td><td>{c.kind === "main" ? <Pill tone="accent">Main</Pill> : <Pill>Feeder</Pill>}{c.open && <Pill tone="ok">Open</Pill>}</td>
                  <td style={{ fontFamily: "var(--font-ui)" }}>{c.to}</td><td>{c.conductor}</td>
                  <td className="r">{fmt(c.load_a, 0)}</td><td className="r">{c.ampacity_a != null ? fmt(c.ampacity_a, 0) : "—"}</td><td className="r">{c.trip}</td><td className="r">{c.frame ?? "—"}</td>
                  <td style={{ whiteSpace: "normal", fontFamily: "var(--font-ui)", fontSize: 12 }}>{c.checks.length === 0 ? <span className="text-faint">—</span> : c.checks.map((k, i) => <div key={i} className={k.ok ? "text-ok" : "text-crit"}>{k.ok ? "✓" : "✗"} {k.name}</div>)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="text-faint text-[12px] flex flex-col gap-1">{L.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}
