/* Chart kit: one SVG frame (axes, gridlines, units, legend, crosshair + tooltip, responsive width) and the marks
   drawn inside it. Pure SVG styled by .ck-* classes and CSS variables (src/head.html), so svgToString() in
   reportButton.jsx can inline the computed styles for the calculation package. React is the global UMD build.

   <Chart x={{ type: "linear", domain: [0, 120], label: "Distance from source", unit: "ft" }}
          y={{ domain: [0, 4], label: "Voltage drop", unit: "%" }}
          hover={{ xs, render: (i) => ({ title, rows: [{ label, value, color }] }), points: (i) => [{ x, y, color }] }}>
     <RefLine y={3} label="limit 3 %" tone="crit" />
     <Line data={[{ x, y }]} color="var(--accent)" />
   </Chart>

   x.type "band" makes a categorical axis of x.n bands (bars); hover then reports the band index. */
const { useState, useRef, useLayoutEffect, useEffect, useContext, createContext, useMemo } = React;
import { niceTicks, linearScale, logScale, bandScale, nearestIndex, formatTick, formatPow10, labelEvery } from "./scale.js";

const Ctx = createContext(null);
export const useChart = () => useContext(Ctx);

const CHAR_W = 6.4;          // approx. advance of an 11 px IBM Plex Mono glyph, for layout estimates
const textW = (s, k = CHAR_W) => String(s ?? "").length * k;

/* Container width from a ResizeObserver; keeps the last non-zero width while the workspace is hidden. */
export function useWidth(ref, fallback = 640) {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const read = () => { const cw = el.clientWidth; if (cw > 0) setW((p) => (Math.abs(p - cw) >= 1 ? Math.floor(cw) : p)); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

function axisFrom(spec, range, isY) {
  const type = spec.type || "linear";
  if (type === "band") {
    const b = bandScale(spec.n, range, { inner: spec.inner ?? 0.3, maxBar: spec.maxBar ?? 24 });
    return { type, band: b, scale: (i) => b.center(i), ticks: [], fmt: (i) => spec.labels?.[i] ?? String(i) };
  }
  const [d0, d1] = spec.domain;
  if (type === "log") {
    const s = logScale([d0, d1], range);
    return { type, scale: s, ticks: spec.ticks || s.ticks(), fmt: spec.format || formatPow10, domain: [d0, d1] };
  }
  const t = niceTicks(d0, d1, spec.count || (isY ? 5 : 6), { nice: spec.nice !== false });
  const dom = spec.nice === false ? [d0, d1] : [t.min, t.max];
  const s = linearScale(dom, range);
  const ticks = spec.ticks || t.ticks;
  return { type, scale: s, ticks, fmt: spec.format || ((v) => formatTick(v, t.decimals)), domain: dom };
}

const label = (spec) => (spec?.label ? `${spec.label}${spec.unit ? `, ${spec.unit}` : ""}` : spec?.unit || "");

export function Chart({ x, y, height = 220, minWidth = 0, legend, hover, children, ariaLabel, reportTitle, className, fallbackWidth }) {
  const wrapRef = useRef(null), svgRef = useRef(null);
  const cw = useWidth(wrapRef, fallbackWidth || 640);
  const W = Math.max(cw, minWidth || 0, 240), H = height;
  const [hi, setHi] = useState(null);

  // provisional y axis to size the left margin from the widest tick label
  const yProbe = useMemo(() => axisFrom(y, [1, 0], true), [y]);
  const yLab = label(y), xLab = label(x);
  const legW = legend ? legend.reduce((s, it) => s + 22 + textW(it.name, 6.2) + 14, 0) : 0;
  const legendRow = legend && legend.length ? (textW(yLab, 6.2) + legW + 24 > W ? 2 : 1) : 0;
  const m = {
    l: Math.ceil(Math.max(28, ...yProbe.ticks.map((t) => textW(yProbe.fmt(t)))) + 12),
    r: 14 + (x.padRight || 0),
    t: (yLab || legendRow ? 24 : 10) + (legendRow === 2 ? 18 : 0),
    b: (x.type === "band" && x.rotate ? 44 : 22) + (xLab ? 16 : 0),
  };
  const iw = Math.max(10, W - m.l - m.r), ih = Math.max(10, H - m.t - m.b);
  const X = axisFrom(x, [m.l, m.l + iw], false), Y = axisFrom(y, [m.t + ih, m.t], true);
  const ctx = { X: X.scale, Y: Y.scale, xAxis: X, yAxis: Y, m, iw, ih, W, H, band: X.band, hi };

  // hover index from a pointer position (plot pixels)
  const xs = hover?.xs;
  const pick = (px) => {
    if (!hover) return null;
    if (X.type === "band") return X.band.index(px);
    if (!xs?.length) return null;
    return nearestIndex(xs.map((v) => X.scale(v)), px);
  };
  const onMove = (e) => {
    const svg = svgRef.current; if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) * W) / (r.width || W);
    if (px < m.l - 6 || px > m.l + iw + 6) { setHi(null); return; }
    setHi(pick(px));
  };
  const count = X.type === "band" ? x.n : xs?.length || 0;
  const onKey = (e) => {
    if (!hover || !count) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHi((h) => { const d = e.key === "ArrowRight" ? 1 : -1; return h == null ? (d > 0 ? 0 : count - 1) : Math.max(0, Math.min(count - 1, h + d)); });
    } else if (e.key === "Escape") setHi(null);
  };
  useEffect(() => { if (hi != null && hi >= count) setHi(null); }, [count]);

  const hx = hi == null ? null : X.type === "band" ? X.band.center(hi) : xs?.[hi] != null ? X.scale(xs[hi]) : null;
  const tip = hi != null && hover?.render ? hover.render(hi) : null;
  const pts = hi != null && hover?.points ? hover.points(hi).filter((p) => Number.isFinite(p.y)) : [];
  const tipLeft = hx == null ? 0 : hx + 14 + 200 > W ? Math.max(4, hx - 14 - 200) : hx + 14;

  // x tick labels: thin out band labels; numeric ticks use the axis ticks
  const showBand = X.type === "band" ? labelEvery(x.n, iw, x.labelPx || Math.max(18, Math.min(60, (Math.max(...(x.labels || [""]).map((s) => String(s).length)) + 1) * 6.4))) : null;

  return (
    <div className={`ck ${className || ""}`} ref={wrapRef}>
      <div className={minWidth ? "ck-scroll" : undefined}>
        <div className="ck-stage" style={{ width: minWidth && W > cw ? W : undefined }} tabIndex={hover ? 0 : undefined} onKeyDown={onKey}
          onBlur={() => setHi(null)} aria-label={hover ? `${ariaLabel || "Chart"}. Use the arrow keys to read values.` : undefined}>
          <svg ref={svgRef} className="ck-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel}
            data-report-fig={reportTitle || undefined} style={{ touchAction: "pan-y" }}
            onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={(e) => e.pointerType === "mouse" && setHi(null)}>
            {/* gridlines + y ticks */}
            <g className="ck-grid">
              {Y.ticks.map((t) => <line key={"gy" + t} x1={m.l} x2={m.l + iw} y1={Y.scale(t)} y2={Y.scale(t)} />)}
              {x.grid && X.type !== "band" && X.ticks.map((t) => <line key={"gx" + t} x1={X.scale(t)} x2={X.scale(t)} y1={m.t} y2={m.t + ih} />)}
            </g>
            <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
            <g className="ck-axis">
              <line x1={m.l} x2={m.l + iw} y1={m.t + ih} y2={m.t + ih} />
            </g>
            <g className="ck-ticks">
              {Y.ticks.map((t) => <text key={"ty" + t} x={m.l - 8} y={Y.scale(t) + 3.5} textAnchor="end">{Y.fmt(t)}</text>)}
              {X.type === "band"
                ? Array.from({ length: x.n }, (_, i) => showBand(i) && (x.rotate
                  ? <text key={"tx" + i} transform={`translate(${X.band.center(i) + 3} ${m.t + ih + 12}) rotate(-40)`} textAnchor="end">{X.fmt(i)}</text>
                  : <text key={"tx" + i} x={X.band.center(i)} y={m.t + ih + 15} textAnchor="middle">{X.fmt(i)}</text>))
                : X.ticks.map((t) => <text key={"tx" + t} x={X.scale(t)} y={m.t + ih + 15} textAnchor="middle">{X.fmt(t)}</text>)}
            </g>
            {yLab && <text className="ck-label" x={2} y={12} textAnchor="start">{yLab}</text>}
            {xLab && <text className="ck-label" x={m.l + iw} y={H - 4} textAnchor="end">{xLab}</text>}
            {legendRow > 0 && <Legend items={legend} x={W - m.r} y={legendRow === 2 ? 30 : 12} />}
            {/* hover layer: never exported to the report */}
            {hover && <rect className="ck-hit" x={m.l} y={m.t} width={iw} height={ih} />}
            {hx != null && (
              <g className="ck-hover" data-noexport="1" pointerEvents="none">
                {X.type === "band"
                  ? <rect className="ck-band-hi" x={X.band.center(hi) - X.band.band / 2} y={m.t} width={X.band.band} height={ih} />
                  : <line className="ck-cross" x1={hx} x2={hx} y1={m.t} y2={m.t + ih} />}
                {pts.map((p, k) => <circle key={k} className="ck-hover-dot" cx={p.x != null ? X.scale(p.x) : hx} cy={Y.scale(p.y)} r="4.5" style={{ fill: p.color }} />)}
              </g>
            )}
          </svg>
          {tip && (
            <div className="ck-tip" style={{ left: tipLeft, top: Math.max(4, m.t - 4) }} role="status">
              {tip.title && <div className="ck-tip-t">{tip.title}</div>}
              {(tip.rows || []).map((r, k) => (
                <div key={k} className="ck-tip-r">
                  {r.color ? <i style={{ background: r.color }} /> : <i className="is-none" />}
                  <span>{r.label}</span><b>{r.value}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Legend drawn inside the SVG (so it travels with the figure into the report), right-aligned at (x, y). */
function Legend({ items, x, y }) {
  let cur = x;
  const placed = [...items].reverse().map((it) => { const w = 22 + textW(it.name, 6.2); cur -= w + 14; return { ...it, at: cur + 14 }; }).reverse();
  return (
    <g className="ck-legend">
      {placed.map((it, k) => (
        <g key={k} transform={`translate(${it.at} ${y})`}>
          {it.kind === "bar" || it.kind === "area"
            ? <rect x="0" y="-8" width="12" height="9" rx="2" style={{ fill: it.color, opacity: it.kind === "area" ? 0.55 : 1 }} />
            : <line x1="0" x2="16" y1="-3.5" y2="-3.5" className={it.kind === "ref" ? "ck-ref-l" : "ck-line-key"} style={{ stroke: it.color }} />}
          <text x={it.kind === "bar" || it.kind === "area" ? 17 : 21} y="0">{it.name}</text>
        </g>
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ marks */
const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");

export function Line({ data, color = "var(--accent)", width = 2, dash, opacity, markers, className, title }) {
  const { X, Y } = useChart();
  const pts = data.filter((d) => Number.isFinite(d.y) && Number.isFinite(d.x)).map((d) => [X(d.x), Y(d.y)]);
  if (pts.length < 2 && !markers) return null;
  return (
    <g className={className}>
      <path className="ck-line" d={path(pts)} style={{ stroke: color, strokeWidth: width, opacity }} strokeDasharray={dash}>{title && <title>{title}</title>}</path>
      {markers && pts.map((p, k) => <circle key={k} className="ck-dot" cx={p[0]} cy={p[1]} r={3} style={{ fill: color }} />)}
    </g>
  );
}

export function Area({ data, color = "var(--accent)", base, line = true, opacity = 0.12 }) {
  const { X, Y, yAxis } = useChart();
  const pts = data.filter((d) => Number.isFinite(d.y)).map((d) => [X(d.x), Y(d.y)]);
  if (pts.length < 2) return null;
  const b = Y(base ?? Math.max(yAxis.domain?.[0] ?? 0, Math.min(0, yAxis.domain?.[1] ?? 0)));
  const d = `${path(pts)}L${pts[pts.length - 1][0].toFixed(2)},${b.toFixed(2)}L${pts[0][0].toFixed(2)},${b.toFixed(2)}Z`;
  return (
    <g>
      <path className="ck-area" d={d} style={{ fill: color, fillOpacity: opacity }} />
      {line && <path className="ck-line" d={path(pts)} style={{ stroke: color }} />}
    </g>
  );
}

/* Vertical bars on a band x axis. values[i] = number | null. groups/group place several series side by side.
   Rounded 3 px data end, square at the baseline (drawn as a path so it survives SVG serialisation). */
export function Bars({ values, color = "var(--accent)", base = 0, groups = 1, group = 0, labels, format = (v) => formatTick(v, 0), titles }) {
  const { Y, band, yAxis, hi } = useChart();
  const lo = yAxis.domain?.[0] ?? 0;
  const b0 = Y(Math.max(base, lo));
  const gap = 2, bw = Math.max(1, (band.bar - gap * (groups - 1)) / groups);
  return (
    <g className="ck-bars">
      {values.map((v, i) => {
        if (!Number.isFinite(v)) return null;
        const x0 = band.start(i) + group * (bw + gap), yv = Y(v);
        const up = yv <= b0, h = Math.abs(b0 - yv), r = Math.min(3, bw / 2, h);
        const top = up ? yv : b0, bot = up ? b0 : yv;
        const d = up
          ? `M${x0},${bot}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${bot}Z`
          : `M${x0},${top}V${bot - r}Q${x0},${bot} ${x0 + r},${bot}H${x0 + bw - r}Q${x0 + bw},${bot} ${x0 + bw},${bot - r}V${top}Z`;
        const c = typeof color === "function" ? color(v, i) : color;
        return (
          <g key={i} className={hi != null && hi !== i ? "ck-dim" : undefined}>
            <path className="ck-bar" d={d} style={{ fill: c }}>{titles && <title>{titles(i)}</title>}</path>
            {labels && labels(i) && <text className="ck-val" x={x0 + bw / 2} y={up ? top - 5 : bot + 12} textAnchor="middle">{format(v)}</text>}
          </g>
        );
      })}
    </g>
  );
}

/* Horizontal (y = value) or vertical (x = value) reference line with an end label: limits such as 3 % VD, 0.95 pu. */
export function RefLine({ y, x, label: text, tone = "accent", align = "end", dash = "5 4" }) {
  const { X, Y, m, iw, ih } = useChart();
  if (y != null) {
    const py = Y(y);
    if (!Number.isFinite(py) || py < m.t - 0.5 || py > m.t + ih + 0.5) return null;
    const tx = align === "start" ? m.l + 4 : m.l + iw - 2;
    return (
      <g className={`ck-ref ck-tone-${tone}`}>
        <line x1={m.l} x2={m.l + iw} y1={py} y2={py} strokeDasharray={dash} />
        {text && <text x={tx} y={py - 5} textAnchor={align === "start" ? "start" : "end"}>{text}</text>}
      </g>
    );
  }
  const px = X(x);
  if (!Number.isFinite(px) || px < m.l - 0.5 || px > m.l + iw + 0.5) return null;
  return (
    <g className={`ck-ref ck-tone-${tone}`}>
      <line x1={px} x2={px} y1={m.t} y2={m.t + ih} strokeDasharray={dash} />
      {text && <text x={px + 4} y={m.t + 10}>{text}</text>}
    </g>
  );
}

/* Shaded acceptable band between two y values (e.g. 0.95 to 1.05 pu). */
export function Band({ y0, y1, tone = "ok" }) {
  const { Y, m, iw, ih } = useChart();
  const a = Math.max(m.t, Math.min(Y(y0), Y(y1))), b = Math.min(m.t + ih, Math.max(Y(y0), Y(y1)));
  if (!(b > a)) return null;
  return <rect className={`ck-zone ck-tone-${tone}`} x={m.l} y={a} width={iw} height={b - a} />;
}

/* Emphasised point with an optional value label above it. */
export function Dot({ x, y, color = "var(--accent)", label: text, r = 4.5 }) {
  const { X, Y, m } = useChart();
  const px = X(x), py = Y(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return (
    <g>
      <circle className="ck-dot-ring" cx={px} cy={py} r={r} style={{ fill: color }} />
      {text && <text className="ck-val" x={px} y={Math.max(m.t + 10, py - 10)} textAnchor="middle">{text}</text>}
    </g>
  );
}

/* Plot-area note in the top-left corner (e.g. "losses on their own scale"). */
export function Note({ children, y: dy = 0 }) {
  const { m } = useChart();
  return <text className="ck-note" x={m.l + 6} y={m.t + 12 + dy}>{children}</text>;
}
