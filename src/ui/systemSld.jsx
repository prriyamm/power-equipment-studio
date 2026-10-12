/* Auto-generated single-line diagram of the System model (ANSI-style symbols),
   laid out top-down from the utility as a tree; loops draw as dashed ties. */
const { useMemo, useRef, useState, useEffect } = React;
import { EQUIPMENT, CONNECTORS, NODE_KINDS } from "../engine/system.js";
import { fmt, cx, Icon } from "./common.jsx";

const COL = 175, ROW = 150, BAR_PAD = 40;
const loadColor = (pct) => (pct == null ? "var(--wire)" : pct > 100 ? "var(--crit)" : pct > 80 ? "var(--high)" : "var(--ok)");
const vColor = (f) => (f === "low" ? "var(--low)" : f === "high" ? "var(--high)" : "var(--ok)");
const kvLabel = (kv) => (kv == null ? "" : kv < 1 ? `${Math.round(kv * 1000)} V` : `${kv} kV`);

function layoutSld(sys, analysis) {
  const c = analysis.compiled;
  const eq = c.eq;
  const nBus = c.busMeta.length;
  // branch list with element identity
  const edges = c.lfCase.branches.map((b, i) => ({ from: b.from, to: b.to, meta: c.branchMeta[i] }));
  const devicesAt = Array.from({ length: nBus + 1 }, () => []);
  for (const e of eq.values()) {
    if (["motor", "load", "capacitor", "generator", "utility"].includes(e.type)) devicesAt[c.busOf(`${e.id}.${EQUIPMENT[e.type].terminals[0]}`)].push(e);
  }
  const util = [...eq.values()].find((e) => e.type === "utility");
  const root = util ? c.busOf(`${util.id}.out`) : 1;
  // BFS tree
  const parent = new Array(nBus + 1).fill(0), via = new Array(nBus + 1).fill(null), depth = new Array(nBus + 1).fill(-1);
  const children = Array.from({ length: nBus + 1 }, () => []);
  depth[root] = 0; const q = [root]; const treeEdges = new Set();
  while (q.length) {
    const u = q.shift();
    edges.forEach((e, k) => {
      const v = e.from === u ? e.to : e.to === u ? e.from : null;
      if (v == null || depth[v] >= 0) return;
      depth[v] = depth[u] + 1; parent[v] = u; via[v] = e; children[u].push(v); treeEdges.add(k); q.push(v);
    });
  }
  // widths in columns
  const width = new Array(nBus + 1).fill(1);
  const leafDevs = (b) => devicesAt[b].filter((e) => e.type !== "utility");
  const measure = (b) => { const w = children[b].reduce((s, ch) => s + measure(ch), 0) + leafDevs(b).length; width[b] = Math.max(1, w); return width[b]; };
  measure(root);
  const pos = {};
  const place = (b, x0) => {
    pos[b] = { x0, x1: x0 + width[b] * COL, y: 110 + depth[b] * ROW };
    let x = x0;
    for (const ch of children[b]) { place(ch, x); x += width[ch] * COL; }
    pos[b].devX = []; for (const d of leafDevs(b)) { pos[b].devX.push({ e: d, x: x + COL / 2 }); x += COL; }
  };
  place(root, 0);
  const ties = edges.filter((_, k) => !treeEdges.has(k));
  return { root, pos, children, via, devicesAt, ties, width: width[root] * COL, maxDepth: Math.max(...depth), c };
}

function Breaker({ x, y, closed = true }) {
  return <rect x={x - 6} y={y - 6} width="12" height="12" className={cx("sld-brk", closed && "is-closed")} />;
}
function XfmrSym({ x, y }) {
  return <g className="sld-sym"><circle cx={x} cy={y - 9} r="12" /><circle cx={x} cy={y + 9} r="12" /></g>;
}
function MotorSym({ x, y }) {
  return <g className="sld-sym"><circle cx={x} cy={y} r="14" /><text x={x} y={y + 4.5} textAnchor="middle" className="sld-sym-text">M</text></g>;
}
function GenSym({ x, y }) {
  return <g className="sld-sym"><circle cx={x} cy={y} r="14" /><path d={`M${x - 8},${y} q4,-8 8,0 t8,0`} /></g>;
}
function LoadSym({ x, y }) {
  return <g className="sld-sym"><path d={`M${x - 9},${y - 6} L${x},${y + 8} L${x + 9},${y - 6} Z`} className="sld-fill" /></g>;
}
function CapSym({ x, y }) {
  return <g className="sld-sym"><path d={`M${x - 12},${y - 3} H${x + 12} M${x - 12},${y + 4} H${x + 12} M${x},${y + 4} V${y + 14} M${x - 7},${y + 14} H${x + 7} M${x - 4},${y + 18} H${x + 4}`} /></g>;
}
function UtilSym({ x, y }) {
  return <g className="sld-sym"><rect x={x - 16} y={y - 16} width="32" height="22" /><path d={`M${x - 16},${y - 16} L${x + 16},${y + 6} M${x + 16},${y - 16} L${x - 16},${y + 6}`} /></g>;
}

export function SystemSld({ sys, analysis, selection, setSelection, showTags }) {
  const wrapRef = useRef(null);
  const Lm = useMemo(() => (analysis?.compiled && !analysis.issues.some((i) => i.level === "error") ? layoutSld(sys, analysis) : null), [sys, analysis]);
  const [zoom, setZoom] = useState(1);
  const L = Lm;
  if (!L) return <div className="canvas-wrap grid place-items-center text-muted p-6">Fix the model errors to draw the one-line diagram.</div>;
  const { pos, children, via, devicesAt, root, c } = L;
  const ok = analysis.ok;
  const eqRes = analysis.equipment || {}, conRes = analysis.connectors || {};
  const W = L.width + 2 * BAR_PAD + 320, H = 90 + (L.maxDepth + 1) * ROW + 120;
  const sel = (kind, id) => selection?.kind === kind && selection.id === id;
  const busRes = (b) => (analysis.lf?.buses ? analysis.lf.buses[b - 1] : null);
  const sc = (b) => analysis.sc?.buses?.[b - 1];
  const out = [];

  const busLabel = (b) => {
    const meta = c.busMeta[b - 1];
    const node = meta.members.find((m) => NODE_KINDS.has(c.eq.get(m).type));
    return { node, name: node ? (c.eq.get(node).name || node) : meta.terms[0].replace(".", " "), kv: meta.kv };
  };

  // edges parent → child
  for (const [bStr, p] of Object.entries(pos)) {
    const b = Number(bStr);
    for (const ch of children[b]) {
      const e = via[ch]; const pc = pos[ch];
      const x = (pc.x0 + pc.x1) / 2 - (pc.x1 - pc.x0) / 2 + COL / 2 + BAR_PAD;
      const xs = Math.max(p.x0 + BAR_PAD, Math.min(p.x1 + BAR_PAD - 1, x));
      const y0 = p.y + 4, y1 = pc.y - 4, ym = (y0 + y1) / 2;
      const m = e.meta, isX = m.kind === "transformer";
      const r = isX ? eqRes[m.id] : conRes[m.id];
      const color = ok ? loadColor(r?.loading_pct) : "var(--wire)";
      const selected = sel(isX ? "eq" : "con", m.id);
      const pick = (ev) => { ev.stopPropagation(); setSelection({ kind: isX ? "eq" : "con", id: m.id }); };
      out.push(
        <g key={"e" + ch} className="sld-edge" onPointerDown={pick}>
          <path d={`M${xs},${y0} V${y1}`} className="sld-hit" />
          {selected && <path d={`M${xs},${y0} V${y1}`} className="sld-sel" />}
          <path d={`M${xs},${y0} V${y1}`} stroke={color} strokeWidth={ok && r ? 1.6 + Math.min(3, (r.loading_pct ?? 0) / 35) : 1.6} fill="none" />
          <Breaker x={xs} y={y0 + 16} />
          {isX ? <XfmrSym x={xs} y={ym} /> : <g><path d={`M${xs - 7},${ym - 4} l14,-6 M${xs - 7},${ym + 4} l14,-6`} className="sld-cable" /></g>}
          {showTags && (
            <g transform={`translate(${xs + 18},${ym - 16})`} pointerEvents="none">
              <text className="sld-tag-title">{m.id}</text>
              <text y="13" className="sld-tag">{isX ? `${fmt(c.eq.get(m.id).kva, 0)} kVA · ${c.eq.get(m.id).z_pct} %Z` : describeCon(sys, m.id)}</text>
              {ok && r && <text y="26" className="sld-tag" fill={color}>{isX ? `${fmt(r.s_kva, 0)} kVA · ${fmt(r.loading_pct, 0)} %` : `${fmt(r.i_a, 0)} A · ${r.loading_pct == null ? "—" : fmt(r.loading_pct, 0) + " %"} · VD ${fmt(r.vd_pct, 2)} %`}</text>}
            </g>
          )}
        </g>
      );
    }
  }
  // ties (loops)
  L.ties.forEach((e, i) => {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
    out.push(<path key={"tie" + i} d={`M${a.x1 + BAR_PAD - 10},${a.y} C${a.x1 + BAR_PAD + 60},${a.y} ${b.x1 + BAR_PAD + 60},${b.y} ${b.x1 + BAR_PAD - 10},${b.y}`} className="sld-tie" />);
  });
  // buses + devices
  for (const [bStr, p] of Object.entries(pos)) {
    const b = Number(bStr);
    const lab = busLabel(b), r = busRes(b), s = sc(b);
    const x0 = p.x0 + BAR_PAD, x1 = p.x1 + BAR_PAD;
    const nodeSel = lab.node && sel("eq", lab.node);
    const nr = lab.node ? eqRes[lab.node] : null;
    const pickBus = (ev) => { ev.stopPropagation(); if (lab.node) setSelection({ kind: "eq", id: lab.node }); };
    const hasUtil = devicesAt[b].some((e) => e.type === "utility");
    if (!lab.node && !hasUtil) {
      // terminal node (e.g. transformer LV throat): a dot, not a bus bar
      const xd = p.x0 + COL / 2 + BAR_PAD;
      out.push(
        <g key={"b" + b} className="sld-node">
          <circle cx={xd} cy={p.y} r="4.5" fill={ok && r ? vColor(r.vflag) : "var(--bar)"} />
          {showTags && ok && r && <text x={xd + 10} y={p.y + 4} className="sld-bus-res"><tspan fill={vColor(r.vflag)}>{r.v.toFixed(4)}</tspan>{s && <tspan className="dim"> · {fmt(s.ik_ka, 1)} kA</tspan>}</text>}
        </g>
      );
      p.devX.forEach((dv, i) => { if (i === 0) dv.x = p.x0 + COL / 2; });
    } else {
    const bw = Math.max(x1 - x0 - 24, 24);
    out.push(
      <g key={"b" + b} className="sld-bus" onPointerDown={pickBus}>
        {nodeSel && <rect x={x0 - 6} y={p.y - 8} width={bw + 12} height="16" rx="3" className="sld-sel-box" />}
        <rect x={x0} y={p.y - 4} width={bw} height="8" rx="1.5" fill={ok && r ? vColor(r.vflag) : "var(--bar)"} />
        <text x={x0} y={p.y - 26} className="sld-bus-name">{hasUtil && !lab.node ? "Service point" : lab.name} <tspan className="sld-bus-kv">{kvLabel(lab.kv)}</tspan>{lab.node && <tspan className="sld-bus-kv">  {c.eq.get(lab.node).bus_a} A · {c.eq.get(lab.node).sc_ka} kA</tspan>}</text>
        {showTags && ok && r && <text x={x0} y={p.y - 11} className="sld-bus-res"><tspan fill={vColor(r.vflag)}>{r.v.toFixed(4)} pu</tspan>{s && <tspan className="dim">  I″k {fmt(s.ik_ka, 1)} kA</tspan>}{nr?.sc_duty_pct != null && <tspan fill={nr.sc_duty_pct > 100 ? "var(--crit)" : nr.sc_duty_pct > 90 ? "var(--high)" : "var(--muted)"}>  ({fmt(nr.sc_duty_pct, 0)} % duty)</tspan>}{nr?.loading_pct != null && <tspan className="dim">  · {fmt(nr.loading_pct, 0)} % bus</tspan>}</text>}
      </g>
    );
    }
    // utility above the root
    for (const d of devicesAt[b].filter((e) => e.type === "utility")) {
      const x = x0 + 30;
      out.push(
        <g key={"u" + d.id} className="sld-dev" onPointerDown={(ev) => { ev.stopPropagation(); setSelection({ kind: "eq", id: d.id }); }}>
          <path d={`M${x},${p.y - 4} V${p.y - 44}`} stroke="var(--wire)" strokeWidth="1.6" />
          <UtilSym x={x} y={p.y - 56} />
          <text x={x + 26} y={p.y - 62} className="sld-tag-title">{d.name || d.id}</text>
          <text x={x + 26} y={p.y - 49} className="sld-tag">{d.mva_sc} MVA sc · X/R {d.xr}</text>
          {sel("eq", d.id) && <rect x={x - 22} y={p.y - 72} width="44" height="36" className="sld-sel-box" transform="translate(0,-4)" />}
        </g>
      );
    }
    p.devX.forEach(({ e: d, x: dx }) => {
      const x = dx + BAR_PAD, y0 = p.y + 4, y1 = p.y + 66;
      const rr = eqRes[d.id];
      const Sym = { motor: MotorSym, load: LoadSym, capacitor: CapSym, generator: GenSym }[d.type];
      out.push(
        <g key={"d" + d.id} className="sld-dev" onPointerDown={(ev) => { ev.stopPropagation(); setSelection({ kind: "eq", id: d.id }); }}>
          <path d={`M${x},${y0} V${y1 - 14}`} stroke="var(--wire)" strokeWidth="1.6" />
          <Breaker x={x} y={y0 + 16} />
          {sel("eq", d.id) && <circle cx={x} cy={y1} r="22" className="sld-sel-box" />}
          {Sym && <Sym x={x} y={y1} />}
          {showTags && <text x={x} y={y1 + 32} textAnchor="middle" className="sld-tag-title">{d.name || d.id}</text>}
          {showTags && ok && rr && <text x={x} y={y1 + 45} textAnchor="middle" className="sld-tag">{d.type === "capacitor" ? `${fmt(rr.q_kvar, 0)} kvar` : d.type === "generator" ? `${fmt(rr.p_kw, 0)} kW` : `${fmt(rr.p_kw, 0)} kW · ${fmt(rr.i_a, 0)} A`}</text>}
        </g>
      );
    });
  }
  return (
    <div ref={wrapRef} className="canvas-wrap sld-wrap" onPointerDown={() => setSelection(null)}>
      <div className="sld-scroll">
        <svg width={W * zoom} height={H * zoom} viewBox={`0 0 ${W} ${H}`} className="sld" role="img" aria-label="Single-line diagram">{out}</svg>
      </div>
      <div className="canvas-hud right">
        <button className="hud-btn" onClick={(ev) => { ev.stopPropagation(); setZoom((z) => Math.min(2.5, z * 1.2)); }} aria-label="Zoom in">+</button>
        <button className="hud-btn" onClick={(ev) => { ev.stopPropagation(); setZoom((z) => Math.max(0.4, z / 1.2)); }} aria-label="Zoom out">−</button>
        <button className="hud-btn" onClick={(ev) => { ev.stopPropagation(); setZoom(1); }} aria-label="Reset zoom"><Icon name="fit" size={14} /></button>
      </div>
    </div>
  );
}

function describeCon(sys, id) {
  const c = sys.connectors.find((x) => x.id === id); if (!c) return "";
  const f = { ...CONNECTORS[c.kind].defaults, ...c };
  return `${CONNECTORS[c.kind].label} ${f.sets}×${f.size} ${f.material}, ${f.length_ft} ft`;
}
