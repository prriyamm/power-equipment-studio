// Magnetic-field map zoom: pure view maths (src/ui/fieldView.js) and the window -> grid mapping.
import test from "node:test";
import assert from "node:assert/strict";

import {
  aspectOf, fullView, isFull, zoomOf, viewWindow, clampView, pointAt, zoomAt, panBy, boxView, imageRect,
  cellCenter, gridRows, sampleGrid, niceStep, ticksIn, axisLabel, MIN_HW_MM,
} from "../src/ui/fieldView.js";
import { fieldGridNx } from "../src/ui/quality.js";
import { bRmsUt } from "../src/engine/pecalc/field.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
// 800 x 150 mm enclosure example: half-width 400 + 1500, 64 columns
const NX = 64;
const FR0 = { cx: 100, cy: 20, hw: 1900, hh: 1075 };
const NY = gridRows(NX, FR0.hh / FR0.hw);
const FRAME = { ...FR0, hh: (FR0.hw * NY) / NX };
const ASP = aspectOf(FRAME);

test("gridRows keeps square cells and matches the old ceil(2 halfH / cell)", () => {
  const cell = (2 * 1900) / 64;
  assert.equal(gridRows(64, 1075 / 1900), Math.ceil((2 * 1075) / cell));
  near(FRAME.hh * 2 / NY, cell);                    // cell height = cell width
  assert.equal(gridRows(48, 1), 48);
});

test("full view covers the frame", () => {
  const v = fullView(FRAME);
  assert.ok(isFull(v, FRAME));
  assert.equal(zoomOf(v, FRAME), 1);
  const w = viewWindow(v, ASP);
  near(w.x0, FRAME.cx - FRAME.hw); near(w.x1, FRAME.cx + FRAME.hw);
  near(w.y0, FRAME.cy - FRAME.hh); near(w.y1, FRAME.cy + FRAME.hh);
});

test("zoomAt keeps the world point under the cursor fixed", () => {
  const v0 = fullView(FRAME);
  for (const [fx, fy, f] of [[0.5, 0.5, 2], [0.25, 0.7, 3], [0.9, 0.1, 1.5], [0.4, 0.6, 4]]) {
    const before = pointAt(v0, ASP, fx, fy);
    const v1 = zoomAt(v0, f, fx, fy, FRAME);
    near(zoomOf(v1, FRAME), f, 1e-9);
    const after = pointAt(v1, ASP, fx, fy);
    // keeps the point fixed unless the pan clamp had to move the window to stay inside the frame
    const w = viewWindow(v1, ASP);
    const clamped = Math.abs(w.x0 - (FRAME.cx - FRAME.hw)) < 1e-9 || Math.abs(w.x1 - (FRAME.cx + FRAME.hw)) < 1e-9 ||
      Math.abs(w.y0 - (FRAME.cy - FRAME.hh)) < 1e-9 || Math.abs(w.y1 - (FRAME.cy + FRAME.hh)) < 1e-9;
    if (!clamped) { near(after.x, before.x, 1e-6); near(after.y, before.y, 1e-6); }
  }
  // centre zoom is never clamped
  const c = zoomAt(v0, 2, 0.5, 0.5, FRAME);
  near(c.cx, FRAME.cx); near(c.cy, FRAME.cy); near(c.hw, FRAME.hw / 2);
});

test("repeated zoom about an off-centre point keeps that point fixed while inside the frame", () => {
  let v = fullView(FRAME);
  const fx = 0.5, fy = 0.5;
  v = zoomAt(v, 2, fx, fy, FRAME);
  const target = pointAt(v, ASP, 0.3, 0.4);
  const v2 = zoomAt(v, 2, 0.3, 0.4, FRAME);
  const p2 = pointAt(v2, ASP, 0.3, 0.4);
  near(p2.x, target.x, 1e-6); near(p2.y, target.y, 1e-6);
  near(v2.hw, FRAME.hw / 4);
});

test("zoom limits: not beyond the full view, not closer than MIN_HW_MM", () => {
  const out = zoomAt(fullView(FRAME), 1 / 3, 0.2, 0.2, FRAME);
  assert.ok(isFull(out, FRAME));
  let v = fullView(FRAME);
  for (let k = 0; k < 20; k++) v = zoomAt(v, 4, 0.5, 0.5, FRAME);
  near(v.hw, MIN_HW_MM);
  // one wheel event changes the scale by at most 4x
  near(zoomAt(fullView(FRAME), 100, 0.5, 0.5, FRAME).hw, FRAME.hw / 4);
});

test("panBy moves the content with the pointer and stays inside the frame", () => {
  const v = zoomAt(fullView(FRAME), 4, 0.5, 0.5, FRAME);         // hw = 475
  // drag right by a quarter of the plot: the content moves right, so the window moves left by hw/2
  const p = panBy(v, 0.25, 0, FRAME);
  near(p.cx, v.cx - v.hw / 2); near(p.cy, v.cy);
  // drag down by a quarter: the window moves up by hh/2
  const q = panBy(v, 0, 0.25, FRAME);
  near(q.cy, v.cy + (v.hw * ASP) / 2);
  // huge drag: clamped so the window stays inside the frame
  const far = panBy(v, -10, 10, FRAME);
  const w = viewWindow(far, ASP);
  near(w.x1, FRAME.cx + FRAME.hw); near(w.y1, FRAME.cy + FRAME.hh);
  // at the full view nothing can pan
  assert.ok(isFull(panBy(fullView(FRAME), 0.4, 0.4, FRAME), FRAME));
});

test("boxView fits the dragged rectangle with the frame aspect", () => {
  const v0 = fullView(FRAME);
  // a wide, short box: width limits
  const b = boxView(v0, 0.4, 0.45, 0.6, 0.5, FRAME);
  const w = viewWindow(b, ASP);
  const a = pointAt(v0, ASP, 0.4, 0.45), c = pointAt(v0, ASP, 0.6, 0.5);
  assert.ok(w.x0 <= a.x + 1e-9 && w.x1 >= c.x - 1e-9 && w.y0 <= c.y + 1e-9 && w.y1 >= a.y - 1e-9);
  near(b.hw, (c.x - a.x) / 2);
  near(b.cx, (a.x + c.x) / 2);
  // reversed corners give the same view
  const r = boxView(v0, 0.6, 0.5, 0.4, 0.45, FRAME);
  near(r.hw, b.hw); near(r.cx, b.cx); near(r.cy, b.cy);
  // a tall, narrow box: height limits
  const t = boxView(v0, 0.49, 0.2, 0.51, 0.8, FRAME);
  const ta = pointAt(v0, ASP, 0.49, 0.2), tb = pointAt(v0, ASP, 0.51, 0.8);
  near(t.hw, (ta.y - tb.y) / 2 / ASP);
  // tiny boxes stop at the closest zoom
  near(boxView(v0, 0.5, 0.5, 0.5001, 0.5001, FRAME).hw, MIN_HW_MM);
});

test("cell centres: window -> grid mapping", () => {
  const v = fullView(FRAME), cell = (2 * v.hw) / NX;
  const c00 = cellCenter(v, ASP, NX, 0, 0);
  near(c00.x, FRAME.cx - FRAME.hw + cell / 2);
  near(c00.y, FRAME.cy + FRAME.hh - cell / 2);                  // row 0 is the top
  const last = cellCenter(v, ASP, NX, NX - 1, NY - 1);
  near(last.x, FRAME.cx + FRAME.hw - cell / 2);
  near(last.y, FRAME.cy - FRAME.hh + cell / 2);
  // zoomed: same grid, smaller cells
  const z = zoomAt(v, 4, 0.5, 0.5, FRAME);
  near((2 * z.hw) / NX, cell / 4);
  const zc = cellCenter(z, ASP, NX, NX / 2, NY / 2);
  near(zc.x, z.cx + (z.hw / NX)); near(zc.y, z.cy - (z.hw / NX));
});

test("sampleGrid samples the visible window at every cell centre, same size at every zoom", () => {
  const f = (x, y) => 1000 * x + y;                              // linear: the cell mean equals the centre value
  const v = zoomAt(fullView(FRAME), 3, 0.3, 0.4, FRAME);
  const g = sampleGrid(v, ASP, NX, NY, f);
  assert.equal(g.length, NX * NY);
  for (const [i, j] of [[0, 0], [10, 7], [NX - 1, NY - 1], [31, 20]]) {
    const p = cellCenter(v, ASP, NX, i, j);
    near(g[j * NX + i], f(p.x, p.y));
  }
  // x grows to the right, y falls going down the rows
  assert.ok(g[1] > g[0] && g[NX] < g[0]);
  assert.equal(sampleGrid(fullView(FRAME), ASP, NX, NY, f).length, g.length);
});

test("zooming on a conductor resolves detail: a real field near a filament, not enlarged cells", () => {
  const I = [{ re: 1000, im: 0 }];
  const frame = { cx: 0, cy: 0, hw: 1900, hh: 1075 };
  const ny = gridRows(NX, frame.hh / frame.hw), fr = { ...frame, hh: (frame.hw * ny) / NX };
  const asp = aspectOf(fr);
  // offset the filament from every cell centre of the full grid
  const full = sampleGrid(fullView(fr), asp, NX, ny, (x, y) => bRmsUt([{ x_mm: 13, y_mm: 7 }], I, x, y));
  let v = fullView(fr);
  for (let k = 0; k < 4; k++) v = zoomAt(v, 4, 0.5, 0.5, fr);
  const zoomed = sampleGrid(v, asp, NX, ny, (x, y) => bRmsUt([{ x_mm: 13, y_mm: 7 }], I, x, y));
  const distinct = (a) => new Set(Array.from(a, (x) => x.toFixed(6))).size;
  assert.ok(distinct(zoomed) > 1000, "every zoomed cell has its own value");
  assert.ok(zoomed.length === full.length);
  // spot value: B = mu0 I / (2 pi r) = 2e-7 * 1000 / r(m)
  const p = cellCenter(v, asp, NX, 40, 10), r = Math.hypot(p.x - 13, p.y - 7) / 1000;
  near(zoomed[10 * NX + 40], (2e-7 * 1000 / r) * 1e6, 1e-9 * zoomed[10 * NX + 40]);
});

test("imageRect places the previous grid inside the new view", () => {
  const v0 = fullView(FRAME);
  assert.deepEqual(Object.values(imageRect(v0, v0, ASP)).map((x) => Math.round(x * 1e9) / 1e9), [0, 0, 1, 1]);
  // zoom in x2 about the centre: the old image is twice as large, centred (x from -0.5 to 1.5)
  const z = zoomAt(v0, 2, 0.5, 0.5, FRAME);
  const r = imageRect(v0, z, ASP);
  near(r.w, 2); near(r.h, 2); near(r.x, -0.5); near(r.y, -0.5);
  // zoom out again: the old (zoomed) image occupies the middle quarter of the area
  const back = imageRect(z, v0, ASP);
  near(back.w, 0.5); near(back.x, 0.25); near(back.y, 0.25);
  // pan: window moved right by a quarter -> old content shifted left by a quarter of the plot
  const pz = panBy(z, -0.25, 0, FRAME);                          // content follows pointer: window moves right
  near(imageRect(z, pz, ASP).x, -0.25);
});

test("axis ticks: round steps, in range, labelled in m or mm", () => {
  assert.equal(niceStep(3800, 4), 1000);
  assert.equal(niceStep(300, 4), 100);
  assert.equal(niceStep(60, 4), 20);
  assert.equal(niceStep(2000, 4), 500);
  assert.deepEqual(ticksIn(-1900, 1900, 1000), [-1000, 0, 1000]);
  assert.deepEqual(ticksIn(-30, 35, 20), [-20, 0, 20]);
  assert.equal(axisLabel(-1000, 1000), "-1 m");
  assert.equal(axisLabel(1500, 1000), "1.5 m");
  assert.equal(axisLabel(1500, 500), "1500 mm");
  assert.equal(axisLabel(-20, 20), "-20 mm");
  assert.equal(axisLabel(2.5, 0.5), "2.5 mm");
});

test("grid resolution follows the graphics tier", () => {
  assert.equal(fieldGridNx("low"), 48);
  assert.equal(fieldGridNx("medium"), 64);
  assert.equal(fieldGridNx("high"), 96);
  assert.ok(fieldGridNx("low") < fieldGridNx("medium"));
});
