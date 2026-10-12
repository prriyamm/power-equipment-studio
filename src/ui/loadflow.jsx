/* Load-flow workspace: one-line diagram, data tables, results, cases, verify. */
const { useState, useMemo, useEffect, useRef, useCallback } = React;
import * as LF from "../engine/loadflow.js";
import { bus } from "./bus.js";
import { StudiesTab } from "./lfstudies.jsx";
import { outageCase } from "../engine/contingency.js";
import { Btn, FLAG_COLOR, Field, Icon, NumField, Pill, Section, Tile, V_MIN, V_MAX, busType, clone, cx, fmt, freeSpot, isXfmr, makeScenario, newId, sgn, vflagOf } from "./common.jsx";

/* ================================================================ DIAGRAM */
function useGeometry(data, layout) {
  return useMemo(() => {
    const pos = {}; let fallback = 0;
    data.buses.forEach((b) => { pos[b.id] = layout[b.id] || [120 + 110 * fallback++, 650]; });
    const inc = {}; data.buses.forEach((b) => (inc[b.id] = []));
    data.branches.forEach((br, k) => { if (inc[br.from] && inc[br.to]) { inc[br.from].push({ k, other: br.to }); inc[br.to].push({ k, other: br.from }); } });
    const hw = {}, port = {};
    data.buses.forEach((b) => {
      const list = inc[b.id];
      hw[b.id] = Math.max(44, 13 * list.length + 26);
      const [x] = pos[b.id];
      list.sort((a, c) => pos[a.other][0] - pos[c.other][0] || a.k - c.k);
      list.forEach((e, j) => {
        const span = 1.2 * hw[b.id];
        port[e.k + ":" + b.id] = x - span / 2 + (span * (j + 0.5)) / list.length;
      });
    });
    const branches = data.branches.map((br, k) => {
      if (!pos[br.from] || !pos[br.to]) return null;
      const [ax, ay] = pos[br.from], [bx, by] = pos[br.to];
      const x1 = port[k + ":" + br.from], x2 = port[k + ":" + br.to];
      let d1 = by < ay ? -1 : 1, d2 = ay < by ? -1 : 1;
      if (Math.abs(ay - by) < 40) { d1 = -1; d2 = -1; }
      const s = 18;
      const pts = [[x1, ay], [x1, ay + d1 * s], [x2, by + d2 * s], [x2, by]];
      const mid = [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2];
      const ang = Math.atan2(pts[2][1] - pts[1][1], pts[2][0] - pts[1][0]);
      return { k, pts, mid, ang, path: "M" + pts.map((p) => p.join(",")).join("L") };
    });
    return { pos, hw, branches };
  }, [data, layout]);
}

function GenSymbol({ x, y }) {
  return (
    <g className="sym">
      <path d={`M${x},${y} V${y - 14}`} />
      <circle cx={x} cy={y - 25} r="11" />
      <path d={`M${x - 6},${y - 25} q3,-6 6,0 t6,0`} />
    </g>
  );
}
function LoadSymbol({ x, y }) {
  return (
    <g className="sym">
      <path d={`M${x},${y} V${y + 20}`} />
      <path d={`M${x - 5},${y + 15} L${x},${y + 23} L${x + 5},${y + 15} Z`} className="sym-fill" />
    </g>
  );
}
function ShuntSymbol({ x, y }) {
  return (
    <g className="sym">
      <path d={`M${x},${y} V${y + 13} M${x - 8},${y + 13} H${x + 8} M${x - 8},${y + 18} H${x + 8} M${x},${y + 18} V${y + 24}`} />
      <path d={`M${x - 5},${y + 24} H${x + 5} M${x - 3},${y + 27} H${x + 3}`} />
    </g>
  );
}

function Diagram({ scenario, result, stale, selection, setSelection, tool, setTool, onMoveBus, onAddBus, onAddBranch, animate, fitSignal }) {
  const { data, layout } = scenario;
  const geo = useGeometry(data, layout);
  const svgRef = useRef(null), wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, w: 1000 });
  const drag = useRef(null);
  const [pending, setPending] = useState(null); // first bus in connect mode
  const [hoverPt, setHoverPt] = useState(null);

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const vh = view.w * (size.h / size.w);

  const fit = useCallback(() => {
    const pts = Object.values(geo.pos); if (!pts.length) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - 120, x1 = Math.max(...xs) + 120, y0 = Math.min(...ys) - 90, y1 = Math.max(...ys) + 90;
    const asp = size.h / size.w;
    let w = x1 - x0, h = y1 - y0;
    if (h / w > asp) w = h / asp;
    setView({ x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - (w * asp) / 2, w });
  }, [geo.pos, size]);
  useEffect(() => { fit(); }, [fitSignal, scenario.id, size.w > 0 && size.h > 0 ? Math.round(size.w / 50) + ":" + Math.round(size.h / 50) : 0]); // eslint-disable-line

  const toWorld = (e) => {
    const svg = svgRef.current, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  };

  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const onWheel = (e) => {
      e.preventDefault();
      const [wx, wy] = toWorld(e);
      const f = Math.exp(e.deltaY * 0.0015);
      setView((v) => {
        const w = Math.min(4000, Math.max(250, v.w * f)), r = w / v.w;
        return { x: wx - (wx - v.x) * r, y: wy - (wy - v.y) * r, w };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => { if (tool !== "connect") setPending(null); }, [tool]);

  const onBusDown = (e, id) => {
    e.stopPropagation();
    if (tool === "connect") {
      if (pending == null) setPending(id);
      else if (pending !== id) { onAddBranch(pending, id); setPending(null); }
      return;
    }
    setSelection({ kind: "bus", id });
    const [wx, wy] = toWorld(e);
    drag.current = { mode: "bus", id, sx: wx, sy: wy, ox: geo.pos[id][0], oy: geo.pos[id][1], moved: false };
    svgRef.current.setPointerCapture(e.pointerId);
  };
  const onBgDown = (e) => {
    if (tool === "bus") { const [wx, wy] = toWorld(e); onAddBus([Math.round(wx / 10) * 10, Math.round(wy / 10) * 10]); return; }
    drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    svgRef.current.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (tool === "connect" && pending != null) setHoverPt(toWorld(e));
    const d = drag.current; if (!d) return;
    if (d.mode === "bus") {
      const [wx, wy] = toWorld(e);
      const nx = Math.round((d.ox + wx - d.sx) / 10) * 10, ny = Math.round((d.oy + wy - d.sy) / 10) * 10;
      if (Math.abs(wx - d.sx) + Math.abs(wy - d.sy) > 3) d.moved = true;
      if (d.moved) onMoveBus(d.id, [nx, ny]);
    } else {
      const s = view.w / size.w;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.ox - (e.clientX - d.sx) * s, y: d.oy - (e.clientY - d.sy) * s }));
    }
  };
  const onUp = () => {
    const d = drag.current; drag.current = null;
    if (d && d.mode === "pan" && !d.moved && tool === "select") setSelection(null);
  };

  const rb = result && result.buses ? Object.fromEntries(result.buses.map((b) => [b.id, b])) : {};
  const rbr = result && result.branches ? result.branches : [];
  const maxP = Math.max(1, ...rbr.map((b) => Math.abs(b.p_from_mw)));
  const zoomBy = (f) => setView((v) => { const w = Math.min(4000, Math.max(250, v.w * f)); const cxp = v.x + v.w / 2, cyp = v.y + (v.w * size.h / size.w) / 2; return { x: cxp - w / 2, y: cyp - (w * size.h / size.w) / 2, w }; });

  return (
    <div ref={wrapRef} className={cx("canvas-wrap", `tool-${tool}`)}>
      <svg ref={svgRef} className="canvas" viewBox={`${view.x} ${view.y} ${view.w} ${vh}`}
        onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        role="img" aria-label="One-line diagram">
        <defs>
          <pattern id="g-minor" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="var(--grid)" strokeWidth="0.6" /></pattern>
          <pattern id="g-major" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#g-minor)" /><path d="M100 0H0V100" fill="none" stroke="var(--grid-major)" strokeWidth="0.9" /></pattern>
        </defs>
        <rect x={view.x - 10} y={view.y - 10} width={view.w + 20} height={vh + 20} fill="url(#g-major)" />

        {/* branches */}
        {geo.branches.map((g, k) => {
          if (!g) return null;
          const br = data.branches[k], r = rbr[k];
          const sel = selection?.kind === "branch" && selection.k === k;
          const p = r ? r.p_from_mw : 0;
          const load = r && r.loading_pct != null ? r.loading_pct : null;
          const color = load != null ? (load > 100 ? "var(--crit)" : load > 80 ? "var(--high)" : "var(--wire)") : "var(--wire)";
          const w = r ? 1.6 + 3 * Math.min(1, Math.abs(p) / maxP) : 1.6;
          const rev = p < 0;
          const flowPath = rev ? "M" + [...g.pts].reverse().map((q) => q.join(",")).join("L") : g.path;
          const lab = r ? `${fmt(Math.abs(p), 1)} MW` : null;
          const fa = rev ? g.ang + Math.PI : g.ang;
          return (
            <g key={k} className="branch" onPointerDown={(e) => { e.stopPropagation(); if (tool === "select") setSelection({ kind: "branch", k }); }}>
              <path d={g.path} className="hit" />
              {sel && <path d={g.path} className="sel-halo" />}
              <path d={g.path} fill="none" stroke={color} strokeWidth={w} strokeLinejoin="round" opacity={stale ? 0.55 : 1} />
              {r && animate && !stale && Math.abs(p) > 0.05 && <path d={flowPath} className="flow" style={{ animationDuration: `${Math.max(0.5, 2.6 - 2 * Math.abs(p) / maxP)}s` }} />}
              {isXfmr(br) && (
                <g transform={`translate(${g.mid[0]},${g.mid[1]}) rotate(${(g.ang * 180) / Math.PI})`}>
                  <circle cx="-5" cy="0" r="7.5" className="xf" /><circle cx="5" cy="0" r="7.5" className="xf" />
                </g>
              )}
              {r && !stale && (
                <g transform={`translate(${g.mid[0]},${g.mid[1]})`}>
                  <g transform={`rotate(${(fa * 180) / Math.PI}) translate(${isXfmr(br) ? 20 : 0},0)`}><path d="M-5,-4.5 L5,0 L-5,4.5 Z" fill={color} /></g>
                  <text x="0" y={isXfmr(br) ? -14 : -9} className="flow-label" textAnchor="middle">{lab}</text>
                </g>
              )}
            </g>
          );
        })}

        {/* pending connection rubber band */}
        {tool === "connect" && pending != null && hoverPt && geo.pos[pending] && (
          <path d={`M${geo.pos[pending][0]},${geo.pos[pending][1]} L${hoverPt[0]},${hoverPt[1]}`} className="rubber" />
        )}

        {/* buses */}
        {data.buses.map((b) => {
          const [x, y] = geo.pos[b.id], hw = geo.hw[b.id], t = busType(b), r = rb[b.id];
          const sel = selection?.kind === "bus" && selection.id === b.id;
          const barColor = r && !stale ? FLAG_COLOR[r.vflag] : "var(--bar)";
          const hasGen = t !== "PQ" || (b.p_gen ?? 0) !== 0 || (b.q_gen ?? 0) !== 0;
          const hasLoad = (b.p_load ?? 0) !== 0 || (b.q_load ?? 0) !== 0;
          const hasShunt = (b.shunt_b ?? 0) !== 0 || (b.shunt_g ?? 0) !== 0;
          return (
            <g key={b.id} className={cx("bus", pending === b.id && "is-pending")} onPointerDown={(e) => onBusDown(e, b.id)}>
              <rect x={x - hw - 6} y={y - 40} width={2 * hw + 12} height={80} className="hit" />
              {hasGen && <GenSymbol x={x - hw * 0.86} y={y} />}
              {hasLoad && <LoadSymbol x={x + hw * 0.86} y={y} />}
              {hasShunt && <ShuntSymbol x={x - hw * 0.86} y={y} />}
              {sel && <rect x={x - hw - 4} y={y - 7} width={2 * hw + 8} height={14} rx="3" className="sel-box" />}
              <rect x={x - hw} y={y - 3.5} width={2 * hw} height={7} rx="1.5" fill={barColor} />
              <text x={x + hw + 8} y={y + 4.5} className="bus-label">
                <tspan className="bus-kind">{t === "slack" ? "SL" : t} </tspan>{b.id}
              </text>
              {r?.switched && !stale && (
                <g transform={`translate(${x + hw - 2},${y - 24})`}><rect x="-52" y="-9" width="54" height="15" rx="7.5" fill="var(--panel)" stroke="var(--high)" strokeWidth="1" /><text x="-25" y="2" textAnchor="middle" fill="var(--high)" style={{ fontSize: 9.5, fontFamily: "var(--font-data)" }}>PQ@limit</text></g>
              )}
              {r && !stale && (
                <text x={x - hw - 8} y={y - 1} textAnchor="end" className="bus-res">
                  <tspan fill={FLAG_COLOR[r.vflag]}>{r.v.toFixed(4)}</tspan>
                  <tspan x={x - hw - 8} dy="12" className="dim">{r.angle_deg.toFixed(2)}°</tspan>
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="canvas-hud left">
        {tool === "bus" && <span>Click the canvas to place a bus. <kbd>Esc</kbd> to stop.</span>}
        {tool === "connect" && <span>{pending == null ? "Click the from-bus." : `From bus ${pending}. Click the to-bus.`} <kbd>Esc</kbd> to stop.</span>}
        {tool === "select" && <span className="hidden sm:inline">Drag buses to move. Drag the grid to pan, scroll to zoom.</span>}
      </div>
      <div className="canvas-hud right">
        <button className="hud-btn" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom in">+</button>
        <button className="hud-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom out">−</button>
        <button className="hud-btn" onClick={fit} aria-label="Fit to view"><Icon name="fit" size={14} /></button>
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--low)" }} />&lt; 0.95</span>
        <span><i style={{ background: "var(--ok)" }} />0.95–1.05</span>
        <span><i style={{ background: "var(--high)" }} />&gt; 1.05 pu</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- inspector */
function BusInspector({ bus, index, data, result, stale, issues, update, renameBus, deleteBus }) {
  const t = busType(bus);
  const r = result?.buses?.find((x) => x.id === bus.id);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [bus.id]);
  const iss = (f) => issues.find((x) => x.kind === "bus" && x.index === index && x.field === f)?.msg;
  const set = (f) => (v) => update((d) => { const b = d.buses[index]; if (v === undefined) delete b[f]; else b[f] = v; });
  const nConn = data.branches.filter((br) => br.from === bus.id || br.to === bus.id).length;
  const F = (f, label, unit, ph, dis, hint) => (
    <Field label={label} unit={unit} hint={hint}><NumField id={`bus-${f}`} value={bus[f]} onCommit={set(f)} placeholder={ph} invalid={iss(f)} disabled={dis} /></Field>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div><div className="label">Bus</div><div className="text-xl font-mono">{bus.id}</div></div>
        <Pill tone={t === "slack" ? "accent" : t === "PV" ? "info" : "muted"}>{t === "slack" ? "Slack" : t}</Pill>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bus id"><NumField id="bus-id" value={bus.id} onCommit={(v) => renameBus(bus.id, v)} invalid={iss("id")} /></Field>
        <Field label="Type">
          <select id="bus-type" className="num-input" value={t} onChange={(e) => update((d) => { d.buses[index].type = e.target.value; })}>
            <option value="slack">slack</option><option value="PV">PV</option><option value="PQ">PQ</option>
          </select>
        </Field>
        {F("v", t === "PQ" ? "V start" : "V set", "pu", "1.0", false, t === "PQ" ? "Initial guess only" : null)}
        {F("angle", t === "slack" ? "Angle" : "Angle start", "deg", "0.0")}
        {F("p_gen", "P gen", "MW", "0", t === "slack", t === "slack" ? "Slack balances P" : null)}
        {F("q_gen", "Q gen", "Mvar", "0", t !== "PQ", t !== "PQ" ? "Solved by V control" : null)}
        {F("p_load", "P load", "MW", "0")}
        {F("q_load", "Q load", "Mvar", "0")}
        {F("shunt_g", "Shunt G", "pu", "0")}
        {F("shunt_b", "Shunt B", "pu", "0", false, "+ capacitive")}
        {t !== "PQ" && F("q_min", "Q min", "Mvar", "none")}
        {t !== "PQ" && F("q_max", "Q max", "Mvar", "none")}
      </div>
      {r && (
        <div className={cx("res-block", stale && "is-stale")}>
          <div className="label mb-2">Result{stale && " · stale"}</div>
          <dl className="kv">
            <dt>V</dt><dd style={{ color: FLAG_COLOR[r.vflag] }}>{r.v.toFixed(5)} pu</dd>
            <dt>Angle</dt><dd>{r.angle_deg.toFixed(4)}°</dd>
            <dt>P inj</dt><dd>{fmt(r.p_mw, 2)} MW</dd>
            <dt>Q inj</dt><dd>{fmt(r.q_mvar, 2)} Mvar</dd>
            <dt>P gen</dt><dd>{fmt(r.p_gen_mw, 2)} MW</dd>
            <dt>Q gen</dt><dd className={r.qflag ? "text-crit" : ""}>{fmt(r.q_gen_mvar, 2)} Mvar{r.qflag && ` (${r.qflag === "qmax" ? "above Q max" : "below Q min"})`}</dd>
          </dl>
        </div>
      )}
      <div className="flex gap-2 items-center">
        {!confirm ? <Btn kind="danger" onClick={() => setConfirm(true)}><Icon name="trash" size={14} />Delete bus</Btn> : (
          <>
            <Btn kind="danger-solid" onClick={() => deleteBus(bus.id)}>Delete bus{nConn ? ` and ${nConn} branch${nConn > 1 ? "es" : ""}` : ""}</Btn>
            <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
          </>
        )}
      </div>
    </div>
  );
}

function BranchInspector({ br, k, data, result, stale, issues, update, deleteBranch }) {
  const r = result?.branches?.[k];
  const iss = (f) => issues.find((x) => x.kind === "branch" && x.index === k && x.field === f)?.msg;
  const set = (f) => (v) => update((d) => { const b = d.branches[k]; if (v === undefined) delete b[f]; else b[f] = v; });
  const ids = data.buses.map((b) => b.id);
  const F = (f, label, unit, ph, hint) => (
    <Field label={label} unit={unit} hint={hint}><NumField id={`br-${f}`} value={br[f]} onCommit={set(f)} placeholder={ph} invalid={iss(f)} /></Field>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div><div className="label">{isXfmr(br) ? "Transformer" : "Line"}</div><div className="text-xl font-mono">{br.from} → {br.to}</div></div>
        <Pill tone={isXfmr(br) ? "info" : "muted"}>#{k + 1}</Pill>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From bus">
          <select id="br-from" className="num-input" value={br.from} onChange={(e) => update((d) => { d.branches[k].from = Number(e.target.value); })}>
            {ids.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
        <Field label="To bus">
          <select id="br-to" className="num-input" value={br.to} onChange={(e) => update((d) => { d.branches[k].to = Number(e.target.value); })}>
            {ids.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
        {F("r", "R", "pu", "0")}
        {F("x", "X", "pu", "0")}
        {F("b", "B total", "pu", "0", "Split b/2 per end")}
        {F("tap", "Tap", "pu", "1.0", "From-side ratio")}
        {F("shift", "Shift", "deg", "0")}
        {F("rate_a", "Rating", "MVA", "none")}
      </div>
      {r && (
        <div className={cx("res-block", stale && "is-stale")}>
          <div className="label mb-2">Result{stale && " · stale"}</div>
          <dl className="kv">
            <dt>From end</dt><dd>{fmt(r.p_from_mw, 2)} MW, {fmt(r.q_from_mvar, 2)} Mvar</dd>
            <dt>To end</dt><dd>{fmt(r.p_to_mw, 2)} MW, {fmt(r.q_to_mvar, 2)} Mvar</dd>
            <dt>Loss</dt><dd>{fmt(r.p_loss_mw, 3)} MW, {fmt(r.q_loss_mvar, 3)} Mvar</dd>
            <dt>|I| from</dt><dd>{fmt(r.i_from_pu, 4)} pu</dd>
            <dt>Loading</dt><dd className={r.loading_pct > 100 ? "text-crit" : ""}>{r.loading_pct == null ? "No rating set" : fmt(r.loading_pct, 1) + " %"}</dd>
          </dl>
        </div>
      )}
      <div><Btn kind="danger" onClick={() => deleteBranch(k)}><Icon name="trash" size={14} />Delete branch</Btn></div>
    </div>
  );
}

function CaseSummary({ scenario, result, issues }) {
  const d = scenario.data;
  const nX = d.branches.filter(isXfmr).length;
  const err = issues.filter((x) => x.level === "error");
  return (
    <div className="flex flex-col gap-4">
      <div><div className="label">Network</div><div className="text-lg">{scenario.name}</div></div>
      <dl className="kv">
        <dt>Base</dt><dd>{d.base_mva} MVA</dd>
        <dt>Buses</dt><dd>{d.buses.length} ({d.buses.filter((b) => busType(b) === "PV").length} PV, {d.buses.filter((b) => busType(b) === "PQ").length} PQ)</dd>
        <dt>Branches</dt><dd>{d.branches.length - nX} lines, {nX} transformers</dd>
        <dt>Load</dt><dd>{fmt(d.buses.reduce((a, b) => a + (b.p_load ?? 0), 0), 1)} MW</dd>
        {result?.converged && <><dt>Losses</dt><dd>{fmt(result.total_p_loss_mw, 3)} MW</dd></>}
      </dl>
      {err.length > 0 && <div className="notice notice-crit">{err.length} error{err.length > 1 ? "s" : ""}: {err[0].msg}</div>}
      <p className="text-muted text-[13px] leading-relaxed">Select a bus or branch to edit it. Use the toolbar to place buses and draw connections. Every edit re-solves when Live solve is on.</p>
    </div>
  );
}

function DiagramTab(p) {
  const { scenario, result, stale, selection, setSelection, tool, setTool, issues, update } = p;
  const [fitSignal, setFitSignal] = useState(0);
  const [animate, setAnimate] = useState(true);
  const sel = selection;
  const busIdx = sel?.kind === "bus" ? scenario.data.buses.findIndex((b) => b.id === sel.id) : -1;
  const brOk = sel?.kind === "branch" && scenario.data.branches[sel.k];
  return (
    <div className="diagram-grid">
      <div className="flex flex-col min-w-0 min-h-0 gap-2">
        <div className="toolbar">
          <div className="seg">
            <Btn active={tool === "select"} onClick={() => setTool("select")} title="Select and move (V)"><Icon name="select" size={14} />Select</Btn>
            <Btn active={tool === "bus"} onClick={() => setTool("bus")} title="Place bus (B)"><Icon name="bus" size={14} />Add bus</Btn>
            <Btn active={tool === "connect"} onClick={() => setTool("connect")} title="Connect two buses (C)"><Icon name="connect" size={14} />Connect</Btn>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Btn onClick={() => { p.relayout(); setFitSignal((x) => x + 1); }} title="Force-directed auto-layout"><Icon name="layout" size={14} />Auto-layout</Btn>
            <Btn onClick={() => setFitSignal((x) => x + 1)}><Icon name="fit" size={14} />Fit</Btn>
            <Btn active={animate} onClick={() => setAnimate(!animate)} title="Animate power flow direction"><Icon name="play" size={13} />Flow</Btn>
            <Btn kind="danger" disabled={!sel} onClick={p.deleteSelection} title="Delete selection (Del)"><Icon name="trash" size={14} />Delete</Btn>
          </div>
        </div>
        <Diagram {...p} animate={animate} fitSignal={fitSignal} />
      </div>
      <aside className="panel inspector">
        {busIdx >= 0 ? <BusInspector bus={scenario.data.buses[busIdx]} index={busIdx} data={scenario.data} result={result} stale={stale} issues={issues} update={update} renameBus={p.renameBus} deleteBus={p.deleteBus} />
          : brOk ? <BranchInspector br={scenario.data.branches[sel.k]} k={sel.k} data={scenario.data} result={result} stale={stale} issues={issues} update={update} deleteBranch={p.deleteBranch} />
          : <CaseSummary scenario={scenario} result={result} issues={issues} />}
      </aside>
    </div>
  );
}

/* ================================================================== DATA */
const BUS_COLS = [
  ["id", "Bus", ""], ["type", "Type", ""], ["v", "V", "pu"], ["angle", "Angle", "deg"], ["p_gen", "P gen", "MW"], ["q_gen", "Q gen", "Mvar"],
  ["p_load", "P load", "MW"], ["q_load", "Q load", "Mvar"], ["shunt_g", "G sh", "pu"], ["shunt_b", "B sh", "pu"], ["q_min", "Q min", "Mvar"], ["q_max", "Q max", "Mvar"],
];
const BR_COLS = [["from", "From", ""], ["to", "To", ""], ["r", "R", "pu"], ["x", "X", "pu"], ["b", "B", "pu"], ["tap", "Tap", "pu"], ["shift", "Shift", "deg"], ["rate_a", "Rating", "MVA"]];
const DEFAULT_PH = { v: "1.0", angle: "0", tap: "1.0", shift: "0", q_min: "—", q_max: "—", rate_a: "—" };

function DataTab({ scenario, issues, update, renameBus, addBus, addBranchRow, deleteBus, deleteBranch, setSelection, setTab }) {
  const d = scenario.data;
  const issueAt = (kind, i, f) => issues.find((x) => x.kind === kind && x.index === i && x.field === f)?.msg;
  const errs = issues.filter((x) => x.level === "error"), warns = issues.filter((x) => x.level === "warn");
  const ids = d.buses.map((b) => b.id);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {errs.length === 0 && warns.length === 0 && <Pill tone="ok">Case valid</Pill>}
        {errs.length > 0 && <Pill tone="crit">{errs.length} error{errs.length > 1 && "s"}</Pill>}
        {warns.length > 0 && <Pill tone="warn">{warns.length} warning{warns.length > 1 && "s"}</Pill>}
        <span className="text-muted text-[13px]">Blank cells use the default shown in grey and are left out of the exported JSON.</span>
        <label className="ml-auto flex items-center gap-2 text-[13px]"><span className="text-muted">Base MVA</span>
          <NumField id="base-mva" className="w-24" value={d.base_mva} onCommit={(v) => update((x) => { x.base_mva = v ?? 100; })} /></label>
      </div>
      {(errs.length > 0 || warns.length > 0) && (
        <ul className="issue-list">
          {[...errs, ...warns].map((x, i) => (
            <li key={i} className={x.level === "error" ? "text-crit" : "text-warn"}>
              <b>{x.kind === "case" ? "Case" : x.kind === "bus" ? `Bus row ${x.index + 1}` : `Branch row ${x.index + 1}`}</b>{x.field ? ` · ${x.field}` : ""}: {x.msg}
            </li>
          ))}
        </ul>
      )}

      <Section title={`Buses · ${d.buses.length}`} aside={<Btn kind="primary-soft" onClick={addBus}><Icon name="plus" size={14} />Add bus</Btn>}>
        <div className="table-wrap">
          <table className="grid-table edit">
            <thead><tr>{BUS_COLS.map(([k, l, u]) => <th key={k}>{l}{u && <em>{u}</em>}</th>)}<th /></tr></thead>
            <tbody>
              {d.buses.map((b, i) => (
                <tr key={i}>
                  {BUS_COLS.map(([k]) => (
                    <td key={k}>
                      {k === "type" ? (
                        <select className="num-input" value={busType(b)} onChange={(e) => update((x) => { x.buses[i].type = e.target.value; })} aria-label={`Bus ${b.id} type`}>
                          <option value="slack">slack</option><option value="PV">PV</option><option value="PQ">PQ</option>
                        </select>
                      ) : k === "id" ? (
                        <NumField value={b.id} onCommit={(v) => renameBus(b.id, v)} invalid={issueAt("bus", i, "id")} className="w-14" />
                      ) : (
                        <NumField value={b[k]} placeholder={DEFAULT_PH[k] ?? "0"} invalid={issueAt("bus", i, k)}
                          onCommit={(v) => update((x) => { if (v === undefined) delete x.buses[i][k]; else x.buses[i][k] = v; })} />
                      )}
                    </td>
                  ))}
                  <td className="w-8"><button className="row-x" onClick={() => deleteBus(b.id)} aria-label={`Delete bus ${b.id}`}><Icon name="x" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Branches · ${d.branches.length}`} aside={<Btn kind="primary-soft" onClick={addBranchRow} disabled={d.buses.length < 2}><Icon name="plus" size={14} />Add branch</Btn>}>
        <div className="table-wrap">
          <table className="grid-table edit">
            <thead><tr><th>#</th>{BR_COLS.map(([k, l, u]) => <th key={k}>{l}{u && <em>{u}</em>}</th>)}<th /></tr></thead>
            <tbody>
              {d.branches.map((br, i) => (
                <tr key={i}>
                  <td className="text-faint font-mono">{i + 1}</td>
                  {BR_COLS.map(([k]) => (
                    <td key={k}>
                      {k === "from" || k === "to" ? (
                        <select className={cx("num-input", issueAt("branch", i, k) && "is-bad")} value={ids.includes(br[k]) ? br[k] : ""} title={issueAt("branch", i, k)}
                          onChange={(e) => update((x) => { x.branches[i][k] = Number(e.target.value); })} aria-label={`Branch ${i + 1} ${k}`}>
                          {!ids.includes(br[k]) && <option value="">{String(br[k])}?</option>}
                          {ids.map((id) => <option key={id} value={id}>{id}</option>)}
                        </select>
                      ) : (
                        <NumField value={br[k]} placeholder={DEFAULT_PH[k] ?? "0"} invalid={issueAt("branch", i, k)}
                          onCommit={(v) => update((x) => { if (v === undefined) delete x.branches[i][k]; else x.branches[i][k] = v; })} />
                      )}
                    </td>
                  ))}
                  <td className="w-8"><button className="row-x" onClick={() => deleteBranch(i)} aria-label={`Delete branch ${i + 1}`}><Icon name="x" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

/* ================================================================ CHARTS */
function VoltageChart({ series, height = 220 }) {
  const W = 760, H = height, L = 44, R = 12, T = 14, B = 28;
  const all = series.flatMap((s) => s.values.map((v) => v.v));
  const lo = Math.min(0.9, Math.floor(Math.min(...all) * 40) / 40), hi = Math.max(1.1, Math.ceil(Math.max(...all) * 40) / 40);
  const ids = series[0].values.map((v) => v.id);
  const n = ids.length, band = (W - L - R) / n, gw = band * 0.72, bw = gw / series.length;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ticks = []; for (let t = Math.ceil(lo * 20) / 20; t <= hi + 1e-9; t += 0.05) ticks.push(+t.toFixed(2));
  const base = y(lo);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Bus voltage profile">
      <rect x={L} y={y(V_MAX)} width={W - L - R} height={y(V_MIN) - y(V_MAX)} className="band" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === V_MIN || t === V_MAX ? "limit" : "gridline"} />
          <text x={L - 6} y={y(t) + 3.5} textAnchor="end" className="tick">{t.toFixed(2)}</text>
        </g>
      ))}
      {ids.map((id, i) => (
        <g key={id}>
          {series.map((s, j) => {
            const v = s.values[i]?.v; if (v == null) return null;
            const x = L + band * i + (band - gw) / 2 + bw * j;
            const fill = series.length === 1 ? FLAG_COLOR[vflagOf(v)] : s.color;
            return <rect key={j} x={x} y={Math.min(y(v), base)} width={Math.max(bw - 1.5, 1)} height={Math.abs(base - y(v))} fill={fill} rx="1.5"><title>{`Bus ${id}${series.length > 1 ? ` (${s.name})` : ""}: ${v.toFixed(4)} pu`}</title></rect>;
          })}
          <text x={L + band * i + band / 2} y={H - 10} textAnchor="middle" className="tick">{id}</text>
        </g>
      ))}
      <text x={L} y={H - 0} className="tick" dy="-1">bus</text>
    </svg>
  );
}

function ConvergenceChart({ history, tol = 1e-8 }) {
  const W = 300, H = 220, L = 38, R = 10, T = 14, B = 28;
  const lg = history.map((m) => Math.log10(Math.max(m, 1e-16)));
  const top = Math.max(1, Math.ceil(Math.max(...lg))), bot = -16;
  const n = Math.max(history.length - 1, 1);
  const x = (i) => L + ((W - L - R) * i) / n, y = (v) => T + ((H - T - B) * (top - v)) / (top - bot);
  const ticks = []; for (let t = top; t >= bot; t -= 4) ticks.push(t);
  const d = lg.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Newton-Raphson convergence">
      {ticks.map((t) => (<g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="gridline" /><text x={L - 5} y={y(t) + 3.5} textAnchor="end" className="tick">1e{t}</text></g>))}
      <line x1={L} x2={W - R} y1={y(Math.log10(tol))} y2={y(Math.log10(tol))} className="limit" />
      <text x={W - R} y={y(Math.log10(tol)) - 4} textAnchor="end" className="tick accent">tol 1e-8</text>
      <path d={`${d}L${x(lg.length - 1)},${y(bot)}L${x(0)},${y(bot)}Z`} className="area" />
      <path d={d} className="line" />
      {lg.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === lg.length - 1 ? 3.5 : 2.2} className={i === lg.length - 1 ? "pt-end" : "pt"}><title>{`iter ${i}: ${history[i].toExponential(2)} pu`}</title></circle>)}
      {lg.map((_, i) => <text key={"t" + i} x={x(i)} y={H - 10} textAnchor="middle" className="tick">{i}</text>)}
    </svg>
  );
}

/* =============================================================== RESULTS */
function ResultsTab({ scenario, result, stale, solve, issues, saveFile, copyText, onSelectBus }) {
  if (!result) {
    return (
      <div className="p-6"><div className="panel p-8 text-center flex flex-col items-center gap-3">
        <div className="text-lg">No results yet</div>
        <p className="text-muted">Solve the active network to see bus voltages, branch flows and losses.</p>
        <Btn kind="primary" onClick={solve}><Icon name="bolt" size={15} />Solve load flow</Btn>
      </div></div>
    );
  }
  if (!result.buses) {
    return (
      <div className="p-6"><div className="notice notice-crit">
        <b>Solve failed.</b> {result.message}{" "}{result.issues?.some((x) => x.level === "error") && "Fix the errors on the Data tab, then solve again."}
      </div></div>
    );
  }
  const r = result;
  const vs = r.buses.map((b) => b.v);
  const nLow = r.buses.filter((b) => b.vflag === "low").length, nHigh = r.buses.filter((b) => b.vflag === "high").length;
  const nQ = r.buses.filter((b) => b.qflag).length;
  const nOver = r.branches.filter((b) => b.loading_pct > 100).length;
  const lossSorted = [...r.branches].sort((a, b) => b.p_loss_mw - a.p_loss_mw);
  const maxLoss = Math.max(1e-9, lossSorted[0]?.p_loss_mw ?? 0);
  return (
    <div className="flex flex-col gap-4 p-4">
      {!r.converged && <div className="notice notice-crit"><b>Did not converge.</b> {r.message}. Values below are the last iterate and are not a valid operating point.</div>}
      {stale && <div className="notice notice-warn">The network changed since this solve. <button className="link" onClick={solve}>Solve again</button> to refresh.</div>}
      <div className="tiles">
        <Tile label="Status" value={r.converged ? "Converged" : "Diverged"} tone={r.converged ? "ok" : "crit"} sub={`${r.iterations} iter · max ΔS ${r.max_mismatch_pu.toExponential(1)} pu · ${r.solve_ms.toFixed(1)} ms`} />
        <Tile label="Generation" value={fmt(r.total_gen_mw, 1)} unit="MW" sub={`${fmt(r.total_gen_mvar, 1)} Mvar`} />
        <Tile label="Load" value={fmt(r.total_load_mw, 1)} unit="MW" sub={`${fmt(r.total_load_mvar, 1)} Mvar`} />
        <Tile label="Losses" value={fmt(r.total_p_loss_mw, 3)} unit="MW" sub={`${fmt((100 * r.total_p_loss_mw) / Math.max(r.total_load_mw, 1e-9), 2)} % of load · ${fmt(r.total_q_loss_mvar, 2)} Mvar`} />
        <Tile label="Voltage range" value={`${Math.min(...vs).toFixed(3)}–${Math.max(...vs).toFixed(3)}`} unit="pu"
          tone={nLow + nHigh ? "warn" : "ok"} sub={nLow + nHigh ? `${nLow} below 0.95 · ${nHigh} above 1.05` : "All buses within 0.95–1.05"} />
      </div>

      <div className="charts-row">
        <Section title="Voltage profile" aside={<span className="text-faint text-[12px]">Shaded band is 0.95–1.05 pu</span>}><VoltageChart series={[{ name: scenario.name, values: r.buses }]} /></Section>
        <Section title="Newton-Raphson convergence"><ConvergenceChart history={r.history} /></Section>
      </div>

      <Section title="Bus results" aside={
        <div className="flex gap-2 flex-wrap">
          {nQ > 0 && <Pill tone="crit">{nQ} Q-limit violation{nQ > 1 && "s"}</Pill>}
          <Btn onClick={() => saveFile(`${slug(scenario.name)}-results.json`, LF.serializeResult(r))}><Icon name="save" size={14} />Results JSON</Btn>
          <Btn onClick={() => copyText(LF.serializeResult(r), "Results JSON copied")}><Icon name="copy" size={14} />Copy</Btn>
        </div>}>
        <div className="table-wrap">
          <table className="grid-table">
            <thead><tr><th>Bus</th><th>Type</th><th className="r">V<em>pu</em></th><th className="r">Angle<em>deg</em></th><th className="r">P inj<em>MW</em></th><th className="r">Q inj<em>Mvar</em></th><th className="r">P gen<em>MW</em></th><th className="r">Q gen<em>Mvar</em></th><th className="r">P load<em>MW</em></th><th className="r">Q load<em>Mvar</em></th><th>Flags</th></tr></thead>
            <tbody>
              {r.buses.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => onSelectBus(b.id)}>
                  <td className="font-mono">{b.id}</td><td className="text-muted">{b.type}</td>
                  <td className="r"><span className={cx("vchip", `v-${b.vflag}`)}>{b.v.toFixed(4)}</span></td>
                  <td className="r">{b.angle_deg.toFixed(3)}</td><td className="r">{fmt(b.p_mw, 2)}</td><td className="r">{fmt(b.q_mvar, 2)}</td>
                  <td className="r">{b.type === "PQ" && !b.p_gen_mw ? <span className="text-faint">—</span> : fmt(b.p_gen_mw, 2)}</td>
                  <td className={cx("r", b.qflag && "text-crit")}>{b.type === "PQ" && Math.abs(b.q_gen_mvar) < 1e-6 ? <span className="text-faint">—</span> : fmt(b.q_gen_mvar, 2)}</td>
                  <td className="r">{fmt(b.p_load_mw, 1)}</td><td className="r">{fmt(b.q_load_mvar, 1)}</td>
                  <td>{b.vflag !== "ok" && <Pill tone={b.vflag === "low" ? "low" : "high"}>{b.vflag === "low" ? "Under V" : "Over V"}</Pill>} {b.qflag && <Pill tone="crit">{b.qflag === "qmax" ? "Q > max" : "Q < min"}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="charts-row">
        <Section title="Branch flows" aside={nOver > 0 && <Pill tone="crit">{nOver} overloaded</Pill>}>
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Branch</th><th className="r">P from<em>MW</em></th><th className="r">Q from<em>Mvar</em></th><th className="r">P to<em>MW</em></th><th className="r">Q to<em>Mvar</em></th><th className="r">P loss<em>MW</em></th><th className="r">Q loss<em>Mvar</em></th><th className="r">Loading</th></tr></thead>
              <tbody>
                {r.branches.map((b, i) => (
                  <tr key={i}>
                    <td className="font-mono whitespace-nowrap">{b.from}→{b.to}{isXfmr(scenario.data.branches[i] || {}) && <span className="text-info"> T</span>}</td>
                    <td className="r">{fmt(b.p_from_mw, 2)}</td><td className="r">{fmt(b.q_from_mvar, 2)}</td><td className="r">{fmt(b.p_to_mw, 2)}</td><td className="r">{fmt(b.q_to_mvar, 2)}</td>
                    <td className="r">{fmt(b.p_loss_mw, 3)}</td><td className="r">{fmt(b.q_loss_mvar, 3)}</td>
                    <td className={cx("r", b.loading_pct > 100 && "text-crit", b.loading_pct > 80 && b.loading_pct <= 100 && "text-warn")}>{b.loading_pct == null ? <span className="text-faint">—</span> : fmt(b.loading_pct, 1) + "%"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td colSpan="4" /><td className="r">{fmt(r.total_p_loss_mw, 3)}</td><td className="r">{fmt(r.total_q_loss_mvar, 3)}</td><td /></tr></tfoot>
            </table>
          </div>
        </Section>
        <Section title="Loss summary">
          <div className="flex flex-col gap-1.5">
            {lossSorted.slice(0, 8).map((b, i) => (
              <div key={i} className="loss-row">
                <span className="font-mono">{b.from}→{b.to}</span>
                <div className="loss-track"><div className="loss-bar" style={{ width: `${Math.max(0, (100 * b.p_loss_mw) / maxLoss)}%` }} /></div>
                <span className="r font-mono">{fmt(b.p_loss_mw, 3)}</span>
                <span className="r text-faint font-mono">{fmt((100 * b.p_loss_mw) / Math.max(r.total_p_loss_mw, 1e-9), 1)}%</span>
              </div>
            ))}
          </div>
          <p className="text-faint text-[12px] mt-3 leading-relaxed">Loss = S<sub>from</sub> + S<sub>to</sub> for each branch. Series I²R and I²X, net of line charging. Negative Q loss means the branch supplies more charging than it absorbs.</p>
        </Section>
      </div>

      <StudiesStrip />
    </div>
  );
}

function StudiesStrip() {
  return (
    <Section title="Studies" aside={<span className="text-faint text-[12px]">Phase 2 and 3 studies register in LF.STUDIES</span>}>
      <div className="studies">
        {LF.STUDIES.map((s) => (
          <div key={s.key} className={cx("study", s.run ? "is-ready" : "is-planned")}>
            <div className="flex items-center justify-between gap-2"><b>{s.name}</b><Pill tone={s.run ? "ok" : "muted"}>{s.run ? "Ready" : `Phase ${s.phase}`}</Pill></div>
            <div className="text-muted text-[12.5px]">{s.detail}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ================================================================= CASES */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "case";

function diffCases(a, b) {
  const out = [];
  if ((a.base_mva ?? 100) !== (b.base_mva ?? 100)) out.push(`Base MVA ${a.base_mva} → ${b.base_mva}`);
  const ma = new Map(a.buses.map((x) => [x.id, x])), mb = new Map(b.buses.map((x) => [x.id, x]));
  for (const [id, x] of ma) {
    const y = mb.get(id);
    if (!y) { out.push(`Bus ${id} removed`); continue; }
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) if (f !== "id" && x[f] !== y[f]) out.push(`Bus ${id} · ${f}: ${x[f] ?? "—"} → ${y[f] ?? "—"}`);
  }
  for (const id of mb.keys()) if (!ma.has(id)) out.push(`Bus ${id} added`);
  const key = (br) => `${br.from}-${br.to}`;
  const ca = new Map(), cb = new Map();
  a.branches.forEach((br) => { const k = key(br); ca.set(k, [...(ca.get(k) || []), br]); });
  b.branches.forEach((br) => { const k = key(br); cb.set(k, [...(cb.get(k) || []), br]); });
  for (const [k, list] of ca) {
    const other = cb.get(k) || [];
    list.forEach((x, i) => {
      const y = other[i];
      if (!y) { out.push(`Branch ${k.replace("-", "→")} removed`); return; }
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[f] !== y[f]) out.push(`Branch ${k.replace("-", "→")} · ${f}: ${x[f] ?? "—"} → ${y[f] ?? "—"}`);
    });
  }
  for (const [k, list] of cb) { const n = (ca.get(k) || []).length; for (let i = n; i < list.length; i++) out.push(`Branch ${k.replace("-", "→")} added`); }
  return out;
}

function CasesTab({ scenarios, active, setActive, loadBuiltin, importCase, rename, duplicate, remove, saveFile, copyText, canSave }) {
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const [a, setA] = useState(scenarios[0]?.id), [b, setB] = useState(scenarios[1]?.id ?? scenarios[0]?.id);
  useEffect(() => {
    if (!scenarios.find((s) => s.id === a)) setA(scenarios[0]?.id);
    if (!scenarios.find((s) => s.id === b)) setB(scenarios[scenarios.length - 1]?.id);
  }, [scenarios]); // eslint-disable-line
  const exportText = useMemo(() => LF.serializeCase(active.data), [active.data]);

  const ingest = (text, name) => {
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.buses)) throw new Error('No "buses" array found. Expected the loadflow case format.');
      if (!Array.isArray(data.branches)) data.branches = [];
      importCase(data, name);
      setErr(null); setPaste("");
    } catch (e) { setErr(e.message); }
  };
  const readFile = (f) => { if (!f) return; const fr = new FileReader(); fr.onload = () => ingest(String(fr.result), f.name.replace(/\.json$/i, "")); fr.readAsText(f); };

  const sa = scenarios.find((s) => s.id === a), sb = scenarios.find((s) => s.id === b);
  const ra = useMemo(() => sa && LF.runLoadFlow(sa.data), [sa?.data]); // eslint-disable-line
  const rb = useMemo(() => sb && LF.runLoadFlow(sb.data), [sb?.data]); // eslint-disable-line
  const changes = useMemo(() => (sa && sb ? diffCases(sa.data, sb.data) : []), [sa?.data, sb?.data]); // eslint-disable-line
  const both = ra?.buses && rb?.buses;
  const viol = (r) => r.buses.filter((x) => x.vflag !== "ok").length;
  const ids = both ? [...new Set([...ra.buses.map((x) => x.id), ...rb.buses.map((x) => x.id)])] : [];
  const mA = both ? Object.fromEntries(ra.buses.map((x) => [x.id, x])) : {}, mB = both ? Object.fromEntries(rb.buses.map((x) => [x.id, x])) : {};

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="cases-grid">
        <Section title="Built-in library">
          <div className="flex flex-col gap-3">
            {Object.entries(LF.CASES).map(([k, c]) => (
              <div key={k} className="lib-card">
                <div className="min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-muted text-[13px]">{c.note}</div>
                  <div className="text-faint text-[12px] font-mono mt-1">{c.data.buses.length} buses · {c.data.branches.length} branches · {c.data.base_mva} MVA</div>
                </div>
                <Btn kind="primary-soft" onClick={() => loadBuiltin(k)}>Open</Btn>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Import">
          <div className={cx("drop", drag && "is-drag")}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files[0]); }}>
            <p>Drop a loadflow <code>.json</code> case here, or</p>
            <Btn kind="primary-soft" onClick={() => fileRef.current?.click()}>Choose file</Btn>
            <input ref={fileRef} id="import-file" type="file" accept=".json,application/json" className="hidden" onChange={(e) => { readFile(e.target.files[0]); e.target.value = ""; }} />
          </div>
          <textarea id="import-paste" className="code-area mt-3" rows="5" placeholder='Or paste JSON: {"base_mva": 100.0, "buses": [...], "branches": [...]}' value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="flex items-center gap-2 mt-2">
            <Btn kind="primary-soft" disabled={!paste.trim()} onClick={() => ingest(paste, "Pasted case")}>Import pasted JSON</Btn>
            {err && <span className="text-crit text-[13px]">{err}</span>}
          </div>
        </Section>

        <Section title={`Export · ${active.name}`} aside={
          <div className="flex gap-2">
            {canSave && <Btn kind="primary-soft" onClick={() => saveFile(`${slug(active.name)}.json`, exportText)}><Icon name="save" size={14} />Save .json</Btn>}
            <Btn onClick={() => copyText(exportText, "Case JSON copied")}><Icon name="copy" size={14} />Copy</Btn>
          </div>}>
          <pre className="code-area max-h-64 overflow-auto">{exportText}</pre>
          <p className="text-faint text-[12px] mt-2">Same layout and float formatting as Python's <code>json</code> module. Runs as-is with <code>loadflow case.json</code>.</p>
        </Section>
      </div>

      <Section title={`Scenarios · ${scenarios.length}`} aside={<span className="text-faint text-[12px]">Kept in memory for this session. Export to keep them.</span>}>
        <div className="flex flex-col gap-2">
          {scenarios.map((s) => (
            <div key={s.id} className={cx("scn-row", s.id === active.id && "is-active")}>
              <input className="num-input flex-1 min-w-0" value={s.name} onChange={(e) => rename(s.id, e.target.value)} aria-label="Scenario name" />
              <span className="text-faint text-[12px] font-mono hidden sm:inline">{s.data.buses.length}b / {s.data.branches.length}br</span>
              {s.id !== active.id ? <Btn onClick={() => setActive(s.id)}>Make active</Btn> : <Pill tone="accent">Active</Pill>}
              <Btn onClick={() => duplicate(s.id)} title="Duplicate"><Icon name="dup" size={14} /><span className="hidden sm:inline">Duplicate</span></Btn>
              <Btn kind="danger" disabled={scenarios.length < 2} onClick={() => remove(s.id)} title="Delete scenario"><Icon name="trash" size={14} /></Btn>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Compare scenarios" aside={
        <div className="flex items-center gap-2 text-[13px]">
          <select className="num-input w-auto" value={a} onChange={(e) => setA(e.target.value)} aria-label="Base scenario">{scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <span className="text-muted">vs</span>
          <select className="num-input w-auto" value={b} onChange={(e) => setB(e.target.value)} aria-label="Compared scenario">{scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </div>}>
        {scenarios.length < 2 && <div className="notice notice-info mb-3">Duplicate the active scenario, change something in the copy, then compare the two here.</div>}
        {!both ? <div className="notice notice-crit">One of the scenarios does not solve: {(ra?.buses ? rb : ra)?.message}</div> : (
          <div className="flex flex-col gap-4">
            <div className="table-wrap">
              <table className="grid-table compare">
                <thead><tr><th>Metric</th><th className="r">{sa.name}</th><th className="r">{sb.name}</th><th className="r">Δ</th></tr></thead>
                <tbody>
                  {[["Losses", "MW", ra.total_p_loss_mw, rb.total_p_loss_mw, 3], ["Generation", "MW", ra.total_gen_mw, rb.total_gen_mw, 2],
                    ["Reactive gen", "Mvar", ra.total_gen_mvar, rb.total_gen_mvar, 2], ["Load", "MW", ra.total_load_mw, rb.total_load_mw, 2],
                    ["Min V", "pu", Math.min(...ra.buses.map((x) => x.v)), Math.min(...rb.buses.map((x) => x.v)), 4],
                    ["Max V", "pu", Math.max(...ra.buses.map((x) => x.v)), Math.max(...rb.buses.map((x) => x.v)), 4],
                    ["Voltage violations", "", viol(ra), viol(rb), 0], ["Iterations", "", ra.iterations, rb.iterations, 0]].map(([l, u, x, y, d]) => (
                    <tr key={l}><td>{l} {u && <em className="text-faint not-italic text-[11px]">{u}</em>}</td><td className="r">{fmt(x, d)}</td><td className="r">{fmt(y, d)}</td>
                      <td className={cx("r", Math.abs(y - x) > 10 ** -d / 2 && (y > x ? "text-high" : "text-low"))}>{sgn(y - x, d)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="charts-row">
              <div className="min-w-0">
                <div className="flex gap-4 text-[12px] mb-1"><span className="flex items-center gap-1.5"><i className="sw" style={{ background: "var(--wire)" }} />{sa.name}</span><span className="flex items-center gap-1.5"><i className="sw" style={{ background: "var(--accent)" }} />{sb.name}</span></div>
                <VoltageChart series={[{ name: sa.name, color: "var(--wire)", values: ids.map((id) => ({ id, v: mA[id]?.v })) }, { name: sb.name, color: "var(--accent)", values: ids.map((id) => ({ id, v: mB[id]?.v })) }]} />
              </div>
              <div className="min-w-0">
                <div className="label mb-2">Network changes · {changes.length}</div>
                {changes.length === 0 ? <p className="text-muted text-[13px]">The two networks are identical.</p> : (
                  <ul className="change-list">{changes.slice(0, 40).map((c, i) => <li key={i}>{c}</li>)}{changes.length > 40 && <li className="text-faint">…and {changes.length - 40} more</li>}</ul>
                )}
              </div>
            </div>
            <div className="table-wrap">
              <table className="grid-table">
                <thead><tr><th>Bus</th><th className="r">V A<em>pu</em></th><th className="r">V B<em>pu</em></th><th className="r">ΔV<em>pu</em></th><th className="r">θ A<em>deg</em></th><th className="r">θ B<em>deg</em></th><th className="r">Δθ<em>deg</em></th></tr></thead>
                <tbody>{ids.map((id) => {
                  const x = mA[id], y = mB[id]; const dv = x && y ? y.v - x.v : null;
                  return (<tr key={id}><td className="font-mono">{id}</td>
                    <td className="r">{x ? <span className={cx("vchip", `v-${x.vflag}`)}>{x.v.toFixed(4)}</span> : "—"}</td>
                    <td className="r">{y ? <span className={cx("vchip", `v-${y.vflag}`)}>{y.v.toFixed(4)}</span> : "—"}</td>
                    <td className={cx("r", dv != null && Math.abs(dv) > 5e-5 && (dv > 0 ? "text-high" : "text-low"))}>{dv == null ? "—" : sgn(dv, 4)}</td>
                    <td className="r">{x ? x.angle_deg.toFixed(3) : "—"}</td><td className="r">{y ? y.angle_deg.toFixed(3) : "—"}</td>
                    <td className="r">{x && y ? sgn(y.angle_deg - x.angle_deg, 3) : "—"}</td></tr>);
                })}</tbody>
              </table>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ================================================================ VERIFY */
function VerifyPanel({ onClose, onOpenCase }) {
  const [res, setRes] = useState(null);
  useEffect(() => { const t = setTimeout(() => setRes(LF.verifySolver()), 30); return () => clearTimeout(t); }, []);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel" role="dialog" aria-label="Solver verification">
        <header className="flex items-start justify-between gap-3 p-4 border-b border-line">
          <div>
            <div className="label">Self-test · IEEE 14-bus vs PYPOWER/MATPOWER reference</div>
            {res ? <div className={cx("verdict", res.pass ? "text-ok" : "text-crit")}>{res.pass ? "PASS" : "FAIL"}<span className="text-muted text-[14px] font-normal ml-3">all 14 buses within {res.tol.toExponential(0)} pu / deg</span></div> : <div className="verdict text-muted">Running…</div>}
          </div>
          <button className="row-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        {res && (
          <div className="p-4 overflow-auto flex flex-col gap-4">
            <div className="tiles">
              <Tile label="Iterations" value={res.iterations} sub={`max mismatch ${res.mismatch.toExponential(2)} pu`} />
              <Tile label="Max |ΔV|" value={res.maxDv.toExponential(1)} unit="pu" tone={res.maxDv <= res.tol ? "ok" : "crit"} sub="Reference given to 6 decimals" />
              <Tile label="Max |Δθ|" value={res.maxDa.toExponential(1)} unit="deg" tone={res.maxDa <= res.tol ? "ok" : "crit"} />
              <Tile label="Losses" value={res.loss.toFixed(3)} unit="MW" tone={Math.abs(res.dLoss) < 5e-4 ? "ok" : "crit"} sub={`reference ${res.lossRef.toFixed(3)} MW`} />
              <Tile label="Power balance" value={res.balance.toExponential(1)} unit="pu" tone="ok" sub="|ΣP inj − P loss|" />
            </div>
            <div className="notice notice-info">
              <b>Bus 9 shunt guard.</b> Dropping the 0.19 pu capacitor at bus 9 shifts voltages by up to <b>{res.shuntShift.toFixed(4)} pu</b>, which would fail this test. The shunt is in the Y-bus diagonal, and this check runs on every verify.
            </div>
            <div className="table-wrap">
              <table className="grid-table">
                <thead><tr><th>Bus</th><th className="r">V ref</th><th className="r">V calc</th><th className="r">ΔV</th><th className="r">θ ref</th><th className="r">θ calc</th><th className="r">Δθ</th><th>Status</th></tr></thead>
                <tbody>{res.rows.map((x) => (
                  <tr key={x.id}><td className="font-mono">{x.id}</td><td className="r">{x.vRef.toFixed(6)}</td><td className="r">{x.v.toFixed(6)}</td><td className="r text-faint">{x.dv.toExponential(1)}</td>
                    <td className="r">{x.aRef.toFixed(6)}</td><td className="r">{x.a.toFixed(6)}</td><td className="r text-faint">{x.da.toExponential(1)}</td>
                    <td>{x.pass ? <Pill tone="ok">pass</Pill> : <Pill tone="crit">fail</Pill>}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Btn kind="primary-soft" onClick={() => setRes(LF.verifySolver())}><Icon name="check" size={14} />Run again</Btn>
              <Btn onClick={onOpenCase}>Open IEEE 14-bus in workspace</Btn>
              <span className="text-faint text-[12px] self-center">Solve time {res.ms.toFixed(1)} ms</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* =================================================================== APP */
const TABS = [["diagram", "Diagram"], ["data", "Data"], ["results", "Results"], ["studies", "Studies"], ["cases", "Cases"]];

export function LoadFlowWorkspace() {
  const [scenarios, setScenarios] = useState(() => {
    const s = makeScenario(LF.CASES.demo3.name, LF.CASES.demo3.data, LF.CASES.demo3.layout);
    s.result = LF.runLoadFlow(s.data); s.solvedData = s.data;
    return [s];
  });
  const [activeId, setActiveId] = useState(() => scenarios[0].id);
  const [tab, setTab] = useState("diagram");
  const [selection, setSelection] = useState(null);
  const [tool, setTool] = useState("select");
  const [live, setLive] = useState(true);
  const [verify, setVerify] = useState(false);
  const [toast, setToast] = useState(null);
  const [downloads, setDownloads] = useState(null);

  const active = scenarios.find((s) => s.id === activeId) || scenarios[0];
  const issues = useMemo(() => LF.validateCase(active.data), [active.data]);
  const stale = !!active.result && active.solvedData !== active.data;

  useEffect(() => {
    let alive = true;
    try { window.claude?.use?.("downloads").then((d) => alive && setDownloads(d)).catch(() => {}); } catch (e) { /* not in a viewer */ }
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }, [toast]);

  const patch = (id, fn) => setScenarios((list) => list.map((s) => (s.id === id ? fn(s) : s)));
  const update = useCallback((fn) => patch(activeId, (s) => { const d = clone(s.data); fn(d); return { ...s, data: d }; }), [activeId]);
  const solve = useCallback(() => patch(activeId, (s) => ({ ...s, result: LF.runLoadFlow(s.data, { enforceQLimits: !!s.enforceQ }), solvedData: s.data })), [activeId]);
  const setEnforceQ = (on) => patch(activeId, (s) => { const n = { ...s, enforceQ: on }; n.result = LF.runLoadFlow(n.data, { enforceQLimits: on }); n.solvedData = n.data; return n; });
  const openOutage = (k) => {
    const src = active, br = src.data.branches[k];
    const s = makeScenario(`${src.name} − branch ${br.from}→${br.to}`, outageCase(src.data, k), src.layout);
    s.enforceQ = src.enforceQ; s.result = LF.runLoadFlow(s.data, { enforceQLimits: !!s.enforceQ }); s.solvedData = s.data;
    addScenario(s); setTab("diagram"); setToast({ text: `Opened outage ${br.from}→${br.to}. Compare it on the Cases tab.` });
  };

  // Live solve: debounce re-solve after edits.
  useEffect(() => {
    if (!live || !stale) return;
    const t = setTimeout(solve, 120);
    return () => clearTimeout(t);
  }, [live, active.data, stale, solve]);
  useEffect(() => { if (live && !active.result) solve(); }, [live, activeId]); // eslint-disable-line

  const renameBus = (oldId, newIdV) => {
    if (newIdV === undefined || !Number.isInteger(newIdV) || newIdV === oldId) return;
    if (active.data.buses.some((b) => b.id === newIdV)) { setToast({ tone: "crit", text: `Bus ${newIdV} already exists` }); return; }
    patch(activeId, (s) => {
      const d = clone(s.data);
      d.buses.forEach((b) => { if (b.id === oldId) b.id = newIdV; });
      d.branches.forEach((br) => { if (br.from === oldId) br.from = newIdV; if (br.to === oldId) br.to = newIdV; });
      const layout = { ...s.layout }; layout[newIdV] = layout[oldId]; delete layout[oldId];
      return { ...s, data: d, layout };
    });
    if (selection?.kind === "bus" && selection.id === oldId) setSelection({ kind: "bus", id: newIdV });
  };
  const addBusAt = (pt) => {
    const id = Math.max(0, ...active.data.buses.map((b) => b.id)) + 1;
    patch(activeId, (s) => {
      const d = clone(s.data); d.buses.push({ id, type: d.buses.length ? "PQ" : "slack" });
      return { ...s, data: d, layout: { ...s.layout, [id]: pt || freeSpot(s.layout) } };
    });
    setSelection({ kind: "bus", id });
    return id;
  };
  const addBranch = (from, to) => {
    const k = active.data.branches.length;
    update((d) => d.branches.push({ from, to, r: 0.01, x: 0.05, b: 0.0 }));
    setSelection({ kind: "branch", k });
  };
  const deleteBus = (id) => {
    patch(activeId, (s) => {
      const d = clone(s.data);
      d.buses = d.buses.filter((b) => b.id !== id);
      d.branches = d.branches.filter((br) => br.from !== id && br.to !== id);
      const layout = { ...s.layout }; delete layout[id];
      return { ...s, data: d, layout };
    });
    setSelection(null);
  };
  const deleteBranch = (k) => { update((d) => d.branches.splice(k, 1)); setSelection(null); };
  const deleteSelection = () => { if (selection?.kind === "bus") deleteBus(selection.id); else if (selection?.kind === "branch") deleteBranch(selection.k); };
  const relayout = () => patch(activeId, (s) => ({ ...s, layout: LF.autoLayout(s.data) }));
  const moveBus = (id, pt) => patch(activeId, (s) => ({ ...s, layout: { ...s.layout, [id]: pt } }));

  const addScenario = (s) => { setScenarios((l) => [...l, s]); setActiveId(s.id); setSelection(null); };
  const loadBuiltin = (k) => { const c = LF.CASES[k]; const s = makeScenario(c.name, c.data, c.layout); s.result = LF.runLoadFlow(s.data); s.solvedData = s.data; addScenario(s); setTab("diagram"); setToast({ text: `Opened ${c.name}` }); };
  const importCase = (data, name) => { const s = makeScenario(name, data); addScenario(s); setTab("diagram"); setToast({ text: `Imported ${name}: ${data.buses.length} buses` }); };
  const duplicate = (id) => {
    const src = scenarios.find((s) => s.id === id);
    const base = src.name.replace(/ · alt \d+$/, "");
    const n = scenarios.filter((s) => s.name.startsWith(base + " · alt")).length + 1;
    const s = { ...makeScenario(`${base} · alt ${n}`, src.data, src.layout), result: src.result, solvedData: null, enforceQ: src.enforceQ };
    s.solvedData = s.result ? s.data : null;
    addScenario(s); setToast({ text: `Created ${s.name}. Edit it, then compare on the Cases tab.` });
  };
  const removeScenario = (id) => { setScenarios((l) => { const n = l.filter((s) => s.id !== id); if (id === activeId && n.length) setActiveId(n[0].id); return n.length ? n : l; }); };

  // Networks handed over from other workspaces (System view → compiled bus model).
  useEffect(() => bus.on("loadflow:open", ({ data, name, layout }) => {
    const s = makeScenario(name, data, layout && Object.keys(layout).length === data.buses.length ? layout : undefined);
    s.result = LF.runLoadFlow(s.data); s.solvedData = s.data;
    addScenario(s); setTab("diagram"); setToast({ text: `Opened ${name}: ${data.buses.length} buses` });
  }), []); // eslint-disable-line

  const saveFile = async (filename, text) => {
    if (!downloads) { copyText(text, "Saving is not available here. Copied to clipboard instead."); return; }
    try { await downloads.save({ filename, data: text }); setToast({ text: `Saved ${filename}` }); }
    catch (e) { if (e?.code !== "declined") setToast({ tone: "crit", text: `Could not save: ${e?.message || e?.code || "unknown error"}` }); }
  };
  const copyText = (text, msg) => {
    try { navigator.clipboard.writeText(text).then(() => setToast({ text: msg }), () => setToast({ tone: "crit", text: "Clipboard blocked. Select the text and copy it manually." })); }
    catch (e) { setToast({ tone: "crit", text: "Clipboard blocked. Select the text and copy it manually." }); }
  };

  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); solve(); setToast({ text: "Solved" }); return; }
      if (typing || verify) return;
      if (e.key === "Escape") { setTool("select"); setSelection(null); }
      if ((e.key === "Delete" || e.key === "Backspace") && selection && tab === "diagram") { e.preventDefault(); deleteSelection(); }
      if (tab === "diagram") { if (e.key === "v") setTool("select"); if (e.key === "b") setTool("bus"); if (e.key === "c") setTool("connect"); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

  const r = active.result;
  const errCount = issues.filter((x) => x.level === "error").length;
  const status = errCount ? { tone: "crit", text: `${errCount} input error${errCount > 1 ? "s" : ""}` }
    : !r ? { tone: "muted", text: "Not solved" }
    : stale ? { tone: "warn", text: "Results stale" }
    : r.converged ? { tone: "ok", text: `Converged · ${r.iterations} iter` } : { tone: "crit", text: r.buses ? "Diverged" : "Solve failed" };

  return (
    <div className="ws">
      <header className="topbar">
        <div className="ws-title">Load flow</div>
        <div className="scn-chips" role="tablist" aria-label="Scenarios">
          {scenarios.map((s) => (
            <button key={s.id} className={cx("chip", s.id === activeId && "is-active")} onClick={() => { setActiveId(s.id); setSelection(null); }}>{s.name}</button>
          ))}
          <button className="chip chip-add" onClick={() => duplicate(activeId)} title="Duplicate active scenario"><Icon name="dup" size={13} /></button>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <label className="live-toggle" title="Re-solve after every edit"><input id="live" type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /><span>Live solve</span></label>
          <Btn onClick={() => setVerify(true)} title="Run IEEE 14-bus self-test"><Icon name="check" size={14} />Verify solver</Btn>
          <Btn kind="primary" onClick={() => { solve(); setToast({ text: "Solved" }); }} title="Solve (Ctrl+Enter)"><Icon name="bolt" size={15} />Solve</Btn>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={cx("tab", tab === k && "is-active")} onClick={() => setTab(k)}>
            {l}{k === "data" && errCount > 0 && <span className="dot dot-crit" />}{k === "results" && stale && <span className="dot dot-warn" />}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 pr-1 text-[12.5px]">
          <Pill tone={status.tone}>{status.text}</Pill>
          {r?.converged && !stale && <span className="text-muted hidden md:inline">Losses <b className="text-fg font-mono">{fmt(r.total_p_loss_mw, 3)}</b> MW</span>}
        </div>
      </nav>

      <main className={cx("main", tab === "diagram" && "is-diagram")}>
        {tab === "diagram" && <DiagramTab scenario={active} result={r} stale={stale} selection={selection} setSelection={setSelection} tool={tool} setTool={setTool}
          issues={issues} update={update} renameBus={renameBus} deleteBus={deleteBus} deleteBranch={deleteBranch} deleteSelection={deleteSelection}
          onMoveBus={moveBus} onAddBus={(pt) => addBusAt(pt)} onAddBranch={addBranch} relayout={relayout} />}
        {tab === "data" && <DataTab scenario={active} issues={issues} update={update} renameBus={renameBus} deleteBus={deleteBus} deleteBranch={deleteBranch}
          addBus={() => addBusAt()} addBranchRow={() => { const ids = active.data.buses.map((b) => b.id); update((d) => d.branches.push({ from: ids[0], to: ids[1], r: 0.01, x: 0.05, b: 0.0 })); }} />}
        {tab === "results" && <ResultsTab scenario={active} result={r} stale={stale} solve={solve} issues={issues} saveFile={saveFile} copyText={copyText}
          onSelectBus={(id) => { setSelection({ kind: "bus", id }); setTab("diagram"); }} />}
        {tab === "studies" && <StudiesTab scenario={active} result={r} stale={stale} setEnforceQ={setEnforceQ} openOutage={openOutage} />}
        {tab === "cases" && <CasesTab scenarios={scenarios} active={active} setActive={(id) => { setActiveId(id); setSelection(null); }} loadBuiltin={loadBuiltin} importCase={importCase}
          rename={(id, name) => patch(id, (s) => ({ ...s, name }))} duplicate={duplicate} remove={removeScenario} saveFile={saveFile} copyText={copyText} canSave={!!downloads} />}
      </main>

      {verify && <VerifyPanel onClose={() => setVerify(false)} onOpenCase={() => { setVerify(false); loadBuiltin("ieee14"); }} />}
      {toast && <div className={cx("toast", toast.tone === "crit" && "toast-crit")} role="status">{toast.text}</div>}
    </div>
  );
}

