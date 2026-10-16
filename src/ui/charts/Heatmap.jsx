/* Canvas heatmap for large grids (thousands of cells): one ImageData blit per redraw instead of an SVG rect per
   cell. devicePixelRatio-aware (capped at 2), hover/touch readout, SVG colour bar, and an optional SVG overlay in
   the grid's own units (enclosure outline, conductors, scale bar). figureSvg() in reportButton.jsx turns the
   canvas into an <image> so the calculation package still gets the figure. React is the global UMD build. */
const { useRef, useEffect, useState, useMemo } = React;
import { useWidth } from "./Chart.jsx";
import { hexToRgb, rampAt, normalize, rampCss } from "./colors.js";

const toRgb = (c) => (Array.isArray(c) ? c : typeof c === "string" && c[0] === "#" ? hexToRgb(c) : [0, 0, 0]);

/**
 * values: row-major numbers, row 0 at the top, length nx * ny.
 * color(v) -> "#rrggbb" | [r, g, b]. Or pass legend.stops + legend.domain for a continuous ramp.
 * legend: { steps: [{ max, color, label }], unit } (binned) or { stops, domain, log, unit, ticks } (continuous).
 * overlay: { viewBox: "minx miny w h", children } drawn on top, same extent as the grid.
 * readout(i, j, v) -> string for the hover box.
 */
export function Heatmap({ nx, ny, values, color, legend, overlay, readout, ariaLabel, reportTitle, maxHeight = 520 }) {
  const wrapRef = useRef(null), canvasRef = useRef(null);
  const cw = useWidth(wrapRef, 560);
  const vb = overlay?.viewBox ? overlay.viewBox.split(/[ ,]+/).map(Number) : [0, 0, nx, ny];
  const aspect = vb[3] / vb[2];
  const W = Math.max(120, Math.min(cw, maxHeight / aspect)), H = Math.round(W * aspect);
  const [hover, setHover] = useState(null);

  const colorOf = useMemo(() => {
    if (color) return (v) => toRgb(color(v));
    const { stops, domain, log } = legend;
    return (v) => rampAt(stops, normalize(v, domain, log)) || [0, 0, 0];
  }, [color, legend]);

  // the grid image at one pixel per cell; scaled up without smoothing so cells stay crisp
  const img = useMemo(() => {
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas"); c.width = nx; c.height = ny;
    const g = c.getContext("2d"); if (!g) return null;
    const data = g.createImageData(nx, ny);
    for (let k = 0; k < nx * ny; k++) {
      const [r, gg, b] = colorOf(values[k]);
      data.data[4 * k] = r; data.data[4 * k + 1] = gg; data.data[4 * k + 2] = b; data.data[4 * k + 3] = 255;
    }
    g.putImageData(data, 0, 0);
    return c;
  }, [values, nx, ny, colorOf]);

  useEffect(() => {
    const cv = canvasRef.current; if (!cv || !img) return;
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d"); if (!g) return;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, cv.width, cv.height);
  }, [img, W, H]);

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) { setHover(null); return; }
    const i = Math.floor(fx * nx), j = Math.floor(fy * ny);
    setHover({ i, j, px: fx * W, py: fy * H });
  };
  const v = hover ? values[hover.j * nx + hover.i] : null;

  return (
    <div className="ck-heat" ref={wrapRef} data-report-fig={reportTitle || undefined}>
      <div className="ck-heat-plot" style={{ width: W, height: H }} onPointerMove={onMove} onPointerDown={onMove}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)} role="img" aria-label={ariaLabel}>
        <canvas ref={canvasRef} className="ck-heat-canvas" style={{ width: W, height: H }} />
        {overlay && <svg className="ck-heat-overlay" viewBox={overlay.viewBox} width={W} height={H} preserveAspectRatio="none" aria-hidden="true">{overlay.children}</svg>}
        {hover && (<>
          <div className="ck-heat-cell" data-noexport="1" style={{ left: (hover.i * W) / nx, top: (hover.j * H) / ny, width: W / nx, height: H / ny }} />
          <div className="ck-tip ck-heat-tip" style={{ left: hover.px + 14 + 180 > W ? Math.max(4, hover.px - 194) : hover.px + 14, top: Math.max(4, Math.min(H - 48, hover.py - 20)) }} role="status">
            <div className="ck-tip-r"><i style={{ background: `rgb(${colorOf(v).join(",")})` }} /><span>{readout ? readout(hover.i, hover.j, v) : String(v)}</span></div>
          </div>
        </>)}
      </div>
      {legend && <ColorBar legend={legend} width={Math.min(W, 520)} />}
    </div>
  );
}

/* Colour bar as SVG (exported with the figure): binned swatches with range labels, or a continuous gradient. */
export function ColorBar({ legend, width = 420 }) {
  const unit = legend.unit ? ` ${legend.unit}` : "";
  const id = useMemo(() => "ckg" + Math.random().toString(36).slice(2, 8), []);
  if (legend.steps) {
    const n = legend.steps.length, gap = 2, sw = (width - gap * (n - 1)) / n;
    return (
      <svg className="ck-colorbar" viewBox={`0 0 ${width} 34`} width={width} height={34} role="img" aria-label={`Colour scale${unit}`}>
        {legend.steps.map((s, k) => (
          <g key={k} transform={`translate(${k * (sw + gap)} 0)`}>
            <rect width={sw} height="8" rx={k === 0 || k === n - 1 ? 2 : 0} style={{ fill: s.color }} />
            <text x={sw / 2} y="22" textAnchor="middle">{s.label}</text>
          </g>
        ))}
        {unit && <text x={width} y="33" textAnchor="end" className="ck-colorbar-u">{legend.unit}</text>}
      </svg>
    );
  }
  const ticks = legend.ticks || legend.domain;
  const pos = (t) => normalize(t, legend.domain, legend.log) * width;
  return (
    <svg className="ck-colorbar" viewBox={`0 0 ${width} 34`} width={width} height={34} role="img" aria-label={`Colour scale${unit}`}>
      <defs><linearGradient id={id}>{legend.stops.map(([t, c]) => <stop key={t} offset={t} stopColor={c} />)}</linearGradient></defs>
      <rect width={width} height="8" rx="2" fill={`url(#${id})`} />
      {ticks.map((t) => <text key={t} x={Math.max(10, Math.min(width - 10, pos(t)))} y="22" textAnchor="middle">{t}</text>)}
      {unit && <text x={width} y="33" textAnchor="end" className="ck-colorbar-u">{legend.unit}</text>}
    </svg>
  );
}

export { rampCss };
