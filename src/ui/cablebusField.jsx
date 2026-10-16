/* Cable bus Check tab: magnetic-field map with zoom and pan.

   The map is a canvas Heatmap (charts/Heatmap.jsx) of |B| at the cross-section plane. Wheel zooms about the cursor,
   drag pans, Shift+drag zooms to a box, and +/-/Reset buttons do the same. Every view change recomputes the field
   on the visible window at the same grid size (view maths in fieldView.js), so zooming reveals real detail near the
   conductors, not enlarged pixels. While the new grid is computed (debounced, about 100 ms) the previous image is
   drawn scaled and moved into place. The calculation package captures whatever view is on screen. */
const { useState, useMemo, useEffect, useRef } = React;
import { Btn, cx, fmt } from "./common.jsx";
import { Heatmap, PHASE_VAR, SEQ_STOPS } from "./charts/index.js";
import { useQuality, fieldGridNx } from "./quality.js";
import { buildLayout, cableBusGroups } from "../engine/pecalc/cablebus.js";
import { solveSharing } from "../engine/pecalc/impedance.js";
import { bRmsUt, LIMITS_UT } from "../engine/pecalc/field.js";
import {
  aspectOf, fullView, isFull, zoomOf, viewWindow, clampView, zoomAt, panBy, boxView, imageRect, cellCenter,
  gridRows, sampleGrid, niceStep, ticksIn, axisLabel,
} from "./fieldView.js";

const CSS = `
.fm-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
.fm-tools .btn { padding: 3px 9px; min-width: 30px; justify-content: center; font-family: var(--font-data); }
.fm-zoom { font-family: var(--font-data); font-size: 12px; color: var(--muted); margin-left: 4px; }
.fm-seg { display: inline-flex; margin-left: auto; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.fm-seg .btn { padding: 3px 8px; font-size: 12px; font-family: var(--font-ui); }
.fm-wrap { position: relative; }
.fm-wrap .ck-heat-plot { cursor: grab; touch-action: pan-y; user-select: none; }
.fm-wrap.is-pan .ck-heat-plot { cursor: grabbing; }
.fm-wrap.is-box .ck-heat-plot { cursor: crosshair; }
.fm-wrap.is-pan .ck-heat-tip, .fm-wrap.is-pan .ck-heat-cell, .fm-wrap.is-box .ck-heat-tip, .fm-wrap.is-box .ck-heat-cell { display: none; }
.fm-box { position: absolute; border: 1.5px dashed var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); pointer-events: none; }
`;

/* Binned scale: sequential blues below the ICNIRP 1998 public reference level, status colours above it. */
const LIM_UT = LIMITS_UT["ICNIRP 1998 public"];
const FIELD_STEPS = [
  { max: 1, color: "#0f2336", label: "< 1" },
  { max: 3, color: "#174a78", label: "1–3" },
  { max: 10, color: "#256abf", label: "3–10" },
  { max: 30, color: "#5598e7", label: "10–30" },
  { max: LIM_UT, color: "#b7d3f6", label: `30–${LIM_UT}` },
  { max: 200, color: "#ff8b4a", label: `${LIM_UT}–200` },
  { max: Infinity, color: "#ff5f5f", label: "> 200" },
];
const fieldColor = (b) => FIELD_STEPS.find((s) => b < s.max).color;
const FIXED_LEGEND = { steps: FIELD_STEPS, unit: "µT" };
const AUTO_ZOOM = 3;      // zoom at which the scale switches to "auto" by itself (until the user picks one)

/* Log colour scale fitted to the window: decade ticks plus the end values. */
function autoLegend(lo, hi) {
  const ticks = [];
  for (let e = Math.ceil(Math.log10(lo)); 10 ** e <= hi; e++) ticks.push(10 ** e);
  const r = (v) => Number((v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toPrecision(2)));
  const all = [r(lo), ...ticks.filter((t) => t > lo * 1.5 && t < hi / 1.5), r(hi)];
  return { stops: SEQ_STOPS, domain: [lo, hi], log: true, unit: "µT", ticks: all };
}

export function FieldMap({ inp: liveInp, res: liveRes }) {
  // the sharing solve is heavy: defer it so typing in the inputs stays responsive
  const inp = React.useDeferredValue(liveInp), res = React.useDeferredValue(liveRes);
  const q = useQuality();
  const nx = fieldGridNx(q.tier);

  /* geometry, current sharing and the full (zoom 1) frame; heavy part, once per input change */
  const base = useMemo(() => {
    const od = res.cable_od_mm;
    const cs = buildLayout(inp, res.pattern, od, res.cable_data);
    const sol = solveSharing(cs, cableBusGroups(inp, inp.shield_bonding === "both_ends"), inp.frequency_hz);
    const xs = res.conductors.map((c) => c.x_mm), ys = res.conductors.map((c) => c.y_mm);
    const xc = (Math.min(...xs) + Math.max(...xs)) / 2, yc = (Math.min(...ys) + Math.max(...ys)) / 2;
    const encW = inp.enclosure_width_mm || Math.max(...xs) - Math.min(...xs) + 2 * od;
    const encH = inp.enclosure_height_mm || Math.max(...ys) - Math.min(...ys) + 2 * od;
    const hw = encW / 2 + 1500, halfH = encH / 2 + 1000;
    const ny = gridRows(nx, halfH / hw);
    const frame = { cx: xc, cy: yc, hw, hh: (hw * ny) / nx };
    const sample = (x, y) => bRmsUt(cs, sol.currents, x, y);
    return { cs, sol, xc, yc, encW, encH, od, rows: res.conductors, ny, frame, asp: aspectOf(frame), sample };
  }, [inp, res, nx]);
  const { frame, asp, ny, xc, yc, encW, encH, od, rows, sample } = base;

  /* the full view is always available (peak beyond the enclosure, instant reset) */
  const full = useMemo(() => {
    const values = sampleGrid(fullView(frame), asp, nx, ny, sample);
    let peak = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = cellCenter(fullView(frame), asp, nx, i, j);
      const outside = Math.abs(p.x - xc) > encW / 2 + 40 || Math.abs(p.y - yc) > encH / 2 + 40;
      if (outside && values[j * nx + i] > peak) peak = values[j * nx + i];
    }
    return { values, peak };
  }, [base]);

  /* view: zoom/pan state; reset when the geometry changes */
  const frameKey = `${frame.cx}|${frame.cy}|${frame.hw}|${frame.hh}`;
  const [viewRaw, setViewRaw] = useState(() => fullView(frame));
  const view = useMemo(() => clampView(viewRaw, frame), [viewRaw, frameKey]);
  useEffect(() => { setViewRaw(fullView(frame)); }, [frameKey]);
  const live = useRef({});
  live.current = { frame, view };
  const setView = (fn) => setViewRaw((prev) => fn(clampView(prev, live.current.frame), live.current.frame));
  const zoom = zoomOf(view, frame);
  const atFull = isFull(view, frame);

  /* grid for the visible window, recomputed shortly after the view settles */
  const [shown, setShown] = useState(null);
  const lastRun = useRef(0);
  const current = shown && shown.base === base && shown.view.cx === view.cx && shown.view.cy === view.cy && shown.view.hw === view.hw;
  useEffect(() => {
    if (atFull || current) return undefined;
    const idle = performance.now() - lastRun.current > 250;       // first step after a pause: compute at once
    const id = setTimeout(() => {
      const t0 = performance.now();
      const values = sampleGrid(view, asp, nx, ny, sample);
      lastRun.current = performance.now();
      setShown({ base, view, values, ms: lastRun.current - t0 });
    }, idle ? 0 : 100);
    return () => clearTimeout(id);
  }, [view, base, atFull, current]);
  // what is drawn: the exact grid, else the last grid of these inputs (scaled into place), else the full view
  const img = atFull ? { view: fullView(frame), values: full.values }
    : current || (shown && shown.base === base) ? shown : { view: fullView(frame), values: full.values };
  const rect = isFull(img.view, view) ? null : imageRect(img.view, view, asp);

  /* colour scale: fixed ICNIRP bins, or a log ramp fitted to the window (cells under the cable discs excluded) */
  const [scale, setScale] = useState({ mode: "fixed", user: false });
  useEffect(() => {
    setScale((s) => (s.user ? s : { ...s, mode: zoom >= AUTO_ZOOM ? "auto" : "fixed" }));
  }, [zoom >= AUTO_ZOOM]);
  const legend = useMemo(() => {
    if (scale.mode !== "auto") return FIXED_LEGEND;
    const r2 = (od / 2) ** 2;
    let lo = Infinity, hi = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = img.values[j * nx + i];
      if (!(v > 0)) continue;
      const p = cellCenter(img.view, asp, nx, i, j);
      if (rows.some((c) => (p.x - c.x_mm) ** 2 + (p.y - c.y_mm) ** 2 < r2)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > 0)) return FIXED_LEGEND;
    return autoLegend(Math.max(lo, hi / 1000), Math.max(hi, lo * 1.01));
  }, [scale.mode, img.values, img.view.cx, img.view.cy, img.view.hw, rows, od, nx, ny]);

  /* pointer interaction: wheel zoom about the cursor, drag pan, Shift+drag box */
  const boxRef = useRef(null);
  const [drag, setDrag] = useState(null);          // "pan" | "box" | null
  const [sel, setSel] = useState(null);            // box selection in plot pixels
  useEffect(() => {
    const root = boxRef.current, plot = root && root.querySelector(".ck-heat-plot");
    if (!plot) return undefined;
    const frac = (e) => { const r = plot.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, r }; };
    let st = null;
    const onWheel = (e) => {
      e.preventDefault();
      const { fx, fy } = frac(e);
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      setView((v, fr) => zoomAt(v, f, fx, fy, fr));
    };
    const onDown = (e) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      const { fx, fy } = frac(e);
      st = e.shiftKey ? { mode: "box", fx, fy, x: e.clientX, y: e.clientY } : { mode: "pan", x: e.clientX, y: e.clientY };
      try { plot.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      setDrag(st.mode);
    };
    const onMove = (e) => {
      if (!st) return;
      const r = plot.getBoundingClientRect();
      if (st.mode === "pan") {
        const dx = e.clientX - st.x, dy = e.clientY - st.y;
        st.x = e.clientX; st.y = e.clientY;
        setView((v, fr) => panBy(v, dx / r.width, dy / r.height, fr));
      } else {
        const x0 = Math.min(st.x, e.clientX) - r.left, x1 = Math.max(st.x, e.clientX) - r.left;
        const y0 = Math.min(st.y, e.clientY) - r.top, y1 = Math.max(st.y, e.clientY) - r.top;
        setSel({ x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(r.width, x1) - Math.max(0, x0), h: Math.min(r.height, y1) - Math.max(0, y0) });
      }
    };
    const onUp = (e) => {
      if (!st) return;
      if (st.mode === "box") {
        const { fx, fy, r } = frac(e);
        if (Math.abs(e.clientX - st.x) > 6 && Math.abs(e.clientY - st.y) > 6) {
          const a = { fx: Math.max(0, Math.min(1, st.fx)), fy: Math.max(0, Math.min(1, st.fy)) };
          setView((v, fr) => boxView(v, a.fx, a.fy, Math.max(0, Math.min(1, fx)), Math.max(0, Math.min(1, fy)), fr));
        }
      }
      st = null; setDrag(null); setSel(null);
      try { plot.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
    };
    const onDbl = (e) => { const { fx, fy } = frac(e); setView((v, fr) => zoomAt(v, 2, fx, fy, fr)); };
    plot.addEventListener("wheel", onWheel, { passive: false });
    plot.addEventListener("pointerdown", onDown);
    plot.addEventListener("pointermove", onMove);
    plot.addEventListener("pointerup", onUp);
    plot.addEventListener("pointercancel", onUp);
    plot.addEventListener("dblclick", onDbl);
    return () => {
      plot.removeEventListener("wheel", onWheel); plot.removeEventListener("pointerdown", onDown);
      plot.removeEventListener("pointermove", onMove); plot.removeEventListener("pointerup", onUp);
      plot.removeEventListener("pointercancel", onUp); plot.removeEventListener("dblclick", onDbl);
    };
  }, []);

  /* hover readout: |B| at the centre of the cell under the cursor, computed exactly for the window on screen */
  const readout = (i, j) => {
    const p = cellCenter(view, asp, nx, i, j);
    const b = sample(p.x, p.y);
    const dx = p.x - xc, dy = p.y - yc;
    const pos = view.hw < 600 ? `x ${fmt(dx, 1)} mm, y ${fmt(dy, 1)} mm` : `x ${fmt(dx / 1000, 2)} m, y ${fmt(dy / 1000, 2)} m`;
    return `${pos}: ${fmt(b, b < 10 ? 2 : b < 1000 ? 1 : 0)} µT`;
  };

  const w = viewWindow(view, asp), Wd = 2 * view.hw, Ht = 2 * w.hh;
  const X = (x) => x - w.x0, Y = (y) => w.y1 - y;
  const step = niceStep(Wd, 4), stepY = niceStep(Ht, 3);
  const widthLabel = Wd >= 1000 ? `${fmt(Wd / 1000, 2)} m` : `${fmt(Wd, 0)} mm`;
  const title = "Magnetic field around the enclosure" + (atFull ? "" : `, zoomed ×${fmt(zoom, 1)} (${widthLabel} wide, centred ${fmt(view.cx - xc, 0)}, ${fmt(view.cy - yc, 0)} mm from the cable centre)`);
  const pickScale = (mode) => setScale({ mode, user: true });

  return (
    <div>
      <style>{CSS}</style>
      <div className="fm-tools" role="toolbar" aria-label="Field map zoom">
        <Btn onClick={() => setView((v, fr) => zoomAt(v, 1.6, 0.5, 0.5, fr))} title="Zoom in (or scroll the mouse wheel over the map)">+</Btn>
        <Btn onClick={() => setView((v, fr) => zoomAt(v, 1 / 1.6, 0.5, 0.5, fr))} disabled={atFull} title="Zoom out">−</Btn>
        <Btn onClick={() => setViewRaw(fullView(frame))} disabled={atFull} title="Back to the full view">Reset</Btn>
        <span className="fm-zoom" aria-live="polite">{atFull ? "full view" : `×${fmt(zoom, 1)} · ${widthLabel} wide`}</span>
        <span className="fm-seg" role="group" aria-label="Colour scale">
          Scale
          <Btn active={scale.mode === "fixed"} onClick={() => pickScale("fixed")} title="Fixed bins with the ICNIRP public reference level">Fixed</Btn>
          <Btn active={scale.mode === "auto"} onClick={() => pickScale("auto")} title="Log colour scale fitted to the visible window">Fit view</Btn>
        </span>
      </div>
      <div className={cx("fm-wrap", drag && `is-${drag}`)} ref={boxRef} data-recompute-ms={shown ? shown.ms.toFixed(1) : undefined} data-grid={`${nx}x${ny}`}>
        <Heatmap nx={nx} ny={ny} values={img.values} color={scale.mode === "auto" ? undefined : fieldColor} legend={legend} imageRect={rect}
          ariaLabel="Magnetic flux density around the enclosure" reportTitle={title} readout={readout}
          overlay={{ viewBox: `0 0 ${Wd} ${Ht}`, children: (k) => (<>
            <rect x={X(xc - encW / 2)} y={Y(yc + encH / 2)} width={encW} height={encH} fill="none" stroke="#c3ced7" strokeWidth={1.5 / k} strokeDasharray={`${6 / k} ${4 / k}`} />
            {rows.map((r) => <circle key={r.index} cx={X(r.x_mm)} cy={Y(r.y_mm)} r={Math.max(od / 2, 3 / k)} fill={PHASE_VAR[r.phase]} stroke="#0a0f14" strokeWidth={1 / k} />)}
            {ticksIn(w.x0 - xc, w.x1 - xc, step).map((m) => <g key={`x${m}`}>
              <line x1={X(xc + m)} x2={X(xc + m)} y1={Ht - 12 / k} y2={Ht - 4 / k} stroke="#d6dfe6" strokeWidth={1.5 / k} />
              <text x={X(xc + m)} y={Ht - 16 / k} textAnchor="middle" fontSize={11 / k} fill="#d6dfe6" fontFamily="IBM Plex Mono, monospace" paintOrder="stroke" stroke="#0a0f14" strokeWidth={3 / k}>{axisLabel(m, step)}</text>
            </g>)}
            {ticksIn(w.y0 - yc, w.y1 - yc, stepY).filter((m) => Y(yc + m) < Ht - 34 / k).map((m) => <g key={`y${m}`}>
              <line y1={Y(yc + m)} y2={Y(yc + m)} x1={4 / k} x2={12 / k} stroke="#d6dfe6" strokeWidth={1.5 / k} />
              <text y={Y(yc + m) + 4 / k} x={16 / k} fontSize={11 / k} fill="#d6dfe6" fontFamily="IBM Plex Mono, monospace" paintOrder="stroke" stroke="#0a0f14" strokeWidth={3 / k}>{axisLabel(m, stepY)}</text>
            </g>)}
          </>) }} />
        {sel && <PlotBox boxRef={boxRef} sel={sel} />}
      </div>
      <div className="ck-caption">
        RMS resultant at the cross-section plane (all conductors, shields and enclosure walls). Beyond the enclosure the peak is <b>{fmt(full.peak, 1)} µT</b>; ICNIRP 1998 public reference level {LIM_UT} µT.
        {" "}Scroll to zoom at the cursor, drag to pan, Shift+drag to zoom to a box, double-click to zoom in. Each view recomputes the field on the visible window ({nx} × {ny} cells), axes in mm from the cable centre.
        {scale.mode === "auto" && " Colour scale fitted to this window: log scale, cells under the cables left out of the range."}
      </div>
    </div>
  );
}

/* The Shift+drag selection rectangle, positioned over the plot (not part of the exported figure). */
function PlotBox({ boxRef, sel }) {
  const plot = boxRef.current && boxRef.current.querySelector(".ck-heat-plot");
  const off = plot ? { left: plot.offsetLeft, top: plot.offsetTop } : { left: 0, top: 0 };
  return <div className="fm-box" data-noexport="1" style={{ left: off.left + sel.x, top: off.top + sel.y, width: sel.w, height: sel.h }} />;
}
