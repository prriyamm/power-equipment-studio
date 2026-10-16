/* Pure view maths for the zoomable magnetic-field map (no DOM, no React): unit-tested in tests/fieldView.test.mjs.

   World units are mm in the cross-section plane (the conductors' own x/y). A *frame* is the full extent shown at
   zoom 1: { cx, cy, hw, hh } (centre and half-width / half-height). A *view* is { cx, cy, hw }: the visible
   window, always with the frame's aspect, so hh = hw * asp where asp = frame.hh / frame.hw. The grid has
   nx x ny cells whatever the zoom, so zooming recomputes the field on a smaller window at the same resolution
   instead of enlarging pixels. Plot fractions (fx, fy) are 0..1 from the left / top of the plot. */

export const MIN_HW_MM = 15;       // closest zoom: a 30 mm wide window, about one cable diameter and a bit
export const MAX_ZOOM_STEP = 4;    // one wheel event never changes the scale by more than this

export const aspectOf = (frame) => frame.hh / frame.hw;
export const fullView = (frame) => ({ cx: frame.cx, cy: frame.cy, hw: frame.hw });
export const zoomOf = (view, frame) => frame.hw / view.hw;
export const isFull = (view, frame) => Math.abs(view.hw - frame.hw) < 1e-9 && Math.abs(view.cx - frame.cx) < 1e-9 && Math.abs(view.cy - frame.cy) < 1e-9;

/* The window a view shows: x0 < x1, y0 < y1 (y up), plus its half-height. */
export function viewWindow(view, asp) {
  const hh = view.hw * asp;
  return { x0: view.cx - view.hw, x1: view.cx + view.hw, y0: view.cy - hh, y1: view.cy + hh, hh };
}

/* Keep the window inside the frame and the zoom within [MIN_HW_MM, frame.hw]. */
export function clampView(view, frame) {
  const asp = aspectOf(frame);
  const hw = Math.min(frame.hw, Math.max(Math.min(MIN_HW_MM, frame.hw), view.hw));
  const mx = frame.hw - hw, my = frame.hh - hw * asp;
  return {
    hw,
    cx: Math.min(frame.cx + mx, Math.max(frame.cx - mx, view.cx)),
    cy: Math.min(frame.cy + my, Math.max(frame.cy - my, view.cy)),
  };
}

/* World point under a plot fraction. */
export function pointAt(view, asp, fx, fy) {
  const hh = view.hw * asp;
  return { x: view.cx - view.hw + 2 * view.hw * fx, y: view.cy + hh - 2 * hh * fy };
}

/* Zoom by `factor` (> 1 zooms in) keeping the world point under (fx, fy) fixed (clamped at the limits). */
export function zoomAt(view, factor, fx, fy, frame) {
  const asp = aspectOf(frame);
  const f = Math.min(MAX_ZOOM_STEP, Math.max(1 / MAX_ZOOM_STEP, factor));
  const hw = Math.min(frame.hw, Math.max(Math.min(MIN_HW_MM, frame.hw), view.hw / f));
  const p = pointAt(view, asp, fx, fy);
  const hh = hw * asp;
  return clampView({ hw, cx: p.x + hw * (1 - 2 * fx), cy: p.y + hh * (2 * fy - 1) }, frame);
}

/* Drag the map by a fraction of the plot (dfx right, dfy down): the content follows the pointer. */
export function panBy(view, dfx, dfy, frame) {
  const asp = aspectOf(frame);
  return clampView({ hw: view.hw, cx: view.cx - 2 * view.hw * dfx, cy: view.cy + 2 * view.hw * asp * dfy }, frame);
}

/* Box zoom: the smallest view with the frame's aspect that contains the dragged rectangle. */
export function boxView(view, fx0, fy0, fx1, fy1, frame) {
  const asp = aspectOf(frame);
  const a = pointAt(view, asp, Math.min(fx0, fx1), Math.min(fy0, fy1)), b = pointAt(view, asp, Math.max(fx0, fx1), Math.max(fy0, fy1));
  const w = b.x - a.x, h = a.y - b.y;
  const hw = Math.max(w / 2, h / 2 / asp);
  return clampView({ hw, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }, frame);
}

/* Where a previously computed view sits inside the current one, as plot fractions { x, y, w, h }: draw the old
   image there at once while the new grid is computed. */
export function imageRect(shown, target, asp) {
  const s = viewWindow(shown, asp), t = viewWindow(target, asp);
  return { x: (s.x0 - t.x0) / (2 * target.hw), y: (t.y1 - s.y1) / (2 * t.hh), w: shown.hw / target.hw, h: shown.hw / target.hw };
}

/* World position of the centre of cell (i, j) (row 0 at the top) on an nx-wide grid. */
export function cellCenter(view, asp, nx, i, j) {
  const cell = (2 * view.hw) / nx, hh = view.hw * asp;
  return { x: view.cx - view.hw + (i + 0.5) * cell, y: view.cy + hh - (j + 0.5) * cell };
}

/* Grid rows for a frame: ny follows the frame aspect so the cells are square. */
export const gridRows = (nx, asp) => Math.max(1, Math.ceil(nx * asp - 1e-9));

/* Field on the window of `view`: sample(x_mm, y_mm) at every cell centre, row-major, row 0 at the top. */
export function sampleGrid(view, asp, nx, ny, sample) {
  const out = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = cellCenter(view, asp, nx, i, j);
    out[j * nx + i] = sample(p.x, p.y);
  }
  return out;
}

/* Round tick step (1, 2 or 5 x 10^k mm) giving about `target` ticks over `span` mm. */
export function niceStep(span, target = 4) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/* Tick positions (multiples of step) inside [lo, hi]. */
export function ticksIn(lo, hi, step) {
  const out = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) out.push(Math.round(k * step * 1e6) / 1e6);
  return out;
}

/* Axis label for a mm distance: metres at 1 m steps and above, else mm. */
export function axisLabel(mm, step) {
  if (step >= 1000) return `${Math.round(mm / 10) / 100} m`;
  return `${Math.round(mm * 10) / 10} mm`;
}
