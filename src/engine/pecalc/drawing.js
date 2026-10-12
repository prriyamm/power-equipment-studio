/* SVG cross-section drawing of a cable bus. Port of pecalc/drawing.py. Pure module: returns the same
   SVG string as the Python for the same inputs.

   inp: cableBusInput() object (with enclosure_width_mm / enclosure_height_mm for the housing);
   result: analyse() result. */
import { pyFixed, pyRound } from "./util.js";

export const PHASE_FILL = { A: "#d64545", B: "#2f6fd6", C: "#2e9d5b" };
export const BLOCK_FILL = "#e9b9a1"; // GPO-3 is commonly supplied red / brick coloured
export const RAIL_FILL = "#8f9aa6";

const f1 = (x) => pyFixed(x, 1);

/** Python html.escape(s, quote=True). */
export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function mmIn(v) { return `${pyFixed(v, 0)} mm (${pyFixed(v / 25.4, 2)} in)`; }

export function cablebusSvg(inp, result, opts = {}) {
  const { block_material = "GPO-3", block_lip_mm = 10.0, width_px = 900 } = opts;
  const rows = result.conductors;
  const od = result.cable_od_mm;
  const xs = rows.map((c) => c.x_mm);
  const ys = rows.map((c) => c.y_mm);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const xc = (xmin + xmax) / 2, yc = (ymin + ymax) / 2;
  const w_in = inp.enclosure_width_mm || xmax - xmin + 2 * od;
  const h_in = inp.enclosure_height_mm || ymax - ymin + 2 * od;
  const ts = inp.side_thickness_mm, tc = inp.cover_thickness_mm;
  // model extents (mm), y up
  const x0 = xc - w_in / 2 - ts, x1 = xc + w_in / 2 + ts;
  const y0 = yc - h_in / 2 - tc, y1 = yc + h_in / 2 + tc;
  const [pad_l, pad_r, pad_t, pad_b] = [40, 140, 70, 80];
  const scale = (width_px - pad_l - pad_r) / (x1 - x0);
  const height_px = Math.trunc((y1 - y0) * scale + pad_t + pad_b);
  const X = (x) => pad_l + (x - x0) * scale;
  const Y = (y) => pad_t + (y1 - y) * scale;

  const s = [
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width_px} ${height_px}' width='${width_px}' ` +
    `height='${height_px}' font-family='Helvetica, Arial, sans-serif' font-size='12'>`,
    `<rect x='0' y='0' width='${width_px}' height='${height_px}' fill='#ffffff'/>`,
  ];
  // covers (dashed when not electrically continuous / ventilated)
  const dash = inp.covers_continuous ? "" : " stroke-dasharray='8 5'";
  for (const yy of [yc + h_in / 2 + tc / 2, yc - h_in / 2 - tc / 2]) {
    s.push(`<line x1='${f1(X(xc - w_in / 2))}' y1='${f1(Y(yy))}' x2='${f1(X(xc + w_in / 2))}' y2='${f1(Y(yy))}' ` +
      `stroke='${RAIL_FILL}' stroke-width='${f1(Math.max(2, tc * scale))}'${dash}/>`);
  }
  // side rails
  for (const xl of [xc - w_in / 2 - ts, xc + w_in / 2]) {
    s.push(`<rect x='${f1(X(xl))}' y='${f1(Y(yc + h_in / 2 + tc))}' width='${f1(Math.max(3, ts * scale))}' ` +
      `height='${f1((h_in + 2 * tc) * scale)}' fill='${RAIL_FILL}'/>`);
  }
  // support blocks, one per tier
  const tiers = [...new Set(ys.map((y) => pyRound(y, 3)))].sort((a, b) => a - b);
  for (const ty of tiers) {
    const bh = od + 2 * block_lip_mm;
    s.push(`<rect x='${f1(X(xc - w_in / 2))}' y='${f1(Y(ty + bh / 2))}' width='${f1(w_in * scale)}' ` +
      `height='${f1(bh * scale)}' fill='${BLOCK_FILL}' stroke='#a8664a' stroke-width='1' rx='3'/>`);
  }
  // cables
  for (const c of rows) {
    const cx = X(c.x_mm), cy = Y(c.y_mm), r = (od / 2) * scale;
    s.push(`<circle cx='${f1(cx)}' cy='${f1(cy)}' r='${f1(r)}' fill='${PHASE_FILL[c.phase]}' stroke='#222' ` +
      "stroke-width='1'/>");
    s.push(`<text x='${f1(cx)}' y='${f1(cy + 4)}' text-anchor='middle' fill='#fff' font-weight='bold'>` +
      `${c.phase}</text>`);
  }
  // dimensions
  const yd = Y(yc + h_in / 2 + tc) - 22;
  s.push(`<line x1='${f1(X(xc - w_in / 2))}' y1='${f1(yd)}' x2='${f1(X(xc + w_in / 2))}' y2='${f1(yd)}' ` +
    "stroke='#333' marker-start='url(#a)' marker-end='url(#a)'/>");
  s.push(`<text x='${f1(X(xc))}' y='${f1(yd - 6)}' text-anchor='middle'>inside width ${mmIn(w_in)}</text>`);
  const xd = X(xc + w_in / 2 + ts) + 22;
  s.push(`<line x1='${f1(xd)}' y1='${f1(Y(yc + h_in / 2))}' x2='${f1(xd)}' y2='${f1(Y(yc - h_in / 2))}' ` +
    "stroke='#333' marker-start='url(#a)' marker-end='url(#a)'/>");
  s.push(`<text x='${f1(xd + 8)}' y='${f1(Y(yc) - 4)}'>inside height</text>`);
  s.push(`<text x='${f1(xd + 8)}' y='${f1(Y(yc) + 12)}'>${mmIn(h_in)}</text>`);
  if (rows.length > 1) {
    const bottom = rows.filter((c) => Math.abs(c.y_mm - ymin) < 1e-6).sort((p, q) => p.x_mm - q.x_mm);
    const [a, b] = bottom;
    const yb = Y(a.y_mm) + (od / 2) * scale + 18 + block_lip_mm * scale;
    s.push(`<line x1='${f1(X(a.x_mm))}' y1='${f1(yb)}' x2='${f1(X(b.x_mm))}' y2='${f1(yb)}' stroke='#333' ` +
      "marker-start='url(#a)' marker-end='url(#a)'/>");
    s.push(`<text x='${f1((X(a.x_mm) + X(b.x_mm)) / 2)}' y='${f1(yb + 15)}' text-anchor='middle'>` +
      `pitch ${pyFixed(b.x_mm - a.x_mm, 0)} mm</text>`);
  }
  // legend (bottom row) and title
  const ly = height_px - 22;
  const items = ["A", "B", "C"].map((p) => ["circle", PHASE_FILL[p], `Phase ${p}`]).concat([
    ["rect", BLOCK_FILL, `${block_material} support block`], ["rect", RAIL_FILL, "Al side rail / cover"]]);
  let lx = pad_l;
  for (const [kind, col, text] of items) {
    if (kind === "circle") s.push(`<circle cx='${lx + 7}' cy='${ly - 4}' r='7' fill='${col}'/>`);
    else s.push(`<rect x='${lx}' y='${ly - 10}' width='14' height='11' fill='${col}' stroke='#777'/>`);
    s.push(`<text x='${lx + 20}' y='${ly}'>${escapeHtml(text)}</text>`);
    lx += 30 + 7 * [...text].length;
  }
  const title = `${inp.conductors_per_phase} x ${result.input.size} ${inp.material} per phase, ` +
    `${inp.tiers} tier(s), pattern ${result.pattern}, cable OD ${pyFixed(od, 1)} mm`;
  s.push(`<text x='${pad_l}' y='22' font-size='14' font-weight='bold'>${escapeHtml(title)}</text>`);
  s.push("<defs><marker id='a' viewBox='0 0 10 10' refX='5' refY='5' markerWidth='6' markerHeight='6' " +
    "orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill='#333'/></marker></defs>");
  s.push("</svg>");
  return s.join("\n");
}
